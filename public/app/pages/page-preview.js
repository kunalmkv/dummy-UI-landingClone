// A preview link: the page's draft as it is now, for anyone holding the token.
// The design renders to HTML and CSS here, inside a sandboxed frame.

import { get } from "../lib/api.js";
import { renderDesign } from "../lib/grapes.js";
import { emptyState, html, mount } from "../lib/ui.js";

export async function renderPagePreview({ params }) {
  const app = document.getElementById("app");
  mount(app, html`<div class="boot">Loading the preview…</div>`);
  const result = await get(`/page-previews/${encodeURIComponent(params.token)}`);
  if (!result.ok) {
    mount(app, html`<div class="preview-shell">${emptyState({ iconName: "clock", title: "This preview has expired", text: "Preview links last an hour. Open Preview in the editor again for a fresh one." })}</div>`);
    return;
  }
  const rendered = await renderDesign(result.data.design);
  mount(
    app,
    html`<div class="preview-shell">
      <div class="preview-bar"><strong>${result.data.name}</strong><span class="muted">Draft preview — not published. The link stops working an hour after it was made.</span></div>
      <iframe class="preview-frame" title="Page preview" sandbox="" data-frame></iframe>
    </div>`,
  );
  // A sandbox with no permissions: the draft's own scripts and forms never run.
  app.querySelector("[data-frame]").srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${rendered.css}</style></head><body>${rendered.html}</body></html>`;
}
