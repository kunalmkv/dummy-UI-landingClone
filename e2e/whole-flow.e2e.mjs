// One journey through the pages, the way someone integrating the frontend
// would walk it: an owner signs up, builds a workspace, brings two people in,
// runs it, hands it over; the new owner archives and restores it; one leaves.
//
// Owner and Newcomer start with no account, so everything they do goes
// through the pages. Joiner is an existing account (person()).
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

const WORKSPACE_NAME = "Journey Lab";
const RENAMED = "Journey Lab HQ";

// --- page helpers ---------------------------------------------------------

/**
 * act(), with the panel emptied first: an answer can render exactly like the
 * one before it, and would otherwise never count as a change.
 *
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function press(page, action) {
  await page
    .locator("#response-panel")
    .evaluate((panel) => (panel.innerHTML = ""));
  return act(page, action);
}

function click(page, selector) {
  return press(page, () => page.click(selector));
}

function assertStatus(shown, status, what) {
  assert.equal(shown.status, status, `${what}: the panel showed ${shown.text}`);
}

// textContent, not innerText: the request body sits in a closed <details>.
function panelText(page) {
  return page.locator("#response-panel").textContent();
}

function text(page, selector) {
  return page.locator(selector).innerText();
}

/** The status the panel shows after a page drew it on its own. */
async function panelStatus(page) {
  const shown = await page.locator("#response-panel .status").innerText();
  return { status: Number.parseInt(shown, 10) || null, text: shown };
}

/** Wait until an element's text matches. */
async function waitText(page, selector, pattern) {
  await page.waitForFunction(
    ([target, source]) =>
      new RegExp(source).test(document.querySelector(target)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: 30000 },
  );
}

/**
 * A browser context with no account in it, collecting page errors.
 *
 * @returns {Promise<{context: object, page: object, errors: string[]}>}
 */
async function visitor(run, email) {
  const context = await run.browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context: context, page: page, errors: errors, email: email };
}

/**
 * Open the dev inbox for an address and follow a mailed link, as a person
 * reading their mail would. Leaves the page on wherever the link points.
 * `tester` follows the workspace invite's tester link instead of the app one.
 *
 * @returns {Promise<void>}
 */
async function followMailedLink(page, email, type, linkField, tester = false) {
  // Waits until the mail is queued; the inbox page shows only what is there.
  await mail(email, type);
  await page.goto(`${HARNESS}/inbox`);
  await page.locator("body[data-ready=true]").waitFor();
  await page.fill("#filter-email", email);
  assertOk(await click(page, "#filter-form button[type=submit]"), "inbox");
  const attribute = tester ? "data-tester-link" : "data-link";
  await page
    .locator(`#rows tr[data-type="${type}"] a[${attribute}="${linkField}"]`)
    .first()
    .click();
}

// --- the journey ------------------------------------------------------------

async function ownerSignsUp(owner) {
  const page = owner.page;
  let verifyHref = null;

  await step("1a. Owner registers on the account page", async () => {
    await page.goto(`${HARNESS}/account`);
    await page.locator("#identity", { hasText: "signed out" }).waitFor();
    const form = "#register-form";
    await page.fill("#register-email", owner.email);
    await page.fill(`${form} input[name=password]`, PASSWORD);
    await page.fill(`${form} input[name=firstName]`, "Owen");
    await page.fill(`${form} input[name=lastName]`, "Owner");
    await page.fill(`${form} input[name=organization]`, "Owen Org");
    assertOk(await click(page, `${form} button[type=submit]`), "register");
    verifyHref = await page.locator("#verify-link").getAttribute("href");
    assert.match(verifyHref, /^\/verify-email-tester\?email=/);
  });

  const code = await step(
    "1b. the code is read from the inbox page",
    async () => {
      await mail(owner.email, "VERIFY");
      await page.click('nav a[href="/inbox"]');
      await page.locator("body[data-ready=true]").waitFor();
      await page.fill("#filter-email", owner.email);
      assertOk(await click(page, "#filter-form button[type=submit]"), "inbox");
      const shown = await text(page, '#rows tr[data-type="VERIFY"] .code');
      assert.match(shown, /^\d{6}$/);
      return shown;
    },
  );

  await step("1c. the code verifies the address and signs in", async () => {
    await page.goto(`${HARNESS}${verifyHref}`);
    assert.equal(await page.inputValue("#email"), owner.email);
    const boxes = page.locator("#boxes input");
    for (const [index, digit] of [...code].entries()) {
      await boxes.nth(index).fill(digit);
    }
    assertOk(await click(page, "#code-form button[type=submit]"), "verify");
    assert.match(
      await text(page, "#code-outcome"),
      new RegExp(`verified and signed in as ${owner.email}`),
    );
    await page.locator("#identity strong", { hasText: owner.email }).waitFor();
  });

  await step("1d. Owner signs out, then signs back in", async () => {
    await page.goto(`${HARNESS}/account`);
    await page.locator("#identity strong", { hasText: owner.email }).waitFor();
    assertOk(await click(page, "#logout-btn"), "sign out");
    assert.match(await text(page, "#session-outcome"), /signed out/);
    await page.locator("#identity", { hasText: "signed out" }).waitFor();
    await page.fill("#login-email", owner.email);
    await page.fill("#login-form input[name=password]", PASSWORD);
    assertOk(await click(page, "#login-form button[type=submit]"), "sign in");
    assert.match(
      await text(page, "#login-outcome"),
      new RegExp(`signed in as ${owner.email}`),
    );
    await page.locator("#identity strong", { hasText: owner.email }).waitFor();
  });
}

