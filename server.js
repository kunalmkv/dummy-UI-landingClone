// Static file server + API proxy for the manual auth test harness.
//
// Deliberately dependency-free and deliberately dumb. It exists for three
// reasons the browser gives us no way around:
//
//  1. The auth cookie needs a real http:// origin. Opening the pages as
//     file:// gives them an opaque origin, which means no cookie is ever
//     stored and every request fails in a way that looks like a server bug.
//  2. The backend's CORS whitelist names http://localhost:3001 specifically,
//     and the emailed links point at that same origin — so the port is not a
//     free choice.
//  3. ⚠️ A remote API cannot be called straight from the page. The session
//     cookie is SameSite=lax (auth.config.js), so the browser refuses to send
//     it on a cross-site fetch — login would appear to work and every call
//     after it would answer 401. Everything under /api is therefore proxied
//     through this origin, which makes the cookie first-party again. CORS is
//     not the blocker here and allowing the origin would not have fixed it.
//
// Routing (ROUTING=live, the default): every call goes to API_TARGET, the
// real API. ROUTING=split sends the routes the mock's catalog calls live to
// API_TARGET and the rest to MOCK_TARGET; ROUTING=hybrid keeps everything on the
// real API except the routes the catalog calls planned (built nowhere yet), which
// go to the mock; ROUTING=mock sends everything to the mock. Every answer is
// tagged x-harness-upstream.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

import mongoDatabaseEnum from "../backend/enum/mongo-database.enum.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

// ⚠️ mongoose PLURALIZES model names into collection names, so the backend's
// `email` model lives in a collection called `emails`. Reading the singular
// name returns zero rows and no error, which looks exactly like an empty
// outbox. (The backend's own test suite had this bug — see the leak detector.)
const OUTBOX_COLLECTION = "emails";
// Taken from the backend's own enum: this was once hardcoded "backend" and
// silently read an empty database after the rename.
const BACKEND_DATABASE = mongoDatabaseEnum.MASTER;

// 3001 is not a free choice — see the header comment. PORT only exists so a
// second instance can run beside it, e.g. one pointed at the mock.
const PORT = Number(process.env.PORT ?? 3001);

// Which API the harness drives. The workspace layer is built only on the
// feat-workspace-spine branch, so the default is that master run locally;
// `API_TARGET=https://master.insidefi.net` drives the deployed one (auth only).
const API_TARGET = (
  process.env.API_TARGET ?? "http://localhost:3000"
).replace(/\/+$/, "");

// Where routes that have not shipped answer. The mock serves every documented
// route at its real path, so the base URL is the only thing that differs.
const MOCK_TARGET = (
  process.env.MOCK_TARGET ?? "https://mocks.insidefi.net"
).replace(/\/+$/, "");

// live (default): every call goes to API_TARGET. split: a live route goes to
// API_TARGET and everything else to the mock. mock: every call to the mock.
const ROUTING = process.env.ROUTING ?? "live";

// Everything the page calls is same-origin under this prefix and forwarded on.
const API_PREFIX = "/api";

// The mock's catalog says which routes are live; read once, re-read on demand.
const ROUTE_TABLE_RETRY_MS = 30 * 1000;
let routeTable = [];
let routeTableLoadedAt = 0;

// ⚠️ The mock only checks that a cookie is present. Sending it a placeholder
// keeps the real session token from ever leaving for another service.
const SESSION_COOKIE_NAMES = ["chakra_auth_token", "mfa_token"];

/**
 * Is the API we proxy to running on this machine?
 *
 * @returns {boolean}
 */
