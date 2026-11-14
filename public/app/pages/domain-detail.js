// One custom domain: what needs doing (banners in the design's words), the DNS
// records with Check now, a handed-over root's name servers and registrar, the
// certificate and its log, emailing the records, and the actions. Re-read
// every 30 s while anything is in flight.

import { get, patch, post, ws } from "../lib/api.js";
import { go, navigation } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, copyText, emptyState, formValues, html, icon, mount, plural, popover, setFormError, shortDate, timeAgo, toast } from "../lib/ui.js";
import { archiveDomain, checkNow, dnsChip, domainsPath, downloadZoneFile, healthChip, healthOf, makePrimary, openAssign, openDelete, preflightNotes, recheckCertificate, rerunPreflight, restoreDomain, sessionsText, sslChip } from "./domains.js";
import { shell } from "./shell.js";

const POLL_MS = 30_000;
// How a root's bare name reaches its serving host (D-23).
const LANES = { cloudflare: "through Cloudflare", redirector: "through our redirector", forwarding: "by registrar forwarding", none: "not reaching us yet" };
const PROVIDERS = [
  ["godaddy", "GoDaddy"],
  ["cloudflare", "Cloudflare"],
  ["namecheap", "Namecheap"],
  ["google", "Google"],
  ["other", "Other"],
];
// §5.6 of the design: what the customer reads for each certificate failure.
const FAILURE_COPY = {
  caa_blocked: 'A CAA record blocks our certificate authorities. Add 0 issue "letsencrypt.org", 0 issue "pki.goog; cansignhttpexchanges=yes" and 0 issue "ssl.com".',
  dnssec_broken: "DNSSEC is broken for this host. Fix or remove the DS record at your registrar.",
  dns_unreachable: "Your DNS host didn't answer. Fix or remove the DS record at your registrar, then Check now.",
  timed_out: "Validation timed out. Check the records, then Check now.",
  blocked: "This host is blocked at our edge. Contact support.",
  ca_error: "The certificate authority had a problem. We're retrying; nothing to do.",
  held_elsewhere: "This host is still connected to another platform. Remove it there first, then Check now.",
};
// A delegated root's Route 53 zone, step by step (K.4), then kept or deleted once archived (D19).
const ZONE_PROGRESS = { creating: "Creating your DNS zone", created: "Writing our records", records_applying: "Writing our records", ready: "Zone ready", tombstoned: "Zone kept", deleted: "Zone deleted" };
// An archived root's zone: kept while its name servers may still point at us, then deleted (D19).
const ARCHIVED_LINES = {
  "pending-release": "Being deleted: we finish once your domain's name servers no longer point at us (pending DNS release). Restore it to keep it.",
  tombstoned: "Archived. Its zone is kept while your name servers may still point at us; point them elsewhere and we delete it about a week later.",
  deleted: "Archived. Its zone was deleted; restoring makes a new one with new name servers.",
};
// Once the zone exists its records can be read (K.8).
const ZONE_READABLE = ["created", "records_applying", "ready"];
// Why the name servers are still withheld (K.5); ds-ttl-running names its time.
const BLOCKER_COPY = {
  "zone-not-ready": "Your DNS zone is being set up",
  "preflight-pending": "We haven't checked your domain's registrar and DNSSEC yet",
  "registrar-blocked": "Your registrar blocks a name-server change",
};
// The copy's step and the import page's link words, by migration.status (K.7).
const MIGRATION_BLOCKER = {
  pending: ["Copy your existing records first", "Copy your records"],
  reviewing: ["Finish reviewing your copied records", "Open the review"],
  ready: ["Checking your copied records at our name servers", "See the check"],
};
// Where to change the name servers, keyed by the registrar (p3-rdap-registrars §8.1).
const GUIDE_STEPS = {
  godaddy: "At GoDaddy, open Domain Portfolio → the domain → DNS → Nameservers, and choose I'll use my own nameservers.",
  namecheap: "At Namecheap, open Domain List → Manage → Nameservers, and pick Custom DNS from the drop-down.",
  squarespace: "At Squarespace, open Domains → the domain → DNS → Domain Nameservers → Use Custom Nameservers. Confirm your password and continue past the DNSSEC prompt.",
  porkbun: "At Porkbun, open Account → Domain Management → the domain's Details → the Nameservers edit icon.",
  ionos: "At IONOS, open Domains, click the gear under Actions → Name Server, and choose Use Custom Name Servers.",
  hostinger: "At Hostinger, open the domain's DNS / Nameservers tab and choose Change Nameservers.",
  "network-solutions": "At Network Solutions, open Domains → the domain → Manage → the Nameservers tab → Edit.",
  "name-com": "At Name.com, open My Domains → the domain → Manage Nameservers.",
  dynadot: "At Dynadot, open My Domains → Manage Domains, tick the domain, then Action → DNS Settings → Name Servers.",
  ovhcloud: "At OVHcloud, open Web Cloud → Domain names → the domain → DNS servers → Modify DNS servers. Don't keep OVHcloud's own servers beside ours.",
  gandi: "At Gandi, open Domain → the domain → the Nameservers tab → Change → External.",
  wix: "At Wix, unassign the domain from its site, then open Domains → Domain Actions → Manage DNS records → Nameservers → Use custom nameservers.",
  other: "Sign in where you bought the domain, or the website builder you bought it through, open its name server settings and choose custom name servers.",
};
// What the parent zone lists, asked directly (K.6).
const DELEGATION_LINES = {
  awaiting: "Not switched yet: your domain still uses its old name servers.",
  blocked_ds: "Not switched yet: DNSSEC is still on for your domain.",
  partial: "Partly switched: your domain lists some of our name servers beside others. Remove every other one.",
  delegated: "Switched: your domain uses our name servers.",
  moved_away: "Your domain no longer uses our name servers. Set them again, or its pages stop within 72 hours.",
};

