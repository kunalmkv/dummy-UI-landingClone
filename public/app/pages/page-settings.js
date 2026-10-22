// Page settings: SEO (with a share image uploaded to S3), tracking, advanced
// code, and the danger zone. Each save names the version it read (If-Match).

import { del, get, patch, post } from "../lib/api.js";
import { uploadPageImage } from "../lib/grapes.js";
import { go } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, emptyState, formValues, html, icon, mount, setFormError, toast } from "../lib/ui.js";
import { pagesPath, statusChip } from "./pages.js";
import { shell } from "./shell.js";

const SECTIONS = [
  { key: "seo", label: "SEO", icon: "search" },
  { key: "tracking", label: "Tracking", icon: "activity" },
  { key: "advanced", label: "Advanced", icon: "code" },
  { key: "danger", label: "Danger zone", icon: "triangle-alert", danger: true },
];
const ROBOTS = [
  { key: "index_follow", label: "Index, follow links" },
  { key: "noindex_follow", label: "Don't index, follow links" },
  { key: "index_nofollow", label: "Index, don't follow links" },
  { key: "noindex_nofollow", label: "Don't index or follow links" },
];
const TRACKERS = [
  { key: "metaPixel", label: "Meta Pixel" },
  { key: "ga4", label: "Google Analytics 4" },
  { key: "gtm", label: "Google Tag Manager" },
  { key: "tiktok", label: "TikTok Pixel" },
];

