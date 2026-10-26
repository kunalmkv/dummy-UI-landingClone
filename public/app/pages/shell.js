// The frame around every workspace page: sidebar with the workspace switcher,
// top bar with breadcrumb and notifications, and the archived banner.

import { get, post, query, ws } from "../lib/api.js";
import { go, navigation } from "../lib/router.js";
import { can, loadBootstrap, loadWorkspace, myWorkspaces, ownsOrganization, roleIn, state } from "../lib/state.js";
import { avatar, busy, fullName, html, icon, mount, plural, popover, roleChip, timeAgo, toast } from "../lib/ui.js";
import { signOut } from "./auth.js";
import { openCreateWorkspace, openWorkspace, wireInvites } from "./start.js";

// The caller's pending invitations, for the banner and the switcher's badge.
let pendingInvites = [];
// Banners closed with ✕ stay closed until the page reloads.
const dismissedInvites = new Set();

/** Load the workspace fresh on every page, and record a visit on a switch. */
export async function enterWorkspace(workspaceId) {
  const switching = state.workspace?.id !== workspaceId;
  // The switcher's list is read alongside, so its counts are never stale.
  const [result] = await Promise.all([loadWorkspace(workspaceId), loadBootstrap()]);
  if (!result.ok) {
    toast(result.status === 404 ? "That workspace isn't available to you." : result.error, "error");
    go("/workspaces", true);
    return null;
  }
  if (switching) {
    post(ws(workspaceId, "/visit"), {});
  }
  return state.workspace;
}

const NAV = [
  { key: "home", label: "Home", icon: "house", path: "" },
  { key: "projects", label: "Projects", icon: "folder-kanban", path: "/projects", count: (w) => w.counts?.projects },
  { key: "members", label: "Members", icon: "users", path: "/members", count: (w) => w.counts?.members },
  { key: "settings", label: "Settings", icon: "settings", path: "/settings/general" },
];

/**
 * Draw the shell and hand back the content area.
 *
 * @param {{workspaceId: string, active: string, crumb: string}} options
 * @returns {Promise<HTMLElement|null>}
 */
export async function shell({ workspaceId, active, crumb }) {
  const here = navigation();
  const workspace = await enterWorkspace(workspaceId);
  // Asked for another page while this one loaded: that one draws, not this.
  if (!workspace || navigation() !== here) {
    return null;
  }
  const role = roleIn(workspaceId);
  const base = `#/w/${workspaceId}`;
  const archived = workspace.status !== "ACTIVE" || workspace.readOnly;
  const app = document.getElementById("app");
  mount(
    app,
    html`<div class="shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><div class="brand"><span class="brand-mark">i</span>Insidefi</div></div>
        <button class="switcher" data-switcher data-popover-anchor aria-label="Switch workspace">
          ${avatar(workspace.name, workspace.id, "sq")}
          <span class="ws-text"><div class="ws-name">${workspace.name}</div><div class="ws-sub">${role ? role.charAt(0) + role.slice(1).toLowerCase() : ""} · ${workspace.slug}</div></span>
          ${icon("chevrons-up-down")}
        </button>
        <nav class="nav">
          <div class="nav-label">Workspace</div>
          ${NAV.map((item) => html`<a href="${base}${item.path}" class="${active === item.key ? "active" : ""}">${icon(item.icon)}<span>${item.label}</span>${item.count && item.count(workspace) !== undefined ? html`<span class="count">${item.count(workspace)}</span>` : ""}</a>`)}
        </nav>
        <div class="sidebar-foot">
          <button class="user-chip" data-user data-popover-anchor>
            ${avatar(fullName(state.user), state.user?.id)}
            <span class="who"><div style="font-weight:500">${fullName(state.user)}</div><div class="muted" style="font-size:12px">${state.user?.email}</div></span>
            ${icon("ellipsis")}
          </button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <nav class="crumbs" aria-label="Breadcrumb">
            <a href="#/workspaces">Workspaces</a><span class="sep">/</span>
            <a class="ws-pill" href="${base}">${workspace.name}</a>
            ${crumb ? html`<span class="sep">/</span><span class="current">${crumb}</span>` : ""}
          </nav>
          <div class="topbar-actions">
            <button class="btn btn-ghost btn-icon bell" data-bell data-popover-anchor aria-label="Notifications">${icon("bell")}<span class="dot hidden" data-bell-dot></span></button>
          </div>
        </header>
        <div id="invite-banner"></div>
        ${archived
          ? html`<div class="banner">${icon("archive")}<span>This workspace is archived, so everything in it is read-only.</span>${ownsOrganization(state.workspace?.orgId) ? html`<button class="btn btn-sm" data-restore>Restore workspace</button>` : ""}</div>`
          : ""}
        <div class="content" id="content"></div>
      </div>
    </div>`,
  );
  wireSwitcher(app, workspaceId);
  wireUser(app, base);
  wireBell(app, workspaceId);
  showInviteBanner(app);
  app.querySelector("[data-restore]")?.addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await post(ws(workspaceId, "/restore"), {});
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      await refreshWorkspace();
      toast("Workspace restored");
      go(location.hash.slice(1));
    }),
  );
  return document.getElementById("content");
}