/** Polls while DNS, the certificate or the pages are on their way; a domain needing attention waits for Check now. */
const inFlight = (domain) => ["pending", "ssl-pending", "going-live"].includes(healthOf(domain));

function banners(domain, handover) {
  const lines = [];
  const add = (kind, text) => lines.push({ kind, text });
  const serving = domain.dns.records[0];
  if (domain.lifecycle === "archived") {
    const zone = handover?.zone?.status;
    add("warning", ARCHIVED_LINES[domain.deletePending && zone === "tombstoned" ? "pending-release" : zone] ?? "Archived. Restore it to use it again; the same TXT token has to be found again.");
    return lines;
  }
  if (domain.claimedElsewhere) {
    add("danger", "Another workspace has already verified this host. Support handles disputes; it is yours by itself if they let it go.");
  }
  // Behind a shut gate the client has changed nothing yet; the Name servers card says what waits.
  if (domain.dns.nxdomain && handover?.cutover?.allowed !== false) {
    add("info", `${domain.servingHost} isn't visible yet. DNS changes can take up to 48 hours to spread.`);
  }
  if (domain.dns.status === "mismatch" && serving?.observed) {
    add("danger", `${domain.servingHost} points to ${serving.observed}, not ${serving.value}.`);
  }
  if (domain.dns.status === "conflict") {
    add("danger", `Remove the other records for this name${serving?.observed ? ` (${serving.observed})` : ""}.`);
  }
  if (domain.dns.disagreeing?.length > 0) {
    const verb = domain.dns.disagreeing.length === 1 ? "doesn't" : "don't";
    add("warning", `Your nameservers disagree: ${domain.dns.disagreeing.join(", ")} ${verb} have the ${serving?.type ?? "CNAME"} for ${domain.servingHost}, so some visitors miss your pages. Remove the old nameservers at your registrar, or add the record there too.`);
  }
  if (domain.ssl.status === "failed" || (domain.ssl.status === "active" && domain.ssl.failureReason)) {
    const renewal = domain.ssl.status === "active" ? "Renewal is failing. " : "";
    add("danger", renewal + (FAILURE_COPY[domain.ssl.failureReason] ?? "The certificate couldn't be issued."));
  }
  if (domain.ssl.status === "expired") {
    add("danger", "The certificate expired. Renew it now.");
  }
  if (domain.warmingFailed) {
    add("danger", "We can reach the certificate but not the page. Is a rule on your Cloudflare blocking /_a/ or /.well-known/?");
  }
  if (domain.trials >= 3) {
    add("warning", "We stopped trying by ourselves after 3 attempts. Check now tries again.");
  }
  if (domain.liveElsewhere && domain.ssl.status !== "active") {
    add("info", "Your old site keeps serving: add the two Cloudflare TXT records below when they appear, and the certificate is issued before you move the CNAME.");
  }
  if (domain.liveElsewhere && domain.dns.provider === "cloudflare") {
    add("warning", "Hosts proxied through your own Cloudflare can't be pre-validated: expect a short gap without HTTPS when you switch the CNAME.");
  }
  if (domain.liveElsewhere && domain.ssl.status === "active" && domain.dns.status !== "verified") {
    add("info", "The certificate is ready. Now switch the CNAME.");
  }
  if (healthOf(domain) === "going-live") {
    add("info", "Certificate live · moving your pages. This takes a minute.");
  }
  if (domain.apex?.reason === "alias") {
    add("warning", `Your DNS host's ALIAS at ${domain.host} can never route to us. Use the record below or forward ${domain.host} at your registrar.`);
  } else if (domain.apex?.status === "failed") {
    add("warning", `${domain.host} isn't reaching us. Add the record for your DNS host (below), or set up registrar forwarding. ${domain.servingHost} is not affected.`);
  }
  const txt = domain.dns.records.find((record) => record.type === "TXT" && record.host.includes("_verify"));
  if (domain.live && txt?.state === "found") {
    add("success", "Live. You can remove the TXT record now, or keep it so a restore needs nothing new.");
  }
  return lines;
}

