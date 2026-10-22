// The members page: the list and its filters, one member, role, project
// access, suspension, removal after its impact, leaving, seats and presence.
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
 * The API's own status for a person reading the workspace.
 *
 * @returns {Promise<number>}
 */
async function workspaceStatusFor(who, workspaceId) {
  const response = await who.context.request.get(
    `${API}/workspaces/${workspaceId}`,
  );
  return (await response.json()).status;
}

async function errorLine(page) {
  return page.locator("#response-panel .error-line").innerText();
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("members");
    const olga = await step("Olga signs up", () => person(run, "Olga"));
    const eve = await step("Eve signs up", () => person(run, "Eve"));
    const vic = await step("Vic signs up", () => person(run, "Vic"));

    const { workspaceId, projectId, olgaId } = await step(
      "Olga makes a workspace with a project; Eve (EDITOR) and Vic (VIEWER) join",
      async () => {
        const profile = await setup(olga, "GET", "/auth/profile/get");
        const created = await setup(
          olga,
          "POST",
          `/organizations/${profile.user.organizationId}/workspaces`,
          { name: "Members Lab", timezone: "UTC" },
        );
        const project = await setup(
          olga,
          "POST",
          `/workspaces/${created.workspaceId}/projects`,
          { appId: "affify", name: "Spring leads" },
        );
        await join(olga, created.workspaceId, eve, "EDITOR");
        await join(olga, created.workspaceId, vic, "VIEWER");
        // Seen, so her presence dot is ONLINE.
        await setup(olga, "POST", `/workspaces/${created.workspaceId}/visit`);
        return {
          workspaceId: created.workspaceId,
          projectId: project.projectId,
          olgaId: profile.user.id,
        };
      },
    );

    const page = olga.page;
    const table = page.locator("#members-table");
    const rowOf = (who) => table.locator("tbody tr", { hasText: who.email });
    const fieldOf = (who, field) =>
      rowOf(who).locator(`[data-field="${field}"]`).innerText();
    const listButton = '#list-form button[type="submit"]';

    const eveId = await step(
      "the list loads for the picked workspace, presence inlined",
      async () => {
        await page.goto(`${HARNESS}/members`);
        await rowOf(vic).waitFor();
        assert.match(
          await page.locator("#response-panel .badge").innerText(),
          new RegExp(`GET /workspaces/${workspaceId}/members`),
        );
        assert.equal(await table.locator("tbody tr").count(), 3);
        assert.match(await fieldOf(olga, "presence"), /ONLINE/);
        assert.match(await fieldOf(vic, "presence"), /OFFLINE/);
        assert.equal(await fieldOf(eve, "role"), "EDITOR");
        assert.equal(await fieldOf(eve, "seat"), "paid");
        assert.equal(await fieldOf(vic, "seat"), "free");
        return rowOf(eve).getAttribute("data-user-id");
      },
    );

    await step("the role filter narrows the list to Eve", async () => {
      await page.selectOption('#list-form select[name="role"]', "EDITOR");
      assertOk(await act(page, () => page.click(listButton)), "filter");
      assert.equal(await table.locator("tbody tr").count(), 1);
      assert.equal(await rowOf(eve).count(), 1);
      await page.selectOption('#list-form select[name="role"]', "");
    });

    await step(
      "a page of two, then the next page from its cursor",
      async () => {
        await page.fill('#list-form input[name="limit"]', "2");
        assertOk(await act(page, () => page.click(listButton)), "first page");
        assert.equal(await table.locator("tbody tr").count(), 2);
        assertOk(await act(page, () => page.click("#next-page")), "next page");
        assert.equal(await table.locator("tbody tr").count(), 3);
        assert.equal(await page.locator("#next-page").isHidden(), true);
        await page.fill('#list-form input[name="limit"]', "");
      },
    );

    await step("select shows one member and what they reach", async () => {
      const shown = await act(page, () =>
        rowOf(eve).locator('button[data-action="select"]').click(),
      );
      assertOk(shown, "one member");
      assert.equal(await page.inputValue("#member-id"), eveId);
      assert.equal(
        await page
          .locator('#member-detail [data-field="reachableProjects"]')
          .innerText(),
        "ALL",
      );
    });

    await step("Eve is raised to ADMIN", async () => {
      await page.selectOption('#role-form select[name="wsRole"]', "ADMIN");
      assertOk(
        await act(page, () => page.click('#role-form button[type="submit"]')),
        "role",
      );
      assert.equal(await fieldOf(eve, "role"), "ADMIN");
    });

    await step(
      "Eve is limited to one project, then given all again",
      async () => {
        const submit = () => page.click('#access-form button[type="submit"]');
        await page.selectOption('#access-form select[name="mode"]', "LIMITED");
        await page.fill('#access-form input[name="projectIds"]', projectId);
        assertOk(await act(page, submit), "limited");
        assert.equal(await fieldOf(eve, "access"), "LIMITED 1/1");
        await page.selectOption('#access-form select[name="mode"]', "ALL");
        assertOk(await act(page, submit), "all");
        assert.equal(await fieldOf(eve, "access"), "ALL 1/1");
      },
    );

    await step(
      "Eve is suspended and locked out, then reactivated",
      async () => {
        assertOk(
          await act(page, () =>
            rowOf(eve).locator('button[data-action="suspend"]').click(),
          ),
          "suspend",
        );
        assert.equal(await fieldOf(eve, "status"), "SUSPENDED");
        assert.equal(await workspaceStatusFor(eve, workspaceId), 404);
        assertOk(
          await act(page, () =>
            rowOf(eve).locator('button[data-action="reactivate"]').click(),
          ),
          "reactivate",
        );
        assert.equal(await fieldOf(eve, "status"), "ACTIVE");
        assert.equal(await workspaceStatusFor(eve, workspaceId), 200);
      },
    );

    await step(
      "Olga cannot suspend herself, and the panel says why",
      async () => {
        const refused = await act(page, () =>
          rowOf(olga).locator('button[data-action="suspend"]').click(),
        );
        assert.equal(refused.status, 403);
        assert.match(await errorLine(page), /CANNOT_MODIFY_SELF/);
        assert.equal(await fieldOf(olga, "status"), "ACTIVE");
      },
    );

    await step("seats show the organization's meter", async () => {
      assertOk(await act(page, () => page.click("#seats-button")), "seats");
      assert.equal(
        await page.locator('#seats [data-field="plan"]').innerText(),
        "free",
      );
      // Olga and Eve; Vic is a free VIEWER.
      assert.equal(
        await page.locator('#seats [data-field="seatsUsed"]').innerText(),
        "2",
      );
    });

    await step("presence names Olga as online", async () => {
      assertOk(
        await act(page, () => page.click("#presence-button")),
        "presence",
      );
      assert.match(
        await page.locator("#presence tr", { hasText: olga.email }).innerText(),
        /ONLINE/,
      );
    });

    await step(
      "the removal impact says Eve's pending invitation needs a new owner",
      async () => {
        await setup(eve, "POST", `/workspaces/${workspaceId}/invites`, {
          recipients: [`${run.prefix}-guest@example.com`],
          wsRole: "VIEWER",
        });
        assertOk(
          await act(page, () =>
            rowOf(eve).locator('button[data-action="impact"]').click(),
          ),
          "impact",
        );
        const lines = await page.locator("#impact-lines").innerText();
        assert.match(lines, /hand over 1 pending invitation/);
        assert.match(lines, /free their paid seat/);
        const candidates = await page
          .locator("#reassign-to option")
          .allInnerTexts();
        assert.ok(candidates.some((text) => text.includes(olga.email)));
      },
    );

    await step(
      "removing Eve with nobody named is refused; naming Olga removes her",
      async () => {
        const refused = await act(page, () => page.click("#remove-button"));
        assert.equal(refused.status, 400);
        assert.match(await errorLine(page), /REASSIGN_REQUIRED/);
        await page.selectOption("#reassign-to", olgaId);
        assertOk(await act(page, () => page.click("#remove-button")), "remove");
        assert.equal(await rowOf(eve).count(), 0);
        assert.equal(await workspaceStatusFor(eve, workspaceId), 404);
        // The same Idempotency-Key answers the first result again.
        assertOk(
          await act(page, () => page.click("#remove-button")),
          "replayed remove",
        );
      },
    );

    await step("Olga cannot leave while Vic is still here", async () => {
      const refused = await act(page, () =>
        page.click('#leave-form button[type="submit"]'),
      );
      assert.equal(refused.status, 409);
      assert.match(await errorLine(page), /LAST_OWNER/);
    });

    await step("Vic leaves from his own page", async () => {
      await vic.page.goto(`${HARNESS}/members`);
      await vic.page
        .locator("#members-table tbody tr", { hasText: vic.email })
        .waitFor();
      assertOk(
        await act(vic.page, () =>
          vic.page.click('#leave-form button[type="submit"]'),
        ),
        "leave",
      );
      assert.match(
        await vic.page.locator("#members-table").innerText(),
        /you left/,
      );
      assert.equal(await workspaceStatusFor(vic, workspaceId), 404);
    });

    await step("no page threw", () => {
      for (const who of [olga, eve, vic]) {
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
