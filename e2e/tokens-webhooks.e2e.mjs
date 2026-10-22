// The api tokens page (list, mint, try the bearer, rate limit, revoke) and the
// webhooks page (catalogue, endpoints, test, deliveries, redeliver, rotate,
// edit, delete), driven through their UI as one workspace owner.
import assert from "node:assert/strict";

import {
  API,
  HARNESS,
  act,
  assertOk,
  person,
  startRun,
  step,
} from "./harness.mjs";

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

// textContent, not innerText: the request body sits in a closed <details>.
const panelText = (page) => page.locator("#response-panel").textContent();
const badge = (page) => page.locator("#response-panel .badge").innerText();
const errorLine = (page) =>
  page.locator("#response-panel .error-line").innerText();
// The first <pre> in the panel is the request body.
const sentBody = async (page) =>
  JSON.parse(await page.locator("#response-panel pre").first().textContent());

/**
 * Open a page and wait until its first load has painted.
 *
 * @returns {Promise<void>}
 */
async function open(page, path) {
  await page.goto(`${HARNESS}${path}`);
  await page.locator("body[data-ready=true]").waitFor();
}

/**
 * The tokens page, top to bottom.
 *
 * @returns {Promise<string>} the webhooks-scoped secret it minted
 */
async function tokensFlow(page, workspaceId) {
  const mintButton = '#mint-form button[type="submit"]';
  const tryButton = '#try-form button[type="submit"]';
  const rows = page.locator("#tokens-table tbody tr");

  await step("the tokens page lists no tokens yet", async () => {
    await open(page, "/tokens");
    assert.match(
      await badge(page),
      new RegExp(`GET /workspaces/${workspaceId}/tokens`),
    );
    assert.match(await page.locator("#tokens-table").innerText(), /no live/);
  });

  await step(
    "minting with no scope ticked is refused, saying why",
    async () => {
      const shown = await act(page, () => page.click(mintButton));
      assert.equal(shown.status, 400);
      assert.match(await errorLine(page), /INVALID_REQUEST — scopes must be/);
      assert.equal(await page.locator("#new-secret").count(), 0);
    },
  );

  const reporter = await step(
    "a reports.read token with an expiry: the secret shows once, copyable",
    async () => {
      await page.fill('#mint-form input[name="name"]', "Reporter");
      await page.check('#mint-form input[value="reports.read"]');
      await page.fill('#mint-form input[name="expiresAt"]', "2030-01-01");
      const shown = await act(page, () => page.click(mintButton));
      assert.equal(shown.status, 201);
      assert.deepEqual(await sentBody(page), {
        name: "Reporter",
        scopes: ["reports.read"],
        ownerType: "USER",
        expiresAt: "2030-01-01",
      });
      const secret = await page.locator("#new-secret").innerText();
      assert.match(secret, /^ifi_live_/);
      assert.equal(await page.inputValue("#try-secret"), secret);
      await page.click("#secret-box button[data-copy]");
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        secret,
      );
      assert.equal(await rows.count(), 1);
      const [prefix, last4] = (
        await rows.locator('[data-field="key"]').innerText()
      ).split("··");
      assert.ok(secret.startsWith(prefix) && secret.endsWith(last4));
      assert.match(
        await rows.locator('[data-field="expires"]').innerText(),
        /2030/,
      );
      assert.ok(
        !(await page.locator("#tokens-table").innerText()).includes(secret),
      );
      return {
        secret: secret,
        tokenId: await rows.getAttribute("data-token-id"),
      };
    },
  );

  await step("try it: the bearer reads projects", async () => {
    await page.selectOption('#try-form select[name="route"]', "/projects");
    assertOk(await act(page, () => page.click(tryButton)), "bearer projects");
    assert.match(
      await badge(page),
      new RegExp(`GET /workspaces/${workspaceId}/projects`),
    );
    assert.match(await panelText(page), /"Authorization": "Bearer ifi_live_/);
  });

  await step(
    "try it: reports.read is refused webhook endpoints (403)",
    async () => {
      await page.selectOption(
        '#try-form select[name="route"]',
        "/webhook-endpoints",
      );
      const shown = await act(page, () => page.click(tryButton));
      assert.equal(shown.status, 403);
      assert.match(await errorLine(page), /permission/);
    },
  );

  await step("the rate limit names the token and its use", async () => {
    assertOk(
      await act(page, () => page.click("#rate-limit-button")),
      "rate limit",
    );
    assert.match(
      await page.locator("#rate-summary").innerText(),
      /120 a minute per token/,
    );
    const row = page.locator(
      `#rate-limit tr[data-token-id="${reporter.tokenId}"]`,
    );
    assert.match(await row.innerText(), /Reporter/);
    assert.match(
      await row.locator('[data-field="used"]').innerText(),
      /^\d+ \/ 120$/,
    );
  });

  const hooksSecret = await step(
    "a SERVICE token with the webhooks scope that never expires",
    async () => {
      await page.fill('#mint-form input[name="name"]', "Hook bot");
      await page.uncheck('#mint-form input[value="reports.read"]');
      await page.check('#mint-form input[value="webhooks"]');
      await page.selectOption('#mint-form select[name="ownerType"]', "SERVICE");
      await page.fill('#mint-form input[name="expiresAt"]', "");
      const shown = await act(page, () => page.click(mintButton));
      assert.equal(shown.status, 201);
      assert.equal((await sentBody(page)).expiresAt, undefined);
      const secret = await page.locator("#new-secret").innerText();
      assert.notEqual(secret, reporter.secret);
      const row = page.locator("#tokens-table tbody tr", {
        hasText: "Hook bot",
      });
      assert.match(
        await row.locator('[data-field="owner"]').innerText(),
        /SERVICE/,
      );
      assert.equal(
        await row.locator('[data-field="expires"]').innerText(),
        "never",
      );
      assert.equal(await rows.count(), 2);
      return secret;
    },
  );

  await step("a third live token is refused by the free plan", async () => {
    const shown = await act(page, () => page.click(mintButton));
    assert.equal(shown.status, 403);
    assert.match(await errorLine(page), /ENTITLEMENT_REQUIRED/);
    assert.equal(await rows.count(), 2);
  });

  await step("revoking the reporter token takes it off the list", async () => {
    const row = page.locator(
      `#tokens-table tr[data-token-id="${reporter.tokenId}"]`,
    );
    assertOk(
      await act(page, () =>
        row.locator('button[data-action="revoke"]').click(),
      ),
      "revoke",
    );
    assert.match(
      await badge(page),
      new RegExp(
        `DELETE /workspaces/${workspaceId}/tokens/${reporter.tokenId}`,
      ),
    );
    assert.equal(await row.count(), 0);
    assert.equal(await rows.count(), 1);
  });

  await step(
    "the revoked secret is now 401, the cookie notwithstanding",
    async () => {
      await page.fill("#try-secret", reporter.secret);
      await page.selectOption('#try-form select[name="route"]', "/projects");
      const shown = await act(page, () => page.click(tryButton));
      assert.equal(shown.status, 401);
      assert.match(await errorLine(page), /not signed in/);
    },
  );

  await step("a refreshed list carries no secret", async () => {
    assertOk(await act(page, () => page.click("#refresh-tokens")), "refresh");
    const text = await panelText(page);
    assert.ok(!text.includes(hooksSecret) && !text.includes(reporter.secret));
  });

  return hooksSecret;
}

