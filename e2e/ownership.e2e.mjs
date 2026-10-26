// The retired ownership page: workspace ownership transfer was removed on
// 2026-10-25 (project-level roles). The page only says so, and the routes it
// drove are gone from the API.
import assert from "node:assert/strict";

import { API, HARNESS, person, startRun, step } from "./harness.mjs";

/**
 * Setup through the API as a person: never the thing under test.
 *
 * @returns {Promise<object>} result.data
 */
async function setup(who, method, path, data) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
  });
  const body = await response.json();
  assert.ok(
    [200, 201].includes(body.status),
    `${method} ${path}: ${JSON.stringify(body)}`,
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
  try {
    run = await startRun("ownership");
    const olga = await step("Olga signs up", () => person(run, "Olga"));

    const workspaceId = await step("Olga makes a workspace", async () => {
      const profile = await setup(olga, "GET", "/auth/profile/get");
      const created = await setup(
        olga,
        "POST",
        `/organizations/${profile.user.organizationId}/workspaces`,
        { name: "Handover Lab", timezone: "UTC" },
      );
      return created.workspaceId;
    });

    await step("the page says the flow was retired and points to members", async () => {
      await olga.page.goto(`${HARNESS}/ownership`);
      const note = olga.page.locator("#retired-note");
      await note.waitFor();
      assert.match(await note.innerText(), /Retired on 2026-10-25/);
      assert.equal(
        await note.locator('a[href="/members"]').count(),
        1,
        "a link to members",
      );
      assert.equal(
        await olga.page.locator('nav[data-nav] a[href="/ownership"]').count(),
        0,
        "no nav link to the retired page",
      );
    });

    await step("the ownership routes are gone from the API", async () => {
      const gone = [
        ["GET", `/workspaces/${workspaceId}/ownership-transfer`],
        ["POST", `/workspaces/${workspaceId}/ownership-transfer`, {}],
        ["DELETE", `/workspaces/${workspaceId}/ownership-transfer`],
        ["POST", `/workspaces/${workspaceId}/ownership/assign`, {}],
        ["POST", "/ownership-transfers/accept", { token: "x" }],
      ];
      for (const [method, path, data] of gone) {
        assert.ok(await isGone(olga, method, path, data), `${method} ${path}`);
      }
    });

    await step("no page threw", () => {
      assert.deepEqual(olga.errors, [], olga.email);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
