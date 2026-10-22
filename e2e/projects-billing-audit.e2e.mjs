// The projects, billing and audit pages, driven through their UI: the project
// list with its filters and cursor, create, get, rename, archive and the plan
// limit; plans, the plan switch and its key, seats and a blocked downgrade;
// the audit log behind its plan gate, every filter, and paging.
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
 * Invite someone into a workspace and accept it as them.
 *
 * @returns {Promise<void>}
 */
async function join(inviter, workspaceId, joiner, wsRole) {
  await setup(inviter, "POST", `/workspaces/${workspaceId}/invites`, {
    recipients: [joiner.email],
    wsRole: wsRole,
  });
  const invite = await mail(joiner.email, "WORKSPACE_INVITE");
  await setup(joiner, "POST", "/invites/accept", {
    token: invite.payload.inviteLink.split("#")[1],
  });
}

/**
 * Wait until an element's text matches.
 *
 * @returns {Promise<void>}
 */
async function waitText(page, selector, pattern) {
  await page.waitForFunction(
    ([target, source]) =>
      new RegExp(source).test(document.querySelector(target)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: 30000 },
  );
}

function click(page, selector) {
  return act(page, () => page.click(selector));
}

function errorLine(page) {
  return page.locator("#response-panel .error-line").innerText();
}

function texts(page, selector) {
  return page.locator(selector).allInnerTexts();
}

// --- projects ----------------------------------------------------------

const LIST = '#list-form button[type="submit"]';
const CREATE = '#create-form button[type="submit"]';
const CHANGE = '#change-form button[type="submit"]';

function projectRow(page, projectId) {
  return page.locator(`#projects-table tr[data-project-id="${projectId}"]`);
}

function projectField(page, projectId, field) {
  return projectRow(page, projectId)
    .locator(`[data-field="${field}"]`)
    .innerText();
}

function projectRows(page) {
  return page.locator("#projects-table tbody tr").count();
}

/**
 * Create a project through the form; returns what the panel showed and the
 * new id the page put in the projectId box.
 *
 * @returns {Promise<{shown: object, projectId: string}>}
 */
async function createProject(page, appId, name, vertical) {
  await page.selectOption('#create-form select[name="appId"]', appId);
  await page.fill('#create-form input[name="name"]', name);
  await page.fill('#create-form input[name="vertical"]', vertical);
  const shown = await click(page, CREATE);
  return { shown: shown, projectId: await page.inputValue("#project-id") };
}

/** Set the list form's filters and list. */
async function listProjects(
  page,
  { status = "", appId = "", q = "", limit = "" },
) {
  await page.selectOption('#list-form select[name="status"]', status);
  await page.selectOption('#list-form select[name="appId"]', appId);
  await page.fill('#list-form input[name="q"]', q);
  await page.fill('#list-form input[name="limit"]', limit);
  assertOk(await click(page, LIST), "list projects");
}

