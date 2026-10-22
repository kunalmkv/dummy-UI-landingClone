// The account pages, driven through their forms: register, verify by code and
// by link, resend, sign in and out, profile, change password, forgot and
// reset, magic link, sign out everywhere, and the two-factor stop.
import assert from "node:assert/strict";

// The library the server verifies against, so this tests our wiring only.
import { generate } from "../../backend/node_modules/otplib/dist/index.js";

import {
  API,
  HARNESS,
  PASSWORD,
  act,
  assertOk,
  mail,
  person,
  startRun,
  step,
} from "./harness.mjs";

/** A mailed link, pointed at its API tester page (the app owns the mailed path). */
function tester(link) {
  const url = new URL(link);
  return `${url.origin}${url.pathname}-tester${url.search}${url.hash}`;
}

const NEW_PASSWORD = "a completely new passphrase";
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

/**
 * A browser context with nobody signed in, collecting page errors.
 *
 * @param {object} run from startRun
 * @returns {Promise<{context: object, page: object, errors: string[]}>}
 */
async function stranger(run) {
  const context = await run.browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context: context, page: page, errors: errors };
}

/**
 * The auth cookie this context holds for the API, or null.
 *
 * @param {object} context
 * @returns {Promise<object|null>}
 */
async function authCookie(context) {
  const cookies = await context.cookies(API);
  return cookies.find((cookie) => cookie.name === "chakra_auth_token") ?? null;
}

/**
 * A second device: a new context signed in as this address through the API.
 *
 * @param {object} run
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} the context
 */
async function secondDevice(run, email, password) {
  const context = await run.browser.newContext();
  const response = await context.request.post(`${API}/auth/session/login`, {
    data: { email: email, password: password },
  });
  assert.equal((await response.json()).status, 200, "second device sign-in");
  return context;
}

/**
 * The status GET /auth/profile/get answers for this context.
 *
 * @param {object} context
 * @returns {Promise<number>}
 */
async function profileStatus(context) {
  const response = await context.request.get(`${API}/auth/profile/get`);
  return (await response.json()).status;
}

/**
 * Type a six-digit code into the verify page's boxes.
 *
 * @param {object} page
 * @param {string} code
 * @returns {Promise<void>}
 */
async function typeCode(page, code) {
  const boxes = page.locator("#boxes input");
  for (let index = 0; index < 6; index += 1) {
    await boxes.nth(index).fill(code[index]);
  }
}

/**
 * Wait until the identity strip names this address.
 *
 * @param {object} page
 * @param {string} email
 * @returns {Promise<void>}
 */
async function waitSignedIn(page, email) {
  await page
    .locator("#identity.signed-in strong", { hasText: email })
    .waitFor();
}

/**
 * Wait until the identity strip says signed out.
 *
 * @param {object} page
 * @returns {Promise<void>}
 */
async function waitSignedOut(page) {
  await page
    .locator("#identity.signed-out strong", { hasText: "signed out" })
    .waitFor();
}

/**
 * Fill and submit the account page's sign-in form.
 *
 * @param {object} page on /
 * @param {string} email
 * @param {string} password
 * @param {boolean} keepSignedIn
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function signIn(page, email, password, keepSignedIn) {
  await page.fill("#login-form [name=email]", email);
  await page.fill("#login-form [name=password]", password);
  await page.setChecked("#login-keep", keepSignedIn);
  return act(page, () => page.click("#login-form button[type=submit]"));
}

/**
 * Register through the form, verify by code, check the profile, change the
 * password, sign out, sign back in, sign out everywhere.
 *
 * @param {object} run
 * @returns {Promise<object>} the stranger, for its errors
 */
