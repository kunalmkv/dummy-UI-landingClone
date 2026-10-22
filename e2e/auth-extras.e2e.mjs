// Two-factor, sessions, the edge cases and Google, each driven through its
// page: forms filled, buttons clicked, the panel and the rendered result read.
import assert from "node:assert/strict";
import crypto from "node:crypto";

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

const TOTP_PERIOD_MS = 30 * 1000;

// The last TOTP step spent per secret: the API refuses a step twice.
const spentTotpSteps = {};

/**
 * A code for a step not yet spent, waiting for the next step when needed.
 *
 * @param {string} secret base32, from the setup page
 * @returns {Promise<string>}
 */
async function freshTotp(secret) {
  const spent = spentTotpSteps[secret] ?? -1;
  const nextFreeAt = (spent + 1) * TOTP_PERIOD_MS;
  if (Date.now() < nextFreeAt) {
    await new Promise((resolve) =>
      setTimeout(resolve, nextFreeAt - Date.now() + 500),
    );
  }
  spentTotpSteps[secret] = Math.floor(Date.now() / TOTP_PERIOD_MS);
  return generate({ secret: secret, digits: 6, period: 30 });
}

/**
 * Open a harness page and wait until its own first load is done.
 *
 * @param {object} page
 * @param {string} path e.g. "/sessions"
 * @returns {Promise<void>}
 */
async function open(page, path) {
  await page.goto(`${HARNESS}${path}`);
  await page.waitForSelector("body[data-ready=true]");
}

/**
 * Submit a form by its submit button and return the panel status.
 *
 * @param {object} page
 * @param {string} formId
 * @returns {Promise<{status: number|null, text: string}>}
 */
function submit(page, formId) {
  return act(page, () =>
    page.locator(`#${formId} button[type=submit]`).click(),
  );
}

/**
 * Wait until an element's text matches.
 *
 * @param {object} page
 * @param {string} selector
 * @param {RegExp} pattern
 * @returns {Promise<string>}
 */
async function textMatches(page, selector, pattern) {
  const locator = page.locator(selector);
  await locator.filter({ hasText: pattern }).waitFor({ timeout: 10000 });
  return locator.innerText();
}

/**
 * Sign in through the API from a context and return the response body.
 *
 * @param {object} context a browser context
 * @param {string} email
 * @returns {Promise<object>}
 */
async function apiLogin(context, email) {
  const response = await context.request.post(`${API}/auth/session/login`, {
    data: { email: email, password: PASSWORD },
  });
  return response.json();
}

/**
 * Whether a context's cookie still signs it in.
 *
 * @param {object} context
 * @returns {Promise<number>} the API status of GET /auth/profile/get
 */
async function profileStatus(context) {
  const response = await context.request.get(`${API}/auth/profile/get`);
  return (await response.json()).status;
}

/**
 * The session id the API lists for a context: the SHA-256 of its cookie.
 *
 * @param {object} context
 * @returns {Promise<string>}
 */
async function sessionIdOf(context) {
  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === "chakra_auth_token",
  );
  assert.ok(cookie, "expected an auth cookie");
  return crypto
    .createHash("sha256")
    .update(decodeURIComponent(cookie.value))
    .digest("hex");
}

