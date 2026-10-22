// Sign in (password, Google, or an emailed link), create an account, confirm the
// email code, and the two-factor code.

import { post } from "../lib/api.js";
import { renderGoogleButton } from "../lib/google.js";
import { latestMail, tokenOf } from "../lib/devmail.js";
import { afterAuth, authPath, invitationFor, inviteFromQuery, nextFromQuery } from "../lib/invites.js";
import { go } from "../lib/router.js";
import { devTarget, loadUser, signedOut } from "../lib/state.js";
import { busy, formValues, html, icon, mount, setFormError, toast } from "../lib/ui.js";

const GOOGLE_BLOCK = html`<div class="auth-divider"><span>or</span></div><div class="google-slot" id="google-button"></div><div id="google-note"></div>`;

/** Google's button under the form; a pick signs in, or signs up a new address. */
function wireGoogle(text, token) {
  renderGoogleButton(document.getElementById("google-button"), text, (idToken) => signInWithGoogle(idToken, token, null));
}

async function signInWithGoogle(idToken, token, organization) {
  const note = document.getElementById("google-note");
  const body = { idToken: idToken, keepSignedIn: document.querySelector('[name="keepSignedIn"]')?.checked ?? false };
  if (organization) {
    body.organization = organization;
  }
  const result = await post("/auth/google/sign-in", body);
  const data = result.data ?? {};
  if (!result.ok) {
    mount(note, html`<div class="form-error">${result.error}</div>`);
  } else if (data.user) {
    await loadUser();
    afterAuth(token);
  } else if (data.mfaRequired) {
    go(authPath("mfa", { email: data.email, invite: token }));
  } else if (data.linkRequired) {
    // Only an API from before 2026-10-14 answers this; dev links a verified address itself.
    mount(note, html`<div class="form-note">${data.email} already has a password account. Sign in with the password; you can link Google afterwards.</div>`);
  } else if (data.organizationRequired) {
    // Only an API from before 2026-10-14 asks; dev names the organization for you.
    mount(
      note,
      html`<form class="form" id="google-org-form" novalidate>
        <div class="form-note">New account for ${data.email}. Name your company to finish.</div>
        <label class="field"><span>Company</span><input type="text" name="organization" required placeholder="Acme Health" /></label>
        <button class="btn btn-primary btn-block" type="submit">Create account with Google</button>
      </form>`,
    );
    const form = document.getElementById("google-org-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = form.elements.organization.value.trim();
      if (value) {
        busy(form.querySelector("button[type=submit]"), () => signInWithGoogle(idToken, token, value));
      }
    });
  }
}

export function authLayout(card) {
  return html`<div class="auth-wrap">
    <aside class="auth-aside">
      <div class="brand"><span class="brand-mark">i</span>Insidefi</div>
      <div>
        <h2>Every campaign, team and project in one workspace.</h2>
        <ul>
          <li>${icon("layout-grid")} Apps for funnels, journeys, insights and more</li>
          <li>${icon("users")} Invite your team with the right role</li>
          <li>${icon("shield-check")} Roles, audit log and API access built in</li>
        </ul>
      </div>
      <p class="muted">Dummy app on the real API · local preview</p>
    </aside>
    <main class="auth-main"><div class="auth-card">${card}</div></main>
  </div>`;
}

