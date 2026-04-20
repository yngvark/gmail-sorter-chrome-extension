// Orchestrates the high-level flows: fetch inbox, classify, apply.
// Keeps all state in chrome.storage so the service worker is safely
// resumable if it's suspended mid-run.

import * as gmail from "./gmail.js";
import { getToken } from "./auth.js";
import * as store from "./storage.js";
import { classifyEmail } from "./classify.js";

// ------------------------ Concurrency helper ------------------------

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { _error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------ fetchInbox ------------------------

export async function fetchInbox({ maxResults = 50 } = {}) {
  const token = await getToken({ interactive: true });
  const ids = await gmail.listInboxIds(token, { maxResults });

  // Start with an empty map so removed/archived-outside-extension emails
  // don't linger. If we wanted incremental merge we'd skip this.
  const rows = await mapWithConcurrency(ids, 4, async (id) => {
    return gmail.getMessageMetadata(token, id);
  });

  const byId = {};
  for (const r of rows) {
    if (r && !r._error) byId[r.id] = r;
  }
  await store.setInbox(byId);

  return { fetched: Object.keys(byId).length };
}

// ------------------------ classifyOne (dev) ------------------------

export async function classifyOne(emailId) {
  const inbox = await store.getInbox();
  const row = inbox[emailId] || Object.values(inbox)[0];
  if (!row) return { error: "inbox is empty — run fetchInbox first" };

  const settings = await store.getSettings();
  const token = await getToken({ interactive: true });

  // Escalate to full body if we don't already have one (metadata fetch gave
  // us just from/subject/snippet).
  let email = row;
  if (!email.body) {
    email = await gmail.getMessageFull(token, row.id);
  }

  const result = await classifyEmail({ settings, email });
  console.log("[gmail-sorter] classifyOne →", { from: email.from, subject: email.subject, result });
  if (!result.ok) {
    await store.putError(result.error.kind, result.error.message, result.error.hint);
  } else {
    await store.clearError();
  }
  return { emailId: email.id, from: email.from, subject: email.subject, ...result };
}
