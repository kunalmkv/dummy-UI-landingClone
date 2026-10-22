// Shared page furniture: the identity strip, the response panel, and form
// wiring. Every page loads this after api.js.

/**
 * Render the result of a call into the response panel.
 *
 * The panel is the instrument this harness exists to provide — it shows what
 * was sent, what came back, and the decoded status, so a refusal can be told
 * from a bug without opening devtools.
 *
 * @param {object} result whatever api.call returned
 * @returns {void}
 */
function showResult(result) {
  const panel = document.getElementById("response-panel");
  const tone = result.ok ? "ok" : result.status === null ? "dead" : "refused";

  panel.className = `panel ${tone}`;
  panel.innerHTML = `
    <div class="panel-head">
      <span class="badge">${result.request.method} ${escapeHtml(result.request.path)}</span>
      ${servedByChip(result.servedBy)}
      <span class="status">${result.status ?? "—"} ${escapeHtml(result.statusName)}</span>
      <span class="muted">${result.ms}ms${
        result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""
      }</span>
    </div>
    ${
      result.error
        ? `<p class="error-line">${escapeHtml(result.error)}</p>`
        : ""
    }
    <details${result.ok ? "" : " open"}>
      <summary>request body</summary>
      <pre>${escapeHtml(JSON.stringify(result.request.body, null, 2))}</pre>
    </details>
    ${
      Object.keys(result.request.headers ?? {}).length
        ? `<details open>
      <summary>request headers</summary>
      <pre>${escapeHtml(JSON.stringify(result.request.headers, null, 2))}</pre>
    </details>`
        : ""
    }
    <details open>
      <summary>raw response</summary>
      <pre>${escapeHtml(JSON.stringify(result.raw, null, 2))}</pre>
    </details>
  `;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * A chip naming the server that answered: LIVE, or MOCK with the route's
 * lifecycle. Mock data is example data, so it must never pass for real.
 *
 * @param {{side: string, routeStatus: string}|null} servedBy
 * @returns {string} HTML, empty when unknown
 */
function servedByChip(servedBy) {
  if (!servedBy?.side) {
    return "";
  }
  return servedBy.side === "mock"
    ? `<span class="chip served-mock" title="answered by the mock — example data, nothing is saved">MOCK · ${escapeHtml(servedBy.routeStatus)}</span>`
    : `<span class="chip served-live" title="answered by the live API">LIVE</span>`;
}

/**
 * Escape text for innerHTML.
 *
 * Everything rendered here comes from the server, and some of it is echoed
 * user input — so a registration with a name of `<img onerror=…>` would run in
 * this page otherwise. It would only be attacking the tester, but a harness
 * that is itself broken is not a useful instrument.
 *
 * @param {*} value anything
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

/**
 * Ask the server who we are and paint the identity strip.
 *
 * ⚠️ Reads GET /auth/profile/get rather than any local state. The cookie is HttpOnly, so
 * the page genuinely cannot tell whether it is signed in — only the server can,
 * and that is the property being tested.
 *
 * @returns {Promise<object|null>} the profile, or null when signed out
 */
async function refreshIdentity() {
  const strip = document.getElementById("identity");
  if (strip === null) {
    return null;
  }

  const result = await api.get("/auth/profile/get");

  if (!result.ok) {
    strip.className = "identity signed-out";
    strip.innerHTML = `<strong>signed out</strong><span class="muted">${escapeHtml(
      result.error ?? result.statusName,
    )}</span>`;
    return null;
  }

  const user = result.data.user;
  strip.className = "identity signed-in";
  strip.innerHTML = `
    <strong>${escapeHtml(user.email)}</strong>
    <span class="chip">${escapeHtml(user.role)}</span>
    <span class="chip">${escapeHtml(user.status)}</span>
    <span class="muted">org ${escapeHtml(user.organizationId)}</span>
    <button type="button" id="identity-refresh">refresh</button>
  `;
  document
    .getElementById("identity-refresh")
    .addEventListener("click", refreshIdentity);

  return user;
}

/**
 * Wire a form to a call, showing the result and refreshing identity after.
 *
 * @param {string} formId the form element's id
 * @param {Function} handler receives the form's values, returns a result
 * @returns {void}
 */
function onSubmit(formId, handler) {
  const form = document.getElementById(formId);
  if (form === null) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const values = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector("button[type=submit]");
    const originalLabel = button?.textContent;

    if (button) {
      button.disabled = true;
      button.textContent = "…";
    }

    try {
      const result = await handler(values, form);
      if (result !== undefined) {
        showResult(result);
      }
      await refreshIdentity();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  });
}

