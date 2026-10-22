// The /me screens of Account & security: profile and photo, security activity,
// shell preferences, notifications (the account bell's list and the preference
// matrix), and the account lifecycle (terms, export, delete).

import { del, get, patch, post, put, query } from "../lib/api.js";
import { notificationRow, openNotification } from "../lib/account-bell.js";
import { applyPreferences } from "../lib/prefs.js";
import { state } from "../lib/state.js";
import { avatar, browserTimezone, busy, emptyState, formValues, fullName, html, icon, mount, openModal, setFormError, shortDate, timeAgo, timezones, toast } from "../lib/ui.js";

// The terms version this build shows. The API checks it (UNKNOWN_VERSION).
const CURRENT_TERMS_VERSION = "2026-04";
const LOCALES = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "pt-BR", "ja-JP", "hi-IN"];
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/** A note under a card when the harness answered from the mock, because the API doesn't have the route yet. */
export function mockNote(result) {
  return result?.upstream === "mock"
    ? html`<div class="form-note" data-mock-note>${icon("flask-conical")} Sample data: this route isn't built on the API yet, so the harness answered from the mock.</div>`
    : "";
}

const userOf = (data) => data?.user ?? data;

// ── profile ────────────────────────────────────────────────────────────

export function profileEditCard(target, user, again) {
  const zone = user.timezone ?? browserTimezone();
  const locale = user.locale ?? "en-US";
  mount(
    target,
    html`<div class="card-head"><div><h2>Your details</h2><p>Your name, and the time zone and language used for dates and numbers.</p></div></div>
      <form class="card-body form" id="profile-form" novalidate>
        <div class="row-2">
          <label class="field"><span>First name</span><input type="text" name="firstName" value="${user.firstName ?? ""}" maxlength="100" /></label>
          <label class="field"><span>Last name</span><input type="text" name="lastName" value="${user.lastName ?? ""}" maxlength="100" /></label>
        </div>
        <div class="row-2">
          <label class="field"><span>Time zone</span><select name="timezone">${[...new Set([zone, ...timezones()])].map((one) => html`<option${one === zone ? " selected" : ""}>${one}</option>`)}</select></label>
          <label class="field"><span>Language and region</span><select name="locale">${[...new Set([locale, ...LOCALES])].map((one) => html`<option${one === locale ? " selected" : ""}>${one}</option>`)}</select></label>
        </div>
        <div id="profile-note"></div>
        <div><button class="btn btn-primary" type="submit">Save changes</button></div>
      </form>`,
  );
  const form = target.querySelector("#profile-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await patch("/me/profile", { firstName: values.firstName.trim(), lastName: values.lastName.trim(), timezone: values.timezone, locale: values.locale });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      state.user = { ...state.user, ...userOf(result.data) };
      toast("Profile saved");
      mount(form.querySelector("#profile-note"), mockNote(result));
      again();
    });
  });
}

/** Change the sign-in address: needs the password, then a link to the new address. */
export function emailCard(target, user) {
  mount(
    target,
    html`<div class="card-head"><div><h2>Email address</h2><p>You sign in with <strong>${user.email}</strong>. A link goes to the new address, and a notice to this one. Other devices are signed out when you confirm.</p></div></div>
      <form class="card-body form" id="email-form" novalidate>
        <div class="row-2">
          <label class="field"><span>New email</span><input type="email" name="newEmail" autocomplete="off" placeholder="you@new-company.com" required /></label>
          <label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" required /></label>
        </div>
        <div id="email-note"></div>
        <div><button class="btn" type="submit">Send the confirmation link</button></div>
      </form>`,
  );
  const form = target.querySelector("#email-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/email/change-request", { newEmail: values.newEmail.trim(), currentPassword: values.currentPassword });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      const pending = result.data.pending;
      mount(
        form.querySelector("#email-note"),
        html`<div class="form-note" data-email-pending>We sent a link to <strong>${pending.email}</strong>. It works until ${shortDate(pending.expiresAt)}. Open it while signed in here, or <a href="#/confirm-email">paste its token</a>.</div>${mockNote(result)}`,
      );
      form.elements.currentPassword.value = "";
    });
  });
}

