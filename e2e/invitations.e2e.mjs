// Workspace invitations, driven through /invitations and /invite: an owner
// sends and manages them; invitees decline, accept signed in, accept from
// "my invitations", and one with no account signs up from the link.
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

const WORKSPACE_NAME = "Invite Lab";

/**
 * An owner's workspace and one project in it, made through the API: setup,
 * not the thing under test.
 *
 * @param {object} owner from person()
 * @returns {Promise<{workspaceId: string, projectId: string}>}
 */
async function makeWorkspace(owner) {
  const request = owner.context.request;
  const bootstrap = await (await request.get(`${API}/me/bootstrap`)).json();
  const orgId = bootstrap.result.data.user.organizationId;
  const created = await (
    await request.post(`${API}/organizations/${orgId}/workspaces`, {
      data: { name: WORKSPACE_NAME, timezone: "UTC" },
    })
  ).json();
  assert.equal(created.status, 201, "create the workspace");
  const workspaceId = created.result.data.workspaceId;
  const project = await (
    await request.post(`${API}/workspaces/${workspaceId}/projects`, {
      data: { appId: "affify", name: "Lab project" },
    })
  ).json();
  assert.equal(project.status, 201, "create the project");
  return { workspaceId: workspaceId, projectId: project.result.data.projectId };
}

/**
 * Someone with no account yet: a signed-out browser context of their own.
 *
 * @param {object} run
 * @returns {Promise<{context: object, page: object, errors: string[]}>}
 */
async function signedOutVisitor(run) {
  const context = await run.browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context: context, page: page, errors: errors };
}

/**
 * The token of the newest invitation mailed to an address.
 *
 * @param {string} email
 * @returns {Promise<string>}
 */
async function mailedToken(email) {
  const row = await mail(email, "WORKSPACE_INVITE");
  return row.payload.inviteLink.split("#")[1];
}

/**
 * Open an invitation link on /invite-tester and return what its lookup showed.
 *
 * @param {object} page
 * @param {string} token
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function openLink(page, token) {
  // act() watches the panel, so the page must already have one.
  if (!page.url().startsWith(`${HARNESS}/invite-tester#`)) {
    await page.goto(`${HARNESS}/invite-tester`);
  }
  return act(page, () => page.goto(`${HARNESS}/invite-tester#${token}`));
}

/**
 * Fill the send form and press send.
 *
 * @param {object} page on /invitations
 * @param {object} fields recipients (array), role, access, projectIds, message, key
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function sendThroughForm(page, fields) {
  await page.fill("#send-recipients", fields.recipients.join("\n"));
  await page.selectOption("#send-role", fields.role);
  await page.selectOption("#send-access", fields.access ?? "");
  await page.fill("#send-project-ids", fields.projectIds ?? "");
  await page.fill("#send-message", fields.message ?? "");
  await page.fill("#send-key", fields.key ?? "");
  return act(page, () => page.click("#send-btn"));
}

/**
 * An address's invitation in the workspace table: its details and actions.
 *
 * @param {object} page
 * @param {string} email
 * @returns {object} a locator
 */
