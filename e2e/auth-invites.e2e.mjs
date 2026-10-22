// Organization invitations through the pages: send, list, resend, revoke and
// the organization picker on /invites; the dev inbox for every mail type; and
// the preview and both ways to accept on /accept-invite.
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

/**
 * A signed-out visitor in a browser context of their own.
 *
 * @param {object} run from startRun
 * @returns {Promise<{context: object, page: object, errors: string[]}>}
 */
async function visitor(run) {
  const context = await run.browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context: context, page: page, errors: errors };
}

/**
 * Open a harness page and wait for its first calls to finish.
 *
 * @param {object} page
 * @param {string} path
 * @returns {Promise<void>}
 */
async function open(page, path) {
  await page.goto(`${HARNESS}${path}`);
  await page.locator("body[data-ready]").waitFor();
}

/**
 * Setup that is not under test, straight to the API as this person.
 *
 * @param {object} who a person
 * @param {string} method
 * @param {string} path
 * @param {object} [data]
 * @returns {Promise<*>} result.data
 */
async function callApi(who, method, path, data) {
  const response = await who.context.request.fetch(`${API}${path}`, {
    method: method,
    data: data,
  });
  const body = await response.json();
  assert.ok(
    [200, 201, 202].includes(body.status),
    `${method} ${path} answered ${body.status}: ${JSON.stringify(body.result)}`,
  );
  return body.result.data;
}

/**
 * The token in the newest organization invite mailed to an address.
 *
 * @param {string} email
 * @returns {Promise<string>}
 */
async function inviteToken(email) {
  const row = await mail(email, "INVITE");
  return new URL(row.payload.inviteLink).searchParams.get("token");
}

async function panelError(page) {
  return page.locator("#response-panel .error-line").innerText();
}

/**
 * Send an invitation from the /invites form.
 *
 * @param {object} page on /invites
 * @param {string} email
 * @param {string} role
 * @returns {Promise<{status: number|null, text: string}>}
 */
async function sendFromForm(page, email, role) {
  await page.fill("#invite-email", email);
  await page.selectOption("#invite-role", role);
  return act(page, () => page.click("#invite-form button[type=submit]"));
}

function inviteRow(page, email) {
  return page.locator(`#invites tr[data-email="${email}"]`);
}

