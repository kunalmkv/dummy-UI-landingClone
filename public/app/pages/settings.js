// Workspace settings: general, branding, roles, billing, API tokens, webhooks,
// audit log and the danger zone, behind one secondary navigation.

import { del, get, patch, post, put, query, ws } from "../lib/api.js";
import { confirmIdentity, proofFields, readProof, wireProof } from "../lib/identity.js";
import { go } from "../lib/router.js";
import { can, loadBootstrap, roleIn, state } from "../lib/state.js";
import {
  avatar,
  busy,
  confirmDialog,
  copyText,
  debounce,
  emptyState,
  formValues,
  html,
  icon,
  mount,
  openModal,
  popover,
  roleChip,
  setFormError,
  shortDate,
  skeletonRows,
  timeAgo,
  timezones,
  toast,
} from "../lib/ui.js";
import { refreshWorkspace, shell } from "./shell.js";

const SECTIONS = [
  { key: "general", label: "General", icon: "settings" },
  { key: "branding", label: "Branding", icon: "palette" },
  { key: "roles", label: "Roles & permissions", icon: "shield" },
  { key: "billing", label: "Billing & plan", icon: "credit-card" },
  { key: "api-tokens", label: "API tokens", icon: "key-round" },
  { key: "webhooks", label: "Webhooks", icon: "webhook" },
  { key: "audit", label: "Audit log", icon: "clipboard-list" },
  { key: "danger", label: "Danger zone", icon: "triangle-alert", danger: true },
];

export async function renderSettings({ params }) {
  const section = SECTIONS.find((one) => one.key === params.section) ?? SECTIONS[0];
  const content = await shell({ workspaceId: params.id, active: "settings", crumb: `Settings / ${section.label}` });
  if (!content) {
    return;
  }
  mount(
    content,
    html`<div class="page-head"><div><h1>Settings</h1><p>Manage ${state.workspace.name}.</p></div></div>
      <div class="settings">
        <nav class="subnav">${SECTIONS.map((one) => html`<a href="#/w/${params.id}/settings/${one.key}" class="${one.key === section.key ? "active" : ""} ${one.danger ? "danger" : ""}">${icon(one.icon)}<span>${one.label}</span></a>`)}</nav>
        <div class="section-stack" id="section"></div>
      </div>`,
  );
  const target = content.querySelector("#section");
  const render = { general, branding, roles, billing, "api-tokens": tokens, webhooks, audit, danger }[section.key];
  await render(target, params.id);
}

function readOnlyNote(capability) {
  return can(capability) ? "" : html`<div class="form-note">${icon("lock")} Your role can view this but not change it.</div>`;
}

// ── general ────────────────────────────────────────────────────────────

