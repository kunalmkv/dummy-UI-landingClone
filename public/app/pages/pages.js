// A project's pages: status tabs with counts, search and type filter; new page
// from blank or a template; duplicate, move, archive, unpublish, delete, undelete.

import { del, get, post, query, ws } from "../lib/api.js";
import { go } from "../lib/router.js";
import { can } from "../lib/state.js";
import { busy, confirmDialog, copyText, debounce, emptyState, formValues, html, icon, mount, openModal, popover, setFormError, skeletonRows, timeAgo, toast } from "../lib/ui.js";
import { shell } from "./shell.js";

export const PAGE_TYPES = [
  { key: "lander", label: "Lander" },
  { key: "quiz_step", label: "Quiz step" },
  { key: "offer", label: "Offer" },
  { key: "thank_you", label: "Thank you" },
];
const TABS = [
  { key: "all", label: "All" },
  { key: "published", label: "Published" },
  { key: "draft", label: "Draft" },
  { key: "unpublished", label: "Unpublished" },
  { key: "archived", label: "Archived" },
  { key: "deleted", label: "Deleted" },
];
const STATUS_CHIP = { published: "chip-success", draft: "", unpublished: "chip-info", archived: "chip-warning", deleted: "chip-danger" };

/** /workspaces/:id/projects/:projectId/pages, and what follows it. */
export const pagesPath = (workspaceId, projectId, rest = "") => ws(workspaceId, `/projects/${encodeURIComponent(projectId)}/pages${rest}`);

export const typeLabel = (type) => PAGE_TYPES.find((one) => one.key === type)?.label ?? type;

export function statusChip(page) {
  return html`<span class="chip ${STATUS_CHIP[page.status] ?? ""}">${page.status.charAt(0).toUpperCase() + page.status.slice(1)}</span>${page.status === "published" && page.hasUnpublishedChanges ? html` <span class="chip chip-warning">Pending changes</span>` : ""}`;
}

/** Open a fresh preview link for the draft in a new tab. */
export async function openPreview(workspaceId, projectId, pageId) {
  // Opened first, inside the click, so the browser doesn't block it.
  const tab = window.open("", "_blank");
  const result = await post(pagesPath(workspaceId, projectId, `/${encodeURIComponent(pageId)}/preview-link`), {});
  if (!result.ok) {
    tab?.close();
    toast(result.error, "error");
    return;
  }
  // The API's link points at the web app; this harness serves the same screen.
  const token = result.data.url.split("#")[1];
  if (tab) {
    tab.location = `/preview#${token}`;
  }
}