async function newcomerFlow(run) {
  const newcomer = await stranger(run);
  const { page, context } = newcomer;
  const email = `${run.prefix}-newcomer@example.com`;

  await step(
    "register through the form, asking to stay signed in",
    async () => {
      await page.goto(`${HARNESS}/account`);
      await page.fill("#register-email", email);
      await page.fill("#register-form [name=password]", PASSWORD);
      await page.check("#register-keep");
      const shown = await act(page, () =>
        page.click("#register-form button[type=submit]"),
      );
      assertOk(shown, "register");
      await page.locator("#register-outcome #verify-link").waitFor();
    },
  );

  // An address nobody has verified is re-registered with the newest details
  // (a lost code is not a dead end); only a verified address answers 409.
  await step(
    "the same unverified address again is re-registered, not refused",
    async () => {
      const shown = await act(page, () =>
        page.click("#register-form button[type=submit]"),
      );
      assertOk(shown, "re-register an unverified address");
      await page.locator("#register-outcome #verify-link").waitFor();
    },
  );

  await step(
    "signing in unverified is refused with 403 and a verify link",
    async () => {
      const shown = await signIn(page, email, PASSWORD, false);
      assert.equal(shown.status, 403, shown.text);
      await page
        .locator('#login-outcome a[href^="/verify-email-tester?email="]')
        .waitFor();
    },
  );

  await step("the verify page resends the code and counts down", async () => {
    await page.click('#login-outcome a[href^="/verify-email-tester?email="]');
    await page.waitForURL(/\/verify-email-tester\?email=/);
    assert.equal(await page.inputValue("#email"), email);
    const shown = await act(page, () => page.click("#resend-btn"));
    assertOk(shown, "resend verification");
    await page
      .locator("#resend-outcome", { hasText: "resend again in" })
      .waitFor();
  });

  const code = (await mail(email, "VERIFY")).payload.code;

  await step("a wrong code is refused with the attempts left", async () => {
    const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, "0");
    await typeCode(page, wrongCode);
    const shown = await act(page, () =>
      page.click("#code-form button[type=submit]"),
    );
    assert.equal(shown.status, 400, shown.text);
    assert.match(
      await page.locator("#code-outcome").innerText(),
      /attempts left/,
    );
  });

  await step(
    "the right code verifies and signs in with a 90-day cookie",
    async () => {
      await typeCode(page, code);
      const shown = await act(page, () =>
        page.click("#code-form button[type=submit]"),
      );
      assertOk(shown, "verify by code");
      await waitSignedIn(page, email);
      assert.match(
        await page.locator("#code-outcome").innerText(),
        /verified and signed in/,
      );
      const cookie = await authCookie(context);
      assert.ok(
        cookie.expires > Date.now() / 1000 + NINETY_DAYS_SECONDS - 3600,
        `keepSignedIn from register should give a 90-day cookie, got ${cookie.expires}`,
      );
    },
  );

  await step("a verified address registering again is refused with 409", async () => {
    await page.goto(`${HARNESS}/account`);
    await waitSignedIn(page, email);
    await page.fill("#register-email", email);
    await page.fill("#register-form [name=password]", PASSWORD);
    const shown = await act(page, () =>
      page.click("#register-form button[type=submit]"),
    );
    assert.equal(shown.status, 409, shown.text);
    assert.match(
      await page.locator("#response-panel .error-line").innerText(),
      /already exists/,
    );
    assert.match(
      await page.locator("#register-outcome").innerText(),
      /already exists/,
    );
  });

  await step("the profile table shows the account ACTIVE", async () => {
    await page.goto(`${HARNESS}/account`);
    await waitSignedIn(page, email);
    const shown = await act(page, () => page.click("#profile-btn"));
    assertOk(shown, "profile");
    assert.equal(
      await page.locator('#profile td[data-field="email"]').innerText(),
      email,
    );
    assert.equal(
      await page.locator('#profile td[data-field="status"]').innerText(),
      "ACTIVE",
    );
  });

  await step("page scripts cannot read the auth cookie", async () => {
    const shown = await act(page, () => page.click("#cookie-btn"));
    assertOk(shown, "HttpOnly check");
  });

  await step("a wrong current password is refused", async () => {
    await page.fill("#change-form [name=currentPassword]", "not the password");
    await page.fill("#change-form [name=newPassword]", NEW_PASSWORD);
    const shown = await act(page, () =>
      page.click("#change-form button[type=submit]"),
    );
    assert.equal(shown.status, 401, shown.text);
    assert.match(
      await page.locator("#change-outcome").innerText(),
      /current password is incorrect/,
    );
  });

  await step(
    "changing the password signs out the other device only",
    async () => {
      const otherDevice = await secondDevice(run, email, PASSWORD);
      await page.fill("#change-form [name=currentPassword]", PASSWORD);
      await page.fill("#change-form [name=newPassword]", NEW_PASSWORD);
      const shown = await act(page, () =>
        page.click("#change-form button[type=submit]"),
      );
      assertOk(shown, "change password");
      assert.match(
        await page.locator("#change-outcome").innerText(),
        /changed/,
      );
      await waitSignedIn(page, email);
      assert.equal(await profileStatus(otherDevice), 401, "other device");
      await otherDevice.close();
    },
  );

  await step("sign out ends this device's session", async () => {
    const shown = await act(page, () => page.click("#logout-btn"));
    assertOk(shown, "logout");
    await waitSignedOut(page);
    assert.match(await page.locator("#profile").innerText(), /signed out/);
  });

  await step("the old password is refused with the attempts left", async () => {
    const shown = await signIn(page, email, PASSWORD, false);
    assert.equal(shown.status, 401, shown.text);
    assert.match(
      await page.locator("#login-outcome").innerText(),
      /attempts left/,
    );
  });

  await step(
    "the new password signs in with a browser-session cookie",
    async () => {
      const shown = await signIn(page, email, NEW_PASSWORD, false);
      assertOk(shown, "login");
      await waitSignedIn(page, email);
      assert.match(
        await page.locator("#login-outcome").innerText(),
        new RegExp(`signed in as ${email}`),
      );
      assert.equal((await authCookie(context)).expires, -1, "session cookie");
    },
  );

  await step("sign out everywhere ends every device", async () => {
    const otherDevice = await secondDevice(run, email, NEW_PASSWORD);
    const shown = await act(page, () => page.click("#logout-all-btn"));
    assertOk(shown, "logout-all");
    await waitSignedOut(page);
    const outcome = await page.locator("#session-outcome").innerText();
    const revoked = Number(/(\d+) sessions revoked/.exec(outcome)?.[1]);
    assert.ok(revoked >= 2, outcome);
    assert.equal(await profileStatus(otherDevice), 401, "other device");
    await otherDevice.close();
  });

  return newcomer;
}