async function general(target, id) {
  const workspace = state.workspace;
  const editable = can("workspace.settings.update") && workspace.status === "ACTIVE";
  mount(
    target,
    html`<div class="card">
        <div class="card-head"><div><h2>Workspace details</h2><p>The name and URL everyone in the workspace sees.</p></div></div>
        <form class="card-body form" novalidate data-general>
          ${readOnlyNote("workspace.settings.update")}
          <label class="field"><span>Workspace name</span><input type="text" name="name" maxlength="80" value="${workspace.name}" ${editable ? "" : "disabled"} /></label>
          <label class="field"><span>URL</span><div class="input-prefix"><span>insidefi.net/</span><input type="text" name="slug" maxlength="40" value="${workspace.slug}" ${editable ? "" : "disabled"} /></div><span class="slug-state hint" data-slug-state>Changing it breaks old links.</span></label>
          <div class="row-2">
            <label class="field"><span>Industry</span><input type="text" name="defaultVertical" list="settings-verticals" value="${workspace.defaultVertical ?? ""}" ${editable ? "" : "disabled"} /><datalist id="settings-verticals"></datalist></label>
            <label class="field"><span>Time zone</span><select name="timezone" ${editable ? "" : "disabled"}>${timezones().map((zone) => html`<option${zone === workspace.timezone ? " selected" : ""}>${zone}</option>`)}${timezones().includes(workspace.timezone) ? "" : html`<option selected>${workspace.timezone}</option>`}</select></label>
          </div>
        </form>
        ${editable ? html`<div class="card-foot"><button class="btn btn-primary" data-save disabled>Save changes</button></div>` : ""}
      </div>
      <div class="card">
        <div class="card-head"><div><h2>About this workspace</h2></div></div>
        <div class="card-body"><dl class="kv">
          <dt>Workspace ID</dt><dd><code>${workspace.id}</code> <button class="btn btn-ghost btn-sm btn-icon" data-copy-id aria-label="Copy ID">${icon("copy")}</button></dd>
          <dt>Status</dt><dd>${workspace.status === "ACTIVE" ? html`<span class="chip chip-success">Active</span>` : html`<span class="chip chip-warning">${workspace.status}</span>`}</dd>
          <dt>Your role</dt><dd>${roleChip(roleIn(id))}</dd>
          <dt>Created</dt><dd>${shortDate(workspace.createdAt)}</dd>
          <dt>Members · projects</dt><dd>${workspace.counts?.members ?? 0} · ${workspace.counts?.projects ?? 0}</dd>
        </dl></div>
      </div>`,
  );
  target.querySelector("[data-copy-id]").addEventListener("click", () => copyText(workspace.id));
  if (!editable) {
    return;
  }
  const form = target.querySelector("[data-general]");
  const save = target.querySelector("[data-save]");
  const original = { name: workspace.name, slug: workspace.slug, defaultVertical: workspace.defaultVertical ?? "", timezone: workspace.timezone };
  const changed = () => {
    const values = formValues(form);
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => value.trim() !== String(original[key] ?? "")).map(([key, value]) => [key, value.trim()]));
  };
  const slugState = form.querySelector("[data-slug-state]");
  const checkSlug = debounce(async () => {
    const value = form.elements.slug.value.trim();
    if (value === original.slug || !value) {
      slugState.textContent = "Changing it breaks old links.";
      slugState.className = "slug-state hint";
      return;
    }
    const result = await get(`/workspaces/slug-available${query({ slug: value })}`);
    if (result.ok) {
      slugState.textContent = result.data.available ? "✓ Available" : `Taken${result.data.suggestion ? ` — try ${result.data.suggestion}` : ""}`;
      slugState.className = `slug-state ${result.data.available ? "success-text" : "warning-text"}`;
    }
  }, 350);
  form.addEventListener("input", (event) => {
    save.disabled = Object.keys(changed()).length === 0;
    if (event.target.name === "slug") {
      checkSlug();
    }
  });
  form.addEventListener("change", () => {
    save.disabled = Object.keys(changed()).length === 0;
  });
  form.elements.defaultVertical.addEventListener(
    "input",
    debounce(async () => {
      const typed = form.elements.defaultVertical.value.trim();
      if (typed.length < 2) {
        return;
      }
      const result = await get(`/verticals/suggest${query({ q: typed })}`);
      if (result.ok) {
        form.querySelector("#settings-verticals").innerHTML = String(html`${(result.data ?? []).map((one) => html`<option value="${one}"></option>`)}`);
      }
    }, 300),
  );
  save.addEventListener("click", () =>
    busy(save, async () => {
      setFormError(form, null);
      // The version read with the workspace goes back, so a stale edit is refused.
      const result = await patch(ws(id), changed(), { "If-Match": String(state.workspace.version) });
      if (!result.ok) {
        if (result.code === "VERSION_CONFLICT") {
          await refreshWorkspace();
        }
        setFormError(form, result.error);
        return;
      }
      state.workspace = { ...state.workspace, ...result.data };
      await refreshWorkspace();
      toast("Workspace updated");
      renderSettings({ params: { id: id, section: "general" } });
    }),
  );
}

// ── branding ───────────────────────────────────────────────────────────

