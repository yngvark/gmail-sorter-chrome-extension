// Typed wrapper around chrome.storage. Keys are split by persistence:
//
//   local   → inbox rows, suggestions, apply errors (persist across restart)
//   session → classify/apply progress (cleared when browser closes)
//   sync    → user settings (synced across devices)

import { DEFAULT_SETTINGS, MAX_DISAGREEMENTS } from "../lib/schema.js";

export const KEYS = Object.freeze({
  INBOX:        "inboxEmails",       // { [id]: { id, from, subject, snippet, labelIds } }
  SUGGESTIONS:  "suggestions",       // { [id]: { emailId, from, subject, action } }
  APPLY_ERRORS: "applyErrors",       // { [id]: { message } }
  HAS_CLASSIFIED: "hasClassified",   // boolean — true once the first classify run completes

  CLASSIFY_PROGRESS: "classifyProgress",  // session: { classifying, progress, total }
  APPLY_PROGRESS:    "applyProgress",     // session: { applying, progress, total }
  ERROR:             "lastError",         // session: { kind, message, hint? } (CORS etc.)

  SETTINGS:          "settings",          // sync: see schema.js for shape
  FOLLOWUP_LABEL_ID: "followUpLabelId",   // sync: cached custom-label id
  STAR_LABEL_IDS:    "starLabelIdsV2",      // sync: { yellow?, red?, redBang? } cached label ids

  DIAG_LOG:          "diagLog",           // local: redacted ring buffer of diagnostic events
  DISAGREEMENTS:    "disagreements",     // local: capped buffer of {emailId, predictedAction, chosenAction, from, subject, snippet, ts}

  IMPROVING:        "improving",         // session: { improving: bool, ts }
  IMPROVE_ERROR:    "improveError",      // session: { kind, message, hint? }
});

// Cap on the number of diagnostic events kept in chrome.storage.local.
// Older entries fall off the front. The buffer is intentionally small —
// we only need it to debug a recent reproduction.
export const DIAG_BUFFER_MAX = 200;

// ------------------------ Thin wrappers ------------------------

const getArea = (area) => chrome.storage[area];

export async function get(area, key, fallback) {
  const obj = await getArea(area).get(key);
  return key in obj ? obj[key] : fallback;
}

export async function set(area, key, value) {
  await getArea(area).set({ [key]: value });
}

export async function update(area, key, patch) {
  const current = (await get(area, key, {})) || {};
  const next = { ...current, ...patch };
  await set(area, key, next);
  return next;
}

export async function deleteKeys(area, keys) {
  await getArea(area).remove(keys);
}

// ------------------------ Domain helpers ------------------------

export async function getInbox() {
  return (await get("local", KEYS.INBOX, {})) || {};
}

export async function setInbox(byId) {
  await set("local", KEYS.INBOX, byId);
}

export async function mergeInbox(rows) {
  const current = await getInbox();
  for (const r of rows) current[r.id] = r;
  await setInbox(current);
}

export async function getSuggestions() {
  return (await get("local", KEYS.SUGGESTIONS, {})) || {};
}

// chrome.storage has no transaction primitive. When multiple concurrent
// classifiers all do read-modify-write on `suggestions`, the last writer
// wins and earlier entries are lost. Serialise them through a promise chain
// — only the "suggestions" key mutates often enough to need this.
let suggestionsLock = Promise.resolve();
function withSuggestionsLock(fn) {
  const next = suggestionsLock.then(fn, fn);
  // Ensure rejections in fn don't poison the lock for subsequent callers.
  suggestionsLock = next.catch(() => {});
  return next;
}

export function putSuggestion(s) {
  return withSuggestionsLock(async () => {
    const all = await getSuggestions();
    all[s.emailId] = s;
    await set("local", KEYS.SUGGESTIONS, all);
  });
}

export function deleteSuggestion(emailId) {
  return withSuggestionsLock(async () => {
    const all = await getSuggestions();
    delete all[emailId];
    await set("local", KEYS.SUGGESTIONS, all);
  });
}

export async function putError(kind, message, hint) {
  await set("session", KEYS.ERROR, { kind, message, hint });
}

