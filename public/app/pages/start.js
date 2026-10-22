// Before a workspace is open: where to land, the first-run welcome, the
// workspace picker, onboarding, and the create-workspace form they share.

import { get, post, put, query, ws } from "../lib/api.js";
import { accountBellButton, wireAccountBell } from "../lib/account-bell.js";
import { searchButton, wireSearch } from "../lib/search.js";
import { APP_KEYS, appInfo, appStateLabel } from "../lib/apps.js";
import { go, navigation } from "../lib/router.js";
import { loadBootstrap, myOrganizations, myWorkspaces, state } from "../lib/state.js";
import {
  avatar,
  browserTimezone,
  busy,
  debounce,
  emptyState,
  formValues,
  fullName,
  html,
  icon,
  mount,
  openModal,
  popover,
  roleChip,
  setFormError,
  slugify,
  timeAgo,
  timezones,
  toast,
} from "../lib/ui.js";
import { signOut } from "./auth.js";

// ── landing ─────────────────────────────────────────────────────────────

/** me.md's routing table, first match wins. */
export async function renderLanding() {
  const result = await loadBootstrap();
  if (!result.ok) {
    renderProblem(result.error);
    return;
  }
  const boot = state.bootstrap;
  const list = boot.workspaces ?? [];
  const last = list.find((one) => one.id === boot.lastWorkspaceId);
  if (list.length === 0) {
    go("/welcome", true);
  } else if (boot.onboardingComplete === false) {
    go(`/onboarding?w=${(last ?? list[0]).id}`, true);
  } else if (list.length === 1) {
    go(`/w/${list[0].id}`, true);
  } else if (last) {
    go(`/w/${last.id}`, true);
  } else {
    go("/workspaces", true);
  }
}

export function renderProblem(message) {
  mount(
    document.getElementById("app"),
    html`<div class="centered-page"><div class="page-width card card-pad">${emptyState({
      iconName: "triangle-alert",
      title: "Something went wrong",
      text: message,
      action: html`<a class="btn" href="#/">Try again</a>`,
    })}</div></div>`,
  );
}

// ── shared bits ─────────────────────────────────────────────────────────

export function centeredHeader() {
  return html`<div style="display:flex;align-items:center;justify-content:space-between">
    <div class="brand"><span class="brand-mark">i</span>Insidefi</div>
    <div style="display:flex;align-items:center;gap:8px">
      ${searchButton()}${accountBellButton()}
      <button class="user-chip" style="width:auto" data-user-menu data-popover-anchor>
        ${avatar(fullName(state.user), state.user?.id)}
        <span class="who"><div>${fullName(state.user)}</div><div class="muted" style="font-size:12px">${state.user?.email}</div></span>
        ${icon("chevron-down")}
      </button>
    </div>
  </div>`;
}

export function wireUserMenu(root) {
  // The same header carries the account bell and the search button.
  wireAccountBell(root);
  wireSearch(root);
  root.querySelector("[data-user-menu]")?.addEventListener("click", (event) =>
    popover(event.currentTarget, [
      { title: state.user?.email ?? "" },
      { label: "Account & security", icon: "user-cog", onClick: () => go("/account") },
      { label: "Developer tools", icon: "wrench", onClick: () => window.open("/account", "_blank") },
      "sep",
      { label: "Sign out", icon: "log-out", onClick: () => signOut() },
    ]),
  );
}

/** Open a workspace: remember the pick on the account, then go in. */
export async function openWorkspace(workspaceId) {
  await put("/me/last-workspace", { workspaceId: workspaceId });
  go(`/w/${workspaceId}`);
}

// ── create a workspace ──────────────────────────────────────────────────

function createForm(prefix) {
  const orgs = myOrganizations();
  const zone = browserTimezone();
  return html`
    <label class="field"><span>Workspace name</span><input type="text" name="name" required maxlength="80" placeholder="e.g. Medicare East" /></label>
    <label class="field"><span>URL</span>
      <div class="input-prefix"><span>insidefi.net/</span><input type="text" name="slug" maxlength="40" placeholder="medicare-east" /></div>
      <span class="slug-state hint" id="${prefix}-slug-state">Lower-case letters, numbers and dashes.</span>
    </label>
    ${orgs.length > 1
      ? html`<label class="field"><span>Organization</span><select name="orgId">${orgs.map((org) => html`<option value="${org.id}">${org.name}</option>`)}</select></label>`
      : html`<input type="hidden" name="orgId" value="${orgs[0]?.id ?? ""}" />`}
    <div class="row-2">
      <label class="field"><span>Industry</span><input type="text" name="defaultVertical" list="${prefix}-verticals" placeholder="e.g. Medicare" /><datalist id="${prefix}-verticals"></datalist></label>
      <label class="field"><span>Time zone</span><select name="timezone">${timezones().map((one) => html`<option${one === zone ? " selected" : ""}>${one}</option>`)}</select></label>
    </div>`;
}

