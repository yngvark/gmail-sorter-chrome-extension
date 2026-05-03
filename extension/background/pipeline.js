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
  await store.appendDiag({ kind: "fetch_inbox.start", maxResults });
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

  const fetched = Object.keys(byId).length;
  await store.appendDiag({ kind: "fetch_inbox.done", fetched });
  return { fetched };
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

    // Always re-fetch so the button label "Classify inbox" matches what the
    // user expects: a fresh look at Gmail. The metadata endpoint is cheap;
    // matching the label is worth the round-trip. The `existing` filter
    // below still skips already-classified emails.
    await fetchInbox({ maxResults: settings.maxInbox });
    const inbox = await store.getInbox();

    const existing = await store.getSuggestions();
    const todo = Object.values(inbox).filter((e) => !existing[e.id]);

    await store.setClassifyProgress({ classifying: true, progress: 0, total: todo.length });
    await store.appendDiag({ kind: "classify_inbox.start", total: todo.length });

    if (todo.length === 0) {
      await store.setClassifyProgress({ classifying: false, progress: 0, total: 0 });
      await store.setHasClassified(true);
      await store.appendDiag({ kind: "classify_inbox.done", done: 0, total: 0, aborted: false });
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
          await store.appendDiag({ kind: "classify_inbox.email", emailId: row.id, ok: false });
          return;
        }
      }

      const result = await classifyEmail({ settings, email });

      if (!result.ok) {
        // Fatal for the whole run if it's CORS / model-missing / timeout.
        if (["cors", "model-missing", "timeout", "config"].includes(result.error.kind)) {
          aborted = true;
          await store.putError(result.error.kind, result.error.message, result.error.hint);
          await store.appendDiag({ kind: "classify_inbox.email", emailId: email.id, ok: false });
          return;
        }
        // Otherwise treat as "Leave alone" for this email and keep going.
        await store.appendDiag({ kind: "classify_inbox.email", emailId: email.id, ok: false });
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
      await store.appendDiag({
        kind: "classify_inbox.email",
        emailId: email.id,
        action: result.action,
        ok: true,
      });
    });

    await store.setClassifyProgress({ classifying: false, progress: done, total: todo.length });
    await store.setHasClassified(true);
    await store.appendDiag({ kind: "classify_inbox.done", done, total: todo.length, aborted });
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

// ------------------------ Star variant labels (lazy) ------------------------
//
// Gmail's superstar IDs (^ss_sy, ^ss_sr, ^ss_cr) are not writable via the
// public REST API — confirmed via probe. The fallback that survived review
// is custom user-labels with colours from Gmail's fixed palette, applied
// alongside the system STARRED label. Each variant gets its own label so
// users can filter / search by variant in Gmail.

const STAR_LABEL_SPECS = Object.freeze({
  yellow:  { name: "Star/Yellow",  color: { backgroundColor: "#fad165", textColor: "#594c05" } },
  red:     { name: "Star/Red",     color: { backgroundColor: "#cc3a21", textColor: "#ffffff" } },
  redBang: { name: "Star/RedBang", color: { backgroundColor: "#ac2b16", textColor: "#ffffff" } },
});

// Returns the Gmail label id for a star-variant label, lazy-creating it
// the first time it's needed. Cache lives at store.KEYS.STAR_LABEL_IDS as
// { yellow, red, redBang } in chrome.storage.sync. Mirrors ensureFollowUpLabel.
export async function ensureStarLabel(token, variant) {
  const spec = STAR_LABEL_SPECS[variant];
  if (!spec) throw new Error(`unknown star variant: ${variant}`);

  const cached = await store.get("sync", store.KEYS.STAR_LABEL_IDS, {});
  if (cached[variant]) return cached[variant];

  // Pick up an existing label if the user already has one with this name
  // (e.g. created by a previous extension version or by hand).
  const labels = await gmail.listLabels(token);
  const existing = labels.find((l) => l.name === spec.name);
  let id;
  if (existing) {
    id = existing.id;
  } else {
    const created = await gmail.createLabel(token, spec);
    id = created.id;
  }

  const next = { ...cached, [variant]: id };
  await store.set("sync", store.KEYS.STAR_LABEL_IDS, next);
  return id;
}

// ------------------------ applyOne ------------------------