/**
 * Verify by the emailed link: activates, does not sign in, spends the link.
 *
 * @param {object} run
 * @returns {Promise<object>} the stranger, for its errors
 */
async function linkFlow(run) {
  const linker = await stranger(run);
  const { page, context } = linker;
  const email = `${run.prefix}-linker@example.com`;

  // Setup, not under test here: registering was covered through the form.
  const registered = await context.request.post(
    `${API}/auth/account/register`,
    {
      data: {
        email: email,
        password: PASSWORD,
        firstName: "Linker",
        lastName: "Tester",
        organization: "Linker Org",
      },
    },
  );
  assert.equal((await registered.json()).status, 200, "register linker");
  const verifyMail = await mail(email, "VERIFY");

  await step("the emailed link lands with its token filled in", async () => {
    await page.goto(tester(verifyMail.payload.verificationLink));
    assert.ok((await page.inputValue("#token")).length > 20);
    await page.locator("#token-note").waitFor();
  });

  await step("verifying by link activates but does not sign in", async () => {
    const shown = await act(page, () =>
      page.click("#token-form button[type=submit]"),
    );
    assertOk(shown, "verify by link");
    assert.match(
      await page.locator("#token-outcome").innerText(),
      /not signed in/,
    );
    await waitSignedOut(page);
    assert.equal(await authCookie(context), null, "no auth cookie");
  });

  await step("the same link a second time is refused", async () => {
    const shown = await act(page, () =>
      page.click("#token-form button[type=submit]"),
    );
    assert.equal(shown.status, 400, shown.text);
    assert.match(
      await page.locator("#token-outcome").innerText(),
      /invalid or has expired/,
    );
  });

  await step("the activated account signs in", async () => {
    await page.goto(`${HARNESS}/account`);
    assertOk(await signIn(page, email, PASSWORD, false), "login");
    await waitSignedIn(page, email);
  });

  return linker;
}

/**
 * Forgot password, then reset through the emailed link.
 *
 * @param {object} run
 * @returns {Promise<object>} the person, for their errors
 */
