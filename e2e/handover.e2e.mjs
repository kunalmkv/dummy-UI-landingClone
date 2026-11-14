// A root handed over to us, walked end to end on the MOCK (ROUTING=mock harness):
// the add and its refusals, the gate, the instructions, the root's mode and the
// certificate's four steps, the copy and its acknowledgements, the zone editor,
// every other state of design §5.7's table, then archive with its zone file,
// the kept zone, the deleted zone and restore. Each step names the mockCase (or,
// with "!", the mockError) its calls answer through page.route; every other call
// gets the default case. A few states the mock has no case for are the mock's
// own answer changed in flight (`mutate`), always into a shape the API sends.
// Usage: start `node mock/mock.js` in the handover backend (:4003) and `npm run start:mock` (:3002), then
//   HARNESS=http://localhost:3002 node e2e/handover.e2e.mjs   # SHOTS=<dir> saves a screenshot per step
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:3002";
const SHOTS = process.env.SHOTS ?? null;
const HOST = "medigap-quotes.com";
const SERVING = `go.${HOST}`;
const OURS = ["ns-1290.awsdns-33.org", "ns-1827.awsdns-36.co.uk", "ns-387.awsdns-48.com", "ns-911.awsdns-49.net"];
const BANNERS = {
  tombstoned: "Archived. Its zone is kept while your name servers may still point at us; point them elsewhere and we delete it about a week later.",
  pending: "Being deleted: we finish once your domain's name servers no longer point at us (pending DNS release). Restore it to keep it.",
  deleted: "Archived. Its zone was deleted; restoring makes a new one with new name servers.",
};
// "METHOD /path" under /domains (a domain's id as /:id) → the mockCase it answers, "!<ref>" for a mockError; unset → the default case.
const pick = {};
// "METHOD /path" → a change to the answer's JSON before the page sees it.
const mutate = {};
const calls = [];
const problems = [];
const bodies = [];

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("dialog", (dialog) => problems.push(`unexpected native dialog: ${dialog.message()}`));
// What the page sent to a write, in order: the add, the apex, the copy.
page.on("request", (request) => {
  const url = new URL(request.url());
  if (["POST", "PATCH", "PUT"].includes(request.method()) && /\/domains/.test(url.pathname)) {
    bodies.push({ method: request.method(), path: url.pathname.replace(/^.*\/domains/, "").replace(/^\/[0-9a-f]{24}/, "/:id") || "/", body: request.postDataJSON() });
  }
});
// The envelope's status, not only HTTP's: the mock answers an unknown mockCase in the body.
// The sign-in page's own "signed in?" probe answers 401 by design, so only the walk's calls count.
let walking = false;
page.on("response", async (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith("/api/")) {
    const walk = walking;
    const body = await response.json().catch(() => null);
    calls.push({ method: response.request().method(), path: url.pathname.slice(4) + url.search, http: response.status(), status: body?.status ?? null, walk: walk, refused: url.searchParams.has("mockError") });
  }
});
const ok = (status) => status >= 200 && status < 300;

await page.route(/\/api\/workspaces\/[^/]+\/domains(\/[^?]*)?(\?.*)?$/, async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/domains/, "").replace(/^\/[0-9a-f]{24}/, "/:id") || "/";
  const key = `${route.request().method()} ${path}`;
  const label = pick[key];
  if (label?.startsWith("!")) {
    url.searchParams.set("mockError", label.slice(1));
  } else if (label) {
    url.searchParams.set("mockCase", label);
  }
  const change = mutate[key];
  if (!change) {
    return route.continue({ url: url.toString() });
  }
  const response = await route.fetch({ url: url.toString() });
  const json = await response.json();
  change(json.result?.data);
  return route.fulfill({ response, json });
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
/** The certificate card's four steps, as their states in order. */
const certificateSteps = () => page.locator("[data-cert-steps] li").evaluateAll((items) => items.map((item) => item.dataset.state));
/** One call's body from the writes the page sent, newest last. */
const sentTo = (method, path) => bodies.filter((one) => one.method === method && one.path === path).map((one) => one.body);

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

