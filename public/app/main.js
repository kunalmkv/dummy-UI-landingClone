// Boot: routes, the sign-in guard, and the session-ended handler.

import { inviteFromQuery, invitePath } from "./lib/invites.js";
import { go, notFound, route, start } from "./lib/router.js";
import { loadPreferences } from "./lib/prefs.js";
import { wireSearchShortcut } from "./lib/search.js";
import { loadUser, signedOut, state } from "./lib/state.js";
import { renderAccount } from "./pages/account.js";
import { renderConfirmEmail, renderForgotPassword, renderMagicLink, renderResetPassword, renderVerifyEmail } from "./pages/auth-links.js";
import { renderMfa, renderSignIn, renderSignUp, renderVerify } from "./pages/auth.js";
import { renderHome } from "./pages/home.js";
import { renderInvite } from "./pages/invite.js";
import { renderMembers } from "./pages/members.js";
import { renderPageEditor } from "./pages/page-editor.js";
import { renderPagePreview } from "./pages/page-preview.js";
import { renderPageSettings } from "./pages/page-settings.js";
import { renderPages } from "./pages/pages.js";
import { renderProjects } from "./pages/projects.js";
import { renderSettings } from "./pages/settings.js";
import { renderLanding, renderOnboarding, renderPicker, renderProblem, renderWelcome } from "./pages/start.js";

let userChecked = false;

// Appearance and density follow the person; read them once per sign-in.
let preferencesFor = null;

async function currentUser() {
  if (!userChecked || state.user === null) {
    await loadUser();
    userChecked = true;
  }
  if (state.user && preferencesFor !== state.user.id) {
    preferencesFor = state.user.id;
    loadPreferences();
  }
  return state.user;
}

/**
 * Signed-in pages bounce to sign in; sign-in pages bounce a signed-in person
 * home, or to the invitation they came for. "either" pages take both.
 */
function guarded(handler, needsUser = true) {
  return async (context) => {
    const user = await currentUser();
    if (needsUser === true && !user) {
      go("/signin", true);
      return;
    }
    if (needsUser === false && user) {
      const token = inviteFromQuery(context.query);
      go(token ? invitePath(token) : "/", true);
      return;
    }
    try {
      await handler(context);
    } catch (error) {
      console.error(error);
      renderProblem(error.message);
    }
  };
}

route("/signin", guarded(renderSignIn, false));
route("/signup", guarded(renderSignUp, false));
route("/verify", guarded(renderVerify, false));
route("/mfa", guarded(renderMfa, false));
route("/invite/:token", guarded(renderInvite, "either"));
route("/forgot-password", guarded(renderForgotPassword, false));
// Emailed links open these signed in or out.
route("/reset-password", guarded(renderResetPassword, "either"));
route("/magic-link", guarded(renderMagicLink, "either"));
route("/verify-email", guarded(renderVerifyEmail, "either"));
route("/confirm-email", guarded(renderConfirmEmail, "either"));
route("/account", guarded(renderAccount));
route("/account/:section", guarded(renderAccount));
route("/", guarded(renderLanding));
route("/welcome", guarded(renderWelcome));
route("/workspaces", guarded(renderPicker));
route("/onboarding", guarded(renderOnboarding));
route("/w/:id", guarded(renderHome));
route("/w/:id/projects", guarded(renderProjects));
route("/w/:id/projects/:projectId/pages", guarded(renderPages));
route("/w/:id/projects/:projectId/pages/:pageId/edit", guarded(renderPageEditor));
route("/w/:id/projects/:projectId/pages/:pageId/settings/:section", guarded(renderPageSettings));
// A preview link works signed out: the token is the key.
route("/preview/:token", guarded(renderPagePreview, "either"));
route("/w/:id/members", guarded(renderMembers));
route("/w/:id/settings", guarded((context) => go(`/w/${context.params.id}/settings/general`, true)));
route("/w/:id/settings/:section", guarded(renderSettings));
notFound(() => go("/", true));

window.addEventListener("session-ended", () => {
  if (state.user) {
    signedOut();
    go("/signin");
  }
});

// Emailed links arrive as real paths. The workspace invite and a page preview
// carry their token in the fragment (/invite#<token>, /preview#<token>); the
// others carry ?token=. Each becomes the app's own hash route, and /login (the
// welcome mail's link) becomes sign in.
const MAILED_PATHS = ["/verify-email", "/reset-password", "/magic-link", "/confirm-email"];

function adoptMailedUrl() {
  const { pathname, search, hash } = location;
  if (pathname === "/invite") {
    const fragment = hash.slice(1);
    history.replaceState(null, "", fragment.startsWith("/") ? `/#${fragment}` : fragment ? `/#${invitePath(fragment)}` : "/#/");
  } else if (pathname === "/preview") {
    history.replaceState(null, "", hash.length > 1 ? `/#/preview/${hash.slice(1)}` : "/#/");
  } else if (pathname === "/login") {
    history.replaceState(null, "", "/#/signin");
  } else if (MAILED_PATHS.includes(pathname)) {
    history.replaceState(null, "", `/#${pathname}${search}`);
  }
}

adoptMailedUrl();
wireSearchShortcut();
start();
