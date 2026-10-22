// Shell preferences that follow the person across devices (GET /me/preferences):
// appearance and density are applied to the page; do-not-disturb is just kept.

import { get } from "./api.js";

/** Put appearance and density on the page. Anything unknown falls back to the dark default. */
export function applyPreferences(prefs) {
  const appearance = ["light", "dark", "system"].includes(prefs?.appearance) ? prefs.appearance : "dark";
  document.documentElement.dataset.appearance = appearance;
  document.body.classList.toggle("density-compact", prefs?.density === "compact");
}

/** Read the signed-in person's preferences and apply them. Silent when the route isn't there. */
export async function loadPreferences() {
  const result = await get("/me/preferences");
  if (result.ok) {
    applyPreferences(result.data);
  }
  return result;
}