async function projectsSteps(olga, eve, workspaceId) {
  const page = olga.page;

  await step(
    "the projects page lists the picked workspace, empty",
    async () => {
      await page.goto(`${HARNESS}/projects`);
      await waitText(page, "#projects-table", /no projects match/);
      assert.match(
        await page.locator("#response-panel .badge").innerText(),
        new RegExp(`GET /workspaces/${workspaceId}/projects`),
      );
    },
  );

  const spring = await step(
    "two projects are created through the form",
    async () => {
      const first = await createProject(
        page,
        "affify",
        "Spring leads",
        "Medicare",
      );
      assert.equal(first.shown.status, 201, first.shown.text);
      const second = await createProject(page, "connect", "Summer leads", "");
      assert.equal(second.shown.status, 201, second.shown.text);
      assert.equal(await projectRows(page), 2);
      assert.equal(
        await projectField(page, first.projectId, "vertical"),
        "Medicare",
      );
      assert.equal(await projectField(page, second.projectId, "vertical"), "—");
      assert.equal(
        await projectField(page, second.projectId, "appId"),
        "connect",
      );
      return { springId: first.projectId, summerId: second.projectId };
    },
  );
  const { springId, summerId } = spring;

  await step("a blank name is refused and the panel says why", async () => {
    const refused = (await createProject(page, "affify", "", "")).shown;
    assert.equal(refused.status, 400);
    assert.match(
      await errorLine(page),
      /INVALID_REQUEST — name must be 1 to 100/,
    );
  });

  await step(
    "filters: appId narrows, q matches a name's start, ARCHIVED is empty",
    async () => {
      await listProjects(page, { appId: "connect" });
      assert.equal(await projectRows(page), 1);
      assert.equal(await projectRow(page, summerId).count(), 1);
      await listProjects(page, { q: "spr" });
      assert.equal(await projectRows(page), 1);
      assert.equal(await projectRow(page, springId).count(), 1);
      await listProjects(page, { status: "ARCHIVED" });
      await waitText(page, "#projects-table", /no projects match/);
    },
  );

  await step("select shows one project", async () => {
    await listProjects(page, {});
    const shown = await act(page, () =>
      projectRow(page, springId)
        .locator('button[data-action="select"]')
        .click(),
    );
    assertOk(shown, "get one");
    assert.equal(await page.inputValue("#project-id"), springId);
    assert.equal(
      await page.locator('#project-detail [data-field="name"]').innerText(),
      "Spring leads",
    );
  });

  await step("PATCH renames it and clears its vertical", async () => {
    await page.fill('#change-form input[name="name"]', "Spring leads v2");
    await page.check('#change-form input[name="clearVertical"]');
    assertOk(await click(page, CHANGE), "rename");
    await page.uncheck('#change-form input[name="clearVertical"]');
    assert.equal(await projectField(page, springId, "name"), "Spring leads v2");
    assert.equal(await projectField(page, springId, "vertical"), "—");
    assert.equal(
      await page.locator('#project-detail [data-field="vertical"]').innerText(),
      "—",
    );
  });

  await step("a change with nothing in it is refused", async () => {
    await page.fill('#change-form input[name="name"]', "");
    const refused = await click(page, CHANGE);
    assert.equal(refused.status, 400);
    assert.match(await errorLine(page), /send a name or a vertical to change/);
  });

  await step(
    "the free plan's five projects refuse a sixth; archiving frees a place",
    async () => {
      for (const name of ["P3", "P4", "P5"]) {
        await setup(olga, "POST", `/workspaces/${workspaceId}/projects`, {
          appId: "affify",
          name: name,
        });
      }
      await listProjects(page, {});
      assert.equal(await projectRows(page), 5);
      const refused = (await createProject(page, "affify", "Sixth", "")).shown;
      assert.equal(refused.status, 403);
      assert.match(
        await errorLine(page),
        /ENTITLEMENT_REQUIRED — the plan allows 5 projects/,
      );
      const archived = await act(page, () =>
        projectRow(page, summerId)
          .locator('button[data-action="archive"]')
          .click(),
      );
      assertOk(archived, "archive");
      assert.equal(await projectField(page, summerId, "status"), "ARCHIVED");
      const created = await createProject(page, "affify", "Sixth", "");
      assert.equal(created.shown.status, 201, created.shown.text);
    },
  );

  await step("two per page, then the next pages from the cursor", async () => {
    await listProjects(page, { limit: "2" });
    assert.equal(await projectRows(page), 2);
    assertOk(await click(page, "#next-page"), "page two");
    assert.equal(await projectRows(page), 4);
    assertOk(await click(page, "#next-page"), "page three");
    assert.equal(await projectRows(page), 5);
    assert.equal(await page.locator("#next-page").isHidden(), true);
    assert.equal(await projectRow(page, summerId).count(), 0);
  });

  await step("the ARCHIVED list holds Summer, still readable", async () => {
    await listProjects(page, { status: "ARCHIVED" });
    assert.equal(await projectRows(page), 1);
    assert.equal(await projectField(page, summerId, "status"), "ARCHIVED");
    await page.fill("#project-id", summerId);
    assertOk(
      await click(page, '#get-form button[type="submit"]'),
      "get archived",
    );
  });

  await step(
    "as a reports.read token the list works, a create is refused, a bad token is 401",
    async () => {
      const minted = await setup(
        olga,
        "POST",
        `/workspaces/${workspaceId}/tokens`,
        { name: "PBA reader", scopes: ["reports.read"] },
      );
      await page.fill("#api-token", minted.secret);
      await listProjects(page, {});
      assert.equal(await projectRows(page), 5);
      assert.match(
        await page.locator("#response-panel").innerText(),
        /"Authorization": "Bearer \S+"/,
      );
      const refused = (await createProject(page, "affify", "By token", ""))
        .shown;
      assert.equal(refused.status, 403);
      assert.match(await errorLine(page), /permission/);
      await page.fill("#api-token", "ifi_live_not-a-real-token");
      const unknown = await click(page, LIST);
      assert.equal(unknown.status, 401);
      await page.fill("#api-token", "");
    },
  );

  await step(
    "Eve (EDITOR) reads and renames, but cannot create or archive",
    async () => {
      const evePage = eve.page;
      await evePage.goto(`${HARNESS}/projects`);
      await projectRow(evePage, springId).waitFor();
      const refused = (await createProject(evePage, "affify", "Eve's", ""))
        .shown;
      assert.equal(refused.status, 403);
      assert.match(await errorLine(evePage), /permission/);
      assertOk(
        await act(evePage, () =>
          projectRow(evePage, springId)
            .locator('button[data-action="select"]')
            .click(),
        ),
        "Eve gets one",
      );
      await evePage.fill('#change-form input[name="name"]', "Spring leads v3");
      assertOk(await click(evePage, CHANGE), "Eve renames");
      assert.equal(
        await projectField(evePage, springId, "name"),
        "Spring leads v3",
      );
      const archive = await click(evePage, "#archive-button");
      assert.equal(archive.status, 403);
      assert.match(await errorLine(evePage), /permission/);
    },
  );
}