/**
 * Point the tester at the challenge when a sign-in stopped short of a session.
 *
 * Every route into an account — password, magic link, Google — funnels through
 * the same check, so this one helper covers all of them.
 *
 * @param {object} result a sign-in result
 * @returns {void}
 */
function noteIfChallenged(result) {
  if (result.ok !== true || result.data?.mfaRequired !== true) {
    return;
  }

  const banner = document.getElementById("challenge-banner");
  if (banner === null) {
    return;
  }

  banner.hidden = false;
  banner.innerHTML = `
    <strong>second factor required</strong>
    <span class="muted">
      the challenge cookie is set — you are NOT signed in yet
    </span>
    <a href="/two-factor">go to the challenge →</a>
  `;
}

/**
 * A unique address, so repeated manual runs never collide on the unique email
 * index — which otherwise shows up as a confusing CONFLICT on a form you have
 * not touched.
 *
 * @param {string} [label]
 * @returns {string}
 */
function freshEmail(label = "test") {
  return `${label}-${Date.now()}@example.com`;
}

// Every page, in the order the nav shows them. Link pages (/invite-tester, the
// verify and reset pages) are reached from emails, so they are not listed.
const NAV_PAGES = [
  ["/account", "account"],
  ["/flow", "after sign-in ▸"],
  ["/inbox", "inbox"],
  ["/two-factor", "two-factor"],
  ["/sessions", "sessions"],
  ["/invites", "org invites"],
  ["/edge-cases", "edge cases"],
  ["/google", "google"],
  ["/me", "me"],
  ["/organization", "organizations"],
  ["/workspace", "workspace"],
  ["/invitations", "invitations"],
  ["/members", "members"],
  ["/ownership", "ownership"],
  ["/projects", "projects"],
  ["/billing", "billing"],
  ["/tokens", "api tokens"],
  ["/webhooks", "webhooks"],
  ["/audit", "audit log"],
];

/**
 * Fill every <nav data-nav> with the shared page list, marking this page.
 *
 * @returns {void}
 */
function renderNav() {
  document.querySelectorAll("nav[data-nav]").forEach((nav) => {
    nav.innerHTML = NAV_PAGES.map(
      ([href, label]) =>
        `<a href="${href}"${
          location.pathname === href ? ' aria-current="page"' : ""
        }>${escapeHtml(label)}</a>`,
    ).join("");
  });
  renderTargetBanner();
}

/**
 * Say which API this harness is driving, loudly when it is not a local one.
 *
 * Without it, a harness pointed at the deployed API looks exactly like a
 * harness pointed at localhost — and the accounts, emails and rate limits
 * being spent are real.
 *
 * @returns {void}
 */
async function renderTargetBanner() {
  if (document.getElementById("api-target-banner")) {
    return;
  }

  let target;
  try {
    target = await (await fetch("/dev/target")).json();
  } catch {
    return;
  }

  const banner = document.createElement("div");
  banner.id = "api-target-banner";
  const where = target.local
    ? `api · ${target.target}`
    : `⚠ LIVE API · ${target.target} · accounts, emails and rate limits are real`;
  banner.textContent =
    target.routing === "split"
      ? `${where} · ${target.liveRoutes} live routes there, the other ${target.mockRoutes} → MOCK ${target.mock}`
      : target.routing === "mock"
        ? `MOCK ONLY · ${target.mock} · every call is example data`
        : where;
  banner.style.cssText = [
    "position:sticky",
    "top:0",
    "z-index:99",
    "padding:6px 12px",
    "font:600 12px/1.4 ui-monospace,monospace",
    "letter-spacing:.02em",
    target.local
      ? "background:#1f2937;color:#9ca3af"
      : "background:#7f1d1d;color:#fecaca",
  ].join(";");

  document.body.prepend(banner);
}

