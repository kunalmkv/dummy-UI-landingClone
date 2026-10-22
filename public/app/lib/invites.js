// An emailed invitation rides through sign-up and sign-in as ?invite=<token>,
// so the person lands back on it signed in and joins from there.

import { post, query } from "./api.js";
import { go } from "./router.js";

// The token is base64url; anything else is not a link we sent.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function inviteFromQuery(params) {
  return TOKEN_PATTERN.test(params?.invite ?? "") ? params.invite : null;
}

export const invitePath = (token) => `/invite/${token}`;

/** An auth page's path, carrying the email and the invitation along. */
export const authPath = (page, params) => `/${page}${query(params)}`;

/** The invitation an auth page belongs to, or null when there is none or it can't be opened. */
export async function invitationFor(params) {
  const token = inviteFromQuery(params);
  if (!token) {
    return null;
  }
  const result = await post("/invites/lookup", { token: token });
  return result.ok ? { token: token, ...result.data } : null;
}

// A page to return to after signing in: an app path, never another site.
const NEXT_PATTERN = /^\/[A-Za-z0-9/_?=&%.-]*$/;

export function nextFromQuery(params) {
  const next = params?.next ?? "";
  return NEXT_PATTERN.test(next) && !next.startsWith("//") ? next : null;
}

/** After signing in: back to where they were headed, else the invitation, else the normal landing. */
export function afterAuth(token, next = null) {
  go(next ?? (token ? invitePath(token) : "/"));
}