export function photoCard(target, user, again) {
  mount(
    target,
    html`<div class="card-head"><div><h2>Photo</h2><p>PNG, JPEG or WebP, up to 2 MB.</p></div></div>
      <div class="card-body form">
        <div style="display:flex;align-items:center;gap:16px">
          <span data-avatar>${user.avatarUrl ? html`<img class="avatar-img" alt="" src="${user.avatarUrl}" data-avatar-img />` : avatar(fullName(user), user.id, "lg")}</span>
          <div class="form" style="flex:1">
            <input type="file" accept="image/png,image/jpeg,image/webp" data-photo />
            <div id="photo-note"></div>
          </div>
        </div>
      </div>
      <div class="card-foot"><button class="btn" data-remove-photo ${user.avatarUrl ? "" : "disabled"}>Remove photo</button></div>`,
  );
  // A sample image URL from the mock may not load; fall back to the initials.
  target.querySelector("[data-avatar-img]")?.addEventListener("error", (event) => {
    event.currentTarget.replaceWith(...(() => {
      const holder = document.createElement("span");
      holder.innerHTML = String(avatar(fullName(user), user.id, "lg"));
      return holder.childNodes;
    })());
  });
  const note = target.querySelector("#photo-note");
  const say = (message, kind = "form-note") => mount(note, html`<div class="${kind}">${message}</div>`);
  target.querySelector("[data-photo]").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    if (!PHOTO_TYPES.includes(file.type)) {
      say("That file type isn't allowed. Use PNG, JPEG or WebP.", "form-error");
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      say("That image is over 2 MB.", "form-error");
      return;
    }
    say("Uploading…");
    const minted = await post("/me/avatar/upload-url", { contentType: file.type, bytes: file.size });
    if (!minted.ok) {
      say(minted.error, "form-error");
      return;
    }
    // The mock's upload URL is a sample, so the file is sent only to a real one.
    if (minted.upstream !== "mock") {
      try {
        const sent = await fetch(minted.data.uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
        if (!sent.ok) {
          say(`The upload was refused (HTTP ${sent.status}).`, "form-error");
          return;
        }
      } catch {
        say("The upload could not reach the storage address.", "form-error");
        return;
      }
    }
    const committed = await post("/me/avatar/commit", { assetId: minted.data.assetId });
    if (!committed.ok) {
      say(committed.error, "form-error");
      return;
    }
    state.user = { ...state.user, ...userOf(committed.data) };
    toast("Photo saved");
    again();
  });
  target.querySelector("[data-remove-photo]").addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await del("/me/avatar");
      if (!result.ok) {
        say(result.error, "form-error");
        return;
      }
      state.user = { ...state.user, ...userOf(result.data) };
      toast("Photo removed");
      again();
    }),
  );
}

// ── security activity ──────────────────────────────────────────────────

const EVENT_LABELS = {
  SIGNIN_OK: "Signed in",
  LOGIN_PASSWORD_WRONG: "Wrong password",
  MFA_ENABLE_OK: "Two-factor turned on",
  MFA_DISABLE_OK: "Two-factor turned off",
  PASSWORD_CHANGE_OK: "Password changed",
  GOOGLE_LINK_OK: "Google linked",
  GOOGLE_UNLINK_OK: "Google unlinked",
  SESSION_REVOKE_OK: "A device was signed out",
};

const eventLabel = (event) => EVENT_LABELS[event] ?? event.toLowerCase().replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());

