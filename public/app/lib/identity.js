// "Confirm it's you" before a risky action: a password, an authenticator code,
// or a code emailed on request (the way in for a Google-only account).
// POST /auth/identity/confirm unlocks one named action for five minutes.

import { post } from "./api.js";
import { latestCode } from "./devmail.js";
import { state } from "./state.js";
import { html } from "./ui.js";

const METHODS = [
  { key: "password", label: "Password" },
  { key: "totpCode", label: "Authenticator code" },
  { key: "emailCode", label: "Email code" },
];

/** The proof fields to drop inside a form. */
export function proofFields() {
  return html`<div class="proof" data-proof>
    <div class="segmented" data-proof-methods>${METHODS.map((method, index) => html`<button type="button" data-method="${method.key}" class="${index === 0 ? "active" : ""}">${method.label}</button>`)}</div>
    <label class="field" data-proof-field="password"><span>Your password</span><input type="password" name="password" autocomplete="current-password" /></label>
    <label class="field hidden" data-proof-field="totpCode"><span>Code from your authenticator app</span><input type="text" name="totpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" /></label>
    <div class="field hidden" data-proof-field="emailCode">
      <label><span>Six-digit code we email you</span><input type="text" name="emailCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" /></label>
      <div class="proof-send"><button type="button" class="btn btn-sm" data-send-code>Email me a code</button><span class="hint" data-code-note>Sent to ${state.user?.email ?? "your address"}. It works once and lasts five minutes.</span></div>
    </div>
  </div>`;
}

/** Switch methods and, for the email code, ask the API to send one for `action`. */
export function wireProof(root, action) {
  const methodButtons = root.querySelectorAll("[data-method]");
  const show = (key) => {
    methodButtons.forEach((button) => button.classList.toggle("active", button.dataset.method === key));
    root.querySelectorAll("[data-proof-field]").forEach((field) => field.classList.toggle("hidden", field.dataset.proofField !== key));
    root.querySelector(`[data-proof-field="${key}"] input`)?.focus();
  };
  methodButtons.forEach((button) => button.addEventListener("click", () => show(button.dataset.method)));
  const send = root.querySelector("[data-send-code]");
  send.addEventListener("click", async () => {
    const note = root.querySelector("[data-code-note]");
    send.disabled = true;
    const result = await post("/auth/identity/send-code", { action: action });
    send.disabled = false;
    if (!result.ok) {
      note.textContent = result.error;
      return;
    }
    note.textContent = `Code sent to ${state.user?.email}. It works once and lasts five minutes.`;
    // A local API: fill the code in, as the verify page does.
    const code = await latestCode(state.user?.email, "IDENTITY_CODE");
    const field = root.querySelector('[name="emailCode"]');
    if (code && field && !field.value) {
      field.value = code;
      note.textContent += " Local preview: filled in from the dev inbox.";
    }
  });
}

/** What the person typed, as the body fields the API takes, for the method they picked. */
export function readProof(root) {
  const key = root.querySelector("[data-method].active")?.dataset.method ?? "password";
  const value = root.querySelector(`[name="${key}"]`)?.value ?? "";
  // A password is sent exactly as typed; the codes are digits, so stray spaces go.
  return { [key]: key === "password" ? value : value.trim() };
}

/** Run the confirm step for one action. Resolves the API result. */
export function confirmIdentity(action, proof) {
  return post("/auth/identity/confirm", { action: action, ...proof });
}