export async function clearError() {
  await deleteKeys("session", [KEYS.ERROR]);
}

export async function setClassifyProgress(progress) {
  await set("session", KEYS.CLASSIFY_PROGRESS, progress);
}

export async function setApplyProgress(progress) {
  await set("session", KEYS.APPLY_PROGRESS, progress);
}

export async function putApplyError(id, message) {
  const all = (await get("local", KEYS.APPLY_ERRORS, {})) || {};
  all[id] = { message };
  await set("local", KEYS.APPLY_ERRORS, all);
}

export async function clearApplyError(id) {
  const all = (await get("local", KEYS.APPLY_ERRORS, {})) || {};
  delete all[id];
  await set("local", KEYS.APPLY_ERRORS, all);
}

export async function getSettings() {
  const saved = (await get("sync", KEYS.SETTINGS, {})) || {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set("sync", KEYS.SETTINGS, next);
  return next;
}

export async function setHasClassified(value = true) {
  await set("local", KEYS.HAS_CLASSIFIED, value);
}

// ------------------------ Diagnostics ring buffer ------------------------
//
// Privacy contract: events MUST NOT contain email content (from/subject/
// snippet/body). Email IDs (Gmail's opaque hex) are fine — they're not
// content. See docs/diagnostics.md for the full taxonomy.

// Serialise reads + writes so concurrent appends don't lose entries — the
// pipeline emits multiple events per email in parallel.
let diagLock = Promise.resolve();
function withDiagLock(fn) {
  const next = diagLock.then(fn, fn);
  diagLock = next.catch(() => {});
  return next;
}

export function appendDiag(event) {
  return withDiagLock(async () => {
    const settings = await getSettings();
    if (!settings.diagnostics) return;
    const buf = (await get("local", KEYS.DIAG_LOG, [])) || [];
    buf.push({ ts: Date.now(), ...event });
    // Trim from the front so the buffer stays bounded.
    const trimmed = buf.length > DIAG_BUFFER_MAX
      ? buf.slice(buf.length - DIAG_BUFFER_MAX)
      : buf;
    await set("local", KEYS.DIAG_LOG, trimmed);
  });
}

export async function getDiag() {
  return (await get("local", KEYS.DIAG_LOG, [])) || [];
}

export async function clearDiag() {
  await set("local", KEYS.DIAG_LOG, []);
}

// ------------------------ Disagreement buffer ------------------------
//
// Append-only list capped at MAX_DISAGREEMENTS. Cleared on successful
// improve. Serialise reads + writes so concurrent appends from rapid
// clicks don't lose entries — same pattern as withSuggestionsLock.

let disagreementsLock = Promise.resolve();
function withDisagreementsLock(fn) {
  const next = disagreementsLock.then(fn, fn);
  disagreementsLock = next.catch(() => {});
  return next;
}

export async function getDisagreements() {
  return (await get("local", KEYS.DISAGREEMENTS, [])) || [];
}

export function appendDisagreement(record) {
  return withDisagreementsLock(async () => {
    const list = await getDisagreements();
    list.push(record);
    const trimmed = list.length > MAX_DISAGREEMENTS
      ? list.slice(list.length - MAX_DISAGREEMENTS)
      : list;
    await set("local", KEYS.DISAGREEMENTS, trimmed);
  });
}

export function clearDisagreements() {
  return withDisagreementsLock(async () => {
    await set("local", KEYS.DISAGREEMENTS, []);
  });
}

// ------------------------ Improve session state ------------------------

export async function getImproving() {
  const v = await get("session", KEYS.IMPROVING, null);
  return Boolean(v?.improving);
}

export async function setImproving(improving) {
  await set("session", KEYS.IMPROVING, { improving: Boolean(improving), ts: Date.now() });
}

export async function getImproveError() {
  return (await get("session", KEYS.IMPROVE_ERROR, null)) || null;
}

export async function putImproveError(kind, message, hint) {
  await set("session", KEYS.IMPROVE_ERROR, { kind, message, ...(hint ? { hint } : {}) });
}

export async function clearImproveError() {
  await deleteKeys("session", [KEYS.IMPROVE_ERROR]);
}
