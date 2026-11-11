// A handed-over root's live DNS records (★ K.8): the list with its locks, add,
// edit and delete, bulk, the three templates (preview first), the history and
// the zone file. Every write redraws from its answer, with no second read.

import { del, get, patch, post, query } from "../lib/api.js";
import { navigation } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, emptyState, formValues, html, icon, mount, openModal, plural, setFormError, timeAgo, toast } from "../lib/ui.js";
import { domainsPath } from "./domains.js";
import { shell } from "./shell.js";

// The seven types our DNS hosts.
const WRITABLE = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"];
const LOCKS = {
  none: ["", "yours"],
  chakra: ["chip-info", "kept by Insidefi"],
  values: ["chip-warning", "Insidefi keeps its value here"],
  "read-only": ["", "alias or routing record"],
};
const BLOCKERS = { "zone-not-ready": "Your zone is still being set up", "migration-incomplete": "Finish copying your records first" };
const TEMPLATES = {
  "no-email": ["This domain sends no email", "A null MX replaces your MX records, v=spf1 -all replaces your SPF, and DMARC is set to reject."],
  "google-workspace": ["Google Workspace", "MX 1 smtp.google.com replaces your MX records, and include:_spf.google.com is added to your SPF: its other values stay."],
  "microsoft-365": ["Microsoft 365", "MX 0 <your MX host> replaces your MX records, include:spf.protection.outlook.com is added to your SPF (its other values stay), and autodiscover and the Teams SRV are written."],
};
const SOURCES = { editor: "edited", bulk: "bulk change", template: "template", import: "copy", sync: "Insidefi (certificate token)", removal: "removal" };
const STATUSES = { applied: ["chip-success", "applied"], failed: ["chip-danger", "failed"], aborted: ["chip-warning", "not written: the records changed meanwhile"], pending: ["chip-warning", "outcome not known yet"] };
const count = (value) => Number(value ?? 0).toLocaleString();
// INVALID_REQUEST's reasons, with the set its details name.
const REASONS = {
  name: () => "That name isn't under your domain: type @ for the root, or a name like www.",
  apex_cname: () => "A CNAME can't sit at the root.",
  ttl: (details) => `The TTL must be ${count(details.min ?? 60)} to ${count(details.max ?? 172800)} seconds.`,
  value: (details) => `${details.value ? `${details.value} isn't` : "A value isn't"} valid for this type.`,
  value_count: () => "A record set holds 1 to 100 values.",
  cname_rule: (details, set) => `A CNAME can't share its name with another record: ${set}.`,
  caa: (details) => `Your CAA records would stop ${(details.missing ?? []).join(", ") || "our certificate authorities"} from issuing your pages' certificate: allow them too.`,
  zone_size: (details) => `Your zone would hold more than ${count(details.maxSets)} record sets.`,
  set_size: (details, set) => `${set || "That set"} is too large: keep it under ${count(details.maxChars)} characters, or delete it and create it again.`,
  bulk_size: (details) => `More than ${count(details.maxSets)} sets and deletes at once: split them.`,
  duplicate: (details, set) => `${set} is named twice: name each set once.`,
};

const relativeName = (name, host) => (name === host ? "@" : String(name ?? "").endsWith(`.${host}`) ? name.slice(0, -host.length - 1) : String(name ?? ""));
const stateText = (state) => (state ? `${(state.values ?? []).join(", ") || "—"} (TTL ${state.ttl ?? "—"})` : "nothing");