async function ownerCreatesWorkspace(owner) {
  const page = owner.page;
  const slug = `journey-${Date.now().toString(36)}`;

  await step("2a. organizations lists Owner's own organization", async () => {
    await page.goto(`${HARNESS}/organization`);
    await page.locator("#org-details table").waitFor();
    assert.equal((await panelStatus(page)).status, 200);
    const rows = page.locator("#orgs tbody tr");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.innerText(), /Owen Org[\s\S]*OWNER/);
    assert.match(await text(page, "#workspace-picker"), /no workspace yet/);
  });

  return step(
    "2b. the slug is checked, then the workspace created",
    async () => {
      await page.fill("#ws-slug", slug);
      assertOk(await click(page, "#check-slug"), "slug check");
      assert.match(await text(page, "#slug-answer"), /free/);
      await page.fill(
        "#create-workspace-form input[name=name]",
        WORKSPACE_NAME,
      );
      const shown = await click(
        page,
        "#create-workspace-form button[type=submit]",
      );
      assertStatus(shown, 201, "create the workspace");
      const workspaceId = await page.inputValue("#workspace-select");
      assert.match(await panelText(page), new RegExp(workspaceId));
      assert.match(
        await text(page, "#workspace-select option:checked"),
        new RegExp(`${WORKSPACE_NAME} · OWNER`),
      );
      assert.match(
        await text(page, `#workspaces tr[data-workspace-id="${workspaceId}"]`),
        new RegExp(slug),
      );
      return workspaceId;
    },
  );
}

async function ownerRunsWorkspace(owner) {
  const page = owner.page;

  await step("3a. workspace renames it, sending If-Match", async () => {
    await page.goto(`${HARNESS}/workspace`);
    await page
      .locator("#ws-view strong", { hasText: WORKSPACE_NAME })
      .waitFor();
    assert.equal(await page.inputValue("#if-match"), '"0"');
    await page.fill("#edit-form [name=name]", RENAMED);
    assertOk(await click(page, "#edit-form button[type=submit]"), "rename");
    assert.match(await panelText(page), /"If-Match": "\\"0\\""/);
    assert.match(await text(page, "#ws-view"), new RegExp(RENAMED));
    assert.equal(await text(page, "#ws-version"), "1");
  });

  await step("3b. branding saves a colour and a sender name", async () => {
    assertOk(await click(page, "#load-branding"), "load branding");
    await page.fill("#accent-color", "#0a7cff");
    await page.fill("#branding-form [name=emailSenderName]", "Journey Team");
    assertOk(await click(page, "#branding-form button[type=submit]"), "save");
    assert.match(await panelText(page), /"accentColor": "#0a7cff"/);
    assert.match(await text(page, "#branding-state"), /badge shown/);
  });

  await step("3c. the palette finds Owner by name", async () => {
    await page.fill("#search-q", "Ow");
    assertOk(await click(page, "#search-form button[type=submit]"), "search");
    assert.match(await text(page, "#search-view"), new RegExp(owner.email));
  });

  await step("3d. health reads each connection", async () => {
    assertOk(await click(page, "#load-health"), "health");
    await page.locator("#health-view tr[data-area=webhooks]").waitFor();
  });
}

async function createProject(page, appId, name) {
  await page.selectOption('#create-form select[name="appId"]', appId);
  await page.fill('#create-form input[name="name"]', name);
  const shown = await click(page, '#create-form button[type="submit"]');
  assertStatus(shown, 201, `create ${name}`);
  return page.inputValue("#project-id");
}