const BANNER_STYLE = { danger: "danger-text", warning: "warning-text", success: "success-text", info: "" };

function stateCell(record) {
  if (record.state === "found") {
    return html`<span class="chip chip-success">${icon("check")} found${record.foundAt && record.foundAt !== record.host ? ` at ${record.foundAt}` : ""}</span>`;
  }
  if (record.state === "mismatch") {
    return html`<span class="chip chip-danger">mismatch</span>${record.observed ? html`<div class="hint">sees ${record.observed}</div>` : ""}`;
  }
  return html`<span class="chip">pending</span>`;
}

/** No registrar forwarding on a delegated row: it stops working once the name servers move to us. */
function recordsTable(domain, handover) {
  return html`<div class="table-wrap"><table class="table" data-records>
    <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>TTL</th><th>State</th></tr></thead>
    <tbody>${domain.dns.records.map(
      (record, index) => html`<tr>
        <td><span class="chip">${record.type}</span></td>
        <td class="mono">${record.host}${record.altHost ? html`<div class="hint">or ${record.altHost} at the root</div>` : ""}</td>
        <td class="mono">${record.value} <button class="btn btn-ghost btn-icon btn-sm" data-copy="${index}" aria-label="Copy value">${icon("copy")}</button>
          ${!handover && record.alternatives?.includes("forwarding") ? html`<div class="hint">or forward ${domain.host} to https://${domain.servingHost} at your registrar, keeping the path</div>` : ""}</td>
        <td class="muted">${record.ttl}</td>
        <td>${stateCell(record)}</td>
      </tr>`,
    )}</tbody>
  </table></div>`;
}

/** The removed DS record's last cached answers, counted down; the 30 s poll redraws it. */
function dsCountdown(switchAfter) {
  const minutes = Math.floor((new Date(switchAfter).getTime() - Date.now()) / 60_000);
  return minutes > 0 ? `Old DNSSEC answers expire in ${Math.floor(minutes / 60)} h ${minutes % 60} min, at ${new Date(switchAfter).toLocaleString()}` : "Old DNSSEC answers expire any moment now";
}