/** Wire name → slug, the slug check and industry suggestions; returns the submit handler. */
function wireCreateForm(form, prefix, onCreated) {
  const name = form.elements.name;
  const slug = form.elements.slug;
  const slugState = form.querySelector(`#${prefix}-slug-state`);
  let slugTouched = false;
  const check = debounce(async () => {
    const value = slug.value.trim();
    if (!value) {
      slugState.textContent = "Leave it empty and we'll make one from the name.";
      slugState.className = "slug-state hint";
      return;
    }
    const result = await get(`/workspaces/slug-available${query({ slug: value })}`);
    if (!result.ok) {
      return;
    }
    if (result.data.available) {
      slugState.textContent = "✓ Available";
      slugState.className = "slug-state success-text";
    } else {
      slugState.innerHTML = String(html`Taken. ${result.data.suggestion ? html`<a href="#" data-use="${result.data.suggestion}">Use ${result.data.suggestion}</a>` : ""}`);
      slugState.className = "slug-state warning-text";
      slugState.querySelector("[data-use]")?.addEventListener("click", (event) => {
        event.preventDefault();
        slug.value = event.currentTarget.dataset.use;
        slugTouched = true;
        check();
      });
    }
  }, 350);
  name.addEventListener("input", () => {
    if (!slugTouched) {
      slug.value = slugify(name.value);
      check();
    }
  });
  slug.addEventListener("input", () => {
    slugTouched = true;
    check();
  });
  const vertical = form.elements.defaultVertical;
  vertical.addEventListener(
    "input",
    debounce(async () => {
      const typed = vertical.value.trim();
      if (typed.length < 2) {
        return;
      }
      const result = await get(`/verticals/suggest${query({ q: typed })}`);
      if (result.ok) {
        form.querySelector(`#${prefix}-verticals`).innerHTML = String(html`${(result.data ?? []).map((one) => html`<option value="${one}"></option>`)}`);
      }
    }, 300),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]") ?? form.closest(".modal")?.querySelector("[data-submit]"), async () => {
      setFormError(form, null);
      if (!values.orgId) {
        setFormError(form, "You don't belong to an organization yet.");
        return;
      }
      const body = { name: values.name.trim(), timezone: values.timezone };
      if (values.slug.trim()) {
        body.slug = values.slug.trim();
      }
      if (values.defaultVertical.trim()) {
        body.defaultVertical = values.defaultVertical.trim();
      }
      const result = await post(`/organizations/${encodeURIComponent(values.orgId)}/workspaces`, body);
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      await loadBootstrap();
      toast(`${body.name} is ready`);
      onCreated(result.data.workspaceId);
    });
  });
}

/** After a create: onboarding first if the account hasn't finished it. */
function afterCreate(workspaceId) {
  if (state.bootstrap?.onboardingComplete === false) {
    go(`/onboarding?w=${workspaceId}`);
  } else {
    openWorkspace(workspaceId);
  }
}

export function openCreateWorkspace() {
  openModal({
    title: "Create a workspace",
    subtitle: "A workspace holds your projects and the people who work on them. You'll be its owner.",
    body: html`<form class="modal-body form" id="create-ws-form" novalidate>${createForm("modal")}</form>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Create workspace</button></div>`,
    onMount: (modal, close) => {
      const form = modal.querySelector("#create-ws-form");
      wireCreateForm(form, "modal", (workspaceId) => {
        close();
        afterCreate(workspaceId);
      });
      modal.querySelector("[data-submit]").addEventListener("click", () => form.requestSubmit());
    },
  });
}

// ── invitations ─────────────────────────────────────────────────────────

