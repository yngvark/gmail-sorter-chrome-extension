// Shared message type constants for chrome.runtime messaging between the
// side panel / options page and the service worker.

export const MSG = Object.freeze({
  AUTH_TEST:       "AUTH_TEST",        // dev-only: returns masked token prefix
  AUTH_SIGN_OUT:   "AUTH_SIGN_OUT",

  FETCH_INBOX:     "FETCH_INBOX",      // list inbox + populate storage.local.inboxEmails
  CLASSIFY_ONE:    "CLASSIFY_ONE",     // dev-only: classify a single email, log result
  CLASSIFY_INBOX:  "CLASSIFY_INBOX",   // classify all unclassified inbox emails

  APPLY_ONE:       "APPLY_ONE",        // apply the action for one suggestion
  APPLY_ALL:       "APPLY_ALL",        // apply every pending suggestion

  PROBE_SUPERSTAR: "PROBE_SUPERSTAR",  // dev-only: test whether ^ss_* labels are writable
});

// Response envelope: { ok: true, data } | { ok: false, error: { kind, message, hint? } }
export function reply(data)           { return { ok: true, data }; }
export function replyError(error)     { return { ok: false, error }; }
