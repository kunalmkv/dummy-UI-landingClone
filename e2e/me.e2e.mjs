// The account page (/me): the landing bootstrap, the workspace switcher,
// onboarding and the notification bell, driven through its UI.
//
// Setup, through the API: Ada owns "Ada Studio" and invites Bob and Cara, who
// accept, so Ada has two unread INVITE_ACCEPTED notifications. Bob then invites
// Ada into his "Bob Bench", so she reaches two workspaces in two organizations.
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

const UNREACHABLE_ID = "000000000000000000000000";

/**
 * Call the API as someone, with their cookie. Setup only.
 *
 * @param {object} someone from person()
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<object>} the response envelope
 */
async function send(someone, method, path, body) {
  const response = await someone.context.request.fetch(`${API}${path}`, {
    method: method,
    data: body,
  });
  return await response.json();
}

/**
 * @param {object} owner
 * @param {string} name
 * @returns {Promise<string>} the new workspace's id
 */
async function createWorkspace(owner, name) {
  const profile = await send(owner, "GET", "/auth/profile/get");
  const orgId = profile.result.data.user.organizationId;
  const created = await send(
    owner,
    "POST",
    `/organizations/${orgId}/workspaces`,
    {
      name: name,
      timezone: "UTC",
    },
  );
  assert.equal(
    created.status,
    201,
    `create ${name}: ${JSON.stringify(created)}`,
  );
  return created.result.data.workspaceId;
}

/**
 * Invite someone as a VIEWER and accept the mailed link as them.
 *
 * @param {object} inviter
 * @param {string} workspaceId
 * @param {object} invitee
 * @returns {Promise<void>}
 */
async function inviteAndAccept(inviter, workspaceId, invitee) {
  const invited = await send(
    inviter,
    "POST",
    `/workspaces/${workspaceId}/invites`,
    { recipients: [invitee.email], wsRole: "VIEWER" },
  );
  assert.equal(invited.status, 201, `invite: ${JSON.stringify(invited)}`);
  const row = await mail(invitee.email, "WORKSPACE_INVITE");
  const accepted = await send(invitee, "POST", "/invites/accept", {
    token: row.payload.inviteLink.split("#")[1],
  });
  assert.equal(accepted.status, 200, `accept: ${JSON.stringify(accepted)}`);
}

/**
 * The text of one bootstrap summary field.
 *
 * @param {object} page
 * @param {string} name
 * @returns {Promise<string>}
 */
function field(page, name) {
  return page.locator(`[data-field="${name}"]`).innerText();
}

/**
 * Wait until a bootstrap summary field shows the expected text.
 *
 * @param {object} page
 * @param {string} name
 * @param {string} expected a substring
 * @returns {Promise<void>}
 */
async function waitForField(page, name, expected) {
  await page
    .locator(`[data-field="${name}"]`, { hasText: expected })
    .waitFor({ timeout: 10000 });
}

/**
 * @param {object} page
 * @returns {Promise<string[]>} the notification ids the table shows
 */
