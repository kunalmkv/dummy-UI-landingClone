// Custom domains in the app, through its UI against the real API. The add takes
// a root only (D-H1): a subdomain and a private suffix are refused with words
// and a one-click fill, and a root meets the lane's switch (off on a laptop, so
// "paused" is the answer to a good add). The pages that need a handed-over root
// in a state read seeded rows (see the second half); the mock walk is
// handover.e2e.mjs.
// Usage: the handover branch's master on :3000, the harness on :3001, then
//   BACKEND=/path/to/handover/backend node e2e/domains.e2e.mjs   (BACKEND unset: ../../backend)
import assert from "node:assert/strict";

import { API, HARNESS, fromBackend, person, startRun, step } from "./harness.mjs";

const { default: mongoose } = await fromBackend("node_modules/mongoose/index.js");
const { default: delegatedRootHelper } = await fromBackend("models/tests/helpers/delegated-root.helper.js");
const { default: domainModel } = await fromBackend("models/workspace/domain.workspace.model.js");

/** A workspace and a project of the person's own: setup, not under test. */
async function ownProject(someone) {
  const request = someone.context.request;
  const bootstrap = await (await request.get(`${API}/me/bootstrap`)).json();
  const user = bootstrap.result.data.user;
  const orgId = user.organizationId;
  const workspace = await (await request.post(`${API}/organizations/${orgId}/workspaces`, { data: { name: "Dom Domains", timezone: "UTC" } })).json();
  assert.equal(workspace.status, 201, "create the workspace");
  const workspaceId = workspace.result.data.workspaceId;
  const project = await (await request.post(`${API}/workspaces/${workspaceId}/projects`, { data: { appId: "affify", name: "Medicare Q4" } })).json();
  assert.equal(project.status, 201, "create the project");
  return { workspaceId: workspaceId, projectId: project.result.data.projectId, orgId: orgId, userId: user.userId ?? user.id };
}

const ACM = (name) => ({ name: name, value: `_${"9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d"}.xlfgrmvvlj.acm-validations.aws` });

/** The records lane's row, as the old add left it: no handover, nothing runs it, dated past any real clock. */
async function seedLegacy(dom, host) {
  const row = await domainModel.create({
    orgId: new mongoose.Types.ObjectId(dom.orgId),
    workspaceId: new mongoose.Types.ObjectId(dom.workspaceId),
    projectId: new mongoose.Types.ObjectId(dom.projectId),
    createdBy: new mongoose.Types.ObjectId(dom.userId),
    verifyToken: "a40c7e2b9d1f5a8c3e6b0d4f7a2c9e51",
    host: host,
    type: "subdomain",
    servingHost: host,
    edgeHosts: [host],
    addedAt: delegatedRootHelper.ADDED_AT,
    dns: { mode: "records", status: "pending" },
    edge: { state: "pending" },
  });
  return { domainId: String(row._id), host: row.host, servingHost: row.servingHost };
}

/**
 * A row the API reads as it stores it, so a page meets the real answer in
 * every state without Route 53: never a zone made, only one the row names.
 * Dated past any real clock, so no job of dev's picks it up.
 */