export async function renderSignIn({ query }) {
  const invite = await invitationFor(query);
  const token = invite?.token;
  const next = nextFromQuery(query);
  const app = document.getElementById("app");
  mount(
    app,
    authLayout(html`
      <div>
        <h1>${invite ? `Sign in to join ${invite.workspaceName}` : "Welcome back"}</h1>
        <p class="muted" style="margin-top:6px">${invite ? html`Use <strong class="secondary">${invite.email}</strong>, the address the invitation was sent to.` : "Sign in to your workspace."}</p>
      </div>
      <form class="form" id="signin-form" novalidate>
        <label class="field"><span>Work email</span><input type="email" name="email" autocomplete="email" required value="${invite?.email ?? query.email ?? ""}" ${invite ? "readonly" : ""} /></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required /><a class="hint" href="#/forgot-password" id="forgot-link">Forgot your password?</a></label>
        <label class="check"><input type="checkbox" name="keepSignedIn" checked /> Keep me signed in</label>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <button class="btn btn-block" type="button" id="magic-request">Email me a sign-in link instead</button>
        <div id="magic-note"></div>
      </form>
      ${GOOGLE_BLOCK}
      <p class="auth-switch">New to Insidefi? <a href="#${authPath("signup", { invite: token })}">Create an account</a></p>`),
  );
  wireGoogle("signin_with", token);
  const form = document.getElementById("signin-form");
  document.getElementById("forgot-link").addEventListener("click", (event) => {
    event.preventDefault();
    go(authPath("forgot-password", { email: form.elements.email.value.trim() }));
  });
  document.getElementById("magic-request").addEventListener("click", (event) =>
    busy(event.currentTarget, () => requestMagicLink(form.elements.email.value.trim(), form, next)),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/session/login", {
        email: values.email.trim(),
        password: values.password,
        keepSignedIn: values.keepSignedIn === "on",
      });
      if (!result.ok) {
        if (/verify your email/i.test(result.error)) {
          await post("/auth/email/resend-verification", { email: values.email.trim() });
          go(authPath("verify", { email: values.email.trim(), invite: token, next: next }));
          toast("Confirm your email first — we sent a new code", "info");
          return;
        }
        setFormError(form, result.error);
        return;
      }
      if (result.data?.mfaRequired) {
        go(authPath("mfa", { email: values.email.trim(), invite: token, next: next }));
        return;
      }
      await loadUser();
      afterAuth(token, next);
    });
  });
}

/** Ask for an emailed sign-in link. The answer is the same for any address, so the note is too. */
async function requestMagicLink(email, form, next) {
  setFormError(form, null);
  const note = document.getElementById("magic-note");
  if (!email) {
    setFormError(form, "Enter your email first.");
    return;
  }
  const result = await post("/auth/magic-link/request", { email: email });
  if (!result.ok) {
    setFormError(form, result.error);
    return;
  }
  mount(note, html`<div class="form-note">If ${email} has an account, a sign-in link is on its way. You can ask again in ${result.data?.resendAfterSeconds ?? 60} seconds.</div><div id="magic-local"></div>`);
  // A local API: offer the link the dev inbox holds, since no mail reaches a real inbox.
  const mail = await latestMail(email, "MAGIC", { attempts: 6 });
  const token = tokenOf(mail?.payload?.magicLink);
  if (token) {
    mount(document.getElementById("magic-local"), html`<a class="btn btn-block" href="#${authPath("magic-link", { token: token, next: next })}" id="magic-open">Local preview: open the link from the dev inbox</a>`);
  }
}

