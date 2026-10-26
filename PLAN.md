# dummy-frontend — a manual test harness for the auth API

Not a product. A deliberately plain UI whose only job is to let a human drive every flow in
[`auth-system-design.md`](../docs/design-doc/auth-system-design.md) §5.9 by hand, including the failure paths,
and see exactly what the server said.

**It is a fourth, disposable package.** It is not the real `frontend/`, it does not share its code, and nothing
in `backend/` changes to support it.

---

## The workspace app at `/` (added 2026-10-12)

`http://localhost:3001/` is now a product-style app on the real API — not a
tester: sign in / create account (the emailed code fills itself in from the dev
inbox on a local API), a welcome screen for a new account (create a workspace,
join an invitation), the workspace picker, onboarding (starting app), and inside
a workspace a sidebar with the workspace switcher, a top bar with breadcrumb and
notifications, and Home (apps grid, get-started, recent projects), Projects,
Members (seats, invitations, roles, remove) and Settings (general with If-Match,
branding, roles matrix, billing and plans, API tokens, webhooks, audit log,
danger zone with password step-up).

Plain ES modules in `public/app/` (no build step); colours and type are the
product's design tokens from `design_lib`; icons are lucide 1.28.0, vendored in
`public/app/vendor/`. `e2e/app.e2e.mjs` drives it through the UI only
(`SHOTS=<dir>` saves a screenshot per screen).

The tester pages moved: their home is now **`/account`** (was `/`); every other
tester page keeps its URL, and the app's user menu links to them as
"Developer tools". The one exception is the workspace invite tester, now at
`/invite-tester` (below).

### The invite flow (added 2026-10-14)

- **The emailed link opens the app.** The mail's link is still
  `/invite#<token>`; `server.js` serves the app there and `main.js` rewrites it
  to `#/invite/<token>`. The old tester page takes the same token at
  `/invite-tester#<token>`, and the inbox shows a small "tester →" link beside
  the app one.
- **A new address signs up first.** The invite page sends them to the normal
  sign-up with `?invite=<token>`; the email is locked to the invited address,
  the code is confirmed, and they land back on the invite page signed in. The
  app never uses `/invites/accept`'s create-account path (the owner's call on
  2026-10-14: every invitee founds their own organization and verifies).
- **An existing address signs in** (email locked) and lands back the same way.
  Signed in as someone else, the page offers "Sign out and switch account".
- **One join action per surface.** The link page joins with
  `POST /invites/accept {token}`; the welcome screen, the picker and the new
  banner use `POST /me/invites/:id/accept`. Both end in the same backend join.
- **Existing users see it in the app.** Every workspace page shows a banner per
  pending invitation (Join, Decline, ✕ to hide it until reload), and the
  switcher's "All workspaces" carries a count.
- **Google.** Sign in and sign up show Google's button (`public/app/lib/google.js`). It works only on an
  origin registered on the client (localhost:3002 does; 3001 is refused). The app also handles the
  spine's older answers: "organization required" asks for a company name, "link required" says to
  sign in with the password.
- **Mail delivery.** Locally the mail lands in `/inbox` (no mail service runs).
  On dev it sends only once PR #173 deploys; the deployed sender has no
  `WORKSPACE_INVITE` template before that.

### Account & security, and every auth screen (added 2026-10-14)

The app now calls **every `/auth` route (33, counting the three planned ones in the account
module) and every `/me` route (23)**. `e2e/app-coverage.mjs` fails when one is not called, by method,
from `public/app`; `e2e/app-auth.e2e.mjs` and `e2e/app-me.e2e.mjs` drive them through the UI.

- **Account & security** (`#/account/<section>`, from the user menu): profile, change password,
  two-factor (set up with the QR and key, backup codes shown once, new codes, turn off), Google
  link and unlink, sessions (list, revoke, sign out everywhere), and organization invitations
  (send, list, revoke).
- **Sign in** also offers "Forgot your password?" and "Email me a sign-in link instead"; the
  two-step page has "Not you? Cancel this sign-in".
- **Emailed links open the app.** `/verify-email`, `/reset-password`, `/magic-link`,
  `/accept-invite?token=` and `/login` are served by the app (`APP_LINK_PATHS` in `server.js`);
  `main.js` turns each into its hash route. The bare API testers moved to `<path>-tester`
  (`/reset-password-tester` and so on), and the inbox shows a "tester →" link beside each link.