export async function activity(target) {
  let cursor = null;
  let outcome = "";
  const rows = [];
  const draw = (result) =>
    mount(
      target,
      html`<div class="card">
        <div class="card-head"><div><h2>Security activity</h2><p>Sign-ins and changes to how you sign in, for the last 90 days. Wrong attempts are listed too.</p></div></div>
        <div class="toolbar"><label class="field" style="max-width:220px"><span>Result</span><select data-outcome><option value="">All</option><option value="ok"${outcome === "ok" ? " selected" : ""}>Succeeded</option><option value="refused"${outcome === "refused" ? " selected" : ""}>Refused</option></select></label></div>
        ${!result.ok
          ? emptyState({ iconName: "lock", title: "Not available", text: result.error })
          : rows.length === 0
            ? emptyState({ iconName: "shield-check", title: "Nothing to show", text: "No security events match." })
            : html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>What</th><th>Result</th><th>Where</th><th>Device</th></tr></thead><tbody data-rows>${rows.map(
                (row) => html`<tr><td>${shortDate(row.at)} <span class="muted">${timeAgo(row.at)}</span></td><td>${eventLabel(row.event)}</td><td>${row.outcome === "ok" ? html`<span class="chip chip-success">OK</span>` : html`<span class="chip chip-warning">Refused</span>`}</td><td>${row.location || row.ipMasked || row.ip || "—"}</td><td>${row.device || "—"}</td></tr>`,
              )}</tbody></table></div>`}
        ${cursor ? html`<div class="card-foot"><button class="btn" data-more>Load more</button></div>` : ""}
        ${mockNote(result)}
      </div>`,
    );
  const load = async () => {
    const result = await get(`/me/security/activity${query({ outcome: outcome, limit: 20, cursor: cursor })}`);
    if (result.ok) {
      rows.push(...(result.data.items ?? []));
      cursor = result.data.nextCursor ?? null;
    }
    draw(result);
    target.querySelector("[data-outcome]")?.addEventListener("change", (event) => {
      outcome = event.currentTarget.value;
      rows.length = 0;
      cursor = null;
      load();
    });
    target.querySelector("[data-more]")?.addEventListener("click", load);
  };
  await load();
}

// ── preferences ────────────────────────────────────────────────────────

const segmented = (name, options, current) => html`<div class="segmented" data-segment="${name}">${options.map(([value, label]) => html`<button type="button" data-value="${value}" class="${value === current ? "active" : ""}">${label}</button>`)}</div>`;

export async function preferences(target) {
  const result = await get("/me/preferences");
  if (!result.ok) {
    mount(target, html`<div class="card">${emptyState({ iconName: "lock", title: "Not available", text: result.error })}</div>`);
    return;
  }
  const prefs = result.data;
  const dnd = prefs.doNotDisturb ?? { enabled: false, until: null };
  const until = dnd.until ? new Date(dnd.until) : null;
  // datetime-local wants the local clock, without a zone.
  const localUntil = until ? new Date(until.getTime() - until.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Preferences</h2><p>How the app looks. These follow you to every device.</p></div></div>
      <form class="card-body form" id="prefs-form" novalidate>
        <div class="field"><span>Appearance</span>${segmented("appearance", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], prefs.appearance)}</div>
        <div class="field"><span>Density</span>${segmented("density", [["comfortable", "Comfortable"], ["compact", "Compact"]], prefs.density)}</div>
        <div class="field">
          <label class="check"><input type="checkbox" name="dndEnabled" ${dnd.enabled ? "checked" : ""} /> Do not disturb</label>
          <span class="hint">Mutes notifications and shows you as unavailable to teammates.</span>
          <input type="datetime-local" name="dndUntil" value="${localUntil}" ${dnd.enabled ? "" : "disabled"} />
          <span class="hint">Until (leave empty to keep it on).</span>
        </div>
        <div id="prefs-note">${mockNote(result)}</div>
        <div><button class="btn btn-primary" type="submit">Save preferences</button></div>
      </form>
    </div>`,
  );
  const form = target.querySelector("#prefs-form");
  const chosen = { appearance: prefs.appearance, density: prefs.density };
  form.querySelectorAll("[data-segment]").forEach((group) =>
    group.querySelectorAll("button").forEach((button) =>
      button.addEventListener("click", () => {
        chosen[group.dataset.segment] = button.dataset.value;
        group.querySelectorAll("button").forEach((one) => one.classList.toggle("active", one === button));
      }),
    ),
  );
  form.elements.dndEnabled.addEventListener("change", () => {
    form.elements.dndUntil.disabled = !form.elements.dndEnabled.checked;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const enabled = form.elements.dndEnabled.checked;
      const untilValue = form.elements.dndUntil.value;
      const saved = await patch("/me/preferences", {
        appearance: chosen.appearance,
        density: chosen.density,
        doNotDisturb: { enabled: enabled, until: enabled && untilValue ? new Date(untilValue).toISOString() : null },
      });
      if (!saved.ok) {
        setFormError(form, saved.error);
        return;
      }
      applyPreferences(saved.data);
      toast("Preferences saved");
    });
  });
}