await step("the add's refusals: a subdomain with its fill, a private suffix, a paused lane", async () => {
  await page.goto(`${HARNESS}/#/w/${workspaceId}/domains`);
  await page.locator("[data-add]").click();
  await page.fill('.modal [name="host"]', `go.${HOST}`);
  pick["POST /"] = "!400.3";
  await page.locator(".modal [data-submit]").click();
  await page.locator(".modal [data-refusal]").filter({ hasText: "Add brand.com and pick the go label" }).waitFor();
  await page.locator(".modal [data-fill]").click();
  assert.equal(await page.locator('.modal [name="host"]').inputValue(), "brand.com");
  pick["POST /"] = "!400.4";
  await page.fill('.modal [name="host"]', "brand.github.io");
  await page.locator(".modal [data-submit]").click();
  await page.locator(".modal [data-refusal]").filter({ hasText: "not registered at a registrar" }).waitFor();
  pick["POST /"] = "!503";
  await page.fill('.modal [name="host"]', HOST);
  await page.locator(".modal [data-submit]").click();
  await page.locator(".modal [data-paused]").waitFor();
  assert.equal(await page.locator('.modal [name="host"]').inputValue(), HOST, "the form is kept");
});

await step("add a root: the check reads the registrar, the add sends apexMode and the label, and opens the domain", async () => {
  pick["POST /"] = undefined;
  assert.equal(await count('.modal [name="kind"]'), 0, "no subdomain choice");
  pick["POST /preflight"] = "root-on-the-lane";
  await page.locator(".modal [data-preflight]").click();
  await page.locator(".modal [data-preflight-result]").getByText(/Insidefi will host/).waitFor();
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
  const [added] = sentTo("POST", "/").slice(-1);
  assert.equal(added.apexMode, "keep", "keep is the mode sent");
  assert.equal(added.servingLabel, "go");
  assert.equal(added.host, HOST);
});

await step("delegated-zone-creating: the zone being created, every blocker, no names", async () => {
  assert.equal(await textOf("[data-zone]"), "Creating your DNS zone");
  assert.deepEqual(await textsOf("[data-blockers] li"), ["Your DNS zone is being set up", "We haven't checked your domain's registrar and DNSSEC yet", "Copy your existing records first · Copy your records"]);
  assert.equal(await textOf("[data-delegation]"), "Not switched yet: your domain still uses its old name servers.");
  assert.match(await textOf("[data-preflight-panel]"), /not checked yet/);
  assert.equal(await count("[data-zone-link]"), 0, "no records link before the zone exists");
  assert.equal(await count("[data-records]"), 0, "no records table: the zone holds them");
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
  assert.match(await textOf("[data-apex-note]"), new RegExp(`${HOST} keeps its own records`), "keep: the root's rows are copied as they are");
  await shot("4-import-review");
});

await step("redirect needs apex-replaced before confirm", async () => {
  mutate["GET /:id"] = (data) => { data.apex = { mode: "redirect", chosen: true, status: "pending" }; };
  mutate["GET /:id/import"] = (data) => { data.session.gate = { ...data.session.gate, allowed: false, acknowledgementsMissing: ["apex-replaced"] }; };
  mutate["PATCH /:id/import"] = (data) => { data.session.acknowledged = ["apex-replaced"]; data.session.gate = { ...data.session.gate, allowed: true, blockingKeys: [], unacknowledgedKeys: [], acknowledgementsMissing: ["apex-replaced"] }; };
  await page.reload();
  await page.locator("[data-review]").waitFor({ timeout: 20000 });
  assert.match(await textOf("[data-apex-note]"), new RegExp(`${HOST} redirects to ${SERVING.replace(/\./g, "\\.")}: its address records are not copied`));
  const box = page.locator('[data-gate-ack="apex-replaced"]');
  assert.match(squash(await box.innerText()), new RegExp(`${HOST} answers a site of yours today: I accept that redirecting replaces it`));
  assert.equal(await page.locator("[data-confirm]").isDisabled(), true, "confirm stays shut until it is accepted");
  await box.locator("input").check();
  await toast("Saved");
  assert.deepEqual(sentTo("PATCH", "/:id/import").at(-1), { acknowledged: ["apex-replaced"] });
  await page.locator("[data-confirm]:not([disabled])").waitFor();
  await shot("4b-apex-replaced");
});