- **Confirm it's you** (`lib/identity.js`): before archive (ownership handover is gone, see below), a password,
  an authenticator code, or an emailed code (`/auth/identity/send-code`).
- On a local API, the pages that ask for mail (forgot, magic link, send-code) offer the link or
  code from the dev inbox, as the verify page already did.
- Google's button needs an origin registered on the client, and the API needs `GOOGLE_CLIENT_ID`.
- **The `/me` screens** (Account & security, the same `#/account/<section>` area): Profile (edit name,
  time zone and language; photo upload through `upload-url`, `commit` and delete; change email), Security
  activity (filterable, cursor paged), Preferences (appearance and density are applied to the page;
  do-not-disturb), Notifications (the account bell's list, and the category by channel matrix with quiet
  hours) and Terms, export and closing the account (30-day grace, cancel, the sole-owner refusal that
  points at the handover). The **account bell** and a **⌘K search** (`/me/search`) sit in the header of
  the welcome, picker, onboarding and account pages; inside a workspace the workspace bell stays. The
  workspace switcher reads `/me/workspaces`.
- **Hybrid routing.** Sixteen `/me` routes (and three `/auth` ones) are *planned*: the mock has them,
  no API does. `npm run start:hybrid` (port 3002, with the mock on :4003) sends only planned routes to
  the mock and everything built to the real API; a screen served from the mock says so ("Sample data").
  On the live-only harness (:3001) those screens say the API doesn't have the route yet, and the bell
  stays hidden. `ROUTING=hybrid` is in `server.js`; `e2e/app-me.e2e.mjs` runs against :3002.

### Pages and the GrapesJS editor (added 2026-10-15)

A project's name in Projects opens its pages (`#/w/<id>/projects/<projectId>/pages`):
status tabs with counts, search, a type filter, New page (blank or a template),
and a row menu for edit, settings, preview, duplicate, move, unpublish, archive
or restore, delete and undelete. The editor (`…/pages/<pageId>/edit`) is
GrapesJS 0.23.6 — the version `frontend/` pins — vendored in
`public/app/vendor/grapesjs-0.23.6/` and loaded only on that screen. It
autosaves the draft over the revision it loaded (a conflict shows a Reload
banner), publishes with `editor.getHtml()` / `getCss()`, restores versions into
the draft, and uploads dropped images to S3 through `…/pages/assets`. Settings
(`…/settings/seo|tracking|advanced|danger`) save with If-Match. A preview link
is `/preview#<token>`; the app turns it into `#/preview/<token>` and renders the
draft in a sandboxed frame, signed in or not. Image uploads need S3 set up on the
API and CORS on the bucket for this origin; without S3 the editor says so.

### The same app against the mock (added 2026-10-13)

`npm run start:mock` serves the app on `:3002` with every `/api` call sent to
the local mock on `:4003` (start it with `cd backend && node mock/mock.js`).
Any email and password sign in there. For the deployed mock instead, run
`PORT=3002 ROUTING=mock MOCK_TARGET=https://mocks.insidefi.net node server.js`
— it serves what was last deployed, so it lags the branch until a redeploy.

The app reads both shapes where the mock (the design) and PR #173 still
differ: `GET /me/bootstrap` lists organizations as `orgs` on the mock and
`organizations` on the spine (backend item B-1).

---

## Pointing it at a deployed API (added 2026-10-10)

```bash
npm start                                              # http://localhost:3000, the real API (default)
API_TARGET=https://master.insidefi.net npm start      # the deployed master (auth only)
```

The page no longer calls the API directly. Everything under **`/api`** is
proxied by `server.js` to `API_TARGET`, and the page only ever talks to
`http://localhost:3001`.

**That proxy is not a convenience — it is the only way this works.** The
session cookie is `SameSite=lax`, so a browser will not attach it to a
cross-site fetch. Called straight, `https://master.insidefi.net` would set
a cookie on login and then never receive it again: the login would look
fine and every call after it would answer 401. CORS is not the blocker and
whitelisting the origin would not have fixed it. Going through the proxy
makes the cookie first-party again.

