# chakra dummy UI

A plain test harness for the chakra API. It is not the real frontend. It
lets a person drive every auth and workspace flow by hand and see exactly what
the server answered.

It has two parts, served by one small Node server:

- **The workspace app** at `/`: sign in, the workspace picker, and inside a
  workspace the sidebar, projects, members and settings.
- **The tester pages** at `/account`: one plain page per area (account,
  two-factor, sessions, org invites, edge cases, google, me, organizations,
  workspace, invitations, members, ownership, projects, billing, api tokens,
  webhooks, audit log), linked from a shared top nav.

`PLAN.md` has the full design and what each page covers.

## Where it must live

The server and the e2e scripts import from the chakra backend (`../backend`),
so clone this repo into the chakra checkout as `dummy-frontend/`:

```
chakra/
├── backend/
└── dummy-frontend/   ← this repo
```

chakra's own `.gitignore` already ignores `dummy-frontend/`.

## Run

```bash
cd chakra/dummy-frontend
npm install
```

Start the chakra API on `:3000` (and the mock on `:4003` for the modes that
use it), then pick a mode:

| Command | Port | Where calls go |
| --- | --- | --- |
| `npm start` | 3001 | every call to the real API on :3000 |
| `npm run start:hybrid` | 3002 | the real API, except routes built nowhere yet, which go to the mock |
| `PORT=3003 ROUTING=split MOCK_TARGET=http://localhost:4003 API_TARGET=http://localhost:3000 node server.js` | 3003 | routes live on the deployed API go to the real API, the rest to the mock |
| `npm run start:mock` | 3002 | every call to the mock |

The browser only ever talks to this server; everything under `/api` is proxied,
so the auth cookie stays first-party. Every answer carries an
`x-harness-upstream` header saying which side served it.

The **dev inbox** (`/inbox`) reads emailed codes and links straight from a
local Mongo. It refuses to run when the API is not on this machine, so it never
reads a shared database.

## End-to-end scripts

Playwright scripts in `e2e/` drive the app through the UI only:

```bash
npx playwright install chromium   # once
node e2e/app.e2e.mjs              # SHOTS=<dir> saves a screenshot per screen
```
