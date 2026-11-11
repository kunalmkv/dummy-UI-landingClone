// A root handed over to us, walked end to end on the MOCK (ROUTING=mock harness):
// add, the gate, the copy, the switch, the records, archive with its zone file,
// the kept zone, the deleted zone and restore. Each step names the mockCase its
// calls answer through page.route; every other call gets the default case.
// Usage: start `node mock/mock.js` in the chakra-domains backend (:4003) and `npm run start:mock` (:3002), then
//   HARNESS=http://localhost:3002 node e2e/handover.e2e.mjs   # SHOTS=<dir> saves a screenshot per step
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:3002";
const SHOTS = process.env.SHOTS ?? null;
const HOST = "medigap-quotes.com";
const OURS = ["ns-1290.awsdns-33.org", "ns-1827.awsdns-36.co.uk", "ns-387.awsdns-48.com", "ns-911.awsdns-49.net"];
const BANNERS = {
  tombstoned: "Archived. Its zone is kept while your name servers may still point at us; point them elsewhere and we delete it about a week later.",
  pending: "Being deleted: we finish once your domain's name servers no longer point at us (pending DNS release). Restore it to keep it.",
  deleted: "Archived. Its zone was deleted; restoring makes a new one with new name servers.",
};
// "METHOD /path" under /domains (a domain's id as /:id) → the mockCase it answers; unset → the default case.
const pick = {};
const calls = [];
const problems = [];

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("dialog", (dialog) => problems.push(`unexpected native dialog: ${dialog.message()}`));
// The envelope's status, not only HTTP's: the mock answers an unknown mockCase in the body.
// The sign-in page's own "signed in?" probe answers 401 by design, so only the walk's calls count.
let walking = false;
page.on("response", async (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith("/api/")) {
    const walk = walking;
    const body = await response.json().catch(() => null);
    calls.push({ method: response.request().method(), path: url.pathname.slice(4) + url.search, http: response.status(), status: body?.status ?? null, walk: walk });
  }
});
const ok = (status) => status >= 200 && status < 300;

await page.route(/\/api\/workspaces\/[^/]+\/domains(\/[^?]*)?(\?.*)?$/, (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/domains/, "").replace(/^\/[0-9a-f]{24}/, "/:id") || "/";
  const label = pick[`${route.request().method()} ${path}`];
  if (label) {
    url.searchParams.set("mockCase", label);
  }
  return route.continue({ url: url.toString() });
});

const squash = (text) => text.replace(/\s+/g, " ").trim();
const textOf = async (selector) => squash(await page.locator(selector).first().innerText());
const textsOf = async (selector) => (await page.locator(selector).allInnerTexts()).map(squash);
const count = (selector) => page.locator(selector).count();
const toast = (text) => page.locator(".toast").filter({ hasText: text }).first().waitFor({ timeout: 10000 });
const waitText = (selector, re) => page.waitForFunction(([css, source]) => new RegExp(source).test(document.querySelector(css)?.innerText ?? ""), [selector, re.source], { timeout: 15000 });
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(200); await page.screenshot({ path: `${SHOTS}/handover-${name}.png`, fullPage: true }); } };
async function step(name, fn) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (error) { const why = String(error.message).split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 300); console.log(`  ✖ ${name} — ${why}`); problems.push(`step "${name}": ${why}`); await shot(`fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`); }
}
async function clearToasts() {
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((node) => node.remove()));
}
/** The domain page read again, as the next stage answers it. */
async function reread(label) {
  pick["GET /:id"] = label;
  await page.reload();
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
}
async function menuItem(label) {
  await page.locator("[data-more]").click();
  await page.locator(".popover .menu-item").filter({ hasText: label }).first().click();
}
async function download(trigger) {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), trigger()]);
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
}
function assertZoneFile(file) {
  assert.equal(file.name, `${HOST}.zone`);
  assert.match(file.text, /^; Exported by insidefi: medigap-quotes\.com/);
  assert.match(file.text, /\$ORIGIN medigap-quotes\.com\./);
}
async function assertNamesHidden() {
  assert.equal(await count("[data-name-servers], [data-copy-all-ns], [data-steps]"), 0, "names hidden behind the gate");
}

let workspaceId = null;
let domainId = null;

