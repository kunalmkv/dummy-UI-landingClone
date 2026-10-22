// On a local API the harness can read the mail the API queued, so a page can
// hand over the code or link a real inbox would show. Always null elsewhere.

import { devTarget } from "./state.js";

/** The newest queued mail of one type for an address, or null. Polls briefly while it is being written. */
export async function latestMail(email, type, { attempts = 12, wait = 600 } = {}) {
  const target = await devTarget();
  if (!target.local || !email) {
    return null;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const rows = await (await fetch(`/dev/outbox?email=${encodeURIComponent(email)}`)).json();
      const row = Array.isArray(rows) ? rows.find((one) => one.type === type) : null;
      if (row) {
        return row;
      }
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return null;
}

/** The six-digit code from the newest mail of a type. */
export async function latestCode(email, type, options) {
  return (await latestMail(email, type, options))?.payload?.code ?? null;
}

/** The token at the end of an emailed link such as .../reset-password?token=abc or .../invite#abc. */
export function tokenOf(link) {
  if (!link) {
    return null;
  }
  const url = new URL(link, location.origin);
  return url.searchParams.get("token") ?? (url.hash ? url.hash.slice(1) : null);
}
