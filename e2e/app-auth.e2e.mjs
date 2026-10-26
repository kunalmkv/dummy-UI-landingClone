// The app's account and sign-in screens, driven through the UI only against the
// real API: password change, forgot and reset, sign in by emailed link, confirm
// by emailed link, sessions, two-factor (set up, backup codes, "Not you?",
// turn off), the identity check with an emailed code, and Google linking.
// app-coverage.mjs proves each /auth endpoint is used; this proves they work.
import assert from "node:assert/strict";

import { generate } from "../../backend/node_modules/otplib/dist/index.js";

import { API, HARNESS, PASSWORD, mail, person, startRun, step } from "./harness.mjs";

const NEW_PASSWORD = "a brand new passphrase 1";
const RESET_PASSWORD = "after the reset passphrase 2";

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wait until the text appears anywhere in the selector. */
async function waitText(page, selector, pattern, timeout = 45000) {
  await page.waitForFunction(
    ([css, source]) => new RegExp(source, "i").test(document.querySelector(css)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: timeout },
  );
}

/** Collect what a page throws, except Google's own logging and failed asset loads. */
function watch(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(message.text()) && errors.push(message.text()));
  return errors;
}

/**
 * A route handler that answers with a changed copy of the real answer. A late
 * request (one that arrives while the route is being removed) is let through
 * instead of throwing, which would crash the run.
 */