async function checkTwoFactor(run) {
  const tia = await step("two-factor: sign up Tia", () => person(run, "Tia"));
  const page = tia.page;
  await open(page, "/two-factor");

  const secret = await step("setup renders a QR and a manual key", async () => {
    assertOk(await act(page, () => page.click("#setup-btn")), "setup");
    const src = await page.locator("#qr-area img").getAttribute("src");
    assert.match(src, /^data:image\/png;base64,/);
    return (await page.locator("#manual-key").innerText()).trim();
  });

  await step("a wrong code does not enable", async () => {
    await page.fill("#enable-form input[name=code]", "000000");
    const shown = await submit(page, "enable-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#enable-outcome", /that code is not valid/);
  });

  const firstCodes = await step("enable shows eight backup codes", async () => {
    await page.fill("#enable-form input[name=code]", await freshTotp(secret));
    assertOk(await submit(page, "enable-form"), "enable");
    await textMatches(page, "#enable-outcome", /two-factor is on/);
    const codes = await page
      .locator("#backup-area .backup-code")
      .allInnerTexts();
    assert.equal(codes.length, 8);
    return codes;
  });

  const backupCodes = await step("regenerate replaces the set", async () => {
    await page.fill("#regenerate-form input[name=currentPassword]", PASSWORD);
    assertOk(await submit(page, "regenerate-form"), "regenerate");
    await textMatches(page, "#backup-area", /old set is dead/);
    const codes = await page
      .locator("#backup-area .backup-code")
      .allInnerTexts();
    assert.equal(codes.length, 8);
    assert.ok(codes.every((code) => !firstCodes.includes(code)));
    return codes;
  });

  await step("identity confirmation refuses a wrong password", async () => {
    await page.selectOption("#identity-confirm-form select", "WORKSPACE_ARCHIVE");
    await page.fill("#identity-confirm-form input[name=password]", "not-my-password");
    const shown = await submit(page, "identity-confirm-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#identity-confirm-outcome", /did not confirm it is you/);
  });

  await step("identity-confirm grants with the password", async () => {
    await page.selectOption("#identity-confirm-form select", "ORG_OWNERSHIP_TRANSFER");
    await page.fill("#identity-confirm-form input[name=password]", PASSWORD);
    assertOk(await submit(page, "identity-confirm-form"), "identity confirmation by password");
    await textMatches(
      page,
      "#identity-confirm-outcome",
      /granted ORG_OWNERSHIP_TRANSFER for 300s/,
    );
  });

  await step("identity-confirm grants with a two-factor code", async () => {
    await page.selectOption("#identity-confirm-form select", "WORKSPACE_ARCHIVE");
    await page.fill("#identity-confirm-form input[name=password]", "");
    await page.fill("#identity-confirm-form input[name=code]", await freshTotp(secret));
    assertOk(await submit(page, "identity-confirm-form"), "identity confirmation by code");
    await textMatches(page, "#identity-confirm-outcome", /granted WORKSPACE_ARCHIVE/);
    await page.fill("#identity-confirm-form input[name=code]", "");
  });

  await step("sign-in now stops at the challenge", async () => {
    await tia.context.request.post(`${API}/auth/session/logout`);
    const body = await apiLogin(tia.context, tia.email);
    assert.equal(body.result.data.mfaRequired, true);
    await open(page, "/two-factor");
    await textMatches(page, "#identity", /signed out/);
  });

  await step("the challenge refuses a wrong code", async () => {
    await page.fill("#challenge-form input[name=code]", "000000");
    const shown = await submit(page, "challenge-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#challenge-outcome", /that code is not valid/);
  });

  await step("a backup code finishes the sign-in", async () => {
    await page.fill("#challenge-form input[name=code]", backupCodes[0]);
    assertOk(await submit(page, "challenge-form"), "verify");
    await textMatches(page, "#challenge-outcome", /signed in as/);
    await textMatches(page, "#identity", new RegExp(tia.email));
  });

  await step("a spent backup code is refused", async () => {
    assert.equal(
      (await apiLogin(tia.context, tia.email)).result.data.mfaRequired,
      true,
    );
    await page.fill("#challenge-form input[name=code]", backupCodes[0]);
    const shown = await submit(page, "challenge-form");
    assert.equal(shown.status, 401, shown.text);
  });

  await step("abandon throws the challenge away", async () => {
    assertOk(await act(page, () => page.click("#abandon-btn")), "abandon");
    await textMatches(page, "#challenge-outcome", /challenge thrown away/);
    // An unspent backup code now fails: there is no challenge to finish.
    await page.fill("#challenge-form input[name=code]", backupCodes[1]);
    const shown = await submit(page, "challenge-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#challenge-outcome", /challenge has expired/);
  });

  await step("disable with the password and a code", async () => {
    await page.fill("#disable-form input[name=currentPassword]", PASSWORD);
    await page.fill("#disable-form input[name=code]", await freshTotp(secret));
    assertOk(await submit(page, "disable-form"), "disable");
    await textMatches(page, "#disable-outcome", /two-factor is off/);
  });

  return tia;
}

async function checkSessions(run) {
  const sam = await step("sessions: sign up Sam", () => person(run, "Sam"));
  const page = sam.page;
  const laptop = await run.browser.newContext();
  const phone = await run.browser.newContext();
  await apiLogin(laptop, sam.email);
  await apiLogin(phone, sam.email);
  const laptopId = await sessionIdOf(laptop);

  await step("the list shows every device", async () => {
    await open(page, "/sessions");
    assertOk(
      await act(page, () => page.click("#refresh-sessions")),
      "list sessions",
    );
    assert.equal(await page.locator("#sessions tbody tr").count(), 3);
    await page.locator(`tr[data-id="${laptopId}"]`).waitFor();
  });

  await step("revoking one row signs only that device out", async () => {
    const row = page.locator(`tr[data-id="${laptopId}"]`);
    assertOk(
      await act(page, () => row.locator("button[data-revoke]").click()),
      "revoke",
    );
    await textMatches(page, `tr[data-id="${laptopId}"]`, /ended/);
    assert.equal(await profileStatus(laptop), 401);
    assert.equal(await profileStatus(phone), 200);
    await textMatches(page, "#identity", new RegExp(sam.email));
  });

  await step("an unknown id is refused with 404", async () => {
    await page.fill("#revoke-form input[name=sessionId]", "not-a-session");
    const shown = await submit(page, "revoke-form");
    assert.equal(shown.status, 404, shown.text);
    await textMatches(page, "#response-panel .error-line", /session not found/);
  });

  await step("sign out everywhere ends every session", async () => {
    assertOk(await act(page, () => page.click("#logout-all")), "logout-all");
    assert.equal(await profileStatus(phone), 401);
    await textMatches(page, "#identity", /signed out/);
    await textMatches(page, "#sessions", /not signed in/);
  });

  await step("sign out this device still answers when signed out", async () => {
    assertOk(await act(page, () => page.click("#logout-this")), "logout");
  });

  await laptop.close();
  await phone.close();
  return sam;
}

