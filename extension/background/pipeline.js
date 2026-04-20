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
  const row = emailId ? inbox[emailId] : Object.values(inbox)[0];
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

// ------------------------ classifyInbox ------------------------

// In-memory guard so concurrent CLASSIFY_INBOX messages from multiple panel
// instances don't double-run. The service worker can be suspended between
// calls, so this is best-effort — the progress flag in session storage is
// the source of truth for UI.
let classifyInFlight = false;

export async function classifyInbox() {
  if (classifyInFlight) return { started: false, reason: "already-running" };
  classifyInFlight = true;

  try {
    const settings = await store.getSettings();
    await store.clearError();

    let inbox = await store.getInbox();
    if (Object.keys(inbox).length === 0) {
      await fetchInbox({ maxResults: settings.maxInbox });
      inbox = await store.getInbox();
    }

    const existing = await store.getSuggestions();
    const todo = Object.values(inbox).filter((e) => !existing[e.id]);

    await store.setClassifyProgress({ classifying: true, progress: 0, total: todo.length });

    if (todo.length === 0) {
      await store.setClassifyProgress({ classifying: false, progress: 0, total: 0 });
      await store.setHasClassified(true);
      return { started: true, total: 0 };
    }

    const token = await getToken({ interactive: true });

    let done = 0;
    let aborted = false;

    // Concurrency = 2: Ollama is single-threaded on most hardware; more
    // parallelism only queues inside the server.
    await mapWithConcurrency(todo, 2, async (row) => {
      if (aborted) return;
      // If the initial row lacks a body, fetch it in full.
      let email = row;
      if (!email.body) {
        try { email = await gmail.getMessageFull(token, row.id); }
        catch (err) {
          // Auth or Gmail error — abort, surface to panel.
          aborted = true;
          await store.putError(err.kind || "gmail", err.message);
          return;
        }
      }

      const result = await classifyEmail({ settings, email });

      if (!result.ok) {
        // Fatal for the whole run if it's CORS / model-missing / timeout.
        if (["cors", "model-missing", "timeout", "config"].includes(result.error.kind)) {
          aborted = true;
          await store.putError(result.error.kind, result.error.message, result.error.hint);
          return;
        }
        // Otherwise treat as "Leave alone" for this email and keep going.
        return;
      }

      if (result.action !== "Leave alone") {
        await store.putSuggestion({
          emailId: email.id,
          from: email.from,
          subject: email.subject,
          action: result.action,
        });
      }

      done++;
      await store.setClassifyProgress({ classifying: true, progress: done, total: todo.length });
    });

    await store.setClassifyProgress({ classifying: false, progress: done, total: todo.length });
    await store.setHasClassified(true);
    return { started: true, total: todo.length, done, aborted };
  } finally {
    classifyInFlight = false;
  }
}
