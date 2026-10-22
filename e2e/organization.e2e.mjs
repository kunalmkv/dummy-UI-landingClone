// The organizations page, driven through its UI: found and pick an
// organization, change it, create a workspace, and manage its members.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * act(), with the panel emptied first: a replayed answer can render exactly
 * like the one before it, and would otherwise never count as a change.
 *
 * @param {object} page
 * @param {Function} action
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function press(page, action) {
  await page.locator("#response-panel").evaluate((panel) => {
    panel.innerHTML = "";
  });
  return act(page, action);
}

function submit(page, formSelector) {
  return () => page.locator(`${formSelector} button[type=submit]`).click();
}

/**
 * Assert the panel showed a status, naming what was shown when it did not.
 *
 * @param {{status: number|null, text: string}} shown
 * @param {number} status
 * @param {string} what
 * @returns {void}
 */
function assertStatus(shown, status, what) {
  assert.equal(shown.status, status, `${what}: the panel showed ${shown.text}`);
}

async function panelError(page) {
  return page.locator("#response-panel .error-line").innerText();
}

// The raw response is the panel's last <details>.
async function panelData(page) {
  const raw = await page
    .locator("#response-panel details")
    .last()
    .locator("pre")
    .innerText();
  return JSON.parse(raw).result.data;
}

function memberRow(page, email) {
  return page.locator("#members tbody tr", { hasText: email });
}

async function memberRole(page, email) {
  return (await memberRow(page, email).locator("td.role").innerText()).trim();
}

/**
 * Setup, not the thing under test: invite someone into a workspace and accept
 * it as them, through the API.
 *
 * @param {object} owner who invites
 * @param {string} workspaceId
 * @param {object} invitee
 * @param {string} wsRole
 * @returns {Promise<void>}
 */
async function joinWorkspace(owner, workspaceId, invitee, wsRole) {
  const sent = await owner.context.request.post(
    `${API}/workspaces/${workspaceId}/invites`,
    { data: { recipients: [invitee.email], wsRole: wsRole } },
  );
  const sentBody = await sent.json();
  assert.equal(sentBody.status, 201, `invite ${invitee.email}`);
  const invite = await mail(invitee.email, "WORKSPACE_INVITE");
  const accepted = await invitee.context.request.post(`${API}/invites/accept`, {
    data: { token: invite.payload.inviteLink.split("#")[1] },
  });
  assert.equal((await accepted.json()).status, 200, `accept ${invitee.email}`);
}

// The page has finished loading once the picked organization is on screen.
async function openPage(page) {
  await page.goto(`${HARNESS}/organization`);
  await page.locator("#org-details table").waitFor();
}