function blockerText(blocker, handover, importHref) {
  if (blocker === "migration-incomplete") {
    const [text, link] = MIGRATION_BLOCKER[handover.migration?.status] ?? MIGRATION_BLOCKER.pending;
    return html`${text} · <a href="${importHref}" data-import-link>${link}</a>`;
  }
  if (blocker === "ds-ttl-running") {
    return dsCountdown(handover.delegation?.switchAfter);
  }
  if (blocker === "ds-present") {
    return `DNSSEC is on: turn it off at ${handover.preflight?.registrar ?? "your registrar"} first`;
  }
  return BLOCKER_COPY[blocker] ?? blocker;
}

/** The steps, kept while the parent still lists other name servers. */
function switchSteps(instructions) {
  return html`<ol class="plain-list" data-steps>
      <li>${GUIDE_STEPS[instructions.guide] ?? GUIDE_STEPS.other}</li>
      <li>Enter ${instructions.guide === "wix" ? "the first two" : "all four"} name servers below, exactly as shown, and remove every other one.</li>
      <li>Save, then press Check now.</li>
    </ol>`;
}

/**
 * The zone's progress and the parent's answer, then what still shuts the gate, or the names once it opens.
 * Archived, only the zone's state and its file: the parent's answer is no longer checked.
 */
function nameServersCard(handover, importHref, zoneHref, archived) {
  const status = handover.zone?.status;
  // A kept zone exports itself; a deleted one, the copy saved at archive.
  const saved = status === "deleted" ? handover.zone.exportedAt : null;
  const cutover = handover.cutover ?? {};
  const delegation = handover.delegation ?? {};
  const instructions = cutover.instructions;
  const switching = instructions && delegation.status !== "delegated";
  const names = instructions?.nameServers ?? cutover.nameServers ?? [];
  return html`<div class="card" data-handover>
    <div class="card-head"><h2>Name servers</h2><div class="toolbar">${!archived && ZONE_READABLE.includes(status) ? html`<a class="btn btn-sm" href="${zoneHref}" data-zone-link>${icon("list")} DNS records</a>` : ""}${status === "tombstoned" || saved ? html`<button class="btn btn-sm" data-export>${icon("download")} Download zone file</button>` : ""}${saved ? html`<span class="muted" data-saved>saved ${shortDate(saved)}</span>` : ""}<span class="chip ${status === "ready" ? "chip-success" : "chip-info"}" data-zone>${ZONE_PROGRESS[status] ?? status}</span></div></div>
    ${archived
      ? ""
      : html`<div class="card-body">
      ${DELEGATION_LINES[delegation.status] ? html`<p data-delegation>${DELEGATION_LINES[delegation.status]}${delegation.status === "delegated" && (delegation.oursListed ?? 4) < 4 ?` Your registrar lists ${delegation.oursListed} of our four name servers: that works; add all four if it lets you.` : ""}</p>` : ""}
      ${cutover.allowed
        ? html`${switching ? switchSteps(instructions) : html`<p>Our name servers</p>`}
          <ul class="plain-list mono" data-name-servers>${names.map((name) => html`<li>${name} <button class="btn btn-ghost btn-icon btn-sm" data-copy-ns="${name}" aria-label="Copy ${name}">${icon("copy")}</button></li>`)}</ul>
          <p><button class="btn btn-sm" data-copy-all-ns>${icon("copy")} Copy all</button></p>
          ${switching
            ? html`${(instructions.beforeSwitch ?? []).length > 0
                ? html`<p>Optional: right before you switch, add this at your current DNS provider too, and keep it for ${instructions.cacheHours} hours.</p>
                  <ul class="plain-list mono" data-before-switch>${instructions.beforeSwitch.map((row, index) => html`<li>${row.type} ${row.host} → ${row.value} (TTL ${row.ttl}) <button class="btn btn-ghost btn-icon btn-sm" data-copy-before="${index}" aria-label="Copy value">${icon("copy")}</button></li>`)}</ul>`
                : ""}
              <p class="hint">Old answers can stay cached for up to ${instructions.cacheHours} hours: don't launch a campaign on the switch day.</p>
              ${instructions.dsWaitUntil ? html`<p class="hint">The DNSSEC wait ended ${timeAgo(instructions.dsWaitUntil)}.</p>` : ""}`
            : ""}`
        : html`<ul class="plain-list" data-blockers>${(cutover.blockers ?? []).map((blocker) => html`<li>${blockerText(blocker, handover, importHref)}</li>`)}</ul>`}</div>`}
  </div>`;
}

