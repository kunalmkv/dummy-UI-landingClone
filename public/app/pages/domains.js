// The workspace's custom domains (docs/api-mocks/domains.md): health tabs with
// counts, search, status, project and sort; add a domain; each row's menu
// checks, makes primary, assigns, renews, archives, restores or deletes it.

import { del, get, patch, post, query, ws } from "../lib/api.js";
import { go } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, debounce, emptyState, formValues, html, icon, mount, openModal, plural, popover, setFormError, skeletonRows, timeAgo, toast } from "../lib/ui.js";
import { shell } from "./shell.js";

/** /workspaces/:id/domains, and what follows it. */
export const domainsPath = (workspaceId, rest = "") => ws(workspaceId, `/domains${rest}`);

const TABS = [
  { key: "all", label: "All" },
  { key: "healthy", label: "Healthy" },
  { key: "issues", label: "Issues" },
  { key: "pending", label: "Pending" },
  { key: "archived", label: "Archived" },
];
const STATUSES = [
  ["", "Any status"],
  ["dns-verified", "DNS verified"],
  ["dns-pending", "DNS pending"],
  ["dns-mismatch", "DNS mismatch"],
  ["dns-conflict", "DNS conflict"],
  ["ssl-active", "SSL active"],
  ["ssl-pending", "SSL pending"],
  ["ssl-expired", "SSL expired"],
  ["ssl-failed", "SSL failed"],
];
const SORTS = [
  ["added", "Newest"],
  ["name", "Name"],
  ["sessions", "Sessions"],
  ["status", "Status"],
];
const HEALTH = {
  healthy: ["chip-success", "Healthy"],
  "going-live": ["chip-info", "Going live"],
  "ssl-pending": ["chip-info", "SSL pending"],
  pending: ["", "Pending"],
  attention: ["chip-danger", "Needs attention"],
  archived: ["chip-warning", "Archived"],
};
const DNS_CHIP = { verified: "chip-success", pending: "", mismatch: "chip-danger", conflict: "chip-danger" };
const SSL_CHIP = { active: "chip-success", awaiting_dns: "", provisioning: "chip-info", issuing: "chip-info", expired: "chip-danger", failed: "chip-danger" };
// Domain refusals worded for this screen; the rest come from the shared map.
const ADD_ERRORS = {
  HOST_TAKEN: "This workspace already uses that host, or is still removing it.",
  HOST_CLAIMED: "Another workspace has already verified this host. If it's yours, contact support.",
  WILDCARD_NOT_ALLOWED: "Wildcard domains can't be connected. Add each host on its own.",
  INVALID_DOMAIN: "Enter a bare host like go.brand.com: no https://, path or port.",
};

/** Health is derived in the contract's order; the API never sends it. */
export function healthOf(domain) {
  if (domain.lifecycle === "archived") return "archived";
  if (domain.dns.status === "pending") return "pending";
  if (domain.dns.status === "mismatch" || domain.dns.status === "conflict") return "attention";
  if (domain.ssl.status === "expired" || domain.ssl.status === "failed") return "attention";
  if (domain.ssl.status !== "active") return "ssl-pending";
  return domain.live ? "healthy" : "going-live";
}

export function healthChip(domain) {
  const [kind, label] = HEALTH[healthOf(domain)];
  return html`<span class="chip ${kind}" data-health>${label}</span>`;
}

export const dnsChip = (domain) => html`<span class="chip ${DNS_CHIP[domain.dns.status] ?? ""}">DNS ${domain.dns.status}</span>`;
export const sslChip = (domain) => html`<span class="chip ${SSL_CHIP[domain.ssl.status] ?? ""}">SSL ${domain.ssl.status.replace("_", " ")}</span>`;

/** Elasticsearch did not answer in time: "—", never 0. */
export const sessionsText = (count) => (count === null || count === undefined ? "—" : count.toLocaleString());