The proxy rewrites each upstream `Set-Cookie`: drops `Secure` (the harness
is plain http), drops `Domain`, forces `SameSite=Lax`, and **prefixes
`Path`** — the MFA cookie is scoped to `/auth/mfa` and without that rewrite
it would never be sent to `/api/auth/mfa/verify`, breaking two-factor with
no visible cause.

What changes when the target is not local:

| | Local | Deployed |
|---|---|---|
| Red banner on every page | no | **yes**, naming the host |
| `/dev/outbox` | reads Mongo | **409, refused** — it pulls live verify/reset/magic-link tokens and must never read a shared database |
| Getting an emailed token | the dev inbox | the **real mailbox**; copy the token out of the link and paste it into the page |
| Emailed links | point at `localhost:3001` | point at the deployed web app, so they are not clickable into the harness |
| `npm run e2e` | runs | **refuses** — it deletes Mongo rows by email prefix |

⚠️ Accounts, emails, rate limits and audit rows created against a deployed
API are real.

---

## After sign-in: the real workspace API (updated 2026-10-12)

The workspace layer is built only on the `feat-workspace-spine` branch (PR #173,
not merged, not deployed), so the default target is that branch's master run
locally on `:3000` — every call, sign-in included, goes to the real API:

```bash
cd ../chakra-spine/backend && node master/master.js   # the real API, :3000
cd dummy-frontend && npm start                         # this harness, :3001
```

Other routings stay available: `ROUTING=split` sends the routes the mock's
catalog calls live to `API_TARGET` and the rest to `MOCK_TARGET`;
`ROUTING=mock` sends everything to the mock. Every answer carries
`x-harness-upstream` and the panel shows it as a **LIVE** or **MOCK** chip.

