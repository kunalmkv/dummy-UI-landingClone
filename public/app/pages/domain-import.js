// Copying a handed-over root's records before the switch (★ K.7): a scan of
// its old name servers or a zone file, the review and its gate, then the check
// at our four name servers. Re-read every 5 s while that check runs.

import { del, get, patch, post } from "../lib/api.js";
import { navigation } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, emptyState, formValues, html, icon, mount, openModal, plural, setFormError, timeAgo, toast } from "../lib/ui.js";
import { checkNow, domainsPath } from "./domains.js";
import { shell } from "./shell.js";

const POLL_MS = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const TOO_LARGE = "That file is over 256 KB.";
// The seven types our DNS hosts: only these are copied, edited or added.
const WRITABLE = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"];
// Imports close once the copy is written, served, or not needed.
const CLOSED = ["ready", "confirmed", "not_needed"];
// A refusal that means the page is stale: read the copy again.
const RELOAD_ON = ["VERSION_CONFLICT", "IMPORT_BLOCKED", "IMPORT_CLOSED", "IMPORT_NOT_FOUND", "SOURCE_UNKNOWN"];
const MIGRATION_LINES = {
  pending: "Not copied yet: scan your current DNS or add a zone file, then review what we found.",
  reviewing: "Under review: decide each row, then copy them.",
  ready: "Copied: we're checking them at our four name servers.",
  confirmed: "Copied and served: nothing else to do here.",
  not_needed: "Nothing to copy: your domain had no records to keep.",
};
const NOTES = {
  "source-unanswered": "Your name servers didn't answer: upload a zone file instead",
  "scan-incomplete": "The scan ran out of time and may have missed records: scan again or upload a zone file",
  "ct-unavailable": "We couldn't read the certificate logs, so names only they list may be missing",
  "dkim-unfound": "You have DKIM keys we couldn't find by name: add them or upload a zone file",
};
// Where each old provider keeps its export, by its name servers' suffix.
const EXPORT_HINTS = [
  [".ns.cloudflare.com", "Cloudflare: DNS → Records → Import and Export → Export"],
  [".domaincontrol.com", "GoDaddy: Domain → DNS → Actions → Export Zone File"],
  [".registrar-servers.com", "Namecheap offers no export: scan, then add what's missing"],
];
const SOURCES = { scan: "scan", zone_file: "zone file", manual: "by hand" };
const KINDS = { excluded: ["", "not copied"], blocking: ["chip-danger", "blocks the copy"], ack: ["chip-warning", "needs your OK"], note: ["", "note"] };
// Every conflict code's kind and words.
const CONFLICTS = {
  "chakra-reserved": ["excluded", "We serve your pages on this name"],
  "apex-address": ["excluded", "Your root's address is ours now: it redirects to your pages"],
  "apex-cname": ["excluded", "A CNAME can't sit at the root"],
  "cname-coexists": ["blocking", "A CNAME can't share its name with another record: leave one out"],
  "alias-unsupported": ["ack", "ALIAS isn't supported: we copy the address it answers today"],
  "proxied-suspect": ["ack", "This looks like a Cloudflare proxy address: it stops answering once Cloudflare is gone"],
  "caa-blocks-issuance": ["ack", "This CAA set blocks the certificate authorities we use"],
  "subdomain-ns": ["blocking", "A sub-zone with its own name servers: we can't copy it, leave it out"],
  "unsupported-type": ["blocking", "We can't host this record type: leave it out"],
  "stale-source": ["ack", "Your file and your live DNS disagree"],
  wildcard: ["note", "Answers every name nothing else answers"],
  "apex-mail-host": ["blocking", "Mail can't go to the root itself: edit the target"],
  "apex-alias": ["note", "Points at your root, which redirects to your pages"],
  "spf-apex": ["note", "Your SPF trusts the root's address, which is ours now"],
  unparseable: ["blocking", "We couldn't read this: fix it by hand, or leave it out"],
  "ttl-clamped": ["note", "TTL moved into 60–172,800 seconds"],
  "target-guessed": ["note", "We read this name as complete: check it"],
  "shared-token": ["note", "We keep our own verification value here; yours is copied beside it"],
};
const GATE_ACKS = {
  "email-dropped": ["I'm dropping email for this domain, or I'll fix it after the switch", "Your domain gets email, but the copy holds no mail record."],
  "email-unknown": ["We couldn't tell whether this domain receives email: I've checked", "Our registrar check couldn't see whether mail is set up."],
  "scan-only": ["A scan can miss records: I've added any it missed", "A scan finds only the names it guesses or certificate logs list."],
  "file-unchecked": ["Your file couldn't be compared with your live DNS: it's current", "Your current name servers didn't answer for its email records."],
};