async function invitationsCard() {
  const result = await get("/me/invites");
  const invites = result.ok ? result.data ?? [] : [];
  return { invites: invites, markup: html`<div class="card">
    <div class="card-head"><div><h2>Invitations</h2><p>Workspaces you've been asked to join.</p></div>${invites.length ? html`<span class="chip chip-brand">${invites.length} pending</span>` : ""}</div>
    ${invites.length === 0
      ? emptyState({ iconName: "inbox", title: "No invitations", text: `When a teammate invites ${state.user?.email ?? "you"}, it shows up here.` })
      : html`${invites.map(
          (invite) => html`<div class="invite-row">
            ${avatar(invite.workspaceName, invite.inviteId, "sq")}
            <div class="grow"><div style="font-weight:600">${invite.workspaceName}</div><div class="muted" style="font-size:12.5px">${invite.invitedBy?.name ?? "Someone"} invited you · expires ${timeAgo(invite.expiresAt)}</div></div>
            ${roleChip(invite.role)}
            <button class="btn btn-sm" data-decline="${invite.inviteId}">Decline</button>
            <button class="btn btn-sm btn-primary" data-accept="${invite.inviteId}">Join</button>
          </div>`,
        )}`}
  </div>` };
}

/** Join or decline from a list of the caller's invitations (welcome, picker, shell banner). */
export function wireInvites(root, rerender) {
  root.querySelectorAll("[data-accept]").forEach((button) =>
    button.addEventListener("click", () =>
      busy(button, async () => {
        const result = await post(`/me/invites/${encodeURIComponent(button.dataset.accept)}/accept`, {});
        if (!result.ok) {
          toast(result.error, "error");
          return;
        }
        await loadBootstrap();
        toast("You joined the workspace");
        openWorkspace(result.data.workspaceId);
      }),
    ),
  );
  root.querySelectorAll("[data-decline]").forEach((button) =>
    button.addEventListener("click", () =>
      busy(button, async () => {
        const result = await post(`/me/invites/${encodeURIComponent(button.dataset.decline)}/decline`, {});
        if (!result.ok) {
          toast(result.error, "error");
          return;
        }
        toast("Invitation declined");
        rerender();
      }),
    ),
  );
}

// ── welcome: no workspace yet ───────────────────────────────────────────

export async function renderWelcome() {
  if (!state.bootstrap) {
    await loadBootstrap();
  }
  if (myWorkspaces().length > 0) {
    go("/", true);
    return;
  }
  const app = document.getElementById("app");
  const here = navigation();
  const invites = await invitationsCard();
  if (navigation() !== here) {
    return;
  }
  mount(
    app,
    html`<div class="centered-page"><div class="page-width">
      ${centeredHeader()}
      <div style="margin-top:18px"><h1>Welcome, ${state.user?.firstName ?? "there"} 👋</h1><p class="muted" style="margin-top:6px">You're not in a workspace yet. Create one for your team${invites.invites.length ? ", or join one you've been invited to" : ""}.</p></div>
      <div class="two-col">
        <div class="card">
          <div class="card-head"><div><h2>Create a workspace</h2><p>You'll be its owner. You can invite your team next.</p></div></div>
          <form class="card-body form" id="welcome-create" novalidate>
            ${createForm("welcome")}
            <button class="btn btn-primary" type="submit">${icon("plus")} Create workspace</button>
          </form>
        </div>
        <div id="welcome-invites">${invites.markup}</div>
      </div>
    </div></div>`,
  );
  wireUserMenu(app);
  wireCreateForm(document.getElementById("welcome-create"), "welcome", afterCreate);
  wireInvites(app, renderWelcome);
}

// ── picker ──────────────────────────────────────────────────────────────

