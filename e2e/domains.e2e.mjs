// Custom domains in the app, through its UI against the real API: the empty
// list, adding a subdomain and a root, the records and Check now, the refusals,
// provider and email, archive and restore, and delete with the typed host.
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
    const sub = `shop.${root}`;
    let rootPage = null;
    const toast = (text) => page.locator(".toast").filter({ hasText: text }).waitFor();
    const menuOf = async (host) => {
      await page.locator(`tr[data-row="${host}"] [data-menu]`).click();
      return page.locator(".popover");
    };

    await step("the sidebar opens an empty list that names the sandbox host", async () => {
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}`);
      await page.locator(".nav").getByRole("link", { name: "Domains" }).click();
      await page.waitForURL(/\/domains$/);
      await page.getByRole("heading", { name: "No domains yet" }).waitFor();
      await page.getByText(`project-${dom.projectId}.insidefi.co`).waitFor();
    });

    await step("a pasted URL is sent as its host, and the records follow", async () => {
      await page.getByRole("button", { name: "Add domain" }).click();
      await page.fill('[name="host"]', `https://${sub}/landing`);
      await page.getByText(`We'll send ${sub}`).waitFor();
      await page.getByRole("button", { name: "Add domain" }).last().click();
      await page.waitForURL(/\/domains\/[0-9a-f]{24}$/);
      await page.getByRole("heading", { name: sub }).waitFor();
      const names = await page.locator("[data-records] tbody td:nth-child(2)").allInnerTexts();
      assert.match(names[0], /^shop$/);
      assert.match(names[1], /^_verify\.shop\s+or _verify at the root$/);
      assert.match(await page.locator("[data-records] tbody tr").first().innerText(), /cname\.insidefi\.co/);
      await page.locator("[data-health]").filter({ hasText: "Pending" }).waitFor();
    });

    await step("Check now runs one lookup and says what it found", async () => {
      await page.getByRole("button", { name: "Check now" }).click();
      await toast("Checked: DNS pending");
      await page.locator("[data-banner]").filter({ hasText: `${sub} isn't visible yet` }).waitFor();
      await page.getByText(/1 check · last/).waitFor();
    });

    await step("the provider saves, and the records go out by email", async () => {
      await page.selectOption("[data-provider]", "namecheap");
      await toast("Saved");
      await page.fill('[data-email] [name="email"]', "it@example.com");
      await page.fill('[data-email] [name="note"]', "for the shop host");
      await page.getByRole("button", { name: "Send" }).click();
      await page.locator("[data-sent]").filter({ hasText: "Sent to it@example.com" }).waitFor();
    });

    await step("a pending domain offers no Make primary", async () => {
      await page.locator("[data-more]").click();
      await page.locator(".popover").getByText("Archive").waitFor();
      assert.equal(await page.locator(".popover").getByText("Make primary").count(), 0);
      await page.keyboard.press("Escape");
    });

    await step("the add form words each refusal", async () => {
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}/domains`);
      await page.locator(`tr[data-row="${sub}"]`).waitFor();
      await page.getByRole("button", { name: "Add domain" }).click();
      for (const [host, words] of [
        [sub, "already uses that host"],
        [`*.${root}`, "Wildcard domains can't be connected"],
        ["insidefi.co", "Enter a bare host like go.brand.com"],
        // The free plan holds one domain per workspace.
        [`www.${root}`, "all the domains its plan allows"],
      ]) {
        await page.fill('[name="host"]', host);
        await page.getByRole("button", { name: "Add domain" }).last().click();
        await page.locator(".modal .form-error").filter({ hasText: words }).waitFor();
      }
      await page.locator(".modal [data-close]").first().click();
    });

    await step("archive moves it under Archived, restore brings it back", async () => {
      await (await menuOf(sub)).getByText("Archive").click();
      await toast(`${sub} archived`);
      await page.locator('[data-count="archived"]').filter({ hasText: "1" }).waitFor();
      await page.locator("[data-tabs] button").filter({ hasText: "Archived" }).click();
      await (await menuOf(sub)).getByText("Restore").click();
      await toast("If you removed the TXT record, add it back");
      await page.locator('[data-count="archived"]').filter({ hasText: "0" }).waitFor();
    });

    await step("delete lists the impact and needs the host typed exactly", async () => {
      await page.locator("[data-tabs] button").filter({ hasText: "All" }).click();
      await (await menuOf(sub)).getByText("Delete").click();
      await page.locator("[data-impact]").getByText("must be removed by hand").waitFor();
      const confirm = page.getByRole("button", { name: "Delete domain" });
      await page.fill('.modal [name="host"]', sub.toUpperCase());
      assert.equal(await confirm.isDisabled(), true, "a near miss keeps the button off");
      await page.press('.modal [name="host"]', "Enter");
      await page.locator("[data-impact]").waitFor();
      assert.equal(await page.locator(`tr[data-row="${sub}"]`).count(), 1, "Enter on a near miss deletes nothing and keeps the modal");
      await page.fill('.modal [name="host"]', sub);
      await confirm.click();
      await page.getByRole("heading", { name: `${sub} is deleted` }).waitFor();
      await page.locator(".modal").getByText(`TXT _verify.shop`).waitFor();
      await page.locator(".modal [data-close]").last().click();
      await page.getByRole("heading", { name: "No domains yet" }).waitFor();
    });

    await step("with the slot free again, a root serves on the label picked", async () => {
      await page.getByRole("button", { name: "Add domain" }).click();
      await page.fill('[name="host"]', root);
      await page.selectOption('[name="kind"]', "root");
      await page.selectOption('[name="servingLabel"]', "lp");
      await page.getByRole("button", { name: "Add domain" }).last().click();
      await page.waitForURL(/\/domains\/[0-9a-f]{24}$/);
      rootPage = page.url();
      await page.getByText(`lp.${root}`, { exact: true }).waitFor();
      await page.goto(`${HARNESS}/#/w/${dom.workspaceId}/domains`);
      await page.locator(`tr[data-row="${root}"]`).getByText(`serves on lp.${root}`).waitFor();
      await page.locator('[data-count="all"]').filter({ hasText: "1" }).waitFor();
      await page.locator('[data-count="pending"]').filter({ hasText: "1" }).waitFor();
    });

    await step("the 30-second re-read never wipes an email being written", async () => {
      // Last, because the page's clock stays fake from here on.
      await page.clock.install();
      await page.goto(rootPage);
      await page.locator("[data-records]").waitFor();
      await page.fill('[data-email] [name="email"]', "draft@example.com");
      await page.locator("h1").click();
      for (let tick = 0; tick < 2; tick += 1) {
        await page.clock.fastForward(31_000);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      assert.equal(await page.inputValue('[data-email] [name="email"]'), "draft@example.com");
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