// The workspace every workspace page acts on, kept across pages and reloads.
const WORKSPACE_KEY = "chakra-dummy-workspace";

/**
 * @returns {{id: string, orgId: string, name: string, role: string}|null}
 */
function currentWorkspace() {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_KEY));
  } catch {
    return null;
  }
}

/**
 * Remember a workspace and tell the page it changed.
 *
 * @param {object|null} workspace an item of GET /me/workspaces, or null
 * @returns {void}
 */
function setCurrentWorkspace(workspace) {
  if (workspace === null) {
    localStorage.removeItem(WORKSPACE_KEY);
  } else {
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({
        id: workspace.id,
        orgId: workspace.orgId,
        name: workspace.name,
        role: workspace.role,
      }),
    );
  }
  // A pick made elsewhere on the page (a switcher row) moves the picker too.
  const select = document.getElementById("workspace-select");
  if (select !== null && workspace !== null) {
    select.value = workspace.id;
  }
  document.dispatchEvent(
    new CustomEvent("workspacechange", { detail: currentWorkspace() }),
  );
}

/**
 * Fill #workspace-picker from GET /me/workspaces. Keeps the remembered one
 * when the caller still reaches it, else picks the first.
 *
 * @returns {Promise<object[]>} the caller's workspaces
 */
async function renderWorkspacePicker() {
  const picker = document.getElementById("workspace-picker");
  if (picker === null) {
    return [];
  }
  const result = await api.get("/me/workspaces");
  const workspaces = Array.isArray(result.data)
    ? result.data
    : (result.data?.workspaces ?? []);
  if (!result.ok || workspaces.length === 0) {
    picker.innerHTML = `<span class="muted">${
      result.ok
        ? 'no workspace yet — create one in <a href="/flow#step-create">after sign-in, step 4</a> or on <a href="/organization">organizations</a>'
        : escapeHtml(result.error ?? result.statusName)
    }</span>`;
    setCurrentWorkspace(null);
    return workspaces;
  }
  const remembered = currentWorkspace();
  const chosen =
    workspaces.find((workspace) => workspace.id === remembered?.id) ??
    workspaces[0];
  picker.innerHTML = `<label>workspace
    <select id="workspace-select">${workspaces
      .map(
        (workspace) =>
          `<option value="${escapeHtml(workspace.id)}"${
            workspace.id === chosen.id ? " selected" : ""
          }>${escapeHtml(workspace.name)} · ${escapeHtml(workspace.role)}${
            workspace.readOnly ? " · read-only" : ""
          }</option>`,
      )
      .join("")}</select></label>
    <button type="button" id="workspace-reload">reload list</button>`;
  document.getElementById("workspace-select").addEventListener("change", (e) =>
    setCurrentWorkspace(
      workspaces.find((workspace) => workspace.id === e.target.value),
    ),
  );
  document
    .getElementById("workspace-reload")
    .addEventListener("click", renderWorkspacePicker);
  setCurrentWorkspace(chosen);
  return workspaces;
}

/**
 * Run fn now for the current workspace (once the picker has loaded) and
 * again whenever the picker changes it.
 *
 * @param {Function} fn receives the current workspace, or null
 * @returns {void}
 */
function onWorkspaceChange(fn) {
  document.addEventListener("workspacechange", (event) => fn(event.detail));
}

/**
 * The current workspace's id, or a refusal shown in the panel when none.
 *
 * @returns {string|null}
 */
function requireWorkspaceId() {
  const workspace = currentWorkspace();
  if (workspace === null) {
    showResult({
      ok: false,
      status: null,
      statusName: "NO WORKSPACE",
      error: "pick or create a workspace first",
      request: { method: "—", path: "—", body: null },
      raw: null,
      ms: 0,
    });
    return null;
  }
  return workspace.id;
}

document.addEventListener("DOMContentLoaded", () => {
  renderNav();
  refreshIdentity();
  renderWorkspacePicker();

  // Prefill every "fresh address" button on the page.
  document.querySelectorAll("[data-fresh-email]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.querySelector(
        button.getAttribute("data-fresh-email"),
      );
      if (target) {
        target.value = freshEmail(button.dataset.label ?? "test");
      }
    });
  });
});
