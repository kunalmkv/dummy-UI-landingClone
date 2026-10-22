// The only place that talks to the backend.
//
// Two rules live here so no page has to remember them:
//
//   1. credentials: "include" on EVERY call. Without it the browser neither
//      stores the Set-Cookie it gets back nor sends the cookie it already has,
//      and the whole session model silently does nothing.
//   2. The real status is body.status, never response.ok. responseLib answers
//      HTTP 200 for everything — a refused login, a duplicate email and a
//      server error all arrive as 200. Branching on response.ok would read
//      every one of them as success.

// Same-origin on purpose. server.js proxies everything under /api to whatever
// API it was started against (local master, or the deployed one).
//
// ⚠️ Do NOT put the API's real origin back here. The session cookie is
// SameSite=lax, so a cross-site fetch never carries it: login would look like
// it worked and every call after it would answer 401. The proxy exists to
// make the cookie first-party. See the header of server.js.
const API_ORIGIN = "/api";

// Mirrors backend/enum/res-status.enum.js. Only for display — nothing branches
// on the name, so a value missing here shows as the raw number rather than
// breaking a page.
const STATUS_NAMES = {
  200: "SUCCESS",
  201: "CREATED",
  202: "ACCEPTED",
  400: "VALIDATION_ERROR / BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

// Every status the API uses for "it worked". Creating things answers 201.
const SUCCESS_STATUSES = [200, 201, 202];

/**
 * The refusal as one readable line. Workspace routes send
 * { code, message, details }; auth routes send a plain string.
 *
 * @param {*} error result.error
 * @returns {string|null}
 */
function describeError(error) {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === "object") {
    return [error.code, error.message].filter(Boolean).join(" — ");
  }
  return String(error);
}

/**
 * Call the auth API.
 *
 * @param {string} method GET, POST, PATCH, PUT or DELETE
 * @param {string} path e.g. "/auth/session/login"
 * @param {object} [body] JSON body, omitted for GET
 * @param {object} [headers] extra request headers, e.g. If-Match
 * @returns {Promise<object>} a flattened result, plus everything the panel shows
 */
async function call(method, path, body, headers = {}) {
  const startedAt = performance.now();

  const options = {
    method: method,
    // ⚠️ Rule 1. See the header.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...headers },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let response;
  let payload;

  try {
    response = await fetch(API_ORIGIN + path, options);
  } catch (error) {
    // A CORS refusal reaches JavaScript as an opaque "Failed to fetch" with no
    // detail — deliberately, so a page cannot probe another origin. Say so,
    // because otherwise this looks like the server being down.
    return {
      ok: false,
      status: null,
      statusName: "NO RESPONSE",
      data: null,
      error: `${error.message} — the harness proxy at /api could not reach the API, or the server is down. Check the terminal running server.js for the real reason.`,
      request: { method: method, path: path, body: body ?? null, headers },
      raw: null,
      httpStatus: null,
      servedBy: null,
      ms: Math.round(performance.now() - startedAt),
    };
  }

  // Which server the proxy chose: live and mock answers look identical.
  const servedBy = {
    side: response.headers.get("x-harness-upstream"),
    routeStatus: response.headers.get("x-harness-route-status"),
  };

  const text = await response.text();
  try {
    payload = JSON.parse(text);
  } catch {
    // ⚠️ The server WAS reached — it just has no such route. The live API
    // answers an unmounted path with an HTML page, not the envelope.
    return {
      ok: false,
      status: null,
      statusName: `HTTP ${response.status} · NOT JSON`,
      data: null,
      error: `the ${servedBy.side ?? "upstream"} server answered HTTP ${response.status} with ${
        response.headers.get("content-type") ?? "no content type"
      }, not the JSON envelope — this route probably does not exist there yet`,
      request: { method: method, path: path, body: body ?? null, headers },
      raw: text.slice(0, 2000),
      httpStatus: response.status,
      servedBy: servedBy,
      ms: Math.round(performance.now() - startedAt),
    };
  }

  // ⚠️ Rule 2. The envelope is { result: { message, data, error }, status }.
  const status = payload?.status ?? null;
  const result = payload?.result ?? {};

  return {
    ok: SUCCESS_STATUSES.includes(status),
    status: status,
    statusName: STATUS_NAMES[status] ?? String(status),
    data: result.data ?? null,
    error: describeError(result.error),
    // The refusal's machine code and details, for pages that branch on them.
    errorCode: result.error?.code ?? null,
    errorDetails: result.error?.details ?? null,
    message: result.message ?? null,
    request: { method: method, path: path, body: body ?? null, headers },
    raw: payload,
    httpStatus: response.status,
    servedBy: servedBy,
    ms: Math.round(performance.now() - startedAt),
  };
}

const api = {
  call: call,
  get: (path, headers) => call("GET", path, undefined, headers),
  post: (path, body, headers) => call("POST", path, body ?? {}, headers),
  patch: (path, body, headers) => call("PATCH", path, body ?? {}, headers),
  put: (path, body, headers) => call("PUT", path, body ?? {}, headers),
  del: (path, body, headers) => call("DELETE", path, body ?? {}, headers),
};
