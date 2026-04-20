// Orchestrates the high-level flows: fetch inbox, classify, apply.
// Keeps all state in chrome.storage so the service worker is safely
// resumable if it's suspended mid-run.

import * as gmail from "./gmail.js";
import { getToken } from "./auth.js";
import * as store from "./storage.js";
import { classifyEmail, actionToLabelDiff } from "./classify.js";

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

// ------------------------ Follow-up label (lazy) ------------------------

const FOLLOWUP_LABEL_NAME = "Follow-up";

// Returns the Gmail label id for our Follow-up label, creating it lazily
// and caching the id in chrome.storage.sync so we don't pay the round-trip
// on every apply.
export async function ensureFollowUpLabel(token) {
  const cached = await store.get("sync", store.KEYS.FOLLOWUP_LABEL_ID, null);
  if (cached) return cached;

  // First, check if the user (or a previous run) already has the label.
  const labels = await gmail.listLabels(token);
  const existing = labels.find((l) => l.name === FOLLOWUP_LABEL_NAME);
  if (existing) {
    await store.set("sync", store.KEYS.FOLLOWUP_LABEL_ID, existing.id);
    return existing.id;
  }

  // Otherwise create it.
  const created = await gmail.createLabel(token, {
    name: FOLLOWUP_LABEL_NAME,
    color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  });
  await store.set("sync", store.KEYS.FOLLOWUP_LABEL_ID, created.id);
  return created.id;
}

// ------------------------ applyOne ------------------------

export async function applyOne(emailId) {
  const suggestions = await store.getSuggestions();
  const sugg = suggestions[emailId];
  if (!sugg) return { ok: false, error: { kind: "missing", message: "suggestion not found" } };

  const settings = await store.getSettings();

  // Dry-run: skip the Gmail mutation entirely and just clear local state.
  // Useful for demoing the UI with real classifications.
  if (settings.dryRun) {
    await store.deleteSuggestion(emailId);
    await removeFromInbox(emailId);
    return { ok: true, applied: sugg.action, dryRun: true };
  }

  let diff = actionToLabelDiff(sugg.action);

  // Leave alone just clears the suggestion locally; nothing to do at Gmail.
  if (diff.noop) {
    await store.deleteSuggestion(emailId);
    return { ok: true, applied: sugg.action, noop: true };
  }

  const token = await getToken({ interactive: true });

  // Lazy-create the Follow-up label if this is our first Move action.
  if (sugg.action === "Move: Follow-up" && diff.needsFollowUpLabel) {
    try {
      const labelId = await ensureFollowUpLabel(token);
      diff = actionToLabelDiff(sugg.action, { followUpLabelId: labelId });
    } catch (err) {
      await store.putApplyError(emailId, `Could not create Follow-up label: ${err.message}`);
      return { ok: false, error: { kind: "gmail", message: err.message } };
    }
  }

  try {
    await gmail.modifyLabels(token, emailId, { add: diff.add, remove: diff.remove });
    await store.deleteSuggestion(emailId);
    await store.clearApplyError(emailId);
    await removeFromInbox(emailId);
    return { ok: true, applied: sugg.action };
  } catch (err) {
    await store.putApplyError(emailId, err.message);
    return { ok: false, error: { kind: err.kind || "gmail", message: err.message } };
  }
}

// ------------------------ Superstar probe (dev) ------------------------

export async function probeSuperstar({ emailId, variant = "red" } = {}) {
  const inbox = await store.getInbox();
  const row = emailId ? inbox[emailId] : Object.values(inbox)[0];
  if (!row) return { error: "inbox is empty — run fetchInbox first" };
  const token = await getToken({ interactive: true });
  const result = await gmail.probeSuperstar(token, row.id, variant);
  console.log("[gmail-sorter] superstar probe →", result);
  return result;
}

async function removeFromInbox(emailId) {
  const inbox = await store.getInbox();
  if (emailId in inbox) {
    delete inbox[emailId];
    await store.setInbox(inbox);
  }
}

// ------------------------ applyAll ------------------------

// Visual pacing: even when the network is fast, 250ms per item gives the
// user a sense of progress rather than a flash. Matches the prototype's
// APPLY_ALL_STAGGER_MS so the Chrome extension feels the same.
const APPLY_ALL_STAGGER_MS = 250;

let applyInFlight = false;

export async function applyAll() {
  if (applyInFlight) return { started: false, reason: "already-running" };
  applyInFlight = true;

  try {
    const suggestions = await store.getSuggestions();
    const queue = Object.values(suggestions);
    if (queue.length === 0) return { started: true, total: 0, applied: 0 };

    await store.setApplyProgress({ applying: true, progress: 0, total: queue.length });

    let applied = 0;
    let firstError = null;

    for (const s of queue) {
      const t0 = Date.now();
      const r = await applyOne(s.emailId);
      if (r.ok) applied++;
      else if (!firstError) firstError = r.error;

      await store.setApplyProgress({
        applying: true,
        progress: applied,
        total: queue.length,
      });

      // Stop on auth failure — no point retrying every subsequent item.
      if (!r.ok && r.error?.kind === "auth") break;

      // Pace to stagger timeline so the UI animation reads as "streaming".
      const elapsed = Date.now() - t0;
      if (elapsed < APPLY_ALL_STAGGER_MS) {
        await sleep(APPLY_ALL_STAGGER_MS - elapsed);
      }
    }

    await store.setApplyProgress({ applying: false, progress: applied, total: queue.length });
    return { started: true, total: queue.length, applied, firstError };
  } finally {
    applyInFlight = false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
