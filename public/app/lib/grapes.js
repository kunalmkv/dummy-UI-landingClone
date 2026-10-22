// GrapesJS for pages: loaded only when a page needs it, the blocks the editor
// offers, image uploads to S3 through the pages routes, and rendering a design
// to HTML and CSS for the preview.

import { post, ws } from "./api.js";

const VENDOR = "/app/vendor/grapesjs-0.23.6";
let loading = null;

/** Load GrapesJS once; resolves the grapesjs global. */
export function loadGrapes() {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = `${VENDOR}/grapes.min.css`;
      document.head.appendChild(style);
      const script = document.createElement("script");
      script.src = `${VENDOR}/grapes.min.js`;
      script.onload = () => resolve(window.grapesjs);
      script.onerror = () => {
        loading = null;
        reject(new Error("Couldn't load the page editor."));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

// The core build has no blocks of its own; these cover a lander.
export const BLOCKS = [
  { id: "section", label: "Section", category: "Layout", content: '<section style="padding:48px 24px"><h2>Section title</h2><p>Write something here.</p></section>' },
  {
    id: "columns",
    label: "Two columns",
    category: "Layout",
    content: '<div style="display:flex;gap:24px;padding:24px"><div style="flex:1"><p>Left column</p></div><div style="flex:1"><p>Right column</p></div></div>',
  },
  { id: "heading", label: "Heading", category: "Basic", content: "<h1>Your headline</h1>" },
  { id: "text", label: "Text", category: "Basic", content: "<p>Insert your text here.</p>" },
  { id: "image", label: "Image", category: "Basic", content: { type: "image", style: { "max-width": "100%" } }, activate: true },
  {
    id: "button",
    label: "Button",
    category: "Basic",
    content: '<a href="#" style="display:inline-block;padding:12px 24px;background:#0b3d91;color:#fff;border-radius:6px;text-decoration:none">Get my quote</a>',
  },
  {
    id: "form",
    label: "Lead form",
    category: "Forms",
    content:
      '<form style="display:grid;gap:12px;max-width:360px;padding:24px"><input name="name" placeholder="Full name" /><input name="phone" placeholder="Phone" /><button type="submit">Get my quote</button></form>',
  },
];

/**
 * Upload one image as a page image: sign, PUT it to S3, commit.
 *
 * @returns {Promise<{ok: boolean, data?: {assetId: string, url: string}, error?: string}>}
 */
export async function uploadPageImage(workspaceId, projectId, file) {
  const base = ws(workspaceId, `/projects/${encodeURIComponent(projectId)}/pages/assets`);
  const started = await post(`${base}/upload-url`, { contentType: file.type, bytes: file.size });
  if (!started.ok) {
    return { ok: false, error: started.code === "NOT_CONFIGURED" ? "Image uploads need S3 set up on the API server." : started.error };
  }
  try {
    const stored = await fetch(started.data.uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
    if (!stored.ok) {
      return { ok: false, error: `Storage refused the file (HTTP ${stored.status}).` };
    }
  } catch {
    return { ok: false, error: "Couldn't reach storage. The bucket needs CORS for this site." };
  }
  const committed = await post(`${base}/${encodeURIComponent(started.data.assetId)}/commit`, {});
  return committed.ok ? { ok: true, data: committed.data } : { ok: false, error: committed.error };
}

/**
 * Render GrapesJS project data to HTML and CSS, in an editor nobody sees.
 *
 * @returns {Promise<{html: string, css: string}>}
 */
export async function renderDesign(design) {
  const grapesjs = await loadGrapes();
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-10000px;width:1024px;height:10px;overflow:hidden";
  document.body.appendChild(holder);
  const editor = grapesjs.init({ container: holder, height: "10px", storageManager: false });
  try {
    // Loaded here, not through init's projectData, which applies only once the canvas is ready.
    editor.loadProjectData(design);
    return { html: editor.getHtml(), css: editor.getCss() };
  } finally {
    editor.destroy();
    holder.remove();
  }
}