export async function renderPageSettings({ params }) {
  const { id, projectId, pageId } = params;
  const section = SECTIONS.find((one) => one.key === params.section) ?? SECTIONS[0];
  const pageUrl = (rest = "") => pagesPath(id, projectId, `/${encodeURIComponent(pageId)}${rest}`);
  // The shell and the page load together, so the screen changes at once.
  const [content, pageResult, settingsResult] = await Promise.all([
    shell({ workspaceId: id, active: "projects", crumb: section.label }),
    get(pageUrl()),
    get(pageUrl("/settings")),
  ]);
  if (!content) {
    return;
  }
  const crumb = document.querySelector(".crumbs .current");
  if (crumb && pageResult.ok) {
    crumb.textContent = `${pageResult.data.name} / ${section.label}`;
  }
  if (!pageResult.ok || !settingsResult.ok) {
    mount(content, emptyState({ iconName: "triangle-alert", title: "Couldn't load this page", text: pageResult.error ?? settingsResult.error }));
    return;
  }
  const page = pageResult.data;
  let settings = settingsResult.data;
  const editable = can("page.update") && page.status !== "archived";
  const base = `#/w/${id}/projects/${projectId}/pages/${pageId}`;

  mount(
    content,
    html`<div class="page-head">
        <div><h1>${page.name}</h1><p><a href="#/w/${id}/projects/${projectId}/pages">Pages</a> / ${page.path} ${statusChip(page)}</p></div>
        <div class="actions"><a class="btn" href="${base}/edit">${icon("pencil")} Open editor</a></div>
      </div>
      <div class="settings">
        <nav class="subnav">${SECTIONS.map((one) => html`<a href="${base}/settings/${one.key}" class="${one.key === section.key ? "active" : ""} ${one.danger ? "danger" : ""}">${icon(one.icon)}<span>${one.label}</span></a>`)}</nav>
        <div class="section-stack" id="section"></div>
      </div>`,
  );
  const target = content.querySelector("#section");
  const disabled = editable ? "" : "disabled";
  const note = editable ? "" : html`<div class="form-note">${icon("lock")} ${page.status === "archived" ? "This page is archived, so its settings are read-only." : "Your role can view these settings but not change them."}</div>`;

  /** Save one section over the version this screen read. */
  async function save(form, sectionKey, value) {
    setFormError(form, null);
    const result = await patch(pageUrl("/settings"), { [sectionKey]: value }, { "if-match": String(settings.version) });
    if (!result.ok) {
      if (result.code === "VERSION_CONFLICT") {
        settings = result.details.current ?? settings;
      }
      setFormError(form, result.error);
      return false;
    }
    settings = result.data;
    toast("Settings saved — live on the published page now");
    return true;
  }

  function card(title, text, body) {
    return html`<div class="card"><div class="card-head"><div><h2>${title}</h2><p>${text}</p></div></div>${body}</div>`;
  }

  if (section.key === "seo") {
    const seo = settings.seo;
    mount(
      target,
      card(
        "Search and sharing",
        "What search engines and link previews show for this page.",
        html`<form class="card-body form" novalidate>
          ${note}
          <label class="field"><span>Title</span><input type="text" name="title" maxlength="60" value="${seo.title ?? ""}" ${disabled} /><span class="hint">Up to 60 characters.</span></label>
          <label class="field"><span>Meta description</span><textarea name="metaDescription" maxlength="160" rows="3" ${disabled}>${seo.metaDescription ?? ""}</textarea><span class="hint">Up to 160 characters.</span></label>
          <label class="field"><span>Canonical URL</span><input type="url" name="canonicalUrl" value="${seo.canonicalUrl ?? ""}" placeholder="https://" ${disabled} /></label>
          <label class="field"><span>Search engines</span><select name="robots" ${disabled}>${ROBOTS.map((one) => html`<option value="${one.key}"${one.key === seo.robots ? " selected" : ""}>${one.label}</option>`)}</select></label>
          <div class="field"><span>Share image</span>
            <div data-image>${seo.ogImageUrl ? html`<img src="${seo.ogImageUrl}" alt="Share image" style="max-width:240px;border-radius:8px" />` : html`<span class="muted">None — link previews use the page itself.</span>`}</div>
            ${editable ? html`<div style="display:flex;gap:8px;margin-top:8px"><input type="file" accept="image/png,image/jpeg,image/webp" data-file /><button type="button" class="btn btn-sm" data-clear>Remove</button></div><span class="hint">PNG, JPEG or WebP, up to 5 MB. 1200 × 630 works best.</span>` : ""}
          </div>
        </form>
        ${editable ? html`<div class="card-foot"><button class="btn btn-primary" data-save>Save SEO</button></div>` : ""}`,
      ),
    );
    if (!editable) {
      return;
    }
    const form = target.querySelector("form");
    let ogImageAssetId = seo.ogImageAssetId;
    target.querySelector("[data-file]").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) {
        return;
      }
      const uploaded = await uploadPageImage(id, projectId, file);
      if (!uploaded.ok) {
        toast(uploaded.error, "error");
        event.target.value = "";
        return;
      }
      ogImageAssetId = uploaded.data.assetId;
      mount(target.querySelector("[data-image]"), html`<img src="${uploaded.data.url}" alt="Share image" style="max-width:240px;border-radius:8px" />`);
    });
    target.querySelector("[data-clear]").addEventListener("click", () => {
      ogImageAssetId = null;
      mount(target.querySelector("[data-image]"), html`<span class="muted">None — save to take it off.</span>`);
    });
    target.querySelector("[data-save]").addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const values = formValues(form);
        const blankAsNull = (value) => (value.trim() ? value.trim() : null);
        await save(form, "seo", {
          title: blankAsNull(values.title),
          metaDescription: blankAsNull(values.metaDescription),
          canonicalUrl: blankAsNull(values.canonicalUrl),
          robots: values.robots,
          ogImageAssetId: ogImageAssetId,
        });
      }),
    );
    return;
  }

  if (section.key === "tracking") {
    mount(
      target,
      card(
        "Tracking pixels",
        "Each one follows the project's setting, uses its own ID here, or is off for this page.",
        html`<form class="card-body form" novalidate>
          ${note}
          ${TRACKERS.map((tracker) => {
            const current = settings.tracking[tracker.key];
            return html`<div class="row-2">
              <label class="field"><span>${tracker.label}</span><select name="${tracker.key}.mode" ${disabled}>
                ${["inherit", "override", "off"].map((mode) => html`<option value="${mode}"${mode === current.mode ? " selected" : ""}>${{ inherit: "Use the project's", override: "Use this ID", off: "Off" }[mode]}</option>`)}
              </select></label>
              <label class="field"><span>ID</span><input type="text" name="${tracker.key}.id" value="${current.id ?? ""}" ${disabled} /></label>
            </div>`;
          })}
        </form>
        ${editable ? html`<div class="card-foot"><button class="btn btn-primary" data-save>Save tracking</button></div>` : ""}`,
      ),
    );
    target.querySelector("[data-save]")?.addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const form = target.querySelector("form");
        const values = formValues(form);
        await save(
          form,
          "tracking",
          Object.fromEntries(TRACKERS.map((tracker) => [tracker.key, { mode: values[`${tracker.key}.mode`], id: values[`${tracker.key}.id`].trim() || null }])),
        );
      }),
    );
    return;
  }

  if (section.key === "advanced") {
    const advanced = settings.advanced;
    mount(
      target,
      card(
        "Custom code",
        "Added to the published page as it is. Up to 20 KB each.",
        html`<form class="card-body form" novalidate>
          ${note}
          <label class="field"><span>Head code</span><textarea name="headCode" rows="6" spellcheck="false" style="font-family:monospace" ${disabled}>${advanced.headCode}</textarea></label>
          <label class="field"><span>Body code</span><textarea name="bodyCode" rows="6" spellcheck="false" style="font-family:monospace" ${disabled}>${advanced.bodyCode}</textarea></label>
          <label class="check"><input type="checkbox" name="dynamicTokens" ${advanced.dynamicTokens ? "checked" : ""} ${disabled} /> Replace {{tokens}} with visitor values</label>
        </form>
        ${editable ? html`<div class="card-foot"><button class="btn btn-primary" data-save>Save code</button></div>` : ""}`,
      ),
    );
    target.querySelector("[data-save]")?.addEventListener("click", (event) =>
      busy(event.currentTarget, async () => {
        const form = target.querySelector("form");
        await save(form, "advanced", { headCode: form.elements.headCode.value, bodyCode: form.elements.bodyCode.value, dynamicTokens: form.elements.dynamicTokens.checked });
      }),
    );
    return;
  }

  // ── danger ────────────────────────────────────────────────────────────
  const actions = [];
  if (can("page.publish") && page.status === "published") {
    actions.push({ key: "unpublish", title: "Unpublish", text: "Take the page off its URL. The draft and every version are kept.", label: "Unpublish" });
  }
  if (can("page.update") && page.publishedVersion && page.hasUnpublishedChanges && page.status !== "archived") {
    actions.push({ key: "reset", title: "Reset draft to the live version", text: `Throw away unpublished edits and start again from v${page.publishedVersion}.`, label: "Reset draft" });
  }
  if (can("page.publish")) {
    actions.push(
      page.status === "archived"
        ? { key: "restore", title: "Restore", text: "Bring the page back. It doesn't go live until you publish it.", label: "Restore page" }
        : { key: "archive", title: "Archive", text: "Take it off its URL and make it read-only, out of the default list.", label: "Archive page" },
    );
  }
  if (can("page.delete")) {
    actions.push({ key: "delete", title: "Delete", text: "Stops serving at once; purged after 30 days unless undeleted.", label: "Delete page", danger: true });
  }
  mount(
    target,
    actions.length === 0
      ? emptyState({ iconName: "lock", title: "Nothing you can change here", text: "Your role can't unpublish, archive or delete pages." })
      : card(
          "Danger zone",
          "These change what visitors see.",
          html`<div class="card-body" style="display:grid;gap:16px">${actions.map(
            (action) => html`<div style="display:flex;gap:16px;align-items:center;justify-content:space-between">
              <div><strong>${action.title}</strong><div class="muted">${action.text}</div></div>
              <button class="btn ${action.danger ? "btn-danger" : ""}" data-action="${action.key}">${action.label}</button>
            </div>`,
          )}</div>`,
        ),
  );
  const run = {
    unpublish: () => post(pageUrl("/unpublish"), {}),
    reset: () => post(pageUrl(`/versions/${page.publishedVersion}/restore`), {}),
    archive: () => post(pageUrl("/archive"), {}),
    restore: () => post(pageUrl("/restore"), {}),
    delete: () => del(pageUrl()),
  };
  target.querySelectorAll("[data-action]").forEach((button) =>
    button.addEventListener("click", async () => {
      const action = actions.find((one) => one.key === button.dataset.action);
      const yes = await confirmDialog({ title: `${action.title}?`, message: action.text, confirmLabel: action.label, danger: true });
      if (!yes) {
        return;
      }
      const result = await run[action.key]();
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(`${action.title} done`);
      go(action.key === "delete" ? `/w/${id}/projects/${projectId}/pages` : `/w/${id}/projects/${projectId}/pages/${pageId}/settings/danger`);
    }),
  );
}