await step("sign in to the mock", async () => {
  await page.goto(`${HARNESS}/`);
  await page.waitForURL(/#\/signin/);
  await page.fill('[name="email"]', "you@example.com");
  await page.fill('[name="password"]', "anything-goes-here");
  walking = true;
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/(w\/|workspaces|welcome|onboarding)/, { timeout: 20000 });
  if (!/#\/w\//.test(page.url())) {
    await page.goto(`${HARNESS}/#/workspaces`);
    await page.locator("[data-open]").first().click();
    await page.waitForURL(/#\/w\//);
  }
  workspaceId = page.url().match(/#\/w\/([^/?]+)/)[1];
});

await step("add a root: the check reads root-on-the-lane, the add answers added-delegated and opens the domain", async () => {
  await page.goto(`${HARNESS}/#/w/${workspaceId}/domains`);
  await page.locator("[data-add]").click();
  await page.fill('.modal [name="host"]', HOST);
  await page.selectOption('.modal [name="kind"]', "root");
  pick["POST /preflight"] = "root-on-the-lane";
  await page.locator(".modal [data-preflight]").click();
  await waitText(".modal [data-preflight-result]", /Insidefi will host/);
  const words = await textOf(".modal [data-preflight-result]");
  assert.match(words, /Insidefi will host this domain's DNS\. You copy its records, then change its name servers at GoDaddy\.com, LLC\./);
  assert.match(words, /This domain receives email: copy its mail records too/);
  await shot("1-add-check");
  pick["POST /"] = "added-delegated";
  pick["GET /:id"] = "delegated-zone-creating";
  await page.locator(".modal [data-submit]").click();
  await page.waitForURL(/\/domains\/[0-9a-f]{24}$/, { timeout: 15000 });
  domainId = page.url().match(/\/domains\/([0-9a-f]{24})$/)[1];
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
  assert.match(await textOf("h1"), new RegExp(`^${HOST.replace(/\./g, "\\.")}`));
});

await step("delegated-zone-creating: the zone being created, every blocker, no names", async () => {
  assert.equal(await textOf("[data-zone]"), "Creating your DNS zone");
  assert.deepEqual(await textsOf("[data-blockers] li"), ["Your DNS zone is being set up", "We haven't checked your domain's registrar and DNSSEC yet", "Copy your existing records first · Copy your records"]);
  assert.equal(await textOf("[data-delegation]"), "Not switched yet: your domain still uses its old name servers.");
  assert.match(await textOf("[data-preflight-panel]"), /not checked yet/);
  assert.equal(await count("[data-zone-link]"), 0, "no records link before the zone exists");
  await assertNamesHidden();
  await shot("2-zone-creating");
});

await step("delegated-gated: the zone ready, the blockers and Copy your records, still no names", async () => {
  await reread("delegated-gated");
  assert.equal(await textOf("[data-zone]"), "Zone ready");
  assert.deepEqual(await textsOf("[data-blockers] li"), ["We haven't checked your domain's registrar and DNSSEC yet", "Copy your existing records first · Copy your records"]);
  assert.equal(await textOf("[data-import-link]"), "Copy your records");
  await assertNamesHidden();
  await shot("3-gated");
});

await step("import review: the copy under review, three rows blocking, confirm shut", async () => {
  pick["GET /:id/import"] = "review";
  await page.locator("[data-import-link]").click();
  await page.waitForURL(/\/import$/);
  await page.locator("[data-review]").waitFor({ timeout: 20000 });
  assert.equal(await textOf("h1"), `Copy your records — ${HOST}`);
  assert.match(await textOf("[data-migration]"), /Under review/);
  assert.equal(await count("[data-review] tbody tr"), 14);
  assert.match(await textOf("[data-gate-blocking]"), /^3 rows to leave out or fix:/);
  assert.equal(await page.locator("[data-confirm]").isDisabled(), true);
  await shot("4-import-review");
});

await step("scan scanned: the scanned rows; the scan-only OK opens the gate", async () => {
  await clearToasts();
  pick["POST /:id/import/scan"] = "scanned";
  await page.locator("[data-scan]").click();
  await toast("Scanned your current DNS");
  assert.equal(await count("[data-review] tbody tr"), 8);
  assert.match(await textOf("[data-scan-summary]"), /: 8 record sets found · 312 names asked/);
  assert.equal(await page.locator("[data-confirm]").isDisabled(), true);
  await page.locator('[data-ack-gate="scan-only"]').check();
  await toast("Saved");
  await page.locator("[data-confirm]:not([disabled])").waitFor();
  assert.equal(await textOf("[data-gate-open]"), "Nothing stops the copy.");
  assert.match(await textOf("[data-confirm]"), /Copy 9 record sets/);
});

await step("confirm verifying: the copy is checked at our four name servers", async () => {
  await clearToasts();
  pick["POST /:id/import/confirm"] = "verifying";
  pick["GET /:id/import"] = "verifying";
  await page.locator("[data-confirm]").click();
  await toast("Copying your records");
  await page.locator("[data-verify]").waitFor();
  assert.match(await textOf("[data-verify]"), /Copied 9 record sets\. Checking them at our four name servers…/);
  assert.match(await textOf("[data-migration]"), /Copied: we're checking them at our four name servers\./);
  assert.equal(await count("[data-review], [data-gate], [data-scan-card]"), 0);
  await shot("5-import-verifying");
});

await step("back on the domain (delegated-import-verifying): the check line, still no names", async () => {
  pick["GET /:id"] = "delegated-import-verifying";
  await page.locator(`.page-head a[href="#/w/${workspaceId}/domains/${domainId}"]`).click();
  await page.waitForURL(new RegExp(`/domains/${domainId}$`));
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
  assert.match(await textOf("[data-blockers]"), /Checking your copied records at our name servers · See the check/);
  await assertNamesHidden();
});

await step("Check now → delegated-ns-ready: the GoDaddy steps and our four names to copy", async () => {
  await clearToasts();
  pick["GET /:id"] = "delegated-ns-ready";
  await page.locator("[data-check]").click();
  await toast("Checked:");
  await page.locator("[data-steps]").waitFor();
  const steps = await textOf("[data-steps]");
  assert.match(steps, /At GoDaddy, open Domain Portfolio → the domain → DNS → Nameservers/);
  assert.match(steps, /Enter all four name servers below, exactly as shown, and remove every other one\./);
  assert.deepEqual(await page.locator("[data-copy-ns]").evaluateAll((buttons) => buttons.map((one) => one.dataset.copyNs)), OURS);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.locator("[data-copy-all-ns]").click();
  await toast("Copied to clipboard");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), OURS.join("\n"));
  assert.equal(await textOf("[data-before-switch]"), "CNAME go → cname.insidefi.co (TTL auto)");
  assert.match(await textOf("[data-delegation]"), /^Not switched yet/);
  assert.equal(await count("[data-blockers]"), 0);
  await shot("6-ns-ready");
});

await step("Check now → delegated-live: switched, the steps gone, the names kept, the DNS records link", async () => {
  await clearToasts();
  pick["GET /:id"] = "delegated-live";
  await page.locator("[data-check]").click();
  await toast("Checked:");
  await waitText("[data-delegation]", /^Switched/);
  assert.equal(await textOf("[data-delegation]"), "Switched: your domain uses our name servers.");
  assert.equal(await count("[data-steps], [data-before-switch]"), 0);
  assert.deepEqual(await page.locator("[data-copy-ns]").evaluateAll((buttons) => buttons.map((one) => one.dataset.copyNs)), OURS);
  await page.locator("[data-health]").filter({ hasText: "Healthy" }).waitFor();
  assert.equal(await textOf("[data-zone-link]"), "DNS records");
  await shot("7-live");
});

await step("the records page: the live zone, its locks and history; back to the domain", async () => {
  await page.locator("[data-zone-link]").click();
  await page.waitForURL(/\/zone$/);
  await page.locator("[data-edit-status]").waitFor({ timeout: 20000 });
  assert.equal(await textOf("h1"), `DNS records — ${HOST}`);
  assert.equal(await textOf("[data-edit-status]"), "Changes go live at our name servers at once");
  assert.equal(await count("[data-records] tbody tr"), 12);
  assert.equal(await page.locator(`[data-record="go.${HOST} CNAME"] [data-lock]`).getAttribute("data-lock"), "chakra");
  assert.equal(await count("[data-history]"), 1);
  await shot("8-records");
  await page.locator("[data-back]").click();
  await page.waitForURL(new RegExp(`/domains/${domainId}$`));
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
});

await step("archive delegated-archived: the toast, then delegated-tombstoned's kept-zone banner", async () => {
  await clearToasts();
  pick["POST /:id/archive"] = "delegated-archived";
  pick["GET /:id"] = "delegated-tombstoned";
  await menuItem("Archive");
  await toast(`${HOST} archived; its pages move back to the primary or sandbox`);
  await waitText("[data-banner]", /^Archived/);
  assert.deepEqual(await textsOf("[data-banner]"), [BANNERS.tombstoned]);
  assert.equal(await textOf("[data-zone]"), "Zone kept");
  assert.equal(await textOf("[data-export]"), "Download zone file");
  assert.equal(await count("[data-check], [data-blockers], [data-delegation], [data-zone-link], [data-saved]"), 0);
  await assertNamesHidden();
  await shot("9-tombstoned");
});

await step("the kept zone's file: export live → medigap-quotes.com.zone", async () => {
  pick["GET /:id/zone/export"] = "live";
  assertZoneFile(await download(() => page.locator("[data-export]").click()));
});

await step("delegated-pending-release: the pending DNS release banner, the zone still kept", async () => {
  await reread("delegated-pending-release");
  assert.deepEqual(await textsOf("[data-banner]"), [BANNERS.pending]);
  assert.equal(await textOf("[data-zone]"), "Zone kept");
  assert.equal(await count("[data-export]"), 1);
  await shot("10-pending-release");
});

await step("delegated-zone-deleted: the deleted banner, the file saved at archive and its date", async () => {
  await reread("delegated-zone-deleted");
  assert.deepEqual(await textsOf("[data-banner]"), [BANNERS.deleted]);
  assert.equal(await textOf("[data-zone]"), "Zone deleted");
  const date = await page.evaluate(async () => (await import("/app/lib/ui.js")).shortDate("2026-11-11T10:20:30.000Z"));
  assert.equal(await textOf("[data-saved]"), `saved ${date}`);
  await shot("11-zone-deleted");
});

await step("the deleted zone's file: export snapshot → medigap-quotes.com.zone", async () => {
  pick["GET /:id/zone/export"] = "snapshot";
  assertZoneFile(await download(() => page.locator("[data-export]").click()));
});

await step("restore zone-new: the new-zone toast, a new zone being created", async () => {
  await clearToasts();
  pick["POST /:id/restore"] = "zone-new";
  pick["GET /:id"] = "delegated-zone-creating";
  await menuItem("Restore");
  await toast(`${HOST} restored with a new zone: you will set new name servers.`);
  await waitText("[data-zone]", /^Creating your DNS zone$/);
  assert.equal(await count("[data-banner], [data-export]"), 0);
  await assertNamesHidden();
});

await step("restore zone-kept from the kept zone: its toast, the names held back until our records are checked", async () => {
  await reread("delegated-tombstoned");
  assert.deepEqual(await textsOf("[data-banner]"), [BANNERS.tombstoned]);
  await clearToasts();
  pick["POST /:id/restore"] = "zone-kept";
  pick["GET /:id"] = "delegated-gated";
  await menuItem("Restore");
  await toast(`${HOST} restored; its zone is checked again before its name servers show.`);
  await page.locator("[data-blockers]").waitFor();
  assert.equal(await count("[data-banner], [data-export]"), 0);
  await assertNamesHidden();
  await shot("12-restored-kept");
});

await step("no page errors and no non-2xx answer", async () => {
  await page.waitForTimeout(500);
  const bad = calls.filter((call) => call.walk && (!ok(call.http) || !ok(call.status ?? call.http)));
  assert.deepEqual(bad.map((call) => `${call.method} ${call.path} → HTTP ${call.http}, status ${call.status}`), []);
  assert.deepEqual(problems.filter((problem) => !problem.startsWith("step ")), []);
});

console.log("\nAPI calls:", calls.length);
for (const call of calls) console.log(`  ${call.method} ${call.path} → ${call.status ?? `HTTP ${call.http}`}${call.walk ? "" : " (signed out)"}`);
console.log(`\nproblems: ${problems.length}`); for (const p of problems) console.log("  - " + p);
await browser.close();
process.exit(problems.length ? 1 : 0);