function isLocalTarget() {
  const { hostname } = new URL(API_TARGET);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Make an upstream Set-Cookie storable by a browser on http://localhost:3001.
 *
 * Three rewrites, each for a reason that otherwise costs an hour:
 *   Secure    — dropped, or the browser discards the cookie on plain http.
 *   Domain    — dropped, so the cookie belongs to localhost and not the API's
 *               host, which the browser would refuse to set from here anyway.
 *   SameSite  — forced to Lax: the page and the proxy are now one site.
 *   Path      — prefixed with /api, because the MFA cookie is scoped to
 *               /auth/mfa and would never be sent to /api/auth/mfa/verify.
 *
 * @param {string} cookie one Set-Cookie header value
 * @returns {string} the rewritten value
 */
function rewriteSetCookie(cookie) {
  const [pair, ...attributes] = cookie.split(";");
  const kept = [];

  for (const attribute of attributes) {
    const trimmed = attribute.trim();
    const name = trimmed.split("=")[0].toLowerCase();

    if (name === "secure" || name === "domain" || name === "samesite") {
      continue;
    }

    if (name === "path") {
      const value = trimmed.slice(trimmed.indexOf("=") + 1);
      kept.push(
        value === "/" ? "Path=/" : `Path=${API_PREFIX}${value}`,
      );
      continue;
    }

    kept.push(trimmed);
  }

  return [pair, ...kept, "SameSite=Lax"].join("; ");
}

/**
 * Read the mock's catalog into a route table: method, a path regex, and the
 * route's lifecycle (live, in-review or planned).
 *
 * @returns {Promise<boolean>} false when the catalog could not be read
 */
async function loadRouteTable() {
  routeTableLoadedAt = Date.now();
  try {
    const answer = await fetch(`${MOCK_TARGET}/mock/endpoints`, {
      signal: AbortSignal.timeout(10000),
    });
    const endpoints = (await answer.json()).result.data.endpoints;
    routeTable = endpoints
      .map((endpoint) => ({
        method: endpoint.method,
        regex: new RegExp(
          `^${endpoint.path.replace(/:[A-Za-z]+/g, "[^/]+")}/?$`,
        ),
        // Fewer :params first, so /workspaces/slug-available beats
        // /workspaces/:workspaceId — the same order the mock mounts them in.
        params: (endpoint.path.match(/:/g) ?? []).length,
        status: endpoint.status,
      }))
      .sort((left, right) => left.params - right.params);
    return true;
  } catch (error) {
    console.log(
      `⚠  could not read ${MOCK_TARGET}/mock/endpoints (${error.message}) — every call goes to ${API_TARGET} until it can`,
    );
    return false;
  }
}

/**
 * Which server answers this call, and why.
 *
 * @param {string} method
 * @param {string} pathname the path after /api, no query
 * @returns {{base: string, side: string, routeStatus: string}}
 */
function pickUpstream(method, pathname) {
  const route =
    routeTable.find((one) => one.method === method && one.regex.test(pathname)) ??
    // A wrong method still goes to the side that owns the path, so its 405 answers.
    routeTable.find((one) => one.regex.test(pathname));
  const routeStatus = route?.status ?? "unknown";

  // The mock's own routes (its catalog) exist only there.
  if (ROUTING === "mock" || pathname.startsWith("/mock/")) {
    return { base: MOCK_TARGET, side: "mock", routeStatus: routeStatus };
  }
  // Hybrid: the real API answers everything that is built (even unmerged, in
  // review); only a route that exists nowhere yet falls to the mock.
  if (ROUTING === "hybrid") {
    return route?.status === "planned"
      ? { base: MOCK_TARGET, side: "mock", routeStatus: routeStatus }
      : { base: API_TARGET, side: "live", routeStatus: routeStatus };
  }
  // An unknown route goes live: that is where a 404 means something.
  if (ROUTING === "live" || route === undefined || route.status === "live") {
    return { base: API_TARGET, side: "live", routeStatus: routeStatus };
  }
  return { base: MOCK_TARGET, side: "mock", routeStatus: routeStatus };
}

/**
 * The Cookie header with every session cookie's value swapped for a
 * placeholder — for the mock, which only checks the cookie is there.
 *
 * @param {string} cookieHeader
 * @returns {string}
 */
function withPlaceholderSession(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((pair) => {
      const name = pair.split("=")[0].trim();
      return SESSION_COOKIE_NAMES.includes(name) ? `${name}=harness` : pair.trim();
    })
    .join("; ");
}

/**
 * Read a request's body as a buffer.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<Buffer>}
 */
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Hop-by-hop and connection headers never survive a proxy hop.
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
]);