(async () => {
  let run = null;
  let failed = false;
  const people = [];
  try {
    run = await startRun("org");
    const olga = await step("sign up the founder", () => person(run, "Olga"));
    people.push(olga);
    const page = olga.page;
    const acmeName = `${run.prefix} Acme`;
    const slug = `${run.prefix}-lab`;
    let acmeId = null;
    let workspaceId = null;

    await step("GET /organizations/mine lists and picks her own", async () => {
      await openPage(page);
      const rows = page.locator("#orgs tbody tr");
      assert.equal(await rows.count(), 1);
      const text = await rows.first().innerText();
      assert.ok(text.includes("Olga Org") && text.includes("OWNER"), text);
    });

    await step("POST /organizations founds one, keyed", async () => {
      assert.match(await page.locator("#org-key").inputValue(), UUID);
      await page.locator("#create-org-form input[name=name]").fill(acmeName);
      const shown = await press(page, submit(page, "#create-org-form"));
      assertStatus(shown, 201, "POST /organizations");
      acmeId = (await panelData(page)).orgId;
      await page.locator(`#orgs tr[data-org-id="${acmeId}"]`).waitFor();
      assert.equal(await page.locator("#orgs tbody tr").count(), 2);
    });

    await step(
      "the same Idempotency-Key replays the first answer",
      async () => {
        const shown = await press(page, submit(page, "#create-org-form"));
        assertStatus(shown, 201, "POST /organizations again");
        assert.equal((await panelData(page)).orgId, acmeId);
        assert.equal(await page.locator("#orgs tbody tr").count(), 2);
      },
    );

    await step("picking it reads GET /organizations/:orgId", async () => {
      const shown = await press(page, () =>
        page.locator(`[data-pick-org="${acmeId}"]`).click(),
      );
      assertOk(shown, "GET /organizations/:orgId");
      const details = await page.locator("#org-details").innerText();
      assert.ok(details.includes(acmeName) && details.includes(acmeId));
    });

    await step("PATCH renames it and sets the primary domain", async () => {
      await page
        .locator("#update-org-form input[name=name]")
        .fill(`${acmeName} Ltd`);
      await page
        .locator("#update-org-form input[name=primaryDomain]")
        .fill("Example.COM");
      const shown = await press(page, submit(page, "#update-org-form"));
      assertOk(shown, "PATCH /organizations/:orgId");
      const details = await page.locator("#org-details").innerText();
      assert.ok(details.includes(`${acmeName} Ltd`), details);
      assert.ok(details.includes("example.com"), details);
    });

    await step("a malformed domain is refused, shown clearly", async () => {
      await page.locator("#update-org-form input[name=name]").fill("");
      await page
        .locator("#update-org-form input[name=primaryDomain]")
        .fill("not a domain");
      const shown = await press(page, submit(page, "#update-org-form"));
      assertStatus(shown, 400, "PATCH with a bad domain");
      assert.match(await panelError(page), /INVALID_DOMAIN/);
    });

    await step("the clear box sends primaryDomain null", async () => {
      await page.locator("#update-org-form input[name=primaryDomain]").fill("");
      await page.locator("#clear-domain").check();
      const shown = await press(page, submit(page, "#update-org-form"));
      assertOk(shown, "PATCH clearing the domain");
      assert.equal((await panelData(page)).primaryDomain, null);
      await page.locator("#clear-domain").uncheck();
    });

    await step("GET /verticals/suggest fills the vertical", async () => {
      await page.locator("#ws-vertical").fill("med");
      const shown = await press(page, () =>
        page.locator("#suggest-verticals").click(),
      );
      assertOk(shown, "GET /verticals/suggest");
      await page.locator('#vertical-chips [data-vertical="Medicare"]').click();
      assert.equal(await page.locator("#ws-vertical").inputValue(), "Medicare");
    });

    await step(
      "GET /workspaces/slug-available says a new slug is free",
      async () => {
        await page.locator("#ws-slug").fill(slug);
        const shown = await press(page, () =>
          page.locator("#check-slug").click(),
        );
        assertOk(shown, "GET /workspaces/slug-available");
        assert.match(await page.locator("#slug-answer").innerText(), /free/);
      },
    );

    await step(
      "POST /organizations/:orgId/workspaces creates one and refreshes the picker",
      async () => {
        await page
          .locator("#create-workspace-form input[name=name]")
          .fill("Lab");
        assert.match(await page.locator("#ws-key").inputValue(), UUID);
        assert.notEqual(await page.locator("#ws-timezone").inputValue(), "");
        const shown = await press(page, submit(page, "#create-workspace-form"));
        assertStatus(shown, 201, "POST /organizations/:orgId/workspaces");
        workspaceId = (await panelData(page)).workspaceId;
        const row = page.locator(
          `#workspaces tr[data-workspace-id="${workspaceId}"]`,
        );
        assert.ok((await row.innerText()).includes("Medicare"));
        assert.equal(
          await page.locator("#workspace-select").inputValue(),
          workspaceId,
        );
      },
    );

    await step(
      "the slug is now taken, and its suggestion can be used",
      async () => {
        const shown = await press(page, () =>
          page.locator("#check-slug").click(),
        );
        assertOk(shown, "GET /workspaces/slug-available again");
        assert.match(await page.locator("#slug-answer").innerText(), /taken/);
        await page.locator("#use-suggestion").click();
        const suggested = await page.locator("#ws-slug").inputValue();
        assert.ok(suggested !== slug && suggested.startsWith(slug), suggested);
      },
    );

    await step("a second workspace on the free plan is refused", async () => {
      await page.locator('[data-new-key="#ws-key"]').click();
      await page
        .locator("#create-workspace-form input[name=name]")
        .fill("Second");
      const shown = await press(page, submit(page, "#create-workspace-form"));
      assertStatus(shown, 409, "a second workspace");
      assert.match(await panelError(page), /WORKSPACE_LIMIT_REACHED/);
    });

    await step(
      "GET /organizations/:orgId/workspaces filters by name",
      async () => {
        await page.locator("#workspaces-form input[name=q]").fill("la");
        const shown = await press(page, submit(page, "#workspaces-form"));
        assertOk(shown, "GET /organizations/:orgId/workspaces");
        assert.equal(await page.locator("#workspaces tbody tr").count(), 1);
        await page.locator(`[data-use-workspace="${workspaceId}"]`).click();
        assert.match(
          await page.locator("#workspaces-note").innerText(),
          /current workspace: Lab/,
        );
      },
    );

    const [mia, adam, hal] = await step(
      "three people join the workspace (setup through the API)",
      async () => {
        const joined = [];
        for (const [label, wsRole] of [
          ["Mia", "EDITOR"],
          ["Adam", "VIEWER"],
          ["Hal", "VIEWER"],
        ]) {
          const someone = await person(run, label);
          people.push(someone);
          await joinWorkspace(olga, workspaceId, someone, wsRole);
          joined.push(someone);
        }
        return joined;
      },
    );

    await step("GET /organizations/:orgId/members lists all four", async () => {
      const shown = await press(page, submit(page, "#members-form"));
      assertOk(shown, "GET /organizations/:orgId/members");
      assert.equal(await page.locator("#members tbody tr").count(), 4);
    });

    await step("the roster filters by role and pages by cursor", async () => {
      const form = "#members-form";
      await page.locator(`${form} select[name=orgRole]`).selectOption("OWNER");
      assertOk(await press(page, submit(page, form)), "orgRole=OWNER");
      assert.equal(await page.locator("#members tbody tr").count(), 1);
      assert.ok((await memberRow(page, olga.email).count()) === 1);

      await page.locator(`${form} select[name=orgRole]`).selectOption("");
      await page.locator(`${form} input[name=limit]`).fill("3");
      assertOk(await press(page, submit(page, form)), "limit=3");
      assert.equal(await page.locator("#members tbody tr").count(), 3);
      const shown = await press(page, () =>
        page.locator("#members-next").click(),
      );
      assertOk(shown, "the next page");
      assert.equal(await page.locator("#members tbody tr").count(), 1);
      assert.ok(await page.locator("#members-next").isDisabled());

      await page.locator(`${form} input[name=limit]`).fill("25");
      assertOk(await press(page, submit(page, form)), "back to every member");
    });

    await step("PATCH a member's role makes Mia ADMIN", async () => {
      await memberRow(page, mia.email).locator("select").selectOption("ADMIN");
      const shown = await press(page, () =>
        memberRow(page, mia.email).locator('[data-action="set-role"]').click(),
      );
      assertOk(shown, "PATCH /organizations/:orgId/members/:userId");
      assert.equal(await memberRole(page, mia.email), "ADMIN");
    });

    await step("a handover without an identity confirmation is refused", async () => {
      await memberRow(page, hal.email).locator("select").selectOption("OWNER");
      const shown = await press(page, () =>
        memberRow(page, hal.email).locator('[data-action="set-role"]').click(),
      );
      assertStatus(shown, 403, "a handover with no identity confirmation");
      assert.match(await panelError(page), /IDENTITY_CONFIRM_REQUIRED/);
    });

    await step("Adam leaves through his own page", async () => {
      const adamPage = adam.page;
      await openPage(adamPage);
      assert.equal(await adamPage.locator("#orgs tbody tr").count(), 2);
      const picked = await press(adamPage, () =>
        adamPage.locator(`[data-pick-org="${acmeId}"]`).click(),
      );
      assertOk(picked, "Adam picks Acme");
      const shown = await press(adamPage, submit(adamPage, "#leave-form"));
      assertOk(shown, "POST /organizations/:orgId/members/me/leave");
      assert.deepEqual(await panelData(adamPage), {
        left: true,
        reassignedTo: [],
      });
      assert.equal(await adamPage.locator("#orgs tbody tr").count(), 1);
      assert.equal(
        await adamPage.locator(`[data-pick-org="${acmeId}"]`).count(),
        0,
      );
      assert.match(
        await adamPage.locator("#workspace-picker").innerText(),
        /no workspace yet/,
      );
    });

    await step("removing yourself is refused", async () => {
      const shown = await press(page, () =>
        memberRow(page, olga.email).locator('[data-action="remove"]').click(),
      );
      assertStatus(shown, 403, "removing yourself");
      assert.match(await panelError(page), /CANNOT_REMOVE_SELF/);
    });

    await step(
      "GET removal-impact, then POST remove takes Mia's seat",
      async () => {
        const impact = await press(page, () =>
          memberRow(page, mia.email).locator('[data-action="impact"]').click(),
        );
        assertOk(impact, "GET .../removal-impact");
        const shownImpact = await page.locator("#impact").innerText();
        assert.ok(shownImpact.includes("seatsFreedInOrg"), shownImpact);
        assert.ok(shownImpact.includes("Lab (EDITOR)"), shownImpact);

        const keyBefore = await page.locator("#removal-key").inputValue();
        const shown = await press(page, () =>
          memberRow(page, mia.email).locator('[data-action="remove"]').click(),
        );
        assertOk(shown, "POST .../remove");
        const removed = await panelData(page);
        assert.equal(removed.removed, true);
        assert.equal(removed.workspacesLost, 1);
        assert.equal(await memberRow(page, mia.email).count(), 0);
        assert.notEqual(
          await page.locator("#removal-key").inputValue(),
          keyBefore,
        );
      },
    );

    await step("an identity confirmation, then handing the organization to Hal", async () => {
      await page.locator("#identity-confirm-form input[name=password]").fill(PASSWORD);
      const granted = await press(page, submit(page, "#identity-confirm-form"));
      assertOk(granted, "POST /auth/identity/confirm");
      await memberRow(page, hal.email).locator("select").selectOption("OWNER");
      const shown = await press(page, () =>
        memberRow(page, hal.email).locator('[data-action="set-role"]').click(),
      );
      assertOk(shown, "the handover");
      assert.equal(await memberRole(page, hal.email), "OWNER");
      assert.equal(await memberRole(page, olga.email), "ADMIN");
      const details = await page.locator("#org-details").innerText();
      assert.match(details, /your role\s+ADMIN/);
    });

    await step("no page threw", () => {
      for (const someone of people) {
        assert.deepEqual(someone.errors, [], someone.email);
      }
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    try {
      await run?.finish();
    } catch (error) {
      failed = true;
      console.error(error);
    }
  }
  process.exit(failed ? 1 : 0);
})();