// ── notifications ──────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  security: ["Security", "Sign-ins, password, two-factor and email changes."],
  invites: ["Invitations", "Invitations sent to you, and yours being accepted."],
  leads: ["Leads", "New leads, instantly or as a digest."],
  delivery: ["Delivery problems", "Failed webhooks, CRM pushes and bounces."],
  experiments: ["Experiments", "Split tests that ended and insights."],
  exports: ["Exports and domains", "Exports ready, domains and certificates."],
  mentions: ["Mentions", "Someone mentioned you in a lead note."],
  product: ["Product news", "Release notes and announcements."],
};

export async function notifications(target) {
  mount(target, html`<div class="card" id="bell-card"></div><div class="card" id="matrix-card"></div>`);
  await Promise.all([bellList(target.querySelector("#bell-card")), matrix(target.querySelector("#matrix-card"))]);
}

async function bellList(target) {
  const result = await get(`/me/notifications${query({ status: "all", limit: 20 })}`);
  const items = result.ok ? result.data.items ?? [] : [];
  mount(
    target,
    html`<div class="card-head"><div><h2>Account notifications</h2><p>What the bell shows before you open a workspace${result.ok ? html`. ${result.data.unreadCount ?? 0} unread.` : ""}</p></div><button class="btn" data-read-all ${items.length ? "" : "disabled"}>Mark all read</button></div>
      ${!result.ok ? emptyState({ iconName: "lock", title: "Not available", text: result.error }) : items.length === 0 ? emptyState({ iconName: "bell", title: "You're all caught up", text: "" }) : html`<div class="notif-list" data-list>${items.map(notificationRow)}</div>`}
      ${mockNote(result)}`,
  );
  target.querySelectorAll("[data-note]").forEach((row) =>
    row.addEventListener("click", async () => {
      await openNotification(items.find((one) => one.id === row.dataset.note));
      bellList(target);
    }),
  );
  target.querySelector("[data-read-all]")?.addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const marked = await post("/me/notifications/read", { all: true });
      toast(marked.ok ? "All marked read" : marked.error, marked.ok ? "success" : "error");
      bellList(target);
    }),
  );
}

