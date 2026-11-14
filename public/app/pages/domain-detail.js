// One custom domain on the handover lane: what needs doing (banners in the
// design's words), the name servers and the switch's steps, the registrar, what
// the bare root does, Amazon's certificate in its four steps, and the actions.
// Re-read every 30 s while anything is in flight. A row from the retired
// records lane shows what it is and offers only the way out.

import { get, patch, ws } from "../lib/api.js";
import { go, navigation } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, copyText, emptyState, html, icon, mount, plural, popover, shortDate, timeAgo, toast } from "../lib/ui.js";
import { archiveDomain, checkNow, dnsChip, domainsPath, downloadZoneFile, healthChip, healthOf, makePrimary, openAssign, openDelete, preflightNotes, recheckCertificate, rerunPreflight, restoreDomain, sessionsText, sslChip } from "./domains.js";
import { shell } from "./shell.js";

const POLL_MS = 30_000;
// A row set up before the handover lane: nothing checks it, and it cannot be restored.
const LEGACY = "This domain was set up on DNS records, a setup nothing runs any more: it is no longer checked and can't be restored. Delete it and add its root again.";
// What the customer reads for each certificate failure, and for a failed replacement.
const FAILURE_COPY = {
  caa_blocked: 'A CAA record on your domain blocks Amazon. Add 0 issue "amazon.com" in DNS records, then check the certificate again.',
  dnssec_broken: "DNSSEC is broken for this host. Fix or remove the DS record at your registrar.",
  dns_unreachable: "Amazon couldn't reach your DNS to confirm the certificate. Check that your name servers answer, then check again.",
  timed_out: "Amazon gave up waiting to confirm the certificate: its record only shows once your name servers point at us. Finish the switch, then check the certificate again.",
  blocked: "Amazon blocks this host. Contact support.",
  ca_error: "Amazon had a problem. We're retrying; nothing to do.",
  held_elsewhere: "This host is still on another CloudFront distribution. Remove it there first, then check the certificate again.",
  validation_conflict: "A record of yours sits where Amazon's validation record must go. Delete it in DNS records, then check the certificate again.",
  adoption_mismatch: "A CloudFront setup with our name for this domain already exists and isn't this one's. Contact support.",
  quota: "We've reached an account limit at Amazon. We're raising it; nothing to do.",
};
// The certificate's four steps on CloudFront; ssl.step says where it stands.
const CERT_STEPS = ["Certificate requested from Amazon", "Validation records written to the zone", "Certificate issued by Amazon", "Serving through CloudFront"];
const STEP_GLYPH = { done: "✓", current: "…", failed: "✕", todo: "○" };
// A root's redirect: whether it answers yet.
const APEX_STATUS = { pending: ["", "Waiting"], active: ["chip-success", "Redirecting"], failed: ["chip-danger", "Not working yet"] };
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
  if (domain.lifecycle === "archived") {
    const zone = handover?.zone?.status;
    add("warning", handover ? (ARCHIVED_LINES[domain.deletePending && zone === "tombstoned" ? "pending-release" : zone] ?? ARCHIVED_LINES.tombstoned) : "Archived. It was set up on DNS records, which nothing runs any more: delete it and add its root again.");
    return lines;
  }
  if (!handover) {
    add("warning", LEGACY);
    return lines;
  }
  if (domain.claimedElsewhere) {
    add("danger", "Another workspace has already verified this host. Support handles disputes; it is yours by itself if they let it go.");
  }
  // Behind a shut gate the client has changed nothing yet; the Name servers card says what waits.
  if (domain.dns.nxdomain && handover.cutover?.allowed !== false) {
    add("info", `${domain.servingHost} isn't visible yet. DNS changes can take up to 48 hours to spread.`);
  }
  if (domain.ssl.status === "failed" || (domain.ssl.status === "active" && domain.ssl.failureReason)) {
    const renewal = domain.ssl.status === "active" ? "Renewal is failing. " : "";
    add("danger", renewal + (FAILURE_COPY[domain.ssl.failureReason] ?? "The certificate couldn't be issued."));
  }
  if (domain.ssl.status === "expired") {
    add("danger", "The certificate expired. Check it again now.");
  }
  if (domain.warmingFailed) {
    add("danger", "We can reach the certificate but not the page. Check again in a few minutes; if it stays, contact support.");
  }
  if (healthOf(domain) === "going-live") {
    add("info", "Certificate live · moving your pages. This takes a minute.");
  }
  if (domain.apex?.mode === "redirect" && domain.apex.status === "failed") {
    add("warning", `${domain.host} isn't redirecting yet. ${domain.servingHost} is not affected: check again in a few minutes.`);
  }
  return lines;
}

