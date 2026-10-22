// Every /auth/* and /me/* endpoint in the mock catalog must be called, with its
// own method, somewhere in the app (public/app). A new route fails this until a
// screen uses it. Static: no server, no browser.  Usage: node e2e/app-coverage.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import categories from "../../backend/mock/data/category.data.mock.js";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/app");
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

const missing = rows.filter((row) => row.files.length === 0);
for (const row of rows) {
  console.log(`  ${row.files.length ? "✔" : "✖"} ${row.endpoint.method.padEnd(6)} ${row.endpoint.path}  ${[...new Set(row.files)].join(", ")}`);
}
const count = (prefix) => `${rows.filter((row) => row.endpoint.path.startsWith(prefix) && row.files.length).length} of ${rows.filter((row) => row.endpoint.path.startsWith(prefix)).length}`;
console.log(`\n/auth: ${count("/auth/")} · /me: ${count("/me/")} are called by the app`);
if (missing.length > 0) {
  console.error(`not called yet: ${missing.map((row) => `${row.endpoint.method} ${row.endpoint.path}`).join(", ")}`);
  process.exit(1);
}