async function matrix(target) {
  const result = await get("/me/notification-preferences");
  if (!result.ok) {
    mount(target, html`<div class="card-head"><div><h2>Notification preferences</h2></div></div>${emptyState({ iconName: "lock", title: "Not available", text: result.error })}`);
    return;
  }
  const { categories, quietHours } = result.data;
  const quiet = quietHours ?? { enabled: false, from: "21:00", to: "07:00", timezone: browserTimezone() };
  mount(
    target,
    html`<div class="card-head"><div><h2>Notification preferences</h2><p>Choose what reaches you, and how.</p></div></div>
      <form class="card-body form" id="matrix-form" novalidate>
        <div class="table-wrap"><table class="table"><thead><tr><th>What</th><th>In the app</th><th>By email</th><th>Digest</th></tr></thead><tbody>${Object.entries(categories).map(([key, row]) => {
          const [label, text] = CATEGORY_LABELS[key] ?? [key, ""];
          return html`<tr data-category="${key}">
            <td><div style="font-weight:500">${label}</div><div class="muted" style="font-size:12px">${text}</div></td>
            <td><input type="checkbox" name="inApp" ${row.inApp ? "checked" : ""} aria-label="${label} in the app" /></td>
            <td><input type="checkbox" name="email" ${row.email ? "checked" : ""} ${row.locked ? "disabled" : ""} aria-label="${label} by email" />${row.locked ? html` <span class="muted" title="Always on">${icon("lock")}</span>` : ""}</td>
            <td>${row.digest !== undefined ? html`<select name="digest">${["instant", "daily", "weekly", "off"].map((one) => html`<option${one === row.digest ? " selected" : ""}>${one}</option>`)}</select>` : html`<span class="muted">—</span>`}</td>
          </tr>`;
        })}</tbody></table></div>
        <div class="field">
          <label class="check"><input type="checkbox" name="quietEnabled" ${quiet.enabled ? "checked" : ""} /> Quiet hours</label>
          <div class="row-2"><label class="field"><span>From</span><input type="time" name="quietFrom" value="${quiet.from}" /></label><label class="field"><span>To</span><input type="time" name="quietTo" value="${quiet.to}" /></label></div>
          <span class="hint">Time zone: ${quiet.timezone}</span>
        </div>
        ${mockNote(result)}
        <div><button class="btn btn-primary" type="submit">Save preferences</button></div>
      </form>`,
  );
  const form = target.querySelector("#matrix-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const next = {};
      form.querySelectorAll("[data-category]").forEach((row) => {
        const key = row.dataset.category;
        next[key] = { inApp: row.querySelector('[name="inApp"]').checked, email: row.querySelector('[name="email"]').checked };
        if (categories[key].locked) {
          next[key].locked = true;
        }
        const digest = row.querySelector('[name="digest"]');
        if (digest) {
          next[key].digest = digest.value;
        }
      });
      const saved = await put("/me/notification-preferences", {
        categories: next,
        quietHours: { enabled: form.elements.quietEnabled.checked, from: form.elements.quietFrom.value, to: form.elements.quietTo.value, timezone: quiet.timezone },
      });
      if (!saved.ok) {
        setFormError(form, saved.error);
        return;
      }
      toast("Notification preferences saved");
    });
  });
}

// ── privacy: terms, export, closing the account ────────────────────────

export function privacy(target, data, again) {
  const user = data.user;
  mount(
    target,
    html`<div class="card" id="terms-card">
        <div class="card-head"><div><h2>Terms of service</h2><p>${user.termsAcceptedVersion ? html`You accepted version <strong>${user.termsAcceptedVersion}</strong>.` : "You haven't accepted a version yet."} The current version is <strong>${CURRENT_TERMS_VERSION}</strong>.</p></div></div>
        <form class="card-body form" id="terms-form" novalidate>
          <label class="field"><span>Version to accept</span><input type="text" name="version" value="${CURRENT_TERMS_VERSION}" /></label>
          <div id="terms-note"></div>
          <div><button class="btn btn-primary" type="submit">Accept these terms</button></div>
        </form>
      </div>
      <div class="card" id="export-card">
        <div class="card-head"><div><h2>Export your data</h2><p>A copy of your profile, security activity, preferences, memberships and your own audit entries. One request a day.</p></div></div>
        <div class="card-body form"><div id="export-note"></div><div><button class="btn" data-export>${icon("download")} Request an export</button></div></div>
      </div>
      <div class="card danger-card" id="delete-card"></div>`,
  );

  const termsForm = target.querySelector("#terms-form");
  termsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(termsForm.querySelector("button[type=submit]"), async () => {
      setFormError(termsForm, null);
      const result = await post("/me/terms/accept", { version: termsForm.elements.version.value.trim() });
      if (!result.ok) {
        setFormError(termsForm, result.error);
        return;
      }
      state.user = { ...state.user, termsAcceptedVersion: result.data.acceptedVersion };
      mount(target.querySelector("#terms-note"), html`<div class="form-note" data-terms-done>Accepted version ${result.data.acceptedVersion} on ${shortDate(result.data.acceptedAt)}.</div>${mockNote(result)}`);
    });
  });

  target.querySelector("[data-export]").addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await post("/me/export", {});
      const note = target.querySelector("#export-note");
      if (!result.ok) {
        mount(note, html`<div class="form-error">${result.error}</div>`);
        return;
      }
      mount(note, html`<div class="form-note" data-export-done>Export queued (job ${result.data.jobId}). It includes: ${(result.data.includes ?? []).join(", ")}. We'll tell you when it's ready.</div>${mockNote(result)}`);
    }),
  );

  deleteCard(target.querySelector("#delete-card"), again);
}

