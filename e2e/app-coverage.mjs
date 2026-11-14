// Every /auth/* and /me/* endpoint, and every custom-domains endpoint, in the mock
// catalog must be called, with its own method, somewhere in the app (public/app).
// A new route fails this until a screen uses it. Static: no server, no browser.
// Usage: BACKEND=/path/to/handover/backend node e2e/app-coverage.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The mock catalog of ../../backend, or of the backend BACKEND names.
const BACKEND = path.resolve(process.env.BACKEND ?? path.join(HERE, "../../backend"));
const { default: categories } = await import(pathToFileURL(path.join(BACKEND, "mock/data/category.data.mock.js")).href);

const APP_DIR = path.join(HERE, "../public/app");
// The app's api helpers, by HTTP method.
const HELPER = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "del" };

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") {
        found.push(...(await sourceFiles(full)));
      }
    } else if (entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

const sources = await Promise.all((await sourceFiles(APP_DIR)).map(async (file) => ({ file: path.relative(APP_DIR, file), text: await readFile(file, "utf8") })));

const endpoints = categories.flatMap((category) => category.endpoints ?? []).filter((endpoint) => endpoint.path.startsWith("/auth/") || endpoint.path.startsWith("/me/"));

const rows = endpoints.map((endpoint) => {
  // ":inviteId" becomes "anything", since the app builds that part with ${...}.
  const route = endpoint.path
    .split(/(:[A-Za-z]+)/)
    .map((part) => (part.startsWith(":") ? ".+?" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const call = new RegExp(`\\b${HELPER[endpoint.method]}\\(\\s*[\`"']${route}(?![\\w/-])`);
  return { endpoint, files: sources.filter((source) => call.test(source.text)).map((source) => source.file) };
});

// ─── the custom-domains routes ───────────────────────────────────────────────
// The pages build these through domainsPath(workspaceId, "/…"), and the zone and
// import pages through two named paths: zonePath and importPath.
const DOMAINS = "/workspaces/:workspaceId/domains";
const ALIASES = { "/:domainId/zone": "zonePath", "/:domainId/import": "importPath" };
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A path's ":param" parts are template substitutions in the source: ${domainId}. */
const asSource = (suffix) => suffix.split(/(:[A-Za-z]+)/).map((part) => (part.startsWith(":") ? "\\$\\{[^}]+\\}" : escaped(part))).join("");

/** The regexes any one of which is a call to this endpoint. */
function domainCalls(endpoint) {
  const suffix = endpoint.path.slice(DOMAINS.length);
  const helper = HELPER[endpoint.method];
  // The list and the add share one address: told apart by their method and arguments.
  if (suffix === "") {
    return [endpoint.method === "GET" ? /\bget\(\s*domainsPath\(\s*[^,()]+,\s*query\(/ : /\bpost\(\s*domainsPath\(\s*[^,()]+\)/];
  }
  const calls = [new RegExp(`\\b${helper}\\(\\s*domainsPath\\(\\s*[^,()]+,\\s*[\`"']${asSource(suffix)}(?![\\w/-])`)];
  for (const [prefix, variable] of Object.entries(ALIASES)) {
    if (suffix === prefix) {
      calls.push(new RegExp(`\\b${helper}\\(\\s*${variable}\\b`));
    } else if (suffix.startsWith(`${prefix}/`)) {
      const tail = `\\$\\{${variable}\\}${escaped(suffix.slice(prefix.length))}(?![\\w/-])`;
      calls.push(new RegExp(`\\b${helper}\\(\\s*[\`"']?${tail}`));
      // One call that picks its method: (record ? patch : post)(`${zonePath}/records`, …).
      calls.push(new RegExp(`\\([^()]*\\b${helper}\\b[^()]*\\)\\(\\s*[\`"']?${tail}`));
    }
  }
  return calls;
}

const domainRows = categories
  .flatMap((category) => category.endpoints ?? [])
  .filter((endpoint) => endpoint.path === DOMAINS || endpoint.path.startsWith(`${DOMAINS}/`))
  .map((endpoint) => ({ endpoint, files: sources.filter((source) => domainCalls(endpoint).some((call) => call.test(source.text))).map((source) => source.file) }));

const missing = [...rows, ...domainRows].filter((row) => row.files.length === 0);
for (const row of [...rows, ...domainRows]) {
  console.log(`  ${row.files.length ? "✔" : "✖"} ${row.endpoint.method.padEnd(6)} ${row.endpoint.path}  ${[...new Set(row.files)].join(", ")}`);
}
const count = (prefix) => `${rows.filter((row) => row.endpoint.path.startsWith(prefix) && row.files.length).length} of ${rows.filter((row) => row.endpoint.path.startsWith(prefix)).length}`;
console.log(`\n/auth: ${count("/auth/")} · /me: ${count("/me/")} are called by the app`);
console.log(`domains: ${domainRows.filter((row) => row.files.length).length} of ${domainRows.length} are called by the app`);
if (missing.length > 0) {
  console.error(`not called yet: ${missing.map((row) => `${row.endpoint.method} ${row.endpoint.path}`).join(", ")}`);
  process.exit(1);
}