(async () => {
  let run = null;
  let failed = false;
  const everyone = [];
  try {
    run = await startRun("invites");
    const address = (label) => `${run.prefix}-${label}@example.com`;
    const graceEmail = address("grace");
    const zedEmail = address("zed");
    const yulEmail = address("yul");
    const xiaEmail = address("xia");

    const [ada, carl] = await step("Ada and Carl sign up", () =>
      Promise.all([person(run, "Ada"), person(run, "Carl")]),
    );
    const guest = await visitor(run);
    const grace = await visitor(run);
    everyone.push(ada, carl, guest, grace);
    const adaOrgId = (await callApi(ada, "GET", "/auth/profile/get")).user
      .organizationId;

    await step(
      "Ada's page lists her organization and no invitations",
      async () => {
        await open(ada.page, "/invites");
        assert.match(
          await ada.page.locator("#org-select").innerText(),
          /Ada Org · OWNER/,
        );
        assert.equal(
          await ada.page.locator("#invites").innerText(),
          "nothing pending",
        );
        assert.match(
          await ada.page.locator("#response-panel .status").innerText(),
          /^200/,
        );
      },
    );

    await step(
      "inviting as OWNER is refused, and the panel says why",
      async () => {
        const shown = await sendFromForm(ada.page, graceEmail, "OWNER");
        assert.equal(shown.status, 400, shown.text);
        assert.equal(
          await panelError(ada.page),
          "role must be one of: ADMIN, MEMBER",
        );
      },
    );

    await step("Ada invites Grace, a new address, as MEMBER", async () => {
      assertOk(await sendFromForm(ada.page, graceEmail, "MEMBER"), "send");
      const row = inviteRow(ada.page, graceEmail);
      assert.match(await row.innerText(), /MEMBER[\s\S]*Ada Tester/);
      assert.equal(
        await ada.page.locator("#sent-hint a").getAttribute("href"),
        `/inbox?email=${encodeURIComponent(graceEmail)}`,
      );
    });

    const firstCarlToken = await step(
      "Ada invites Carl, who has an account, as ADMIN",
      async () => {
        assertOk(await sendFromForm(ada.page, carl.email, "ADMIN"), "send");
        assert.match(
          await inviteRow(ada.page, carl.email).innerText(),
          /ADMIN/,
        );
        return inviteToken(carl.email);
      },
    );

    const carlToken = await step("resend mails Carl a new link", async () => {
      const shown = await act(ada.page, () =>
        inviteRow(ada.page, carl.email)
          .locator("button[data-action=resend]")
          .click(),
      );
      assertOk(shown, "resend");
      const token = await inviteToken(carl.email);
      assert.notEqual(token, firstCarlToken);
      assert.equal(await ada.page.locator("#invites tbody tr").count(), 2);
      return token;
    });

    await step("the link the resend replaced is refused", async () => {
      await open(guest.page, `/accept-invite-tester?token=${firstCarlToken}`);
      assert.match(
        await guest.page.locator("#response-panel .status").innerText(),
        /^404/,
      );
      assert.equal(
        await guest.page.locator("#invite-summary .error-line").innerText(),
        "this invitation is invalid or has expired",
      );
    });

    await step("Ada invites Zed, then revokes it from the row", async () => {
      assertOk(await sendFromForm(ada.page, zedEmail, "MEMBER"), "send");
      const zedToken = await inviteToken(zedEmail);
      const shown = await act(ada.page, () =>
        inviteRow(ada.page, zedEmail)
          .locator("button[data-action=revoke]")
          .click(),
      );
      assertOk(shown, "revoke");
      assert.match(
        await ada.page.locator("#response-panel").textContent(),
        /"revoked": true/,
      );
      assert.equal(await inviteRow(ada.page, zedEmail).count(), 0);

      const lookup = await act(guest.page, async () => {
        await guest.page.fill("#token", zedToken);
        await guest.page.click("#preview-form button[type=submit]");
      });
      assert.equal(lookup.status, 404, lookup.text);
    });

    const graceToken = await inviteToken(graceEmail);

    await step(
      "Grace finds the invite in the inbox and follows it",
      async () => {
        await open(
          grace.page,
          `/inbox?email=${encodeURIComponent(graceEmail)}`,
        );
        const row = grace.page.locator("#rows tr[data-type=INVITE]");
        assert.match(
          await row.innerText(),
          /Ada Org[\s\S]*Ada Tester[\s\S]*false/,
        );
        const link = row.locator("a[data-link=inviteLink]");
        assert.equal(
          await link.innerText(),
          "accept the organization invite →",
        );
        assert.equal(
          await link.getAttribute("href"),
          `${HARNESS}/accept-invite?token=${graceToken}`,
        );
        await row.locator("a[data-tester-link=inviteLink]").click();
        await grace.page.waitForURL(/\/accept-invite-tester\?token=/);
        await grace.page.locator("body[data-ready]").waitFor();
        assert.match(
          await grace.page.locator("#invite-summary").innerText(),
          new RegExp(`${graceEmail}[\\s\\S]*MEMBER[\\s\\S]*joining Ada Org`),
        );
      },
    );

    await step("a short password is refused", async () => {
      await grace.page.fill("#create-form [name=password]", "short");
      const shown = await act(grace.page, () =>
        grace.page.click("#create-form button[type=submit]"),
      );
      assert.equal(shown.status, 400, shown.text);
      assert.match(
        await grace.page.locator("#outcome").innerText(),
        /password/,
      );
    });

    await step("Grace creates her account and is signed in", async () => {
      await grace.page.fill("#create-form [name=password]", PASSWORD);
      assertOk(
        await act(grace.page, () =>
          grace.page.click("#create-form button[type=submit]"),
        ),
        "accept",
      );
      assert.match(
        await grace.page.locator("#outcome").innerText(),
        new RegExp(`signed in as ${graceEmail}[\\s\\S]*MEMBER`),
      );
      await grace.page
        .locator("#identity strong")
        .filter({ hasText: graceEmail })
        .waitFor();
    });

    await step("the spent link is refused", async () => {
      const shown = await act(grace.page, () =>
        grace.page.click("#create-form button[type=submit]"),
      );
      assert.equal(shown.status, 400, shown.text);
      assert.equal(
        await grace.page.locator("#outcome .error-line").innerText(),
        "this invitation is invalid or has expired",
      );
    });

    await step("Grace, a MEMBER, is refused the invitation list", async () => {
      await open(grace.page, "/invites");
      assert.match(
        await grace.page.locator("#response-panel .status").innerText(),
        /^403/,
      );
      assert.equal(
        await grace.page.locator("#invites .error-line").innerText(),
        "only an owner or an admin can see invitations",
      );
    });

    await step("signed out, Carl's link asks for a sign-in", async () => {
      await open(guest.page, `/accept-invite-tester?token=${carlToken}`);
      const shown = await act(guest.page, () =>
        guest.page.click("#join-form button[type=submit]"),
      );
      assert.equal(shown.status, 401, shown.text);
      assert.match(
        await guest.page.locator("#outcome .note").innerText(),
        new RegExp(`Sign in as ${carl.email}`),
      );
    });

    await step("Ada cannot spend Carl's invitation", async () => {
      await open(ada.page, `/accept-invite-tester?token=${carlToken}`);
      assert.match(
        await ada.page.locator("#invite-summary").innerText(),
        new RegExp(`${carl.email}[\\s\\S]*ADMIN`),
      );
      const shown = await act(ada.page, () =>
        ada.page.click("#join-form button[type=submit]"),
      );
      assert.equal(shown.status, 403, shown.text);
      assert.equal(
        await ada.page.locator("#outcome .error-line").innerText(),
        "this invitation is for a different account",
      );
    });

    await step("Carl joins Ada Org with his signed-in account", async () => {
      await open(carl.page, `/accept-invite-tester?token=${carlToken}`);
      assertOk(
        await act(carl.page, () =>
          carl.page.click("#join-form button[type=submit]"),
        ),
        "join",
      );
      assert.match(
        await carl.page.locator("#outcome").innerText(),
        /joined Ada Org[\s\S]*ADMIN/,
      );
    });

    await step(
      "Carl picks Ada Org and invites Yul into it as ADMIN",
      async () => {
        await open(carl.page, "/invites");
        const shown = await act(carl.page, () =>
          carl.page.selectOption("#org-select", adaOrgId),
        );
        assertOk(shown, "list");
        assert.match(
          await carl.page.locator("#response-panel .badge").innerText(),
          new RegExp(`organizationId=${adaOrgId}`),
        );
        assert.equal(
          await carl.page.locator("#invites").innerText(),
          "nothing pending",
        );

        assertOk(await sendFromForm(carl.page, yulEmail, "ADMIN"), "send");
        assert.match(
          await carl.page.locator("#response-panel").textContent(),
          new RegExp(`"organizationId": "${adaOrgId}"`),
        );
        assert.match(
          await inviteRow(carl.page, yulEmail).innerText(),
          /ADMIN[\s\S]*Carl Tester/,
        );
      },
    );

    // Only OWNER and ADMIN seats are billable: Ada, Carl and Yul fill all 3.
    await step("Yul accepts and takes the last seat", async () => {
      const yul = await visitor(run);
      everyone.push(yul);
      await open(
        yul.page,
        `/accept-invite-tester?token=${await inviteToken(yulEmail)}`,
      );
      await yul.page.fill("#create-form [name=password]", PASSWORD);
      assertOk(
        await act(yul.page, () =>
          yul.page.click("#create-form button[type=submit]"),
        ),
        "accept",
      );
      assert.match(await yul.page.locator("#outcome").innerText(), /ADMIN/);
    });

    await step("Ada Org is full, so Xia's accept is refused", async () => {
      // Carl's page still has Ada Org picked.
      assertOk(await sendFromForm(carl.page, xiaEmail, "ADMIN"), "send");
      const xia = await visitor(run);
      everyone.push(xia);
      await open(
        xia.page,
        `/accept-invite-tester?token=${await inviteToken(xiaEmail)}`,
      );
      await xia.page.fill("#create-form [name=password]", PASSWORD);
      const shown = await act(xia.page, () =>
        xia.page.click("#create-form button[type=submit]"),
      );
      assert.equal(shown.status, 409, shown.text);
      assert.match(
        await xia.page.locator("#outcome .note").innerText(),
        /no seats left/,
      );
    });

    await step("Carl revokes Xia's invitation in Ada Org", async () => {
      const shown = await act(carl.page, () =>
        inviteRow(carl.page, xiaEmail)
          .locator("button[data-action=revoke]")
          .click(),
      );
      assertOk(shown, "revoke");
      assert.match(
        await carl.page.locator("#response-panel").textContent(),
        new RegExp(`"organizationId": "${adaOrgId}"`),
      );
      assert.equal(
        await carl.page.locator("#invites").innerText(),
        "nothing pending",
      );
    });

    // Workspace and ownership mails, made through the API, for the inbox.
    const [dora, eve] = await step("Dora and Eve sign up", () =>
      Promise.all([person(run, "Dora"), person(run, "Eve")]),
    );
    everyone.push(dora, eve);

    const tokens = await step(
      "Dora invites Eve to a workspace and offers her ownership",
      async () => {
        const doraOrgId = (await callApi(dora, "GET", "/auth/profile/get")).user
          .organizationId;
        const eveId = (await callApi(eve, "GET", "/auth/profile/get")).user.id;
        const { workspaceId } = await callApi(
          dora,
          "POST",
          `/organizations/${doraOrgId}/workspaces`,
          { name: "Harbor", timezone: "UTC" },
        );
        await callApi(dora, "POST", `/workspaces/${workspaceId}/invites`, {
          recipients: [eve.email],
          wsRole: "EDITOR",
        });
        const invite = (
          await mail(eve.email, "WORKSPACE_INVITE")
        ).payload.inviteLink.split("#")[1];
        await callApi(eve, "POST", "/invites/accept", { token: invite });
        await callApi(dora, "POST", "/auth/identity/confirm", {
          action: "WORKSPACE_OWNERSHIP_TRANSFER",
          password: PASSWORD,
        });
        await callApi(
          dora,
          "POST",
          `/workspaces/${workspaceId}/ownership-transfer`,
          {
            toUserId: eveId,
            confirmName: "Harbor",
          },
        );
        const offer = (
          await mail(eve.email, "OWNERSHIP_TRANSFER")
        ).payload.transferLink.split("#")[1];
        await callApi(eve, "POST", "/ownership-transfers/accept", {
          token: offer,
        });
        return { invite: invite, offer: offer };
      },
    );

    await step(
      "Eve's inbox shows her code, workspace invite and offer",
      async () => {
        await open(eve.page, "/inbox");
        await eve.page.fill("#filter-email", eve.email);
        assertOk(
          await act(eve.page, () =>
            eve.page.click("#filter-form button[type=submit]"),
          ),
          "filter",
        );
        assert.equal(
          new URL(eve.page.url()).searchParams.get("email"),
          eve.email,
        );

        const verify = eve.page.locator("#rows tr[data-type=VERIFY]");
        assert.equal(
          await verify.locator(".code").innerText(),
          (await mail(eve.email, "VERIFY")).payload.code,
        );
        assert.match(
          await verify
            .locator("a[data-link=verificationLink]")
            .getAttribute("href"),
          new RegExp(`^${HARNESS}/verify-email\\?token=.+&email=`),
        );

        const invite = eve.page.locator("#rows tr[data-type=WORKSPACE_INVITE]");
        assert.match(await invite.innerText(), /Harbor[\s\S]*EDITOR/);
        assert.equal(
          await invite.locator("a[data-link=inviteLink]").getAttribute("href"),
          `${HARNESS}/invite#${tokens.invite}`,
        );

        const offer = eve.page.locator(
          "#rows tr[data-type=OWNERSHIP_TRANSFER]",
        );
        const offerLink = offer.locator("a[data-link=transferLink]");
        assert.equal(
          await offerLink.innerText(),
          "review the ownership offer →",
        );
        assert.equal(
          await offerLink.getAttribute("href"),
          `${HARNESS}/ownership#${tokens.offer}`,
        );
      },
    );

    await step("Dora's inbox shows the handover notice's payload", async () => {
      await open(dora.page, `/inbox?email=${encodeURIComponent(dora.email)}`);
      const notice = dora.page.locator(
        "#rows tr[data-type=OWNERSHIP_TRANSFERRED]",
      );
      assert.match(await notice.innerText(), /toName\s+Eve Tester/);
      assert.match(await notice.innerText(), /workspaceName\s+Harbor/);
      assert.equal(
        await notice.locator("a[data-link=appLink]").getAttribute("href"),
        `${HARNESS}/`,
      );
    });

    await step("no page threw", () =>
      everyone.forEach((someone) => assert.deepEqual(someone.errors, [])),
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await run?.finish();
  }
  process.exit(failed ? 1 : 0);
})();
