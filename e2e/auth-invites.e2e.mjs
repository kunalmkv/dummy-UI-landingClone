// The retired organization invitations: the /invites page only says so and
// the five /auth/invite routes are gone (retired 2026-10-26; workspace
// invitations are the one way in). Also the dev inbox for a workspace invite.
import assert from "node:assert/strict";

import {
  API,
  HARNESS,
  act,
  assertOk,
  mail,
  person,
  startRun,
  step,
} from "./harness.mjs";

/**
 * Open a harness page and wait for its first calls to finish.
 *
 * @param {object} page
 * @param {string} path
 * @returns {Promise<void>}
 */
async function open(page, path) {
  await page.goto(`${HARNESS}${path}`);
  await page.locator("body[data-ready]").waitFor();
}

/**
 * Setup that is not under test, straight to the API as this person.
 *
 * @param {object} who a person
 * @param {string} method
 * @param {string} path
 * @param {object} [data]
 * @returns {Promise<*>} result.data
 */
async function callApi(who, method, path, data) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
  });
  const body = await response.json();
  assert.ok(
    [200, 201, 202].includes(body.status),
    `${method} ${path} answered ${body.status}: ${JSON.stringify(body.result)}`,
  );
  return body.result.data;
}

/**
 * True when a route is gone: no success envelope comes back for it.
 *
 * @returns {Promise<boolean>}
 */
async function isGone(who, method, path, data) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
  });
  try {
    return (await response.json()).status !== 200;
  } catch {
    return true;
  }
}

(async () => {
  let run = null;
  let failed = false;
  const everyone = [];
  try {
    run = await startRun("invites");

    const ada = await step("Ada signs up", () => person(run, "Ada"));
    everyone.push(ada);

    await step(
      "the page says the flow was retired and points to invitations",
      async () => {
        await ada.page.goto(`${HARNESS}/invites`);
        const note = ada.page.locator("#retired-note");
        await note.waitFor();
        assert.match(await note.innerText(), /Retired on 2026-10-26/);
        assert.equal(
          await note.locator('a[href="/invitations"]').count(),
          1,
          "a link to invitations",
        );
        assert.equal(
          await ada.page.locator('nav[data-nav] a[href="/invites"]').count(),
          0,
          "no nav link to the retired page",
        );
      },
    );

    await step(
      "the organization invitation routes are gone from the API",
      async () => {
        const gone = [
          ["GET", "/auth/invite/preview?token=x"],
          ["POST", "/auth/invite/accept", { token: "x" }],
          [
            "POST",
            "/auth/invite/send",
            { email: "x@example.com", role: "MEMBER" },
          ],
          ["GET", "/auth/invite/list"],
          ["POST", "/auth/invite/revoke", { inviteId: "x" }],
        ];
        for (const [method, path, data] of gone) {
          assert.ok(await isGone(ada, method, path, data), `${method} ${path}`);
        }
      },
    );

    // A workspace mail, made through the API, for the inbox.
    const [dora, eve] = await step("Dora and Eve sign up", () =>
      Promise.all([person(run, "Dora"), person(run, "Eve")]),
    );
    everyone.push(dora, eve);

    const tokens = await step(
      "Dora invites Eve onto a project of her workspace",
      async () => {
        const doraOrgId = (await callApi(dora, "GET", "/auth/profile/get")).user
          .organizationId;
        const { workspaceId } = await callApi(
          dora,
          "POST",
          `/organizations/${doraOrgId}/workspaces`,
          { name: "Harbor", timezone: "UTC" },
        );
        const { projectId } = await callApi(
          dora,
          "POST",
          `/workspaces/${workspaceId}/projects`,
          { appId: "affify", name: "Pier" },
        );
        await callApi(dora, "POST", `/workspaces/${workspaceId}/invites`, {
          recipients: [eve.email],
          projectRoles: [{ projectId: projectId, role: "EDITOR" }],
        });
        const invite = (
          await mail(eve.email, "WORKSPACE_INVITE")
        ).payload.inviteLink.split("#")[1];
        await callApi(eve, "POST", "/invites/accept", { token: invite });
        return { invite: invite };
      },
    );

    await step("Eve's inbox shows her code and workspace invite", async () => {
      await open(eve.page, "/inbox");
      await eve.page.fill("#filter-email", eve.email);
      assertOk(
        await act(eve.page, () =>
          eve.page.click("#filter-form button[type=submit]"),
        ),
        "filter",
      );
      assert.equal(
        new URL(eve.page.url()).searchParams.get("email"),
        eve.email,
      );

      const verify = eve.page.locator("#rows tr[data-type=VERIFY]");
      assert.equal(
        await verify.locator(".code").innerText(),
        (await mail(eve.email, "VERIFY")).payload.code,
      );
      assert.match(
        await verify
          .locator("a[data-link=verificationLink]")
          .getAttribute("href"),
        new RegExp(`^${HARNESS}/verify-email\\?token=.+&email=`),
      );

      const invite = eve.page.locator("#rows tr[data-type=WORKSPACE_INVITE]");
      assert.match(await invite.innerText(), /Harbor/);
      assert.equal(
        await invite.locator("a[data-link=inviteLink]").getAttribute("href"),
        `${HARNESS}/invite#${tokens.invite}`,
      );
    });

    await step("no page threw", () =>
      everyone.forEach((someone) => assert.deepEqual(someone.errors, [])),
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
