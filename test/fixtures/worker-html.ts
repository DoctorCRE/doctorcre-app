import { JSDOM } from "jsdom";

export class FixtureHtmlRewriter {
  handlers = new Map<string, { element(node: Element): void }>();
  on(selector: string, handler: { element(node: Element): void }) {
    this.handlers.set(selector, handler);
    return this;
  }
  transform(response: Response) {
    const handlers = this.handlers;
    return new Response(
      new ReadableStream({
        async start(stream) {
          const html = await response.text();
          if (!/<html[\s>]/i.test(html)) {
            stream.enqueue(new TextEncoder().encode(html));
            stream.close();
            return;
          }
          const dom = new JSDOM(html);
          try {
            for (const [selector, handler] of handlers) {
              dom.window.document.querySelectorAll(selector).forEach((element) => {
                handler.element(element);
              });
            }
            stream.enqueue(new TextEncoder().encode(dom.serialize()));
            stream.close();
          } finally {
            dom.window.close();
          }
        },
      }),
      response,
    );
  }
}