const relativeName = (name, host) => (name === host ? "@" : String(name ?? "").endsWith(`.${host}`) ? name.slice(0, -host.length - 1) : String(name ?? ""));
const rowLabel = (row, host) => (row.name ? `${relativeName(row.name, host)} ${row.type}` : `line ${row.line ?? "?"}`);
const toggled = (list, code, on) => (on ? [...new Set([...(list ?? []), code])] : (list ?? []).filter((one) => one !== code));

/** A typed name: "@" or empty is the root, a bare label sits under it. */
function absoluteName(text, host) {
  const name = text.trim().toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "@") {
    return host;
  }
  return name === host || name.endsWith(`.${host}`) ? name : `${name}.${host}`;
}

/** The friendly words, with what the details add. */
function refusal(result) {
  const details = result.details ?? {};
  if (result.code === "RATE_LIMITED") {
    return `Too many scans: try again in ${plural(Math.ceil((details.retryAfterSeconds ?? 60) / 60), "minute")}.`;
  }
  if (result.code === "ZONE_FILE_INVALID" && details.maxRows) {
    return `That's more than ${details.maxRows.toLocaleString()} records for one review: split the file, or contact support.`;
  }
  if (result.code === "ZONE_FILE_INVALID" && details.lines?.length > 0) {
    return `${result.error} Look at ${details.lines.length === 1 ? "line" : "lines"} ${details.lines.join(", ")}.`;
  }
  if (["RECORD_CONFLICT", "UPSTREAM_UNAVAILABLE"].includes(result.code)) {
    return "Your DNS zone was busy: try again in a moment.";
  }
  return result.error;
}