const BANNER_STYLE = { danger: "danger-text", warning: "warning-text", success: "success-text", info: "" };

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
 * What to add before the switch: Amazon's validation records only, at the old
 * DNS host, so the certificate is ready when the names move; then the cache
 * warning, and a note when the serving host answers today.
 */
function beforeSwitch(instructions, servingHost) {
  const rows = instructions.beforeSwitch ?? [];
  return html`${rows.length > 0
      ? html`<p data-before-switch-note>Optional: add ${rows.length === 1 ? "this record" : "these records"} at your current DNS host, so the certificate is ready before you switch. Keep ${rows.length === 1 ? "it" : "them"} until the switch is done.</p>
        <ul class="plain-list mono" data-before-switch>${rows.map((row, index) => html`<li>${row.type} ${row.name} → ${row.value} <button class="btn btn-ghost btn-icon btn-sm" data-copy-before="${index}" aria-label="Copy value">${icon("copy")}</button></li>`)}</ul>`
      : ""}
    <p class="hint" data-cache-note>Old answers can stay cached for up to ${instructions.cacheHours} hours: don't launch a campaign on the switch day.</p>
    ${instructions.servingHostNote === "replaces" ? html`<p class="hint" data-serving-note>${servingHost} starts serving your pages at the switch.</p>` : ""}
    ${instructions.dsWaitUntil ? html`<p class="hint">The DNSSEC wait ended ${timeAgo(instructions.dsWaitUntil)}.</p>` : ""}`;
}

/**
 * The zone's progress and the parent's answer, then what still shuts the gate, or the names once it opens.
 * Archived, only the zone's state and its file: the parent's answer is no longer checked.
 */