/** What the registry said, when, and a way to ask again. */
function preflightCard(preflight, rerun) {
  return html`<div class="card" data-preflight-panel>
    <div class="card-head"><h2>Registrar</h2>
      <div class="toolbar"><span class="muted">${preflight?.checkedAt ? `checked ${timeAgo(preflight.checkedAt)}` : "not checked yet"}</span>
        ${rerun ? html`<button class="btn btn-sm" data-preflight-rerun>${icon("refresh-cw")} Check the registrar again</button>` : ""}</div></div>
    <div class="card-body">${preflight?.checkedAt
      ? html`<dl class="kv"><dt>Registrar</dt><dd>${preflight.registrar ?? "—"}</dd><dt>Expires</dt><dd>${shortDate(preflight.expiresAt)}</dd></dl>
        <div class="field">${preflightNotes(preflight)}</div>`
      : html`<p class="muted">We look up its registrar, DNSSEC and email within a minute of the add.</p>`}</div>
  </div>`;
}

function certificateCard(ssl) {
  const step = ["provisioning", "issuing"].includes(ssl.status);
  return html`<div class="card-body"><dl class="kv">
      <dt>Status</dt><dd>${sslChip({ ssl })}${step ? html` <span class="muted">Step ${ssl.step} of 4 · elapsed ${ssl.elapsedSeconds}s · ETA ~${Math.round(ssl.etaSeconds / 60)} min</span>` : ""}</dd>
      <dt>Issuer</dt><dd>${ssl.issuer ?? "—"}</dd>
      <dt>Valid until</dt><dd>${ssl.validUntil ? shortDate(ssl.validUntil) : "—"}</dd>
      <dt>Auto-renew</dt><dd>${ssl.autoRenew ? "On" : "Off"}</dd>
    </dl>
    ${ssl.log.length > 0 ? html`<ul class="plain-list mono" data-log>${ssl.log.map((line) => html`<li>${line.glyph} ${line.text} <span class="muted">${timeAgo(line.at)}</span></li>`)}</ul>` : html`<p class="muted">No certificate yet: it starts once DNS is verified.</p>`}
  </div>`;
}