async function ownerMakesProjects(owner) {
  const page = owner.page;
  const row = (id) =>
    page.locator(`#projects-table tr[data-project-id="${id}"]`);

  const projectId = await step(
    "4a. projects creates two projects",
    async () => {
      await page.goto(`${HARNESS}/projects`);
      await waitText(page, "#projects-table", /no projects match/);
      assert.equal((await panelStatus(page)).status, 200);
      const spring = await createProject(page, "affify", "Spring leads");
      await createProject(page, "connect", "Summer leads");
      assert.equal(await page.locator("#projects-table tbody tr").count(), 2);
      return spring;
    },
  );

  await step("4b. one project is renamed", async () => {
    assertOk(
      await press(page, () =>
        row(projectId).locator('button[data-action="select"]').click(),
      ),
      "select",
    );
    await page.fill('#change-form input[name="name"]', "Spring leads v2");
    assertOk(await click(page, '#change-form button[type="submit"]'), "rename");
    assert.equal(
      await row(projectId).locator('[data-field="name"]').innerText(),
      "Spring leads v2",
    );
  });
  return projectId;
}

/** Fill the send form and send; project limits are added before this. */
async function sendInvite(page, email) {
  await page.fill("#send-recipients", email);
  await page.selectOption("#send-role", "EDITOR");
  const shown = await click(page, "#send-btn");
  assertStatus(shown, 201, `invite ${email}`);
  assert.equal(await page.locator("#send-outcome tr[data-sent-id]").count(), 1);
}

async function peopleJoin(owner, joiner, newcomer, projectId) {
  const page = owner.page;
  const inviteRow = (email) =>
    page.locator("#invite-rows tbody[data-invite-id]", { hasText: email });

  await step("5a. Owner invites Joiner as an EDITOR", async () => {
    await page.goto(`${HARNESS}/invitations`);
    await page
      .locator("#invite-rows", { hasText: "no invitations match" })
      .waitFor();
    await sendInvite(page, joiner.email);
    await inviteRow(joiner.email).waitFor();
  });

  await step("5b. Owner invites Newcomer, limited to one project", async () => {
    assertOk(await click(page, "#list-projects"), "list projects");
    await page.click(`[data-add-project="${projectId}"]`);
    assert.equal(await page.inputValue("#send-access"), "LIMITED");
    await sendInvite(page, newcomer.email);
    assert.match(
      await panelText(page),
      new RegExp(`"projectIds": \\[\\s*"${projectId}"`),
    );
    await inviteRow(newcomer.email)
      .locator("td", { hasText: projectId })
      .waitFor();
  });

  await step("5c. Joiner accepts from 'my invitations'", async () => {
    const joinerPage = joiner.page;
    await joinerPage.goto(`${HARNESS}/invitations`);
    const row = joinerPage.locator("#my-invites tr", { hasText: RENAMED });
    await row.waitFor();
    assertOk(
      await press(joinerPage, () =>
        row.locator('[data-mine="accept"]').click(),
      ),
      "accept mine",
    );
    await joinerPage
      .locator("#workspace-select option", { hasText: `${RENAMED} · EDITOR` })
      .waitFor({ state: "attached" });
  });

  await step("5d. Newcomer opens the mailed link from the inbox", async () => {
    const newPage = newcomer.page;
    await followMailedLink(
      newPage,
      newcomer.email,
      "WORKSPACE_INVITE",
      "inviteLink",
      true,
    );
    await newPage.waitForURL(`${HARNESS}/invite-tester#*`);
    await newPage.locator("#summary-signup").waitFor();
    assert.equal((await panelStatus(newPage)).status, 200);
    assert.equal(await text(newPage, "#summary-workspace"), RENAMED);
    assert.equal(await text(newPage, "#summary-signup"), "true");
  });

  await step("5e. Newcomer accepts by creating an account", async () => {
    const newPage = newcomer.page;
    await newPage.fill("#signup-first", "Nia");
    await newPage.fill("#signup-last", "Newcomer");
    await newPage.fill("#signup-password", PASSWORD);
    assertOk(
      await click(newPage, "#signup-form button[type=submit]"),
      "accept as a new account",
    );
    assert.match(await text(newPage, "#outcome"), /as\s+EDITOR/);
    await newPage
      .locator("#identity strong", { hasText: newcomer.email })
      .waitFor();
  });
}

