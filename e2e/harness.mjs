// Shared furniture for the harness's end-to-end checks: a real headless
// browser against the real pages on :3001 and the real API on :3000.
//
// People are signed up and verified through the API (the browser context's
// request shares its cookies), so a page's check never depends on another
// page working. Everything a run creates is deleted by its email prefix.

import assert from "node:assert/strict";

import "../../backend/node/bootstrap.node.js";

import { chromium } from "playwright";
import mongoose from "../../backend/node_modules/mongoose/index.js";

import runHelper from "../../backend/master/tests/helpers/http-run.helper.js";

// Override with HARNESS=http://localhost:3002 to drive the hybrid harness (planned routes on the mock).
export const HARNESS = process.env.HARNESS ?? "http://localhost:3001";
export const API = process.env.API_TARGET ?? "http://localhost:3000";
export const PASSWORD = "correct horse battery staple";

// ⚠️ LOCAL ONLY, and enforced rather than trusted. These checks create
// accounts and then DELETE rows out of Mongo by email prefix. Run them
// against a shared or deployed API and the cleanup deletes other people's
// data. The page harness can point anywhere (server.js proxies it); this
// cannot.
{
  const { hostname } = new URL(API);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `e2e refuses to run against ${API}. These checks delete rows from Mongo ` +
        "by email prefix and are only safe against a local master. Unset " +
        "API_TARGET to run them.",
    );
  }
}

/**
 * A run: its browser, its email prefix, and a cleanup that checks the seat
 * ledger is still true before deleting what the run made.
 *
 * @param {string} label short, letters only
 * @returns {Promise<object>}
 */
export async function startRun(label) {
  await runHelper.connect();
  const prefix = `harness${label}-${Date.now()}`;
  // The installed Chrome: Playwright's own build here is older than it wants.
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  return {
    prefix: prefix,
    browser: browser,
    async finish() {
      try {
        await runHelper.assertSeatLedgersClean(prefix);
      } finally {
        await runHelper.cleanUp(prefix);
        await browser.close();
        await mongoose.disconnect();
      }
    },
  };
}

/**
 * The newest outbox row of a type sent to an address, waiting up to 15s.
 *
 * @param {string} email
 * @param {string} type e.g. VERIFY, WORKSPACE_INVITE, OWNERSHIP_TRANSFER
 * @returns {Promise<object>}
 */
export async function mail(email, type) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await (
      await fetch(`${HARNESS}/dev/outbox?email=${encodeURIComponent(email)}`)
    ).json();
    const row = rows.find((candidate) => candidate.type === type);
    if (row) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no ${type} mail reached ${email}`);
}

/**
 * A new, verified, signed-in person in a browser context of their own, with
 * page errors collected so a check can assert the page never threw.
 *
 * @param {object} run from startRun
 * @param {string} label letters only; also their first name
 * @returns {Promise<{context: object, page: object, email: string, errors: string[]}>}
 */
export async function person(run, label) {
  const context = await run.browser.newContext();
  const email = `${run.prefix}-${label.toLowerCase()}@example.com`;
  const registered = await context.request.post(
    `${API}/auth/account/register`,
    {
      data: {
        email: email,
        password: PASSWORD,
        firstName: label,
        lastName: "Tester",
        organization: `${label} Org`,
      },
    },
  );
  const answer = await registered.json();
  assert.equal(
    answer.status,
    200,
    `register ${email}: ${JSON.stringify(answer.result)}`,
  );
  const verify = await mail(email, "VERIFY");
  const verified = await context.request.post(`${API}/auth/email/verify`, {
    data: { email: email, code: verify.payload.code },
  });
  const body = await verified.json();
  assert.equal(body.result?.data?.signedIn, true, `verify ${email}`);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context: context, page: page, email: email, errors: errors };
}

/**
 * Do something on a page and return the status the response panel then shows.
 *
 * @param {object} page
 * @param {Function} action async () => void, e.g. a click
 * @returns {Promise<{status: number|null, text: string}>}
 */
export async function act(page, action) {
  const panel = page.locator("#response-panel");
  // Emptied first: two identical answers would otherwise look like no answer.
  await panel.evaluate((node) => {
    node.innerHTML = "";
  });
  await action();
  await page.waitForFunction(
    () => document.querySelector("#response-panel").innerHTML !== "",
    null,
    { timeout: 30000 },
  );
  const text = await panel.locator(".status").first().innerText();
  return { status: Number.parseInt(text, 10) || null, text: text };
}

/**
 * Assert a panel status was a success (200, 201 or 202).
 *
 * @param {{status: number|null, text: string}} shown from act
 * @param {string} what
 * @returns {void}
 */
export function assertOk(shown, what) {
  assert.ok(
    [200, 201, 202].includes(shown.status),
    `${what}: the panel showed ${shown.text}`,
  );
}

/**
 * A step with a name, so a failure says where the flow broke.
 *
 * @param {string} name
 * @param {Function} fn
 * @returns {Promise<*>}
 */
export async function step(name, fn) {
  try {
    const value = await fn();
    console.log(`  ✔ ${name}`);
    return value;
  } catch (error) {
    console.log(`  ✖ ${name}`);
    throw error;
  }
}