function scanCard(view, manage, domainHref) {
  const names = view.sourceNameServers ?? [];
  const scan = view.session?.scan;
  return html`<div class="card" data-scan-card>
    <div class="card-head"><h2>Your current DNS</h2>${manage ? html`<button class="btn btn-sm" data-scan ${names.length === 0 ? "disabled" : ""}>${icon("radar")} Scan your current DNS</button>` : ""}</div>
    <div class="card-body">
      ${names.length > 0
        ? html`<p>We ask your current name servers: <span class="mono">${names.join(", ")}</span></p>`
        : html`<p class="warning-text" data-source-unknown>We don't know your current name servers yet: check the registrar again on the <a href="${domainHref}">domain page</a>.</p>`}
      ${scan
        ? html`<p class="hint" data-scan-summary>Last scan ${timeAgo(scan.at)}: ${plural(scan.found ?? 0, "record set")} found · ${plural(scan.asked ?? 0, "name")} asked · ${scan.unknown ?? 0} unanswered · ${scan.wildcardSuppressed ?? 0} hidden by a wildcard · ${plural(scan.ctNames ?? 0, "name")} from certificate logs</p>`
        : ""}
      ${(scan?.notes ?? []).map((note) => html`<div class="form-note warning-text" data-scan-note>${NOTES[note] ?? String(note).replaceAll("-", " ")}</div>`)}
    </div>
  </div>`;
}

function zoneFileCard(view, manage) {
  const names = view.sourceNameServers ?? [];
  const file = view.session?.zoneFile;
  const dropped = Object.entries(file?.dropped ?? {}).filter(([, count]) => count > 0);
  const hint = EXPORT_HINTS.find(([suffix]) => names.some((name) => String(name).endsWith(suffix)))?.[1] ?? "If your DNS provider can export a zone file (BIND), paste it here";
  return html`<div class="card" data-zone-file-card>
    <div class="card-head"><h2>Zone file</h2></div>
    <form class="card-body form" data-zone-form novalidate>
      <p class="hint" data-export-hint>${hint}</p>
      ${manage
        ? html`<label class="field"><span>Paste it</span><textarea class="mono" rows="6" data-zone-text placeholder="@ 3600 IN MX 10 mail.example.com."></textarea></label>
          <label class="field"><span>Or upload it <span class="muted">(256 KB at most)</span></span><input type="file" accept=".txt,.zone,.db,text/plain" data-zone-upload /></label>
          <div><button class="btn btn-sm" data-zone-add>${icon("file-up")} Add zone file</button></div>`
        : ""}
      ${file
        ? html`<p class="hint" data-zone-summary>Last file ${timeAgo(file.at)}: ${plural(file.sets ?? 0, "record set")} · ${plural(file.unparseable ?? 0, "line")} we couldn't read${dropped.length > 0 ? ` · dropped ${dropped.map(([kind, count]) => `${count} ${kind.toUpperCase()}`).join(", ")} (we serve our own)` : ""}${names.length > 0 ? ` · ${file.checked ? "compared with your live DNS" : "not compared with your live DNS"}` : ""}</p>
          ${names.length === 0 ? html`<p class="hint" data-zone-unchecked>We'll compare it with your live DNS once we know your current name servers: add it again then.</p>` : ""}`
        : ""}
    </form>
  </div>`;
}

/** One conflict: its kind's chip and words; an OK box on the ones that take one. */
function conflictLine(row, index, code, { gate, editable }) {
  const [kind, words] = CONFLICTS[code] ?? ["note", String(code).replaceAll("-", " ")];
  // An email set's stale-source blocks: no OK takes it away.
  const tone = kind === "ack" && (gate?.blockingKeys ?? []).includes(row.key) ? "blocking" : kind;
  return html`<div data-conflict="${code}" data-kind="${tone}"><span class="chip ${KINDS[tone][0]}">${KINDS[tone][1]}</span> <span class="hint">${words}</span>
    ${tone === "ack" ? html`<label class="check"><input type="checkbox" data-ack-row="${index}" data-code="${code}" ${(row.acknowledged ?? []).includes(code) ? "checked" : ""} ${editable ? "" : "disabled"} /> I understand</label>` : ""}
    ${code === "caa-blocks-issuance" && editable ? html`<button class="btn btn-sm" data-extend-caa>Allow our certificate authorities</button>` : ""}</div>`;
}

function reviewRow(row, index, host, context) {
  const conflicts = row.conflicts ?? [];
  const excluded = conflicts.some((code) => CONFLICTS[code]?.[0] === "excluded");
  const live = row.liveValues;
  return html`<tr data-row="${row.key}" class="${excluded ? "muted" : ""}">
    <td><input type="checkbox" data-include="${index}" ${row.include ? "checked" : ""} ${excluded || !context.editable ? "disabled" : ""} aria-label="Copy ${rowLabel(row, host)}" /></td>
    <td class="mono">${row.name ? relativeName(row.name, host) : `line ${row.line ?? "?"}`}</td>
    <td>${row.type ? html`<span class="chip">${row.type}</span>` : "—"}</td>
    <td class="muted">${row.ttl ?? "—"}</td>
    <td class="mono">${(row.values ?? []).map((value) => html`<div>${value}</div>`)}
      ${conflicts.includes("stale-source") && Array.isArray(live) ? html`<div class="hint" data-live>${live.length > 0 ? `live now: ${live.join(", ")}` : "gone from your live DNS"}</div>` : ""}</td>
    <td><span class="chip" data-source>${SOURCES[row.source] ?? row.source ?? "—"}</span></td>
    <td>${conflicts.map((code) => conflictLine(row, index, code, context))}</td>
    <td class="actions">${context.editable && !excluded && WRITABLE.includes(row.type) ? html`<button class="btn btn-ghost btn-sm" data-edit-row="${index}">${icon("pencil")} Edit</button>` : ""}</td>
  </tr>`;
}

function reviewCard(session, host, context) {
  const rows = session.rows ?? [];
  return html`<div class="card" data-review>
    <div class="card-head"><h2>Records to copy</h2><div class="toolbar"><span class="muted">${plural(rows.length, "row")} · kept 7 days after the last change</span>
      ${context.editable ? html`<button class="btn btn-sm" data-add-row>${icon("plus")} Add a record</button>` : ""}</div></div>
    ${rows.length > 0
      ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Copy</th><th>Name</th><th>Type</th><th>TTL</th><th>Values</th><th>From</th><th style="min-width:300px">Needs a look</th><th></th></tr></thead>
          <tbody>${rows.map((row, index) => reviewRow(row, index, host, context))}</tbody>
        </table></div>`
      : html`<div class="card-body muted">No records found yet: upload a zone file, or add them by hand.</div>`}
  </div>`;
}

function gatePanel(session, host, manage) {
  const gate = session.gate ?? {};
  const rows = session.rows ?? [];
  const given = session.acknowledged ?? [];
  const asks = [...new Set([...(gate.acknowledgementsMissing ?? []), ...given])];
  const jumps = (keys) => keys.map((key) => html`<button class="btn btn-ghost btn-sm" data-jump="${key}">${rowLabel(rows.find((row) => row.key === key) ?? { line: key.replace(/^line /, "") }, host)}</button>`);
  const blocking = gate.blockingKeys ?? [];
  const waiting = gate.unacknowledgedKeys ?? [];
  return html`<div class="card" data-gate>
    <div class="card-head"><h2>Before the copy</h2></div>
    <div class="card-body form">
      <p class="hint">We write the rows you keep into your DNS zone at Insidefi, then check them at our four name servers. Your name servers appear on the domain page once they answer.</p>
      ${gate.zoneReady === false ? html`<div class="form-note warning-text">Your DNS zone is still being set up: you can copy once it's ready.</div>` : ""}
      ${(gate.includedSets ?? 0) > (gate.maxSets ?? Infinity) ? html`<div class="form-note danger-text">More than ${(gate.maxSets ?? 0).toLocaleString()} record sets: contact support.</div>` : ""}
      ${blocking.length > 0 ? html`<div data-gate-blocking><span class="danger-text">${plural(blocking.length, "row")} to leave out or fix:</span> ${jumps(blocking)}</div>` : ""}
      ${waiting.length > 0 ? html`<div data-gate-unacknowledged><span class="warning-text">${plural(waiting.length, "row")} to accept or leave out:</span> ${jumps(waiting)}</div>` : ""}
      ${asks.map((code) => {
        const [label, why] = GATE_ACKS[code] ?? [String(code).replaceAll("-", " "), ""];
        return html`<label class="check" data-gate-ack="${code}"><input type="checkbox" data-ack-gate="${code}" ${given.includes(code) ? "checked" : ""} ${manage ? "" : "disabled"} /> <span>${label}${why ? html` <span class="hint">${why}</span>` : ""}</span></label>`;
      })}
      ${gate.allowed ? html`<p class="success-text" data-gate-open>Nothing stops the copy.</p>` : ""}
      ${manage
        ? html`<div class="toolbar"><button class="btn btn-primary" data-confirm ${gate.allowed ? "" : "disabled"}>${icon("copy-check")} Copy ${plural(gate.includedSets ?? 0, "record set")}</button>
            <button class="btn btn-ghost" data-discard>${icon("rotate-ccw")} Start over</button></div>`
        : ""}
    </div>
  </div>`;
}

function verifyCard(session, host, domainHref, manage) {
  if (session.status === "confirmed") {
    return html`<div class="card" data-verify>
      <div class="card-head"><h2>Copied</h2><span class="chip chip-success">${icon("check")} served</span></div>
      <div class="card-body"><p class="success-text" data-verified>Your records are served. Your name servers are on the domain page.</p>
        <p><a class="btn btn-sm" href="${domainHref}" data-back>Back to the domain</a></p></div>
    </div>`;
  }
  const verification = session.verification ?? {};
  const sample = verification.sample ?? [];
  const mismatched = verification.mismatched ?? [];
  const copied = (session.rows ?? []).filter((row) => row.include && WRITABLE.includes(row.type)).length;
  return html`<div class="card" data-verify>
    <div class="card-head"><h2>Checking the copy</h2>${manage ? html`<button class="btn btn-sm" data-check-now>${icon("refresh-cw")} Check now</button>` : ""}</div>
    <div class="card-body">
      <p>Copied ${plural(copied, "record set")}. Checking them at our four name servers…</p>
      <p class="hint">We ask for ${plural(sample.length, "set")}, every email record among them · ${verification.checkedAt ? `last checked ${timeAgo(verification.checkedAt)}` : "not checked yet: this takes about a minute"}</p>
      <ul class="plain-list mono" data-sample>${sample.map((set) => html`<li>${relativeName(set.name, host)} ${set.type}${mismatched.some((one) => one.name === set.name && one.type === set.type) ? html` <span class="chip chip-warning" data-mismatched>not served yet</span>` : ""}</li>`)}</ul>
    </div>
  </div>`;
}

export async function renderDomainImport({ params }) {
  const id = params.id;
  const domainId = params.domainId;
  const content = await shell({ workspaceId: id, active: "domains", crumb: "Domains" });
  if (!content) {
    return;
  }
  const here = navigation();
  const manage = can("domain.manage");
  const domainHref = `#/w/${id}/domains/${domainId}`;
  const importPath = domainsPath(id, `/${domainId}/import`);
  const [domainResult, importResult] = await Promise.all([get(domainsPath(id, `/${domainId}`)), get(importPath)]);
  if (navigation() !== here) {
    return;
  }
  if (!domainResult.ok || !importResult.ok) {
    mount(content, emptyState({ iconName: "triangle-alert", title: "Couldn't load the copy", text: (domainResult.ok ? importResult : domainResult).error, action: html`<a class="btn" href="${domainHref}">Back to the domain</a>` }));
    return;
  }
  const domain = domainResult.data;
  const host = domain.host;
  let view = importResult.data;

  function draw() {
    const session = view.session;
    const open = !CLOSED.includes(view.migration?.status);
    const reviewing = session?.status === "reviewing";
    const context = { gate: session?.gate, editable: manage && open && reviewing };
    // A redraw keeps a zone file half pasted.
    const draft = content.querySelector("[data-zone-text]")?.value ?? "";
    mount(
      content,
      html`
        <div class="page-head">
          <div><h1>Copy your records — ${host}</h1>
            <p><a href="${domainHref}">${host}</a> / <span data-migration>${MIGRATION_LINES[view.migration?.status] ?? view.migration?.status ?? "—"}</span></p></div>
        </div>
        <div class="section-stack">
          ${open ? scanCard(view, manage, domainHref) : ""}
          ${open ? zoneFileCard(view, manage) : ""}
          ${open && !session ? emptyState({ iconName: "copy", title: "No review yet", text: "Scan your current DNS or add a zone file: what they find shows here for you to review." }) : ""}
          ${reviewing ? reviewCard(session, host, context) : ""}
          ${reviewing ? gatePanel(session, host, context.editable) : ""}
          ${["verifying", "confirmed"].includes(session?.status) ? verifyCard(session, host, domainHref, manage) : ""}
        </div>`,
    );
    const textarea = content.querySelector("[data-zone-text]");
    if (textarea) {
      textarea.value = draft;
    }
    wire();
  }

  async function load() {
    const result = await get(importPath);
    if (navigation() !== here) {
      return;
    }
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    view = result.data;
    draw();
  }

  /** A write answers the whole copy: draw it. A refusal says why, and a stale page reads it again. */
  async function answer(result, done) {
    if (!result.ok) {
      toast(refusal(result), "error");
      return RELOAD_ON.includes(result.code) ? load() : draw();
    }
    view = result.data;
    draw();
    toast(done);
  }

  const save = async (body) => answer(await patch(importPath, body), "Saved");

  async function readUpload(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      event.target.value = "";
      toast(TOO_LARGE, "error");
      return;
    }
    content.querySelector("[data-zone-text]").value = await file.text();
  }

  async function addZoneFile() {
    const form = content.querySelector("[data-zone-form]");
    const text = form.querySelector("[data-zone-text]").value;
    setFormError(form, null);
    if (text.trim() === "") {
      setFormError(form, "Paste your zone file, or upload it.");
      return;
    }
    if (new Blob([text]).size > MAX_FILE_BYTES) {
      setFormError(form, TOO_LARGE);
      return;
    }
    const result = await post(`${importPath}/zone-file`, { text: text });
    if (!result.ok) {
      setFormError(form, refusal(result));
      return;
    }
    content.querySelector("[data-zone-text]").value = "";
    await answer(result, "Zone file added");
  }

  /** Edit a row's values and TTL, or add one by hand (`row` null). */
  function openRow(row) {
    openModal({
      title: row ? `Edit ${rowLabel(row, host)}` : "Add a record",
      subtitle: row ? "New values make it yours: its acknowledgements are cleared." : `Under ${host}; @ is the root.`,
      body: html`<form class="modal-body form" novalidate>
          ${row
            ? ""
            : html`<div class="row-2"><label class="field"><span>Name</span><input type="text" name="name" placeholder="@ or www" /></label>
              <label class="field"><span>Type</span><select name="type">${WRITABLE.map((type) => html`<option>${type}</option>`)}</select></label></div>`}
          <label class="field"><span>TTL <span class="muted">(seconds)</span></span><input type="number" name="ttl" min="60" max="172800" value="${row?.ttl ?? 3600}" /></label>
          <label class="field"><span>Values <span class="muted">(one per line)</span></span><textarea class="mono" rows="4" name="values">${(row?.values ?? []).join("\n")}</textarea></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>${row ? "Save" : "Add"}</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        form.addEventListener("submit", (event) => event.preventDefault());
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            const values = formValues(form);
            const edit = { ttl: Number(values.ttl), values: values.values.split("\n").map((value) => value.trim()).filter(Boolean) };
            const body = row ? { rows: [{ key: row.key, ...edit }] } : { add: [{ name: absoluteName(values.name, host), type: values.type, ...edit }] };
            const result = await patch(importPath, body);
            if (!result.ok) {
              setFormError(form, refusal(result));
              return;
            }
            close();
            await answer(result, row ? "Saved" : "Added");
          }),
        );
      },
    });
  }

  async function discard() {
    const yes = await confirmDialog({ title: "Start over?", message: "This review and every decision in it are thrown away. Your current DNS isn't touched.", confirmLabel: "Start over", danger: true });
    if (yes) {
      await answer(await del(importPath), "Review thrown away");
    }
  }

  function wire() {
    const rows = view.session?.rows ?? [];
    const click = (selector, action) => content.querySelectorAll(selector).forEach((button) => button.addEventListener("click", (event) => busy(event.currentTarget, () => action(event.currentTarget))));
    click("[data-scan]", async () => answer(await post(`${importPath}/scan`, {}), "Scanned your current DNS"));
    click("[data-zone-add]", addZoneFile);
    click("[data-extend-caa]", () => save({ extendCaa: true }));
    click("[data-confirm]", async () => answer(await post(`${importPath}/confirm`, {}), "Copying your records"));
    click("[data-check-now]", async () => (await checkNow(id, domain)) && load());
    content.querySelector("[data-zone-form]")?.addEventListener("submit", (event) => event.preventDefault());
    content.querySelector("[data-zone-upload]")?.addEventListener("change", readUpload);
    content.querySelector("[data-add-row]")?.addEventListener("click", () => openRow(null));
    content.querySelector("[data-discard]")?.addEventListener("click", discard);
    content.querySelectorAll("[data-edit-row]").forEach((button) => button.addEventListener("click", () => openRow(rows[button.dataset.editRow])));
    content.querySelectorAll("[data-include]").forEach((box) => box.addEventListener("change", () => save({ rows: [{ key: rows[box.dataset.include].key, include: box.checked }] })));
    content.querySelectorAll("[data-ack-row]").forEach((box) =>
      box.addEventListener("change", () => {
        const row = rows[box.dataset.ackRow];
        save({ rows: [{ key: row.key, acknowledged: toggled(row.acknowledged, box.dataset.code, box.checked) }] });
      }),
    );
    content.querySelectorAll("[data-ack-gate]").forEach((box) => box.addEventListener("change", () => save({ acknowledged: toggled(view.session?.acknowledged, box.dataset.ackGate, box.checked) })));
    content.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => content.querySelector(`[data-row="${CSS.escape(button.dataset.jump)}"]`)?.scrollIntoView({ block: "center" })));
  }

  draw();
  // The check at our name servers takes about a minute: follow it.
  const timer = setInterval(async () => {
    if (navigation() !== here || !document.body.contains(content)) {
      clearInterval(timer);
      return;
    }
    if (view.session?.status === "verifying" && !document.querySelector(".modal-backdrop, .popover")) {
      await load();
    }
  }, POLL_MS);
}