async function shownNotificationIds(page) {
  return page
    .locator("#notifications tr[data-notification]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.notification));
}

/**
 * Load a notifications page from the form.
 *
 * @param {object} page
 * @param {string} status
 * @param {string} limit
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function loadFirstPage(page, status, limit) {
  await page.selectOption("#notifications-status", status);
  await page.fill("#notifications-limit", limit);
  return act(page, () => page.click("#first-page"));
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("me");
    const [ada, bob, cara] = await step("sign up Ada, Bob and Cara", () =>
      Promise.all([
        person(run, "Ada"),
        person(run, "Bob"),
        person(run, "Cara"),
      ]),
    );
    const { adaStudio, bobBench } = await step(
      "Ada's workspace gets two acceptances; Bob's takes Ada in",
      async () => {
        const studio = await createWorkspace(ada, "Ada Studio");
        await inviteAndAccept(ada, studio, bob);
        await inviteAndAccept(ada, studio, cara);
        const bench = await createWorkspace(bob, "Bob Bench");
        await inviteAndAccept(bob, bench, ada);
        return { adaStudio: studio, bobBench: bench };
      },
    );
    const page = ada.page;

    await step("GET /me/bootstrap: the landing renders on open", async () => {
      await page.goto(`${HARNESS}/me`);
      await page
        .locator("#response-panel .badge", { hasText: "GET /me/bootstrap" })
        .waitFor();
      // The bell list loads quietly after the landing call; wait for it too.
      await page.locator("#notifications table").waitFor();
      assert.match(
        await page.locator("#response-panel .status").innerText(),
        /^200/,
      );
      assert.equal(await field(page, "email"), ada.email);
      assert.equal(await field(page, "onboardingComplete"), "no");
      assert.equal(await field(page, "startingApp"), "null");
      assert.equal(await field(page, "lastWorkspaceId"), "null");
      // Two workspaces and no last pick: no landing workspace, so bootstrap
      // counts only account-level notices. The bell below is Ada Studio's.
      assert.equal(await field(page, "unreadNotifications"), "0");
      assert.equal(await page.locator("#bell").innerText(), "2 unread");
      const orgRows = page.locator("#organizations tbody tr");
      assert.equal(await orgRows.count(), 2);
      assert.match(await orgRows.nth(0).innerText(), /Ada Org\s+primary/);
      assert.match(await orgRows.nth(1).innerText(), /Bob Org[\s\S]*MEMBER/);
    });

    await step("reload bootstrap from its button", async () => {
      assertOk(
        await act(page, () => page.click("#load-bootstrap")),
        "GET /me/bootstrap",
      );
    });

    await step("GET /me/workspaces: both workspaces, by name", async () => {
      assertOk(
        await act(page, () => page.click("#load-workspaces")),
        "GET /me/workspaces",
      );
      const rows = page.locator("#workspaces tbody tr");
      assert.equal(await rows.count(), 2);
      assert.match(await rows.nth(0).innerText(), /Ada Studio[\s\S]*OWNER/);
      assert.match(await rows.nth(1).innerText(), /Bob Bench[\s\S]*VIEWER/);
      assert.equal(await page.locator("#workspaces [data-last]").count(), 0);
    });

    await step("PUT /me/last-workspace from a switcher row", async () => {
      const row = page.locator(`tr[data-workspace="${bobBench}"]`);
      assertOk(
        await act(page, () => row.locator("[data-remember]").click()),
        "PUT /me/last-workspace",
      );
      await row.locator("[data-last]").waitFor();
      assert.equal(await page.locator("#workspaces [data-last]").count(), 1);
      await waitForField(page, "lastWorkspaceId", bobBench);
      // The harness's other pages now act on the same workspace.
      assert.equal(await page.evaluate(() => currentWorkspace()?.id), bobBench);
    });

    await step("an id Ada does not reach is refused 404", async () => {
      await page.fill("#remember-id", UNREACHABLE_ID);
      const shown = await act(page, () =>
        page.click("#remember-form button[type=submit]"),
      );
      assert.equal(shown.status, 404, shown.text);
      assert.match(
        await page.locator("#response-panel .error-line").innerText(),
        /NOT_FOUND/,
      );
      assert.match(await field(page, "lastWorkspaceId"), new RegExp(bobBench));
    });

    await step(
      "POST /me/onboarding/complete refuses an unknown app",
      async () => {
        await page.selectOption("#onboarding-workspace", adaStudio);
        await page.selectOption("#onboarding-app", "spreadsheets");
        const shown = await act(page, () =>
          page.click("#onboarding-form button[type=submit]"),
        );
        assert.equal(shown.status, 400, shown.text);
        assert.match(
          await page.locator("#response-panel .error-line").innerText(),
          /INVALID_REQUEST/,
        );
        assert.equal(await field(page, "onboardingComplete"), "no");
      },
    );

    await step("POST /me/onboarding/complete finishes onboarding", async () => {
      await page.selectOption("#onboarding-workspace", adaStudio);
      await page.selectOption("#onboarding-app", "journey");
      assertOk(
        await act(page, () =>
          page.click("#onboarding-form button[type=submit]"),
        ),
        "POST /me/onboarding/complete",
      );
      await waitForField(page, "onboardingComplete", "yes");
      assert.equal(await field(page, "startingApp"), "journey");
      // Onboarding also remembers its workspace as the last pick.
      assert.match(await field(page, "lastWorkspaceId"), /Ada Studio/);
    });

    await step("GET /workspaces/:workspaceId/notifications pages by cursor", async () => {
      // The bell is per workspace, and the last pick moved the page to Bob Bench.
      await page.selectOption("#workspace-select", adaStudio);
      await page.locator("#notifications table").waitFor();
      assertOk(await loadFirstPage(page, "all", "1"), "first page");
      const firstPage = await shownNotificationIds(page);
      assert.equal(firstPage.length, 1);
      const [first] = firstPage;
      assert.equal(await page.locator("#next-page").isDisabled(), false);

      assertOk(await act(page, () => page.click("#next-page")), "next page");
      assert.match(
        await page.locator("#response-panel .badge").innerText(),
        /cursor=/,
      );
      const second = await shownNotificationIds(page);
      assert.equal(second.length, 1);
      assert.notEqual(second[0], first);
      assert.equal(await page.locator("#next-page").isDisabled(), true);
      assert.match(await page.locator("#next-cursor").innerText(), /last page/);
      const titles = await page.locator("#notifications").innerText();
      assert.match(titles, /joined Ada Studio/);
    });

    await step("a capitalised status is refused 400", async () => {
      const shown = await loadFirstPage(page, "UNREAD", "25");
      assert.equal(shown.status, 400, shown.text);
      assert.match(
        await page.locator("#response-panel .error-line").innerText(),
        /status must be unread or all/,
      );
    });

    await step("marking with nothing ticked is refused 400", async () => {
      assertOk(await loadFirstPage(page, "unread", "25"), "unread page");
      assert.equal((await shownNotificationIds(page)).length, 2);
      const shown = await act(page, () => page.click("#mark-ticked"));
      assert.equal(shown.status, 400, shown.text);
      assert.equal(await page.locator("#bell").innerText(), "2 unread");
    });

    await step("POST …/notifications/read: one from its row", async () => {
      const [first] = await shownNotificationIds(page);
      assertOk(
        await act(page, () =>
          page.click(`tr[data-notification="${first}"] [data-read]`),
        ),
        "mark one read",
      );
      assert.equal(await page.locator("#bell").innerText(), "1 unread");
      assert.equal((await shownNotificationIds(page)).includes(first), false);
    });

    await step("POST …/notifications/read: the ticked ones", async () => {
      const [remaining] = await shownNotificationIds(page);
      await page.check(`tr[data-notification="${remaining}"] [data-tick]`);
      assertOk(
        await act(page, () => page.click("#mark-ticked")),
        "mark ticked read",
      );
      assert.equal(await page.locator("#bell").innerText(), "0 unread");
      assert.equal((await shownNotificationIds(page)).length, 0);
    });

    await step("POST …/notifications/read: all, safe to repeat", async () => {
      assertOk(await act(page, () => page.click("#mark-all")), "mark all read");
      assert.equal(await page.locator("#bell").innerText(), "0 unread");
    });

    await step("everything shows as read, and bootstrap agrees", async () => {
      assertOk(await loadFirstPage(page, "all", "25"), "all page");
      assert.equal((await shownNotificationIds(page)).length, 2);
      assert.equal(await page.locator("#notifications tr.unread").count(), 0);
      assertOk(
        await act(page, () => page.click("#load-bootstrap")),
        "GET /me/bootstrap",
      );
      assert.equal(await field(page, "unreadNotifications"), "0");
    });

    await step("the page threw nothing", () => {
      for (const someone of [ada, bob, cara]) {
        assert.deepEqual(someone.errors, [], someone.email);
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