/** The host only: a pasted URL loses its scheme, path and port before it is sent. */
export function bareHost(text) {
  return text.trim().replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

// ─── actions shared with the detail screen ──────────────────────────────────

async function report(result, done) {
  if (!result.ok) {
    toast(result.error, "error");
    return false;
  }
  toast(done);
  return true;
}

export async function checkNow(workspaceId, domain) {
  const result = await post(domainsPath(workspaceId, `/${domain.domainId}/check-dns`), {});
  return report(result, result.ok ? `Checked: DNS ${result.data.dns.status}, SSL ${result.data.ssl.status.replace("_", " ")}` : "");
}

export async function makePrimary(workspaceId, domain) {
  const result = await post(domainsPath(workspaceId, `/${domain.domainId}/primary`), {});
  const demoted = result.data?.demoted;
  return report(result, `${domain.host} is the project's primary domain${demoted ? ` (was ${demoted.host})` : ""}`);
}

export async function renewCertificate(workspaceId, domain) {
  const result = await post(domainsPath(workspaceId, `/${domain.domainId}/ssl/renew`), {});
  return report(result, "Renewal started · usually a few minutes");
}

export async function archiveDomain(workspaceId, domain) {
  const result = await post(domainsPath(workspaceId, `/${domain.domainId}/archive`), {});
  return report(result, `${domain.host} archived; its pages move back to the primary or sandbox`);
}

export async function restoreDomain(workspaceId, domain) {
  const result = await post(domainsPath(workspaceId, `/${domain.domainId}/restore`), {});
  return report(result, `${domain.host} restored. If you removed the TXT record, add it back.`);
}

/** Pick another project; the move drops primary, the target keeps its own. */
export async function openAssign(workspaceId, domain, onDone) {
  const projects = (await get(ws(workspaceId, "/projects?limit=100"))).data?.items ?? [];
  openModal({
    title: `Assign ${domain.host}`,
    subtitle: "Its pages on the old project fall back to that project's primary or sandbox. It stops being primary.",
    body: html`<form class="modal-body form" novalidate>
        <label class="field"><span>Project</span><select name="projectId">${projects.map((one) => html`<option value="${one.projectId}" ${one.projectId === domain.projectId ? "selected" : ""}>${one.name}</option>`)}</select></label>
      </form>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Assign</button></div>`,
    onMount: (modal, close) => {
      const form = modal.querySelector("form");
      modal.querySelector("[data-submit]").addEventListener("click", (event) =>
        busy(event.currentTarget, async () => {
          const result = await patch(domainsPath(workspaceId, `/${domain.domainId}`), { projectId: formValues(form).projectId });
          if (!result.ok) {
            setFormError(form, result.error);
            return;
          }
          close();
          toast(`${domain.host} assigned`);
          onDone();
        }),
      );
    },
  });
}

/** The impact first, then the host typed exactly (the API's NAME_MISMATCH is the backstop). */
export async function openDelete(workspaceId, domain, onDone) {
  const impact = await get(domainsPath(workspaceId, `/${domain.domainId}/removal-impact`));
  if (!impact.ok) {
    toast(impact.error, "error");
    return;
  }
  const facts = impact.data;
  openModal({
    title: `Delete ${domain.host}?`,
    subtitle: "Permanent. Archive keeps it in the Archived tab instead.",
    body: html`<form class="modal-body form" novalidate>
        <ul class="plain-list" data-impact>
          <li>${plural(facts.pages, "page")} and ${plural(facts.quizzes, "quiz", "quizzes")} move back to the project's primary or sandbox</li>
          <li>${sessionsText(facts.sessions30d)} sessions in the last 30 days · ${plural(facts.activeCampaigns, "active campaign")}</li>
          ${facts.isPrimary ? html`<li>It is the project's primary domain: new pages default to the sandbox until another is primary</li>` : ""}
          ${facts.certificateRevoked ? html`<li>Its SSL certificate is deleted</li>` : ""}
          ${facts.dnsRecordsManual ? html`<li>The DNS records at your provider must be removed by hand</li>` : ""}
        </ul>
        <label class="field"><span>Type <b>${domain.host}</b> to confirm</span><input type="text" name="host" autocomplete="off" /></label>
      </form>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-submit disabled>Delete domain</button></div>`,
    onMount: (modal, close) => {
      const form = modal.querySelector("form");
      const submit = modal.querySelector("[data-submit]");
      form.host.addEventListener("input", () => {
        submit.disabled = form.host.value !== domain.host;
      });
      // Enter submits only a confirmed host, and never reloads the page.
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!submit.disabled) {
          submit.click();
        }
      });
      submit.addEventListener("click", (event) =>
        busy(event.currentTarget, async () => {
          const result = await del(domainsPath(workspaceId, `/${domain.domainId}${query({ host: form.host.value })}`));
          if (!result.ok) {
            setFormError(form, result.code === "NAME_MISMATCH" ? "That isn't the host exactly." : result.error);
            return;
          }
          close();
          showLeftoverRecords(domain);
          onDone();
        }),
      );
    },
  });
}

function showLeftoverRecords(domain) {
  openModal({
    title: `${domain.host} is deleted`,
    subtitle: "Remove these DNS records at your provider now.",
    body: html`<div class="modal-body"><ul class="plain-list mono">${domain.dns.records.map((record) => html`<li>${record.type} ${record.host} → ${record.value}</li>`)}</ul></div>
      <div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`,
  });
}

/** Host, project, a root's serving label, and whether it is live on another platform already. */
export async function openAddDomain(workspaceId, onAdded) {
  const projects = (await get(ws(workspaceId, "/projects?limit=100"))).data?.items ?? [];
  if (projects.length === 0) {
    toast("Create a project first: every domain belongs to one.", "error");
    return;
  }
  openModal({
    title: "Add a domain",
    subtitle: "We give you the DNS records next. Nothing changes for visitors until they verify.",
    body: html`<form class="modal-body form" novalidate>
        <label class="field"><span>Domain</span><input type="text" name="host" required placeholder="go.brand.com" autocomplete="off" /><span class="hint" data-echo></span></label>
        <label class="field"><span>Attach to project</span><select name="projectId">${projects.map((one) => html`<option value="${one.projectId}">${one.name}</option>`)}</select></label>
        <label class="field"><span>Is it a bare domain?</span><select name="kind"><option value="subdomain">No: a subdomain like go.brand.com</option><option value="root">Yes: a bare domain like brand.com</option></select></label>
        <label class="field hidden" data-label-field><span>Pages serve on</span><select name="servingLabel"><option value="go">go</option><option value="lp">lp</option><option value="offers">offers</option><option value="www">www</option></select><span class="hint">brand.com redirects to this host; www is usually your own site.</span></label>
        <label class="check"><input type="checkbox" name="liveElsewhere" /> This host already serves a site on another platform (the certificate comes first, so HTTPS never drops)</label>
      </form>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Add domain</button></div>`,
    onMount: (modal, close) => {
      const form = modal.querySelector("form");
      const echo = form.querySelector("[data-echo]");
      form.host.addEventListener("input", () => {
        const sent = bareHost(form.host.value);
        echo.textContent = sent && sent !== form.host.value.trim() ? `We'll send ${sent}` : "";
      });
      form.kind.addEventListener("change", () => form.querySelector("[data-label-field]").classList.toggle("hidden", form.kind.value !== "root"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        modal.querySelector("[data-submit]").click();
      });
      modal.querySelector("[data-submit]").addEventListener("click", (event) =>
        busy(event.currentTarget, async () => {
          const values = formValues(form);
          setFormError(form, null);
          const body = { host: bareHost(values.host), projectId: values.projectId };
          if (values.kind === "root") {
            body.servingLabel = values.servingLabel;
          }
          if (form.liveElsewhere.checked) {
            body.liveElsewhere = true;
          }
          const result = await post(domainsPath(workspaceId), body);
          if (!result.ok) {
            const scope = result.code === "ENTITLEMENT_REQUIRED" ? (result.details?.scope ?? "plan") : null;
            const product = scope === "product";
            const plan = scope === "plan";
            setFormError(
              form,
              product
                ? "Insidefi has no hostnames left right now. Contact support; your plan isn't the limit."
                : plan
                  ? "This workspace has all the domains its plan allows (archived ones count). Upgrade in Billing, or delete one."
                  : scope === "pilot"
                    ? "Custom domains are in a pilot. Ask support to add this workspace."
                    : (ADD_ERRORS[result.code] ?? result.error),
            );
            return;
          }
          close();
          onAdded(result.data);
        }),
      );
    },
  });
}