/**
 * Forward one /api call upstream and copy the answer back, cookies included.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} pathname the path after /api
 * @param {string} query the query string, without "?"
 * @returns {Promise<void>}
 */
async function proxyToApi(request, response, pathname, query) {
  if (
    ROUTING !== "live" &&
    routeTable.length === 0 &&
    Date.now() - routeTableLoadedAt > ROUTE_TABLE_RETRY_MS
  ) {
    await loadRouteTable();
  }
  const { base, side, routeStatus } = pickUpstream(request.method, pathname);
  const pathWithQuery = query ? `${pathname}?${query}` : pathname;

  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(name)) {
      headers[name] = value;
    }
  }
  if (side === "mock" && typeof headers.cookie === "string") {
    headers.cookie = withPlaceholderSession(headers.cookie);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream;
  try {
    upstream = await fetch(base + pathWithQuery, {
      method: request.method,
      headers: headers,
      body: hasBody ? await readBody(request) : undefined,
      // A JSON API should never redirect; following one silently would turn a
      // misconfiguration into a confusing 200.
      redirect: "manual",
    });
  } catch (error) {
    response.writeHead(502, {
      "Content-Type": "application/json",
      "x-harness-upstream": side,
      "x-harness-route-status": routeStatus,
    });
    response.end(
      JSON.stringify({
        error: `proxy could not reach ${base} — ${error.message}`,
      }),
    );
    return;
  }

  // fetch already decompressed the body, so the upstream encoding and length
  // both describe bytes we are no longer sending. Node recomputes the length.
  const DROP = new Set(["set-cookie", "content-encoding", "content-length"]);

  const outHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP.has(name)) {
      outHeaders[name] = value;
    }
  });

  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) {
    outHeaders["set-cookie"] = cookies.map(rewriteSetCookie);
  }

  // So the page can say which server answered — live and mock look identical.
  outHeaders["x-harness-upstream"] = side;
  outHeaders["x-harness-route-status"] = routeStatus;

  response.writeHead(upstream.status, outHeaders);
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Paths a mail points at. The app serves them all; its router reads ?token= or #token.
const APP_LINK_PATHS = new Set(["/invite", "/login", "/verify-email", "/reset-password", "/magic-link", "/preview", "/confirm-email"]);

/**
 * Turn a request path into a file on disk, or null.
 *
 * Extensionless paths resolve to `<name>.html`, so a tester page at
 * /reset-password-tester is a file called reset-password-tester.html. The paths
 * a mail points at (APP_LINK_PATHS) are the app's, not a file's.
 *
 * @param {string} urlPath the pathname from the request
 * @returns {Promise<string|null>} an absolute file path, or null when nothing matches
 */