/** A typed name made absolute: "@" or empty is the root, a bare label sits under it, Unicode becomes punycode. */
function absoluteName(text, host) {
  const typed = text.trim().replace(/\.$/, "");
  if (typed === "" || typed === "@") {
    return host;
  }
  let name = typed.toLowerCase();
  try {
    // Only a bare host name: anything else goes as typed, and the API says why. Chrome escapes a wildcard's *.
    name = /[/:@?#\\]/.test(typed) ? name : decodeURIComponent(new URL(`http://${typed}`).hostname);
  } catch {
    // Not a host name: sent as typed.
  }
  return name === host || name.endsWith(`.${host}`) ? name : `${name}.${host}`;
}

/** The friendly words, with what the details add; RECORD_CONFLICT keeps the server's. */
function refusal(result, host) {
  const details = result.details ?? {};
  const set = `${relativeName(details.name, host)} ${details.type ?? ""}`.trim();
  if (result.code === "RATE_LIMITED") {
    return `Too many record changes: try again in ${plural(Math.ceil((details.retryAfterSeconds ?? 60) / 60), "minute")}.`;
  }
  if (result.code === "RECORD_LOCKED" && details.ttl) {
    return `Insidefi keeps this set's TTL: use ${details.ttl}.`;
  }
  if (result.code === "UNSUPPORTED_RECORD" && details.reason === "read_only") {
    return "That's an alias or routing record: it isn't changed here.";
  }
  if (result.code === "UPSTREAM_UNAVAILABLE") {
    return "Our DNS host didn't answer: try again in a moment.";
  }
  if (result.code === "INVALID_REQUEST" && REASONS[details.reason]) {
    return REASONS[details.reason](details, set);
  }
  return result.error;
}

function changeList(changes, host) {
  return html`<ul class="plain-list mono" data-changes>${changes.map((change) => html`<li>${relativeName(change?.name, host)} ${change?.type ?? ""}: ${stateText(change?.before)} → ${stateText(change?.after)}</li>`)}</ul>`;
}

function statusLine(blockers, importHref) {
  if (blockers.length === 0) {
    return "Changes go live at our name servers at once";
  }
  return blockers.map((code, index) => html`${index > 0 ? " · " : ""}${BLOCKERS[code] ?? String(code).replaceAll("-", " ")}${code === "migration-incomplete" ? html` · <a href="${importHref}" data-import-link>Open the copy</a>` : ""}`);
}

/** A values row shows the client's values, then Insidefi's greyed; only rows of none and values change. */
function recordRow(record, index, host, writable) {
  const lock = record.lock ?? "none";
  const [tone, words] = LOCKS[lock] ?? ["", String(lock).replaceAll("-", " ")];
  const locked = record.lockedValues ?? [];
  const mine = (record.values ?? []).filter((value) => !locked.includes(value));
  return html`<tr data-record="${record.name} ${record.type}">
    <td class="mono">${relativeName(record.name, host)}</td>
    <td><span class="chip">${record.type ?? "—"}</span></td>
    <td class="muted">${record.ttl ?? "—"}</td>
    <td class="mono">${mine.map((value) => html`<div>${value}</div>`)}${locked.map((value) => html`<div class="muted" data-locked-value>${value} <span class="hint">Insidefi's</span></div>`)}${mine.length + locked.length === 0 ? "—" : ""}</td>
    <td><span class="chip ${tone}" data-lock="${lock}">${words}</span></td>
    <td class="actions">${writable && ["none", "values"].includes(lock)
      ? html`<button class="btn btn-ghost btn-sm" data-edit="${index}">${icon("pencil")} Edit</button><button class="btn btn-ghost btn-sm" data-delete="${index}">${icon("trash-2")} Delete</button>`
      : ""}</td>
  </tr>`;
}

function recordsCard(view, host, writable) {
  const records = view.records ?? [];
  return html`<div class="card">
    <div class="card-head"><h2>Records</h2><span class="muted">${plural(view.zone?.recordCount ?? records.length, "record set")} · the SOA and NS are ours, so not listed</span></div>
    ${records.length > 0
      ? html`<div class="table-wrap"><table class="table" data-records>
          <thead><tr><th>Name</th><th>Type</th><th>TTL</th><th>Values</th><th>Lock</th><th></th></tr></thead>
          <tbody>${records.map((record, index) => recordRow(record, index, host, writable))}</tbody>
        </table></div>`
      : html`<div class="card-body muted" data-records>No records yet.</div>`}
  </div>`;
}

function templatesCard(choice, preview, previewed, host) {
  const changes = preview?.changes ?? [];
  return html`<div class="card" data-templates>
    <div class="card-head"><h2>Templates</h2><span class="muted">preview first, then apply</span></div>
    <form class="card-body form" data-template-form novalidate>
      <div class="row-2"><label class="field"><span>Template</span><select name="template" data-template>${Object.entries(TEMPLATES).map(([value, [label]]) => html`<option value="${value}" ${choice.template === value ? "selected" : ""}>${label}</option>`)}</select></label>
        ${choice.template === "microsoft-365" ? html`<label class="field"><span>Your Microsoft 365 MX host</span><input type="text" name="mxHost" data-mx-host placeholder="brand-com.mail.protection.outlook.com" value="${choice.mxHost}" /></label>` : ""}</div>
      <p class="hint" data-template-hint>${TEMPLATES[choice.template]?.[1] ?? ""}</p>
      ${preview
        ? html`<div data-preview-changes>
            ${changes.some((change) => change?.type === "MX") ? html`<div class="form-note warning-text" data-mx-warning>This replaces your MX records: mail goes to the new host.</div>` : ""}
            ${changes.length > 0 ? changeList(changes, host) : html`<p class="muted">Nothing to change: your records already match.</p>`}
          </div>`
        : ""}
      <div class="toolbar"><button class="btn btn-sm" data-preview>${icon("eye")} Preview</button><button class="btn btn-primary btn-sm" data-apply ${previewed ? "" : "disabled"}>${icon("check")} Apply</button></div>
    </form>
  </div>`;
}

function bulkCard(host, changes) {
  const example = { sets: [{ name: `www.${host}`, type: "CNAME", ttl: 3600, values: [host] }], deletes: [{ name: `www.${host}`, type: "A" }] };
  return html`<div class="card" data-bulk>
    <div class="card-head"><h2>Bulk change</h2><span class="muted">up to 200 sets and deletes, checked together</span></div>
    <form class="card-body form" data-bulk-form novalidate>
      <label class="field"><span>Sets and deletes <span class="muted">(JSON, full names)</span></span><textarea class="mono" rows="8" data-bulk-text>${JSON.stringify(example, null, 2)}</textarea></label>
      <p class="hint">Each set is its end state, created or replaced as a whole. If it stops midway, send it again to finish.</p>
      <div><button class="btn btn-sm" data-bulk-send>${icon("send")} Send</button></div>
      ${changes ? html`<div data-bulk-changes>${changes.length > 0 ? changeList(changes, host) : html`<p class="muted">Nothing to change.</p>`}</div>` : ""}
    </form>
  </div>`;
}

function historyItem(item, host) {
  const [tone, words] = STATUSES[item?.status] ?? ["", String(item?.status ?? "—").replaceAll("-", " ")];
  return html`<li data-history-item>
    <div><span title="${item?.at ? new Date(item.at).toLocaleString() : ""}">${item?.at ? timeAgo(item.at) : "—"}</span> · <b data-source>${SOURCES[item?.source] ?? String(item?.source ?? "—").replaceAll("-", " ")}</b> · <span data-actor>${item?.actor?.label ?? "—"}</span> <span class="chip ${tone}" data-status>${words}</span></div>
    ${item?.error ? html`<div class="hint" data-error>${item.error}</div>` : ""}
    ${changeList(item?.changes ?? [], host)}
  </li>`;
}

function historyCard(history, host) {
  const items = history.items ?? [];
  return html`<div class="card" data-history>
    <div class="card-head"><h2>History</h2><span class="muted">every change, newest first</span></div>
    <div class="card-body">
      ${history.error ? html`<p class="danger-text">${history.error}</p>` : items.length === 0 ? html`<p class="muted">No changes yet.</p>` : html`<ul class="plain-list">${items.map((item) => historyItem(item, host))}</ul>`}
      ${history.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}
    </div>
  </div>`;
}

export async function renderDomainZone({ params }) {
  const id = params.id;
  const domainId = params.domainId;
  const content = await shell({ workspaceId: id, active: "domains", crumb: "Domains" });
  if (!content) {
    return;
  }
  const here = navigation();
  const manage = can("domain.manage");
  const domainHref = `#/w/${id}/domains/${domainId}`;
  const zonePath = domainsPath(id, `/${domainId}/zone`);
  const [domainResult, recordsResult, historyResult] = await Promise.all([get(domainsPath(id, `/${domainId}`)), get(`${zonePath}/records`), get(`${zonePath}/history`)]);
  if (navigation() !== here) {
    return;
  }
  if (!domainResult.ok || !recordsResult.ok) {
    const failed = domainResult.ok ? recordsResult : domainResult;
    mount(content, emptyState({ iconName: "triangle-alert", title: "Couldn't load the records", text: refusal(failed, domainResult.data?.host ?? ""), action: html`<a class="btn" href="${domainHref}">Back to the domain</a>` }));
    return;
  }
  const host = domainResult.data?.host ?? "";
  let view = recordsResult.data ?? {};
  let history = historyResult.ok ? historyResult.data ?? {} : { error: historyResult.error };
  let bulkChanges = null;
  let choice = { template: "no-email", mxHost: "" };
  let preview = null;

  const templateBody = (previewOnly) => ({ template: choice.template, ...(choice.template === "microsoft-365" ? { params: { mxHost: choice.mxHost.trim() } } : {}), ...(previewOnly ? { preview: true } : {}) });
  const choiceKey = () => JSON.stringify(templateBody(false));

  function draw() {
    const writable = manage && view.editable === true;
    // A redraw keeps a bulk change half typed.
    const draft = content.querySelector("[data-bulk-text]")?.value;
    mount(
      content,
      html`
        <div class="page-head">
          <div><h1>DNS records — ${host}</h1>
            <p><a href="${domainHref}" data-back>${host}</a> / <span data-edit-status>${statusLine(view.editBlockers ?? [], `${domainHref}/import`)}</span></p></div>
          <div class="actions"><button class="btn" data-export>${icon("download")} Download zone file</button>
            ${writable ? html`<button class="btn btn-primary" data-add>${icon("plus")} Add a record</button>` : ""}</div>
        </div>
        <div class="section-stack">
          ${recordsCard(view, host, writable)}
          ${writable ? templatesCard(choice, preview, preview?.key === choiceKey(), host) : ""}
          ${writable ? bulkCard(host, bulkChanges) : ""}
          ${historyCard(history, host)}
        </div>`,
    );
    const textarea = content.querySelector("[data-bulk-text]");
    if (textarea && draft !== undefined) {
      textarea.value = draft;
    }
    wire();
  }

  /** A write answers the zone after it: draw that, and say what it did. */
  function changed(result, done) {
    view = result.data ?? {};
    draw();
    toast(view.written === false ? "Nothing to change: it was already like that." : `${done}: ${plural((view.changes ?? []).length, "record set")} changed`);
  }

  /** Add a set (`record` null), or replace one's TTL and values; at a token name only the client's values, at Insidefi's TTL. */
  function openRecord(record) {
    const locked = record?.lockedValues ?? [];
    const tokenSet = record?.lock === "values";
    openModal({
      title: record ? `Edit ${relativeName(record.name, host)} ${record.type}` : "Add a record",
      subtitle: tokenSet ? "Insidefi keeps its own values here, and the TTL: you change yours." : record ? "The whole set is replaced." : `Under ${host}; @ is the root.`,
      body: html`<form class="modal-body form" data-record-form novalidate>
          ${record
            ? ""
            : html`<div class="row-2"><label class="field"><span>Name</span><input type="text" name="name" placeholder="@ or www" /></label>
              <label class="field"><span>Type</span><select name="type">${WRITABLE.map((type) => html`<option>${type}</option>`)}</select></label></div>`}
          <label class="field"><span>TTL <span class="muted">(seconds)</span></span><input type="number" name="ttl" min="60" max="172800" value="${record?.ttl ?? 3600}" ${tokenSet ? "disabled" : ""} /></label>
          <label class="field"><span>Values <span class="muted">(one per line)</span></span><textarea class="mono" rows="4" name="values">${(record?.values ?? []).filter((value) => !locked.includes(value)).join("\n")}</textarea>
            <span class="hint">TXT: type the text, we quote it. CAA: 0 issue "letsencrypt.org"</span></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>${record ? "Save" : "Add"}</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        form.addEventListener("submit", (event) => event.preventDefault());
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            const values = formValues(form);
            const body = {
              name: record ? record.name : absoluteName(values.name ?? "", host),
              type: record ? record.type : values.type,
              ttl: tokenSet ? record.ttl : Number(values.ttl),
              values: String(values.values ?? "").split("\n").map((value) => value.trim()).filter(Boolean),
            };
            const result = await (record ? patch : post)(`${zonePath}/records`, body);
            if (!result.ok) {
              setFormError(form, refusal(result, host));
              return;
            }
            close();
            changed(result, record ? "Saved" : "Added");
          }),
        );
      },
    });
  }

  async function remove(record) {
    const label = relativeName(record.name, host);
    const yes = await confirmDialog(
      record.lock === "values"
        ? { title: "Remove your values?", message: `Remove your values at ${label}? Insidefi's stay.`, confirmLabel: "Remove", danger: true }
        : { title: `Delete ${label} ${record.type}?`, message: "Its values leave your zone at once.", confirmLabel: "Delete", danger: true },
    );
    if (!yes) {
      return;
    }
    const result = await del(`${zonePath}/records${query({ name: record.name, type: record.type })}`);
    if (!result.ok) {
      toast(refusal(result, host), "error");
      return;
    }
    changed(result, "Deleted");
  }

  async function sendBulk(form) {
    setFormError(form, null);
    let body = null;
    try {
      body = JSON.parse(form.querySelector("[data-bulk-text]").value);
    } catch {
      setFormError(form, "That isn't JSON: check its brackets, commas and quotes.");
      return;
    }
    const result = await post(`${zonePath}/records/bulk`, body);
    if (!result.ok) {
      setFormError(form, refusal(result, host));
      return;
    }
    bulkChanges = result.data?.changes ?? [];
    changed(result, "Bulk change sent");
  }

  /** A preview answers the live zone and what a write would send; Apply waits for one of the same choice. */
  async function previewTemplate(form) {
    setFormError(form, null);
    const result = await post(`${zonePath}/records/template`, templateBody(true));
    if (!result.ok) {
      setFormError(form, refusal(result, host));
      return;
    }
    view = result.data ?? {};
    preview = { key: choiceKey(), changes: view.changes ?? [] };
    draw();
  }

  async function applyTemplate(form) {
    const result = await post(`${zonePath}/records/template`, templateBody(false));
    if (!result.ok) {
      setFormError(form, refusal(result, host));
      return;
    }
    preview = null;
    changed(result, "Template applied");
  }

  async function loadMore() {
    const result = await get(`${zonePath}/history${query({ cursor: history.nextCursor })}`);
    if (navigation() !== here) {
      return;
    }
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    history = { ...result.data, items: [...(history.items ?? []), ...(result.data?.items ?? [])] };
    draw();
  }

  async function download() {
    const result = await get(`${zonePath}/export`);
    if (!result.ok) {
      toast(refusal(result, host), "error");
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([result.data?.text ?? ""], { type: "text/plain" }));
    link.download = result.data?.fileName ?? `${host}.zone`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function wire() {
    const records = view.records ?? [];
    const click = (selector, action) => content.querySelectorAll(selector).forEach((button) => button.addEventListener("click", (event) => busy(event.currentTarget, () => action(event.currentTarget))));
    content.querySelectorAll("form").forEach((form) => form.addEventListener("submit", (event) => event.preventDefault()));
    click("[data-export]", download);
    click("[data-more]", loadMore);
    click("[data-bulk-send]", (button) => sendBulk(button.form));
    click("[data-preview]", (button) => previewTemplate(button.form));
    click("[data-apply]", (button) => applyTemplate(button.form));
    content.querySelector("[data-add]")?.addEventListener("click", () => openRecord(null));
    content.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => openRecord(records[button.dataset.edit])));
    content.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => remove(records[button.dataset.delete])));
    content.querySelector("[data-template]")?.addEventListener("change", (event) => {
      choice = { ...choice, template: event.target.value };
      preview = null;
      draw();
    });
    content.querySelector("[data-mx-host]")?.addEventListener("input", (event) => {
      choice = { ...choice, mxHost: event.target.value };
      content.querySelector("[data-apply]").disabled = preview?.key !== choiceKey();
    });
  }

  draw();
}
