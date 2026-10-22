// The workspace page, driven through its UI: read, edit with If-Match, the
// slug check, roles, capabilities, visit, apps, branding, the palette,
// resume, health, and archive/restore behind an identity confirmation.
import assert from "node:assert/strict";

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

import mongoose from "../../backend/node_modules/mongoose/index.js";
import appWaitlistModel from "../../backend/models/workspace/app-waitlist.workspace.model.js";

/**
 * Call the API as someone, for setup that is not under test.
 *
 * @returns {Promise<object>} the parsed envelope
 */
async function apiCall(who, method, path, data, headers) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
    headers: headers,
  });
  return await response.json();
}

/** Open the workspace page and wait until it has loaded the picked workspace. */
async function openWorkspacePage(who, workspaceName) {
  await who.page.goto(`${HARNESS}/workspace`);
  await who.page
    .locator("#ws-view strong")
    .filter({ hasText: workspaceName })
    .waitFor();
}

/** Click and return what the panel then shows. */
function click(page, selector) {
  return act(page, () => page.click(selector));
}

function panelText(page) {
  return page.locator("#response-panel").innerText();
}

function text(page, selector) {
  return page.locator(selector).innerText();
}

/** Ada owns a workspace; Bob joins it as a VIEWER through a real invite. */
async function setUp(run) {
  const ada = await person(run, "Ada");
  const bob = await person(run, "Bob");
  const profile = await apiCall(ada, "GET", "/auth/profile/get");
  const orgId = profile.result.data.user.organizationId;
  const name = `Ada Space ${Date.now().toString(36)}`;
  const created = await apiCall(
    ada,
    "POST",
    `/organizations/${orgId}/workspaces`,
    { name: name, timezone: "UTC" },
  );
  assert.equal(created.status, 201, JSON.stringify(created));
  const workspace = { name: name, ...created.result.data };
  const invited = await apiCall(
    ada,
    "POST",
    `/workspaces/${workspace.workspaceId}/invites`,
    { recipients: [bob.email], wsRole: "VIEWER" },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited));
  const invite = await mail(bob.email, "WORKSPACE_INVITE");
  const accepted = await apiCall(bob, "POST", "/invites/accept", {
    token: invite.payload.inviteLink.split("#")[1],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  return { ada: ada, bob: bob, workspace: workspace };
}

(async () => {
  let run = null;
  let workspaceId = null;
  let failed = false;
  try {
    run = await startRun("workspace");
    const { ada, bob, workspace } = await step(
      "set up: Ada owns a workspace, Bob joins it as a viewer",
      () => setUp(run),
    );
    workspaceId = workspace.workspaceId;
    const page = ada.page;

    await step("the page loads the workspace the picker holds", async () => {
      await openWorkspacePage(ada, workspace.name);
      assert.equal(await page.inputValue("#workspace-select"), workspaceId);
      assert.match(
        await panelText(page),
        new RegExp(`GET /workspaces/${workspaceId}`),
      );
      assert.equal(await text(page, "#ws-version"), "0");
      assert.equal(await page.inputValue("#if-match"), '"0"');
    });

    let suggestion = null;
    await step(
      "the slug check calls its own slug taken and offers a free one",
      async () => {
        await page.fill("#slug-ask", workspace.slug);
        assertOk(
          await click(page, "#slug-form button[type=submit]"),
          "slug check",
        );
        suggestion = await text(page, "#slug-suggestion");
        assert.notEqual(suggestion, workspace.slug);
        await page.click("#use-suggestion");
        assert.equal(
          await page.inputValue("#edit-form [name=slug]"),
          suggestion,
        );
      },
    );

    await step("the slug check calls an unheld slug free", async () => {
      await page.fill("#slug-ask", `free-${Date.now().toString(36)}`);
      assertOk(
        await click(page, "#slug-form button[type=submit]"),
        "slug check",
      );
      assert.match(await text(page, "#slug-result"), /is free/);
    });

    await step(
      "a rename and slug move send If-Match from the version read",
      async () => {
        await page.fill("#edit-form [name=name]", "Ada Renamed");
        assertOk(await click(page, "#edit-form button[type=submit]"), "rename");
        const panel = await panelText(page);
        assert.match(panel, /PATCH/);
        assert.match(panel, /If-Match/);
        assert.match(await text(page, "#ws-view"), /Ada Renamed/);
        assert.match(await text(page, "#ws-view"), new RegExp(suggestion));
        assert.equal(await text(page, "#ws-version"), "1");
        assert.equal(await page.inputValue("#if-match"), '"1"');
      },
    );

    await step(
      "a stale If-Match is refused with VERSION_CONFLICT, shown clearly",
      async () => {
        // Someone else renames it meanwhile, as another tab would.
        const elsewhere = await apiCall(
          ada,
          "PATCH",
          `/workspaces/${workspaceId}`,
          { name: "Changed Elsewhere" },
          { "If-Match": '"1"' },
        );
        assert.equal(elsewhere.status, 200);
        await page.fill("#edit-form [name=name]", "Mine Now");
        const shown = await click(page, "#edit-form button[type=submit]");
        assert.equal(shown.status, 409, shown.text);
        assert.match(await panelText(page), /VERSION_CONFLICT/);
        assert.equal(await page.locator("#conflict-note").isVisible(), true);
        assert.equal(await text(page, "#conflict-version"), "2");
      },
    );

    await step("loading the current version re-arms If-Match", async () => {
      assertOk(await click(page, "#conflict-reload"), "reload");
      assert.match(await text(page, "#ws-view"), /Changed Elsewhere/);
      assert.equal(await page.inputValue("#if-match"), '"2"');
      assert.equal(await page.locator("#conflict-note").isVisible(), false);
    });

    await step("the roles matrix renders from the server", async () => {
      assertOk(await click(page, "#load-roles"), "roles");
      const row = 'tr[data-capability="workspace.delete"]';
      assert.equal(await text(page, `${row} td[data-role=OWNER]`), "yes");
      assert.equal(await text(page, `${row} td[data-role=ADMIN]`), "no");
    });

    await step("the owner's capabilities reach every project", async () => {
      assertOk(await click(page, "#load-capabilities"), "capabilities");
      assert.equal(await text(page, "#reach"), "ALL");
      assert.match(await text(page, "#capabilities-view"), /workspace\.delete/);
    });

    await step("a visit is recorded and shows as lastVisit", async () => {
      assert.equal(await text(page, "#ws-last-visit"), "never");
      assertOk(await click(page, "#record-visit"), "visit");
      assert.match(await panelText(page), /visited/);
      assertOk(await click(page, "#load-workspace"), "reload");
      assert.notEqual(await text(page, "#ws-last-visit"), "never");
    });

    await step("the app grid lists each app's state", async () => {
      assertOk(await click(page, "#load-apps"), "apps");
      assert.equal(await page.locator("#apps-view tbody tr").count(), 6);
      assert.match(await text(page, "tr[data-app=journey]"), /COMING_SOON/);
      assert.equal(await text(page, "tr[data-app=journey] .on-waitlist"), "no");
    });

    await step(
      "joining a waitlist from its row shows on the next load",
      async () => {
        assertOk(await click(page, "tr[data-app=journey] [data-join]"), "join");
        assert.match(await panelText(page), /"joined": true/);
        assertOk(await click(page, "#load-apps"), "apps again");
        assert.equal(
          await text(page, "tr[data-app=journey] .on-waitlist"),
          "yes",
        );
      },
    );

    await step("an app that does not exist is refused", async () => {
      const shown = await click(page, "#waitlist-form button[type=submit]");
      assert.equal(shown.status, 404, shown.text);
      assert.match(await panelText(page), /there is no such app/);
    });

    await step(
      "branding loads and saves a colour and a sender name",
      async () => {
        assertOk(await click(page, "#load-branding"), "branding");
        assert.equal(
          await page.isChecked("#branding-form [name=badgeEnabled]"),
          true,
        );
        await page.fill("#accent-color", "#12ab34");
        await page.fill("#branding-form [name=emailSenderName]", "Ada Co");
        assertOk(
          await click(page, "#branding-form button[type=submit]"),
          "save",
        );
        assert.equal(await page.inputValue("#accent-color"), "#12ab34");
        const swatch = await page
          .locator("#accent-swatch")
          .evaluate((element) => element.style.background);
        assert.equal(swatch, "rgb(18, 171, 52)");
        assert.match(await text(page, "#branding-state"), /does not let/);
      },
    );

    await step("branding refuses a colour that is not #rrggbb", async () => {
      await page.fill("#accent-color", "red");
      const shown = await click(page, "#branding-form button[type=submit]");
      assert.equal(shown.status, 400, shown.text);
      assert.match(await panelText(page), /INVALID_COLOR/);
    });

    await step("branding refuses hiding the badge on this plan", async () => {
      await page.fill("#accent-color", "#12ab34");
      await page.uncheck("#branding-form [name=badgeEnabled]");
      const shown = await click(page, "#branding-form button[type=submit]");
      assert.equal(shown.status, 403, shown.text);
      assert.match(await panelText(page), /ENTITLEMENT_REQUIRED/);
    });

    await step("the palette refuses one character", async () => {
      await page.fill("#search-q", "m");
      const shown = await click(page, "#search-form button[type=submit]");
      assert.equal(shown.status, 400, shown.text);
      assert.match(await text(page, "#search-view"), /at least 2 characters/);
    });

    await step("the palette finds a page and a member", async () => {
      await page.fill("#search-q", "me");
      assertOk(await click(page, "#search-form button[type=submit]"), "search");
      assert.match(await text(page, "#search-view"), /Members/);
      await page.fill("#search-q", "bo");
      assertOk(await click(page, "#search-form button[type=submit]"), "search");
      assert.match(await text(page, "#search-view"), new RegExp(bob.email));
    });

    await step("resume and health render", async () => {
      assertOk(await click(page, "#load-resume"), "resume");
      assert.match(await text(page, "#resume-view"), /nothing to pick up/);
      assertOk(await click(page, "#load-health"), "health");
      assert.match(await text(page, "tr[data-area=webhooks]"), /webhooks/);
    });

    await step(
      "Bob, a viewer, reads the workspace but is refused a rename",
      async () => {
        await openWorkspacePage(bob, "Changed Elsewhere");
        assertOk(await click(bob.page, "#load-capabilities"), "capabilities");
        assert.doesNotMatch(
          await text(bob.page, "#capabilities-view"),
          /workspace\.settings\.update/,
        );
        await bob.page.fill("#edit-form [name=name]", "Bob Was Here");
        const shown = await click(bob.page, "#edit-form button[type=submit]");
        assert.equal(shown.status, 403, shown.text);
      },
    );

    await step("archive is refused without an identity confirmation", async () => {
      await page.check("#archive-form [name=emailMembers]");
      const shown = await click(page, "#archive-form button[type=submit]");
      assert.equal(shown.status, 403, shown.text);
      assert.match(await panelText(page), /IDENTITY_CONFIRM_REQUIRED/);
    });

    await step("a wrong password grants no identity confirmation", async () => {
      await page.fill("#identity-confirm-password", "not the password at all");
      const shown = await click(page, "#identity-confirm-form button[type=submit]");
      assert.equal(shown.status, 401, shown.text);
      assert.match(await text(page, "#identity-confirm-state"), /not granted/);
    });

    await step(
      "the password grants one archive, which emails members",
      async () => {
        await page.fill("#identity-confirm-password", PASSWORD);
        assertOk(
          await click(page, "#identity-confirm-form button[type=submit]"),
          "identity confirmation",
        );
        assert.match(
          await text(page, "#identity-confirm-state"),
          /granted for WORKSPACE_ARCHIVE/,
        );
        assertOk(
          await click(page, "#archive-form button[type=submit]"),
          "archive",
        );
        assert.match(await panelText(page), /ARCHIVED/);
        await mail(bob.email, "WORKSPACE_ARCHIVED");
        assertOk(await click(page, "#load-workspace"), "reload");
        assert.match(await text(page, "#ws-view"), /read-only/);
      },
    );

    await step("restore makes it writable again", async () => {
      assertOk(await click(page, "#restore"), "restore");
      assert.match(await panelText(page), /"status": "ACTIVE"/);
      assertOk(await click(page, "#load-workspace"), "reload");
      assert.doesNotMatch(await text(page, "#ws-view"), /read-only/);
    });

    await step("no page threw", () => {
      assert.deepEqual(ada.errors, []);
      assert.deepEqual(bob.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    // run.finish() does not know the waitlist collection yet.
    if (workspaceId !== null) {
      await appWaitlistModel.collection.deleteMany({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      });
    }
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