export async function renderSignUp({ query }) {
  const invite = await invitationFor(query);
  const token = invite?.token;
  const app = document.getElementById("app");
  mount(
    app,
    authLayout(html`
      <div>
        <h1>Create your account</h1>
        <p class="muted" style="margin-top:6px">${invite ? html`You're joining <strong class="secondary">${invite.workspaceName}</strong>. Create your account with the invited address first.` : "Start a workspace for your team in a minute."}</p>
      </div>
      <form class="form" id="signup-form" novalidate>
        <div class="row-2">
          <label class="field"><span>First name</span><input type="text" name="firstName" autocomplete="given-name" required /></label>
          <label class="field"><span>Last name</span><input type="text" name="lastName" autocomplete="family-name" required /></label>
        </div>
        <label class="field"><span>Company</span><input type="text" name="organization" autocomplete="organization" required placeholder="Acme Health" />${invite ? html`<span class="hint">Your own space on Insidefi. You'll join ${invite.workspaceName} right after.</span>` : ""}</label>
        <label class="field"><span>Work email</span><input type="email" name="email" autocomplete="email" required ${invite ? html`value="${invite.email}" readonly` : ""} /></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="new-password" required /><span class="hint">At least 10 characters.</span></label>
        <button class="btn btn-primary btn-block" type="submit">Create account</button>
      </form>
      ${GOOGLE_BLOCK}
      <p class="auth-switch">Already have an account? <a href="#${authPath("signin", { invite: token })}">Sign in</a></p>`),
  );
  wireGoogle("signup_with", token);
  const form = document.getElementById("signup-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = formValues(form);
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const email = values.email.trim();
      const result = await post("/auth/account/register", {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        organization: values.organization.trim(),
        email: email,
        password: values.password,
      });
      if (!result.ok) {
        setFormError(form, result.error);
        if (result.status === 409) {
          form.querySelector(".form-error").insertAdjacentHTML("beforeend", String(html` <a id="signup-exists" href="#${authPath("signin", { email: email, invite: token })}">Sign in instead</a>`));
        }
        return;
      }
      go(authPath("verify", { email: email, invite: token }));
    });
  });
}

/** The newest emailed code for an address, from the local dev inbox. */
async function codeFromDevInbox(email, type) {
  const target = await devTarget();
  if (!target.local) {
    return null;
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const rows = await (await fetch(`/dev/outbox?email=${encodeURIComponent(email)}`)).json();
      const row = Array.isArray(rows) ? rows.find((one) => one.type === type) : null;
      if (row?.payload?.code) {
        return row.payload.code;
      }
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return null;
}

export function renderVerify({ query }) {
  const email = query.email ?? "";
  const token = inviteFromQuery(query);
  const next = nextFromQuery(query);
  const app = document.getElementById("app");
  mount(
    app,
    authLayout(html`
      <div>
        <div class="empty-icon" style="width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--bg-brand-soft);color:var(--text-brand);margin-bottom:14px">${icon("mail")}</div>
        <h1>Check your email</h1>
        <p class="muted" style="margin-top:6px">We sent a 6-digit code to <strong class="secondary">${email}</strong>.</p>
      </div>
      <form class="form" id="verify-form" novalidate>
        <label class="field"><span>Verification code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="123456" style="letter-spacing:0.3em;font-size:18px;text-align:center" /></label>
        <div id="dev-note"></div>
        <button class="btn btn-primary btn-block" type="submit">Verify and continue</button>
      </form>
      <p class="auth-switch">Didn't get it? <a href="#" id="resend">Send a new code</a> · <a href="#${authPath("signin", { email: email, invite: token })}">Back to sign in</a></p>`),
  );
  const form = document.getElementById("verify-form");
  codeFromDevInbox(email, "VERIFY").then((code) => {
    if (code && !form.elements.code.value) {
      form.elements.code.value = code;
      document.getElementById("dev-note").innerHTML = String(html`<div class="form-note">Local preview: the code was filled in from the dev inbox.</div>`);
    }
  });
  document.getElementById("resend").addEventListener("click", async (event) => {
    event.preventDefault();
    await post("/auth/email/resend-verification", { email: email });
    toast("A new code is on its way");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = form.elements.code.value.trim();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/email/verify", { email: email, code: code });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      if (result.data?.signedIn) {
        await loadUser();
        afterAuth(token, next);
      } else {
        toast("Email confirmed — sign in to continue");
        go(authPath("signin", { email: email, invite: token, next: next }));
      }
    });
  });
}

export function renderMfa({ query }) {
  const token = inviteFromQuery(query);
  const next = nextFromQuery(query);
  const app = document.getElementById("app");
  mount(
    app,
    authLayout(html`
      <div><h1>Two-step verification</h1><p class="muted" style="margin-top:6px">Enter the 6-digit code from your authenticator app${query.email ? html` for <strong class="secondary">${query.email}</strong>` : ""}, or one of your backup codes.</p></div>
      <form class="form" id="mfa-form" novalidate>
        <label class="field"><span>Code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required style="letter-spacing:0.3em;font-size:18px;text-align:center" /></label>
        <button class="btn btn-primary btn-block" type="submit">Verify</button>
      </form>
      <p class="auth-switch">Not you? <a href="#" id="mfa-abandon">Cancel this sign-in</a></p>`),
  );
  const form = document.getElementById("mfa-form");
  // "Not you?": throw the half-finished sign-in away, then start over.
  document.getElementById("mfa-abandon").addEventListener("click", async (event) => {
    event.preventDefault();
    await post("/auth/mfa/abandon", {});
    go(authPath("signin", { invite: token, next: next }));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form.querySelector("button[type=submit]"), async () => {
      setFormError(form, null);
      const result = await post("/auth/mfa/verify", { code: form.elements.code.value.trim() });
      if (!result.ok) {
        setFormError(form, result.error);
        return;
      }
      if (typeof result.data?.backupCodesRemaining === "number") {
        toast(`Signed in with a backup code. ${result.data.backupCodesRemaining} left.`, "info");
      }
      await loadUser();
      afterAuth(token, next);
    });
  });
}

/** Sign out, then go to `next` (sign in by default). */
export async function signOut(next = "/signin") {
  await post("/auth/session/logout", {});
  signedOut();
  go(next);
}