function inviteRow(page, email) {
  return page.locator("#invite-rows tbody[data-invite-id]", { hasText: email });
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("invitations");
    const ninaEmail = `${run.prefix}-nina@example.com`;
    const rexEmail = `${run.prefix}-rex@example.com`;

    const owner = await step("sign up the owner", () => person(run, "Olga"));
    const ivan = await step("sign up Ivan, who will be invited", () =>
      person(run, "Ivan"),
    );
    const mia = await step("sign up Mia, who will be invited", () =>
      person(run, "Mia"),
    );
    const visitor = await signedOutVisitor(run);
    const { workspaceId, projectId } = await step(
      "set up a workspace with one project",
      () => makeWorkspace(owner),
    );

    const page = owner.page;
    await step("the owner's /invitations opens on the workspace", async () => {
      await page.goto(`${HARNESS}/invitations`);
      await page
        .locator("#workspace-select option", { hasText: WORKSPACE_NAME })
        .waitFor({ state: "attached" });
      await page
        .locator("#invite-rows", { hasText: "no invitations match" })
        .waitFor();
    });

    await step("preview sorts a batch without sending anything", async () => {
      await page.fill(
        "#send-recipients",
        [ninaEmail, owner.email, "not-an-address"].join("\n"),
      );
      await page.selectOption("#send-role", "EDITOR");
      assertOk(await act(page, () => page.click("#preview-btn")), "preview");
      const outcome = await page.locator("#send-outcome").innerText();
      assert.match(outcome, /nothing was sent/);
      assert.match(outcome, /not-an-address — not an email address/);
      assert.match(outcome, new RegExp(`alreadyMember\\s+${owner.email}`));
      assert.match(outcome, /wouldConsume 1/);
    });

    await step("an OWNER invitation is refused, and says so", async () => {
      const shown = await sendThroughForm(page, {
        recipients: [ninaEmail],
        role: "OWNER",
      });
      assert.equal(shown.status, 400, shown.text);
      assert.match(
        await page.locator("#response-panel .error-line").innerText(),
        /INVALID_REQUEST/,
      );
      assert.match(
        await page.locator("#send-outcome .refusal").innerText(),
        /wsRole must be ADMIN, EDITOR or VIEWER/,
      );
    });

    let ninaInviteId = null;
    await step(
      "send Nina an EDITOR invitation limited to one project, with a message and an Idempotency-Key",
      async () => {
        assertOk(
          await act(page, () => page.click("#list-projects")),
          "list projects",
        );
        await page.click(`[data-add-project="${projectId}"]`);
        assert.equal(await page.inputValue("#send-project-ids"), projectId);
        assert.equal(await page.inputValue("#send-access"), "LIMITED");
        await page.click("#new-key");
        const key = await page.inputValue("#send-key");
        const shown = await sendThroughForm(page, {
          recipients: [ninaEmail],
          role: "EDITOR",
          access: "LIMITED",
          projectIds: projectId,
          message: "Welcome to the lab",
          key: key,
        });
        assert.equal(shown.status, 201, shown.text);
        ninaInviteId = await page
          .locator("#send-outcome tr[data-sent-id]")
          .getAttribute("data-sent-id");
        assert.ok(ninaInviteId, "the sent invitation is listed");
        assert.match(
          await page.locator("#response-panel").innerText(),
          /"Idempotency-Key"/,
        );
        await inviteRow(page, ninaEmail)
          .locator("td", { hasText: projectId })
          .waitFor();
      },
    );

    await step(
      "a retry with the same Idempotency-Key answers the same invitation",
      async () => {
        assert.equal(
          (await act(page, () => page.click("#send-btn"))).status,
          201,
        );
        assert.equal(
          await page
            .locator("#send-outcome tr[data-sent-id]")
            .getAttribute("data-sent-id"),
          ninaInviteId,
        );
      },
    );

    await step(
      "send Ivan, Mia and Rex VIEWER invitations in one batch",
      async () => {
        const shown = await sendThroughForm(page, {
          recipients: [ivan.email, mia.email, rexEmail],
          role: "VIEWER",
        });
        assert.equal(shown.status, 201, shown.text);
        assert.equal(
          await page.locator("#send-outcome tr[data-sent-id]").count(),
          3,
        );
      },
    );

    await step("list all, then expired, then pending", async () => {
      await page.selectOption("#list-status", "all");
      assertOk(
        await act(page, () => page.click("#list-form button[type=submit]")),
        "list all",
      );
      await inviteRow(page, rexEmail).waitFor();
      assert.equal(
        await page.locator("#invite-rows tbody[data-invite-id]").count(),
        4,
      );
      await page.selectOption("#list-status", "expired");
      assertOk(
        await act(page, () => page.click("#list-form button[type=submit]")),
        "list expired",
      );
      await page
        .locator("#invite-rows", { hasText: "no invitations match" })
        .waitFor();
      await page.selectOption("#list-status", "pending");
      assertOk(
        await act(page, () => page.click("#list-form button[type=submit]")),
        "list pending",
      );
      assert.match(
        await page.locator("#invite-counts").innerText(),
        /active 4/,
      );
    });

    let rexToken = null;
    await step(
      "change Rex's role, resend, copy the link and edit the message",
      async () => {
        const rex = inviteRow(page, rexEmail);
        await rex.locator("[data-role-select]").selectOption("EDITOR");
        assertOk(
          await act(page, () => rex.locator('[data-action="role"]').click()),
          "change role",
        );
        await rex.locator(".role-cell", { hasText: "EDITOR" }).waitFor();

        assertOk(
          await act(page, () => rex.locator('[data-action="resend"]').click()),
          "resend",
        );
        await rex.locator(".resends", { hasText: "1" }).waitFor();

        assertOk(
          await act(page, () => rex.locator('[data-action="link"]').click()),
          "copy link",
        );
        const href = await page.locator("#revealed-open").getAttribute("href");
        rexToken = href.split("#")[1];
        assert.ok(rexToken, "the copied link carries a token");

        await rex.locator('[data-action="edit"]').click();
        assert.equal(
          await page.inputValue("#edit-id"),
          await rex.getAttribute("data-invite-id"),
        );
        const empty = await act(page, () =>
          page.click("#edit-form button[type=submit]"),
        );
        assert.equal(empty.status, 400, `an empty change: ${empty.text}`);
        await page.selectOption("#edit-message-mode", "set");
        await page.fill("#edit-message", "Hello Rex");
        assertOk(
          await act(page, () => page.click("#edit-form button[type=submit]")),
          "edit the message",
        );
      },
    );

    await step("revoke Rex, and his copied link is dead", async () => {
      assertOk(
        await act(page, () =>
          inviteRow(page, rexEmail).locator('[data-action="revoke"]').click(),
        ),
        "revoke",
      );
      await inviteRow(page, rexEmail).waitFor({ state: "detached" });
      const shown = await openLink(visitor.page, rexToken);
      assert.equal(shown.status, 409, shown.text);
      assert.match(
        await visitor.page.locator("#lookup-summary .refusal").innerText(),
        /INVITE_REVOKED/,
      );
    });

    const ivanFirstToken = await mailedToken(ivan.email);
    await step(
      "signed out, accepting an existing account's invitation is refused SIGN_IN_REQUIRED",
      async () => {
        assertOk(await openLink(visitor.page, ivanFirstToken), "lookup");
        assert.equal(
          await visitor.page.locator("#summary-signup").innerText(),
          "false",
        );
        const shown = await act(visitor.page, () =>
          visitor.page.click("#accept-btn"),
        );
        assert.equal(shown.status, 401, shown.text);
        assert.match(
          await visitor.page.locator("#outcome .refusal").innerText(),
          /SIGN_IN_REQUIRED/,
        );
      },
    );

    await step("Ivan declines from the link", async () => {
      assertOk(await openLink(ivan.page, ivanFirstToken), "lookup");
      assert.equal(
        await ivan.page.locator("#summary-workspace").innerText(),
        WORKSPACE_NAME,
      );
      assertOk(
        await act(ivan.page, () => ivan.page.click("#decline-btn")),
        "decline",
      );
      assert.match(await ivan.page.locator("#outcome").innerText(), /declined/);
    });

    await step("Mia declines from her invitations", async () => {
      await mia.page.goto(`${HARNESS}/invitations`);
      const row = mia.page.locator("#my-invites tr", {
        hasText: WORKSPACE_NAME,
      });
      await row.waitFor();
      assertOk(
        await act(mia.page, () => row.locator('[data-mine="decline"]').click()),
        "decline mine",
      );
      await mia.page
        .locator("#my-invites", { hasText: "no invitations wait" })
        .waitFor();
    });

    await step("the owner invites Ivan and Mia again", async () => {
      const shown = await sendThroughForm(page, {
        recipients: [ivan.email, mia.email],
        role: "VIEWER",
      });
      assert.equal(shown.status, 201, shown.text);
    });

    await step("Ivan, signed in, accepts the new link", async () => {
      const token = await mailedToken(ivan.email);
      assert.notEqual(token, ivanFirstToken);
      assertOk(await openLink(ivan.page, token), "lookup");
      assertOk(
        await act(ivan.page, () => ivan.page.click("#accept-btn")),
        "accept",
      );
      assert.match(
        await ivan.page.locator("#outcome").innerText(),
        new RegExp(`joined workspace\\s+${workspaceId}\\s+as\\s+VIEWER`),
      );
    });

    await step(
      "Mia accepts from her invitations, and the picker gains it",
      async () => {
        assertOk(
          await act(mia.page, () => mia.page.click("#load-mine")),
          "reload mine",
        );
        const row = mia.page.locator("#my-invites tr", {
          hasText: WORKSPACE_NAME,
        });
        assertOk(
          await act(mia.page, () =>
            row.locator('[data-mine="accept"]').click(),
          ),
          "accept mine",
        );
        await mia.page
          .locator("#workspace-select option", { hasText: WORKSPACE_NAME })
          .waitFor({ state: "attached" });
      },
    );

    await step(
      "Nina, with no account, signs up from the link and lands signed in",
      async () => {
        assertOk(
          await openLink(visitor.page, await mailedToken(ninaEmail)),
          "lookup",
        );
        assert.equal(
          await visitor.page.locator("#summary-signup").innerText(),
          "true",
        );
        await visitor.page.fill("#signup-first", "Nina");
        await visitor.page.fill("#signup-last", "Newcomer");
        await visitor.page.fill("#signup-password", PASSWORD);
        assertOk(
          await act(visitor.page, () =>
            visitor.page.click("#signup-form button[type=submit]"),
          ),
          "accept as a new account",
        );
        assert.match(
          await visitor.page.locator("#outcome").innerText(),
          /as\s+EDITOR/,
        );
        await visitor.page
          .locator("#identity strong", { hasText: ninaEmail })
          .waitFor();
        const reach = await (
          await visitor.context.request.get(
            `${API}/workspaces/${workspaceId}/me/capabilities`,
          )
        ).json();
        assert.deepEqual(
          reach.result.data.reachableProjectIds,
          [projectId],
          "the invitation's project limit carried over",
        );
      },
    );

    await step(
      "nothing is left pending, and the revoke is counted",
      async () => {
        assertOk(
          await act(page, () => page.click("#list-form button[type=submit]")),
          "list pending",
        );
        await page
          .locator("#invite-rows", { hasText: "no invitations match" })
          .waitFor();
        assert.match(
          await page.locator("#invite-counts").innerText(),
          /active 0.*revoked 1/s,
        );
      },
    );

    await step("no page threw", () => {
      assert.deepEqual(owner.errors, []);
      assert.deepEqual(ivan.errors, []);
      assert.deepEqual(mia.errors, []);
      assert.deepEqual(visitor.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
