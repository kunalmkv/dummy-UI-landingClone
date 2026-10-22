// The after-sign-in journey (/flow) against the real API: a brand-new account
// lands on No-workspace, creates a workspace, finishes onboarding, opens it,
// makes a project, invites Gus and renames it. Gus then accepts on his /flow.
import assert from "node:assert/strict";

import { HARNESS, person, startRun, step } from "./harness.mjs";

/**
 * Wait until an output box says something matching, and return its text.
 *
 * @param {object} page
 * @param {string} selector
 * @param {RegExp} pattern
 * @returns {Promise<string>}
 */
async function waitText(page, selector, pattern) {
  await page.waitForFunction(
    ([css, source]) =>
      new RegExp(source).test(document.querySelector(css)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: 60000 },
  );
  return page.locator(selector).innerText();
}

/**
 * Open /flow and wait until it has checked who is signed in.
 *
 * @param {object} page
 * @returns {Promise<void>}
 */
async function openFlow(page) {
  await page.goto(`${HARNESS}/flow`);
  await page.waitForSelector("body[data-ready=true]", { timeout: 60000 });
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("flow");
    const [fay, gus] = await step("sign up Fay and Gus", () =>
      Promise.all([person(run, "Fay"), person(run, "Gus")]),
    );
    const page = fay.page;
    const slug = `${run.prefix}-studio`.toLowerCase().slice(-36);

    await step("0. the page knows who is signed in, from the live API", async () => {
      await openFlow(page);
      assert.match(await page.locator("#out-you").innerText(), new RegExp(fay.email));
      assert.equal(await page.locator("#response-panel .chip.served-live").count(), 1);
    });

    await step("1. a brand-new account lands on the No-workspace screen", async () => {
      await page.click('[data-run="landing"]');
      await waitText(page, "#out-landing .decision", /No-workspace/);
      assert.match(await page.locator("#out-landing").innerText(), /Fay Org/);
    });

    await step("3. it has no invitations yet", async () => {
      await page.click('[data-run="invites"]');
      await waitText(page, "#out-invites", /no pending invitations/);
    });

    await step("4. the slug is checked as typed, then the workspace is created", async () => {
      await page.fill('#create-form input[name="name"]', "Fay Studio");
      await page.fill("#create-slug", slug);
      await waitText(page, "#slug-state", /free/);
      await page.click("#create-form button[type=submit]");
      const shown = await waitText(page, "#out-create", /created|✗/);
      assert.match(shown, /created Fay Studio/, shown);
      assert.match(shown, /you are OWNER/);
      assert.match(await page.locator("#state-bar").innerText(), /Fay Studio \(OWNER\)/);
    });

    await step("4b. onboarding finishes and opens the workspace", async () => {
      await page.selectOption("#onboarding-app", "affify");
      await page.click("#onboarding-form button[type=submit]");
      await waitText(page, "#out-onboarding", /onboarding finished|✗/);
      const home = await waitText(page, "#out-home", /visit recorded/);
      assert.match(home, /Fay Studio/);
      assert.match(home, /Affify ACTIVE/);
      assert.doesNotMatch(await page.locator("#state-bar").innerText(), /version · —/);
    });

    await step("6. a project is created in an open app", async () => {
      await page.click('[data-run="projects"]');
      await waitText(page, "#out-projects", /no projects yet/);
      await page.selectOption("#project-app", "affify");
      await page.fill('#project-form input[name="name"]', "Spring promo");
      await page.click("#project-form button[type=submit]");
      const shown = await waitText(page, "#out-projects", /created|✗/);
      assert.match(shown, /created Spring promo in affify/, shown);
    });

    await step("7. seats, then Gus is previewed, invited and listed", async () => {
      await page.click('[data-run="team"]');
      await waitText(page, "#out-team", /used of/);
      await page.fill('#invite-form textarea[name="recipients"]', gus.email);
      await page.click("#invite-preview");
      assert.match(await waitText(page, "#out-team", /will invite|✗/), new RegExp(gus.email));
      await page.click("#invite-form button[type=submit]");
      assert.match(await waitText(page, "#out-team", /sent|✗/), /sent/);
      await page.click("#invite-list");
      await waitText(page, "#out-team", /PENDING/);
      assert.match(await page.locator("#out-team").innerText(), new RegExp(gus.email));
    });

    await step("8. the rename sends If-Match and moves the version on", async () => {
      await page.fill('#settings-form input[name="name"]', "Fay Studio Two");
      await page.click("#settings-form button[type=submit]");
      const shown = await waitText(page, "#out-settings", /renamed|✗/);
      assert.match(shown, /renamed to Fay Studio Two · version now/, shown);
      assert.match(await page.locator("#response-panel").innerText(), /If-Match/);
    });

    await step("2. the picker lists it and opening it remembers the pick", async () => {
      await page.click('[data-run="picker"]');
      await waitText(page, "#out-picker", /Fay Studio Two/);
      await page.locator("#out-picker [data-open]").first().click();
      await waitText(page, "#out-home", /visit recorded/);
    });

    await step("Gus accepts the invitation on his own /flow", async () => {
      await openFlow(gus.page);
      await gus.page.click('[data-run="invites"]');
      await waitText(gus.page, "#out-invites", /Fay Studio Two/);
      await gus.page.locator("#out-invites [data-accept]").first().click();
      await waitText(gus.page, "#out-invites", /joined Fay Studio Two as EDITOR/);
      await waitText(gus.page, "#out-home", /visit recorded/);
    });

    await step("no page threw", () => {
      assert.deepEqual(fay.errors, []);
      assert.deepEqual(gus.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
