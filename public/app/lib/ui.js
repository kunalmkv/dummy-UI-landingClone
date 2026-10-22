// Shared UI pieces: toasts, modals, menus, confirm, and small formatters.

import { html, icon, mount, raw, refreshIcons } from "./html.js";

// ── formatting ──────────────────────────────────────────────────────────

export function initials(name) {
  const words = String(name ?? "?").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

const AVATAR_COLORS = ["#3d8fff", "#8b6bff", "#1fcb89", "#f2b33e", "#f26464", "#3a6cd9", "#a3791b", "#7a4ec4", "#3a8a52", "#ff7a59"];

export function colorFor(seed) {
  let hash = 0;
  for (const char of String(seed ?? "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function avatar(name, seed, extra = "") {
  return html`<span class="avatar ${extra}" style="background:${raw(colorFor(seed ?? name))}">${initials(name)}</span>`;
}

export function roleChip(role) {
  if (!role) {
    return "";
  }
  return html`<span class="chip role role-${role}">${role.charAt(0) + role.slice(1).toLowerCase()}</span>`;
}

export function fullName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "";
}

export function timeAgo(value) {
  if (!value) {
    return "—";
  }
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const future = seconds < 0;
  const span = Math.abs(seconds);
  const units = [
    [60, "second"],
    [3600, "minute", 60],
    [86400, "hour", 3600],
    [604800, "day", 86400],
    [2629800, "week", 604800],
    [31557600, "month", 2629800],
    [Infinity, "year", 31557600],
  ];
  if (span < 45) {
    return future ? "in a moment" : "just now";
  }
  for (const [limit, unit, size = 1] of units) {
    if (span < limit) {
      const count = Math.round(span / size);
      const label = `${count} ${unit}${count === 1 ? "" : "s"}`;
      return future ? `in ${label}` : `${label} ago`;
    }
  }
  return "";
}

export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

export function shortDate(value) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function timezones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"];
  }
}

export function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ── toasts ──────────────────────────────────────────────────────────────

export function toast(message, kind = "success") {
  const root = document.getElementById("toast-root");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = String(html`${icon(kind === "error" ? "circle-alert" : kind === "info" ? "info" : "circle-check")}<span>${message}</span>`);
  root.appendChild(node);
  refreshIcons();
  setTimeout(() => node.remove(), kind === "error" ? 6000 : 3500);
}

// ── buttons ─────────────────────────────────────────────────────────────

/** Run an async action with the button disabled and spinning. */
export async function busy(button, action) {
  if (!button || button.classList.contains("is-busy")) {
    return undefined;
  }
  const original = button.innerHTML;
  button.classList.add("is-busy");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${button.textContent.trim() ? `<span>${button.textContent.trim()}</span>` : ""}`;
  try {
    return await action();
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
    button.innerHTML = original;
    refreshIcons();
  }
}

// ── modals ──────────────────────────────────────────────────────────────

/**
 * Open a modal. `body` is html; `onMount(modalEl, close)` wires it.
 *
 * @returns {{el: HTMLElement, close: Function}}
 */
export function openModal({ title, subtitle = "", body, size = "", onMount, onClose }) {
  const root = document.getElementById("modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = String(html`
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head">
        <div><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ""}</div>
        <button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon("x")}</button>
      </div>
      ${body}
    </div>`);
  root.appendChild(backdrop);
  refreshIcons();
  const modal = backdrop.querySelector(".modal");
  const onKey = (event) => {
    if (event.key === "Escape") {
      close();
    }
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    onClose?.();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      close();
    }
  });
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  onMount?.(modal, close);
  modal.querySelector("input:not([type=hidden]):not([disabled]), select, textarea")?.focus();
  return { el: modal, close: close };
}

/** Ask a yes/no question. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title: title,
      body: html`
        <div class="modal-body"><p class="secondary">${message}</p></div>
        <div class="modal-foot">
          <button class="btn" data-close>Cancel</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${confirmLabel}</button>
        </div>`,
      onMount: (modal, close) => {
        modal.querySelector("[data-yes]").addEventListener("click", () => {
          answered = true;
          close();
          resolve(true);
        });
      },
      onClose: () => {
        if (!answered) {
          resolve(false);
        }
      },
    });
  });
}

/** Show an error inside a form, or clear it. */
export function setFormError(form, message) {
  let box = form.querySelector(".form-error");
  if (!message) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "form-error";
    form.prepend(box);
  }
  box.innerHTML = String(html`${icon("circle-alert")}<span>${message}</span>`);
  refreshIcons();
}

// ── popover menus ───────────────────────────────────────────────────────

let openPopover = null;

export function closePopover() {
  openPopover?.remove();
  openPopover = null;
}

/**
 * Open a popover under an anchor. `content` is html or an array of menu items
 * { label, icon, danger, onClick } / "sep" / { title }.
 */
export function popover(anchor, content, { width, onMount } = {}) {
  closePopover();
  const node = document.createElement("div");
  node.className = "popover";
  if (width) {
    node.style.width = `${width}px`;
    node.style.maxWidth = `${width}px`;
  }
  const items = Array.isArray(content) ? content : null;
  node.innerHTML = String(
    items
      ? html`${items.map((item, index) =>
          item === "sep"
            ? html`<div class="menu-sep"></div>`
            : item.title
              ? html`<div class="menu-title">${item.title}</div>`
              : html`<button class="menu-item ${item.danger ? "danger" : ""}" data-index="${index}">${item.icon ? icon(item.icon) : ""}<span>${item.label}</span></button>`,
        )}`
      : content,
  );
  document.body.appendChild(node);
  refreshIcons();
  const rect = anchor.getBoundingClientRect();
  const width_ = node.offsetWidth;
  let left = rect.right - width_;
  if (left < 8) {
    left = Math.min(rect.left, window.innerWidth - width_ - 8);
  }
  node.style.left = `${Math.max(8, left)}px`;
  const below = rect.bottom + 6;
  node.style.top = `${below + node.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - node.offsetHeight - 6) : below}px`;
  if (items) {
    node.querySelectorAll("[data-index]").forEach((button) =>
      button.addEventListener("click", () => {
        const item = items[Number(button.dataset.index)];
        closePopover();
        item.onClick?.();
      }),
    );
  }
  openPopover = node;
  onMount?.(node);
  return node;
}

document.addEventListener("mousedown", (event) => {
  if (openPopover && !openPopover.contains(event.target) && !event.target.closest("[data-popover-anchor]")) {
    closePopover();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopover();
  }
});
window.addEventListener("hashchange", closePopover);

// ── misc ────────────────────────────────────────────────────────────────

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't copy — select the text and copy it yourself", "error");
  }
}

export function emptyState({ iconName, title, text, action = "" }) {
  return html`<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ""}
    ${action}
  </div>`;
}

export function skeletonRows(count = 4) {
  return html`<div class="card-body" style="display:grid;gap:14px">${Array.from({ length: count }, () => html`<div class="skeleton"></div>`)}</div>`;
}

export { mount, html, icon, raw };
