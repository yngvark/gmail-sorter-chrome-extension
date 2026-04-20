// Typed wrapper around chrome.storage. Keys are split by persistence:
//
//   local   → inbox rows, suggestions, apply errors (persist across restart)
//   session → classify/apply progress (cleared when browser closes)
//   sync    → user settings (synced across devices)

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
});

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

export async function putSuggestion(s) {
  const all = await getSuggestions();
  all[s.emailId] = s;
  await set("local", KEYS.SUGGESTIONS, all);
}

export async function deleteSuggestion(emailId) {
  const all = await getSuggestions();
  delete all[emailId];
  await set("local", KEYS.SUGGESTIONS, all);
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