await step("a source answering at go needs serving-replaced", async () => {
  mutate["GET /:id/import"] = (data) => { data.session.gate = { ...data.session.gate, allowed: false, acknowledgementsMissing: ["serving-replaced"] }; };
  mutate["PATCH /:id/import"] = (data) => { data.session.acknowledged = ["serving-replaced"]; data.session.gate = { ...data.session.gate, allowed: true, blockingKeys: [], unacknowledgedKeys: [], acknowledgementsMissing: ["serving-replaced"] }; };
  await clearToasts();
  await page.reload();
  await page.locator("[data-review]").waitFor({ timeout: 20000 });
  const box = page.locator('[data-gate-ack="serving-replaced"]');
  assert.match(squash(await box.innerText()), new RegExp(`${SERVING.replace(/\./g, "\\.")} answers today; at the switch it serves your Insidefi pages: I accept that`));
  assert.equal(await page.locator("[data-confirm]").isDisabled(), true);
  await box.locator("input").check();
  await toast("Saved");
  await page.locator("[data-confirm]:not([disabled])").waitFor();
  delete mutate["GET /:id"];
  delete mutate["GET /:id/import"];
  delete mutate["PATCH /:id/import"];
  await shot("4c-serving-replaced");
});

await step("scan scanned: the scanned rows; the scan-only OK opens the gate", async () => {
  await clearToasts();
  await page.reload();
  await page.locator("[data-review]").waitFor({ timeout: 20000 });
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
  assert.match(await textOf("[data-delegation]"), /^Not switched yet/);
  assert.equal(await count("[data-blockers]"), 0);
  await shot("6-ns-ready");
});

await step("beforeSwitch shows only the validation record, to add before the switch", async () => {
  const rows = await textsOf("[data-before-switch] li");
  assert.equal(rows.length, 2, "the root's and the serving host's validation records");
  for (const row of rows) {
    assert.match(row, new RegExp(`^CNAME _[0-9a-f]{32}(\\.go)?\\.${HOST.replace(/\./g, "\\.")} → _[0-9a-f]{32}\\.[a-z0-9]+\\.acm-validations\\.aws`), "a validation CNAME, no TTL");
    assert.doesNotMatch(row, /cname\.insidefi\.co|TTL/, "never the address of the pages");
  }
  assert.match(await textOf("[data-before-switch-note]"), /add (these records|this record) at your current DNS host, so the certificate is ready before you switch/);
  assert.match(await textOf("[data-cache-note]"), /Old answers can stay cached for up to 48 hours/);
  assert.equal(await count("[data-serving-note]"), 0, "nothing answers at the serving host today");
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.locator('[data-copy-before="0"]').click();
  await toast("Copied to clipboard");
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^_[0-9a-f]{32}\.[a-z0-9]+\.acm-validations\.aws$/);
  mutate["GET /:id"] = (data) => { data.handover.cutover.instructions.servingHostNote = "replaces"; };
  await page.reload();
  await page.locator("[data-steps]").waitFor();
  assert.equal(await textOf("[data-serving-note]"), `${SERVING} starts serving your pages at the switch.`);
  delete mutate["GET /:id"];
  await shot("6b-before-switch");
});

await step("keep shows the root's records editable", async () => {
  await reread("delegated-ns-ready");
  assert.equal(await textOf("[data-apex-mode]"), "Kept as it is");
  assert.match(await textOf("[data-apex-text]"), new RegExp(`${HOST} keeps whatever answers there today: its records are yours`));
  assert.equal(await count("[data-apex-status]"), 0, "no redirect to wait for");
  assert.equal(await textOf("[data-root-records]"), "Edit its records");
  assert.match(await page.locator("[data-root-records]").getAttribute("href"), /\/zone$/);
  assert.equal(await textOf('[data-apex-switch="redirect"]'), `Redirect ${HOST} to ${SERVING}`);
  await shot("6c-root-keep");
});