// ─── the list ───────────────────────────────────────────────────────────────

export async function renderDomains({ params }) {
  const id = params.id;
  const projectsRequest = get(ws(id, "/projects?limit=100"));
  const content = await shell({ workspaceId: id, active: "domains", crumb: "Domains" });
  if (!content) {
    return;
  }
  const view = { filter: "all", status: "", projectId: "", sort: "added", q: "", items: [], counts: {}, sandboxHosts: {}, nextCursor: null, projects: [] };

  mount(
    content,
    html`
      <div class="page-head">
        <div><h1>Domains</h1><p>Custom hosts your pages and quizzes serve on. Health is worked out from DNS, the certificate and whether pages serve yet.</p></div>
        <div class="actions">${can("domain.manage") ? html`<button class="btn btn-primary" data-add>${icon("plus")} Add domain</button>` : ""}</div>
      </div>
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap;gap:12px">
          <div class="tabs" data-tabs>${TABS.map((tab) => html`<button data-value="${tab.key}" class="${tab.key === "all" ? "active" : ""}">${tab.label} <span class="muted" data-count="${tab.key}"></span></button>`)}</div>
          <div class="toolbar" style="flex:1;justify-content:flex-end">
            <div class="search">${icon("search")}<input type="search" placeholder="Search host or project" data-q /></div>
            <select data-status>${STATUSES.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
            <select data-project><option value="">All projects</option></select>
            <select data-sort>${SORTS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
          </div>
        </div>
        <div data-list>${skeletonRows()}</div>
      </div>`,
  );

  const list = content.querySelector("[data-list]");
  const projectName = (projectId) => view.projects.find((one) => one.projectId === projectId)?.name ?? (projectId ? "—" : "Unassigned");

  async function load(append = false) {
    if (!append) {
      mount(list, skeletonRows());
    }
    const result = await get(domainsPath(id, query({ filter: view.filter, status: view.status, projectId: view.projectId, sort: view.sort, q: view.q, limit: 25, cursor: append ? view.nextCursor : "" })));
    if (!result.ok) {
      mount(list, emptyState({ iconName: "triangle-alert", title: "Couldn't load domains", text: result.error }));
      return;
    }
    view.items = append ? [...view.items, ...result.data.items] : result.data.items;
    view.counts = result.data.counts;
    view.sandboxHosts = result.data.sandboxHosts ?? {};
    view.nextCursor = result.data.nextCursor;
    content.querySelectorAll("[data-count]").forEach((badge) => {
      badge.textContent = view.counts[badge.dataset.count] ?? "";
    });
    draw();
  }

  function draw() {
    if (view.items.length === 0) {
      const filtered = view.q || view.status || view.filter !== "all";
      const sandboxes = Object.values(view.sandboxHosts);
      mount(
        list,
        emptyState({
          iconName: "globe",
          title: filtered ? "No domains match" : "No domains yet",
          text: filtered ? "Try another tab, status or search." : sandboxes.length > 0 ? `Until you add one, pages publish to ${sandboxes.join(", ")}.` : "Add a domain to serve pages on your own host.",
        }),
      );
      return;
    }
    mount(
      list,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Domain</th><th>Project</th><th>Health</th><th>DNS · SSL</th><th>Serves</th><th>Sessions 30d</th><th>Added</th><th class="actions"></th></tr></thead>
        <tbody>${view.items.map(
          (domain) => html`<tr data-row="${domain.host}">
            <td><div class="name"><a href="#/w/${id}/domains/${domain.domainId}">${domain.host}</a>${domain.primary ? html` <span class="chip chip-brand">Primary</span>` : ""}</div>
              ${domain.servingHost !== domain.host ? html`<div class="email">serves on ${domain.servingHost}</div>` : ""}</td>
            <td>${projectName(domain.projectId)}</td>
            <td>${healthChip(domain)}</td>
            <td>${dnsChip(domain)} ${sslChip(domain)}</td>
            <td class="muted">${plural(domain.pages, "page")} · ${plural(domain.quizzes, "quiz", "quizzes")}</td>
            <td class="muted">${sessionsText(domain.sessions30d)}</td>
            <td class="muted">${timeAgo(domain.addedAt)}</td>
            <td class="actions"><button class="btn btn-ghost btn-icon btn-sm" data-menu="${domain.domainId}" data-popover-anchor aria-label="Domain actions">${icon("ellipsis")}</button></td>
          </tr>`,
        )}</tbody>
      </table></div>
      ${view.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}`,
    );
    list.querySelector("[data-more]")?.addEventListener("click", (event) => busy(event.currentTarget, () => load(true)));
    list.querySelectorAll("[data-menu]").forEach((button) =>
      button.addEventListener("click", () => popover(button, menuFor(view.items.find((one) => one.domainId === button.dataset.menu)))),
    );
  }

  /** Done, then the list again. */
  const then = (action) => async () => {
    if (await action()) {
      load();
    }
  };

  function menuFor(domain) {
    const items = [{ label: "View", icon: "eye", onClick: () => go(`/w/${id}/domains/${domain.domainId}`) }];
    if (!can("domain.manage")) {
      return items;
    }
    if (domain.lifecycle === "archived") {
      items.push("sep", { label: "Restore", icon: "archive-restore", onClick: then(() => restoreDomain(id, domain)) });
    } else {
      items.push({ label: "Check DNS now", icon: "refresh-cw", onClick: then(() => checkNow(id, domain)) });
      if (!domain.primary && domain.dns.status === "verified") {
        items.push({ label: "Make primary", icon: "star", onClick: then(() => makePrimary(id, domain)) });
      }
      items.push({ label: "Assign to project…", icon: "folder-input", onClick: () => openAssign(id, domain, load) });
      if (domain.dns.status === "verified" && !["provisioning", "issuing"].includes(domain.ssl.status)) {
        items.push({ label: "Renew certificate", icon: "shield-check", onClick: then(() => renewCertificate(id, domain)) });
      }
      items.push("sep", { label: "Archive", icon: "archive", onClick: then(() => archiveDomain(id, domain)) });
    }
    items.push({ label: "Delete", icon: "trash-2", danger: true, onClick: () => openDelete(id, domain, load) });
    return items;
  }

  content.querySelector("[data-add]")?.addEventListener("click", () => openAddDomain(id, (domain) => go(`/w/${id}/domains/${domain.domainId}`)));
  content.querySelectorAll("[data-tabs] button").forEach((button) =>
    button.addEventListener("click", () => {
      content.querySelectorAll("[data-tabs] button").forEach((one) => one.classList.toggle("active", one === button));
      view.filter = button.dataset.value;
      load();
    }),
  );
  content.querySelector("[data-q]").addEventListener(
    "input",
    debounce((event) => {
      view.q = event.target.value.trim();
      load();
    }, 300),
  );
  for (const [selector, key] of [["[data-status]", "status"], ["[data-project]", "projectId"], ["[data-sort]", "sort"]]) {
    content.querySelector(selector).addEventListener("change", (event) => {
      view[key] = event.target.value;
      load();
    });
  }
  const projects = await projectsRequest;
  view.projects = projects.data?.items ?? [];
  content.querySelector("[data-project]").insertAdjacentHTML("beforeend", String(html`${view.projects.map((one) => html`<option value="${one.projectId}">${one.name}</option>`)}`));
  await load();
}