// --- billing -----------------------------------------------------------

function billingField(page, field) {
  return page.locator(`#billing [data-field="${field}"]`).innerText();
}

/** Open the billing page and wait for both of its reads. */
async function openBilling(page) {
  await page.goto(`${HARNESS}/billing`);
  await page.locator("#plans tbody tr").nth(3).waitFor();
  await page.locator("#billing table, #billing .error-line").first().waitFor();
}

async function billingSteps(olga, eve, orgId) {
  const page = olga.page;

  await step(
    "billing shows the free plan, the seat meter and its limits",
    async () => {
      await openBilling(page);
      assert.equal(await billingField(page, "plan"), "free");
      // Olga and Eve, an EDITOR, hold a paid seat each.
      assert.equal(await billingField(page, "seatMeter"), "2 of 3");
      assert.equal(await billingField(page, "workspaceMeter"), "1 of 1");
      assert.equal(
        await page
          .locator('#current-limits [data-field="projectsPerWorkspace"]')
          .innerText(),
        "5",
      );
      assert.equal(
        await page
          .locator('#plans tr[data-plan-id="free"] [data-field="current"]')
          .count(),
        1,
      );
      assertOk(await click(page, "#plans-button"), "plans");
      assertOk(await click(page, "#billing-button"), "billing");
    },
  );

  const key = await step(
    "moving to starter from its row updates the figures",
    async () => {
      assertOk(
        await click(page, '#plans tr[data-plan-id="starter"] button'),
        "starter",
      );
      await waitText(page, '#billing [data-field="plan"]', /^starter$/);
      assert.equal(await billingField(page, "seatMeter"), "2 of 10");
      assert.equal(
        await page
          .locator('#current-limits [data-field="auditLogVisible"]')
          .innerText(),
        "true",
      );
      return page.inputValue("#idempotency-key");
    },
  );

  await step(
    "the same key replays; the same key for another plan is refused",
    async () => {
      assert.ok(key.length > 0);
      assertOk(await click(page, '#plan-form button[type="submit"]'), "replay");
      assert.match(
        await page.locator("#response-panel").innerText(),
        /"plan": "starter"/,
      );
      await page.selectOption("#plan-select", "growth");
      const refused = await click(page, '#plan-form button[type="submit"]');
      assert.equal(refused.status, 400);
      assert.match(
        await errorLine(page),
        /already used for a different request/,
      );
      assert.match(await page.locator("#plan-refusal").innerText(), /refused/);
      assertOk(await click(page, "#billing-button"), "billing after refusal");
      assert.equal(await billingField(page, "plan"), "starter");
    },
  );

  await step(
    "extra seats: 2 is set, the same number as a string is refused",
    async () => {
      await page.fill('#seats-form input[name="seatsExtra"]', "2");
      assertOk(await click(page, '#seats-form button[type="submit"]'), "seats");
      await waitText(page, '#billing [data-field="seatsExtra"]', /^2$/);
      assert.equal(await billingField(page, "seatMeter"), "2 of 12");
      await page.check('#seats-form input[name="asString"]');
      const refused = await click(page, '#seats-form button[type="submit"]');
      assert.equal(refused.status, 400);
      assert.match(await errorLine(page), /seatsExtra must be a whole number/);
      await page.uncheck('#seats-form input[name="asString"]');
    },
  );

  await step(
    "a downgrade below what is in use is blocked, with the reason",
    async () => {
      await setup(olga, "POST", `/organizations/${orgId}/workspaces`, {
        name: "PBA Second",
        timezone: "UTC",
      });
      const refused = await click(
        page,
        '#plans tr[data-plan-id="free"] button',
      );
      assert.equal(refused.status, 409);
      assert.match(await errorLine(page), /DOWNGRADE_BLOCKED/);
      assert.match(
        await page.locator("#plan-refusal").innerText(),
        /0 seat\(s\) and 1 workspace\(s\)/,
      );
      assertOk(await click(page, "#billing-button"), "billing after block");
      assert.equal(await billingField(page, "plan"), "starter");
      assert.equal(await billingField(page, "workspaceMeter"), "2 of 3");
    },
  );

  await step(
    "Eve (EDITOR) is refused billing, but may read the plans",
    async () => {
      const evePage = eve.page;
      await openBilling(evePage);
      assert.match(
        await evePage.locator("#billing .error-line").innerText(),
        /permission/,
      );
      const refused = await click(
        evePage,
        '#plans tr[data-plan-id="growth"] button',
      );
      assert.equal(refused.status, 403);
      assert.match(await errorLine(evePage), /permission/);
    },
  );
}