async function branding(target, id) {
  mount(target, html`<div class="card">${skeletonRows(3)}</div>`);
  const result = await get(ws(id, "/branding"));
  if (!result.ok) {
    mount(target, html`<div class="card">${emptyState({ iconName: "palette", title: "Branding isn't available", text: result.error })}</div>`);
    return;
  }
  const brand = result.data;
  const editable = can("branding.update") && state.workspace.status === "ACTIVE";
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Branding</h2><p>How pages and emails from this workspace look.</p></div></div>
      <form class="card-body form" novalidate>
        ${readOnlyNote("branding.update")}
        <label class="field"><span>Accent colour</span>
          <div style="display:flex;gap:10px;align-items:center"><input type="color" name="accentPicker" value="${brand.accentColor ?? "#3d8fff"}" style="width:46px;height:34px;padding:2px;border-radius:8px;border:1px solid var(--border-default);background:var(--bg-input)" ${editable ? "" : "disabled"} /><input type="text" name="accentColor" value="${brand.accentColor ?? ""}" placeholder="#3d8fff" style="max-width:140px" ${editable ? "" : "disabled"} /></div>
        </label>
        <label class="field"><span>Email sender name</span><input type="text" name="emailSenderName" maxlength="60" value="${brand.emailSenderName ?? ""}" placeholder="${state.workspace.name}" ${editable ? "" : "disabled"} /><span class="hint">Shown as the sender on emails your pages send.</span></label>
        <label class="check"><input type="checkbox" name="badgeEnabled" ${brand.badgeEnabled ? "checked" : ""} ${editable && brand.badgeRemovable ? "" : "disabled"} /> Show the "Made with Insidefi" badge</label>
        ${brand.badgeRemovable ? "" : html`<span class="hint" style="margin-top:-8px">Your plan keeps the badge on. Upgrade to remove it.</span>`}
      </form>
      ${editable ? html`<div class="card-foot"><button class="btn btn-primary" data-save>Save branding</button></div>` : ""}
    </div>`,
  );
  if (!editable) {
    return;
  }
  const form = target.querySelector("form");
  form.elements.accentPicker.addEventListener("input", (event) => {
    form.elements.accentColor.value = event.target.value;
  });
  target.querySelector("[data-save]").addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      setFormError(form, null);
      const body = { accentColor: form.elements.accentColor.value.trim() || null, emailSenderName: form.elements.emailSenderName.value.trim() || null };
      if (brand.badgeRemovable) {
        body.badgeEnabled = form.elements.badgeEnabled.checked;
      }
      const saved = await put(ws(id, "/branding"), body);
      if (!saved.ok) {
        setFormError(form, saved.error);
        return;
      }
      toast("Branding saved");
    }),
  );
}

// ── roles ──────────────────────────────────────────────────────────────

const GROUP_NAMES = {
  workspace: "Workspace",
  member: "Members",
  project: "Projects",
  page: "Pages",
  quiz: "Quizzes",
  campaign: "Campaigns",
  lead: "Leads",
  report: "Reports",
  token: "API tokens",
  webhook: "Webhooks",
  integration: "Integrations",
  branding: "Branding",
  audit: "Audit log",
  billing: "Billing",
};

function capabilityLabel(capability) {
  const [, ...rest] = capability.split(".");
  const words = rest.join(" ").replace(/_/g, " ");
  const verbs = { read: "View", create: "Create", update: "Edit", delete: "Delete", publish: "Publish", export: "Export", write: "Edit", manage: "Manage", revoke: "Revoke", invite: "Invite people", remove: "Remove people", state: "Pause and resume", transfer: "Hand over ownership", archive: "Archive", "settings update": "Edit settings", "role change": "Change roles", "scope change": "Change project access" };
  return verbs[words] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

async function roles(target, id) {
  mount(target, html`<div class="card">${skeletonRows(6)}</div>`);
  const result = await get(ws(id, "/roles"));
  if (!result.ok) {
    mount(target, html`<div class="card">${emptyState({ iconName: "shield", title: "Couldn't load roles", text: result.error })}</div>`);
    return;
  }
  const { roles: roleList, capabilities } = result.data;
  const groups = new Map();
  for (const row of capabilities) {
    const group = row.capability.split(".")[0];
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(row);
  }
  const cell = (level) =>
    level === "yes" ? html`<span class="yes">${icon("check")}</span>` : level === "partial" ? html`<span class="partial">Own only</span>` : html`<span class="no">—</span>`;
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Roles & permissions</h2><p>What each role can do. Roles are fixed; change someone's role on the Members page.</p></div></div>
      <div class="table-wrap"><table class="table matrix">
        <thead><tr><th>Permission</th>${roleList.map((role) => html`<th style="text-align:center">${roleChip(role)}</th>`)}</tr></thead>
        <tbody>${[...groups.entries()].map(
          ([group, rows]) => html`<tr class="group"><td colspan="${roleList.length + 1}">${GROUP_NAMES[group] ?? group}</td></tr>${rows.map(
            (row) => html`<tr><td>${capabilityLabel(row.capability)} <span class="muted mono" style="font-size:11px;margin-left:6px">${row.capability}</span></td>${roleList.map((role) => html`<td class="cell">${cell(row.levels[role])}</td>`)}</tr>`,
          )}`,
        )}</tbody>
      </table></div>
    </div>`,
  );
}

// ── billing ────────────────────────────────────────────────────────────