export async function renderDomainDetail({ params }) {
  const id = params.id;
  const domainId = params.domainId;
  const content = await shell({ workspaceId: id, active: "domains", crumb: "Domains" });
  if (!content) {
    return;
  }
  const here = navigation();
  const manage = can("domain.manage");
  let domain = null;
  let projects = [];

  async function load() {
    const [domainResult, sslResult, projectsResult] = await Promise.all([
      get(domainsPath(id, `/${domainId}`)),
      get(domainsPath(id, `/${domainId}/ssl`)),
      projects.length === 0 ? get(ws(id, "/projects?limit=100")) : null,
    ]);
    if (navigation() !== here) {
      return false;
    }
    if (!domainResult.ok) {
      mount(content, emptyState({ iconName: "triangle-alert", title: "Couldn't load this domain", text: domainResult.error, action: html`<a class="btn" href="#/w/${id}/domains">Back to domains</a>` }));
      return false;
    }
    domain = domainResult.data;
    projects = projectsResult?.data?.items ?? projects;
    draw(sslResult.ok ? sslResult.data : null);
    return true;
  }

  function draw(ssl) {
    const project = projects.find((one) => one.projectId === domain.projectId);
    const archived = domain.lifecycle === "archived";
    // An API from before Phase 2 sends no dns.mode and no handover: the records lane.
    const handover = domain.dns.mode === "delegated" ? domain.handover : null;
    mount(
      content,
      html`
        <div class="page-head">
          <div><h1>${domain.host} ${healthChip(domain)}</h1>
            <p><a href="#/w/${id}/domains">Domains</a> / pages serve on <b>${domain.servingHost}</b> · ${project ? project.name : "unassigned"}${domain.primary ? " · primary" : ""} · ${dnsChip(domain)} ${sslChip(domain)}</p></div>
          <div class="actions">
            ${manage && !archived ? html`<button class="btn" data-check>${icon("refresh-cw")} Check now</button>` : ""}
            ${manage ? html`<button class="btn btn-ghost btn-icon" data-more data-popover-anchor aria-label="More actions">${icon("ellipsis")}</button>` : ""}
          </div>
        </div>
        <div class="section-stack">
          ${banners(domain, handover).map((line) => html`<div class="form-note ${BANNER_STYLE[line.kind]}" data-banner>${line.text}</div>`)}
          ${handover ? nameServersCard(handover, `#/w/${id}/domains/${domainId}/import`, `#/w/${id}/domains/${domainId}/zone`, archived) : ""}
          ${handover ? preflightCard(handover.preflight, manage && !archived) : ""}
          <div class="card">
            <div class="card-head"><h2>${handover ? "Records we keep in your zone" : "DNS records"}</h2>
              <div class="toolbar"><span class="muted">${plural(domain.dns.checks, "check")} · last ${domain.dns.lastCheckedAt ? timeAgo(domain.dns.lastCheckedAt) : "never"}</span>
                ${handover ? "" : html`<select data-provider ${manage && !archived ? "" : "disabled"} aria-label="Where is your DNS managed?">${PROVIDERS.map(([value, label]) => html`<option value="${value}" ${domain.dns.provider === value ? "selected" : ""}>${label}</option>`)}</select>`}</div></div>
            ${recordsTable(domain, handover)}
          </div>
          <div class="card">
            <div class="card-head"><h2>Certificate</h2>${manage && !archived && domain.dns.status === "verified" && !["provisioning", "issuing"].includes(domain.ssl.status) ? html`<button class="btn btn-sm" data-renew>${icon("shield-check")} Renew</button>` : ""}</div>
            ${ssl ? certificateCard(ssl) : html`<div class="card-body muted">Couldn't load the certificate.</div>`}
          </div>
          <div class="card">
            <div class="card-head"><h2>Usage</h2></div>
            <div class="card-body"><dl class="kv">
              <dt>Type</dt><dd>${domain.type}${domain.apex ? ` · ${domain.host} redirects ${LANES[domain.apex.lane] ?? domain.apex.lane} (${domain.apex.status})` : ""}</dd>
              <dt>Pages · quizzes</dt><dd>${domain.pages} · ${domain.quizzes}</dd>
              <dt>Sessions 30d</dt><dd>${sessionsText(domain.sessions30d)}${domain.sessions30d === null ? html` <span class="hint">only campaign pages have traffic</span>` : ""}</dd>
              <dt>Active campaigns</dt><dd>${domain.activeCampaigns}</dd>
              <dt>Added</dt><dd>${timeAgo(domain.addedAt)}</dd>
              <dt>First live</dt><dd>${domain.activatedAt ? timeAgo(domain.activatedAt) : "not yet"}</dd>
            </dl></div>
          </div>
          ${manage && !archived && !handover
            ? html`<div class="card">
                <div class="card-head"><h2>Email the records</h2></div>
                <form class="card-body form" data-email novalidate>
                  <label class="field"><span>To</span><input type="email" name="email" placeholder="it@brand.com" required /></label>
                  <label class="field"><span>Note <span class="muted">(optional)</span></span><input type="text" name="note" maxlength="280" /></label>
                  <div><button class="btn btn-sm" data-send>Send</button> <span class="hint" data-sent></span></div>
                </form>
              </div>`
            : ""}
        </div>`,
    );
    wire();
  }

  /** Done: read it all again. */
  const then = (action) => async () => {
    if (await action()) {
      await load();
    }
  };

  function wire() {
    content.querySelector("[data-check]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => checkNow(id, domain))));
    content.querySelector("[data-renew]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => recheckCertificate(id, domain))));
    content.querySelector("[data-export]")?.addEventListener("click", (event) => busy(event.currentTarget, () => downloadZoneFile(id, domain)));
    content.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => copyText(domain.dns.records[Number(button.dataset.copy)].value)));
    content.querySelectorAll("[data-copy-ns]").forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copyNs)));
    content.querySelector("[data-copy-all-ns]")?.addEventListener("click", () => copyText([...content.querySelectorAll("[data-copy-ns]")].map((button) => button.dataset.copyNs).join("\n")));
    content.querySelectorAll("[data-copy-before]").forEach((button) => button.addEventListener("click", () => copyText(domain.handover.cutover.instructions.beforeSwitch[Number(button.dataset.copyBefore)].value)));
    content.querySelector("[data-preflight-rerun]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => rerunPreflight(id, domain))));
    content.querySelector("[data-provider]")?.addEventListener("change", async (event) => {
      const result = await patch(domainsPath(id, `/${domainId}`), { provider: event.target.value });
      toast(result.ok ? "Saved" : result.error, result.ok ? "success" : "error");
    });
    content.querySelector("[data-more]")?.addEventListener("click", (event) => popover(event.currentTarget, menu()));
    const form = content.querySelector("[data-email]");
    form?.addEventListener("submit", (event) => event.preventDefault());
    form?.querySelector("[data-send]").addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const values = formValues(form);
        setFormError(form, null);
        const body = { email: values.email.trim() };
        if (values.note.trim()) {
          body.note = values.note.trim();
        }
        const result = await post(domainsPath(id, `/${domainId}/email-records`), body);
        if (!result.ok) {
          setFormError(form, result.error);
          return;
        }
        form.querySelector("[data-sent]").textContent = `Sent to ${result.data.to} · ${result.data.remainingToday} left today`;
      }),
    );
  }

  function menu() {
    if (domain.lifecycle === "archived") {
      return [
        { label: "Restore", icon: "archive-restore", onClick: then(() => restoreDomain(id, domain)) },
        "sep",
        { label: "Delete", icon: "trash-2", danger: true, onClick: () => openDelete(id, domain, () => go(`/w/${id}/domains`)) },
      ];
    }
    const items = [];
    if (!domain.primary && domain.dns.status === "verified") {
      items.push({ label: "Make primary", icon: "star", onClick: then(() => makePrimary(id, domain)) });
    }
    items.push(
      { label: "Assign to project…", icon: "folder-input", onClick: () => openAssign(id, domain, load) },
      "sep",
      { label: "Archive", icon: "archive", onClick: then(() => archiveDomain(id, domain)) },
      { label: "Delete", icon: "trash-2", danger: true, onClick: () => openDelete(id, domain, () => go(`/w/${id}/domains`)) },
    );
    return items;
  }

  if (!(await load())) {
    return;
  }
  // The detail is the polling read (D3): never check-dns, and only while in flight.
  const timer = setInterval(async () => {
    if (navigation() !== here || !document.body.contains(content)) {
      clearInterval(timer);
      return;
    }
    // Never redraw under someone typing: the email form keeps what it holds.
    const typing = content.contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
    const drafted = [...content.querySelectorAll("[data-email] input")].some((input) => input.value.trim() !== "");
    if (inFlight(domain) && !typing && !drafted && !document.querySelector(".modal-backdrop, .popover")) {
      await load();
    }
  }, POLL_MS);
}
