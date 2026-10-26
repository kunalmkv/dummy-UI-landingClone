// Account & security: the signed-in person's own sign-in settings — profile,
// password, two-factor, Google and sessions.

import { get, post } from "../lib/api.js";
import { renderGoogleButton } from "../lib/google.js";
import { go, navigation } from "../lib/router.js";
import { signedOut, state } from "../lib/state.js";
import { busy, confirmDialog, copyText, emptyState, formValues, fullName, html, icon, mount, openModal, setFormError, shortDate, timeAgo, toast } from "../lib/ui.js";
import { signOut } from "./auth.js";
import { activity, emailCard, mockNote, notifications, photoCard, preferences, privacy, profileEditCard } from "./account-me.js";
import { centeredHeader, wireUserMenu } from "./start.js";

const SECTIONS = [
  { key: "profile", label: "Profile", icon: "user" },
  { key: "password", label: "Password", icon: "key-round" },
  { key: "two-factor", label: "Two-factor", icon: "smartphone" },
  { key: "google", label: "Google", icon: "link" },
  { key: "sessions", label: "Sessions", icon: "monitor-smartphone" },
  { key: "activity", label: "Security activity", icon: "shield-check" },
  { key: "preferences", label: "Preferences", icon: "sliders-horizontal" },
  { key: "notifications", label: "Notifications", icon: "bell" },
  { key: "privacy", label: "Terms, export & closing", icon: "file-text" },
];

export async function renderAccount({ params }) {
  const section = SECTIONS.find((one) => one.key === params.section) ?? SECTIONS[0];
  const app = document.getElementById("app");
  const here = navigation();
  const result = await get("/auth/profile/get");
  // Asked for another page while this one loaded: that one draws, not this.
  if (navigation() !== here) {
    return;
  }
  if (!result.ok) {
    if (result.status === 401) {
      signedOut();
      go("/signin");
      return;
    }
    toast(result.error, "error");
    return;
  }
  const data = result.data;
  state.user = data.user;
  mount(
    app,
    html`<div class="centered-page"><div class="page-width">
      ${centeredHeader()}
      <div class="page-head" style="margin-top:18px">
        <div><h1>Account & security</h1><p>Your sign-in, password, two-factor and devices.</p></div>
        <div class="actions"><a class="btn" href="#/">${icon("arrow-left")} Back to workspaces</a></div>
      </div>
      <div class="settings">
        <nav class="subnav">${SECTIONS.map((one) => html`<a href="#/account/${one.key}" class="${one.key === section.key ? "active" : ""}">${icon(one.icon)}<span>${one.label}</span></a>`)}</nav>
        <div class="section-stack" id="section"></div>
      </div>
    </div></div>`,
  );
  wireUserMenu(app);
  const target = app.querySelector("#section");
  const again = () => renderAccount({ params: { section: section.key } });
  const render = { profile, password, "two-factor": twoFactor, google, sessions, activity, preferences, notifications, privacy }[section.key];
  await render(target, data, again);
}

// ── profile ────────────────────────────────────────────────────────────

function profile(target, data, again) {
  const user = data.user;
  const organizations = user.organizations ?? (data.organization ? [{ ...data.organization, orgRole: user.role, isPrimary: true }] : []);
  mount(
    target,
    html`<div class="card" id="edit-card"></div>
      <div class="card" id="photo-card"></div>
      <div class="card" id="email-card"></div>
      <div class="card">
        <div class="card-head"><div><h2>Account</h2><p>The account you are signed in with.</p></div></div>
        <div class="card-body"><dl class="kv">
          <dt>Name</dt><dd>${fullName(user)}</dd>
          <dt>Email</dt><dd>${user.email} ${user.emailVerifiedAt ? html`<span class="chip chip-success">Verified</span>` : html`<span class="chip chip-warning">Not verified</span>`}</dd>
          <dt>Status</dt><dd>${user.status}</dd>
          <dt>Last sign-in</dt><dd>${user.lastLoginAt ? timeAgo(user.lastLoginAt) : "—"}</dd>
          <dt>Two-factor</dt><dd>${data.mfaEnabled ? html`<span class="chip chip-success">On</span>` : html`<span class="chip">Off</span>`} <a href="#/account/two-factor">${data.mfaEnabled ? "Manage" : "Set up"}</a></dd>
          <dt>Google</dt><dd>${data.googleLinked ? html`<span class="chip chip-success">Linked</span>` : html`<span class="chip">Not linked</span>`} <a href="#/account/google">${data.googleLinked ? "Manage" : "Link"}</a></dd>
        </dl></div>
        <div class="card-foot"><button class="btn" data-signout>${icon("log-out")} Sign out</button></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Organizations</h2><p>Where you hold a seat. The primary one is where new workspaces start.</p></div></div>
        ${organizations.length === 0
          ? emptyState({ iconName: "building-2", title: "No organization", text: "You are not in an organization." })
          : html`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Your role</th><th></th></tr></thead><tbody>${organizations.map(
              (organization) => html`<tr><td>${organization.name}</td><td><span class="chip">${organization.orgRole ?? organization.role ?? "—"}</span></td><td>${organization.isPrimary ? html`<span class="chip chip-brand">Primary</span>` : ""}</td></tr>`,
            )}</tbody></table></div>`}
      </div>`,
  );
  target.querySelector("[data-signout]").addEventListener("click", () => signOut());
  profileEditCard(target.querySelector("#edit-card"), user, again);
  photoCard(target.querySelector("#photo-card"), user, again);
  emailCard(target.querySelector("#email-card"), user);
}