function deleteCard(target, again) {
  const pending = state.closing ?? null;
  mount(
    target,
    html`<div class="card-head"><div><h2>Close your account</h2><p>Your account closes after 30 days. Until then you can cancel and nothing is lost. Audit entries stay, without your name.</p></div></div>
      ${pending
        ? html`<div class="danger-row"><div><h3>Closing on ${shortDate(pending.purgeAt)}</h3><p>This removes ${pending.blastRadius?.workspaces ?? 0} workspace${pending.blastRadius?.workspaces === 1 ? "" : "s"} and ${pending.blastRadius?.memberships ?? 0} membership${pending.blastRadius?.memberships === 1 ? "" : "s"}. ${pending.blastRadius?.auditRowsRetained ?? 0} audit entries are kept.</p></div><button class="btn" data-cancel-close>Cancel closing</button></div>`
        : html`<div class="danger-row"><div><h3>Close my account</h3><p>You'll be asked for your password.</p></div><button class="btn btn-danger" data-close-account>Close account…</button></div>
            <div class="danger-row"><div><h3>Already asked to close it?</h3><p>Cancel that here, inside the 30 days.</p></div><button class="btn" data-cancel-close>Cancel closing</button></div>`}
      <div id="delete-note"></div>`,
  );
  const note = target.querySelector("#delete-note");
  target.querySelector("[data-cancel-close]")?.addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await post("/me/delete-cancel", {});
      if (!result.ok) {
        mount(note, html`<div class="form-error" data-delete-error>${result.error}</div>`);
        return;
      }
      state.closing = null;
      toast("Your account stays open");
      deleteCard(target, again);
    }),
  );
  target.querySelector("[data-close-account]")?.addEventListener("click", () =>
    openModal({
      title: "Close your account?",
      subtitle: "It closes in 30 days. You can cancel until then.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" /></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-submit>Close my account</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const result = await post("/me/delete-request", { currentPassword: form.elements.currentPassword.value });
            if (result.ok) {
              state.closing = result.data;
              close();
              toast("Your account will close in 30 days");
              deleteCard(target, again);
              return;
            }
            if (result.code === "SOLE_OWNER") {
              const list = result.details?.workspaces ?? [];
              mount(
                form,
                html`<div class="form-error" data-sole-owner>You're the only owner of ${list.length === 1 ? "this workspace" : "these workspaces"}. Hand ${list.length === 1 ? "it" : "them"} over first.</div>
                  <ul class="plain-list">${list.map((one) => html`<li><a href="#/w/${one.workspaceId}/settings/danger" data-transfer-link>${one.name}</a></li>`)}</ul>`,
              );
              form.querySelectorAll("[data-transfer-link]").forEach((link) => link.addEventListener("click", close));
              return;
            }
            if (result.code === "ALREADY_PENDING_DELETE") {
              close();
              mount(note, html`<div class="form-note">This account is already closing. Cancel it here if you changed your mind.</div>`);
              return;
            }
            setFormError(form, result.error);
          }),
        );
      },
    }),
  );
}
