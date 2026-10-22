// The page an emailed invitation opens. A new address signs up first and an
// existing one signs in; both come back here signed in and join with one click.

import { post } from "../lib/api.js";
import { authPath, invitePath } from "../lib/invites.js";
import { loadBootstrap, loadUser, state } from "../lib/state.js";
import { busy, html, mount, roleChip, timeAgo, toast } from "../lib/ui.js";
import { authLayout, signOut } from "./auth.js";
import { openWorkspace } from "./start.js";

// Answers that mean the link itself is spent; anything else may pass on a retry.
const SPENT = new Set(["INVITE_NOT_FOUND", "INVITE_EXPIRED", "INVITE_REVOKED", "INVITE_NOT_PENDING"]);

export async function renderInvite({ params }) {
  const token = params.token;
  const app = document.getElementById("app");
  const lookup = await post("/invites/lookup", { token: token });
  if (!lookup.ok) {
    drawSpent(app, lookup.error);
    return;
  }
  const invite = lookup.data;
  const user = state.user;
  if (!user && invite.requiresSignup) {
    draw(app, {
      title: `Create your account to join ${invite.workspaceName}`,
      text: html`The invitation is for <strong class="secondary">${invite.email}</strong>. Create your account with that address and confirm it with the code we email you. You come straight back here to join.`,
      invite: invite,
      actions: html`<a class="btn btn-primary btn-block" id="invite-signup" href="#${authPath("signup", { invite: token })}">Create your account</a>
        <p class="auth-switch">Already have an account? <a href="#${authPath("signin", { email: invite.email, invite: token })}">Sign in</a></p>`,
    });
    return;
  }
  if (!user) {
    draw(app, {
      title: `Sign in to join ${invite.workspaceName}`,
      text: html`The invitation is for <strong class="secondary">${invite.email}</strong>, which already has an account. Sign in with it to join.`,
      invite: invite,
      actions: html`<a class="btn btn-primary btn-block" id="invite-signin" href="#${authPath("signin", { email: invite.email, invite: token })}">Sign in</a>`,
    });
    return;
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    drawMismatch(app, token, invite.email, user.email);
    return;
  }
  draw(app, {
    title: `${invite.inviterName ?? "Someone"} invited you to join ${invite.workspaceName}`,
    text: "",
    invite: invite,
    actions: html`<div class="invite-buttons"><button class="btn" id="invite-decline">Decline</button><button class="btn btn-primary" id="invite-join">Join</button></div>`,
  });
  const answer = (button, path, onDone) =>
    busy(button, async () => {
      const result = await post(path, { token: token });
      if (result.ok) {
        await onDone(result.data);
      } else if (result.code === "SIGN_IN_REQUIRED" || result.code === "INVITE_EMAIL_MISMATCH") {
        // The session ended or changed since the page drew: draw it again for who is here now.
        await loadUser();
        await renderInvite({ params: params });
      } else if (SPENT.has(result.code)) {
        drawSpent(app, result.error);
      } else {
        showError(app, result.error);
      }
    });
  document.getElementById("invite-join").addEventListener("click", (event) =>
    answer(event.currentTarget, "/invites/accept", async (data) => {
      await loadBootstrap();
      toast(`You joined ${invite.workspaceName}`);
      openWorkspace(data.workspaceId);
    }),
  );
  document.getElementById("invite-decline").addEventListener("click", (event) =>
    answer(event.currentTarget, "/invites/decline", () =>
      draw(app, {
        title: "Invitation declined",
        text: `You won't join ${invite.workspaceName}, and the link no longer works.`,
        actions: html`<a class="btn btn-block" href="#/">Go to Insidefi</a>`,
      }),
    ),
  );
}

function draw(app, { title, text, invite = null, actions }) {
  mount(
    app,
    authLayout(html`
      <div id="invite-card">
        <h1 id="invite-title">${title}</h1>
        ${text ? html`<p class="muted" style="margin-top:6px">${text}</p>` : ""}
      </div>
      ${invite ? summary(invite) : ""}
      <div id="invite-error"></div>
      <div class="invite-actions" id="invite-actions">${actions}</div>`),
  );
}

function summary(invite) {
  return html`<dl class="invite-summary">
    <div><dt>Workspace</dt><dd>${invite.workspaceName}</dd></div>
    <div><dt>Organization</dt><dd>${invite.orgName ?? "—"}</dd></div>
    <div><dt>Invited by</dt><dd>${invite.inviterName ?? "—"}</dd></div>
    <div><dt>Role</dt><dd>${roleChip(invite.wsRole)}</dd></div>
    <div><dt>Sent to</dt><dd>${invite.email}</dd></div>
    <div><dt>Expires</dt><dd>${timeAgo(invite.expiresAt)}</dd></div>
  </dl>`;
}

function drawSpent(app, message) {
  draw(app, {
    title: "This invitation can't be opened",
    text: message,
    actions: html`<a class="btn btn-block" href="#/">Go to Insidefi</a>`,
  });
}

function drawMismatch(app, token, invitedEmail, currentEmail) {
  draw(app, {
    title: "This invitation is for another address",
    text: html`It was sent to <strong class="secondary">${invitedEmail}</strong>, but you're signed in as <strong class="secondary">${currentEmail}</strong>. Sign out, then use ${invitedEmail} to join.`,
    actions: html`<div class="invite-buttons"><a class="btn" id="invite-not-now" href="#/">Not now</a><button class="btn btn-primary" id="invite-switch">Sign out and switch account</button></div>`,
  });
  document.getElementById("invite-switch").addEventListener("click", (event) =>
    busy(event.currentTarget, () => signOut(invitePath(token))),
  );
}

function showError(app, message) {
  mount(app.querySelector("#invite-error"), html`<div class="form-error">${message}</div>`);
}
