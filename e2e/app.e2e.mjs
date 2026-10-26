// The workspace app at / — driven only through its UI against the real API:
// sign up, confirm the code, create a workspace, onboard, a project, invite
// three people (one signs up from the mailed link, one joins from the banner
// in their own workspace, one from their welcome screen), settings, the bell.
import assert from "node:assert/strict";

import { API, HARNESS, PASSWORD, mail, person, startRun, step } from "./harness.mjs";

const SHOTS = process.env.SHOTS ?? null;

async function shot(page, name) {
  if (SHOTS) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
}

/** A workspace of the person's own, made through the API: setup, not under test. */
async function ownWorkspace(someone, name) {
  const request = someone.context.request;
  const bootstrap = await (await request.get(`${API}/me/bootstrap`)).json();
  const orgId = bootstrap.result.data.user.organizationId;
  const created = await (await request.post(`${API}/organizations/${orgId}/workspaces`, { data: { name: name, timezone: "UTC" } })).json();
  assert.equal(created.status, 201, `create ${name}`);
  return created.result.data.workspaceId;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wait until the text appears anywhere in the selector. */
async function waitText(page, selector, pattern, timeout = 60000) {
  await page.waitForFunction(
    ([css, source]) => new RegExp(source).test(document.querySelector(css)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: timeout },
  );
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("app");
    const browser = run.browser;
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(message.text()) && errors.push(message.text()));
    const email = `${run.prefix}-una@example.com`;
    // Vic has no account yet: he signs up from the mailed link.
    const vicEmail = `${run.prefix}-vic@example.com`;
    const vicContext = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const vicPage = await vicContext.newPage();
    const vicErrors = [];
    vicPage.on("pageerror", (error) => vicErrors.push(error.message));
    const wes = await step("set up Wes, an existing account with a workspace of his own", async () => {
      const someone = await person(run, "Wes");
      someone.workspaceId = await ownWorkspace(someone, "Wes Shop");
      return someone;
    });
    const yan = await step("set up Yan, an existing account with no workspace", () => person(run, "Yan"));

    await step("a signed-out visit lands on sign in", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/signin/);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      await shot(page, "01-signin");
    });

    await step("create an account, then the code fills itself in", async () => {
      await page.getByRole("link", { name: "Create an account" }).click();
      await page.fill('[name="firstName"]', "Una");
      await page.fill('[name="lastName"]', "Tester");
      await page.fill('[name="organization"]', `Una Org ${run.prefix}`);
      await page.fill('[name="email"]', email);
      await page.fill('[name="password"]', PASSWORD);
      await shot(page, "02-signup");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/#\/verify/);
      await page.waitForFunction(() => document.querySelector('[name="code"]')?.value.length === 6, null, { timeout: 30000 });
      await shot(page, "03-verify");
      await page.getByRole("button", { name: "Verify and continue" }).click();
      await page.waitForURL(/#\/welcome/);
    });

    await step("welcome: create the first workspace", async () => {
      await page.getByRole("heading", { name: /Welcome, Una/ }).waitFor();
      await page.fill('#welcome-create [name="name"]', "Una Studio");
      await page.fill('#welcome-create [name="slug"]', `una-${run.prefix.slice(-10)}`.toLowerCase());
      await waitText(page, "#welcome-slug-state", /Available/);
      await shot(page, "04-welcome");
      await page.getByRole("button", { name: "Create workspace" }).click();
      await page.waitForURL(/#\/onboarding/);
    });

    let workspaceId = null;
    await step("onboarding: pick a starting app, land on home", async () => {
      await page.getByRole("heading", { name: "Where would you like to start?" }).waitFor();
      await shot(page, "05-onboarding");
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.waitForURL(/#\/w\/[0-9a-f]{24}$/);
      workspaceId = page.url().match(/#\/w\/([0-9a-f]{24})/)[1];
      await page.getByRole("heading", { name: /Good (morning|afternoon|evening), Una/ }).waitFor();
      await waitText(page, ".apps", /Affify/);
      await shot(page, "06-home");
    });

    await step("projects: create one from the dialog", async () => {
      await page.locator(".nav a", { hasText: "Projects" }).click();
      await page.waitForURL(/\/projects$/);
      await waitText(page, "[data-list]", /No projects yet/);
      await page.getByRole("button", { name: "New project" }).first().click();
      await page.fill('.modal [name="name"]', "Spring promo");
      await page.fill('.modal [name="vertical"]', "Medicare");
      await shot(page, "07-new-project");
      await page.getByRole("button", { name: "Create project" }).click();
      await waitText(page, "[data-list]", /Spring promo/);
      await shot(page, "08-projects");
    });

    await step("members: invite Vic and Wes as editors on the project with a live seat preview, then Yan as a reader", async () => {
      await page.locator(".nav a", { hasText: "Members" }).click();
      await page.waitForURL(/\/members$/);
      await waitText(page, "[data-seats]", /seats used/);
      await page.getByRole("button", { name: "Invite people" }).click();
      await page.fill('.modal [name="emails"]', `${vicEmail}, ${wes.email}, not-an-address`);
      await waitText(page, ".modal [data-preview]", /Will be invited/);
      await shot(page, "09-invite");
      await page.getByRole("button", { name: /Send invitations/ }).click();
      await waitText(page, "[data-panel]", new RegExp(escapeRegex(wes.email)));
      // A reader is free, so Una + two editors still fit the free plan's three seats.
      await page.getByRole("button", { name: "Invite people" }).click();
      await page.locator('.modal [data-role="READER"]').click();
      await page.fill('.modal [name="emails"]', yan.email);
      await waitText(page, ".modal [data-preview]", /Will be invited/);
      await page.getByRole("button", { name: /Send invitations/ }).click();
      await waitText(page, "[data-panel]", new RegExp(escapeRegex(yan.email)));
      await shot(page, "10-invitations");
    });

    await step("settings: rename with If-Match, roles matrix, billing, tokens", async () => {
      await page.locator(".nav a", { hasText: "Settings" }).click();
      await page.waitForURL(/\/settings\/general$/);
      await page.fill('[data-general] [name="name"]', "Una Studio HQ");
      await page.getByRole("button", { name: "Save changes" }).click();
      await waitText(page, ".switcher", /Una Studio HQ/);
      await shot(page, "11-settings-general");
      await page.getByRole("link", { name: "Roles & permissions" }).click();
      await waitText(page, "#section", /Invite people/);
      assert.ok((await page.locator(".matrix tbody tr:not(.group)").count()) >= 40);
      await shot(page, "12-roles");
      await page.getByRole("link", { name: "Billing & plan" }).click();
      await waitText(page, "#section", /Plans/);
      await shot(page, "13-billing");
      await page.getByRole("link", { name: "API tokens" }).click();
      await page.getByRole("button", { name: "Create token" }).click();
      await page.fill('.modal [name="name"]', "Reporting script");
      await page.locator(".modal").getByRole("button", { name: "Create token" }).click();
      await waitText(page, ".modal .secret", /ifi_/);
      await shot(page, "14-token-secret");
      await page.locator(".modal").getByRole("button", { name: "Done" }).click();
      await waitText(page, "#section", /Reporting script/);
      await page.getByRole("link", { name: "Audit log" }).click();
      await waitText(page, "#section", /audit log/i);
      await shot(page, "15-audit");
      await page.getByRole("link", { name: "Danger zone" }).click();
      await waitText(page, "#section", /Archive workspace/);
      await shot(page, "16-danger");
    });

    await step("Vic opens the mailed link, creates his account, and joins", async () => {
      const token = (await mail(vicEmail, "WORKSPACE_INVITE")).payload.inviteLink.split("#")[1];
      await vicPage.goto(`${HARNESS}/invite#${token}`);
      await vicPage.waitForURL(new RegExp(`#/invite/${token}$`));
      await vicPage.getByRole("heading", { name: /Create your account to join Una Studio/ }).waitFor();
      await shot(vicPage, "17-invite-signed-out");
      await vicPage.getByRole("link", { name: "Create your account" }).click();
      await vicPage.waitForURL(/#\/signup\?invite=/);
      // The address is the invited one and can't be changed.
      const emailField = vicPage.locator('[name="email"]');
      assert.equal(await emailField.inputValue(), vicEmail);
      assert.notEqual(await emailField.getAttribute("readonly"), null);
      await vicPage.fill('[name="firstName"]', "Vic");
      await vicPage.fill('[name="lastName"]', "Tester");
      await vicPage.fill('[name="organization"]', `Vic Org ${run.prefix}`);
      await vicPage.fill('[name="password"]', PASSWORD);
      await vicPage.getByRole("button", { name: "Create account" }).click();
      await vicPage.waitForURL(/#\/verify\?.*invite=/);
      await vicPage.waitForFunction(() => document.querySelector('[name="code"]')?.value.length === 6, null, { timeout: 30000 });
      await vicPage.getByRole("button", { name: "Verify and continue" }).click();
      await vicPage.waitForURL(new RegExp(`#/invite/${token}$`));
      await vicPage.getByRole("heading", { name: /invited you to join Una Studio/ }).waitFor();
      await shot(vicPage, "18-invite-ready");
      await vicPage.getByRole("button", { name: "Join", exact: true }).click();
      await vicPage.waitForURL(new RegExp(`#/w/${workspaceId}$`));
      await waitText(vicPage, ".switcher", /Una Studio HQ/);
    });

    await step("Wes sees the invitation in his own workspace and joins from the banner", async () => {
      await wes.page.goto(`${HARNESS}/#/w/${wes.workspaceId}`);
      await waitText(wes.page, "#invite-banner", /Una Studio/);
      await wes.page.locator("[data-switcher]").click();
      await waitText(wes.page, ".popover [data-all]", /All workspaces\s*1/);
      await wes.page.keyboard.press("Escape");
      await shot(wes.page, "19-invite-banner");
      await wes.page.locator("#invite-banner").getByRole("button", { name: "Join", exact: true }).click();
      await wes.page.waitForURL(new RegExp(`#/w/${workspaceId}$`));
      await waitText(wes.page, ".switcher", /Una Studio HQ/);
    });

    await step("Yan joins from the welcome screen's invitation", async () => {
      await yan.page.goto(`${HARNESS}/`);
      await yan.page.waitForURL(/#\/welcome/);
      await waitText(yan.page, "#welcome-invites", /Una Studio/);
      await shot(yan.page, "20-invited-welcome");
      await yan.page.getByRole("button", { name: "Join" }).click();
      await yan.page.waitForURL(/#\/w\/[0-9a-f]{24}$/);
      await waitText(yan.page, ".switcher", /Una Studio HQ/);
    });

    await step("Una's bell shows that Vic joined", async () => {
      await page.goto(`${HARNESS}/#/w/${workspaceId}`);
      await page.waitForFunction(() => !document.querySelector("[data-bell-dot]")?.classList.contains("hidden"), null, { timeout: 30000 });
      await page.locator("[data-bell]").click();
      await waitText(page, ".notif-panel", /joined/);
      await shot(page, "21-notifications");
      await page.keyboard.press("Escape");
    });

    await step("the switcher, then sign out", async () => {
      await page.locator("[data-switcher]").click();
      await page.waitForSelector(".popover [data-find]");
      await shot(page, "22-switcher");
      await page.keyboard.press("Escape");
      await page.locator("[data-user]").click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL(/#\/signin/);
    });

    await step("no page threw", () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(vicErrors, []);
      assert.deepEqual(wes.errors, []);
      assert.deepEqual(yan.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