function nameServersCard(domain, handover, importHref, zoneHref, archived) {
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
          ${switching ? beforeSwitch(instructions, domain.servingHost) : ""}`
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

/** What the bare root answers: its own records, or a 301 to the pages; and the switch between the two. */
function apexCard(domain, manage, archived, zoneHref) {
  const mode = domain.apex?.mode ?? "keep";
  const other = mode === "keep" ? "redirect" : "keep";
  const [tone, words] = APEX_STATUS[domain.apex?.status] ?? ["", ""];
  const editable = mode === "keep" && ZONE_READABLE.includes(domain.handover?.zone?.status);
  return html`<div class="card" data-apex>
    <div class="card-head"><h2>The root: ${domain.host}</h2>
      <div class="toolbar"><span class="chip" data-apex-mode>${mode === "keep" ? "Kept as it is" : `Redirects to ${domain.servingHost}`}</span>${mode === "redirect" && words ? html`<span class="chip ${tone}" data-apex-status>${words}</span>` : ""}</div></div>
    <div class="card-body">
      <p data-apex-text>${mode === "keep"
        ? `${domain.host} keeps whatever answers there today: its records are yours. Your pages are on ${domain.servingHost}.`
        : `${domain.host} sends visitors to ${domain.servingHost}, keeping the path. Its address records are ours while it redirects.`}</p>
      <div class="toolbar">${editable ? html`<a class="btn btn-sm" href="${zoneHref}" data-root-records>Edit its records</a>` : ""}
        ${manage && !archived ? html`<button class="btn btn-sm" data-apex-switch="${other}">${other === "redirect" ? `Redirect ${domain.host} to ${domain.servingHost}` : `Keep ${domain.host} as it is`}</button>` : ""}</div>
    </div>
  </div>`;
}

/**
 * Where step n stands. The ladder sets ssl.step once that step has happened, even
 * before the switch while the status still waits for DNS; nothing is done until
 * a certificate was asked for (startedAt). The next step is the one in progress, or the one that failed.
 */
function stepState(ssl, n) {
  const done = ["active", "expired"].includes(ssl.status) ? CERT_STEPS.length : ssl.startedAt ? ssl.step : 0;
  if (done === 0) {
    return "todo";
  }
  if (n <= done) {
    return "done";
  }
  return n === done + 1 ? (ssl.status === "failed" ? "failed" : "current") : "todo";
}

/** A replacement runs beside the certificate that keeps serving: its progress, or why it failed. */
function replacementLine(replacement) {
  if (["requested", "attached"].includes(replacement?.status)) {
    return html`<p data-replacing>Replacing the certificate: a new one is being issued beside this one, which keeps serving.${replacement.status === "attached" ? " It is being attached now." : ""}</p>`;
  }
  if (replacement?.status === "failed") {
    return html`<p class="warning-text" data-replacing>The replacement failed: ${FAILURE_COPY[replacement.failureReason] ?? "Amazon couldn't issue it."} The certificate in use keeps serving until it ends.</p>`;
  }
  return "";
}

function certificateCard(ssl) {
  const progressing = ["provisioning", "issuing"].includes(ssl.status);
  return html`<div class="card-body"><dl class="kv">
      <dt>Status</dt><dd>${sslChip({ ssl })}${progressing && ssl.elapsedSeconds !== null ? html` <span class="muted">${ssl.step} of 4 steps done · elapsed ${ssl.elapsedSeconds}s · ETA ~${Math.round(ssl.etaSeconds / 60)} min</span>` : ""}</dd>
      <dt>Issuer</dt><dd data-issuer>${ssl.issuer ?? "—"}</dd>
      <dt>Valid until</dt><dd>${ssl.validUntil ? shortDate(ssl.validUntil) : "—"}</dd>
      <dt>Auto-renew</dt><dd>${ssl.autoRenew ? "On" : "Off"}</dd>
    </dl>
    <ol class="plain-list" data-cert-steps>${CERT_STEPS.map((text, index) => {
      const state = stepState(ssl, index + 1);
      return html`<li data-step="${index + 1}" data-state="${state}">${STEP_GLYPH[state]} ${text}</li>`;
    })}</ol>
    ${replacementLine(ssl.replacement)}
    ${ssl.log.length > 0 ? html`<ul class="plain-list mono" data-log>${ssl.log.map((line) => html`<li>${line.glyph} ${line.text} <span class="muted">${timeAgo(line.at)}</span></li>`)}</ul>` : html`<p class="muted">No certificate yet: it starts once your name servers point at us.</p>`}
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
    // A row from before the handover lane sends no handover: the retired records lane.
    const handover = domain.dns.mode === "delegated" ? domain.handover : null;
    const zoneHref = `#/w/${id}/domains/${domainId}/zone`;
    // Amazon's certificate is asked again, unless nothing was asked yet or it is still being issued.
    const recheck =
      manage && !archived && handover && !["awaiting_dns", "provisioning", "issuing"].includes(domain.ssl.status) && !["requested", "attached"].includes(ssl?.replacement?.status);
    mount(
      content,
      html`
        <div class="page-head">
          <div><h1>${domain.host} ${healthChip(domain)}</h1>
            <p><a href="#/w/${id}/domains">Domains</a> / pages serve on <b>${domain.servingHost}</b> · ${project ? project.name : "unassigned"}${domain.primary ? " · primary" : ""} · ${dnsChip(domain)} ${sslChip(domain)}</p></div>
          <div class="actions">
            ${manage && !archived && handover ? html`<button class="btn" data-check>${icon("refresh-cw")} Check now</button>` : ""}
            ${manage ? html`<button class="btn btn-ghost btn-icon" data-more data-popover-anchor aria-label="More actions">${icon("ellipsis")}</button>` : ""}
          </div>
        </div>
        <div class="section-stack">
          ${banners(domain, handover).map((line) => html`<div class="form-note ${BANNER_STYLE[line.kind]}" data-banner>${line.text}</div>`)}
          ${handover ? nameServersCard(domain, handover, `#/w/${id}/domains/${domainId}/import`, zoneHref, archived) : ""}
          ${handover && !archived ? preflightCard(handover.preflight, manage) : ""}
          ${handover && !archived ? apexCard(domain, manage, archived, zoneHref) : ""}
          ${handover && !archived
            ? html`<div class="card" data-certificate>
                <div class="card-head"><h2>Certificate</h2>${recheck ? html`<button class="btn btn-sm" data-recheck>${icon("shield-check")} Check again</button>` : ""}</div>
                ${ssl ? certificateCard(ssl) : html`<div class="card-body muted">Couldn't load the certificate.</div>`}
              </div>`
            : ""}
          <div class="card">
            <div class="card-head"><h2>Usage</h2></div>
            <div class="card-body"><dl class="kv">
              <dt>Type</dt><dd>${domain.type}${handover && domain.apex ? ` · ${domain.host} ${domain.apex.mode === "redirect" ? `redirects to ${domain.servingHost}` : "keeps its own records"}` : ""}</dd>
              ${handover ? html`<dt>Checks</dt><dd>${plural(domain.dns.checks, "check")} · last ${domain.dns.lastCheckedAt ? timeAgo(domain.dns.lastCheckedAt) : "never"}</dd>` : ""}
              <dt>Pages · quizzes</dt><dd>${domain.pages} · ${domain.quizzes}</dd>
              <dt>Sessions 30d</dt><dd>${sessionsText(domain.sessions30d)}${domain.sessions30d === null ? html` <span class="hint">only campaign pages have traffic</span>` : ""}</dd>
              <dt>Active campaigns</dt><dd>${domain.activeCampaigns}</dd>
              <dt>Added</dt><dd>${timeAgo(domain.addedAt)}</dd>
              <dt>First live</dt><dd>${domain.activatedAt ? timeAgo(domain.activatedAt) : "not yet"}</dd>
            </dl></div>
          </div>
        </div>`,
    );
    wire(handover);
  }

  /** Done: read it all again. */
  const then = (action) => async () => {
    if (await action()) {
      await load();
    }
  };

  /** The root's mode, with the replace-a-site question asked when the API says it matters. */
  async function switchApex(mode) {
    let result = await patch(domainsPath(id, `/${domainId}/apex`), { mode });
    if (!result.ok && result.code === "ACKNOWLEDGEMENT_REQUIRED" && (result.details?.missing ?? []).includes("apex-replaced")) {
      const yes = await confirmDialog({
        title: `Redirect ${domain.host}?`,
        message: `${domain.host} answers a site of yours today. Redirecting replaces it: visitors of ${domain.host} land on ${domain.servingHost} instead.`,
        confirmLabel: "Redirect and replace",
        danger: true,
      });
      if (!yes) {
        return false;
      }
      result = await patch(domainsPath(id, `/${domainId}/apex`), { mode, acknowledged: true });
    }
    if (!result.ok) {
      toast(result.error, "error");
      return false;
    }
    toast(mode === "redirect" ? `${domain.host} now redirects to ${domain.servingHost}` : `${domain.host} keeps its own records`);
    return true;
  }

  function wire(handover) {
    content.querySelector("[data-check]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => checkNow(id, domain))));
    content.querySelector("[data-recheck]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => recheckCertificate(id, domain))));
    content.querySelector("[data-export]")?.addEventListener("click", (event) => busy(event.currentTarget, () => downloadZoneFile(id, domain)));
    content.querySelectorAll("[data-apex-switch]").forEach((button) => button.addEventListener("click", (event) => busy(event.currentTarget, then(() => switchApex(button.dataset.apexSwitch)))));
    content.querySelectorAll("[data-copy-ns]").forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copyNs)));
    content.querySelector("[data-copy-all-ns]")?.addEventListener("click", () => copyText([...content.querySelectorAll("[data-copy-ns]")].map((button) => button.dataset.copyNs).join("\n")));
    content.querySelectorAll("[data-copy-before]").forEach((button) => button.addEventListener("click", () => copyText(handover.cutover.instructions.beforeSwitch[Number(button.dataset.copyBefore)].value)));
    content.querySelector("[data-preflight-rerun]")?.addEventListener("click", (event) => busy(event.currentTarget, then(() => rerunPreflight(id, domain))));
    content.querySelector("[data-more]")?.addEventListener("click", (event) => popover(event.currentTarget, menu()));
  }

  function menu() {
    const handover = domain.dns.mode === "delegated";
    if (domain.lifecycle === "archived") {
      return [
        ...(handover ? [{ label: "Restore", icon: "archive-restore", onClick: then(() => restoreDomain(id, domain)) }, "sep"] : []),
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
    const typing = content.contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
    if (inFlight(domain) && !typing && !document.querySelector(".modal-backdrop, .popover")) {
      await load();
    }
  }, POLL_MS);
}