// --- audit -------------------------------------------------------------

const SEARCH = '#events-form button[type="submit"]';

function eventRows(page) {
  return page.locator("#events-table tbody tr").count();
}

async function search(page, filters) {
  await page.click('#events-form button[type="reset"]');
  for (const [name, value] of Object.entries(filters)) {
    const field = page.locator(`#events-form [name="${name}"]`);
    if ((await field.evaluate((element) => element.tagName)) === "SELECT") {
      await field.selectOption(value);
    } else {
      await field.fill(value);
    }
  }
  return click(page, SEARCH);
}

async function auditGateSteps(olga) {
  await step(
    "on the free plan the audit log shows ENTITLEMENT_REQUIRED clearly",
    async () => {
      const page = olga.page;
      await page.goto(`${HARNESS}/audit`);
      // The events table is the page's last read, so the load is over.
      await waitText(page, "#events-table", /ENTITLEMENT_REQUIRED/);
      assert.match(
        await page.locator("#audit-gate").innerText(),
        /hidden on this plan/,
      );
      const refused = await click(page, SEARCH);
      assert.equal(refused.status, 403);
      assert.match(
        await errorLine(page),
        /ENTITLEMENT_REQUIRED — the plan does not show/,
      );
      const actions = await click(page, "#actions-button");
      assert.equal(actions.status, 403);
    },
  );
}