async function seed(dom, host, over = {}) {
  const row = await domainModel.create({
    orgId: new mongoose.Types.ObjectId(dom.orgId),
    workspaceId: new mongoose.Types.ObjectId(dom.workspaceId),
    projectId: new mongoose.Types.ObjectId(dom.projectId),
    createdBy: new mongoose.Types.ObjectId(dom.userId),
    verifyToken: "a40c7e2b9d1f5a8c3e6b0d4f7a2c9e51",
    ...delegatedRootHelper.delegatedRoot({ host: host, ...over }),
  });
  return { domainId: String(row._id), host: row.host, servingHost: row.servingHost };
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("domains");
    const dom = await step("set up Dom with a workspace and a project", async () => {
      const someone = await person(run, "Dom");
      Object.assign(someone, await ownProject(someone));
      return someone;
    });
    const page = dom.page;
    page.on("console", (message) => message.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(message.text()) && dom.errors.push(message.text()));
    await page.setViewportSize({ width: 1440, height: 900 });
    const root = `${run.prefix}.com`;
    // The add's own request bodies, in order.
    const sent = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/workspaces\/[^/]+\/domains$/.test(new URL(request.url()).pathname)) {
        sent.push(request.postDataJSON());
      }
    });
    const modalError = (words) => page.locator(".modal [data-refusal]").filter({ hasText: words }).waitFor();
    const addButton = () => page.locator(".modal [data-submit]");

    await step("the sidebar opens an empty list that names the sandbox host", async () => {
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}`);
      await page.locator(".nav").getByRole("link", { name: "Domains" }).click();
      await page.waitForURL(/\/domains$/);
      await page.getByRole("heading", { name: "No domains yet" }).waitFor();
      await page.getByText(`project-${dom.projectId}.insidefi.co`).waitFor();
    });

    await step("the add dialog takes a root, its label and keep or redirect, keep selected", async () => {
      await page.getByRole("button", { name: "Add domain" }).click();
      assert.equal(await page.locator('.modal [name="servingLabel"]').inputValue(), "go", "the label starts as go");
      assert.equal(await page.locator('.modal [name="apexMode"][value="keep"]').isChecked(), true, "keep is selected");
      assert.equal(await page.locator('.modal [name="apexMode"][value="redirect"]').isChecked(), false);
      assert.equal(await page.locator('.modal [name="kind"], .modal [name="liveElsewhere"]').count(), 0, "no subdomain choice and no live-elsewhere box");
      await page.fill('.modal [name="host"]', `https://${root}/landing`);
      await page.getByText(`We'll send ${root}`).waitFor();
    });

    await step("a subdomain is refused with the fill", async () => {
      await page.fill('.modal [name="host"]', `lp2.${root}`);
      await addButton().click();
      await modalError(`Add ${root} and pick the lp2 label`);
      assert.equal(sent.length, 1, "the refusal came from the API, not a client check");
      await page.locator('.modal [data-fill]').click();
      assert.equal(await page.locator('.modal [name="host"]').inputValue(), root, "the fill puts the root in");
      assert.equal(await page.locator('.modal [name="servingLabel"]').inputValue(), "lp2", "and the label");
      assert.equal(await page.locator(".modal [data-refusal]").count(), 0, "and clears the refusal");
    });

    await step("a name too deep to carry a label is refused with the root only", async () => {
      await page.fill('.modal [name="host"]', `a.b.${root}`);
      await addButton().click();
      await modalError(`Add ${root} and pick the label its pages serve on`);
      await page.locator('.modal [data-fill]').click();
      assert.equal(await page.locator('.modal [name="host"]').inputValue(), root);
      assert.equal(await page.locator('.modal [name="servingLabel"]').inputValue(), "lp2", "the label stays as it was");
    });

    await step("a private suffix is refused", async () => {
      await page.fill('.modal [name="host"]', `${run.prefix}.github.io`);
      await addButton().click();
      await modalError("This name is not registered at a registrar, so it has no name servers to hand over");
      assert.equal(await page.locator(".modal [data-fill]").count(), 0, "nothing to fill in");
    });

    await step("the add words the other refusals", async () => {
      for (const [host, words] of [
        [`*.${root}`, "Wildcard domains can't be connected"],
        ["insidefi.co", "Enter a bare host like go.brand.com"],
      ]) {
        await page.fill('.modal [name="host"]', host);
        await addButton().click();
        await modalError(words);
      }
    });

    await step("paused keeps the form, and the add sends apexMode and the label", async () => {
      await page.fill('.modal [name="host"]', root);
      await page.fill('.modal [name="servingLabel"]', "offers");
      await page.locator('.modal [name="apexMode"][value="redirect"]').check();
      const before = sent.length;
      await addButton().click();
      await page.locator(".modal [data-paused]").filter({ hasText: "New domains are paused for now" }).waitFor();
      assert.equal(sent.length, before + 1);
      assert.deepEqual(sent.at(-1), { host: root, projectId: dom.projectId, servingLabel: "offers", apexMode: "redirect" });
      assert.equal(await page.locator('.modal [name="host"]').inputValue(), root, "the host is kept");
      assert.equal(await page.locator('.modal [name="servingLabel"]').inputValue(), "offers", "the label is kept");
      assert.equal(await page.locator('.modal [name="apexMode"][value="redirect"]').isChecked(), true, "the mode is kept");
      assert.equal(await addButton().isDisabled(), false, "and it can be sent again");
      await page.locator(".modal [data-close]").first().click();
      await page.getByRole("heading", { name: "No domains yet" }).waitFor();
    });

    // ── the pages read the API's own answers, in each state of a root ────────────
    const names = {
      switching: `switch-${run.prefix}.com`,
      reviewing: `review-${run.prefix}.com`,
      live: `live-${run.prefix}.com`,
      legacy: `legacy-${run.prefix}.com`,
    };
    const rows = {};
    await step("seed a root with its gate open, one under review, a live one and a legacy row", async () => {
      rows.switching = await seed(dom, names.switching, {
        handover: {
          migration: { status: "not_needed", acknowledged: ["serving-replaced"] },
          delegation: { status: "awaiting" },
          preflight: { checkedAt: new Date("2026-11-01T10:00:00.000Z"), registrar: "GoDaddy.com, LLC", guide: "godaddy", emailState: "absent" },
          edge: { status: "certificate_requested", certificateStatus: "PENDING_VALIDATION", observed: null, deployed: null, validationRecords: [ACM(`_c3e1f9a2b4d6e8f0a1b2c3d4e5f6a7b8.${names.switching}`), ACM(`_7d2e8f1a3b5c7d9e0f1a2b3c4d5e6f7a.go.${names.switching}`)] },
        },
        edge: { state: "pending" },
        // Asked for, and its validation records written, before the switch: the status still waits for DNS.
        ssl: { status: "awaiting_dns", step: 2, startedAt: new Date("2026-11-01T10:30:00.000Z") },
        dns: { status: "pending" },
      });
      rows.reviewing = await seed(dom, names.reviewing, {
        handover: { migration: { status: "reviewing" }, delegation: { status: "awaiting" }, preflight: { checkedAt: new Date("2026-11-01T10:00:00.000Z"), guide: "godaddy", emailState: "present" }, edge: { status: "none", observed: null, deployed: null } },
        edge: { state: "pending" },
        dns: { status: "pending" },
        ssl: { status: "awaiting_dns" },
      });
      rows.live = await seed(dom, names.live, {
        activatedAt: new Date("2026-11-02T10:00:00.000Z"),
        apex: { mode: "redirect", chosen: true, status: "active" },
        edge: { state: "active" },
        dns: { status: "verified", verifiedAt: new Date("2026-11-02T10:00:00.000Z") },
        ssl: { status: "active", step: 4 },
        handover: { edge: { certificateNotAfter: new Date("2027-02-01T00:00:00.000Z"), replacement: { certificateArn: "arn:aws:acm:us-east-1:111111111111:certificate/c2", status: "requested", generation: 2 } } },
      });
      // The records lane's row, as the old add left it: it holds no handover and nothing runs it.
      rows.legacy = await seedLegacy(dom, `go.${names.legacy}`);
    });

    /** A row's page, once its own heading is drawn: the last route's cards are still there until then. */
    const open = async (row) => {
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}/domains/${row.domainId}`);
      await page.locator("h1").filter({ hasText: row.host }).waitFor();
    };

    await step("the list shows each root on its label, and the legacy row apart", async () => {
      // The list is open at this very address, and a same-address goto draws nothing again.
      await page.reload();
      await page.locator(`tr[data-row="${names.switching}"]`).getByText(`serves on go.${names.switching}`).waitFor();
      await page.locator(`tr[data-row="${names.live}"]`).waitFor();
      await page.locator(`tr[data-row="go.${names.legacy}"]`).waitFor();
    });

    await step("a gate open: the four names, beforeSwitch's validation records, the 48-hour line and the serving note", async () => {
      await open(rows.switching);
      await page.locator("[data-steps]").waitFor();
      assert.equal(await page.locator("[data-name-servers] li").count(), 4);
      assert.equal(await page.locator("[data-records]").count(), 0, "no records table: a delegated root sends none");
      const before = await page.locator("[data-before-switch] li").allInnerTexts();
      assert.equal(before.length, 2);
      for (const row of before) {
        assert.match(row.replace(/\s+/g, " ").trim(), /^CNAME _[0-9a-f]{32}(\.go)?\..+ → _[0-9a-f]{32}\.xlfgrmvvlj\.acm-validations\.aws$/);
      }
      assert.match(await page.locator("[data-cache-note]").innerText(), /cached for up to 48 hours/);
      assert.equal((await page.locator("[data-serving-note]").innerText()).trim(), `${rows.switching.servingHost} starts serving your pages at the switch.`);
      assert.equal((await page.locator("[data-apex-mode]").innerText()).trim(), "Kept as it is");
      assert.equal((await page.locator("[data-issuer]").innerText()).trim(), "Amazon");
      assert.deepEqual(await page.locator("[data-cert-steps] li").evaluateAll((items) => items.map((item) => item.dataset.state)), ["done", "done", "current", "todo"], "before the switch the certificate already shows its progress");
    });

    await step("a copy under review: its blockers, and the root's mode switched both ways", async () => {
      await open(rows.reviewing);
      await page.locator("[data-blockers]").waitFor();
      assert.equal(await page.locator("[data-name-servers]").count(), 0, "no names while the copy is open");
      const before = sent.length;
      const apexBodies = [];
      page.on("request", (request) => request.method() === "PATCH" && /\/apex$/.test(request.url()) && apexBodies.push(request.postDataJSON()));
      await page.locator('[data-apex-switch="redirect"]').click();
      await page.locator("[data-apex-mode]").filter({ hasText: `Redirects to ${rows.reviewing.servingHost}` }).waitFor();
      assert.equal((await page.locator("[data-apex-status]").innerText()).trim(), "Waiting");
      await page.locator('[data-apex-switch="keep"]').click();
      await page.locator("[data-apex-mode]").filter({ hasText: "Kept as it is" }).waitFor();
      assert.deepEqual(apexBodies, [{ mode: "redirect" }, { mode: "keep" }], "an open copy asks its question in the review, not here");
      assert.equal(sent.length, before, "no add was sent");
    });

    await step("the copy page reads the API's own answer: no review yet, scan and zone file offered", async () => {
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}/domains/${rows.reviewing.domainId}/import`);
      await page.locator("h1").filter({ hasText: `Copy your records — ${rows.reviewing.host}` }).waitFor();
      await page.locator("[data-scan-card]").waitFor();
      await page.locator("[data-zone-file-card]").waitFor();
      assert.match((await page.locator("[data-migration]").innerText()).trim(), /^Under review|^Not copied yet/);
      assert.equal(await page.locator("[data-review], [data-gate]").count(), 0, "no session, so nothing to review");
    });

    await step("a live root: the four steps done, the replacement beside them, Check again", async () => {
      await open(rows.live);
      await page.locator("[data-cert-steps]").waitFor();
      assert.deepEqual(await page.locator("[data-cert-steps] li").evaluateAll((items) => items.map((item) => item.dataset.state)), ["done", "done", "done", "done"]);
      assert.match((await page.locator("[data-replacing]").innerText()).trim(), /^Replacing the certificate: a new one is being issued beside this one, which keeps serving\./);
      assert.equal(await page.locator("[data-recheck]").count(), 0, "a replacement in flight is not asked again");
      assert.equal((await page.locator("[data-apex-mode]").innerText()).trim(), `Redirects to ${rows.live.servingHost}`);
      assert.equal((await page.locator("[data-apex-status]").innerText()).trim(), "Redirecting");
    });

    await step("a legacy records row: what it is, no Check now, and no way back once archived", async () => {
      await open(rows.legacy);
      await page.locator("[data-banner]").filter({ hasText: "a setup nothing runs any more" }).waitFor();
      assert.equal(await page.locator("[data-check], [data-apex], [data-certificate], [data-handover]").count(), 0);
      await page.locator("[data-more]").click();
      await page.locator(".popover .menu-item").filter({ hasText: "Archive" }).click();
      await page.locator(".toast").filter({ hasText: "archived" }).first().waitFor();
      await page.locator("[data-banner]").filter({ hasText: "nothing runs any more" }).waitFor();
      await page.locator("[data-more]").click();
      assert.equal(await page.locator(".popover .menu-item").filter({ hasText: "Restore" }).count(), 0, "restore is refused for it, so it isn't offered");
      await page.keyboard.press("Escape");
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}/domains`);
      await page.locator("[data-tabs] button").filter({ hasText: "Archived" }).click();
      await page.locator("tr[data-row]").first().waitFor();
      await page.locator("tr[data-row] [data-menu]").first().click();
      assert.equal(await page.locator(".popover .menu-item").filter({ hasText: "Restore" }).count(), 0, "nor in the list");
      await page.keyboard.press("Escape");
    });

    assert.deepEqual(dom.errors, [], "no page errors");
    console.log("\ndomains e2e: all steps passed");
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
    process.exit(failed ? 1 : 0);
  }
})();