async function checkEdgeCases(run) {
  const lou = await step("edge cases: sign up Lou", () => person(run, "Lou"));
  const page = lou.page;
  await open(page, "/edge-cases");
  await page.fill("#target-email", lou.email);

  await step("five wrong passwords lock the address", async () => {
    const shown = await submit(page, "lockout-form");
    assert.equal(shown.status, 429, shown.text);
    const cells = await page
      .locator("#lockout-trace tbody tr td:nth-child(3)")
      .allInnerTexts();
    assert.deepEqual(cells, ["4", "3", "2", "1", "—"]);
    await textMatches(
      page,
      "#lockout-countdown",
      /locked — try again in \d\d:\d\d/,
    );
  });

  await step("the right password is refused while locked", async () => {
    await page.fill("#right-password-form input[name=password]", PASSWORD);
    const shown = await submit(page, "right-password-form");
    assert.equal(shown.status, 429, shown.text);
    await textMatches(page, "#right-password-outcome", /still locked for/);
  });

  await step("a magic link can still be requested", async () => {
    assertOk(await act(page, () => page.click("#hatch-btn")), "magic request");
    await textMatches(page, "#hatch-outcome", /accepted/);
    await mail(lou.email, "MAGIC");
  });

  await step("the magic link signs in and clears the lockout", async () => {
    assertOk(
      await act(page, () => page.click("#open-magic-btn")),
      "magic consume",
    );
    await textMatches(page, "#hatch-outcome", /signed in as/);
    assertOk(await submit(page, "right-password-form"), "login after link");
    await textMatches(page, "#right-password-outcome", /signed in as/);
  });

  await step("a second magic link inside a minute counts down", async () => {
    await page.selectOption(
      "#cooldown-form select",
      "/auth/magic-link/request",
    );
    assertOk(await submit(page, "cooldown-form"), "magic cooldown");
    await textMatches(page, "#cooldown-outcome", /resend allowed in 00:\d\d/);
  });

  await step("forgot-password's cooldown is silent", async () => {
    await page.selectOption("#cooldown-form select", "/auth/password/forgot");
    assertOk(await submit(page, "cooldown-form"), "forgot");
    await textMatches(page, "#cooldown-outcome", /cooldown is silent/);
  });

  await step("verification resend returns its countdown", async () => {
    await page.selectOption(
      "#cooldown-form select",
      "/auth/email/resend-verification",
    );
    assertOk(await submit(page, "cooldown-form"), "resend verification");
    await textMatches(page, "#cooldown-outcome", /resend allowed in \d\d:\d\d/);
  });

  await step("a code with no challenge is refused", async () => {
    const shown = await act(page, () => page.click("#orphan-code-btn"));
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#orphan-outcome", /refused, as it must be/);
  });

  await step("forgot-password answers a stranger identically", async () => {
    await page.click("[data-fresh-email='#fake-email']");
    await page.selectOption("#enum-form select", "/auth/password/forgot");
    assertOk(await submit(page, "enum-form"), "compare");
    await textMatches(page, "#enum-verdict", /identical — no oracle/);
  });

  return lou;
}

async function checkGoogle(run) {
  const gus = await step("google: sign up Gus", () => person(run, "Gus"));
  const page = gus.page;
  await open(page, "/google");
  await page.fill("#id-token", "not-a-real-google-token");

  await step("sign-in with a bad token shows the refusal", async () => {
    const shown = await submit(page, "signin-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#signin-outcome", /could not be verified/);
  });

  await step("link checks the password first", async () => {
    await page.fill(
      "#link-form input[name=currentPassword]",
      "not-my-password",
    );
    const shown = await submit(page, "link-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#link-outcome", /current password is incorrect/);
  });

  await step("link with the password still checks the token", async () => {
    await page.fill("#link-form input[name=currentPassword]", PASSWORD);
    const shown = await submit(page, "link-form");
    assert.equal(shown.status, 401, shown.text);
    await textMatches(page, "#link-outcome", /could not be verified/);
  });

  await step("unlink with nothing linked is refused", async () => {
    const shown = await act(page, () => page.click("#unlink-btn"));
    assert.equal(shown.status, 400, shown.text);
    await textMatches(page, "#link-outcome", /no Google account is linked/);
  });

  return gus;
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("authx");
    const people = [
      await checkTwoFactor(run),
      await checkSessions(run),
      await checkEdgeCases(run),
      await checkGoogle(run),
    ];
    await step("no page threw", () => {
      for (const somebody of people) {
        assert.deepEqual(somebody.errors, [], somebody.email);
      }
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
