// Hash routes: #/w/<workspaceId>/members?tab=invites

const routes = [];
let handler404 = null;

export function route(pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  routes.push({ regex: new RegExp(`^${source}$`), keys: keys, handler: handler });
}

// Which navigation is current. A page that waits on the API before it draws
// asks `navigation()` first and again afterwards; if it moved on, it must not draw.
let generation = 0;
export const navigation = () => generation;

export function notFound(handler) {
  handler404 = handler;
}

export function current() {
  const hash = location.hash.slice(1) || "/";
  const [path, search = ""] = hash.split("?");
  return { path: path || "/", query: Object.fromEntries(new URLSearchParams(search)) };
}

/** Navigate; `replace` keeps a redirect out of the back button's history. */
export function go(path, replace = false) {
  if (location.hash.slice(1) === path) {
    resolve();
  } else if (replace) {
    location.replace(`#${path}`);
  } else {
    location.hash = path;
  }
}

export async function resolve() {
  generation += 1;
  const { path, query } = current();
  // A thin bar at the top while the page's first calls are in flight.
  document.body.classList.add("is-loading");
  try {
    for (const one of routes) {
      const match = path.match(one.regex);
      if (match) {
        const params = Object.fromEntries(one.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
        return await one.handler({ params: params, query: query, path: path });
      }
    }
    return await handler404?.({ path: path, query: query });
  } finally {
    document.body.classList.remove("is-loading");
  }
}

export function start() {
  window.addEventListener("hashchange", resolve);
  resolve();
}