// ── password ───────────────────────────────────────────────────────────

function password(target) {
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Change password</h2><p>Other devices are signed out, and any emailed links still open are cancelled. This one stays signed in.</p></div></div>
      <form class="card-body form" id="password-form" novalidate>
        <label class="field"><span>Current password</span><input type="password" name="currentPassword" autocomplete="current-password" required /></label>
        <label class="field"><span>New password</span><input type="password" name="newPassword" autocomplete="new-password" required /><span class="hint">10 to 72 characters.</span></label>
        <label class="field"><span>Repeat the new password</span><input type="password" name="repeat" autocomplete="new-password" required /></label>
        <div><button class="btn btn-primary" type="submit">Change password</button></div>
      </form>
    </div>`,
  );
  const form = target.querySelector("#password-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      if (values.newPassword !== values.repeat) {
        setFormError(form, "The two new passwords don't match.");
        return;
      }
      const result = await post("/auth/password/change", { currentPassword: values.currentPassword, newPassword: values.newPassword });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      form.reset();
      toast("Password changed. Your other devices were signed out.");
    });
  });
}

// ── two-factor ─────────────────────────────────────────────────────────

function twoFactor(target, data, again) {
  if (data.mfaEnabled) {
    twoFactorOn(target, again);
  } else {
    twoFactorOff(target, again);
  }
}

function twoFactorOff(target, again) {
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Two-factor authentication</h2><p>Ask for a code from an authenticator app after the password, so a stolen password isn't enough.</p></div><span class="chip">Off</span></div>
      <div class="card-body"><button class="btn btn-primary" data-setup>${icon("smartphone")} Set up an authenticator app</button></div>
    </div>`,
  );
  target.querySelector("[data-setup]").addEventListener("click", (event) =>
    busy(event.currentTarget, async () => {
      const result = await post("/auth/mfa/setup", {});
      if (!result.ok) {
        toast(result.error, "error");
        // 409: it is already on — show the real state.
        if (result.status === 409) {
          again();
        }
        return;
      }
      scanStep(target, result.data, again);
    }),
  );
}

function scanStep(target, setup, again) {
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Scan, then confirm</h2><p>Nothing is turned on until you enter a code from the app.</p></div></div>
      <div class="card-body form">
        <div class="two-factor-scan">
          <img class="qr" alt="QR code for your authenticator app" data-qr width="180" height="180" />
          <div class="form">
            <p class="secondary">1. Scan the code with Google Authenticator, 1Password, Authy or similar.</p>
            <p class="secondary">Or enter this key by hand:</p>
            <div class="secret"><span data-key>${setup.manualEntryKey}</span><button class="btn btn-ghost btn-sm btn-icon" data-copy-key aria-label="Copy the key">${icon("copy")}</button></div>
          </div>
        </div>
        <form class="form" id="enable-form" novalidate>
          <label class="field"><span>2. The 6-digit code the app shows</span><input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" required /></label>
          <div class="row-2"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Turn on two-factor</button></div>
        </form>
      </div>
    </div>`,
  );
  target.querySelector("[data-qr]").src = setup.qrCode;
  target.querySelector("[data-copy-key]").addEventListener("click", () => copyText(setup.manualEntryKey));
  target.querySelector("[data-cancel]").addEventListener("click", again);
  const form = target.querySelector("#enable-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/mfa/enable", { code: form.elements.code.value.trim() });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      toast("Two-factor is on");
      codesStep(target, result.data.backupCodes, "Save your backup codes", again);
    });
  });
}

/** The backup codes, shown once, with copy and download. */
function codesStep(target, codes, title, again) {
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>${title}</h2><p>Each code works once if you lose your phone. This is the only time they are shown.</p></div></div>
      <div class="card-body form">
        <ul class="backup-codes" data-codes>${codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
        <div class="row-2"><button class="btn" data-copy-codes>${icon("copy")} Copy all</button><button class="btn" data-download>${icon("download")} Download</button></div>
      </div>
      <div class="card-foot"><button class="btn btn-primary" data-done>I've saved them</button></div>
    </div>`,
  );
  const text = codes.join("\n");
  target.querySelector("[data-copy-codes]").addEventListener("click", () => copyText(text));
  target.querySelector("[data-download]").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = "insidefi-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  target.querySelector("[data-done]").addEventListener("click", again);
}