export async function renderPicker() {
  const here = navigation();
  await loadBootstrap();
  const app = document.getElementById("app");
  const list = myWorkspaces();
  const orgName = Object.fromEntries(myOrganizations().map((org) => [org.id, org.name]));
  const invites = await invitationsCard();
  if (navigation() !== here) {
    return;
  }
  const cards = (filter) =>
    list
      .filter((one) => !filter || one.name.toLowerCase().includes(filter))
      .map(
        (one) => html`<button class="ws-card" data-open="${one.id}">
          <div style="display:flex;align-items:center;gap:12px">
            ${avatar(one.name, one.id, "sq lg")}
            <div style="min-width:0;flex:1"><div style="font-weight:600;font-size:15px">${one.name}</div><div class="muted" style="font-size:12.5px">${orgName[one.orgId] ?? ""}</div></div>
            ${roleChip(one.role)}
          </div>
          <div class="meta"><span>${icon("users")} ${one.counts?.members ?? 0}</span><span>${icon("folder-kanban")} ${one.counts?.projects ?? 0}</span>${one.readOnly ? html`<span class="chip chip-warning">Archived</span>` : ""}</div>
          <div class="muted" style="font-size:12px">${one.lastVisit ? html`Last opened ${timeAgo(one.lastVisit.at)}${one.lastVisit.name ? html` by ${one.lastVisit.name}` : ""}` : "Not opened yet"}</div>
        </button>`,
      );
  mount(
    app,
    html`<div class="centered-page"><div class="page-width">
      ${centeredHeader()}
      <div class="page-head" style="margin-top:18px">
        <div><h1>Your workspaces</h1><p>Pick one to open. Your choice is remembered on every device.</p></div>
        <div class="actions"><button class="btn btn-primary" data-new>${icon("plus")} New workspace</button></div>
      </div>
      <div class="toolbar"><div class="search">${icon("search")}<input type="search" placeholder="Search workspaces" data-search /></div></div>
      <div class="ws-grid" data-grid>${cards("")}</div>
      ${invites.invites.length ? invites.markup : ""}
    </div></div>`,
  );
  wireUserMenu(app);
  const wireCards = () =>
    app.querySelectorAll("[data-open]").forEach((card) => card.addEventListener("click", () => openWorkspace(card.dataset.open)));
  wireCards();
  app.querySelector("[data-search]").addEventListener("input", (event) => {
    mount(app.querySelector("[data-grid]"), html`${cards(event.target.value.trim().toLowerCase())}`);
    wireCards();
  });
  app.querySelector("[data-new]").addEventListener("click", openCreateWorkspace);
  wireInvites(app, renderPicker);
}

// ── onboarding ──────────────────────────────────────────────────────────

export async function renderOnboarding({ query: params }) {
  if (!state.bootstrap) {
    await loadBootstrap();
  }
  const workspaceId = params.w ?? myWorkspaces()[0]?.id;
  const workspace = myWorkspaces().find((one) => one.id === workspaceId);
  if (!workspace) {
    go("/", true);
    return;
  }
  const result = await get(ws(workspaceId, "/apps"));
  const apps = result.ok ? result.data : APP_KEYS.map((key) => ({ key: key, state: "ACTIVE" }));
  const app = document.getElementById("app");
  let chosen = apps.find((one) => one.state === "ACTIVE")?.key ?? null;
  const draw = () =>
    mount(
      app,
      html`<div class="centered-page"><div class="page-width">
        ${centeredHeader()}
        <div style="margin-top:18px"><span class="chip chip-brand">Step 2 of 2</span><h1 style="margin-top:10px">Where would you like to start?</h1><p class="muted" style="margin-top:6px">Pick the app you'll use first in ${workspace.name}. You can open the others any time.</p></div>
        <div class="apps">${apps.map((one) => {
          const info = appInfo(one.key);
          const open = one.state === "ACTIVE";
          const label = appStateLabel(one);
          return html`<button class="app-card ${open ? "selectable" : "locked"} ${chosen === one.key ? "selected" : ""}" ${open ? html`data-pick="${one.key}"` : "disabled"}>
            <div class="app-top"><span class="app-icon" style="background:${info.color}">${icon(info.icon)}</span><div style="font-weight:600">${info.name}</div></div>
            <div class="desc">${info.tagline}</div>
            <div class="app-foot"><span class="chip ${label.kind ? `chip-${label.kind}` : ""}">${label.text}</span>${chosen === one.key ? html`<span class="chip chip-brand">${icon("check")} Selected</span>` : ""}</div>
          </button>`;
        })}</div>
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" data-continue ${chosen ? "" : "disabled"}>Continue ${icon("arrow-right")}</button></div>
      </div></div>`,
    );
  const wire = () => {
    wireUserMenu(app);
    app.querySelectorAll("[data-pick]").forEach((card) =>
      card.addEventListener("click", () => {
        chosen = card.dataset.pick;
        draw();
        wire();
      }),
    );
    app.querySelector("[data-continue]").addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const done = await post("/me/onboarding/complete", { workspaceId: workspaceId, startingApp: chosen });
        if (!done.ok) {
          toast(done.error, "error");
          return;
        }
        await loadBootstrap();
        openWorkspace(workspaceId);
      }),
    );
  };
  draw();
  wire();
}