async function resetFlow(run) {
  const resetter = await person(run, "Resetter");
  const { page } = resetter;
  const rawResponse = page.locator("#response-panel details:last-of-type pre");

  await step(
    "forgot password answers a made-up address identically",
    async () => {
      await page.goto(`${HARNESS}/account`);
      await waitSignedIn(page, resetter.email);
      await page.fill("#forgot-email", `${run.prefix}-ghost@example.com`);
      assertOk(
        await act(page, () => page.click("#forgot-form button[type=submit]")),
        "forgot, unknown address",
      );
      const ghostAnswer = await rawResponse.innerText();
      await page.fill("#forgot-email", resetter.email);
      assertOk(
        await act(page, () => page.click("#forgot-form button[type=submit]")),
        "forgot, real address",
      );
      assert.equal(await rawResponse.innerText(), ghostAnswer);
      assert.match(
        await page.locator("#forgot-outcome").innerText(),
        /reset link is in the inbox/,
      );
    },
  );

  const resetMail = await mail(resetter.email, "RESET");

  await step("the reset link sets a new password and signs out", async () => {
    await page.goto(tester(resetMail.payload.resetLink));
    await waitSignedIn(page, resetter.email);
    await page.locator("#token-note").waitFor();
    await page.fill("#reset-form [name=newPassword]", NEW_PASSWORD);
    const shown = await act(page, () =>
      page.click("#reset-form button[type=submit]"),
    );
    assertOk(shown, "reset");
    await waitSignedOut(page);
    assert.match(
      await page.locator("#reset-outcome").innerText(),
      /every session is signed out/,
    );
  });

  await step("the spent reset link is refused", async () => {
    const shown = await act(page, () =>
      page.click("#reset-form button[type=submit]"),
    );
    assert.equal(shown.status, 400, shown.text);
    assert.match(
      await page.locator("#reset-outcome").innerText(),
      /invalid or has expired/,
    );
  });

  await step("the new password signs in", async () => {
    await page.goto(`${HARNESS}/account`);
    assertOk(await signIn(page, resetter.email, NEW_PASSWORD, false), "login");
    await waitSignedIn(page, resetter.email);
  });

  return resetter;
}

/**
 * Sign out, ask for a magic link, sign in with it, then replay it.
 *
 * @param {object} run
 * @returns {Promise<object>} the person, for their errors
 */
async function magicFlow(run) {
  const magician = await person(run, "Magician");
  const { page } = magician;

  await step(
    "signed out, a magic link is requested with a countdown",
    async () => {
      await page.goto(`${HARNESS}/account`);
      await waitSignedIn(page, magician.email);
      assertOk(await act(page, () => page.click("#logout-btn")), "logout");
      await waitSignedOut(page);
      await page.fill("#magic-email", magician.email);
      const shown = await act(page, () =>
        page.click("#magic-form button[type=submit]"),
      );
      assertOk(shown, "magic link request");
      await page
        .locator("#magic-outcome", { hasText: "send again in" })
        .waitFor();
    },
  );

  const magicMail = await mail(magician.email, "MAGIC");

  await step("the emailed link signs in on the magic-link page", async () => {
    await page.goto(tester(magicMail.payload.magicLink));
    await waitSignedOut(page);
    await page.locator("#token-note").waitFor();
    const shown = await act(page, () =>
      page.click("#consume-form button[type=submit]"),
    );
    assertOk(shown, "magic link consume");
    await waitSignedIn(page, magician.email);
    assert.match(
      await page.locator("#consume-outcome").innerText(),
      /signed in as/,
    );
  });

  await step("the spent magic link is refused", async () => {
    const shown = await act(page, () =>
      page.click("#consume-form button[type=submit]"),
    );
    assert.equal(shown.status, 401, shown.text);
    assert.match(
      await page.locator("#consume-outcome").innerText(),
      /invalid or has expired/,
    );
  });

  return magician;
}

/**
 * Turn two-factor on through the API. Setup, not what is under test.
 *
 * @param {object} context signed in
 * @returns {Promise<string[]>} the backup codes
 */
