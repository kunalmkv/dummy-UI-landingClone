// The wiki's live tester in a real browser: every category renders every
// documented route, and one chained flow — ids captured by one card filling
// the next, ending in a PATCH that sends If-Match — works against the API.
// Then json and number fields go as real arrays, objects, null and numbers.
import assert from "node:assert/strict";

import envUtil from "../../backend/util/env.util.js";

import internalUsersEnum from "../../backend/enum/internal-users.enum.js";

import categoryDocs from "../../backend/wiki/docs/category.docs.wiki.js";

import { person, startRun, step } from "./harness.mjs";

const WIKI = "http://localhost:4002";

/**
 * Open a card, send it, and return the status line it shows.
 *
 * @param {object} page
 * @param {string} slug e.g. get-organizations-mine
 * @param {object} [fields] { "body-name": "Acme" } typed before sending
 * @returns {Promise<string>}
 */
async function send(page, slug, fields = {}) {
  const card = page.locator(`details#${slug}`);
  await card.waitFor({ state: "attached" });
  if (!(await card.evaluate((node) => node.open))) {
    // The card's own head: a nested <details> has a summary of its own.
    await card.locator("summary.ep-head").click();
  }
  for (const [key, value] of Object.entries(fields)) {
    const field = page.locator(`#f-${slug}-${key}`);
    if ((await field.evaluate((node) => node.tagName)) === "SELECT") {
      await field.selectOption(value);
    } else {
      await field.fill(value);
    }
  }
  const status = card.locator(".actions .status");
  await card.locator(".send").click();
  await page.waitForFunction(
    (node) => /^\d{3} ·/.test(node.textContent),
    await status.elementHandle(),
    { timeout: 30000 },
  );
  return status.innerText();
}

/**
 * The curl line a card shows for what it sends.
 *
 * @param {object} page
 * @param {string} slug
 * @returns {Promise<string>}
 */
async function curlOf(page, slug) {
  return await page.locator(`details#${slug} .curl`).textContent();
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("wiki");
    const ada = await step("a signed-in person", () => person(run, "Ada"));
    const token = envUtil.getUserGithubToken(internalUsersEnum.CODE);
    await ada.context.addInitScript(
      (value) => sessionStorage.setItem("chakra-wiki-token", value),
      token,
    );
    const { page } = ada;
    await page.goto(`${WIKI}/`);

    const docs = await page.evaluate(
      async (value) =>
        (
          await (
            await fetch("/wiki/docs", {
              headers: { authorization: "Bearer " + value },
            })
          ).json()
        ).result.data,
      token,
    );

    await step("the wiki serves the docs on disk", () =>
      assert.equal(
        JSON.stringify(docs.categories),
        JSON.stringify(categoryDocs),
        "the running wiki is older than the docs: restart it",
      ),
    );

    await step("every category renders every documented route", async () => {
      for (const category of docs.categories) {
        await page.goto(`${WIKI}/#/${category.key}`);
        await page.waitForFunction(
          (count) => document.querySelectorAll("details.ep").length === count,
          category.endpoints.length,
          { timeout: 15000 },
        );
      }
    });

    await page.goto(`${WIKI}/#/organizations`);
    await step("GET /organizations/mine answers and captures orgId", async () =>
      assert.match(await send(page, "get-organizations-mine"), /^200/),
    );
    await step(
      "the create-workspace card is filled from it and creates",
      async () => {
        const orgId = await page
          .locator("#f-post-organizations-orgid-workspaces-params-orgId")
          .inputValue();
        assert.match(orgId, /^[0-9a-f]{24}$/, "orgId was not carried over");
        assert.match(
          await send(page, "post-organizations-orgid-workspaces", {
            "body-name": "Wiki Tester",
          }),
          /^20[01]/,
        );
      },
    );

    await page.goto(`${WIKI}/#/workspaces`);
    await step("GET the workspace, capturing its version", async () =>
      assert.match(await send(page, "get-workspaces-workspaceid"), /^200/),
    );
    await step("PATCH it with If-Match from the captured version", async () => {
      const ifMatch = await page
        .locator("#f-patch-workspaces-workspaceid-headers-If-Match")
        .inputValue();
      assert.ok(ifMatch !== "", "the If-Match field was not filled");
      assert.match(
        await send(page, "patch-workspaces-workspaceid", {
          "body-name": "Wiki Tester Renamed",
        }),
        /^200/,
      );
      const curl = await page
        .locator("details#patch-workspaces-workspaceid .curl")
        .textContent();
      assert.match(curl, /-H 'If-Match: /, "the curl line lacks the header");
    });

    await page.goto(`${WIKI}/#/organizations`);
    await step("a json field sends null: the domain is cleared", async () => {
      const slug = "patch-organizations-orgid";
      assert.match(
        await send(page, slug, { "body-primaryDomain": "null" }),
        /^200/,
      );
      assert.match(await curlOf(page, slug), /"primaryDomain":null/);
    });

    await page.goto(`${WIKI}/#/billing`);
    await step("a number field sends a number: extra seats", async () => {
      const slug = "post-workspaces-workspaceid-billing-seats";
      // SEATS_BELOW_USAGE is the documented refusal; a 400 would be the type.
      assert.match(await send(page, slug), /^(200|409) ·/);
      assert.match(await curlOf(page, slug), /"seatsExtra":2[,}]/);
    });

    await page.goto(`${WIKI}/#/invitations`);
    await step("an invitation batch sends an array and a boolean", async () => {
      const slug = "post-workspaces-workspaceid-invites";
      const recipients = JSON.stringify([`${run.prefix}-grace@example.com`]);
      // An admin invitation: the sample projectRoles name no project of this
      // workspace, so they are left blank and the flag goes instead.
      assert.match(
        await send(page, slug, {
          "body-recipients": recipients,
          "body-admin": "true",
          "body-projectRoles": "",
        }),
        /^201/,
      );
      const curl = await curlOf(page, slug);
      assert.ok(curl.includes(`"recipients":${recipients}`), curl);
      assert.ok(curl.includes('"admin":true'), curl);
      assert.ok(!curl.includes('"projectRoles"'), curl);
    });

    // Before the token: its capture fills the webhook card's Authorization.
    await page.goto(`${WIKI}/#/webhooks`);
    await step(
      "a webhook endpoint sends events and headers as arrays",
      async () => {
        const slug = "post-workspaces-workspaceid-webhook-endpoints";
        const headers = '[{"name":"X-Crm-Key","value":"abc"}]';
        assert.match(
          await send(page, slug, { "body-headers": headers }),
          /^201/,
        );
        const curl = await curlOf(page, slug);
        assert.ok(curl.includes('"events":["member.invited"]'), curl);
        assert.ok(curl.includes(`"headers":${headers}`), curl);
      },
    );

    await page.goto(`${WIKI}/#/tokens`);
    await step("an API token is minted with scopes as an array", async () => {
      const slug = "post-workspaces-workspaceid-tokens";
      assert.match(await send(page, slug), /^201/);
      assert.ok(
        (await curlOf(page, slug)).includes('"scopes":["reports.read"]'),
        "scopes did not go as an array",
      );
    });

    await step("a coded refusal shows its code and message", async () => {
      await page.goto(`${WIKI}/#/workspaces`);
      const status = await send(page, "post-workspaces-workspaceid-archive");
      assert.match(status, /^403/);
      const message = await page
        .locator("details#post-workspaces-workspaceid-archive .msg")
        .innerText();
      assert.match(message, /^IDENTITY_CONFIRM_REQUIRED — /);
    });

    await step("the page threw nothing", () =>
      assert.deepEqual(ada.errors, []),
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
