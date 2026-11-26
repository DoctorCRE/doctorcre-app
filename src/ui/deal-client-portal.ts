export type ClientPortalView = { deal: string; url: unknown; clientName: unknown };

const COPY_LABEL = "Copy client link";
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** The partners' view of the client's site. The share site refuses framing, so the site opens in its own tab. */
export function clientPortalHtml({ deal, url, clientName }: ClientPortalView): string {
  if (typeof url !== "string" || !/^https:\/\/[^/]/i.test(url))
    return '<p class="deal-client-portal-none">No client website yet.</p>';
  const title = typeof clientName === "string" && clientName ? `Website for ${esc(clientName)}` : "Client website";
  const open = `data-open-client-website="${esc(deal)}"`;
  const newTab = '<span class="sr-only"> (opens in a new tab)</span>';
  return `<section class="deal-client-portal" aria-labelledby="deal-client-portal-title">
  <div class="deal-client-portal-line"><h2 id="deal-client-portal-title">${title}</h2><button class="btn" type="button" data-copy-client-link="${esc(url)}">${COPY_LABEL}</button><button class="btn btn-primary" type="button" ${open}>Open as client${newTab}</button></div>
  <button class="deal-client-portal-preview" type="button" ${open}><span>${esc(url.replace(/^https:\/\//i, "").replace(/\/$/, ""))}</span><span aria-hidden="true">↗</span>${newTab}</button>
</section>`;
}

/** Copies the client's own link, the one that asks for their password, and says Copied on the button. */
export async function copyClientLink(button: HTMLButtonElement, clipboard: Pick<Clipboard, "writeText">) {
  const url = button.dataset.copyClientLink;
  if (!url) return;
  try {
    await clipboard.writeText(url);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Couldn't copy";
  }
  // eslint-disable-next-line no-restricted-syntax -- Single 2 s Copied label reset per click, owned by this button.
  setTimeout(() => {
    button.textContent = COPY_LABEL;
  }, 2000);
}