/** Re-read the open workspace after a change (counts, version, status). */
export async function refreshWorkspace() {
  if (state.workspace) {
    await loadWorkspace(state.workspace.id);
  }
  await loadBootstrap();
}

function wireSwitcher(app, workspaceId) {
  app.querySelector("[data-switcher]").addEventListener("click", async (event) => {
    const anchor = event.currentTarget;
    // Fresh from /me/workspaces (every workspace the person can open); the landing list is the fallback.
    const fresh = await get("/me/workspaces");
    const reachable = fresh.ok ? (Array.isArray(fresh.data) ? fresh.data : fresh.data?.items) : null;
    const list = Array.isArray(reachable) ? reachable : myWorkspaces();
    const items = (filter) =>
      list
        .filter((one) => !filter || one.name.toLowerCase().includes(filter))
        .map(
          (one) => html`<button class="menu-item" data-ws="${one.id}">${avatar(one.name, one.id, "sq")}<span style="flex:1;min-width:0"><div style="font-weight:500">${one.name}</div><div class="muted" style="font-size:11.5px">${plural(one.counts?.members ?? 0, "member")} · ${plural(one.counts?.projects ?? 0, "project")}</div></span>${one.id === workspaceId ? icon("check") : ""}</button>`,
        );
    const node = popover(
      anchor,
      html`<input type="search" placeholder="Find a workspace" data-find />
        <div data-list style="max-height:300px;overflow-y:auto">${items("")}</div>
        <div class="menu-sep"></div>
        <button class="menu-item" data-all>${icon("layout-grid")}<span>All workspaces</span>${pendingInvites.length ? html`<span class="count" title="Pending invitations">${pendingInvites.length}</span>` : ""}</button>
        <button class="menu-item" data-create>${icon("plus")}<span>Create workspace</span></button>`,
      { width: 300 },
    );
    const wire = () =>
      node.querySelectorAll("[data-ws]").forEach((button) =>
        button.addEventListener("click", () => {
          node.remove();
          if (button.dataset.ws !== workspaceId) {
            openWorkspace(button.dataset.ws);
          }
        }),
      );
    wire();
    node.querySelector("[data-find]").focus();
    node.querySelector("[data-find]").addEventListener("input", (input) => {
      mount(node.querySelector("[data-list]"), html`${items(input.target.value.trim().toLowerCase())}`);
      wire();
    });
    node.querySelector("[data-all]").addEventListener("click", () => {
      node.remove();
      go("/workspaces");
    });
    node.querySelector("[data-create]").addEventListener("click", () => {
      node.remove();
      openCreateWorkspace();
    });
  });
}

