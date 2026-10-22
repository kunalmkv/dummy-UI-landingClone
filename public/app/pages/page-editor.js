// The page editor: GrapesJS full screen. The draft autosaves over the revision
// it loaded; publish sends the HTML and CSS the editor renders. Versions,
// preview and image uploads (to S3, through the pages routes) sit in the bar.

import { get, post, put } from "../lib/api.js";
import { BLOCKS, loadGrapes, uploadPageImage } from "../lib/grapes.js";
import { navigation } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, debounce, emptyState, formValues, html, icon, mount, openModal, setFormError, timeAgo, toast } from "../lib/ui.js";
import { openPreview, pagesPath, statusChip } from "./pages.js";
import { enterWorkspace } from "./shell.js";

export async function renderPageEditor({ params }) {
  const { id, projectId, pageId } = params;
  const here = navigation();
  const listPath = `#/w/${id}/projects/${projectId}/pages`;
  const pageUrl = (rest = "") => pagesPath(id, projectId, `/${encodeURIComponent(pageId)}${rest}`);
  const app = document.getElementById("app");
  mount(
    app,
    html`<div class="editor-shell">
      <header class="editor-bar">
        <a class="btn btn-ghost btn-sm" href="${listPath}">${icon("arrow-left")} Pages</a>
        <div class="editor-title"><strong data-name>Loading…</strong> <span data-status></span></div>
        <span class="muted editor-save" data-save-state></span>
        <div class="editor-actions">
          <a class="btn btn-ghost btn-sm hidden" data-live target="_blank" rel="noopener">${icon("external-link")} Live page</a>
          <button class="btn btn-sm" data-preview>${icon("eye")} Preview</button>
          <button class="btn btn-sm" data-versions>${icon("history")} Versions</button>
          <a class="btn btn-sm" href="#/w/${id}/projects/${projectId}/pages/${pageId}/settings/seo">${icon("settings")} Settings</a>
          <button class="btn btn-primary btn-sm hidden" data-publish>${icon("rocket")} Publish</button>
        </div>
      </header>
      <div data-banner></div>
      <div class="editor-canvas" data-canvas><div class="boot">Loading the editor…</div></div>
    </div>`,
  );
  // The frame is up already; the workspace (for what the caller may do) loads with the page.
  const [workspace, pageResult, draftResult, grapesjs] = await Promise.all([enterWorkspace(id), get(pageUrl()), get(pageUrl("/draft")), loadGrapes().catch(() => null)]);
  if (!workspace || navigation() !== here) {
    return;
  }
  const canvas = app.querySelector("[data-canvas]");
  if (!pageResult.ok || !draftResult.ok || !grapesjs) {
    mount(canvas, emptyState({ iconName: "triangle-alert", title: "Couldn't open this page", text: pageResult.error ?? draftResult.error ?? "The editor didn't load." }));
    return;
  }

  let page = pageResult.data;
  let revision = draftResult.data.draftRevision;
  const readOnly = page.status === "archived" || !can("page.update");
  const saveState = app.querySelector("[data-save-state]");
  const banner = app.querySelector("[data-banner]");

  function drawHeader() {
    app.querySelector("[data-name]").textContent = page.name;
    mount(app.querySelector("[data-status]"), statusChip(page));
    const live = app.querySelector("[data-live]");
    live.classList.toggle("hidden", !page.url);
    if (page.url) {
      live.href = page.url;
    }
    app.querySelector("[data-publish]").classList.toggle("hidden", readOnly || !can("page.publish"));
  }
  drawHeader();
  if (page.status === "archived") {
    mount(banner, html`<div class="banner">${icon("archive")}<span>This page is archived, so the editor is read-only. Restore it from the pages list to edit.</span></div>`);
  }
  saveState.textContent = readOnly ? "Read-only" : `Saved ${timeAgo(draftResult.data.savedAt)}`;

  canvas.innerHTML = "";
  const editor = grapesjs.init({
    container: canvas,
    height: "100%",
    width: "auto",
    storageManager: false,
    projectData: draftResult.data.design,
    blockManager: { blocks: BLOCKS },
    assetManager: { upload: "pages", uploadFile: uploadFiles },
  });

  async function uploadFiles(event) {
    const files = [...(event.dataTransfer?.files ?? event.target?.files ?? [])];
    for (const file of files) {
      const uploaded = await uploadPageImage(id, projectId, file);
      if (!uploaded.ok) {
        toast(uploaded.error, "error");
        continue;
      }
      editor.AssetManager.add({ src: uploaded.data.url, width: uploaded.data.width, height: uploaded.data.height });
    }
  }

  // ── autosave ──────────────────────────────────────────────────────────
  let dirty = false;
  let saving = null;
  let conflict = false;
  let applying = false;

  async function saveOnce() {
    saveState.textContent = "Saving…";
    const result = await put(pageUrl("/draft"), { expectedRevision: revision, design: editor.getProjectData() });
    if (result.ok) {
      revision = result.data.draftRevision;
      page = { ...page, hasUnpublishedChanges: true };
      drawHeader();
      saveState.textContent = "All changes saved";
      return true;
    }
    if (result.code === "VERSION_CONFLICT") {
      showConflict(result.details.current);
    }
    saveState.textContent = `Not saved — ${result.error}`;
    return false;
  }

  /** Save what changed, and wait for any save in flight. False when it couldn't. */
  async function flush() {
    while (saving) {
      await saving;
    }
    if (conflict) {
      return false;
    }
    if (!dirty || readOnly) {
      return true;
    }
    dirty = false;
    saving = saveOnce();
    const saved = await saving;
    saving = null;
    if (!saved) {
      dirty = true;
      return false;
    }
    return flush();
  }

  const saveSoon = debounce(() => flush(), 1200);
  editor.on("load", () =>
    editor.on("update", () => {
      if (applying || readOnly) {
        return;
      }
      dirty = true;
      saveState.textContent = "Unsaved changes";
      saveSoon();
    }),
  );

  function showConflict(current) {
    conflict = true;
    const who = current?.updatedBy?.name ? ` by ${current.updatedBy.name}` : "";
    mount(
      banner,
      html`<div class="banner">${icon("triangle-alert")}<span>This page was saved somewhere else${who} ${timeAgo(current?.updatedAt)}. Reload to get that version — edits made here since your last save will be lost.</span><button class="btn btn-sm" data-reload>Reload</button></div>`,
    );
    banner.querySelector("[data-reload]").addEventListener("click", (event) => busy(event.currentTarget, () => reloadDraft()));
  }

  async function reloadDraft() {
    const draft = await get(pageUrl("/draft"));
    if (!draft.ok) {
      toast(draft.error, "error");
      return;
    }
    applying = true;
    editor.loadProjectData(draft.data.design);
    setTimeout(() => {
      applying = false;
    }, 0);
    revision = draft.data.draftRevision;
    conflict = false;
    dirty = false;
    mount(banner, "");
    saveState.textContent = `Saved ${timeAgo(draft.data.savedAt)}`;
    const fresh = await get(pageUrl());
    if (fresh.ok) {
      page = fresh.data;
      drawHeader();
    }
  }

  // ── publish ───────────────────────────────────────────────────────────
  function openPublish() {
    openModal({
      title: page.publishedVersion ? `Publish v${page.publishedVersion + 1}` : "Publish this page",
      subtitle: page.publishedVersion ? "Replaces the live version at once. Earlier versions stay in Versions." : "It goes live at its path straight away.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Note <span class="muted">(optional)</span></span><input type="text" name="note" maxlength="200" placeholder="What changed" /></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Publish</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          modal.querySelector("[data-submit]").click();
        });
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            setFormError(form, null);
            if (!(await flush())) {
              setFormError(form, "The latest changes aren't saved yet, so they can't be published.");
              return;
            }
            const note = formValues(form).note.trim();
            const result = await post(pageUrl("/publish"), { expectedRevision: revision, html: editor.getHtml(), css: editor.getCss(), ...(note ? { note: note } : {}) });
            if (!result.ok) {
              if (result.code === "VERSION_CONFLICT") {
                close();
                showConflict(result.details.current);
                return;
              }
              setFormError(form, result.error);
              return;
            }
            close();
            page = result.data.page;
            drawHeader();
            toast(`Published ${result.data.version.label}`);
          }),
        );
      },
    });
  }

  // ── versions ──────────────────────────────────────────────────────────
  async function openVersions() {
    const result = await get(pageUrl("/versions"));
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    openModal({
      title: "Versions",
      subtitle: "Every publish is kept. Restoring copies a version into the draft; nothing goes live until you publish.",
      body: html`<div class="modal-body">${
        result.data.length === 0
          ? emptyState({ iconName: "history", title: "Not published yet", text: "Each publish adds a version here." })
          : html`<div class="table-wrap"><table class="table"><tbody>${result.data.map(
              (version) => html`<tr>
                <td><strong>${version.label}</strong> ${version.current ? html`<span class="chip chip-success">Live</span>` : ""}<div class="muted" style="font-size:12px">${version.note ?? "No note"}</div></td>
                <td class="muted">${timeAgo(version.publishedAt)}${version.publishedBy ? ` · ${version.publishedBy.name}` : ""}</td>
                <td class="actions">${readOnly ? "" : html`<button class="btn btn-sm" data-restore="${version.version}">Restore into draft</button>`}</td>
              </tr>`,
            )}</tbody></table></div>`
      }</div>`,
      onMount: (modal, close) => {
        modal.querySelectorAll("[data-restore]").forEach((button) =>
          button.addEventListener("click", async () => {
            const yes = await confirmDialog({
              title: `Restore v${button.dataset.restore} into the draft?`,
              message: "The draft is replaced by that version. Unpublished edits are lost; the live page doesn't change until you publish.",
              confirmLabel: "Restore",
            });
            if (!yes) {
              return;
            }
            await flush();
            const restored = await post(pageUrl(`/versions/${button.dataset.restore}/restore`), {});
            if (!restored.ok) {
              toast(restored.error, "error");
              return;
            }
            close();
            await reloadDraft();
            toast(`v${button.dataset.restore} is in the draft`);
          }),
        );
      },
    });
  }

  app.querySelector("[data-publish]").addEventListener("click", () => openPublish());
  app.querySelector("[data-versions]").addEventListener("click", () => openVersions());
  app.querySelector("[data-preview]").addEventListener("click", async () => {
    await flush();
    openPreview(id, projectId, pageId);
  });

  // Leaving: save what is left, then let the editor go.
  window.onbeforeunload = () => (dirty ? true : undefined);
  const leave = () => {
    if (location.hash.includes(`/pages/${pageId}/edit`)) {
      return;
    }
    window.removeEventListener("hashchange", leave);
    window.onbeforeunload = null;
    flush().finally(() => editor.destroy());
  };
  window.addEventListener("hashchange", leave);
}