async function billing(target, id) {
  mount(target, html`<div class="card">${skeletonRows(4)}</div>`);
  const [billingResult, plansResult] = await Promise.all([get(ws(id, "/billing")), get("/billing/plans")]);
  if (!billingResult.ok) {
    mount(target, html`<div class="card">${emptyState({ iconName: "credit-card", title: "Billing isn't available to you", text: billingResult.error })}</div>`);
    return;
  }
  const bill = billingResult.data;
  const plans = plansResult.ok ? plansResult.data : [];
  const usage = bill.usage ?? {};
  const seatTotal = (usage.seatsIncluded ?? 0) + (usage.seatsExtra ?? 0);
  const seatPct = seatTotal ? Math.min(100, ((usage.seatsUsed ?? 0) / seatTotal) * 100) : 0;
  const pendingPct = seatTotal ? Math.min(100 - seatPct, ((usage.pendingInviteSeats ?? 0) / seatTotal) * 100) : 0;
  const current = plans.find((plan) => plan.planId === bill.plan);
  const yesNo = (value) => (value ? icon("check") : icon("x"));
  mount(
    target,
    html`<div class="card">
        <div class="card-head"><div><h2>${current?.displayName ?? bill.plan} plan</h2><p>${bill.orgName} · billed for the whole organization</p></div><span class="chip ${bill.status === "ACTIVE" ? "chip-success" : "chip-warning"}">${bill.status}</span></div>
        <div class="card-body" style="display:grid;gap:16px">
          <div><div class="meter-row" style="margin-bottom:8px"><span>Seats</span><span>${usage.seatsUsed ?? 0} used${usage.pendingInviteSeats ? ` · ${usage.pendingInviteSeats} pending` : ""} of ${seatTotal}</span></div><div class="meter"><span style="width:${seatPct}%"></span><span class="pending" style="width:${pendingPct}%"></span></div></div>
          <div class="meter-row"><span>Workspaces</span><span>${usage.workspacesUsed ?? 0} of ${usage.workspaceLimit ?? "—"}</span></div>
          ${bill.trialEndsAt ? html`<div class="meter-row"><span>Trial ends</span><span>${shortDate(bill.trialEndsAt)}</span></div>` : ""}
          ${bill.currentPeriodEnd ? html`<div class="meter-row"><span>Renews</span><span>${shortDate(bill.currentPeriodEnd)}</span></div>` : ""}
          <form class="form" data-seats style="grid-template-columns:auto auto 1fr;align-items:end">
            <label class="field"><span>Extra seats</span><input type="number" min="0" max="1000" name="seatsExtra" value="${usage.seatsExtra ?? 0}" style="width:110px" /></label>
            <button class="btn" type="submit">Update seats</button>
            <span class="hint">On top of the ${usage.seatsIncluded ?? 0} seats the plan includes.</span>
          </form>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Plans</h2><p>Changing the plan is for the organization's owner.</p></div></div>
        <div class="card-body"><div class="plans">${plans.map(
          (plan) => html`<div class="plan ${plan.planId === bill.plan ? "current" : ""}">
            <div style="display:flex;justify-content:space-between;align-items:center"><h3>${plan.displayName}</h3>${plan.planId === bill.plan ? html`<span class="chip chip-brand">Current</span>` : ""}</div>
            <ul>
              <li>${icon("users")} ${plan.seatsIncluded} seats included</li>
              <li>${icon("layout-grid")} ${plan.limits?.workspaces} workspace${plan.limits?.workspaces === 1 ? "" : "s"}</li>
              <li>${icon("folder-kanban")} ${plan.limits?.projectsPerWorkspace} projects each</li>
              <li>${icon("key-round")} ${plan.limits?.apiTokens} API tokens</li>
              <li>${icon("webhook")} ${plan.limits?.webhookEndpoints} webhooks</li>
              <li>${yesNo(plan.limits?.auditLogVisible)} Audit log</li>
              <li>${yesNo(plan.limits?.badgeRemovable)} Remove badge</li>
            </ul>
            ${plan.planId === bill.plan ? "" : html`<button class="btn btn-sm" data-plan="${plan.planId}">Switch to ${plan.displayName}</button>`}
          </div>`,
        )}</div></div>
      </div>`,
  );
  target.querySelectorAll("[data-plan]").forEach((button) =>
    button.addEventListener("click", async () => {
      const plan = plans.find((one) => one.planId === button.dataset.plan);
      const yes = await confirmDialog({ title: `Switch to ${plan.displayName}?`, message: `The whole organization moves to the ${plan.displayName} plan right away.`, confirmLabel: "Switch plan" });
      if (!yes) {
        return;
      }
      const result = await post(ws(id, "/billing/plan"), { planId: plan.planId });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(`You're on the ${plan.displayName} plan`);
      await refreshWorkspace();
      billing(target, id);
    }),
  );
  target.querySelector("[data-seats]").addEventListener("submit", (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    busy(button, async () => {
      const seatsExtra = Number(event.currentTarget.elements.seatsExtra.value);
      const result = await post(ws(id, "/billing/seats"), { seatsExtra: seatsExtra });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("Seats updated");
      billing(target, id);
    });
  });
}