export async function applyOne(emailId, chosenAction) {
  const suggestions = await store.getSuggestions();
  const sugg = suggestions[emailId];
  if (!sugg) {
    const result = { ok: false, error: { kind: "missing", message: "suggestion not found" } };
    await emitApplyOneFailure(emailId, undefined, result);
    return result;
  }

  // Disagreement capture: when the user picks an action different from the
  // model's suggestion, record the pair so improvePrompt can learn from it.
  // Apply the user's chosen action, not the predicted one.
  let actionToApply = sugg.action;
  if (chosenAction && chosenAction !== sugg.action) {
    const inbox = await store.getInbox();
    const row = inbox[emailId] || {};
    await store.appendDisagreement({
      emailId,
      predictedAction: sugg.action,
      chosenAction,
      from:    row.from    || sugg.from    || "",
      subject: row.subject || sugg.subject || "",
      snippet: (row.snippet || "").slice(0, 200),
      ts: Date.now(),
    });
    actionToApply = chosenAction;
  }

  await store.appendDiag({ kind: "apply_one.start", emailId, action: actionToApply });
  const settings = await store.getSettings();

  // Dry-run: skip the Gmail mutation entirely and just clear local state.
  // Useful for demoing the UI with real classifications.
  if (settings.dryRun) {
    await store.deleteSuggestion(emailId);
    await removeFromInbox(emailId);
    const r = { ok: true, applied: actionToApply, dryRun: true };
    await store.appendDiag({ kind: "apply_one.done", emailId, ok: true, dryRun: true });
    return r;
  }

  const starLabelIdsCache = await store.get("sync", store.KEYS.STAR_LABEL_IDS, {});
  let diff = actionToLabelDiff(actionToApply, { starLabelIds: starLabelIdsCache });

  // Unmapped action: the suggestion's action string didn't match any case
  // in actionToLabelDiff (typo, wrong case, garbled model output). DO NOT
  // delete the suggestion locally — that's the "Archive does nothing" foot-
  // gun where the row vanishes without Gmail being touched. Instead surface
  // a toast and leave the suggestion visible so something else can resolve
  // it (model retry, manual triage, code fix).
  if (diff.unmapped) {
    await store.appendDiag({ kind: "apply_one.unmapped_action", emailId, action: actionToApply });
    const result = {
      ok: false,
      error: { kind: "unmapped-action", message: `Unknown action: ${actionToApply}` },
    };
    await emitApplyOneFailure(emailId, actionToApply, result);
    return result;
  }

  // Leave alone (or any other intentional noop) just clears the suggestion
  // locally; nothing to do at Gmail.
  if (diff.noop) {
    await store.deleteSuggestion(emailId);
    await store.appendDiag({ kind: "apply_one.done", emailId, ok: true, noop: true });
    return { ok: true, applied: actionToApply, noop: true };
  }

  let token;
  try {
    token = await getToken({ interactive: true });
  } catch (err) {
    const result = { ok: false, error: { kind: err.kind || "auth", message: err.message } };
    await emitApplyOneFailure(emailId, actionToApply, result);
    return result;
  }

  // Lazy-create the Follow-up label if this is our first Move action.
  if (actionToApply === "Move: Follow-up" && diff.needsFollowUpLabel) {
    try {
      const labelId = await ensureFollowUpLabel(token);
      diff = actionToLabelDiff(actionToApply, { followUpLabelId: labelId });
    } catch (err) {
      await store.putApplyError(emailId, `Could not create Follow-up label: ${err.message}`);
      const result = { ok: false, error: { kind: "gmail", message: err.message } };
      await store.appendDiag({
        kind: "apply_one.done", emailId, ok: false, errorKind: result.error.kind,
      });
      return result;
    }
  }

  // Lazy-create the star-variant label if this is the first apply for that variant.
  if (diff.needsStarLabel) {
    try {
      const labelId = await ensureStarLabel(token, diff.needsStarLabel);
      diff = actionToLabelDiff(actionToApply, {
        starLabelIds: { ...starLabelIdsCache, [diff.needsStarLabel]: labelId },
        followUpLabelId: undefined,
      });
    } catch (err) {
      await store.putApplyError(emailId, `Could not create star label: ${err.message}`);
      const result = { ok: false, error: { kind: "gmail", message: err.message } };
      await store.appendDiag({
        kind: "apply_one.done", emailId, ok: false, errorKind: result.error.kind,
      });
      return result;
    }
  }

  try {
    await gmail.modifyLabels(token, emailId, { add: diff.add, remove: diff.remove });
    await store.deleteSuggestion(emailId);
    await store.clearApplyError(emailId);
    await removeFromInbox(emailId);
    await store.appendDiag({ kind: "apply_one.done", emailId, ok: true });
    return { ok: true, applied: actionToApply };
  } catch (err) {
    await store.putApplyError(emailId, err.message);
    const result = { ok: false, error: { kind: err.kind || "gmail", message: err.message } };
    await store.appendDiag({
      kind: "apply_one.done", emailId, ok: false, errorKind: result.error.kind,
    });
    return result;
  }
}

// Always-on visibility: if applyOne returns non-ok for ANY reason — missing
// suggestion, auth failure before the Gmail call, etc. — write to
// APPLY_ERRORS so the side panel toast renders. Previously only thrown
// errors from gmail.modifyLabels surfaced; everything else was silent.
async function emitApplyOneFailure(emailId, action, result) {
  const message = result?.error?.message || "Apply failed";
  await store.putApplyError(emailId, message);
  await store.appendDiag({
    kind: "apply_one.done",
    emailId,
    ok: false,
    errorKind: result?.error?.kind,
    ...(action ? { action } : {}),
  });
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
