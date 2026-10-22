// The workspace app at / driven against the MOCK (ROUTING=mock harness): every
// screen is opened and every /api answer is recorded, so a mock that the real
// UI cannot use shows up as a list of calls, not a vague "it looks wrong".
// Usage: HARNESS=http://localhost:3002 node e2e/app-mock.e2e.mjs
import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:3002";
const SHOTS = process.env.SHOTS ?? null;
const calls = [];
const problems = [];
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await context.newPage();
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("response", async (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/")) return;
  let status = null, error = null, keys = null;
  try {
    const body = await response.json();
    status = body.status;
    error = body.result?.error ? (typeof body.result.error === "string" ? body.result.error : body.result.error.code) : null;
    keys = body.result?.data && typeof body.result.data === "object" && !Array.isArray(body.result.data) ? Object.keys(body.result.data).slice(0, 12).join(",") : Array.isArray(body.result?.data) ? `[${body.result.data.length}]` : String(body.result?.data);
  } catch { status = `HTTP ${response.status()} ${response.headers()["content-type"]}`; }
  calls.push({ method: response.request().method(), path: url.pathname.slice(4) + url.search, status: status, error: error, keys: keys, upstream: response.headers()["x-harness-upstream"] });
});
const text = async (sel) => ((await page.locator(sel).first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const waitText = (sel, re, timeout = 20000) => page.waitForFunction(([css, src]) => new RegExp(src, "i").test(document.querySelector(css)?.innerText ?? ""), [sel, re.source], { timeout });
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(200); await page.screenshot({ path: `${SHOTS}/mock-${name}.png` }); } };
async function step(name, fn) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (error) { console.log(`  ✖ ${name} — ${String(error.message).split("\n")[0].slice(0, 160)}`); problems.push(`step "${name}": ${String(error.message).split("\n")[0].slice(0, 160)}`); await shot(`fail-${name.replace(/[^a-z0-9]+/gi, "-")}`); }
}
const errorsShown = async () => { const toasts = await page.locator(".toast.error").allInnerTexts(); const forms = await page.locator(".form-error").allInnerTexts(); return [...toasts, ...forms].map((t) => t.replace(/\s+/g, " ").trim()); };