await step("redirect over a site asks for the acknowledgement", async () => {
  await clearToasts();
  pick["PATCH /:id/apex"] = "!409.4";
  await page.locator('[data-apex-switch="redirect"]').click();
  const dialog = page.locator(".modal");
  await dialog.getByText(`${HOST} answers a site of yours today`).waitFor();
  assert.match(squash(await dialog.innerText()), /Redirecting replaces it: visitors of .* land on go\.medigap-quotes\.com instead\./);
  pick["PATCH /:id/apex"] = "apex-redirect";
  pick["GET /:id"] = "delegated-live";
  await dialog.getByRole("button", { name: "Redirect and replace" }).click();
  await toast(`${HOST} now redirects to ${SERVING}`);
  assert.deepEqual(sentTo("PATCH", "/:id/apex"), [{ mode: "redirect" }, { mode: "redirect", acknowledged: true }]);
  await waitText("[data-apex-mode]", /^Redirects to go\.medigap-quotes\.com$/);
  assert.equal(await textOf("[data-apex-status]"), "Redirecting");
  assert.equal(await count("[data-root-records]"), 0, "its address records are ours now");
  assert.equal(await textOf('[data-apex-switch="keep"]'), `Keep ${HOST} as it is`);
  await shot("6d-root-redirect");
});

await step("the certificate card walks the four steps", async () => {
  const steps = {
    "certificate-awaiting-dns": ["todo", "todo", "todo", "todo"],
    // ssl.step is how many steps have happened: the next one is in progress, or is the one that failed.
    "certificate-issuing": ["done", "done", "current", "todo"],
    "certificate-timed-out": ["done", "done", "failed", "todo"],
    // Serving: all four, with a replacement beside it (the mock's plain "active" is the first edge's).
    "certificate-replacing": ["done", "done", "done", "done"],
  };
  for (const [label, expected] of Object.entries(steps)) {
    pick["GET /:id/ssl"] = label;
    await page.reload();
    await page.locator("[data-cert-steps]").waitFor();
    assert.deepEqual(await certificateSteps(), expected, label);
  }
  assert.deepEqual(await textsOf("[data-cert-steps] li").then((rows) => rows.map((row) => row.replace(/^\S+ /, ""))), [
    "Certificate requested from Amazon",
    "Validation records written to the zone",
    "Certificate issued by Amazon",
    "Serving through CloudFront",
  ]);
  assert.equal(await textOf("[data-issuer]"), "Amazon");
  await shot("6e-certificate");
});

await step("a replacement in flight, and one that failed", async () => {
  pick["GET /:id/ssl"] = "certificate-replacing";
  await page.reload();
  await page.locator("[data-replacing]").waitFor();
  assert.match(await textOf("[data-replacing]"), /^Replacing the certificate: a new one is being issued beside this one, which keeps serving\./);
  assert.deepEqual(await certificateSteps(), ["done", "done", "done", "done"], "the serving certificate stays as it was");
  pick["GET /:id/ssl"] = "certificate-replacement-failed";
  await page.reload();
  await page.locator("[data-replacing]").waitFor();
  assert.match(await textOf("[data-replacing]"), /^The replacement failed: A CAA record on your domain blocks Amazon\./);
  assert.match(await textOf("[data-replacing]"), /The certificate in use keeps serving until it ends\./);
  await shot("6f-replacement-failed");
});

