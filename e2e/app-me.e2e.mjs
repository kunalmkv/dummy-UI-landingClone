// The app's /me screens and the three account-module /auth routes, driven
// through the UI against the HYBRID harness (:3002): built routes answer from the
// real API, the planned ones from the mock. app-coverage.mjs proves every
// /auth and /me route is called; this proves the screens work.
//
//   npm run start:hybrid   (with the mock on :4003)   then   node e2e/app-me.e2e.mjs
import assert from "node:assert/strict";

process.env.HARNESS ??= "http://localhost:3002";
const { HARNESS, PASSWORD, person, startRun, step } = await import("./harness.mjs");

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const envelope = (status, data, error = null) => ({ result: { message: null, data: data, error: error }, status: status });

async function waitText(page, selector, pattern, timeout = 45000) {
  await page.waitForFunction(
    ([css, source]) => new RegExp(source, "i").test(document.querySelector(css)?.innerText ?? ""),
    [selector, pattern.source],
    { timeout: timeout },
  );
}

function watch(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(message.text()) && errors.push(message.text()));
  return errors;
}

/**
 * A route handler that answers with a changed copy of the real answer. A late
 * request (one that arrives while the route is being removed) is let through
 * instead of throwing, which would crash the run.
 */
function reshape(change) {
  return async (route) => {
    try {
      const body = await (await route.fetch()).json();
      change(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    } catch {
      await route.continue().catch(() => {});
    }
  };
}

/** The next request matching a URL part (and a body part), started before the action that sends it. */
const requestTo = (page, urlPart, bodyPart = "") => page.waitForRequest((request) => request.url().includes(urlPart) && (request.postData() ?? "").includes(bodyPart), { timeout: 30000 });

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("appme");
    const mae = await person(run, "Mae");
    const page = mae.page;
    const errors = watch(page);
    const uploads = [];
    page.on("request", (request) => request.url().includes("uploads.example.com") && uploads.push(request.url()));

    // ── the account bell, before any workspace is open ───────────────

    await step("the account bell shows unread count and opens a row on its screen", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.locator("[data-account-bell]:not(.hidden)").waitFor();
      await waitText(page, "[data-account-bell-dot]", /\d/);
      await page.locator("[data-account-bell]").click();
      await waitText(page, ".notif-panel", /Your account export is ready/);
      await page.locator(".notif-panel [data-note]", { hasText: "account export is ready" }).click();
      await page.waitForURL(/#\/account\/privacy/);
      await page.getByRole("heading", { name: "Terms of service" }).waitFor();
    });

    await step("mark all read sends {all: true}", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.locator("[data-account-bell]:not(.hidden)").waitFor();
      await page.locator("[data-account-bell]").click();
      const sent = requestTo(page, "/api/me/notifications/read", '"all":true');
      await page.locator(".notif-panel [data-read-all]").click();
      await sent;
    });

    // ── the search palette ───────────────────────────────────────────

    await step("Ctrl+K opens the search, which finds a command and opens it", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.locator("[data-search-open]").waitFor();
      await page.keyboard.press("Control+k");
      await page.getByRole("heading", { name: "Search" }).waitFor();
      const sent = requestTo(page, "/api/me/search");
      await page.fill("[data-q]", "ac");
      assert.match((await sent).url(), /q=ac/);
      await page.locator('.search-group .menu-item', { hasText: "Account settings" }).click();
      await page.waitForURL(/#\/account\/profile/);
    });

    // ── profile, photo and email ─────────────────────────────────────

    await step("profile: saving sends the name, time zone and language", async () => {
      await page.fill('#profile-form [name="firstName"]', "Maya");
      const sent = requestTo(page, "/api/me/profile", '"firstName":"Maya"');
      await page.getByRole("button", { name: "Save changes" }).click();
      const request = await sent;
      assert.ok(request.postData().includes('"timezone"') && request.postData().includes('"locale"'));
      await waitText(page, ".toast", /Profile saved/);
    });

    await step("photo: a wrong type is refused here, a PNG is minted and committed, and the sample URL is not uploaded to", async () => {
      await page.goto(`${HARNESS}/#/account/profile`);
      await page.locator("[data-photo]").waitFor();
      await page.setInputFiles("[data-photo]", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
      await waitText(page, "#photo-note", /isn't allowed/);
      const minted = requestTo(page, "/api/me/avatar/upload-url", '"contentType":"image/png"');
      const committed = requestTo(page, "/api/me/avatar/commit", '"assetId"');
      await page.setInputFiles("[data-photo]", { name: "me.png", mimeType: "image/png", buffer: PNG });
      await minted;
      await committed;
      await waitText(page, ".toast", /Photo saved/);
      assert.deepEqual(uploads, [], "the mock's sample upload URL is not called");
    });

    await step("photo: remove sends DELETE /me/avatar", async () => {
      // The real profile has no photo, so show the Remove button by giving it one.
      await page.route("**/api/auth/profile/get", reshape((body) => (body.result.data.user.avatarUrl = "https://cdn.example.com/avatars/me.png")));
      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.goto(`${HARNESS}/#/account/profile`);
      await page.locator("[data-remove-photo]:not([disabled])").waitFor();
      const sent = page.waitForRequest((request) => request.method() === "DELETE" && request.url().includes("/api/me/avatar"));
      await page.locator("[data-remove-photo]").click();
      await sent;
      await waitText(page, ".toast", /Photo removed/);
      await page.unroute("**/api/auth/profile/get");
    });

    await step("email change: the request asks for the password, and a token confirms it", async () => {
      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.goto(`${HARNESS}/#/account/profile`);
      await page.fill('#email-form [name="newEmail"]', `${run.prefix}-newaddress@example.com`);
      await page.fill('#email-form [name="currentPassword"]', PASSWORD);
      const sent = requestTo(page, "/api/auth/email/change-request", '"newEmail"');
      await page.getByRole("button", { name: "Send the confirmation link" }).click();
      await sent;
      await waitText(page, "#email-note", /We sent a link/);
      await page.locator("#email-note a", { hasText: "paste its token" }).click();
      await page.waitForURL(/#\/confirm-email/);
      await page.fill('#token-form [name="token"]', "a-token-from-the-mail");
      const confirmed = requestTo(page, "/api/auth/email/change-confirm", "a-token-from-the-mail");
      await page.getByRole("button", { name: "Confirm" }).click();
      await confirmed;
      await page.getByRole("heading", { name: "Email changed" }).waitFor();
    });

    // ── sessions: sign out all the others ────────────────────────────

    await step("sessions: \"Sign out all other sessions\" keeps this one", async () => {
      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.locator("[data-others]").click();
      const sent = requestTo(page, "/api/auth/session/revoke-others");
      await page.locator(".modal [data-yes]").click();
      await sent;
      await waitText(page, ".toast", /Signed out 2 other sessions/);
      await page.locator("tr[data-session]").first().waitFor();
    });

    // ── security activity ────────────────────────────────────────────

    await step("security activity lists events, shows refusals, and filters by result", async () => {
      await page.goto(`${HARNESS}/#/account/activity`);
      await page.locator("table.table tbody tr").first().waitFor();
      await waitText(page, "#section", /Refused/);
      const sent = requestTo(page, "/api/me/security/activity");
      await page.selectOption("[data-outcome]", "refused");
      assert.match((await sent).url(), /outcome=refused/);
    });

    // ── preferences ──────────────────────────────────────────────────

    await step("preferences: light and compact are saved, and a person who has them gets them applied", async () => {
      await page.goto(`${HARNESS}/#/account/preferences`);
      await page.locator('[data-segment="appearance"] [data-value="light"]').click();
      await page.locator('[data-segment="density"] [data-value="compact"]').click();
      const sent = requestTo(page, "/api/me/preferences", '"appearance":"light"');
      await page.getByRole("button", { name: "Save preferences" }).click();
      const request = await sent;
      assert.ok(request.postData().includes('"density":"compact"'));
      await waitText(page, ".toast", /Preferences saved/);

      // The mock answers one fixed document, so a person who really has these is stood in for here.
      await page.route("**/api/me/preferences", (route) => (route.request().method() === "GET" ? route.fulfill({ json: envelope(200, { appearance: "light", density: "compact", doNotDisturb: { enabled: false, until: null } }) }) : route.fallback()));
      await page.goto(`${HARNESS}/#/account/sessions`);
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.appearance === "light" && document.body.classList.contains("density-compact"), null, { timeout: 30000 });
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const channels = background.match(/\d+/g).map(Number);
      assert.ok(channels[0] > 200 && channels[1] > 200 && channels[2] > 200, `a light page, got ${background}`);
      await page.unroute("**/api/me/preferences");
    });

    // ── notifications ────────────────────────────────────────────────

    await step("notifications: the account list reads and marks rows, and the matrix is saved whole", async () => {
      await page.goto(`${HARNESS}/#/account/notifications`);
      await page.locator("#bell-card [data-note]").first().waitFor();
      await page.locator("#matrix-card [data-category]").first().waitFor();
      assert.equal(await page.locator("#matrix-card [data-category]").count(), 8);
      assert.equal(await page.locator('[data-category="security"] [name="email"]').isDisabled(), true);
      await page.selectOption('[data-category="leads"] [name="digest"]', "weekly");
      const sent = requestTo(page, "/api/me/notification-preferences", '"digest":"weekly"');
      await page.locator("#matrix-form").getByRole("button", { name: "Save preferences" }).click();
      const request = await sent;
      assert.ok(request.postData().includes('"quietHours"') && request.postData().includes('"locked":true'));
      await waitText(page, ".toast", /Notification preferences saved/);
      const read = requestTo(page, "/api/me/notifications/read", '"ids"');
      await page.locator("#bell-card [data-read-all]").waitFor();
      await page.locator("#bell-card [data-note].unread").first().click();
      await read;
    });

    // ── terms, export, closing the account ───────────────────────────

    await step("terms are accepted, and an export is queued", async () => {
      await page.goto(`${HARNESS}/#/account/privacy`);
      await page.getByRole("button", { name: "Accept these terms" }).click();
      await page.locator("[data-terms-done]").waitFor();
      await page.locator("[data-export]").click();
      await waitText(page, "[data-export-done]", /Export queued \(job /);
    });

    await step("closing the account: it asks for the password, shows the 30 days, and can be cancelled", async () => {
      await page.getByRole("button", { name: "Close account…" }).click();
      await page.fill('.modal [name="currentPassword"]', PASSWORD);
      const sent = requestTo(page, "/api/me/delete-request", '"currentPassword"');
      await page.locator(".modal [data-submit]").click();
      await sent;
      await waitText(page, "#delete-card", /Closing on/);
      const cancelled = requestTo(page, "/api/me/delete-cancel");
      await page.locator("#delete-card [data-cancel-close]").click();
      await cancelled;
      await waitText(page, ".toast", /stays open/);
    });

    await step("closing the account while the only owner points at the workspaces to hand over", async () => {
      await page.route("**/api/me/delete-request", (route) =>
        route.fulfill({ json: envelope(409, null, { code: "SOLE_OWNER", message: "transfer these workspaces first", details: { workspaces: [{ workspaceId: "66f1c3a25a2b4c0012ab5678", name: "Mae Lab", transferHref: "/w" }] } }) }),
      );
      await page.getByRole("button", { name: "Close account…" }).click();
      await page.fill('.modal [name="currentPassword"]', PASSWORD);
      await page.locator(".modal [data-submit]").click();
      await page.locator("[data-sole-owner]").waitFor();
      assert.match(await page.locator("[data-transfer-link]").getAttribute("href"), /#\/w\/66f1c3a25a2b4c0012ab5678\/settings\/danger/);
      await page.unroute("**/api/me/delete-request");
      await page.keyboard.press("Escape");
    });

    // ── the switcher reads /me/workspaces ────────────────────────────

    await step("the workspace switcher reads /me/workspaces", async () => {
      await page.goto(`${HARNESS}/`);
      await page.waitForURL(/#\/welcome/);
      await page.fill('#welcome-create [name="name"]', "Mae Lab");
      await page.fill('#welcome-create [name="slug"]', `maelab-${run.prefix.slice(-10)}`.toLowerCase());
      await waitText(page, "#welcome-slug-state", /Available/);
      await page.getByRole("button", { name: "Create workspace" }).click();
      await page.waitForURL(/#\/onboarding/);
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.waitForURL(/#\/w\/[0-9a-f]{24}$/);
      await page.locator("[data-switcher]").waitFor();
      const read = requestTo(page, "/api/me/workspaces");
      await page.locator("[data-switcher]").click();
      await read;
      await waitText(page, ".popover", /Mae Lab/);
      await page.keyboard.press("Escape");
    });

    // ── an API without the planned routes says so ────────────────────

    await step("on the live-only harness the planned routes explain themselves and the bell stays hidden", async () => {
      const live = await mae.context.newPage();
      const liveErrors = watch(live);
      await live.goto("http://localhost:3001/#/account/preferences");
      await waitText(live, "#section", /doesn't have that route yet/);
      await live.goto("http://localhost:3001/#/workspaces");
      await live.locator("[data-user-menu]").waitFor();
      assert.equal(await live.locator("[data-account-bell]").evaluate((node) => node.classList.contains("hidden")), true);
      assert.deepEqual(liveErrors, []);
      await live.close();
    });

    await step("no page threw", () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(mae.errors, []);
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
