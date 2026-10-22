// Projects: the list with tabs, search and app filter; create, rename, archive.

import { get, patch, post, query, ws } from "../lib/api.js";
import { APP_KEYS, appInfo, appStateLabel } from "../lib/apps.js";
import { go } from "../lib/router.js";
import { can, state } from "../lib/state.js";
import {
  busy,
  confirmDialog,
  debounce,
  emptyState,
  formValues,
  html,
  icon,
  mount,
  openModal,
  popover,
  setFormError,
  skeletonRows,
  timeAgo,
  toast,
} from "../lib/ui.js";
import { refreshWorkspace, shell } from "./shell.js";

export async function renderProjects({ params, query: params_ }) {
  const content = await shell({ workspaceId: params.id, active: "projects", crumb: "Projects" });
  if (!content) {
    return;
  }
  const id = params.id;
  const view = { status: "ACTIVE", q: "", appId: params_.app ?? "", items: [], nextCursor: null };
  const appsResult = await get(ws(id, "/apps"));
  const apps = appsResult.ok ? appsResult.data : APP_KEYS.map((key) => ({ key: key, state: "ACTIVE" }));

  mount(
    content,
    html`
      <div class="page-head">
        <div><h1>Projects</h1><p>Each project lives in one app and holds its pages, campaigns and leads.</p></div>
        <div class="actions">${can("project.create") ? html`<button class="btn btn-primary" data-new>${icon("plus")} New project</button>` : ""}</div>
      </div>
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="segmented" data-status>
            <button class="active" data-value="ACTIVE">Active</button>
            <button data-value="ARCHIVED">Archived</button>
          </div>
          <div class="toolbar" style="flex:1;justify-content:flex-end">
            <div class="search">${icon("search")}<input type="search" placeholder="Search by name" data-q /></div>
            <select data-app><option value="">All apps</option>${apps.map((one) => html`<option value="${one.key}"${view.appId === one.key ? " selected" : ""}>${appInfo(one.key).name}</option>`)}</select>
          </div>
        </div>
        <div data-list>${skeletonRows()}</div>
      </div>`,
  );

  const list = content.querySelector("[data-list]");

  async function load(append = false) {
    if (!append) {
      mount(list, skeletonRows());
    }
    const result = await get(
      ws(id, `/projects${query({ status: view.status, q: view.q.length >= 1 ? view.q : "", appId: view.appId, limit: 20, cursor: append ? view.nextCursor : "" })}`),
    );
    if (!result.ok) {
      mount(list, emptyState({ iconName: "triangle-alert", title: "Couldn't load projects", text: result.error }));
      return;
    }
    view.items = append ? [...view.items, ...(result.data.items ?? [])] : result.data.items ?? [];
    view.nextCursor = result.data.nextCursor ?? null;
    draw();
  }

  function draw() {
    if (view.items.length === 0) {
      const filtered = view.q || view.appId;
      mount(
        list,
        view.status === "ARCHIVED"
          ? emptyState({ iconName: "archive", title: "No archived projects", text: "Projects you archive are kept here, read-only." })
          : emptyState({
              iconName: "folder-kanban",
              title: filtered ? "No projects match" : "No projects yet",
              text: filtered ? "Try another name or app." : "Create a project to start building pages and campaigns.",
              action: !filtered && can("project.create") ? html`<button class="btn btn-primary" data-new-empty>${icon("plus")} New project</button>` : "",
            }),
      );
      list.querySelector("[data-new-empty]")?.addEventListener("click", () => openCreate());
      return;
    }
    mount(
      list,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Project</th><th>App</th><th>Created</th><th>Updated</th><th class="actions"></th></tr></thead>
        <tbody>${view.items.map((project) => {
          const info = appInfo(project.appId);
          // A whole active row opens the project's pages.
          return html`<tr${project.status === "ACTIVE" ? html` data-open="${project.projectId}" style="cursor:pointer"` : ""}>
            <td><div class="person"><span class="app-icon" style="width:30px;height:30px;border-radius:8px;background:${info.color}">${icon(info.icon)}</span><div><div class="name">${project.status === "ACTIVE" ? html`<a href="#/w/${id}/projects/${project.projectId}/pages">${project.name}</a>` : project.name}</div><div class="email">${project.vertical || "No industry set"}</div></div></div></td>
            <td><span class="chip">${info.name}</span></td>
            <td class="muted">${timeAgo(project.createdAt)}</td>
            <td class="muted">${project.status === "ARCHIVED" ? html`<span class="chip chip-warning">Archived</span>` : timeAgo(project.updatedAt)}</td>
            <td class="actions">${project.status === "ACTIVE" && can("project.update") ? html`<button class="btn btn-ghost btn-icon btn-sm" data-menu="${project.projectId}" data-popover-anchor aria-label="Project actions">${icon("ellipsis")}</button>` : ""}</td>
          </tr>`;
        })}</tbody>
      </table></div>
      ${view.nextCursor ? html`<div class="load-more"><button class="btn btn-sm" data-more>Load more</button></div>` : ""}`,
    );
    list.querySelector("[data-more]")?.addEventListener("click", (event) => busy(event.currentTarget, () => load(true)));
    list.querySelectorAll("[data-open]").forEach((row) =>
      row.addEventListener("click", (event) => {
        if (!event.target.closest("a, button")) {
          go(`/w/${id}/projects/${row.dataset.open}/pages`);
        }
      }),
    );
    list.querySelectorAll("[data-menu]").forEach((button) =>
      button.addEventListener("click", () => {
        const project = view.items.find((one) => one.projectId === button.dataset.menu);
        popover(button, [
          { label: "Pages", icon: "file-text", onClick: () => go(`/w/${id}/projects/${project.projectId}/pages`) },
          { label: "Rename", icon: "pencil", onClick: () => openRename(project) },
          "sep",
          { label: "Archive", icon: "archive", danger: true, onClick: () => archive(project) },
        ]);
      }),
    );
  }

  function openCreate() {
    const firstOpen = apps.find((one) => one.state === "ACTIVE")?.key;
    const preselect = apps.find((one) => one.key === view.appId && one.state === "ACTIVE")?.key ?? firstOpen;
    openModal({
      title: "New project",
      subtitle: "A project lives in one app. You can rename it later.",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Project name</span><input type="text" name="name" required maxlength="100" placeholder="e.g. Medicare leads Q4" /></label>
          <label class="field"><span>App</span><select name="appId">${apps.map((one) => {
            const label = appStateLabel(one);
            return html`<option value="${one.key}"${one.state !== "ACTIVE" ? " disabled" : ""}${one.key === preselect ? " selected" : ""}>${appInfo(one.key).name}${one.state !== "ACTIVE" ? ` — ${label.text}` : ""}</option>`;
          })}</select></label>
          <label class="field"><span>Industry <span class="muted">(optional)</span></span><input type="text" name="vertical" placeholder="${state.workspace?.defaultVertical ?? "e.g. Medicare"}" /></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Create project</button></div>`,
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
            const body = { appId: values.appId, name: values.name.trim() };
            if (values.vertical.trim()) {
              body.vertical = values.vertical.trim();
            }
            const result = await post(ws(id, "/projects"), body);
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            toast(`${result.data.name} created`);
            await refreshWorkspace();
            renderProjects({ params: params, query: {} });
          }),
        );
      },
    });
  }

  function openRename(project) {
    openModal({
      title: "Rename project",
      body: html`<form class="modal-body form" novalidate>
          <label class="field"><span>Project name</span><input type="text" name="name" required maxlength="100" value="${project.name}" /></label>
          <label class="field"><span>Industry</span><input type="text" name="vertical" value="${project.vertical ?? ""}" /></label>
        </form>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>Save</button></div>`,
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
            const result = await patch(ws(id, `/projects/${encodeURIComponent(project.projectId)}`), {
              name: values.name.trim(),
              vertical: values.vertical.trim(),
            });
            if (!result.ok) {
              setFormError(form, result.error);
              return;
            }
            close();
            toast("Project updated");
            load();
          }),
        );
      },
    });
  }

  async function archive(project) {
    const yes = await confirmDialog({
      title: `Archive ${project.name}?`,
      message: "It becomes read-only and moves to the Archived tab.",
      confirmLabel: "Archive project",
      danger: true,
    });
    if (!yes) {
      return;
    }
    const result = await post(ws(id, `/projects/${encodeURIComponent(project.projectId)}/archive`), {});
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${project.name} archived`);
    await refreshWorkspace();
    load();
  }

  content.querySelector("[data-new]")?.addEventListener("click", () => openCreate());
  content.querySelectorAll("[data-status] button").forEach((button) =>
    button.addEventListener("click", () => {
      content.querySelectorAll("[data-status] button").forEach((one) => one.classList.toggle("active", one === button));
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
  content.querySelector("[data-app]").addEventListener("change", (event) => {
    view.appId = event.target.value;
    load();
  });

  await load();
  if (params_.new === "1" && can("project.create")) {
    history.replaceState(null, "", `#/w/${id}/projects`);
    openCreate();
  }
}