/**
 * The webhooks page, top to bottom.
 *
 * @returns {Promise<void>}
 */
async function webhooksFlow(page, workspaceId, hooksSecret) {
  const createButton = '#create-form button[type="submit"]';
  const editButton = '#edit-form button[type="submit"]';

  await step(
    "the webhooks page loads the catalogue and no endpoints",
    async () => {
      await open(page, "/webhooks");
      assert.match(
        await badge(page),
        new RegExp(`GET /workspaces/${workspaceId}/webhook-endpoints`),
      );
      assert.equal(
        await page.locator('#create-events input[name="events"]').count(),
        8,
      );
      assert.ok(
        await page
          .locator('#create-events input[value="member.invited"]')
          .isChecked(),
      );
      assert.equal(
        await page
          .locator('#create-form [data-insert="{{member.email}}"] .pii')
          .count(),
        1,
      );
      assert.match(
        await page.locator("#endpoints-table").innerText(),
        /no endpoints/,
      );
    },
  );

  await step("the catalogue buttons call their routes", async () => {
    assertOk(await act(page, () => page.click("#events-button")), "events");
    assert.match(await badge(page), /GET \/webhook-events/);
    assertOk(
      await act(page, () => page.click("#variables-button")),
      "variables",
    );
    assert.match(await badge(page), /GET \/webhook-variables/);
    assert.match(
      await page.locator("#variables-list summary").innerText(),
      /^\d+ variables/,
    );
  });

  await step(
    "a localhost URL is refused as URL_NOT_ALLOWED, under the form",
    async () => {
      await page.fill(
        '#create-form input[name="url"]',
        "https://localhost/hooks",
      );
      const shown = await act(page, () => page.click(createButton));
      assert.equal(shown.status, 400);
      assert.match(await errorLine(page), /URL_NOT_ALLOWED/);
      assert.match(
        await page.locator("#create-outcome").innerText(),
        /URL_NOT_ALLOWED — that host points inside our network/,
      );
    },
  );

  const endpointId = await step(
    "a public endpoint with a template and a header: the secret shows once",
    async () => {
      await page.fill(
        '#create-form input[name="url"]',
        "https://example.com/hooks",
      );
      await page.click('#create-form [data-insert="{{member.email}}"]');
      await page.fill(
        '#create-form textarea[name="headers"]',
        "X-Api-Key: abc123",
      );
      const shown = await act(page, () => page.click(createButton));
      assert.equal(shown.status, 201);
      assert.deepEqual(await sentBody(page), {
        name: "CRM",
        url: "https://example.com/hooks",
        method: "POST",
        events: ["member.invited"],
        bodyTemplate: "{{member.email}}",
        headers: [{ name: "X-Api-Key", value: "abc123" }],
      });
      const secret = await page
        .locator('#create-outcome [data-field="secret"]')
        .innerText();
      assert.match(secret, /^whsec_/);
      const row = page.locator("#endpoints-table tbody tr");
      assert.equal(await row.count(), 1);
      assert.match(
        await row.locator('[data-field="status"]').innerText(),
        /ACTIVE/,
      );
      assert.equal(
        await row.locator('[data-field="headers"]').innerText(),
        "X-Api-Key",
      );
      assert.equal(
        await row.locator('[data-field="secret"]').innerText(),
        `··${secret.slice(-4)}`,
      );
      assert.ok(
        !(await page.locator("#endpoints-table").innerText()).includes(secret),
      );
      return row.getAttribute("data-endpoint-id");
    },
  );
  const row = page.locator(
    `#endpoints-table tr[data-endpoint-id="${endpointId}"]`,
  );

  await step("the list answers the webhooks token as the caller", async () => {
    await page.fill("#bearer", hooksSecret);
    assertOk(
      await act(page, () => page.click("#refresh-endpoints")),
      "as token",
    );
    assert.match(await panelText(page), /"Authorization": "Bearer ifi_live_/);
    assert.equal(await row.count(), 1);
    await page.fill("#bearer", "");
  });

  await step("select, then PATCH the name and method only", async () => {
    await row.locator('button[data-action="select"]').click();
    assert.equal(await page.inputValue("#edit-endpoint-id"), endpointId);
    await page.fill("#edit-name", "CRM sync");
    await page.selectOption('#edit-form select[name="method"]', "PUT");
    assertOk(await act(page, () => page.click(editButton)), "patch");
    assert.deepEqual(await sentBody(page), { name: "CRM sync", method: "PUT" });
    assert.match(
      await row.locator('[data-field="name"]').innerText(),
      /CRM sync/,
    );
    assert.match(
      await row.locator('[data-field="url"]').innerText(),
      /PUT https:\/\/example\.com\/hooks/,
    );
  });

  await step(
    "rotating shows a new secret once, with the old one's grace",
    async () => {
      assertOk(
        await act(page, () =>
          row.locator('button[data-action="rotate"]').click(),
        ),
        "rotate",
      );
      const secret = await page
        .locator('#rotate-secret [data-field="secret"]')
        .innerText();
      assert.match(secret, /^whsec_/);
      assert.match(
        await page.locator('#rotate-secret [data-field="grace"]').innerText(),
        /\d/,
      );
      assert.equal(
        await row.locator('[data-field="secret"]').innerText(),
        `··${secret.slice(-4)}`,
      );
    },
  );

  const deliveryId = await step(
    "test sends one sample event and logs it",
    async () => {
      assertOk(
        await act(page, () =>
          row.locator('button[data-action="test"]').click(),
        ),
        "test",
      );
      assert.match(
        await page.locator("#test-result").innerText(),
        /test → (receiver answered \d+|nothing answered)/,
      );
      const id = await page.inputValue("#delivery-id");
      assert.match(id, /^[a-f0-9]{24}$/);
      return id;
    },
  );
  const logRow = page.locator(
    `#deliveries-table tr[data-delivery-id="${deliveryId}"]`,
  );

  await step("the endpoint's log lists the test delivery", async () => {
    assertOk(
      await act(page, () =>
        row.locator('button[data-action="deliveries"]').click(),
      ),
      "deliveries",
    );
    assert.equal(await logRow.count(), 1);
    assert.match(
      await logRow.locator('[data-field="eventId"]').innerText(),
      /^evt_test_/,
    );
    assert.equal(
      await logRow.locator('[data-field="event"]').innerText(),
      "member.invited",
    );
  });

  await step("opening it shows the payload, marked as a test", async () => {
    assertOk(
      await act(page, () =>
        logRow.locator('button[data-action="open"]').click(),
      ),
      "open",
    );
    assert.match(
      await badge(page),
      new RegExp(
        `GET /workspaces/${workspaceId}/webhook-deliveries/${deliveryId}`,
      ),
    );
    const payload = JSON.parse(
      await page.locator('#delivery-detail [data-field="payload"]').innerText(),
    );
    assert.equal(payload.event.test, true);
    assert.equal(payload.workspace.id, workspaceId);
  });

  await step(
    "redeliver with an Idempotency-Key queues it as PENDING",
    async () => {
      await page.click("#new-key");
      assertOk(
        await act(page, () => page.click("#redeliver-button")),
        "redeliver",
      );
      assert.match(await panelText(page), /"Idempotency-Key": "redeliver-\d+"/);
      assert.match(
        await page.locator("#delivery-detail").innerText(),
        /PENDING/,
      );
    },
  );

  await step(
    "PATCH status DISABLED turns it off, sending nothing else",
    async () => {
      await page.fill("#edit-name", "");
      await page.selectOption('#edit-form select[name="method"]', "");
      await page.selectOption('#edit-form select[name="status"]', "DISABLED");
      assertOk(await act(page, () => page.click(editButton)), "disable");
      assert.deepEqual(await sentBody(page), { status: "DISABLED" });
      assert.match(
        await row.locator('[data-field="status"]').innerText(),
        /DISABLED[\s\S]*health disabled/,
      );
    },
  );

  await step("delete takes the endpoint off the list", async () => {
    assertOk(
      await act(page, () =>
        row.locator('button[data-action="delete"]').click(),
      ),
      "delete",
    );
    assert.match(
      await badge(page),
      new RegExp(
        `DELETE /workspaces/${workspaceId}/webhook-endpoints/${endpointId}`,
      ),
    );
    assert.match(
      await page.locator("#endpoints-table").innerText(),
      /no endpoints/,
    );
  });

  await step(
    "the deleted endpoint's log answers 404, shown in place",
    async () => {
      const shown = await act(page, () =>
        page.click('#deliveries-form button[type="submit"]'),
      );
      assert.equal(shown.status, 404);
      assert.match(
        await page.locator("#deliveries-table").innerText(),
        /NOT_FOUND — there is no such webhook endpoint/,
      );
    },
  );
}

(async () => {
  let run = null;
  let failed = false;
  try {
    run = await startRun("tokhooks");
    const olga = await step("Olga signs up", () => person(run, "Olga"));
    const workspaceId = await step("Olga makes a workspace", async () => {
      const profile = await setup(olga, "GET", "/auth/profile/get");
      const created = await setup(
        olga,
        "POST",
        `/organizations/${profile.user.organizationId}/workspaces`,
        { name: "Hooks Lab", timezone: "UTC" },
      );
      return created.workspaceId;
    });
    await olga.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: HARNESS,
    });

    const hooksSecret = await tokensFlow(olga.page, workspaceId);
    await webhooksFlow(olga.page, workspaceId, hooksSecret);

    await step("no page threw", () => assert.deepEqual(olga.errors, []));
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
