// Workspace home: who's here, the app grid, a get-started list and recent projects.

import { get, post, query, ws } from "../lib/api.js";
import { appInfo, appStateLabel } from "../lib/apps.js";
import { can, state } from "../lib/state.js";
import { busy, emptyState, html, icon, mount, plural, timeAgo, toast } from "../lib/ui.js";
import { shell } from "./shell.js";

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export async function renderHome({ params }) {
  const content = await shell({ workspaceId: params.id, active: "home", crumb: "Home" });
  if (!content) {
    return;
  }
  const id = params.id;
  const base = `#/w/${id}`;
  const workspace = state.workspace;
  mount(content, html`<div class="skeleton" style="height:28px;width:320px"></div>`);
  const [apps, health, projects, seats] = await Promise.all([
    get(ws(id, "/apps")),
    get(ws(id, "/health")),
    get(ws(id, `/projects${query({ status: "ACTIVE", limit: 5 })}`)),
    get(ws(id, "/seats")),
  ]);
  const appList = apps.ok ? apps.data : [];
  const projectList = projects.ok ? projects.data.items ?? [] : [];
  const webhooks = health.ok ? health.data.webhooks ?? { ok: 0, failing: 0 } : { ok: 0, failing: 0 };
  const seat = seats.ok ? seats.data : null;
  const counts = workspace.counts ?? {};
  const steps = [
    { done: true, label: "Create your workspace", href: `${base}/settings/general` },
    { done: (counts.projects ?? 0) > 0, label: "Create your first project", href: `${base}/projects?new=1` },
    { done: (counts.members ?? 0) > 1 || (counts.pendingInvites ?? 0) > 0, label: "Invite your team", href: `${base}/members?invite=1` },
    { done: webhooks.ok + webhooks.failing > 0, label: "Send leads to your tools with a webhook", href: `${base}/settings/webhooks` },
  ];
  const remaining = steps.filter((step) => !step.done).length;

  mount(
    content,
    html`
      <div class="page-head">
        <div><h1>${greeting()}, ${state.user?.firstName ?? ""}</h1><p>Here's what's happening in ${workspace.name}.</p></div>
        <div class="actions">
          ${can("member.invite") ? html`<a class="btn" href="${base}/members?invite=1">${icon("user-plus")} Invite people</a>` : ""}
          ${can("project.create") ? html`<a class="btn btn-primary" href="${base}/projects?new=1">${icon("plus")} New project</a>` : ""}
        </div>
      </div>

      <div class="grid-stats">
        <a class="card stat" href="${base}/projects" style="color:inherit;text-decoration:none"><div class="label">${icon("folder-kanban")} Active projects</div><div class="value">${counts.projects ?? 0}</div><div class="sub">across ${plural(appList.filter((one) => one.state === "ACTIVE").length, "open app")}</div></a>
        <a class="card stat" href="${base}/members" style="color:inherit;text-decoration:none"><div class="label">${icon("users")} Members</div><div class="value">${counts.members ?? 0}</div><div class="sub">${plural(counts.pendingInvites ?? 0, "invitation")} pending</div></a>
        <div class="card stat"><div class="label">${icon("armchair")} Seats</div><div class="value">${seat ? `${seat.seatsUsed}/${seat.seatsIncluded + (seat.seatsExtra ?? 0)}` : "—"}</div><div class="sub">${seat ? `${seat.seatsFree} free on the ${seat.plan} plan` : ""}</div></div>
        <a class="card stat" href="${base}/settings/webhooks" style="color:inherit;text-decoration:none"><div class="label">${icon("webhook")} Webhooks</div><div class="value">${webhooks.ok + webhooks.failing}</div><div class="sub">${webhooks.failing ? html`<span class="danger-text">${webhooks.failing} failing</span>` : "all healthy"}</div></a>
      </div>

      <div class="home-cols">
        <div class="card">
          <div class="card-head"><div><h2>Apps</h2><p>Everything your workspace can use.</p></div></div>
          <div class="card-body"><div class="apps" style="grid-template-columns:repeat(2,minmax(0,1fr))">${appList.map((one) => appCard(one, base))}</div></div>
        </div>
        <div style="display:grid;gap:18px">
          ${remaining
            ? html`<div class="card">
                <div class="card-head"><div><h2>Get started</h2><p>${steps.length - remaining} of ${steps.length} done</p></div></div>
                <div class="card-body checklist" style="padding:8px">${steps.map(
                  (step) => html`<a href="${step.href}" class="${step.done ? "done" : ""}"><span class="tick">${step.done ? icon("check") : ""}</span><span class="label">${step.label}</span>${step.done ? "" : html`<span class="arrow">${icon("arrow-right")}</span>`}</a>`,
                )}</div>
              </div>`
            : ""}
          <div class="card">
            <div class="card-head"><div><h2>Recent projects</h2></div><a href="${base}/projects" class="btn btn-ghost btn-sm">View all</a></div>
            ${projectList.length === 0
              ? emptyState({ iconName: "folder-kanban", title: "No projects yet", text: "Projects hold your pages, campaigns and leads.", action: can("project.create") ? html`<a class="btn btn-primary btn-sm" href="${base}/projects?new=1">${icon("plus")} New project</a>` : "" })
              : html`<div>${projectList.map((project) => {
                  const info = appInfo(project.appId);
                  return html`<a class="invite-row" href="${base}/projects/${project.projectId}/pages" style="color:inherit;text-decoration:none"><span class="app-icon" style="width:30px;height:30px;border-radius:8px;background:${info.color}">${icon(info.icon)}</span><div class="grow"><div style="font-weight:500">${project.name}</div><div class="muted" style="font-size:12px">${info.name}${project.vertical ? ` · ${project.vertical}` : ""}</div></div><span class="muted" style="font-size:12px">${timeAgo(project.createdAt)}</span></a>`;
                })}</div>`}
          </div>
        </div>
      </div>`,
  );

  content.querySelectorAll("[data-waitlist]").forEach((button) =>
    button.addEventListener("click", () =>
      busy(button, async () => {
        const result = await post(ws(id, `/apps/${encodeURIComponent(button.dataset.waitlist)}/waitlist`), {});
        if (!result.ok) {
          toast(result.error, "error");
          return;
        }
        toast("We'll let you know when it launches");
        renderHome({ params: params });
      }),
    ),
  );
}

function appCard(app, base) {
  const info = appInfo(app.key);
  const label = appStateLabel(app);
  let action = "";
  if (app.state === "ACTIVE") {
    action = html`<a class="btn btn-sm" href="${base}/projects?app=${app.key}">Open ${icon("arrow-right")}</a>`;
  } else if (app.state === "COMING_SOON") {
    action = app.onWaitlist
      ? html`<span class="chip chip-success">${icon("check")} On the waitlist</span>`
      : html`<button class="btn btn-sm" data-waitlist="${app.key}">${icon("bell")} Notify me</button>`;
  } else if (app.state === "UPGRADE") {
    action = html`<a class="btn btn-sm" href="${base}/settings/billing">See plans</a>`;
  }
  return html`<div class="app-card ${app.state === "ACTIVE" ? "" : "locked"}">
    <div class="app-top"><span class="app-icon" style="background:${info.color}">${icon(info.icon)}</span><div style="font-weight:600">${info.name}</div></div>
    <div class="desc">${info.tagline}</div>
    <div class="app-foot"><span class="chip ${label.kind ? `chip-${label.kind}` : ""}">${label.text}</span>${action}</div>
  </div>`;
}