export async function renderPages({ params }) {
  const id = params.id;
  const projectId = params.projectId;
  // Asked for alongside the shell and the list, so the screen changes at once.
  const projectRequest = get(ws(id, `/projects/${encodeURIComponent(projectId)}`));
  const content = await shell({ workspaceId: id, active: "projects", crumb: "Pages" });
  if (!content) {
    return;
  }
  const view = { status: "all", q: "", type: "", items: [], counts: {}, nextCursor: null };

  mount(
    content,
    html`
      <div class="page-head">
        <div><h1>Pages</h1><p><a href="#/w/${id}/projects">Projects</a> / <span data-project-name>…</span> — the landing pages this project serves.</p></div>
        <div class="actions">${can("page.create") ? html`<button class="btn btn-primary" data-new>${icon("plus")} New page</button>` : ""}</div>
      </div>
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap;gap:12px">
          <div class="tabs" data-tabs>${TABS.map((tab) => html`<button data-value="${tab.key}" class="${tab.key === "all" ? "active" : ""}">${tab.label} <span class="muted" data-count="${tab.key}"></span></button>`)}</div>
          <div class="toolbar" style="flex:1;justify-content:flex-end">
            <div class="search">${icon("search")}<input type="search" placeholder="Search name or path" data-q /></div>
            <select data-type><option value="">All types</option>${PAGE_TYPES.map((type) => html`<option value="${type.key}">${type.label}</option>`)}</select>
          </div>
        </div>
        <div data-list>${skeletonRows()}</div>
      </div>`,
  );

  const list = content.querySelector("[data-list]");
  const pageUrl = (page, rest = "") => pagesPath(id, projectId, `/${encodeURIComponent(page.pageId)}${rest}`);

  async function load(append = false) {
    if (!append) {
      mount(list, skeletonRows());
    }
    const result = await get(pagesPath(id, projectId, query({ status: view.status, q: view.q, type: view.type, limit: 20, cursor: append ? view.nextCursor : "" })));
    if (!result.ok) {
      mount(list, emptyState({ iconName: "triangle-alert", title: "Couldn't load pages", text: result.error }));
      return;
    }
    view.items = append ? [...view.items, ...result.data.items] : result.data.items;
    view.counts = result.data.counts;
    view.nextCursor = result.data.nextCursor;
    content.querySelectorAll("[data-count]").forEach((badge) => {
      badge.textContent = view.counts[badge.dataset.count] ?? "";
    });
    draw();
  }

  function draw() {
    if (view.items.length === 0) {
      const filtered = view.q || view.type;
      mount(
        list,
        emptyState({
          iconName: view.status === "deleted" ? "trash-2" : "file-text",
          title: filtered ? "No pages match" : view.status === "deleted" ? "Nothing deleted" : "No pages here yet",
          text: filtered ? "Try another name, path or type." : view.status === "deleted" ? "Deleted pages stay here for 30 days." : "Create a page to start building.",
        }),
      );
      return;
    }
    mount(
      list,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Page</th><th>Type</th><th>Status</th><th>Updated</th><th class="actions"></th></tr></thead>
        <tbody>${view.items.map(
          (page) => html`<tr>
            <td><div class="name">${page.status === "deleted" ? page.name : html`<a href="#/w/${id}/projects/${projectId}/pages/${page.pageId}/edit">${page.name}</a>`}</div>
              <div class="email">${page.url ? html`<a href="${page.url}" target="_blank" rel="noopener">${page.path}</a>` : page.path}</div></td>
            <td><span class="chip">${typeLabel(page.type)}</span></td>
            <td>${statusChip(page)}${page.status === "deleted" ? html`<div class="muted" style="font-size:12px">purged ${timeAgo(page.purgeAt)}</div>` : ""}</td>
            <td class="muted">${timeAgo(page.updatedAt)}${page.updatedBy ? ` · ${page.updatedBy.name}` : ""}</td>
            <td class="actions"><button class="btn btn-ghost btn-icon btn-sm" data-menu="${page.pageId}" data-popover-anchor aria-label="Page actions">${icon("ellipsis")}</button></td>
          </tr>`,
        )}</tbody>
      </table></div>
      ${view.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}`,
    );
    list.querySelector("[data-more]")?.addEventListener("click", (event) => busy(event.currentTarget, () => load(true)));
    list.querySelectorAll("[data-menu]").forEach((button) =>
      button.addEventListener("click", () => popover(button, menuFor(view.items.find((one) => one.pageId === button.dataset.menu)))),
    );
  }

  function menuFor(page) {
    const editPath = `/w/${id}/projects/${projectId}/pages/${page.pageId}`;
    if (page.status === "deleted") {
      return can("page.delete") ? [{ label: "Undelete", icon: "undo-2", onClick: () => act(page, "/undelete", `${page.name} is back`) }] : [{ title: "Deleted — an admin can undelete it" }];
    }
    const items = [
      { label: page.status === "archived" ? "View" : "Edit", icon: "pencil", onClick: () => go(`${editPath}/edit`) },
      { label: "Settings", icon: "settings", onClick: () => go(`${editPath}/settings/seo`) },
      { label: "Preview draft", icon: "eye", onClick: () => openPreview(id, projectId, page.pageId) },
    ];
    if (page.url) {
      items.push({ label: "Copy live URL", icon: "link", onClick: () => copyText(page.url) });
    }
    if (can("page.create")) {
      items.push("sep", { label: "Duplicate", icon: "copy", onClick: () => duplicate(page) });
    }
    if (can("page.update") && page.status !== "archived") {
      items.push({ label: "Move to project…", icon: "folder-input", onClick: () => openMove(page) });
    }
    if (can("page.publish")) {
      if (page.status === "published") {
        items.push({ label: "Unpublish", icon: "eye-off", onClick: () => act(page, "/unpublish", `${page.name} is off its URL`) });
      }
      items.push(
        page.status === "archived"
          ? { label: "Restore", icon: "archive-restore", onClick: () => act(page, "/restore", `${page.name} restored`) }
          : { label: "Archive", icon: "archive", onClick: () => act(page, "/archive", `${page.name} archived`) },
      );
    }
    if (can("page.delete")) {
      items.push("sep", { label: "Delete", icon: "trash-2", danger: true, onClick: () => remove(page) });
    }
    return items;
  }

  async function act(page, rest, done) {
    const result = await post(pageUrl(page, rest), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(done);
    load();
  }

  async function duplicate(page) {
    const result = await post(pageUrl(page, "/duplicate"), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`Copied as ${result.data.name}`);
    load();
  }

  async function remove(page) {
    const yes = await confirmDialog({
      title: `Delete ${page.name}?`,
      message: "It stops serving at once and is purged after 30 days. Until then an admin can undelete it from the Deleted tab.",
      confirmLabel: "Delete page",
      danger: true,
    });
    if (!yes) {
      return;
    }
    const result = await del(pageUrl(page));
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${page.name} deleted`);
    load();
  }

  async function openMove(page) {
    const projects = await get(ws(id, "/projects?limit=100"));
    const others = (projects.data?.items ?? []).filter((one) => one.projectId !== projectId);
    if (others.length === 0) {
      toast("There is no other project to move it to.", "error");
      return;
    }
    openModal({
      title: `Move ${page.name}`,
      subtitle: "Its versions move with it. A published page serves on the new project's address at once.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Project</span><select name="projectId">${others.map((one) => html`<option value="${one.projectId}">${one.name}</option>`)}</select></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Move page</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            const result = await post(pageUrl(page, "/move"), { projectId: formValues(form).projectId });
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            toast(`${page.name} moved`);
            load();
          }),
        );
      },
    });
  }

  async function openCreate() {
    const templates = await get(pagesPath(id, projectId, "/templates"));
    openModal({
      title: "New page",
      subtitle: "Start blank or from a template. The path can change until the first publish.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Page name</span><input type="text" name="name" required maxlength="120" placeholder="e.g. Medicare hero v3" /></label>
          <label class="field"><span>Type</span><select name="type">${PAGE_TYPES.map((type) => html`<option value="${type.key}">${type.label}</option>`)}</select></label>
          <label class="field"><span>Path <span class="muted">(optional — made from the name)</span></span><input type="text" name="path" placeholder="/medicare-hero" /></label>
          <label class="field"><span>Start from</span><select name="start">
            <option value="blank">Blank page</option>
            ${(templates.data ?? []).map((template) => html`<option value="${template.templateId}">Template: ${template.name}</option>`)}
          </select></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Create and edit</button></div>`,
      onMount: (modal, close) => {
        const form = modal.querySelector("form");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          modal.querySelector("[data-submit]").click();
        });
        modal.querySelector("[data-submit]").addEventListener("click", (event) =>
          busy(event.currentTarget, async () => {
            const values = formValues(form);
            setFormError(form, null);
            const body = { name: values.name.trim(), type: values.type, buildMethod: values.start === "blank" ? "blank" : "template" };
            if (values.start !== "blank") {
              body.templateId = values.start;
            }
            if (values.path.trim()) {
              body.path = values.path.trim();
            }
            const result = await post(pagesPath(id, projectId), body);
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            go(`/w/${id}/projects/${projectId}/pages/${result.data.pageId}/edit`);
          }),
        );
      },
    });
  }

  content.querySelector("[data-new]")?.addEventListener("click", () => openCreate());
  content.querySelectorAll("[data-tabs] button").forEach((button) =>
    button.addEventListener("click", () => {
      content.querySelectorAll("[data-tabs] button").forEach((one) => one.classList.toggle("active", one === button));
      view.status = button.dataset.value;
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
  content.querySelector("[data-type]").addEventListener("change", (event) => {
    view.type = event.target.value;
    load();
  });
  const [projectResult] = await Promise.all([projectRequest, load()]);
  if (!projectResult.ok) {
    mount(content, emptyState({ iconName: "triangle-alert", title: "Couldn't load this project", text: projectResult.error }));
    return;
  }
  const projectName = projectResult.data.name;
  content.querySelector("[data-project-name]").textContent = projectName;
  const crumb = document.querySelector(".crumbs .current");
  if (crumb) {
    crumb.textContent = `${projectName} / Pages`;
  }
}
