// Custom domains in the app, through its UI against the real API. The add takes
// a root only (D-H1): a subdomain and a private suffix are refused with words
// and a one-click fill, and a root meets the lane's switch (off on a laptop, so
// "paused" is the answer to a good add). The pages that need a handed-over root
// in a state read seeded rows (see the second half); the mock walk is
// handover.e2e.mjs.
// Usage: master on :3000 (run with --preserve-symlinks from a checkout whose
// ../backend is the handover branch), the harness on :3001, then
//   node --preserve-symlinks --preserve-symlinks-main e2e/domains.e2e.mjs
import assert from "node:assert/strict";

import { API, HARNESS, person, startRun, step } from "./harness.mjs";

/** A workspace and a project of the person's own: setup, not under test. */
async function ownProject(someone) {
  const request = someone.context.request;
  const bootstrap = await (await request.get(`${API}/me/bootstrap`)).json();
  const orgId = bootstrap.result.data.user.organizationId;
  const workspace = await (await request.post(`${API}/organizations/${orgId}/workspaces`, { data: { name: "Dom Domains", timezone: "UTC" } })).json();
  assert.equal(workspace.status, 201, "create the workspace");
  const workspaceId = workspace.result.data.workspaceId;
  const project = await (await request.post(`${API}/workspaces/${workspaceId}/projects`, { data: { appId: "affify", name: "Medicare Q4" } })).json();
  assert.equal(project.status, 201, "create the project");
  return { workspaceId: workspaceId, projectId: project.result.data.projectId };
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