**`/flow`** walks the journey after sign-in in the app's own order (design
§5.14): profile → bootstrap and the landing decision (me.md's table) → picker
→ invitations → create workspace and onboarding → Apps home → first project →
invite the team → rename with `If-Match`. Ids carry from step to step, and the
opened workspace is remembered for every module page. Everything is saved, and
an invite sends real mail — the dev inbox shows it.

⚠️ The spine's `env.config.js` has local edits that remove its placeholder
`MFA_ENCRYPTION_KEY` and `WEBHOOK_KEK`: until they are back, two-factor setup
and webhook endpoints answer 500 locally. Nothing else needs them.

---

## What the backend already decided for us

Five facts found by reading the code, not assumed. Each one removes a choice.

| Fact | Consequence |
|---|---|
| `web-server.config.js` already whitelists **`http://localhost:3001`** with `credentials: true` | Serve on **3001** and CORS works with **zero backend changes**. Any other port needs a config edit |
| Emailed links point at `http://localhost:3001/verify-email`, `/reset-password`, `/magic-link`, `/accept-invite` | Those four paths must exist (the app owns them now; the old testers are `<path>-tester`), so a link from a real email is **directly clickable** into this harness |
| The cookie is `HttpOnly`, `SameSite` omitted (browser default `Lax`), `Secure` only in prod | `localhost:3001 → localhost:3000` is **same-site**, so `Lax` sends it and plain `http` keeps it. Every fetch needs `credentials: "include"` |
| `responseLib` answers **HTTP 200 for everything**; the real code is `body.status` | ⚠️ The client must never branch on `response.ok`. Reading the HTTP status would make every 401 and 409 look like a success |
| ⚠️ **`SMTP_HOST` is set locally, so mail is really sent** — not rendered to the console | Registering `test@example.com` sends a real message that bounces, against the shared 2,000/day Gmail cap (§9.1). **Tokens must come from the outbox, not from an inbox or the console** |

---

## Three decisions I need approval on

### 1. Stack: plain HTML + vanilla JS, no build step, no framework

One `.html` per page, one shared `api.js`, one `app.css`. No npm for the UI itself, no bundler, no
TypeScript. Edit a file, hit refresh.

*Why:* the harness exists to test the API. A build step means a thing that can break for reasons unrelated to
auth, and every minute spent debugging it is a minute not spent testing. React would also hide exactly what is
being sent, which is the thing under test.

*Cost:* no reactivity, so pages re-render by hand. At this size that is a few lines.

### 2. ⚠️ How the tester gets emailed tokens — a dev inbox, in THIS package

Four flows (verify, reset, magic link, invite) only work if the tester can read a token that only exists in
the `email` outbox collection. With SMTP configured, no inbox and no console will show it.

**Recommended — the dummy server reads Mongo itself.** `dummy-frontend/server.js` exposes
`GET /dev/outbox`, reading the outbox directly. The harness renders it as a fake inbox with clickable links.

⚠️ **Why not a backend endpoint:** an endpoint that hands out live verify, reset and magic-link tokens for any
address is a **complete authentication bypass** if it ever reaches an environment it should not. Guarding it
with `!isProdEnv()` puts one boolean between the API and total compromise. Putting the capability in a folder
that is never deployed removes it from the shipped surface entirely — the backend stays unaware this exists.

*Cost:* `dummy-frontend/` needs its own `package.json` with the `mongodb` driver and one `npm install`. It
reads the connection string from `../backend/env.config.js`. It binds to **127.0.0.1 only**.

*Alternative if you would rather not:* drop `/dev/outbox` and every page gets a "paste a token" box; you read
tokens out of Mongo yourself. Strictly worse to use, equally correct.

### 3. Google sign-in is last and optional

⚠️ **`GOOGLE_CLIENT_ID` is not set locally**, so flows J and L cannot be exercised at all until a Google OAuth
client exists and its id is in `env.config.js`. Phase 6 is written but only runnable after that. Everything
else works today.

---

## Phases

Each ends with something you can drive by hand. Nothing starts until the previous one is approved.

### Phase 1 — The shell, and proof the cookie works

The riskiest thing first: if credentialed CORS is wrong, nothing else can be built on it.

- `server.js` — static files, **extensionless routing** (`/verify-email` → `verify-email.html`), 127.0.0.1 only
- `api.js` — one `call()` wrapper: always `credentials: "include"`, always reads `body.status`, never
  `response.ok`; returns `{status, data, error}`
- A persistent **response panel** on every page: the request sent, the raw JSON back, and the decoded status
  name — this is the actual instrument, not decoration
- A **"who am I"** strip that calls `GET /auth/me` on load
- Pages: register, login, logout, me

**You verify:** register → the account appears `PENDING_VERIFICATION`; login is refused because it is
unverified; the response panel shows `UNAUTHORIZED`, not a browser error. Then in devtools, confirm
`chakra_auth_token` is set after a successful login and is **not** readable from `document.cookie`.

### Phase 2 — The dev inbox and the four link pages

- `GET /dev/outbox` in `server.js` + an inbox page: newest first, filter by address, each row a clickable link
- `/verify-email`, `/reset-password`, `/magic-link`, `/accept-invite` — each reads `?token=` and posts it

**You verify:** register → open the inbox → click the verify link → the account activates → login works. Then
replay the same link and watch it fail, which is the single-use guarantee. Then forgot-password → reset → the
old session is dead and the new password works.

### Phase 3 — Two-factor

- Setup (render the returned QR data-URI), enable, show the backup codes **once**
- The challenge screen: login stops here, the code goes in, the session appears
- Disable, regenerate backup codes

**You verify:** enable 2FA → log out → log in → you land on the challenge, not signed in. ⚠️ Then check
`document.cookie` shows no auth cookie at that point — holding a challenge is **not** being signed in. Use a
backup code and confirm it works exactly once.

### Phase 4 — Sessions and invitations

- Sessions list (device, IP, created, last seen) with revoke; sign-out-everywhere
- Invite create/list/revoke; the accept page completing a signup into an existing organization

**You verify:** sign in from two browsers, revoke one from the other, confirm only that one dies. Invite an
address, accept it in a private window, confirm the new user lands in the **same** organization as a `MEMBER`.

### Phase 5 — The edge cases this whole harness exists for

No new plumbing; screens for the paths that are hard to trigger and easy to get wrong.

- The **lockout**: five bad passwords, then the countdown and remaining-attempts the API returns
- ⚠️ **"Sign in with magic link instead" while locked out** — it must still work, which is the whole reason
  `MAGIC_REQUEST` is a separate counter
- The magic-link resend cooldown counting down
- Anti-enumeration: forgot-password and magic-link for a **non-existent** address must produce a
  byte-identical response — shown side by side so a difference is visible
- Expired and reused links; a 2FA code entered twice; wrong-organization invite revokes

**You verify:** the lockout countdown ticks down and clears on a password reset.

### Phase 6 — Google (optional, blocked)

Only once `GOOGLE_CLIENT_ID` is set: the Google button, sign-up, `linkRequired` on an existing account, linking
with a password, and unlinking refused when it would leave no way in.

---

## Out of scope, deliberately

No styling beyond legibility, no responsive layout, no build, no tests, no error boundaries, no state
management, no routing library. If a choice is between "nicer" and "less code", it takes less code.

## Notes

- `dummy-frontend/` should be gitignored or clearly marked as not-shipped — say which you prefer.
- ⚠️ Noticed while planning, unrelated: `backend/env.config.js` carries a **real dev Mongo credential** in a
  committed file. CI overwrites it from secrets, but the committed default is live. Worth a separate look.

---

## The workspace layer (added September 2026)

The auth pages above were the first part. A second set of pages covers the workspace API. They follow the
same rules: plain HTML, `/api.js` then `/ui.js`, the shared `<nav data-nav>`, the identity strip, and the
response panel on the right. Every page that acts on a workspace also has the **workspace picker**
(`#workspace-picker`). The picker reads `GET /me/workspaces` and remembers your pick across pages.

| Page | What it drives |
|---|---|
| `/me` | bootstrap, the switcher, last workspace, onboarding, notifications and marking them read |
| `/organization` | your organizations, one organization and its edit, org members (role, removal impact, remove, leave), the org's workspaces, and creating one with the slug check and vertical suggestions |
| `/workspace` | read, edit with `If-Match`, slug check, roles, capabilities, visit, apps and waitlist, branding, the command palette, resume, health, and archive (after a step-up) or restore |
| `/invitations` | preview, send, list, edit, resend, copy the link, revoke; your own invitations, accepted or declined |
| `/invite#<token>` | the mailed workspace invite; opens the app's invite page (see "The invite flow") |
| `/invite-tester#<token>` | the same token on the tester: look it up, then accept signed in, accept by signing up, or decline |
| `/verify-email-tester`, `/reset-password-tester`, `/magic-link-tester`, `/accept-invite-tester` | the old bare testers for the four emailed links; the real paths open the app |
| `/members` | the list and its filters, one member, the admin flag (PUT/DELETE `…/admins/:userId`), project roles (PUT `…/project-roles`), suspend and reactivate, removal impact then remove, leave, seats, presence |
| `/ownership` | retired on 2026-10-25: a note and a link to `/members` |
| `/projects` | list, create, read, rename, archive, and a project's people (list, place or change at EDITOR/READER, remove, invite into the project); can send an API token instead of the cookie |
| `/billing` | plans, the organization's billing, a plan change with its `Idempotency-Key`, extra seats |
| `/tokens` | mint (the secret shows once), try it as a bearer, the rate limit, revoke |
| `/webhooks` | the event and variable catalogue, endpoints, test, deliveries, redeliver, rotate the secret, edit, delete |
| `/audit` | the action list, the trail with every filter and paging, and the plan gate |

**Coverage:** every route in `backend/wiki/docs/*.docs.wiki.js` can be called from some page. That is 117
routes; health and sample are left out on purpose. This was last checked on 29 September 2026. When a route is
added to the docs, add it to the page it belongs to.

**The role model (2026-10-25):** the API was rewritten for project-level roles
(`docs/design-doc/workspace-system-design.md` §4.1). An organization has `OWNER` and `MEMBER`. A workspace member
carries `admin: true|false` and `projectRoles: [{ projectId, role: EDITOR|READER }]`; `accessLevel` is what that
resolves to (`ADMIN`, `EDITOR` or `READER`). An invitation grants either `admin: true` or `projectRoles`, never
both; accepting answers `{ workspaceId, accessLevel }`. Gone: `wsRole`, `projectAccess` (ALL/LIMITED), the
`OWNER/ADMIN/EDITOR/CREATOR/VIEWER` workspace roles, `PATCH …/members/:userId`, `…/project-access`, project
visibility, and every ownership-transfer route. The pages and e2e scripts here follow that model.

## The e2e checks

`e2e/` holds end-to-end checks. Each one drives the real pages in headless Chrome against the real API.

**To run one:** the API must be up on `:3000` — the spine's master, see above. This server must be
up on `:3001`. `wiki.e2e.mjs` also needs the wiki on `:4002`. Playwright is a devDependency (`npm install` fetches it; on this machine `node_modules/playwright`
is a link to `frontend/`'s copy). It drives the
installed Chrome. Then:

```bash
cd dummy-frontend && node e2e/<name>.e2e.mjs    # exit 0 = pass
```

⚠️ The scripts import the API's own test helpers from `../../backend`, which only
the spine branch has. With this checkout on another branch, run them from a
folder whose `backend` links to the spine's:

```bash
mkdir -p /tmp/e2e/node_modules && cd /tmp/e2e
ln -sfn ~/Desktop/adstia/chakra-spine/backend backend
ln -sfn ~/Desktop/adstia/chakra/dummy-frontend dummy-frontend
ln -sfn ~/Desktop/adstia/chakra/frontend/node_modules/playwright-core node_modules/playwright-core
node --preserve-symlinks --preserve-symlinks-main dummy-frontend/e2e/<name>.e2e.mjs
```

Each script takes between 20 seconds and 8 minutes; `whole-flow` takes about 7. They can run side by side,
because each run uses its own email prefix. ⚠️ Keep the lid open and run under `caffeinate -i`. If the laptop
sleeps, the API's heartbeat sees the long pause and kills the API, and every run fails.

**What they prove:**

- **Pages, not the API alone.** Every step fills a form or clicks a button, then checks two things: the status
  in the response panel, and something the page drew. Every script ends by checking that no page threw.
- **Emailed links work.** Mail is read from the dev outbox, and its link is opened on this harness.
- **Each page stands alone.** Setup people are made through the API (`person()`), so a page's check never
  depends on another page working.
- **Nothing is left behind.** `run.finish()` checks that the seat ledger still adds up, then deletes
  everything the run made, found by its email prefix.

| Script | Covers |
|---|---|
| `smoke` | the harness itself: a signed-in person shows in the identity strip |
| `auth-core`, `auth-extras`, `auth-invites` | the auth pages: account, two-factor, sessions, edge cases, Google, organization invites, the inbox |
| `organization`, `workspace`, `me` | the pages of the same name |
| `invitations` | `/invitations` and `/invite-tester`, for every way an invitee answers |
| `members` | the page of the same name: the admin flag, project roles, suspend, remove, leave |
| `ownership` | the retired page shows its note, and the removed routes answer nothing |
| `projects-billing-audit` | those three pages, with plan limits, the downgrade block, and the audit plan gate |
| `tokens-webhooks` | those two pages, with a minted token used as a bearer |
| `flow` | `/flow` from a brand-new account: No-workspace, create, onboarding, Apps home, a project, an invite that the invitee accepts on their own `/flow`, and a rename |
| `whole-flow` | one journey through the pages: sign up, workspace, invites, members, a token, a webhook, audit, archive and restore, leaving |
| `wiki` | the wiki's live tester (on `:4002`), not this harness |
| `app` | the workspace app at `/` through the UI only: sign up, welcome, onboarding, projects, members, settings, three invitees joining (from the mailed link after signing up, from the banner in their own workspace, from the welcome screen), the bell |
| `pages` | pages through the UI: the list, a page from a template, an edit in the GrapesJS canvas that autosaves, publish and versions, the preview tab, SEO settings, archive, restore and delete |
| `app-auth` | the app's account and sign-in screens through the UI: password change, forgot and reset, sign in and confirm by emailed link, sessions, two-factor with backup codes and "Not you?", the identity check by emailed code, organization invitations, Google linking |
| `app-me` | the `/me` screens and the planned `/auth` routes through the UI, on the hybrid harness (:3002): account bell, search, profile and photo, email change, security activity, preferences applied to the page, notification matrix, terms, export, closing the account, the switcher |
| `app-coverage` | static: every `/auth` and `/me` route in the mock catalog is called, with its own method, somewhere in `public/app` |
| `app-mock` | the same app against the mock (`HARNESS=http://localhost:3002`); records every `/api` call so a mock the UI cannot use shows up as a list |

**What they do not prove:** Google sign-in (no client id locally), real email delivery, and anything the API
does not show in its answers.

The "Out of scope" note above said "no tests". That was true for the auth phases; the workspace layer added
these checks.
