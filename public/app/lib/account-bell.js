// The account bell: account-level notifications only (GET /me/notifications),
// shown where no workspace is open. A workspace's own bell lives in its shell.

import { get, post, query } from "./api.js";
import { go } from "./router.js";
import { html, icon, mount, popover, timeAgo } from "./ui.js";

// The contract's client routes, as this app's hash routes.
const ROUTES = {
  "/account/profile": "/account/profile",
  "/account/security": "/account/activity",
  "/account/sessions": "/account/sessions",
  "/account/notifications": "/account/notifications",
  "/account/exports": "/account/privacy",
  "/workspaces/new": "/workspaces",
  "/workspace": "/workspaces",
};

/** An app path for a href the API sends, or null when it names nothing here. */
export function appPath(href) {
  return ROUTES[href] ?? (href?.startsWith("/account/") ? "/account" : null);
}

const TYPE_ICON = { INVITE_ACCEPTED: "user-plus", MEMBER_REMOVED: "user-minus", EXPORT_READY: "download", SECURITY_ALERT: "shield-alert" };

/** One row, shared by the bell's popover and the Notifications screen. */
export function notificationRow(note) {
  return html`<button type="button" class="notif ${note.readAt ? "" : "unread"}" data-note="${note.id}" data-href="${note.href ?? ""}">
    <span class="app-icon" style="width:30px;height:30px;border-radius:8px;background:var(--bg-brand-soft);color:var(--text-brand)">${icon(TYPE_ICON[note.type] ?? "bell")}</span>
    <span style="min-width:0;text-align:left"><span style="display:block">${note.title}</span>${note.body ? html`<span class="muted" style="display:block;font-size:12.5px">${note.body}</span>` : ""}<span class="when">${timeAgo(note.createdAt)}</span></span>
  </button>`;
}

/** Mark rows read, then open where the row points. */
export async function openNotification(note) {
  if (!note.readAt) {
    await post("/me/notifications/read", { ids: [note.id] });
  }
  const path = appPath(note.href);
  if (path) {
    go(path);
  }
}

/** The bell button's markup: hidden until the route answers, so an API without it shows no dead button. */
export function accountBellButton() {
  return html`<button class="btn btn-ghost btn-icon bell hidden" data-account-bell data-popover-anchor aria-label="Account notifications">${icon("bell")}<span class="dot hidden" data-account-bell-dot></span></button>`;
}

async function refreshDot(root) {
  const button = root.querySelector("[data-account-bell]");
  const dot = root.querySelector("[data-account-bell-dot]");
  const result = await get(`/me/notifications${query({ status: "unread", limit: 1 })}`);
  if (!button || !result.ok) {
    return;
  }
  button.classList.remove("hidden");
  const count = result.data.unreadCount ?? 0;
  dot.textContent = count > 9 ? "9+" : String(count);
  dot.classList.toggle("hidden", count === 0);
}

export function wireAccountBell(root) {
  const button = root.querySelector("[data-account-bell]");
  if (!button) {
    return;
  }
  refreshDot(root);
  button.addEventListener("click", async () => {
    const node = popover(
      button,
      html`<div class="notif-head"><h3>Account notifications</h3><button class="btn btn-ghost btn-sm" data-read-all>Mark all read</button></div><div class="notif-list" data-list><div class="card-body"><div class="skeleton"></div></div></div>`,
      { width: 360 },
    );
    node.classList.add("notif-panel");
    const draw = async () => {
      const result = await get(`/me/notifications${query({ status: "all", limit: 20 })}`);
      const items = result.ok ? result.data.items ?? [] : [];
      mount(
        node.querySelector("[data-list]"),
        items.length === 0
          ? html`<div class="empty" style="padding:28px 16px"><div class="empty-icon">${icon("bell")}</div><p>${result.ok ? "You're all caught up." : result.error}</p></div>`
          : html`${items.map(notificationRow)}`,
      );
      node.querySelectorAll("[data-note]").forEach((row) =>
        row.addEventListener("click", async () => {
          node.remove();
          await openNotification(items.find((one) => one.id === row.dataset.note));
          refreshDot(root);
        }),
      );
    };
    await draw();
    node.querySelector("[data-read-all]").addEventListener("click", async () => {
      const result = await post("/me/notifications/read", { all: true });
      if (result.ok) {
        await draw();
        refreshDot(root);
      }
    });
  });
}