async function resolveFile(urlPath) {
  // Every emailed link opens the app; the old testers are at <path>-tester.
  const cleaned = urlPath === "/" || APP_LINK_PATHS.has(urlPath) ? "/index.html" : urlPath;

  const candidates = path.extname(cleaned)
    ? [cleaned]
    : [`${cleaned}.html`, path.join(cleaned, "index.html")];

  for (const candidate of candidates) {
    const filePath = path.join(PUBLIC_DIR, candidate);

    // ⚠️ Path traversal guard. `path.join` happily resolves "../../etc/passwd";
    // only comparing the RESOLVED path against the root catches it. This binds
    // to localhost only, but a dev tool that serves arbitrary files is still a
    // dev tool that serves arbitrary files.
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      return null;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.isFile()) {
        return filePath;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

// Opened lazily and kept, so the inbox does not pay a connect per poll.
let mongoClient = null;

/**
 * The outbox, newest first.
 *
 * ⚠️ This reads live verify, reset and magic-link tokens for any address —
 * which is a complete authentication bypass in the wrong place. It lives HERE,
 * in a package that is never deployed and binds to 127.0.0.1, rather than in
 * the backend, so the shipped API has no such endpoint to accidentally expose.
 * Do not move it into `backend/`.
 *
 * @param {URLSearchParams} query optional `email` filter
 * @returns {Promise<object[]>} outbox rows, newest first
 */
async function readOutbox(query) {
  if (mongoClient === null) {
    // The backend keeps its connection string here. ⚠️ LOCAL, the database a
    // local API writes to — never DEV, whose outbox holds real people's tokens.
    // dev's env.config.js has no LOCAL_MONGO_URL, so fall back to the local box.
    const { default: envConfig } = await import("../backend/env.config.js");
    mongoClient = new MongoClient(
      envConfig.LOCAL_MONGO_URL ?? "mongodb://127.0.0.1:27017",
    );
    await mongoClient.connect();
  }

  const filter = {};
  const email = query.get("email");
  if (email) {
    filter.to = { $regex: email, $options: "i" };
  }

  return mongoClient
    .db(BACKEND_DATABASE)
    .collection(OUTBOX_COLLECTION)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(40)
    .toArray();
}

const server = http.createServer(async (request, response) => {
  // The second argument is only there to satisfy the URL parser; nothing reads
  // the host.
  const { pathname, searchParams } = new URL(
    request.url,
    `http://localhost:${PORT}`,
  );

  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    const rest = pathname.slice(API_PREFIX.length) || "/";
    await proxyToApi(request, response, rest, searchParams.toString());
    return;
  }

  // What the page prints in its banner, so nobody mistakes production for a
  // local API after a reload.
  if (pathname === "/dev/target") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        target: API_TARGET,
        mock: MOCK_TARGET,
        routing: ROUTING,
        liveRoutes: routeTable.filter((one) => (ROUTING === "hybrid" ? one.status !== "planned" : one.status === "live")).length,
        mockRoutes: routeTable.filter((one) => (ROUTING === "hybrid" ? one.status === "planned" : one.status !== "live")).length,
        local: isLocalTarget(),
      }),
    );
    return;
  }

  if (pathname === "/dev/outbox") {
    // ⚠️ Refused against a remote API on purpose. This reader pulls live
    // verify, reset and magic-link tokens straight out of Mongo; pointing it
    // at a shared or production database would hand over real people's
    // accounts. Read those mails from the real inbox instead.
    if (!isLocalTarget()) {
      response.writeHead(409, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error:
            `the dev outbox is disabled while the harness points at ${API_TARGET} — ` +
            "it reads live tokens from Mongo and must never read a shared database. " +
            "Open the real mailbox, then paste the token into the page.",
        }),
      );
      return;
    }

    try {
      const rows = await readOutbox(searchParams);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(rows));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const filePath = await resolveFile(pathname);

  if (filePath === null) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`no page for ${pathname}`);
    return;
  }

  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    // Every reload should show the file as it is on disk. Caching a harness
    // you are actively editing wastes more time than it saves.
    "Cache-Control": "no-store",
  });
  response.end(body);
});

if (ROUTING !== "live") {
  await loadRouteTable();
}

// 127.0.0.1, never 0.0.0.0 — nothing here is meant to be reachable from
// another machine.
server.listen(PORT, "127.0.0.1", () => {
  const live = routeTable.filter((one) => one.status === "live").length;
  console.log(`dummy-frontend  →  http://localhost:${PORT}`);
  console.log(`routing         →  ${ROUTING}`);
  if (ROUTING === "split") {
    console.log(`  live routes   →  ${API_TARGET}  (${live})`);
    console.log(`  the rest      →  ${MOCK_TARGET}  (${routeTable.length - live})`);
  } else if (ROUTING === "hybrid") {
    const planned = routeTable.filter((one) => one.status === "planned").length;
    console.log(`  everything built →  ${API_TARGET}  (${routeTable.length - planned})`);
    console.log(`  planned routes   →  ${MOCK_TARGET}  (${planned})`);
  } else {
    console.log(`  every call    →  ${ROUTING === "mock" ? MOCK_TARGET : API_TARGET}`);
  }
  if (ROUTING !== "mock" && !isLocalTarget()) {
    console.log("");
    console.log("⚠️  THIS IS NOT A LOCAL API.");
    console.log("    Accounts, emails, rate limits and audit rows are real.");
    console.log("    The dev outbox is disabled; read mail from the inbox.");
    console.log("    Local instead:  npm start");
  }
});