async function ownerReadsNotifications(owner) {
  const page = owner.page;
  await step(
    "6. me shows both acceptances unread, then marks them read",
    async () => {
      await page.goto(`${HARNESS}/me`);
      await page
        .locator("#response-panel .badge", { hasText: "GET /me/bootstrap" })
        .waitFor();
      await page.locator("#notifications table").waitFor();
      assert.equal(await text(page, "#bell"), "2 unread");
      await page.selectOption("#notifications-status", "unread");
      assertOk(await click(page, "#first-page"), "unread notifications");
      const unread = page.locator("#notifications tr.unread");
      assert.equal(await unread.count(), 2);
      for (const title of await unread.allInnerTexts()) {
        assert.match(title, new RegExp(`joined ${RENAMED}`));
      }
      assertOk(await click(page, "#mark-all"), "mark all read");
      assert.equal(await text(page, "#bell"), "0 unread");
      assert.equal(await page.locator("#notifications tr.unread").count(), 0);
    },
  );
}

async function ownerManagesMembers(owner, joiner, newcomer) {
  const page = owner.page;
  const rowOf = (email) =>
    page.locator("#members-table tbody tr", { hasText: email });
  const fieldOf = (email, field) =>
    rowOf(email).locator(`[data-field="${field}"]`).innerText();

  await step("7a. members raises Joiner to ADMIN", async () => {
    await page.goto(`${HARNESS}/members`);
    await rowOf(newcomer.email).waitFor();
    assert.equal((await panelStatus(page)).status, 200);
    assert.equal(await page.locator("#members-table tbody tr").count(), 3);
    assert.match(await fieldOf(newcomer.email, "access"), /LIMITED/);
    assertOk(
      await press(page, () =>
        rowOf(joiner.email).locator('button[data-action="select"]').click(),
      ),
      "select Joiner",
    );
    await page.selectOption('#role-form select[name="wsRole"]', "ADMIN");
    assertOk(await click(page, '#role-form button[type="submit"]'), "role");
    assert.equal(await fieldOf(joiner.email, "role"), "ADMIN");
  });

  await step("7b. the removal impact for Newcomer is read", async () => {
    assertOk(
      await press(page, () =>
        rowOf(newcomer.email).locator('button[data-action="impact"]').click(),
      ),
      "impact",
    );
    assert.match(await text(page, "#impact-lines"), /paid seat/);
  });

  await step("7c. Newcomer is suspended, then reactivated", async () => {
    assertOk(
      await press(page, () =>
        rowOf(newcomer.email).locator('button[data-action="suspend"]').click(),
      ),
      "suspend",
    );
    assert.equal(await fieldOf(newcomer.email, "status"), "SUSPENDED");
    assertOk(
      await press(page, () =>
        rowOf(newcomer.email)
          .locator('button[data-action="reactivate"]')
          .click(),
      ),
      "reactivate",
    );
    assert.equal(await fieldOf(newcomer.email, "status"), "ACTIVE");
  });
}