function twoFactorOn(target, again) {
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Two-factor authentication</h2><p>You are asked for an authenticator code after your password.</p></div><span class="chip chip-success">On</span></div>
      <div class="danger-row"><div><h3>New backup codes</h3><p>Replaces every backup code. The old ones stop working at once.</p></div><button class="btn" data-regenerate>New codes…</button></div>
      <div class="danger-row"><div><h3>Turn off two-factor</h3><p>Needs your password and a current code from the app.</p></div><button class="btn btn-danger" data-disable>Turn off…</button></div>
    </div>`,
  );
  target.querySelector("[data-regenerate]").addEventListener("click", () =>
    openModal({
      title: "Get new backup codes",
      subtitle: "Confirm your password. The current backup codes stop working.",
      body: html`<form class="modal-body form" novalidate><label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" /></label></form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Get new codes</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const result = await post("/auth/mfa/regenerate-backup-codes", { currentPassword: form.elements.currentPassword.value });
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            codesStep(target, result.data.backupCodes, "Your new backup codes", again);
          }),
        );
      },
    }),
  );
  target.querySelector("[data-disable]").addEventListener("click", () =>
    openModal({
      title: "Turn off two-factor?",
      subtitle: "Sign-ins will need only your password.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" /></label>
          <label class="field"><span>Code from your authenticator app</span><input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" /><span class="hint">A backup code won't work here.</span></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-submit>Turn off</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            const result = await post("/auth/mfa/disable", { currentPassword: form.elements.currentPassword.value, code: form.elements.code.value.trim() });
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            toast("Two-factor is off");
            again();
          }),
        );
      },
    }),
  );
}

// ── Google ─────────────────────────────────────────────────────────────