function wireUser(app, base) {
  app.querySelector("[data-user]").addEventListener("click", (event) =>
    popover(event.currentTarget, [
      { title: state.user?.email ?? "" },
      { label: "Workspace settings", icon: "settings", onClick: () => (location.hash = `${base.slice(1)}/settings/general`) },
      { label: "All workspaces", icon: "layout-grid", onClick: () => go("/workspaces") },
      { label: "Account & security", icon: "user-cog", onClick: () => go("/account") },
      { label: "Developer tools", icon: "wrench", onClick: () => window.open("/account", "_blank") },
      "sep",
      { label: "Sign out", icon: "log-out", onClick: () => signOut() },
    ]),
  );
}

/** Invitations sent to the caller, as a banner on every workspace page. */
async function showInviteBanner(app) {
  const result = await get("/me/invites");
  const box = app.querySelector("#invite-banner");
  if (!box || !result.ok) {
    return;
  }
  pendingInvites = result.data ?? [];
  mount(
    box,
    html`${pendingInvites
      .filter((invite) => !dismissedInvites.has(invite.inviteId))
      .map(
        (invite) => html`<div class="banner banner-invite">
          ${icon("mail")}
          <span><strong>${invite.invitedBy?.name ?? "Someone"}</strong> invited you to join <strong>${invite.workspaceName}</strong> as ${roleChip(invite.role)}</span>
          <span class="banner-actions">
            <button class="btn btn-sm" data-decline="${invite.inviteId}">Decline</button>
            <button class="btn btn-sm btn-primary" data-accept="${invite.inviteId}">Join</button>
            <button class="btn btn-ghost btn-sm btn-icon" data-dismiss="${invite.inviteId}" aria-label="Dismiss">${icon("x")}</button>
          </span>
        </div>`,
      )}`,
  );
  wireInvites(box, () => showInviteBanner(app));
  box.querySelectorAll("[data-dismiss]").forEach((button) =>
    button.addEventListener("click", () => {
      dismissedInvites.add(button.dataset.dismiss);
      showInviteBanner(app);
    }),
  );
}

async function updateBellDot(app, workspaceId) {
  const result = await get(ws(workspaceId, `/notifications${query({ status: "unread", limit: 1 })}`));
  const dot = app.querySelector("[data-bell-dot]");
  if (!dot || !result.ok) {
    return;
  }
  const count = result.data.unreadCount ?? 0;
  dot.textContent = count > 9 ? "9+" : String(count);
  dot.classList.toggle("hidden", count === 0);
}

function wireBell(app, workspaceId) {
  updateBellDot(app, workspaceId);
  const bell = app.querySelector("[data-bell]");
  bell.addEventListener("click", async () => {
    const node = popover(
      bell,
      html`<div class="notif-head"><h3>Notifications</h3><button class="btn btn-ghost btn-sm" data-read-all>Mark all read</button></div><div class="notif-list" data-list><div class="card-body"><div class="skeleton"></div></div></div>`,
      { width: 360 },
    );
    node.classList.add("notif-panel");
    const draw = async () => {
      const result = await get(ws(workspaceId, `/notifications${query({ status: "all", limit: 20 })}`));
      const items = result.ok ? result.data.items ?? [] : [];
      mount(
        node.querySelector("[data-list]"),
        items.length === 0
          ? html`<div class="empty" style="padding:28px 16px"><div class="empty-icon">${icon("bell")}</div><p>You're all caught up.</p></div>`
          : html`${items.map(
              (note) => html`<div class="notif ${note.readAt ? "" : "unread"}">
                <span class="app-icon" style="width:30px;height:30px;border-radius:8px;background:var(--bg-brand-soft);color:var(--text-brand)">${icon(note.type === "INVITE_ACCEPTED" ? "user-plus" : note.type === "MEMBER_REMOVED" ? "user-minus" : "bell")}</span>
                <div style="min-width:0"><div>${note.title}</div>${note.body ? html`<div class="muted" style="font-size:12.5px">${note.body}</div>` : ""}<div class="when">${timeAgo(note.createdAt)}</div></div>
              </div>`,
            )}`,
      );
    };
    await draw();
    node.querySelector("[data-read-all]").addEventListener("click", async () => {
      const result = await post(ws(workspaceId, "/notifications/read"), { all: true });
      if (result.ok) {
        await draw();
        updateBellDot(app, workspaceId);
      }
    });
  });
}

export { roleChip };