async function enableTwoFactor(context) {
  const setup = await (
    await context.request.post(`${API}/auth/mfa/setup`)
  ).json();
  const code = await generate({
    secret: setup.result.data.manualEntryKey,
    digits: 6,
    period: 30,
  });
  const enabled = await (
    await context.request.post(`${API}/auth/mfa/enable`, {
      data: { code: code },
    })
  ).json();
  assert.equal(enabled.status, 200, "enable two-factor");
  return enabled.result.data.backupCodes;
}

/**
 * With two-factor on, sign-in stops at the challenge screen: abandon it,
 * then finish with a backup code. A magic link stops there too.
 *
 * @param {object} run
 * @returns {Promise<object>} the person, for their errors
 */
async function twoFactorFlow(run) {
  const guarded = await person(run, "Guarded");
  const { page } = guarded;
  const backupCodes = await enableTwoFactor(guarded.context);
  const challengeScreen = page.locator("#challenge-screen");

  await step("with two-factor on, sign-in stops at the challenge", async () => {
    await page.goto(`${HARNESS}/account`);
    await waitSignedIn(page, guarded.email);
    assertOk(await act(page, () => page.click("#logout-btn")), "logout");
    await waitSignedOut(page);
    assertOk(await signIn(page, guarded.email, PASSWORD, false), "login");
    await challengeScreen.waitFor();
    assert.equal(await page.locator("#normal-screens").isVisible(), false);
    assert.equal(await page.locator("#backup-label").isVisible(), false);
    assert.equal(await page.locator("#challenge-banner").isVisible(), false);
    await waitSignedOut(page);
  });

  await step("abandoning the challenge puts the forms back", async () => {
    assertOk(await act(page, () => page.click("#abandon-inline")), "abandon");
    await page.locator("#normal-screens").waitFor();
    assert.equal(await challengeScreen.isVisible(), false);
    await waitSignedOut(page);
  });

  await step("a wrong backup code is refused on the challenge", async () => {
    assertOk(await signIn(page, guarded.email, PASSWORD, false), "login");
    await challengeScreen.waitFor();
    await page.click("#toggle-backup");
    await page.locator("#backup-label").waitFor();
    assert.equal(await page.locator("#challenge-boxes").isVisible(), false);
    await page.fill("#backup-input", "00000-00000");
    const shown = await act(page, () =>
      page.click("#challenge-form button[type=submit]"),
    );
    assert.equal(shown.status, 401, shown.text);
    assert.match(
      await page.locator("#response-panel .error-line").innerText(),
      /not valid/,
    );
  });

  await step("a backup code finishes the sign-in", async () => {
    await page.fill("#backup-input", backupCodes[0]);
    const shown = await act(page, () =>
      page.click("#challenge-form button[type=submit]"),
    );
    assertOk(shown, "mfa verify");
    await waitSignedIn(page, guarded.email);
    await page.locator("#normal-screens").waitFor();
    assert.equal(
      await page.locator('#profile td[data-field="email"]').innerText(),
      guarded.email,
    );
  });

  await step("a magic link also stops at the second factor", async () => {
    assertOk(await act(page, () => page.click("#logout-btn")), "logout");
    await waitSignedOut(page);
    await page.fill("#magic-email", guarded.email);
    assertOk(
      await act(page, () => page.click("#magic-form button[type=submit]")),
      "magic link request",
    );
    const magicMail = await mail(guarded.email, "MAGIC");
    await page.goto(tester(magicMail.payload.magicLink));
    await waitSignedOut(page);
    assert.equal(await page.locator("#challenge-banner").isVisible(), false);
    assertOk(
      await act(page, () => page.click("#consume-form button[type=submit]")),
      "magic link consume",
    );
    await page.locator('#challenge-banner a[href="/two-factor"]').waitFor();
    assert.match(
      await page.locator("#consume-outcome").innerText(),
      /second factor required/,
    );
    await waitSignedOut(page);
  });

  return guarded;
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("authcore");
    const visitors = [
      await newcomerFlow(run),
      await linkFlow(run),
      await resetFlow(run),
      await magicFlow(run),
      await twoFactorFlow(run),
    ];
    await step("no page threw", () =>
      assert.deepEqual(
        visitors.flatMap((visitor) => visitor.errors),
        [],
      ),
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
