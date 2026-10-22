// The pre-workspace palette (GET /me/search): the caller's workspaces and a few
// global commands, never a workspace's contents. ⌘K or Ctrl+K opens it where
// a page has a search button.

import { get, query } from "./api.js";
import { appPath } from "./account-bell.js";
import { go } from "./router.js";
import { debounce, html, icon, mount, openModal } from "./ui.js";

const MIN_LENGTH = 2;

export function searchButton() {
  return html`<button class="btn btn-ghost" data-search-open aria-label="Search">${icon("search")}<span class="muted">Search</span><kbd>⌘K</kbd></button>`;
}

/** Where a result goes: a workspace opens itself, a command uses the contract's href. */
function open(kind, item) {
  if (kind === "workspace") {
    go(`/w/${item.id}`);
  } else {
    go(appPath(item.href) ?? "/");
  }
}

export function openSearch() {
  openModal({
    title: "Search",
    subtitle: "Your workspaces and account settings.",
    body: html`<div class="modal-body form">
      <label class="field"><input type="search" name="q" placeholder="Search anything…" autocomplete="off" data-q /></label>
      <div data-results><p class="muted">Type at least ${MIN_LENGTH} characters.</p></div>
    </div>`,
    onMount: (modal, close) => {
      const input = modal.querySelector("[data-q]");
      const results = modal.querySelector("[data-results]");
      const draw = (groups, note) => {
        mount(
          results,
          groups.length === 0
            ? html`<p class="muted">${note}</p>`
            : html`${groups.map(
                (group) => html`<div class="search-group"><div class="nav-label">${group.kind === "workspace" ? "Workspaces" : "Commands"}</div>${group.items.map(
                  (item) => html`<button type="button" class="menu-item" data-kind="${group.kind}" data-id="${item.id}">${icon(group.kind === "workspace" ? "layout-grid" : "corner-down-right")}<span style="flex:1;min-width:0"><div style="font-weight:500">${item.label}</div>${item.sublabel ? html`<div class="muted" style="font-size:11.5px">${item.sublabel}</div>` : ""}</span></button>`,
                )}</div>`,
              )}`,
        );
        results.querySelectorAll("[data-id]").forEach((row) =>
          row.addEventListener("click", () => {
            const group = groups.find((one) => one.kind === row.dataset.kind);
            close();
            open(row.dataset.kind, group.items.find((one) => one.id === row.dataset.id));
          }),
        );
      };
      const run = debounce(async () => {
        const q = input.value.trim();
        if (q.length < MIN_LENGTH) {
          draw([], `Type at least ${MIN_LENGTH} characters.`);
          return;
        }
        const result = await get(`/me/search${query({ q: q, limit: 5 })}`);
        draw(result.ok ? result.data.groups ?? [] : [], result.ok ? "Nothing matched." : result.error);
      }, 250);
      input.addEventListener("input", run);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          results.querySelector("[data-id]")?.click();
        }
      });
    },
  });
}

/** Wire the button, and ⌘K / Ctrl+K once for the whole app. */
export function wireSearch(root) {
  root.querySelector("[data-search-open]")?.addEventListener("click", openSearch);
}

let shortcutWired = false;
export function wireSearchShortcut() {
  if (shortcutWired) {
    return;
  }
  shortcutWired = true;
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      const button = document.querySelector("[data-search-open]");
      if (button) {
        event.preventDefault();
        button.click();
      }
    }
  });
}
