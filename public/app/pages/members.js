// Members and invitations: the roster, roles, suspend, remove, leave, and the
// invite dialog with its live seat preview.

import { del, get, patch, post, query, ws } from "../lib/api.js";
import { go } from "../lib/router.js";
import { can, loadBootstrap, state } from "../lib/state.js";
import {
  avatar,
  busy,
  confirmDialog,
  copyText,
  debounce,
  emptyState,
  html,
  icon,
  mount,
  openModal,
  popover,
  roleChip,
  setFormError,
  skeletonRows,
  timeAgo,
  toast,
} from "../lib/ui.js";
import { refreshWorkspace, shell } from "./shell.js";

const ROLES = [
  { value: "ADMIN", label: "Admin", text: "Manages members, settings, tokens and webhooks." },
  { value: "EDITOR", label: "Editor", text: "Builds pages, quizzes and campaigns in the projects they reach." },
  { value: "VIEWER", label: "Viewer", text: "Sees everything, changes nothing. Free — no seat." },
];

function parseEmails(text) {
  return [...new Set(String(text).split(/[\s,;]+/).map((one) => one.trim()).filter(Boolean))];
}

export async function renderMembers({ params, query: params_ }) {
  const content = await shell({ workspaceId: params.id, active: "members", crumb: "Members" });
  if (!content) {
    return;
  }
  const id = params.id;
  const me = state.user?.id;
  const view = { tab: params_.tab === "invitations" ? "invitations" : "members", q: "", role: "", members: [], nextCursor: null, invites: [], showExpired: false };

  mount(
    content,
    html`
      <div class="page-head">
        <div><h1>Members</h1><p>Who can work in ${state.workspace.name}, and what they can do.</p></div>
        <div class="actions">${can("member.invite") ? html`<button class="btn btn-primary" data-invite>${icon("user-plus")} Invite people</button>` : ""}</div>
      </div>
      <div class="card card-pad" data-seats><div class="skeleton"></div></div>
      <div class="card">
        <div class="tabs" style="padding:0 12px" data-tabs>
          <button data-tab="members">Members<span class="count" data-count-members>${state.workspace.counts?.members ?? ""}</span></button>
          <button data-tab="invitations">Invitations<span class="count" data-count-invites>${state.workspace.counts?.pendingInvites ?? ""}</span></button>
        </div>
        <div data-panel></div>
      </div>`,
  );

  const panel = content.querySelector("[data-panel]");

  async function loadSeats() {
    const result = await get(ws(id, "/seats"));
    const box = content.querySelector("[data-seats]");
    if (!result.ok) {
      box.remove();
      return;
    }
    const seats = result.data;
    const total = seats.seatsIncluded + (seats.seatsExtra ?? 0);
    const usedPct = total ? Math.min(100, (seats.seatsUsed / total) * 100) : 0;
    const pendingPct = total ? Math.min(100 - usedPct, ((seats.seatsPending ?? 0) / total) * 100) : 0;
    mount(
      box,
      html`<div class="meter-row" style="margin-bottom:10px">
          <div><strong style="color:var(--text-primary)">${seats.seatsUsed} of ${total} seats used</strong>${seats.seatsPending ? html` · ${seats.seatsPending} held by pending invitations` : ""} · ${seats.plan} plan</div>
          ${can("billing.read") ? html`<a href="#/w/${id}/settings/billing">Add seats</a>` : ""}
        </div>
        <div class="meter"><span style="width:${usedPct}%"></span><span class="pending" style="width:${pendingPct}%"></span></div>
        <div class="muted" style="font-size:12px;margin-top:8px">${(seats.billableRoles ?? []).map((role) => role.charAt(0) + role.slice(1).toLowerCase()).join(", ")} take a seat. Viewers are free.</div>`,
    );
  }

  function setTab(tab) {
    view.tab = tab;
    content.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    if (tab === "members") {
      drawMembersFrame();
      loadMembers();
    } else {
      drawInvitesFrame();
      loadInvites();
    }
  }

  // ── members ──────────────────────────────────────────────────────────

  function drawMembersFrame() {
    mount(
      panel,
      html`<div class="card-head" style="justify-content:flex-start">
          <div class="toolbar" style="flex:1">
            <div class="search">${icon("search")}<input type="search" placeholder="Search name or email" data-q value="${view.q}" /></div>
            <select data-role><option value="">All roles</option>${["OWNER", "ADMIN", "EDITOR", "VIEWER"].map((role) => html`<option value="${role}"${view.role === role ? " selected" : ""}>${role.charAt(0) + role.slice(1).toLowerCase()}</option>`)}</select>
          </div>
        </div>
        <div data-rows>${skeletonRows()}</div>`,
    );
    panel.querySelector("[data-q]").addEventListener(
      "input",
      debounce((event) => {
        view.q = event.target.value.trim();
        loadMembers();
      }, 300),
    );
    panel.querySelector("[data-role]").addEventListener("change", (event) => {
      view.role = event.target.value;
      loadMembers();
    });
  }

  async function loadMembers(append = false) {
    const rows = panel.querySelector("[data-rows]");
    const result = await get(ws(id, `/members${query({ q: view.q.length >= 2 ? view.q : "", role: view.role, limit: 25, cursor: append ? view.nextCursor : "" })}`));
    if (!result.ok) {
      mount(rows, emptyState({ iconName: "triangle-alert", title: "Couldn't load members", text: result.error }));
      return;
    }
    view.members = append ? [...view.members, ...(result.data.items ?? [])] : result.data.items ?? [];
    view.nextCursor = result.data.nextCursor ?? null;
    drawMembers();
  }

  function drawMembers() {
    const rows = panel.querySelector("[data-rows]");
    if (view.members.length === 0) {
      mount(rows, emptyState({ iconName: "users", title: "No members match", text: "Try another name, email or role." }));
      return;
    }
    const canRole = can("member.role.change");
    const canRemove = can("member.remove");
    mount(
      rows,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Projects</th><th>Joined</th><th class="actions"></th></tr></thead>
        <tbody>${view.members.map((member) => {
          const self = member.userId === me;
          const editable = canRole && !self && member.wsRole !== "OWNER";
          return html`<tr>
            <td><div class="person">${avatar(member.name || member.email, member.userId)}<div style="min-width:0"><div class="name">${member.name || member.email}${self ? html` <span class="chip" style="margin-left:4px">You</span>` : ""}</div><div class="email">${member.email}</div></div></div></td>
            <td>${editable
              ? html`<select data-role-of="${member.userId}">${["ADMIN", "EDITOR", "VIEWER"].map((role) => html`<option value="${role}"${member.wsRole === role ? " selected" : ""}>${role.charAt(0) + role.slice(1).toLowerCase()}</option>`)}</select>`
              : roleChip(member.wsRole)}</td>
            <td>${member.status === "SUSPENDED"
              ? html`<span class="chip chip-warning">Suspended</span>`
              : html`<span style="display:inline-flex;align-items:center;gap:7px"><span class="dot-status ${member.presence === "ONLINE" ? "on" : ""}"></span>${member.presence === "ONLINE" ? "Online" : "Active"}</span>`}</td>
            <td class="muted">${member.projectAccess?.mode === "LIMITED" ? `${member.projectAccess.granted} of ${member.projectAccess.total}` : "All projects"}</td>
            <td class="muted">${timeAgo(member.joinedAt)}</td>
            <td class="actions">${(canRemove && !self && member.wsRole !== "OWNER") || (self && member.wsRole !== "OWNER")
              ? html`<button class="btn btn-ghost btn-icon btn-sm" data-member-menu="${member.userId}" data-popover-anchor aria-label="Member actions">${icon("ellipsis")}</button>`
              : ""}</td>
          </tr>`;
        })}</tbody>
      </table></div>
      ${view.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}`,
    );
    rows.querySelector("[data-more]")?.addEventListener("click", (event) => busy(event.currentTarget, () => loadMembers(true)));
    rows.querySelectorAll("[data-role-of]").forEach((select) =>
      select.addEventListener("change", async () => {
        const member = view.members.find((one) => one.userId === select.dataset.roleOf);
        const result = await patch(ws(id, `/members/${encodeURIComponent(member.userId)}`), { wsRole: select.value });
        if (!result.ok) {
          select.value = member.wsRole;
          toast(result.error, "error");
          return;
        }
        member.wsRole = select.value;
        toast(`${member.name || member.email} is now ${select.value.toLowerCase()}`);
        loadSeats();
      }),
    );
    rows.querySelectorAll("[data-member-menu]").forEach((button) =>
      button.addEventListener("click", () => {
        const member = view.members.find((one) => one.userId === button.dataset.memberMenu);
        const self = member.userId === me;
        const items = self
          ? [{ label: "Leave workspace", icon: "log-out", danger: true, onClick: () => leave() }]
          : [
              member.status === "SUSPENDED"
                ? { label: "Reactivate", icon: "rotate-ccw", onClick: () => setSuspended(member, false) }
                : { label: "Suspend", icon: "ban", onClick: () => setSuspended(member, true) },
              "sep",
              { label: "Remove from workspace", icon: "user-minus", danger: true, onClick: () => remove(member) },
            ];
        popover(button, items);
      }),
    );
  }

  async function setSuspended(member, suspend) {
    if (suspend) {
      const yes = await confirmDialog({
        title: `Suspend ${member.name || member.email}?`,
        message: "They keep their seat but can't open this workspace until you reactivate them.",
        confirmLabel: "Suspend",
        danger: true,
      });
      if (!yes) {
        return;
      }
    }
    const result = await post(ws(id, `/members/${encodeURIComponent(member.userId)}/${suspend ? "suspend" : "reactivate"}`), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(suspend ? "Member suspended" : "Member reactivated");
    loadMembers();
  }

  async function remove(member) {
    const impact = await get(ws(id, `/members/${encodeURIComponent(member.userId)}/removal-impact`));
    if (!impact.ok) {
      toast(impact.error, "error");
      return;
    }
    const data = impact.data;
    const candidates = data.reassignCandidates ?? [];
    openModal({
      title: `Remove ${member.name || member.email}?`,
      subtitle: "They lose access right away. What they made stays.",
      body: html`<div class="modal-body">
          <dl class="kv">
            <dt>Projects they reach</dt><dd>${data.projects ?? 0}</dd>
            <dt>API tokens revoked</dt><dd>${data.apiTokens ?? 0}</dd>
            <dt>Pending invitations</dt><dd>${data.pendingInvitesOwned ?? 0}</dd>
            <dt>Seats freed</dt><dd>${data.seatsFreedInOrg ?? 0}</dd>
          </dl>
          ${(data.pendingInvitesOwned ?? 0) > 0 && candidates.length
            ? html`<label class="field"><span>Hand their invitations to</span><select name="reassign">${candidates.map((one) => html`<option value="${one.userId}">${one.name} (${one.email})</option>`)}</select></label>`
            : ""}
        </div>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-yes>Remove member</button></div>`,
      onMount: (modal, close) => {
        modal.querySelector("[data-yes]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            const reassign = modal.querySelector("[name=reassign]")?.value;
            const result = await post(ws(id, `/members/${encodeURIComponent(member.userId)}/remove`), reassign ? { reassignToUserId: reassign } : {});
            if (!result.ok) {
              setFormError(modal.querySelector(".modal-body"), result.error);
              return;
            }
            close();
            toast(`${member.name || member.email} was removed`);
            await refreshWorkspace();
            loadSeats();
            loadMembers();
          }),
        );
      },
    });
  }

  async function leave() {
    const yes = await confirmDialog({
      title: `Leave ${state.workspace.name}?`,
      message: "You'll lose access until someone invites you again.",
      confirmLabel: "Leave workspace",
      danger: true,
    });
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
  }

  // ── invitations ──────────────────────────────────────────────────────

  function drawInvitesFrame() {
    mount(
      panel,
      html`<div class="card-head" style="justify-content:flex-start">
          <label class="check"><input type="checkbox" data-expired ${view.showExpired ? "checked" : ""} /> Show expired</label>
        </div>
        <div data-rows>${skeletonRows()}</div>`,
    );
    panel.querySelector("[data-expired]").addEventListener("change", (event) => {
      view.showExpired = event.target.checked;
      loadInvites();
    });
  }

  async function loadInvites() {
    const rows = panel.querySelector("[data-rows]");
    const result = await get(ws(id, `/invites${query({ status: view.showExpired ? "all" : "pending", limit: 50 })}`));
    if (!result.ok) {
      mount(rows, emptyState({ iconName: "triangle-alert", title: "Couldn't load invitations", text: result.error }));
      return;
    }
    view.invites = result.data.items ?? [];
    const active = result.data.counts?.active;
    if (active !== undefined) {
      content.querySelector("[data-count-invites]").textContent = active;
    }
    drawInvites();
  }

  function drawInvites() {
    const rows = panel.querySelector("[data-rows]");
    if (view.invites.length === 0) {
      mount(
        rows,
        emptyState({
          iconName: "mail",
          title: "No pending invitations",
          text: "Invite people by email. They join with the role you pick.",
          action: can("member.invite") ? html`<button class="btn btn-primary btn-sm" data-invite-empty>${icon("user-plus")} Invite people</button>` : "",
        }),
      );
      rows.querySelector("[data-invite-empty]")?.addEventListener("click", openInvite);
      return;
    }
    const manage = can("member.invite");
    mount(
      rows,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Email</th><th>Role</th><th>Invited by</th><th>Sent</th><th>Expires</th><th class="actions"></th></tr></thead>
        <tbody>${view.invites.map(
          (invite) => html`<tr>
            <td><div class="person">${avatar(invite.email, invite.email)}<div class="name">${invite.email}</div></div></td>
            <td>${manage && !invite.isExpired
              ? html`<select data-invite-role="${invite.inviteId}">${["ADMIN", "EDITOR", "VIEWER"].map((role) => html`<option value="${role}"${invite.wsRole === role ? " selected" : ""}>${role.charAt(0) + role.slice(1).toLowerCase()}</option>`)}</select>`
              : roleChip(invite.wsRole)}</td>
            <td class="muted">${invite.invitedBy?.name ?? "—"}</td>
            <td class="muted">${timeAgo(invite.lastSentAt ?? invite.sentAt)}${invite.resendCount ? ` · resent ${invite.resendCount}×` : ""}</td>
            <td>${invite.isExpired ? html`<span class="chip chip-danger">Expired</span>` : html`<span class="muted">${timeAgo(invite.expiresAt)}</span>`}</td>
            <td class="actions">${manage ? html`<button class="btn btn-ghost btn-icon btn-sm" data-invite-menu="${invite.inviteId}" data-popover-anchor aria-label="Invitation actions">${icon("ellipsis")}</button>` : ""}</td>
          </tr>`,
        )}</tbody>
      </table></div>`,
    );
    rows.querySelectorAll("[data-invite-role]").forEach((select) =>
      select.addEventListener("change", async () => {
        const invite = view.invites.find((one) => one.inviteId === select.dataset.inviteRole);
        const result = await patch(ws(id, `/invites/${encodeURIComponent(invite.inviteId)}`), { wsRole: select.value });
        if (!result.ok) {
          select.value = invite.wsRole;
          toast(result.error, "error");
          return;
        }
        invite.wsRole = select.value;
        toast("Invitation updated");
      }),
    );
    rows.querySelectorAll("[data-invite-menu]").forEach((button) =>
      button.addEventListener("click", () => {
        const invite = view.invites.find((one) => one.inviteId === button.dataset.inviteMenu);
        popover(button, [
          { label: "Resend email", icon: "send", onClick: () => resend(invite) },
          { label: "Copy invite link", icon: "link", onClick: () => copyLink(invite) },
          "sep",
          { label: "Revoke invitation", icon: "x", danger: true, onClick: () => revoke(invite) },
        ]);
      }),
    );
  }

  async function resend(invite) {
    const result = await post(ws(id, `/invites/${encodeURIComponent(invite.inviteId)}/resend`), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`Sent again to ${invite.email}`);
    loadInvites();
  }

  async function copyLink(invite) {
    const result = await get(ws(id, `/invites/${encodeURIComponent(invite.inviteId)}/link`));
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    copyText(result.data.url);
  }

  async function revoke(invite) {
    const yes = await confirmDialog({ title: `Revoke the invitation to ${invite.email}?`, message: "The link stops working and its seat is freed.", confirmLabel: "Revoke", danger: true });
    if (!yes) {
      return;
    }
    const result = await del(ws(id, `/invites/${encodeURIComponent(invite.inviteId)}`));
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast("Invitation revoked");
    await refreshWorkspace();
    loadSeats();
    loadInvites();
  }

  // ── invite dialog ────────────────────────────────────────────────────

  function openInvite() {
    let role = "EDITOR";
    openModal({
      title: `Invite people to ${state.workspace.name}`,
      subtitle: "They'll get an email with a link to join.",
      size: "lg",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Email addresses</span><textarea name="emails" placeholder="name@company.com, another@company.com" rows="3"></textarea><span class="hint">Separate addresses with commas, spaces or new lines.</span></label>
          <div class="field"><span class="field-label">Role</span>
            <div class="segmented" data-roles>${ROLES.map((one) => html`<button type="button" data-role="${one.value}" class="${one.value === role ? "active" : ""}">${one.label}</button>`)}</div>
            <span class="hint" data-role-text>${ROLES.find((one) => one.value === role).text}</span>
          </div>
          <label class="field"><span>Personal message <span class="muted">(optional)</span></span><input type="text" name="message" maxlength="500" placeholder="Welcome aboard!" /></label>
          <div data-preview></div>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-send disabled>${icon("send")} Send invitations</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        const send = modal.querySelector("[data-send]");
        const previewBox = modal.querySelector("[data-preview]");
        let valid = [];
        const preview = debounce(async () => {
          const recipients = parseEmails(form.elements.emails.value);
          if (recipients.length === 0) {
            previewBox.innerHTML = "";
            send.disabled = true;
            return;
          }
          const result = await post(ws(id, "/invites/preview"), { recipients: recipients, wsRole: role });
          if (!result.ok) {
            mount(previewBox, html`<div class="form-error">${icon("circle-alert")}<span>${result.error}</span></div>`);
            send.disabled = true;
            return;
          }
          const data = result.data;
          valid = data.valid ?? [];
          const seats = data.seats ?? {};
          mount(
            previewBox,
            html`<div class="card" style="background:var(--bg-input)"><div class="card-body" style="display:grid;gap:10px">
              ${valid.length ? html`<div><div class="field-label" style="margin-bottom:6px">Will be invited</div><div class="chips-input">${valid.map((email) => html`<span class="chip chip-brand">${email}</span>`)}</div></div>` : ""}
              ${(data.invalid ?? []).length ? html`<div><div class="field-label" style="margin-bottom:6px">Not valid</div><div class="chips-input">${data.invalid.map((one) => html`<span class="chip chip-danger" title="${one.reason}">${one.email}</span>`)}</div></div>` : ""}
              ${(data.alreadyMember ?? []).length ? html`<div><div class="field-label" style="margin-bottom:6px">Already members</div><div class="chips-input">${data.alreadyMember.map((email) => html`<span class="chip">${email}</span>`)}</div></div>` : ""}
              ${(data.alreadyInvited ?? []).length ? html`<div><div class="field-label" style="margin-bottom:6px">Already invited</div><div class="chips-input">${data.alreadyInvited.map((email) => html`<span class="chip">${email}</span>`)}</div></div>` : ""}
              <div class="meter-row">${seats.shortBy > 0
                ? html`<span class="warning-text">${icon("triangle-alert")} Short by ${seats.shortBy} seat${seats.shortBy === 1 ? "" : "s"} — add seats in Billing, or invite as Viewer (free).</span>`
                : html`<span>${role === "VIEWER" ? "Viewers don't take a seat." : `Uses ${seats.wouldConsume ?? 0} of ${seats.free ?? 0} free seats.`}</span>`}</div>
            </div></div>`,
          );
          send.disabled = valid.length === 0 || seats.shortBy > 0;
        }, 350);
        form.elements.emails.addEventListener("input", preview);
        modal.querySelectorAll("[data-role]").forEach((button) =>
          button.addEventListener("click", () => {
            role = button.dataset.role;
            modal.querySelectorAll("[data-role]").forEach((one) => one.classList.toggle("active", one === button));
            modal.querySelector("[data-role-text]").textContent = ROLES.find((one) => one.value === role).text;
            preview();
          }),
        );
        send.addEventListener("click", () =>
          busy(send, async () => {
            setFormError(form, null);
            const body = { recipients: valid, wsRole: role };
            if (form.elements.message.value.trim()) {
              body.message = form.elements.message.value.trim();
            }
            const result = await post(ws(id, "/invites"), body);
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            const sent = result.data.invites?.length ?? 0;
            toast(`${sent} invitation${sent === 1 ? "" : "s"} sent`);
            await refreshWorkspace();
            loadSeats();
            setTab("invitations");
          }),
        );
      },
    });
  }

  content.querySelector("[data-invite]")?.addEventListener("click", openInvite);
  content.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  loadSeats();
  setTab(view.tab);
  if (params_.invite === "1" && can("member.invite")) {
    history.replaceState(null, "", `#/w/${id}/members`);
    openInvite();
  }
}
