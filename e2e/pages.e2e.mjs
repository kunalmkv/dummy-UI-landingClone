// Pages in the app, through its UI against the real API: the list, a new page
// from a template, the GrapesJS editor's autosave, publish and versions, the
// public preview, settings, and archive, restore and delete.
import assert from "node:assert/strict";

import { API, HARNESS, person, startRun, step } from "./harness.mjs";

/** A workspace and a project of the person's own: setup, not under test. */
async function ownProject(someone) {
  const request = someone.context.request;
  const bootstrap = await (await request.get(`${API}/me/bootstrap`)).json();
  const orgId = bootstrap.result.data.user.organizationId;
  const workspace = await (await request.post(`${API}/organizations/${orgId}/workspaces`, { data: { name: "Pam Pages", timezone: "UTC" } })).json();
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
    run = await startRun("pages");
    const pam = await step("set up Pam with a workspace and a project", async () => {
      const someone = await person(run, "Pam");
      Object.assign(someone, await ownProject(someone));
      return someone;
    });
    const page = pam.page;
    page.on("console", (message) => message.type() === "error" && !/Failed to load resource|GSI_LOGGER/.test(message.text()) && pam.errors.push(message.text()));
    await page.setViewportSize({ width: 1440, height: 900 });

    await step("the project opens its empty pages list", async () => {
      await page.goto(`${HARNESS}/#/w/${pam.workspaceId}/projects`);
      await page.getByRole("link", { name: "Medicare Q4" }).click();
      await page.waitForURL(/\/pages$/);
      await page.getByRole("heading", { name: "No pages here yet" }).waitFor();
    });

    await step("a new page from a template opens in the editor", async () => {
      await page.getByRole("button", { name: "New page" }).click();
      await page.fill('[name="name"]', "Medicare Hero");
      await page.selectOption('[name="start"]', "tpl_medicare_hero");
      await page.getByRole("button", { name: "Create and edit" }).click();
      await page.waitForURL(/\/pages\/[0-9a-f]{24}\/edit$/);
      await page.frameLocator(".gjs-frame").locator("h1").filter({ hasText: "Find your Medicare plan" }).waitFor({ timeout: 60000 });
    });

    await step("an edit in the canvas autosaves", async () => {
      const heading = page.frameLocator(".gjs-frame").locator("h1");
      await heading.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type(" today");
      await page.frameLocator(".gjs-frame").locator("p").first().click();
      await page.locator("[data-save-state]").filter({ hasText: "All changes saved" }).waitFor({ timeout: 30000 });
    });

    await step("publish makes v1 live, and Versions lists it", async () => {
      await page.getByRole("button", { name: "Publish" }).click();
      await page.fill('[name="note"]', "First go");
      await page.locator(".modal [data-submit]").click();
      await page.getByText("Published v1").waitFor();
      await page.locator("[data-status]").filter({ hasText: "Published" }).waitFor();
      assert.match(await page.locator("[data-live]").getAttribute("href"), /\.insidefi\.app\/medicare-hero$/);
      await page.getByRole("button", { name: "Versions" }).click();
      await page.locator(".modal").getByText("First go").waitFor();
      await page.locator(".modal [data-close]").first().click();
    });

    await step("preview opens the draft in a new tab", async () => {
      const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("button", { name: "Preview" }).click()]);
      await tab.waitForURL(/#\/preview\/[A-Za-z0-9_-]+$/);
      await tab.frameLocator(".preview-frame").locator("h1").filter({ hasText: "today" }).waitFor({ timeout: 60000 });
      await tab.close();
    });

    await step("SEO settings save over their version", async () => {
      await page.getByRole("link", { name: "Settings" }).click();
      await page.waitForURL(/\/settings\/seo$/);
      await page.fill('[name="title"]', "Find your plan");
      await page.getByRole("button", { name: "Save SEO" }).click();
      await page.getByText("Settings saved").waitFor();
      await page.reload();
      assert.equal(await page.locator('[name="title"]').inputValue(), "Find your plan");
    });

    await step("archive, restore and delete from the list", async () => {
      await page.goto(`${HARNESS}/#/w/${pam.workspaceId}/projects/${pam.projectId}/pages`);
      const menu = () => page.locator("[data-menu]").first();
      await menu().click();
      await page.locator(".popover").getByText("Archive").click();
      await page.locator("td").getByText("Archived", { exact: true }).waitFor();
      await menu().click();
      await page.locator(".popover").getByText("Restore").click();
      await page.locator("td").getByText("Unpublished", { exact: true }).waitFor();
      await menu().click();
      await page.locator(".popover").getByText("Delete").click();
      await page.getByRole("button", { name: "Delete page" }).click();
      await page.locator('[data-count="deleted"]').filter({ hasText: "1" }).waitFor();
    });

    assert.deepEqual(pam.errors, [], "no page errors");
    console.log("\npages e2e: all steps passed");
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
    process.exit(failed ? 1 : 0);
  }
})();