function google(target, data, again) {
  if (data.googleLinked) {
    mount(
      target,
      html`<div class="card">
        <div class="card-head"><div><h2>Google</h2><p>You can sign in with Google.</p></div><span class="chip chip-success">Linked</span></div>
        <div class="danger-row"><div><h3>Unlink Google</h3><p>Sign-ins by Google stop working. It is refused when Google is your only way in, so set a password first.</p></div><button class="btn btn-danger" data-unlink>Unlink…</button></div>
      </div>`,
    );
    target.querySelector("[data-unlink]").addEventListener("click", () =>
      openModal({
        title: "Unlink Google?",
        subtitle: "Confirm your password.",
        body: html`<form class="modal-body form" novalidate><label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" /></label></form>
          <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-submit>Unlink Google</button></div>`,
        onMount: (modal, close) => {
          const form = modal.querySelector("form");
          modal.querySelector("[data-submit]").addEventListener("click", (event) =>
            busy(event.currentTarget, async () => {
              setFormError(form, null);
              const result = await post("/auth/google/unlink", { currentPassword: form.elements.currentPassword.value });
              if (!result.ok) {
                setFormError(form, result.error);
                return;
              }
              close();
              toast("Google unlinked");
              again();
            }),
          );
        },
      }),
    );
    return;
  }
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Google</h2><p>Link a Google account so you can sign in with it. A Google account with the same address as this one links itself the first time you use it to sign in; link here when the addresses differ.</p></div><span class="chip">Not linked</span></div>
      <form class="card-body form" id="link-form" novalidate>
        <label class="field"><span>Your password</span><input type="password" name="currentPassword" autocomplete="current-password" /><span class="hint">Needed to link, then pick the Google account below.</span></label>
        <div class="google-slot" id="google-link-slot"></div>
      </form>
    </div>`,
  );
  const form = target.querySelector("#link-form");
  renderGoogleButton(target.querySelector("#google-link-slot"), "continue_with", async (idToken) => {
    setFormError(form, null);
    const currentPassword = form.elements.currentPassword.value;
    if (!currentPassword) {
      setFormError(form, "Enter your password first, then pick the Google account again.");
      return;
    }
    const result = await post("/auth/google/link", { idToken: idToken, currentPassword: currentPassword });
    if (!result.ok) {
      setFormError(form, result.error);
      return;
    }
    toast("Google linked");
    again();
  });
}

// ── sessions ───────────────────────────────────────────────────────────

/** A readable device name: the API's `device` when it sends one, else a short read of the user agent. */
function deviceLabel(session) {
  if (session.device) {
    return session.device;
  }
  const agent = session.userAgent ?? "";
  const system = /Windows/.test(agent) ? "Windows" : /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X|Macintosh/.test(agent) ? "Mac" : /Linux/.test(agent) ? "Linux" : null;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : null;
  return [system, browser].filter(Boolean).join(" · ") || agent.slice(0, 40) || "Unknown device";
}

async function sessions(target, data, again) {
  const result = await get("/auth/session/list");
  const rows = result.ok ? (result.data.sessions ?? []).filter((one) => !one.revokedAt) : [];
  mount(
    target,
    html`<div class="card">
      <div class="card-head"><div><h2>Where you're signed in</h2><p>Every device with an open session, newest first.</p></div><div style="display:flex;gap:8px"><button class="btn" data-others>Sign out all other sessions</button><button class="btn btn-danger" data-all>Sign out everywhere</button></div></div>
      ${rows.length === 0
        ? emptyState({ iconName: "monitor-smartphone", title: "No sessions", text: result.ok ? "" : result.error })
        : html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Device</th><th>Where</th><th>Signed in</th><th>Last active</th><th class="actions"></th></tr></thead>
            <tbody>${rows.map(
              (one) => html`<tr data-session="${one.id}">
                <td>${deviceLabel(one)} ${one.current ? html`<span class="chip chip-brand">This device</span>` : ""} ${one.unrecognized ? html`<span class="chip chip-warning">Unrecognized</span>` : ""}</td>
                <td>${one.location || one.ipMasked || one.ip || "—"}</td>
                <td>${shortDate(one.createdAt)}</td>
                <td>${timeAgo(one.lastSeenAt)}</td>
                <td class="actions"><button class="btn btn-sm" data-revoke="${one.id}" data-current="${one.current ? "1" : ""}">${one.current ? "Sign out" : "Revoke"}</button></td>
              </tr>`,
            )}</tbody></table></div>`}
    </div>`,
  );
  target.querySelectorAll("[data-revoke]").forEach((button) =>
    button.addEventListener("click", async () => {
      const current = button.dataset.current === "1";
      const yes = await confirmDialog({
        title: current ? "Sign out of this device?" : "Sign that device out?",
        // Older APIs don't say which row is this device, so the warning covers it.
        message: current ? "You'll need to sign in again here." : "It is signed out right away. If it is the device you are using now, you will be signed out here too.",
        confirmLabel: current ? "Sign out" : "Revoke",
        danger: true,
      });
      if (!yes) {
        return;
      }
      const revoked = await post("/auth/session/revoke", { sessionId: button.dataset.revoke });
      if (!revoked.ok) {
        toast(revoked.error, "error");
        return;
      }
      if (current) {
        signedOut();
        go("/signin");
        return;
      }
      toast("Device signed out");
      // If that was this very session, the profile read inside again() finds it ended and goes to sign in.
      again();
    }),
  );
  target.querySelector("[data-others]").addEventListener("click", async () => {
    const yes = await confirmDialog({ title: "Sign out all other sessions?", message: "Every other device is signed out. You stay signed in here.", confirmLabel: "Sign them out", danger: true });
    if (!yes) {
      return;
    }
    const out = await post("/auth/session/revoke-others", {});
    if (!out.ok) {
      toast(out.error, "error");
      return;
    }
    toast(out.data?.revoked ? `Signed out ${out.data.revoked} other session${out.data.revoked === 1 ? "" : "s"}` : "No other sessions were open");
    again();
  });
  target.querySelector("[data-all]").addEventListener("click", async () => {
    const yes = await confirmDialog({ title: "Sign out everywhere?", message: "Every device, this one included, is signed out. You'll sign in again here.", confirmLabel: "Sign out everywhere", danger: true });
    if (!yes) {
      return;
    }
    const out = await post("/auth/session/logout-all", {});
    if (!out.ok) {
      toast(out.error, "error");
      return;
    }
    signedOut();
    toast(`Signed out of ${out.data?.revoked ?? "every"} session${out.data?.revoked === 1 ? "" : "s"}`);
    go("/signin");
  });
}