async function ownerUsesToken(owner, workspaceId) {
  const page = owner.page;
  const tryButton = '#try-form button[type="submit"]';

  const secret = await step(
    "8a. tokens mints one; its secret shows once",
    async () => {
      await page.goto(`${HARNESS}/tokens`);
      await page.locator("body[data-ready=true]").waitFor();
      assert.match(await text(page, "#tokens-table"), /no live/);
      await page.fill('#mint-form input[name="name"]', "Journey reader");
      await page.check('#mint-form input[value="reports.read"]');
      const shown = await click(page, '#mint-form button[type="submit"]');
      assertStatus(shown, 201, "mint");
      const minted = await text(page, "#new-secret");
      assert.match(minted, /^ifi_live_/);
      assert.equal(await page.locator("#tokens-table tbody tr").count(), 1);
      assert.ok(!(await text(page, "#tokens-table")).includes(minted));
      return minted;
    },
  );

  await step("8b. the token reads projects as a bearer", async () => {
    assert.equal(await page.inputValue("#try-secret"), secret);
    await page.selectOption('#try-form select[name="route"]', "/projects");
    assertOk(await click(page, tryButton), "bearer");
    assert.match(
      await text(page, "#response-panel .badge"),
      new RegExp(`GET /workspaces/${workspaceId}/projects`),
    );
    assert.match(await panelText(page), /"Authorization": "Bearer ifi_live_/);
  });

  await step("8c. revoked, it is gone and refused", async () => {
    assertOk(
      await press(page, () =>
        page
          .locator('#tokens-table tbody tr button[data-action="revoke"]')
          .click(),
      ),
      "revoke",
    );
    assert.match(await text(page, "#tokens-table"), /no live/);
    await page.fill("#try-secret", secret);
    assertStatus(await click(page, tryButton), 401, "the revoked secret");
  });
}

async function ownerAddsWebhook(owner) {
  const page = owner.page;
  const row = page.locator("#endpoints-table tbody tr");

  await step("9a. webhooks adds an endpoint", async () => {
    await page.goto(`${HARNESS}/webhooks`);
    await page.locator("body[data-ready=true]").waitFor();
    await page.fill(
      '#create-form input[name="url"]',
      "https://example.com/hooks",
    );
    const shown = await click(page, '#create-form button[type="submit"]');
    assertStatus(shown, 201, "create the endpoint");
    assert.match(
      await text(page, '#create-outcome [data-field="secret"]'),
      /^whsec_/,
    );
    assert.equal(await row.count(), 1);
    assert.match(
      await row.locator('[data-field="status"]').innerText(),
      /ACTIVE/,
    );
  });

  await step("9b. a test is sent and its delivery is listed", async () => {
    assertOk(
      await press(page, () =>
        row.locator('button[data-action="test"]').click(),
      ),
      "test",
    );
    assert.match(await text(page, "#test-result"), /test →/);
    const deliveryId = await page.inputValue("#delivery-id");
    assertOk(
      await press(page, () =>
        row.locator('button[data-action="deliveries"]').click(),
      ),
      "deliveries",
    );
    const logRow = page.locator(
      `#deliveries-table tr[data-delivery-id="${deliveryId}"]`,
    );
    assert.match(
      await logRow.locator('[data-field="eventId"]').innerText(),
      /^evt_test_/,
    );
  });
}

// The trail is the audit page's last read: a table, or the refusal.
function auditLoaded(page) {
  return page
    .locator("#events-table table, #events-table .error-line")
    .first()
    .waitFor();
}

async function ownerReadsAudit(owner, workspaceId) {
  const page = owner.page;

  await step(
    "10a. audit shows the trail (plan raised if it hides it)",
    async () => {
      await page.goto(`${HARNESS}/audit`);
      await auditLoaded(page);
      if (await page.locator("#audit-gate").isVisible()) {
        assert.equal((await panelStatus(page)).status, 403);
        // Setup, not under test: the free plan hides the log.
        const response = await owner.context.request.post(
          `${API}/workspaces/${workspaceId}/billing/plan`,
          { data: { planId: "starter" } },
        );
        assert.equal((await response.json()).status, 200, "raise the plan");
        console.log(
          "    (the free plan hid the log: moved to starter through the API)",
        );
        await page.reload();
        await auditLoaded(page);
      }
      assert.ok((await page.locator("#events-table tbody tr").count()) > 0);
      assert.equal((await panelStatus(page)).status, 200);
      assert.equal(await page.locator("#audit-gate").isHidden(), true);
    },
  );

  await step("10b. the trail filters by action", async () => {
    await page.selectOption('#events-form [name="action"]', "project.created");
    assertOk(await click(page, '#events-form button[type="submit"]'), "filter");
    const actions = await page
      .locator('#events-table [data-field="action"]')
      .allInnerTexts();
    assert.deepEqual(actions, ["project.created", "project.created"]);
  });
}

async function ownershipHandedOver(owner, joiner, workspaceId) {
  const page = owner.page;
  const loaded = `body[data-loaded="${workspaceId}"]`;

  await step(
    "11a. Owner confirms the password and offers it to Joiner",
    async () => {
      await page.goto(`${HARNESS}/ownership`);
      await page.locator(loaded).waitFor();
      assert.equal((await panelStatus(page)).status, 200);
      assert.match(await text(page, "#offer-state"), /no open offer/);
      await page.fill("#identity-confirm-password", PASSWORD);
      assertOk(
        await click(page, '#identity-confirm-form button[type="submit"]'),
        "identity confirmation",
      );
      assert.match(await text(page, "#identity-confirm-outcome"), /granted/);
      const joinerId = await page
        .locator("#offer-to option", { hasText: joiner.email })
        .getAttribute("value");
      await page.selectOption("#offer-to", joinerId);
      await page.fill("#offer-confirm", RENAMED);
      assertOk(await click(page, '#offer-form button[type="submit"]'), "offer");
      assert.match(await text(page, "#offer-state"), new RegExp(joiner.email));
      assert.equal(
        await text(page, '#offer-state [data-field="status"]'),
        "PENDING",
      );
    },
  );

  await step("11b. Joiner opens the mailed link and accepts", async () => {
    const joinerPage = joiner.page;
    await followMailedLink(
      joinerPage,
      joiner.email,
      "OWNERSHIP_TRANSFER",
      "transferLink",
    );
    await joinerPage.waitForURL(`${HARNESS}/ownership#*`);
    await joinerPage.locator(loaded).waitFor();
    // As an ADMIN, Joiner may not read the open offer yet.
    assert.equal((await panelStatus(joinerPage)).status, 403);
    assert.notEqual(await joinerPage.inputValue("#accept-token"), "");
    assertOk(
      await click(joinerPage, '#accept-form button[type="submit"]'),
      "accept",
    );
    assert.match(
      await text(joinerPage, "#accept-outcome"),
      /you now own workspace/,
    );
    assertOk(await click(joinerPage, "#workspace-reload"), "reload the list");
    await joinerPage.locator(loaded).waitFor();
    assert.match(
      await text(joinerPage, "#workspace-select option:checked"),
      /OWNER/,
    );
  });

  await step("11c. Owner now sees ADMIN", async () => {
    await page.goto(`${HARNESS}/ownership`);
    await page.locator(loaded).waitFor();
    assert.match(await text(page, "#workspace-select option:checked"), /ADMIN/);
    // An ADMIN may no longer read the offer.
    assert.equal((await panelStatus(page)).status, 403);
    assert.match(
      await text(page, "#capability-line"),
      /no workspace\.transfer/,
    );
  });
}

async function joinerArchivesAndRestores(joiner) {
  const page = joiner.page;

  await step("12a. Joiner confirms the password and archives", async () => {
    await page.goto(`${HARNESS}/workspace`);
    await page.locator("#ws-view strong", { hasText: RENAMED }).waitFor();
    assert.equal((await panelStatus(page)).status, 200);
    await page.fill("#identity-confirm-password", PASSWORD);
    assertOk(await click(page, "#identity-confirm-form button[type=submit]"), "identity confirmation");
    assert.match(
      await text(page, "#identity-confirm-state"),
      /granted for WORKSPACE_ARCHIVE/,
    );
    assertOk(await click(page, "#archive-form button[type=submit]"), "archive");
    assert.match(await panelText(page), /ARCHIVED/);
  });

  await step("12b. the workspace reads as read-only", async () => {
    assertOk(await click(page, "#load-workspace"), "load");
    assert.match(await text(page, "#ws-view"), /read-only/);
  });

  await step("12c. restore makes it writable again", async () => {
    assertOk(await click(page, "#restore"), "restore");
    assert.match(await panelText(page), /"status": "ACTIVE"/);
    assertOk(await click(page, "#load-workspace"), "load");
    assert.doesNotMatch(await text(page, "#ws-view"), /read-only/);
  });
}

async function newcomerLeaves(newcomer) {
  const page = newcomer.page;
  await step("13. Newcomer leaves the workspace on members", async () => {
    await page.goto(`${HARNESS}/members`);
    await page
      .locator("#members-table tbody tr", { hasText: newcomer.email })
      .waitFor();
    assertOk(await click(page, '#leave-form button[type="submit"]'), "leave");
    assert.match(await text(page, "#members-table"), /you left/);
  });
}

(async () => {
  let run = null;
  let failed = false;
  const people = [];
  try {
    run = await startRun("flow");
    const owner = await visitor(run, `${run.prefix}-owner@example.com`);
    const newcomer = await visitor(run, `${run.prefix}-newcomer@example.com`);
    const joiner = await step("Joiner has an account (through the API)", () =>
      person(run, "Joiner"),
    );
    people.push(owner, joiner, newcomer);

    await ownerSignsUp(owner);
    const workspaceId = await ownerCreatesWorkspace(owner);
    await ownerRunsWorkspace(owner);
    const projectId = await ownerMakesProjects(owner);
    await peopleJoin(owner, joiner, newcomer, projectId);
    await ownerReadsNotifications(owner);
    await ownerManagesMembers(owner, joiner, newcomer);
    await ownerUsesToken(owner, workspaceId);
    await ownerAddsWebhook(owner);
    await ownerReadsAudit(owner, workspaceId);
    await ownershipHandedOver(owner, joiner, workspaceId);
    await joinerArchivesAndRestores(joiner);
    await newcomerLeaves(newcomer);

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
