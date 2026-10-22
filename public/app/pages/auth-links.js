// The pages an emailed link opens, and the request pages that send them:
// forgot password, reset password, sign in by link, confirm an address by
// link, and joining an organization from its invitation.

import { get, post, query } from "../lib/api.js";
import { latestMail, tokenOf } from "../lib/devmail.js";
import { afterAuth, authPath, nextFromQuery } from "../lib/invites.js";
import { go } from "../lib/router.js";
import { loadUser, signedOut, state } from "../lib/state.js";
import { busy, formValues, html, mount, roleChip, setFormError, toast } from "../lib/ui.js";
import { authLayout, signOut } from "./auth.js";

const card = (title, text, body = "") => authLayout(html`<div><h1>${title}</h1>${text ? html`<p class="muted" style="margin-top:6px">${text}</p>` : ""}</div>${body}`);
const homeLink = html`<p class="auth-switch"><a href="#/signin">Back to sign in</a></p>`;

// ── forgot password ────────────────────────────────────────────────────

export function renderForgotPassword({ query: params }) {
  const app = document.getElementById("app");
  mount(
    app,
    card(
      "Forgot your password?",
      "Enter your email and we'll send a link to choose a new one.",
      html`<form class="form" id="forgot-form" novalidate>
          <label class="field"><span>Work email</span><input type="email" name="email" autocomplete="email" required value="${params.email ?? ""}" /></label>
          <button class="btn btn-primary btn-block" type="submit">Send reset link</button>
        </form>
        <div id="forgot-note"></div>
        ${homeLink}`,
    ),
  );
  const form = document.getElementById("forgot-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = form.elements.email.value.trim();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/password/forgot", { email: email });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      // The same answer for every address, so nothing here says whether it has an account.
      mount(document.getElementById("forgot-note"), html`<div class="form-note">If ${email} has an account, a reset link is on its way. It works once.</div><div id="forgot-local"></div>`);
      const mail = await latestMail(email, "RESET", { attempts: 6 });
      const token = tokenOf(mail?.payload?.resetLink);
      if (token) {
        mount(document.getElementById("forgot-local"), html`<a class="btn btn-block" id="reset-open" href="#${authPath("reset-password", { token: token })}">Local preview: open the link from the dev inbox</a>`);
      }
    });
  });
}

// ── reset password ─────────────────────────────────────────────────────

export function renderResetPassword({ query: params }) {
  const token = params.token ?? "";
  const app = document.getElementById("app");
  if (!token) {
    mount(app, card("This link is incomplete", "Open the link in your email again, or ask for a new one.", html`<a class="btn btn-block" href="#/forgot-password">Send a new reset link</a>${homeLink}`));
    return;
  }
  mount(
    app,
    card(
      "Choose a new password",
      "Every device is signed out when it changes.",
      html`<form class="form" id="reset-form" novalidate>
          <label class="field"><span>New password</span><input type="password" name="newPassword" autocomplete="new-password" required /><span class="hint">10 to 72 characters.</span></label>
          <label class="field"><span>Repeat it</span><input type="password" name="repeat" autocomplete="new-password" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Change password</button>
        </form>${homeLink}`,
    ),
  );
  const form = document.getElementById("reset-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      if (values.newPassword !== values.repeat) {
        setFormError(form, "The two passwords don't match.");
        return;
      }
      const result = await post("/auth/password/reset", { token: token, newPassword: values.newPassword });
      if (!result.ok) {
        setFormError(form, result.error);
        if (/invalid or has expired/i.test(result.error)) {
          form.querySelector(".form-error").insertAdjacentHTML("beforeend", String(html` <a href="#/forgot-password" id="reset-again">Send a new link</a>`));
        }
        return;
      }
      // The reset signed every session out, this browser's included.
      signedOut();
      toast("Password changed. Sign in with the new one.");
      go("/signin");
    });
  });
}

// ── sign in by link ────────────────────────────────────────────────────

export async function renderMagicLink({ query: params }) {
  const app = document.getElementById("app");
  const token = params.token ?? "";
  if (!token) {
    mount(app, card("This link is incomplete", "Open the link in your email again, or ask for a new one.", homeLink));
    return;
  }
  mount(app, card("Signing you in…", "One moment."));
  const result = await post("/auth/magic-link/consume", { token: token });
  if (!result.ok) {
    mount(app, card("This link can't sign you in", result.error, html`<a class="btn btn-block" href="#/signin">Back to sign in</a>`));
    return;
  }
  if (result.data?.mfaRequired) {
    go(authPath("mfa", { email: result.data.email, next: nextFromQuery(params) }), true);
    return;
  }
  await loadUser();
  afterAuth(null, nextFromQuery(params));
}

// ── confirm an address by link ─────────────────────────────────────────

export async function renderVerifyEmail({ query: params }) {
  const app = document.getElementById("app");
  const token = params.token ?? "";
  const again = params.email ? html`<a class="btn btn-block" href="#${authPath("verify", { email: params.email })}">Enter a code instead</a>` : "";
  if (!token) {
    mount(app, card("This link is incomplete", "Open the link in your email again.", html`${again}${homeLink}`));
    return;
  }
  mount(app, card("Confirming your email…", "One moment."));
  const result = await post("/auth/email/verify", { token: token });
  if (!result.ok) {
    mount(app, card("We couldn't confirm that", result.error, html`${again}${homeLink}`));
    return;
  }
  mount(
    app,
    card("Email confirmed", "Your address is verified. Sign in to continue.", html`<a class="btn btn-primary btn-block" id="verified-signin" href="#${authPath("signin", { email: params.email })}">Sign in</a>`),
  );
}

