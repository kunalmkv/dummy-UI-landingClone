// What the app knows about the signed-in person and the open workspace.

import { get, ws } from "./api.js";

export const state = {
  user: null,
  bootstrap: null,
  workspace: null,
  caps: new Set(),
  dev: null,
};

export async function loadUser() {
  const result = await get("/auth/profile/get");
  state.user = result.ok ? result.data.user : null;
  return state.user;
}

export async function loadBootstrap() {
  const result = await get("/me/bootstrap");
  if (result.ok) {
    state.bootstrap = result.data;
  }
  return result;
}

export function myWorkspaces() {
  return state.bootstrap?.workspaces ?? [];
}

// The design and the mock call it orgs; PR #173 still sends organizations
// (backend item B-1). Read both until the spine renames it.
export function myOrganizations() {
  return state.bootstrap?.orgs ?? state.bootstrap?.organizations ?? [];
}

/** Is the caller the Owner of this organization? Archive and restore are theirs. */
export function ownsOrganization(orgId) {
  return myOrganizations().find((one) => one.id === orgId)?.orgRole === "OWNER";
}

/** The caller's role in a workspace, from the switcher list. */
export function roleIn(workspaceId) {
  return myWorkspaces().find((one) => one.id === workspaceId)?.role ?? null;
}

export async function loadWorkspace(workspaceId) {
  const result = await get(ws(workspaceId));
  if (result.ok) {
    state.workspace = result.data;
    state.caps = new Set(result.data.capabilities ?? []);
  }
  return result;
}

export function can(capability) {
  return state.caps.has(capability);
}

/** Is the API local? Then the dev inbox can fill emailed codes in. */
export async function devTarget() {
  if (state.dev === null) {
    try {
      state.dev = await (await fetch("/dev/target")).json();
    } catch {
      state.dev = { local: false };
    }
  }
  return state.dev;
}

export function signedOut() {
  state.user = null;
  state.bootstrap = null;
  state.workspace = null;
  state.caps = new Set();
}