// ── API tokens ─────────────────────────────────────────────────────────

const SCOPES = [
  { value: "leads.read", text: "Read leads" },
  { value: "leads.write", text: "Create and update leads" },
  { value: "reports.read", text: "Read reports" },
  { value: "webhooks", text: "Manage webhooks" },
  { value: "admin", text: "Full admin access" },
];

function revealSecret(title, secret, note) {
  openModal({
    title: title,
    subtitle: note,
    body: html`<div class="modal-body"><div class="secret"><span style="flex:1">${secret}</span><button class="btn btn-sm" data-copy>${icon("copy")} Copy</button></div><div class="form-note">${icon("triangle-alert")} Copy it now — you won't be able to see it again.</div></div>
      <div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`,
    onMount: (modal) => modal.querySelector("[data-copy]").addEventListener("click", () => copyText(secret)),
  });
}

async function tokens(target, id) {
  if (!can("token.read")) {
    mount(target, html`<div class="card">${emptyState({ iconName: "key-round", title: "API tokens are for admins", text: "Ask a workspace admin to create a token for you." })}</div>`);
    return;
  }
  mount(target, html`<div class="card">${skeletonRows(3)}</div>`);
  const [list, rate] = await Promise.all([get(ws(id, "/tokens")), get(ws(id, "/rate-limit"))]);
  const items = list.ok ? list.data ?? [] : [];
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>API tokens</h2><p>Let scripts and tools call the API on this workspace's behalf.</p></div>${can("token.create") ? html`<button class="btn btn-primary btn-sm" data-new>${icon("plus")} Create token</button>` : ""}</div>
      ${!list.ok
        ? emptyState({ iconName: "triangle-alert", title: "Couldn't load tokens", text: list.error })
        : items.length === 0
          ? emptyState({ iconName: "key-round", title: "No tokens yet", text: "Create a token to connect a script or another tool." })
          : html`<div class="table-wrap"><table class="table">
              <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th>Expires</th><th class="actions"></th></tr></thead>
              <tbody>${items.map(
                (token) => html`<tr>
                  <td><div class="name" style="font-weight:500">${token.name}</div><div class="muted" style="font-size:12px">${token.ownerType === "SERVICE" ? "Service token" : "Personal token"} · created ${timeAgo(token.createdAt)}</div></td>
                  <td><code>${token.keyPrefix}··${token.last4}</code></td>
                  <td><div class="chips-input">${(token.scopes ?? []).map((scope) => html`<span class="chip">${scope}</span>`)}</div></td>
                  <td class="muted">${token.lastUsedAt ? timeAgo(token.lastUsedAt) : "Never used"}</td>
                  <td>${token.expiresAt ? (new Date(token.expiresAt) < new Date() ? html`<span class="chip chip-danger">Expired</span>` : html`<span class="muted">${shortDate(token.expiresAt)}</span>`) : html`<span class="muted">Never</span>`}</td>
                  <td class="actions">${can("token.revoke") ? html`<button class="btn btn-ghost btn-sm" data-revoke="${token.tokenId}">Revoke</button>` : ""}</td>
                </tr>`,
              )}</tbody>
            </table></div>`}
      ${rate.ok ? html`<div class="card-foot" style="justify-content:flex-start;color:var(--text-tertiary);font-size:12.5px">${icon("gauge")} This minute: ${rate.data.windowUsedPct ?? 0}% of the workspace's API budget used · each token may make ${rate.data.limitPerMinute} calls a minute</div>` : ""}
    </div>`,
  );
  target.querySelector("[data-new]")?.addEventListener("click", () =>
    openModal({
      title: "Create an API token",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Name</span><input type="text" name="name" maxlength="100" required placeholder="e.g. Reporting script" /></label>
          <div class="field"><span class="field-label">Access</span>${SCOPES.map((scope) => html`<label class="check"><input type="checkbox" name="scope" value="${scope.value}" ${scope.value === "reports.read" ? "checked" : ""} /> ${scope.text} <code class="muted">${scope.value}</code></label>`)}</div>
          <div class="row-2">
            <label class="field"><span>Belongs to</span><select name="ownerType"><option value="USER">Me — revoked if I leave</option><option value="SERVICE">The workspace — survives staff changes</option></select></label>
            <label class="field"><span>Expires <span class="muted">(optional)</span></span><input type="date" name="expiresAt" /></label>
          </div>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Create token</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const scopes = [...form.querySelectorAll("[name=scope]:checked")].map((one) => one.value);
            const body = { name: form.elements.name.value.trim(), scopes: scopes, ownerType: form.elements.ownerType.value };
            if (form.elements.expiresAt.value) {
              body.expiresAt = new Date(`${form.elements.expiresAt.value}T23:59:59Z`).toISOString();
            }
            const result = await post(ws(id, "/tokens"), body);
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            revealSecret("Your new token", result.data.secret, `${result.data.name} — use it as a Bearer token.`);
            tokens(target, id);
          }),
        );
      },
    }),
  );
  target.querySelectorAll("[data-revoke]").forEach((button) =>
    button.addEventListener("click", async () => {
      const token = items.find((one) => one.tokenId === button.dataset.revoke);
      const yes = await confirmDialog({ title: `Revoke ${token.name}?`, message: "Anything using it stops working right away.", confirmLabel: "Revoke token", danger: true });
      if (!yes) {
        return;
      }
      const result = await del(ws(id, `/tokens/${encodeURIComponent(token.tokenId)}`));
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("Token revoked");
      tokens(target, id);
    }),
  );
}

// ── webhooks ───────────────────────────────────────────────────────────

async function webhooks(target, id) {
  if (!can("webhook.read")) {
    mount(target, html`<div class="card">${emptyState({ iconName: "webhook", title: "Webhooks are for admins", text: "Ask a workspace admin to set one up." })}</div>`);
    return;
  }
  mount(target, html`<div class="card">${skeletonRows(3)}</div>`);
  const [list, events] = await Promise.all([get(ws(id, "/webhook-endpoints")), get("/webhook-events")]);
  const items = list.ok ? list.data ?? [] : [];
  const eventList = events.ok ? events.data ?? [] : [];
  const eventLabel = Object.fromEntries(eventList.map((one) => [one.key, one.label]));
  const manage = can("webhook.manage");
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Webhooks</h2><p>Send events like a new lead or a new member to any URL.</p></div>${manage ? html`<button class="btn btn-primary btn-sm" data-new>${icon("plus")} Add endpoint</button>` : ""}</div>
      ${!list.ok
        ? emptyState({ iconName: "triangle-alert", title: "Couldn't load webhooks", text: list.error })
        : items.length === 0
          ? emptyState({ iconName: "webhook", title: "No endpoints yet", text: "Add an endpoint to push events to your CRM, Slack or anything with a URL." })
          : html`<div class="table-wrap"><table class="table">
              <thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th>Health</th><th class="actions"></th></tr></thead>
              <tbody>${items.map(
                (endpoint) => html`<tr>
                  <td><div style="font-weight:500">${endpoint.name}</div><div class="muted mono" style="font-size:11.5px">${endpoint.method} ${endpoint.url}</div></td>
                  <td><div class="chips-input">${(endpoint.events ?? []).map((key) => html`<span class="chip">${eventLabel[key] ?? key}</span>`)}</div></td>
                  <td>${endpoint.status === "ACTIVE" ? html`<span class="chip chip-success">Active</span>` : html`<span class="chip chip-warning">${endpoint.status}</span>`}</td>
                  <td>${endpoint.health?.state === "healthy" ? html`<span class="success-text">Healthy</span>` : html`<span class="warning-text">${endpoint.health?.state ?? "—"}</span>`}<div class="muted" style="font-size:12px">${endpoint.deliveryCount ?? 0} deliveries${endpoint.health?.successRate24h !== null && endpoint.health?.successRate24h !== undefined ? ` · ${endpoint.health.successRate24h}% ok` : ""}</div></td>
                  <td class="actions">${manage ? html`<button class="btn btn-ghost btn-icon btn-sm" data-menu="${endpoint.endpointId}" data-popover-anchor aria-label="Endpoint actions">${icon("ellipsis")}</button>` : ""}</td>
                </tr>`,
              )}</tbody>
            </table></div>`}
    </div>`,
  );
  target.querySelector("[data-new]")?.addEventListener("click", () =>
    openModal({
      title: "Add a webhook endpoint",
      size: "lg",
      body: html`<form class="modal-body form" novalidate>
          <div class="row-2">
            <label class="field"><span>Name</span><input type="text" name="name" maxlength="80" placeholder="e.g. CRM" /></label>
            <label class="field"><span>Method</span><select name="method"><option>POST</option><option>PUT</option></select></label>
          </div>
          <label class="field"><span>URL</span><input type="text" name="url" placeholder="https://example.com/hooks" /></label>
          <div class="field"><span class="field-label">Send these events</span>${eventList.map((event) => html`<label class="check"><input type="checkbox" name="event" value="${event.key}" /> ${event.label} <code class="muted">${event.key}</code></label>`)}</div>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Add endpoint</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const body = {
              name: form.elements.name.value.trim(),
              url: form.elements.url.value.trim(),
              method: form.elements.method.value,
              events: [...form.querySelectorAll("[name=event]:checked")].map((one) => one.value),
            };
            const result = await post(ws(id, "/webhook-endpoints"), body);
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            revealSecret("Endpoint added", result.data.signingSecret, "Use this signing secret to check that requests come from us.");
            webhooks(target, id);
          }),
        );
      },
    }),
  );
  target.querySelectorAll("[data-menu]").forEach((button) =>
    button.addEventListener("click", () => {
      const endpoint = items.find((one) => one.endpointId === button.dataset.menu);
      const path = ws(id, `/webhook-endpoints/${encodeURIComponent(endpoint.endpointId)}`);
      popover(button, [
        {
          label: "Send a test event",
          icon: "send",
          onClick: async () => {
            const result = await post(`${path}/test`, {});
            toast(result.ok ? "Test event sent" : result.error, result.ok ? "success" : "error");
          },
        },
        {
          label: endpoint.status === "ACTIVE" ? "Disable" : "Enable",
          icon: endpoint.status === "ACTIVE" ? "ban" : "play",
          onClick: async () => {
            const result = await patch(path, { status: endpoint.status === "ACTIVE" ? "DISABLED" : "ACTIVE" });
            toast(result.ok ? "Endpoint updated" : result.error, result.ok ? "success" : "error");
            webhooks(target, id);
          },
        },
        "sep",
        {
          label: "Delete endpoint",
          icon: "trash-2",
          danger: true,
          onClick: async () => {
            const yes = await confirmDialog({ title: `Delete ${endpoint.name}?`, message: "Deliveries stop and its history is removed.", confirmLabel: "Delete", danger: true });
            if (!yes) {
              return;
            }
            const result = await del(path);
            toast(result.ok ? "Endpoint deleted" : result.error, result.ok ? "success" : "error");
            webhooks(target, id);
          },
        },
      ]);
    }),
  );
}

// ── audit log ──────────────────────────────────────────────────────────

async function audit(target, id) {
  mount(target, html`<div class="card">${skeletonRows(5)}</div>`);
  const actions = await get(ws(id, "/audit-actions"));
  if (!actions.ok) {
    const upsell = actions.code === "ENTITLEMENT_REQUIRED";
    mount(
      target,
      html`<div class="card">${emptyState({
        iconName: upsell ? "lock" : "clipboard-list",
        title: upsell ? "The audit log is on paid plans" : "The audit log isn't available to you",
        text: upsell ? "See who changed what, and when — upgrade the organization's plan to turn it on." : actions.error,
        action: upsell ? html`<a class="btn btn-primary btn-sm" href="#/w/${id}/settings/billing">See plans</a>` : "",
      })}</div>`,
    );
    return;
  }
  const labels = Object.fromEntries((actions.data ?? []).map((one) => [one.action, one.label]));
  const view = { action: "", items: [], nextCursor: null };
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Audit log</h2><p>Every change made in this workspace.</p></div>
        <select data-action style="width:auto"><option value="">All actions</option>${(actions.data ?? []).map((one) => html`<option value="${one.action}">${one.label}</option>`)}</select>
      </div>
      <div data-rows>${skeletonRows(5)}</div>
    </div>`,
  );
  const rows = target.querySelector("[data-rows]");
  async function load(append = false) {
    const result = await get(ws(id, `/audit-events${query({ action: view.action, limit: 25, cursor: append ? view.nextCursor : "" })}`));
    if (!result.ok) {
      mount(rows, emptyState({ iconName: "triangle-alert", title: "Couldn't load the log", text: result.error }));
      return;
    }
    view.items = append ? [...view.items, ...(result.data.items ?? [])] : result.data.items ?? [];
    view.nextCursor = result.data.nextCursor ?? null;
    if (view.items.length === 0) {
      mount(rows, emptyState({ iconName: "clipboard-list", title: "Nothing recorded yet", text: "Changes to members, projects, settings and more show up here." }));
      return;
    }
    mount(
      rows,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${view.items.map(
          (event) => html`<tr>
            <td class="muted" title="${new Date(event.at).toLocaleString()}">${timeAgo(event.at)}</td>
            <td><div class="person">${event.actor?.type === "SYSTEM" ? html`<span class="avatar" style="background:var(--bg-neutral);color:var(--text-secondary)">${icon("bot")}</span>` : avatar(event.actor?.label ?? "?", event.actor?.id)}<div><div class="name">${event.actor?.label ?? "Someone"}</div><div class="email">${event.actor?.type === "TOKEN" ? "API token" : event.actor?.type === "SYSTEM" ? "Automatic" : event.actor?.roleAtTime ?? ""}</div></div></div></td>
            <td><div style="font-weight:500">${labels[event.action] ?? event.action}</div><div class="muted" style="font-size:12px">${event.target?.label ?? ""}</div></td>
            <td class="muted" style="font-size:12.5px">${(event.changes ?? []).slice(0, 2).map((change) => html`<div>${change.field}: ${String(change.from ?? "—")} → ${String(change.to ?? "—")}</div>`)}</td>
          </tr>`,
        )}</tbody>
      </table></div>
      ${view.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}`,
    );
    rows.querySelector("[data-more]")?.addEventListener("click", (event) => busy(event.currentTarget, () => load(true)));
  }
  target.querySelector("[data-action]").addEventListener("change", (event) => {
    view.action = event.target.value;
    load();
  });
  load();
}

// ── danger zone ────────────────────────────────────────────────────────

async function danger(target, id) {
  const workspace = state.workspace;
  const role = roleIn(id);
  const archived = workspace.status !== "ACTIVE";
  const canArchive = can("workspace.archive");
  mount(
    target,
    html`<div class="card danger-card">
      <div class="card-head"><div><h2>Danger zone</h2><p>Changes here are hard to undo.</p></div></div>
      ${canArchive
        ? html`<div class="danger-row"><div><h3>${archived ? "Restore workspace" : "Archive workspace"}</h3><p>${archived ? "Bring it back to normal. Members get their access back." : "Make everything read-only and free its seats. You can restore it later."}</p></div>
            ${archived ? html`<button class="btn" data-restore>Restore</button>` : html`<button class="btn btn-danger" data-archive>Archive…</button>`}</div>`
        : ""}
      ${role !== "OWNER"
        ? html`<div class="danger-row"><div><h3>Leave workspace</h3><p>You'll lose access until someone invites you again.</p></div><button class="btn btn-danger" data-leave>Leave</button></div>`
        : ""}
      ${!canArchive && role === "OWNER" ? emptyState({ iconName: "shield", title: "Nothing to do here", text: "" }) : ""}
    </div>`,
  );

  target.querySelector("[data-archive]")?.addEventListener("click", () =>
    openModal({
      title: `Archive ${workspace.name}?`,
      subtitle: "Everything becomes read-only and its seats are freed. You can restore it later.",
      body: html`<form class="modal-body form" novalidate>
          ${proofFields()}
          <label class="check"><input type="checkbox" name="emailMembers" /> Email the members that it was archived</label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-submit>Archive workspace</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        wireProof(form, "WORKSPACE_ARCHIVE");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const check = await confirmIdentity("WORKSPACE_ARCHIVE", readProof(form));
            if (!check.ok) {
              setFormError(form, check.error);
              return;
            }
            const result = await post(ws(id, "/archive"), { emailMembers: form.elements.emailMembers.checked });
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            toast("Workspace archived");
            await refreshWorkspace();
            renderSettings({ params: { id: id, section: "danger" } });
          }),
        );
      },
    }),
  );

  target.querySelector("[data-restore]")?.addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await post(ws(id, "/restore"), {});
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("Workspace restored");
      await refreshWorkspace();
      renderSettings({ params: { id: id, section: "danger" } });
    }),
  );

  target.querySelector("[data-leave]")?.addEventListener("click", async () => {
    const yes = await confirmDialog({ title: `Leave ${workspace.name}?`, message: "You'll lose access until someone invites you again.", confirmLabel: "Leave workspace", danger: true });
    if (!yes) {
      return;
    }
    const result = await post(ws(id, "/members/me/leave"), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    state.workspace = null;
    await loadBootstrap();
    toast("You left the workspace");
    go("/");
  });
}
