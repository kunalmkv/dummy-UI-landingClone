// The ownership page: offering a workspace, withdrawing, accepting from the
// emailed link, and the org owner's rescue of a workspace left with no owner.
import assert from "node:assert/strict";

import {
  API,
  HARNESS,
  PASSWORD,
  act,
  assertOk,
  mail,
  person,
  startRun,
  step,
} from "./harness.mjs";

const WORKSPACE_NAME = "Handover Lab";

/**
 * Setup through the API as a person: never the thing under test.
 *
 * @returns {Promise<object>} result.data
 */
async function setup(who, method, path, data) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
  });
  const body = await response.json();
  assert.ok(
    [200, 201].includes(body.status),
    `${method} ${path}: ${JSON.stringify(body)}`,
  );
  return body.result.data;
}

/**
 * The token of an offer mailed to someone, newer than the one given.
 *
 * @returns {Promise<{id: string, token: string}>}
 */
async function offerMail(email, previousId = null) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const row = await mail(email, "OWNERSHIP_TRANSFER");
    if (row._id !== previousId) {
      return { id: row._id, token: row.payload.transferLink.split("#")[1] };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no new OWNERSHIP_TRANSFER mail reached ${email}`);
}

/**
 * Open a URL on the page and wait until the picked workspace has drawn.
 *
 * @returns {Promise<void>}
 */
async function open(who, url, workspaceId) {
  await who.page.goto(url);
  await who.page.waitForSelector(`body[data-loaded="${workspaceId}"]`);
}

function panelText(page) {
  return page.locator("#response-panel").innerText();
}

function errorLine(page) {
  return page.locator("#response-panel .error-line").innerText();
}

function badge(page) {
  return page.locator("#response-panel .badge").innerText();
}

/** Confirm the password through the identity confirmation form. */
async function confirmIdentity(page) {
  await page.fill("#identity-confirm-password", PASSWORD);
  assertOk(
    await act(page, () => page.click('#identity-confirm-form button[type="submit"]')),
    "identity confirmation",
  );
  assert.match(await page.locator("#identity-confirm-outcome").innerText(), /granted/);
}

/** Submit the offer form for one person and a typed name. */
function offer(page, toUserId, confirmName) {
  return act(page, async () => {
    await page.selectOption("#offer-to", toUserId);
    await page.fill("#offer-confirm", confirmName);
    await page.click('#offer-form button[type="submit"]');
  });
}

function acceptOnPage(page) {
  return act(page, () => page.click('#accept-form button[type="submit"]'));
}

function rescue(page, toUserId) {
  return act(page, async () => {
    await page.selectOption("#assign-to", toUserId);
    await page.click('#assign-form button[type="submit"]');
  });
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("ownership");
    const olga = await step("Olga signs up", () => person(run, "Olga"));
    const hank = await step("Hank signs up", () => person(run, "Hank"));

    const { workspaceId, hankId } = await step(
      "Olga makes a workspace and Hank joins it as an EDITOR",
      async () => {
        const profile = await setup(olga, "GET", "/auth/profile/get");
        const created = await setup(
          olga,
          "POST",
          `/organizations/${profile.user.organizationId}/workspaces`,
          { name: WORKSPACE_NAME, timezone: "UTC" },
        );
        await setup(
          olga,
          "POST",
          `/workspaces/${created.workspaceId}/invites`,
          {
            recipients: [hank.email],
            wsRole: "EDITOR",
          },
        );
        const invite = await mail(hank.email, "WORKSPACE_INVITE");
        await setup(hank, "POST", "/invites/accept", {
          token: invite.payload.inviteLink.split("#")[1],
        });
        const hankProfile = await setup(hank, "GET", "/auth/profile/get");
        return {
          workspaceId: created.workspaceId,
          hankId: hankProfile.user.id,
        };
      },
    );

    const page = olga.page;
    const offerState = page.locator("#offer-state");

    await step(
      "the page opens on the workspace with no open offer",
      async () => {
        await open(olga, `${HARNESS}/ownership`, workspaceId);
        assert.match(
          await badge(page),
          new RegExp(`GET /workspaces/${workspaceId}/ownership-transfer`),
        );
        assert.match(await panelText(page), /"pending": null/);
        assert.match(await offerState.innerText(), /no open offer/);
        assert.match(
          await page.locator("#capability-line").innerText(),
          /you hold workspace\.transfer/,
        );
        assert.match(
          await page.locator("#confirm-hint").innerText(),
          /Handover Lab/,
        );
      },
    );

    await step(
      "offering without an identity confirmation is refused IDENTITY_CONFIRM_REQUIRED",
      async () => {
        const refused = await offer(page, hankId, WORKSPACE_NAME);
        assert.equal(refused.status, 403);
        assert.match(await errorLine(page), /IDENTITY_CONFIRM_REQUIRED/);
        assert.match(
          await page.locator("#offer-outcome").innerText(),
          /in the identity confirmation form/,
        );
      },
    );

    await step("Olga confirms her password", () => confirmIdentity(page));

    await step("a mistyped name is refused NAME_MISMATCH", async () => {
      const refused = await offer(page, hankId, WORKSPACE_NAME.toLowerCase());
      assert.equal(refused.status, 400);
      assert.match(await errorLine(page), /NAME_MISMATCH/);
      assert.match(await offerState.innerText(), /no open offer/);
    });

    await step(
      "the exact name offers it to Hank; the grant was kept",
      async () => {
        assertOk(await offer(page, hankId, WORKSPACE_NAME), "offer");
        assert.match(await offerState.innerText(), new RegExp(hank.email));
        assert.equal(
          await offerState.locator('[data-field="status"]').innerText(),
          "PENDING",
        );
      },
    );

    const first = await step("the offer mail reaches Hank", () =>
      offerMail(hank.email),
    );

    await step("refresh reads the same open offer back", async () => {
      assertOk(await act(page, () => page.click("#offer-refresh")), "refresh");
      assert.match(await panelText(page), new RegExp(hankId));
      assert.match(await offerState.innerText(), new RegExp(hank.email));
    });

    await step("withdrawing it answers cancelled: true", async () => {
      assertOk(
        await act(page, () =>
          offerState.locator('button[data-action="withdraw"]').click(),
        ),
        "withdraw",
      );
      assert.match(await panelText(page), /"cancelled": true/);
      assert.match(await offerState.innerText(), /withdrawn/);
    });

    await step(
      "Hank's withdrawn link is refused TRANSFER_NOT_PENDING",
      async () => {
        await open(hank, `${HARNESS}/ownership#${first.token}`, workspaceId);
        // An EDITOR may not read the offer: the page shows that on load.
        assert.match(await badge(hank.page), /GET .*ownership-transfer/);
        assert.match(
          await hank.page.locator("#offer-state").innerText(),
          /OWNER/,
        );
        assert.equal(await hank.page.inputValue("#accept-token"), first.token);
        const refused = await acceptOnPage(hank.page);
        assert.equal(refused.status, 409);
        assert.match(await errorLine(hank.page), /TRANSFER_NOT_PENDING/);
        assert.match(
          await hank.page.locator("#accept-outcome").innerText(),
          /link is dead/,
        );
      },
    );

    await step("Olga confirms again and offers it to Hank again", async () => {
      await confirmIdentity(page);
      assertOk(await offer(page, hankId, WORKSPACE_NAME), "second offer");
      assert.match(await offerState.innerText(), new RegExp(hank.email));
    });

    const second = await step("a new offer mail reaches Hank", () =>
      offerMail(hank.email, first.id),
    );

    // Olga's fifth offer in 15 minutes: the most the limit allows.
    await step(
      "a second offer while one is open is refused TRANSFER_ALREADY_PENDING",
      async () => {
        await confirmIdentity(page);
        const refused = await offer(page, hankId, WORKSPACE_NAME);
        assert.equal(refused.status, 409);
        assert.match(await errorLine(page), /TRANSFER_ALREADY_PENDING/);
        assert.match(
          await page.locator("#offer-outcome").innerText(),
          /Withdraw the open offer first/,
        );
        // The refusal names the open offer; the table keeps showing it.
        assert.match(await panelText(page), /"pending": \{/);
        assert.match(await offerState.innerText(), new RegExp(hank.email));
      },
    );

    await step("Olga pasting Hank's link is refused NOT_FOUND", async () => {
      await page.fill("#accept-token", second.token);
      const refused = await acceptOnPage(page);
      assert.equal(refused.status, 404);
      assert.match(await errorLine(page), /NOT_FOUND/);
      assert.match(
        await page.locator("#accept-outcome").innerText(),
        /made to someone else/,
      );
    });

    await step(
      "signed out, Hank's accept is refused and says sign in",
      async () => {
        await hank.page.goto(`${HARNESS}/ownership#${second.token}`);
        await hank.page.waitForFunction(
          (token) => document.querySelector("#accept-token").value === token,
          second.token,
        );
        assertOk(
          await act(hank.page, () => hank.page.click("#signout-button")),
          "sign out",
        );
        const refused = await acceptOnPage(hank.page);
        assert.equal(refused.status, 401);
        assert.match(
          await hank.page.locator("#accept-outcome").innerText(),
          /sign in below/,
        );
      },
    );

    await step(
      "Hank signs in on the page and accepts: he owns it",
      async () => {
        await hank.page.fill("#signin-email", hank.email);
        await hank.page.fill("#signin-password", PASSWORD);
        assertOk(
          await act(hank.page, () =>
            hank.page.click('#signin-form button[type="submit"]'),
          ),
          "sign in",
        );
        assertOk(await acceptOnPage(hank.page), "accept");
        assert.match(await panelText(hank.page), new RegExp(workspaceId));
        assert.match(
          await hank.page.locator("#accept-outcome").innerText(),
          /you now own workspace/,
        );
        assertOk(
          await act(hank.page, () => hank.page.click("#workspace-reload")),
          "reload the list",
        );
        await hank.page.waitForSelector(`body[data-loaded="${workspaceId}"]`);
        assert.match(
          await hank.page
            .locator("#workspace-select option:checked")
            .innerText(),
          /OWNER/,
        );
        assert.match(
          await hank.page.locator("#offer-state").innerText(),
          /no open offer/,
        );
      },
    );

    // Her row is ADMIN now, but she owns the organization, and the org OWNER
    // owns every workspace in it (spine 0d3866b, design §5.2 step 7).
    await step("Olga, the organization's owner, still owns it implicitly", async () => {
      await open(olga, `${HARNESS}/ownership`, workspaceId);
      assert.match(
        await page.locator("#workspace-select option:checked").innerText(),
        /OWNER/,
      );
      assert.match(await page.locator(".panel .status").innerText(), /^200/);
      assert.match(
        await page.locator("#offer-state").innerText(),
        /no open offer/,
      );
    });

    await step(
      "the rescue is refused WORKSPACE_HAS_OWNER while Hank owns it",
      async () => {
        const refused = await rescue(page, hankId);
        assert.equal(refused.status, 409);
        assert.match(await errorLine(page), /WORKSPACE_HAS_OWNER/);
        assert.match(
          await page.locator("#assign-outcome").innerText(),
          /owner offers it instead/,
        );
      },
    );

    await step(
      "Olga, then Hank, leave: the workspace has no owner",
      async () => {
        await setup(
          olga,
          "POST",
          `/workspaces/${workspaceId}/members/me/leave`,
          {},
        );
        await setup(
          hank,
          "POST",
          `/workspaces/${workspaceId}/members/me/leave`,
          {},
        );
      },
    );

    await step(
      "Olga's rescue needs an identity confirmation, then makes Hank the owner",
      async () => {
        await open(olga, `${HARNESS}/ownership`, workspaceId);
        const refused = await rescue(page, hankId);
        assert.equal(refused.status, 403);
        assert.match(await errorLine(page), /IDENTITY_CONFIRM_REQUIRED/);
        await confirmIdentity(page);
        assertOk(await rescue(page, hankId), "rescue");
        assert.match(
          await panelText(page),
          new RegExp(`"ownerId": "${hankId}"`),
        );
        assert.match(
          await page.locator("#assign-outcome").innerText(),
          new RegExp(`${hank.email} now owns it`),
        );
      },
    );

    await step("Hank's page shows him as the owner again", async () => {
      await open(hank, `${HARNESS}/ownership`, workspaceId);
      assert.match(
        await hank.page.locator("#workspace-select option:checked").innerText(),
        /OWNER/,
      );
      assert.match(await panelText(hank.page), /"pending": null/);
    });

    await step(
      "Hank's sixth offer in 15 minutes is refused RATE_LIMITED",
      async () => {
        // He is the only member, so each offer names himself: refused, but
        // counted all the same.
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const refused = await offer(hank.page, hankId, WORKSPACE_NAME);
          assert.equal(refused.status, 400, `offer ${attempt}`);
          assert.match(await errorLine(hank.page), /already own/);
        }
        const limited = await offer(hank.page, hankId, WORKSPACE_NAME);
        assert.equal(limited.status, 429);
        assert.match(await errorLine(hank.page), /RATE_LIMITED/);
        assert.match(await panelText(hank.page), /"retryAfterSeconds": \d+/);
        assert.match(
          await hank.page.locator("#offer-outcome").innerText(),
          /5 offers per 15 minutes/,
        );
      },
    );

    await step("no page threw", () => {
      for (const who of [olga, hank]) {
        assert.deepEqual(who.errors, [], who.email);
      }
    });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
