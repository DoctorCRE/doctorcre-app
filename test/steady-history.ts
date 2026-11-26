import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";

const COMMITTING = "Not attached to an active page";

// Chromium refuses history commands while a cross-document navigation commits,
// and Playwright's goBack/goForward do not wait that out. The refusal comes
// before anything navigates, so the step is sent again once the commit lands.
export function steadyHistory(page: Page, budgetMs = 30_000): Page {
  for (const step of ["goBack", "goForward"] as const) {
    const send = page[step].bind(page);
    page[step] = async (options) => {
      const deadline = Date.now() + budgetMs;
      for (;;) {
        try {
          return await send(options);
        } catch (error) {
          if (!(error instanceof Error && error.message.includes(COMMITTING)) || Date.now() >= deadline) throw error;
          await delay(25);
        }
      }
    };
  }
  return page;
}