await step("sign-in page", async () => { await page.goto(`${HARNESS}/`); await page.waitForURL(/#\/signin/); await page.getByRole("heading", { name: "Welcome back" }).waitFor(); });
await step("sign in with any credentials (mock)", async () => {
  await page.fill('[name="email"]', "you@example.com"); await page.fill('[name="password"]', "anything-goes-here");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/(w\/|workspaces|welcome|onboarding)/, { timeout: 20000 });
  console.log("    landed on", page.url().replace(HARNESS, ""));
});
await step("home renders workspace, apps, stats", async () => {
  if (!/#\/w\//.test(page.url())) { await page.goto(`${HARNESS}/#/workspaces`); await page.locator("[data-open]").first().click(); }
  await page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }).waitFor();
  await waitText(".apps", /Affify|Journey/); await shot("home");
  const stats = await text(".grid-stats"); if (!/Members/.test(stats)) throw new Error("stats missing");
  console.log("    switcher:", await text(".switcher"));
});
await step("notifications bell", async () => { await page.locator("[data-bell]").click(); await waitText(".notif-panel", /Notifications/); await shot("bell"); await page.keyboard.press("Escape"); });
await step("projects list + new project", async () => {
  await page.locator(".nav a", { hasText: "Projects" }).click(); await page.waitForURL(/\/projects$/);
  await waitText("[data-list]", /Project|No projects/); await shot("projects");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.fill('.modal [name="name"]', "Mock project"); await page.locator(".modal").getByRole("button", { name: "Create project" }).click();
  await page.waitForTimeout(1500); const errs = await errorsShown(); if (errs.length) throw new Error(errs.join(" | "));
});
await step("members, seats, invite preview", async () => {
  await page.locator(".nav a", { hasText: "Members" }).click(); await page.waitForURL(/\/members$/);
  await waitText("[data-panel]", /Member|No members/); await shot("members");
  const seats = await text("[data-seats]"); if (!/seats used/.test(seats)) throw new Error("seat meter missing: " + seats.slice(0, 80));
  await page.getByRole("button", { name: "Invite people" }).click(); await page.fill('.modal [name="emails"]', "teammate@example.com");
  await waitText(".modal [data-preview]", /invited|seat|Not valid/i); await shot("invite");
  await page.getByRole("button", { name: /Send invitations/ }).click(); await page.waitForTimeout(1500);
  const errs = await errorsShown(); if (errs.length) throw new Error(errs.join(" | "));
  await page.locator("[data-tab=invitations]").click(); await waitText("[data-panel]", /@|No pending/);
});
for (const section of ["general", "branding", "roles", "billing", "api-tokens", "webhooks", "audit", "danger"]) {
  await step(`settings/${section}`, async () => {
    await page.goto(`${HARNESS}/#/w/${page.url().match(/#\/w\/([0-9a-f]{24})/)[1]}/settings/${section}`);
    await page.waitForFunction(() => !document.querySelector("#section .skeleton"), null, { timeout: 20000 });
    await page.waitForTimeout(600); await shot(`settings-${section}`);
    const body = await text("#section"); if (/Couldn't load|isn't available/.test(body)) throw new Error(body.slice(0, 160));
  });
}
await step("rename with If-Match", async () => {
  await page.goto(page.url().replace(/settings\/.*$/, "settings/general")); await page.waitForFunction(() => document.querySelector("[data-general] [name=name]"), null, { timeout: 20000 });
  await page.fill('[data-general] [name="name"]', "Renamed on the mock"); await page.getByRole("button", { name: "Save changes" }).click(); await page.waitForTimeout(1500);
  const errs = await errorsShown(); if (errs.length) throw new Error(errs.join(" | "));
});
await step("switcher + all workspaces + create dialog", async () => {
  await page.locator("[data-switcher]").click(); await page.waitForSelector(".popover [data-find]"); await page.locator(".popover [data-all]").click();
  await page.waitForURL(/#\/workspaces/); await waitText(".ws-grid", /./); await shot("picker");
  await page.locator("[data-new]").click(); await page.fill('#create-ws-form [name="name"]', "Another one"); await waitText("#modal-slug-state", /Available|Taken|make one/);
  await page.locator(".modal [data-submit]").click(); await page.waitForTimeout(1500); const errs = await errorsShown(); if (errs.length) throw new Error(errs.join(" | ")); await page.keyboard.press("Escape");
});
await step("sign out, then sign up → verify on the mock", async () => {
  await page.goto(`${HARNESS}/#/workspaces`); await page.locator("[data-user-menu], [data-user]").first().click();
  await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL(/#\/signin/);
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  await page.fill('[name="firstName"]', "Mo"); await page.fill('[name="lastName"]', "Ck"); await page.fill('[name="organization"]', "Mock Org"); await page.fill('[name="email"]', "mo@example.com"); await page.fill('[name="password"]', "a-long-enough-password");
  await page.getByRole("button", { name: "Create account" }).click(); await page.waitForURL(/#\/verify/); await page.fill('[name="code"]', "123456");
  await page.getByRole("button", { name: "Verify and continue" }).click(); await page.waitForTimeout(2000); console.log("    after verify:", page.url().replace(HARNESS, ""));
});

console.log("\nAPI calls:", calls.length);
const bad = calls.filter((c) => typeof c.status !== "number" || c.status >= 400);
console.log(`non-2xx: ${bad.length}`);
for (const c of bad) console.log(`  ${c.method} ${c.path} → ${c.status} ${c.error ?? ""}`);
console.log("\nall calls:");
for (const c of calls) console.log(`  ${c.method} ${c.path} → ${c.status} ${c.error ?? ""} ${c.keys ?? ""}`);
console.log(`\nproblems: ${problems.length}`); for (const p of problems) console.log("  - " + p);
await browser.close();
process.exit(problems.length ? 1 : 0);
