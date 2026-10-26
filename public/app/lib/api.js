// The real API, through the harness's same-origin /api proxy so the session
// cookie is first-party. Every answer is HTTP 200; the real status is in the body.

const FRIENDLY = {
  SLUG_TAKEN: "That URL is already taken.",
  SLUG_RESERVED: "That URL is reserved — pick another.",
  SEAT_LIMIT_REACHED: "There are no free seats left. Add seats in Billing first.",
  WORKSPACE_LIMIT_REACHED: "Your plan's workspace limit is reached. Upgrade the plan to add another.",
  ENTITLEMENT_REQUIRED: "Your plan doesn't include this. Upgrade in Billing.",
  APP_NOT_AVAILABLE: "That app isn't available in this workspace.",
  VERSION_CONFLICT: "Someone changed this meanwhile. The latest version is loaded — try again.",
  WORKSPACE_ARCHIVED: "This workspace is archived, so it is read-only.",
  ORGANIZATION_SUSPENDED: "This organization is suspended.",
  IDENTITY_CONFIRM_REQUIRED: "Confirm your password first.",
  NAME_MISMATCH: "The name you typed doesn't match the workspace name.",
  CANNOT_MODIFY_SELF: "You can't change your own membership here.",
  CANNOT_REMOVE_SELF: "You can't remove yourself — leave the workspace instead.",
  OWNER_IS_ADMIN: "The organization's owner is an admin of every workspace already.",
  ALREADY_MEMBER: "They are already a member.",
  INVITE_RATE_LIMITED: "Too many invitations just now — try again in a little while.",
  DOWNGRADE_BLOCKED: "You use more than that plan allows. Free some seats or workspaces first.",
  SEATS_BELOW_USAGE: "That is fewer seats than are in use.",
  SCOPE_ABOVE_ACTOR: "You can't give a token more access than you have.",
  RATE_LIMITED: "Too many requests — wait a moment and try again.",
  SIGN_IN_REQUIRED: "Sign in as the invited address to accept this invitation.",
  SIGN_UP_REQUIRED: "Create an account with the invited address first, then open the link again.",
  INVITE_EMAIL_MISMATCH: "This invitation is for a different email address.",
  INVITE_NOT_FOUND: "That invitation link isn't valid. It may have been replaced by a newer one.",
  INVITE_EXPIRED: "That invitation has expired. Ask to be invited again.",
  INVITE_REVOKED: "That invitation was withdrawn.",
  INVITE_NOT_PENDING: "That invitation was already answered.",
};

const PERMISSION = "you do not have permission to do that";

function sentence(text) {
  const value = String(text ?? "Something went wrong").trim();
  return value.charAt(0).toUpperCase() + value.slice(1) + (/[.!?]$/.test(value) ? "" : ".");
}

function friendlyError(error) {
  if (error && typeof error === "object") {
    return FRIENDLY[error.code] ?? sentence(error.message ?? error.code);
  }
  if (typeof error === "string" && /no such route/i.test(error)) {
    return "This API doesn't have that route yet. Run the harness in hybrid mode to use the mock for it.";
  }
  if (error === PERMISSION) {
    return "Your role can't do this here.";
  }
  return sentence(error);
}

/**
 * Call the API.
 *
 * @returns {Promise<{ok: boolean, status: number, data: *, error: string|null, code: string|null, details: object}>}
 */
export async function api(method, path, body, headers = {}) {
  const init = { method: method, credentials: "same-origin", headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    return { ok: false, status: 0, data: null, code: null, details: {}, error: "Can't reach the server. Is the API running?" };
  }
  let envelope = null;
  try {
    envelope = await response.json();
  } catch {
    envelope = null;
  }
  if (envelope === null || typeof envelope.status !== "number") {
    // Express answers a route it doesn't have with a plain 404 page, not the envelope.
    const missing = response.status === 404;
    return {
      ok: false,
      status: response.status,
      data: null,
      code: null,
      details: {},
      error: missing ? friendlyError("no such route") : `The server answered something unexpected (HTTP ${response.status}).`,
      upstream: response.headers.get("x-harness-upstream"),
    };
  }
  const status = envelope.status;
  const rawError = envelope.result?.error ?? null;
  const ok = status >= 200 && status < 300;
  const result = {
    ok: ok,
    status: status,
    data: envelope.result?.data ?? null,
    code: rawError && typeof rawError === "object" ? rawError.code ?? null : null,
    details: rawError && typeof rawError === "object" ? rawError.details ?? {} : {},
    error: ok ? null : friendlyError(rawError),
    rawError: rawError,
    // Which side answered: "live" (the real API) or "mock", from the harness.
    upstream: response.headers.get("x-harness-upstream"),
  };
  // A session that ended elsewhere: send the person back to sign in.
  if (status === 401 && rawError === "not signed in" && !path.startsWith("/auth/")) {
    window.dispatchEvent(new CustomEvent("session-ended"));
  }
  return result;
}

export const get = (path) => api("GET", path);
export const post = (path, body = {}, headers) => api("POST", path, body, headers);
export const patch = (path, body = {}, headers) => api("PATCH", path, body, headers);
export const put = (path, body = {}, headers) => api("PUT", path, body, headers);
export const del = (path) => api("DELETE", path);

/** Path under the current workspace. */
export const ws = (workspaceId, rest = "") => `/workspaces/${encodeURIComponent(workspaceId)}${rest}`;

/** A query string from an object, skipping empty values. */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, value);
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