async function auditSteps(olga, eve, runStartedAt, eveId) {
  const page = olga.page;

  await step(
    "on starter the actions fill the filters and the trail loads",
    async () => {
      await page.goto(`${HARNESS}/audit`);
      await page.locator("#events-table tbody tr").first().waitFor();
      assert.equal(await page.locator("#audit-gate").isHidden(), true);
      assertOk(await click(page, "#actions-button"), "actions");
      assert.match(
        await page.locator("#actions-count").innerText(),
        /^\d+ actions$/,
      );
      assert.equal(
        await page
          .locator('#action-select option[value="project.created"]')
          .count(),
        1,
      );
      assert.equal(
        await page
          .locator('#target-type-select option[value="billing"]')
          .count(),
        1,
      );
    },
  );

  await step(
    "the action filter narrows to the six projects created",
    async () => {
      assertOk(await search(page, { action: "project.created" }), "by action");
      assert.equal(await eventRows(page), 6);
      const actions = await texts(page, '#events-table [data-field="action"]');
      assert.ok(actions.every((action) => action === "project.created"));
    },
  );

  await step(
    "'same actor' on Eve's rename narrows to what Eve did",
    async () => {
      assertOk(await search(page, { action: "project.updated" }), "renames");
      assert.equal(await eventRows(page), 2);
      const eveRow = page.locator("#events-table tbody tr", {
        hasText: "Eve Tester",
      });
      assertOk(
        await act(page, () =>
          eveRow.locator('button[data-filter="actorId"]').click(),
        ),
        "same actor",
      );
      assert.equal(
        await page.inputValue('#events-form [name="actorId"]'),
        eveId,
      );
      assert.equal(await eventRows(page), 1);
      assert.match(
        await page.locator('#events-table [data-field="changes"]').innerText(),
        /name: "Spring leads v2" → "Spring leads v3"/,
      );
    },
  );

  await step("targetType billing shows the plan and seat changes", async () => {
    assertOk(await search(page, { targetType: "billing" }), "by target");
    const actions = await texts(page, '#events-table [data-field="action"]');
    assert.deepEqual(actions.sort(), [
      "billing.plan_changed",
      "billing.seats_changed",
    ]);
    assert.match(
      await page.locator("#events-table tbody").innerText(),
      /seatsExtra: 0 → 2/,
    );
  });

  await step("from and to bound the time; a bad date is refused", async () => {
    const soon = new Date(Date.now() + 60000).toISOString();
    assertOk(await search(page, { from: runStartedAt, to: soon }), "bounded");
    assert.ok((await eventRows(page)) > 0);
    assertOk(await search(page, { from: "2099-01-01T00:00:00Z" }), "future");
    await waitText(page, "#events-table", /no events match/);
    const refused = await search(page, { from: "yesterday" });
    assert.equal(refused.status, 400);
    assert.match(await errorLine(page), /from is not a date/);
  });

  await step("two per page, then the next page from its cursor", async () => {
    assertOk(await search(page, { limit: "2" }), "page one");
    assert.equal(await eventRows(page), 2);
    assertOk(await click(page, "#next-page"), "page two");
    const ids = await page
      .locator("#events-table tbody tr")
      .evaluateAll((rows) => rows.map((row) => row.dataset.eventId));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
  });

  await step(
    "Eve (EDITOR) is refused the log, and it is not the plan gate",
    async () => {
      const evePage = eve.page;
      await evePage.goto(`${HARNESS}/audit`);
      await waitText(evePage, "#events-table", /permission/);
      assert.equal(await evePage.locator("#audit-gate").isHidden(), true);
    },
  );
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("pba");
    const runStartedAt = new Date().toISOString();
    const olga = await step("Olga signs up", () => person(run, "Olga"));
    const eve = await step("Eve signs up", () => person(run, "Eve"));

    const { workspaceId, orgId, eveId } = await step(
      "Olga makes a workspace; Eve joins it as an EDITOR",
      async () => {
        const profile = await setup(olga, "GET", "/auth/profile/get");
        const orgId = profile.user.organizationId;
        const created = await setup(
          olga,
          "POST",
          `/organizations/${orgId}/workspaces`,
          { name: "PBA Lab", timezone: "UTC" },
        );
        await join(olga, created.workspaceId, eve, "EDITOR");
        const eveProfile = await setup(eve, "GET", "/auth/profile/get");
        return {
          workspaceId: created.workspaceId,
          orgId: orgId,
          eveId: eveProfile.user.id,
        };
      },
    );

    await projectsSteps(olga, eve, workspaceId);
    await auditGateSteps(olga);
    await billingSteps(olga, eve, orgId);
    await auditSteps(olga, eve, runStartedAt, eveId);

    await step("no page threw", () => {
      for (const who of [olga, eve]) {
        assert.deepEqual(who.errors, [], who.email);
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