function reshape(change) {
  return async (route) => {
    try {
      const body = await (await route.fetch()).json();
      change(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    } catch {
      await route.continue().catch(() => {});
    }
  };
}

async function signIn(page, email, password) {
  await page.goto(`${HARNESS}/#/signin`);
  await page.fill('#signin-form [name="email"]', email);
  await page.fill('#signin-form [name="password"]', password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signOutFromMenu(page) {
  await page.locator("[data-user-menu], [data-user]").first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/#\/signin/);
}

/** An authenticator code that has not been used yet: each code works once per 30-second step. */
async function freshTotp(secret) {
  const period = 30000;
  await new Promise((resolve) => setTimeout(resolve, period - (Date.now() % period) + 700));
  return generate({ secret: secret, digits: 6, period: 30 });
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("appauth");
    const una = await person(run, "Una");
    const page = una.page;
    const errors = watch(page);
    const email = una.email;

    // ── account page ─────────────────────────────────────────────────

    await step("the user menu opens Account & security, which shows the profile", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.locator("[data-user-menu]").click();
      await page.locator(".popover .menu-item", { hasText: "Account & security" }).click();
      await page.waitForURL(/#\/account/);
      await page.getByRole("heading", { name: "Account & security" }).waitFor();
      await waitText(page, "#section", new RegExp(escapeRegex(email)));
      await waitText(page, "#section", /Two-factor\s*Off/);
    });

    await step("change password: a mismatch is refused, then it changes", async () => {
      await page.goto(`${HARNESS}/#/account/password`);
      // The profile's email card has a currentPassword too: wait for this form.
      await page.locator("#password-form").waitFor();
      await page.fill('#password-form [name="currentPassword"]', PASSWORD);
      await page.fill('#password-form [name="newPassword"]', NEW_PASSWORD);
      await page.fill('#password-form [name="repeat"]', "not the same one");
      await page.getByRole("button", { name: "Change password" }).click();
      await waitText(page, "#password-form .form-error", /don't match/);
      await page.fill('#password-form [name="repeat"]', NEW_PASSWORD);
      await page.getByRole("button", { name: "Change password" }).click();
      await waitText(page, ".toast", /Password changed/);
    });

    await step("sign out, then the new password signs in and the old one does not", async () => {
      await page.goto(`${HARNESS}/#/account/profile`);
      await page.locator("[data-signout]").click();
      await page.waitForURL(/#\/signin/);
      await signIn(page, email, PASSWORD);
      await waitText(page, "#signin-form .form-error", /incorrect/);
      await signIn(page, email, NEW_PASSWORD);
      await page.waitForURL(/#\/welcome/);
    });

    // ── forgot and reset ─────────────────────────────────────────────

    let resetLink = null;
    await step("forgot password: the page asks, offers the local preview, and the real mailed URL opens the app", async () => {
      await signOutFromMenu(page);
      await page.fill('#signin-form [name="email"]', email);
      await page.locator("#forgot-link").click();
      await page.waitForURL(/#\/forgot-password/);
      assert.equal(await page.inputValue('[name="email"]'), email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await waitText(page, "#forgot-note", /reset link is on its way/);
      await page.locator("#reset-open").waitFor();
      resetLink = (await mail(email, "RESET")).payload.resetLink;
      assert.ok(resetLink.startsWith(`${HARNESS}/reset-password?token=`), resetLink);
      const token = new URL(resetLink).searchParams.get("token");
      assert.ok((await page.locator("#reset-open").getAttribute("href")).endsWith(`token=${token}`), "the preview carries the mailed token");
      await page.goto(resetLink);
      await page.waitForURL(/#\/reset-password\?token=/);
    });

    await step("reset password: a mismatch is refused, then it sets the new password and signs out", async () => {
      await page.fill('[name="newPassword"]', RESET_PASSWORD);
      await page.fill('[name="repeat"]', "something else");
      await page.getByRole("button", { name: "Change password" }).click();
      await waitText(page, "#reset-form .form-error", /don't match/);
      await page.fill('[name="repeat"]', RESET_PASSWORD);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.waitForURL(/#\/signin/);
      await signIn(page, email, RESET_PASSWORD);
      await page.waitForURL(/#\/welcome/);
    });

    await step("a reset link works once: opening it again and submitting is refused", async () => {
      await page.goto(resetLink);
      await page.waitForURL(/#\/reset-password\?token=/);
      await page.fill('[name="newPassword"]', NEW_PASSWORD);
      await page.fill('[name="repeat"]', NEW_PASSWORD);
      await page.getByRole("button", { name: "Change password" }).click();
      await waitText(page, "#reset-form .form-error", /invalid or has expired/);
      await page.locator("#reset-again").waitFor();
    });

    // ── sign in by emailed link, and confirm by emailed link ─────────

    await step("sign in by link: the sign-in page asks, and the mailed link signs in", async () => {
      await page.goto(`${HARNESS}/#/welcome`);
      await signOutFromMenu(page);
      await page.fill('#signin-form [name="email"]', email);
      await page.locator("#magic-request").click();
      await waitText(page, "#magic-note", /sign-in link is on its way/);
      await page.locator("#magic-open").waitFor();
      const row = await mail(email, "MAGIC");
      assert.ok(row.payload.magicLink.startsWith(`${HARNESS}/magic-link?token=`), row.payload.magicLink);
      await page.locator("#magic-open").click();
      await page.waitForURL(/#\/welcome/);
      await page.locator("[data-user-menu]").waitFor();
      // The mailed URL itself opens the app, and the link is spent.
      await page.goto(row.payload.magicLink);
      await page.waitForURL(/#\/magic-link\?token=/);
      await page.getByRole("heading", { name: "This link can't sign you in" }).waitFor();
    });

    await step("confirm by link: the mailed link opens the app and the address is verified", async () => {
      const newcomer = `${run.prefix}-verifyme@example.com`;
      const registered = await (
        await page.context().request.post(`${API}/auth/account/register`, {
          data: { email: newcomer, password: PASSWORD, firstName: "Vera", lastName: "Link", organization: "Vera Org" },
        })
      ).json();
      assert.equal(registered.status, 200, JSON.stringify(registered.result));
      const row = await mail(newcomer, "VERIFY");
      assert.ok(row.payload.verificationLink.startsWith(`${HARNESS}/verify-email?token=`), row.payload.verificationLink);
      const stranger = await run.browser.newContext();
      const strangerPage = await stranger.newPage();
      await strangerPage.goto(row.payload.verificationLink);
      await strangerPage.waitForURL(/#\/verify-email\?token=/);
      await strangerPage.getByRole("heading", { name: "Email confirmed" }).waitFor();
      await strangerPage.locator("#verified-signin").click();
      // The mailed link carries only the token, so there is no address to prefill.
      await strangerPage.waitForURL(/#\/signin$/);
      await strangerPage.locator('#signin-form [name="email"]').waitFor();
      // A second use of the same link is refused.
      await strangerPage.goto(row.payload.verificationLink);
      await strangerPage.getByRole("heading", { name: "We couldn't confirm that" }).waitFor();
      await stranger.close();
    });

    await step("the welcome mail's /login link opens sign in", async () => {
      const guest = await run.browser.newContext();
      const guestPage = await guest.newPage();
      await guestPage.goto(`${HARNESS}/login`);
      await guestPage.waitForURL(/#\/signin/);
      await guestPage.getByRole("heading", { name: "Welcome back" }).waitFor();
      await guest.close();
    });

    // ── sessions ─────────────────────────────────────────────────────

    await step("sessions: a second device shows up, is revoked, and signs out", async () => {
      const other = await run.browser.newContext();
      const otherPage = await other.newPage();
      watch(otherPage);
      await signIn(otherPage, email, RESET_PASSWORD);
      await otherPage.waitForURL(/#\/welcome/);

      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.waitForSelector("tr[data-session]");
      assert.ok((await page.locator("tr[data-session]").count()) >= 2);
      // The live API does not say which row is this device yet, so the other device is the newest row.
      assert.match(await page.locator("tr[data-session]").first().innerText(), /Chrome/);
      await page.locator("tr[data-session] [data-revoke]").first().click();
      await page.locator(".modal [data-yes]").click();
      await waitText(page, ".toast", /Device signed out/);

      await otherPage.goto(`${HARNESS}/`);
      await otherPage.waitForURL(/#\/signin/);
      await other.close();
    });

    await step("sessions: sign out everywhere ends this one too", async () => {
      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.locator("[data-all]").click();
      await page.locator(".modal [data-yes]").click();
      await page.waitForURL(/#\/signin/);
      await signIn(page, email, RESET_PASSWORD);
      await page.waitForURL(/#\/welcome/);
    });

    // ── two-factor ───────────────────────────────────────────────────

    let secret = null;
    let backupCodes = [];
    await step("two-factor: set up shows a QR and a key, a wrong code is refused, the right one turns it on", async () => {
      await page.goto(`${HARNESS}/#/account/two-factor`);
      await page.getByRole("button", { name: /Set up an authenticator app/ }).click();
      await page.locator("[data-qr]").waitFor();
      assert.match(await page.locator("[data-qr]").getAttribute("src"), /^data:image\/png;base64,/);
      secret = (await page.locator("[data-key]").innerText()).trim();
      assert.ok(secret.length >= 16, secret);
      await page.fill('#enable-form [name="code"]', "000000");
      await page.getByRole("button", { name: "Turn on two-factor" }).click();
      await waitText(page, "#enable-form .form-error", /not valid/);
      await page.fill('#enable-form [name="code"]', await freshTotp(secret));
      await page.getByRole("button", { name: "Turn on two-factor" }).click();
      await page.locator("[data-codes] li").first().waitFor();
      backupCodes = await page.locator("[data-codes] li").allInnerTexts();
      assert.equal(backupCodes.length, 8);
      await page.locator("[data-done]").click();
      await waitText(page, "#section", /Two-factor authentication[\s\S]*On/);
    });

    await step("two-factor: new backup codes replace the old ones", async () => {
      await page.getByRole("button", { name: /New codes/ }).click();
      await page.fill('.modal [name="currentPassword"]', "wrong password here");
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".modal .form-error", /incorrect/);
      await page.fill('.modal [name="currentPassword"]', RESET_PASSWORD);
      await page.locator(".modal [data-submit]").click();
      await page.locator("[data-codes] li").first().waitFor();
      const fresh = await page.locator("[data-codes] li").allInnerTexts();
      assert.equal(fresh.length, 8);
      assert.equal(fresh.filter((code) => backupCodes.includes(code)).length, 0, "the old codes are gone");
      backupCodes = fresh;
      await page.locator("[data-done]").click();
    });

    await step("two-factor sign-in: \"Not you?\" cancels it, then a backup code signs in once", async () => {
      await page.goto(`${HARNESS}/#/account/profile`);
      await page.locator("[data-signout]").click();
      await page.waitForURL(/#\/signin/);
      await signIn(page, email, RESET_PASSWORD);
      await page.waitForURL(/#\/mfa/);
      await page.locator("#mfa-abandon").click();
      await page.waitForURL(/#\/signin/);
      // The challenge is gone, so a code now has nothing to finish.
      await signIn(page, email, RESET_PASSWORD);
      await page.waitForURL(/#\/mfa/);
      await page.fill('#mfa-form [name="code"]', "000000");
      await page.getByRole("button", { name: "Verify" }).click();
      await waitText(page, "#mfa-form .form-error", /not valid/);
      await page.fill('#mfa-form [name="code"]', backupCodes[0]);
      // The toast is brief, so watch for it from before the click.
      const toast = page.waitForSelector(".toast:has-text('7 left')", { timeout: 45000 });
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForURL(/#\/welcome/);
      await toast;
    });

    await step("two-factor: turning it off needs the password and a current app code", async () => {
      await page.goto(`${HARNESS}/#/account/two-factor`);
      await page.getByRole("button", { name: /Turn off/ }).click();
      await page.fill('.modal [name="currentPassword"]', RESET_PASSWORD);
      await page.fill('.modal [name="code"]', backupCodes[1]);
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".modal .form-error", /not valid/);
      await page.fill('.modal [name="code"]', await freshTotp(secret));
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".toast", /Two-factor is off/);
      await waitText(page, "#section", /Two-factor authentication[\s\S]*Off/);
    });

    // ── identity check, with the emailed code ────────────────────────

    let workspaceId = null;
    await step("a workspace to protect", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.fill('#welcome-create [name="name"]', "Una Lab");
      await page.fill('#welcome-create [name="slug"]', `unalab-${run.prefix.slice(-10)}`.toLowerCase());
      await waitText(page, "#welcome-slug-state", /Available/);
      await page.getByRole("button", { name: "Create workspace" }).click();
      await page.waitForURL(/#\/onboarding/);
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.waitForURL(/#\/w\/[0-9a-f]{24}$/);
      workspaceId = page.url().match(/#\/w\/([0-9a-f]{24})/)[1];
    });

    await step("archive needs a confirmed identity: a wrong emailed code is refused, the right one works", async () => {
      await page.goto(`${HARNESS}/#/w/${workspaceId}/settings/danger`);
      await page.getByRole("button", { name: "Archive…" }).click();
      await page.locator('.modal [data-method="emailCode"]').click();
      await page.locator(".modal [data-send-code]").click();
      await page.waitForFunction(() => document.querySelector('.modal [name="emailCode"]')?.value.length === 6, null, { timeout: 30000 });
      const right = await page.inputValue('.modal [name="emailCode"]');
      await page.fill('.modal [name="emailCode"]', right === "000000" ? "111111" : "000000");
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".modal .form-error", /did not confirm/);
      await page.fill('.modal [name="emailCode"]', right);
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".toast", /Workspace archived/);
      await page.locator("[data-restore]").first().waitFor();
    });

    await step("restore, then archive again with the password this time", async () => {
      await page.locator("[data-restore]").first().click();
      await waitText(page, ".toast", /Workspace restored/);
      await page.getByRole("button", { name: "Archive…" }).click();
      await page.fill('.modal [name="password"]', RESET_PASSWORD);
      await page.locator(".modal [data-submit]").click();
      await waitText(page, ".toast", /Workspace archived/);
      await page.locator("[data-restore]").first().click();
      await waitText(page, ".toast", /Workspace restored/);
    });

    // ── Google, with a stand-in for Google's own button ──────────────

    await step("Google: linking asks for the password, and the API's refusal shows", async () => {
      const gContext = await run.browser.newContext();
      await gContext.addInitScript(() => {
        window.google = {
          accounts: {
            id: {
              initialize(options) {
                window.__googleCallback = options.callback;
              },
              renderButton(slot) {
                slot.innerHTML = '<button type="button" id="fake-google">Fake Google</button>';
                slot.querySelector("button").onclick = () => window.__googleCallback({ credential: "fake.id.token" });
              },
            },
          },
        };
      });
      const gPage = await gContext.newPage();
      const gErrors = watch(gPage);
      await signIn(gPage, email, RESET_PASSWORD);
      // Let the workspace home finish drawing, or its late render would cover the next page.
      await gPage.waitForURL(/#\/w\/[0-9a-f]{24}$/);
      await gPage.locator("[data-switcher]").waitFor();
      await gPage.goto(`${HARNESS}/#/account/google`);
      await gPage.locator("#fake-google").click();
      await waitText(gPage, "#link-form .form-error", /Enter your password first/);
      await gPage.fill('#link-form [name="currentPassword"]', RESET_PASSWORD);
      await gPage.locator("#fake-google").click();
      await waitText(gPage, "#link-form .form-error", /could not be verified/);

      // Unlink: shown for a linked account; the API's answers are stood in for here.
      await gPage.route("**/api/auth/profile/get", reshape((body) => (body.result.data.googleLinked = true)));
      await gPage.route("**/api/auth/google/unlink", (route) => route.fulfill({ json: { result: { message: "Success", data: { unlinked: true }, error: null }, status: 200 } }));
      // Already on this URL, so a goto would draw nothing new: reload instead.
      await gPage.reload();
      await gPage.getByRole("button", { name: /Unlink/ }).click();
      await gPage.fill('.modal [name="currentPassword"]', RESET_PASSWORD);
      await gPage.locator(".modal [data-submit]").click();
      await waitText(gPage, ".toast", /Google unlinked/);
      assert.deepEqual(gErrors, []);
      await gContext.close();
    });

    await step("no page threw", () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(una.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