await step("Check again replaces Renew, and the failure words name Amazon", async () => {
  await clearToasts();
  assert.equal(await count("[data-renew]"), 0, "no Renew");
  assert.equal(await textOf("[data-recheck]"), "Check again");
  pick["POST /:id/ssl/renew"] = "check-again-on-cloudfront";
  await page.locator("[data-recheck]").click();
  await toast("Checking the certificate again");
  assert.equal(sentTo("POST", "/:id/ssl/renew").length, 1);
  mutate["GET /:id"] = (data) => { data.ssl = { ...data.ssl, status: "failed", failureReason: "held_elsewhere", step: 3 }; };
  await page.reload();
  await page.locator("[data-banner]").filter({ hasText: "still on another CloudFront distribution" }).waitFor();
  delete mutate["GET /:id"];
  delete pick["GET /:id/ssl"];
});

await step("Check now → delegated-live: switched, the steps gone, the names kept, the DNS records link", async () => {
  await clearToasts();
  await reread("delegated-ns-ready");
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

await step("the records page: the live zone, the validation CNAMEs locked, the alias without a TTL, the legend", async () => {
  // The mock's sample zone still holds the first edge's rows: the answer is reshaped into what the API
  // sends a redirecting root today, Amazon's validation CNAMEs and the root's aliases (an alias lists its
  // target as its one value, with no TTL), so the page is tested against the shape it will meet.
  const ENDPOINT = "d111111abcdef8.cloudfront.net";
  mutate["GET /:id/zone/records"] = (data) => {
    data.records = data.records
      .filter((record) => !(record.name === HOST && record.type === "A"))
      .map((record) => (record.name === SERVING && record.type === "CNAME" ? { ...record, values: [ENDPOINT] } : record))
      .concat([
        { name: HOST, type: "A", ttl: null, values: [ENDPOINT], lock: "chakra" },
        { name: HOST, type: "AAAA", ttl: null, values: [ENDPOINT], lock: "chakra" },
        { name: `_c3e1f9a2b4d6e8f0a1b2c3d4e5f6a7b8.${HOST}`, type: "CNAME", ttl: 300, values: ["_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d.xlfgrmvvlj.acm-validations.aws"], lock: "chakra" },
        { name: `_7d2e8f1a3b5c7d9e0f1a2b3c4d5e6f7a.${SERVING}`, type: "CNAME", ttl: 300, values: ["_4b3a2c1d0e9f8a7b6c5d4e3f2a1b0c9d.xlfgrmvvlj.acm-validations.aws"], lock: "chakra" },
      ]);
  };
  await page.locator("[data-zone-link]").click();
  await page.waitForURL(/\/zone$/);
  await page.locator("[data-edit-status]").waitFor({ timeout: 20000 });
  assert.equal(await textOf("h1"), `DNS records — ${HOST}`);
  assert.equal(await textOf("[data-edit-status]"), "Changes go live at our name servers at once");
  assert.equal(await count("[data-records] tbody tr"), 15);
  for (const name of [`_c3e1f9a2b4d6e8f0a1b2c3d4e5f6a7b8.${HOST}`, `_7d2e8f1a3b5c7d9e0f1a2b3c4d5e6f7a.${SERVING}`]) {
    assert.equal(await page.locator(`[data-record="${name} CNAME"] [data-lock]`).getAttribute("data-lock"), "chakra", `${name} is Insidefi's`);
    assert.equal(await count(`[data-record="${name} CNAME"] [data-edit]`), 0, "and cannot be edited");
  }
  assert.equal(await page.locator(`[data-record="${SERVING} CNAME"] [data-lock]`).getAttribute("data-lock"), "chakra");
  const legend = await textOf("[data-lock-legend]");
  assert.match(legend, /the certificate's validation CNAMEs/);
  assert.match(legend, /the root's address aliases while it redirects/);
  for (const type of ["A", "AAAA"]) {
    const alias = page.locator(`[data-record="${HOST} ${type}"]`);
    assert.equal(await alias.locator("[data-lock]").getAttribute("data-lock"), "chakra");
    assert.equal(squash(await alias.locator("[data-alias]").innerText()), `alias → ${ENDPOINT}`, `${type}: the target, and no TTL`);
    assert.equal(await alias.locator("td:nth-child(3)").innerText(), "—", "no TTL on an alias");
  }
  assert.equal(await count(`[data-record="${HOST} MX"] [data-edit]`), 1, "the client's mail records are theirs");
  assert.equal(await count("[data-history]"), 1);
  await shot("8-records");
  await page.locator("[data-back]").click();
  await page.waitForURL(new RegExp(`/domains/${domainId}$`));
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
});

await step("keep's zone: the client's root address is theirs to edit", async () => {
  // A keeping root's address is the client's: the sample's chakra lock on it is the first edge's.
  mutate["GET /:id/zone/records"] = (data) => { data.records = data.records.map((record) => (record.name === HOST && record.type === "A" ? { ...record, lock: "none" } : record)); };
  await page.locator("[data-zone-link]").click();
  await page.waitForURL(/\/zone$/);
  await page.locator("[data-records]").waitFor();
  assert.equal(await page.locator(`[data-record="${HOST} A"] [data-lock]`).getAttribute("data-lock"), "none");
  assert.equal(await count(`[data-record="${HOST} A"] [data-edit]`), 1);
  assert.equal(await count("[data-alias]"), 0);
  delete mutate["GET /:id/zone/records"];
  await page.locator("[data-back]").click();
  await page.waitForURL(new RegExp(`/domains/${domainId}$`));
  await page.locator("[data-handover]").waitFor({ timeout: 20000 });
});

await step("every other state of the switch: DNSSEC on, its countdown, two of four listed, moved away", async () => {
  const states = [
    ["delegated-ds-blocked", () => textOf("[data-delegation]"), /^Not switched yet: DNSSEC is still on for your domain\.$/],
    ["delegated-ds-blocked", () => textOf("[data-blockers]"), /DNSSEC is on: turn it off at GoDaddy\.com, LLC first/],
    ["delegated-ds-countdown", () => textOf("[data-blockers]"), /Old DNSSEC answers expire/],
    ["delegated-two-listed", () => textOf("[data-delegation]"), /^Switched: your domain uses our name servers\. Your registrar lists 2 of our four name servers: that works; add all four if it lets you\.$/],
    ["delegated-moved-away", () => textOf("[data-delegation]"), /^Your domain no longer uses our name servers\. Set them again, or its pages stop within 72 hours\.$/],
  ];
  for (const [label, read, expected] of states) {
    await reread(label);
    assert.match(await read(), expected, label);
  }
  await shot("7b-moved-away");
});

await step("archive delegated-archived: the toast, then delegated-tombstoned's kept-zone banner", async () => {
  await clearToasts();
  await reread("delegated-live");
  pick["POST /:id/archive"] = "delegated-archived";
  pick["GET /:id"] = "delegated-tombstoned";
  await menuItem("Archive");
  await toast(`${HOST} archived; its pages move back to the primary or sandbox`);
  await waitText("[data-banner]", /^Archived/);
  assert.deepEqual(await textsOf("[data-banner]"), [BANNERS.tombstoned]);
  assert.equal(await textOf("[data-zone]"), "Zone kept");
  assert.equal(await textOf("[data-export]"), "Download zone file");
  assert.equal(await count("[data-check], [data-blockers], [data-delegation], [data-zone-link], [data-saved], [data-apex], [data-recheck]"), 0);
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
  const bad = calls.filter((call) => call.walk && !call.refused && (!ok(call.http) || !ok(call.status ?? call.http)));
  assert.deepEqual(bad.map((call) => `${call.method} ${call.path} → HTTP ${call.http}, status ${call.status}`), []);
  assert.deepEqual(problems.filter((problem) => !problem.startsWith("step ")), []);
});

console.log("\nAPI calls:", calls.length);
for (const call of calls) console.log(`  ${call.method} ${call.path} → ${call.status ?? `HTTP ${call.http}`}${call.walk ? "" : " (signed out)"}`);
console.log(`\nproblems: ${problems.length}`); for (const p of problems) console.log("  - " + p);
await browser.close();
process.exit(problems.length ? 1 : 0);