// ── confirm a new email address ────────────────────────────────────────

export async function renderConfirmEmail({ query: params }) {
  const app = document.getElementById("app");
  const token = params.token ?? "";
  if (!state.user) {
    mount(app, card("Sign in to confirm the change", "The link only works for the account that asked for it. Sign in, then open the link again.", html`<a class="btn btn-primary btn-block" href="#${authPath("signin", { next: token ? `/confirm-email?token=${token}` : "/confirm-email" })}">Sign in</a>`));
    return;
  }
  if (!token) {
    mount(
      app,
      card(
        "Confirm your new email",
        "Paste the token from the link we sent to the new address.",
        html`<form class="form" id="token-form" novalidate>
          <label class="field"><span>Token</span><input type="text" name="token" autocomplete="off" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Confirm</button>
        </form><p class="auth-switch"><a href="#/account/profile">Back to your account</a></p>`,
      ),
    );
    document.getElementById("token-form").addEventListener("submit", (event) => {
      event.preventDefault();
      go(authPath("confirm-email", { token: event.currentTarget.elements.token.value.trim() }));
    });
    return;
  }
  mount(app, card("Confirming your new email…", "One moment."));
  const result = await post("/auth/email/change-confirm", { token: token });
  if (!result.ok) {
    mount(app, card("We couldn't change your email", result.error, html`<a class="btn btn-block" href="#/account/profile">Back to your account</a>`));
    return;
  }
  state.user = { ...state.user, ...(result.data.user ?? {}) };
  mount(
    app,
    card(
      "Email changed",
      html`You now sign in with <strong class="secondary">${result.data.user?.email}</strong>.${result.data.sessionsRevoked ? ` ${result.data.sessionsRevoked} other session${result.data.sessionsRevoked === 1 ? " was" : "s were"} signed out.` : ""}`,
      html`<a class="btn btn-primary btn-block" id="email-changed-done" href="#/account/profile">Back to your account</a>`,
    ),
  );
}

// ── join an organization from its invitation ───────────────────────────

export async function renderAcceptOrgInvite({ query: params }) {
  const app = document.getElementById("app");
  const token = params.token ?? "";
  if (!token) {
    mount(app, card("This invitation link is incomplete", "Open the link in your email again.", homeLink));
    return;
  }
  const preview = await get(`/auth/invite/preview${query({ token: token })}`);
  if (!preview.ok) {
    mount(app, card("This invitation can't be opened", preview.error, html`<a class="btn btn-block" href="#/">Go to Insidefi</a>`));
    return;
  }
  const invite = preview.data;
  const here = `/accept-invite?token=${token}`;
  const summary = html`<dl class="invite-summary">
    <div><dt>Organization</dt><dd>${invite.organizationName}</dd></div>
    <div><dt>Your role</dt><dd>${roleChip(invite.role)}</dd></div>
    <div><dt>Sent to</dt><dd>${invite.email}</dd></div>
  </dl>`;
  const user = state.user;

  if (user && user.email.toLowerCase() !== invite.email.toLowerCase()) {
    mount(
      app,
      card(
        "This invitation is for another address",
        html`It was sent to <strong class="secondary">${invite.email}</strong>, but you're signed in as <strong class="secondary">${user.email}</strong>.`,
        html`${summary}<div class="invite-buttons"><a class="btn" href="#/">Not now</a><button class="btn btn-primary" id="org-invite-switch">Sign out and switch account</button></div>`,
      ),
    );
    document.getElementById("org-invite-switch").addEventListener("click", (event) => busy(event.currentTarget, () => signOut(here)));
    return;
  }

  if (user) {
    mount(
      app,
      card(`Join ${invite.organizationName}`, "You're signed in with the invited address.", html`${summary}<div id="org-invite-error"></div><div class="invite-buttons"><a class="btn" href="#/">Not now</a><button class="btn btn-primary" id="org-invite-join">Join</button></div>`),
    );
    document.getElementById("org-invite-join").addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const result = await post("/auth/invite/accept", { token: token });
        if (!result.ok) {
          mount(document.getElementById("org-invite-error"), html`<div class="form-error">${result.error}</div>`);
          return;
        }
        toast(`You joined ${result.data?.organization?.name ?? invite.organizationName}`);
        go("/");
      }),
    );
    return;
  }

  // Signed out: a new address makes its account here; an existing one signs in first.
  mount(
    app,
    card(
      `Join ${invite.organizationName}`,
      html`Create your account for <strong class="secondary">${invite.email}</strong>. The invitation is the proof of the address, so there is no code to enter.`,
      html`${summary}
        <form class="form" id="org-invite-form" novalidate>
          <div class="row-2">
            <label class="field"><span>First name</span><input type="text" name="firstName" autocomplete="given-name" required /></label>
            <label class="field"><span>Last name</span><input type="text" name="lastName" autocomplete="family-name" required /></label>
          </div>
          <label class="field"><span>Password</span><input type="password" name="password" autocomplete="new-password" required /><span class="hint">10 to 72 characters.</span></label>
          <button class="btn btn-primary btn-block" type="submit">Create account and join</button>
        </form>
        <p class="auth-switch">Already have an account? <a id="org-invite-signin" href="#${authPath("signin", { email: invite.email, next: here })}">Sign in</a></p>`,
    ),
  );
  const form = document.getElementById("org-invite-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/invite/accept", { token: token, firstName: values.firstName.trim(), lastName: values.lastName.trim(), password: values.password });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      await loadUser();
      toast(`You joined ${invite.organizationName}`);
      go("/");
    });
  });
}
