// The harness itself: a verified person sees who they are on the account page.
import assert from "node:assert/strict";

import { HARNESS, person, startRun, step } from "./harness.mjs";

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("smoke");
    const ada = await step("sign up and verify through the API", () =>
      person(run, "Ada"),
    );
    await step("the identity strip names the signed-in person", async () => {
      await ada.page.goto(`${HARNESS}/account`);
      const strip = ada.page.locator("#identity");
      await strip.locator("strong").filter({ hasText: "@" }).waitFor();
      assert.match(await strip.innerText(), new RegExp(ada.email));
    });
    await step("the page threw nothing", () =>
      assert.deepEqual(ada.errors, []),
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
