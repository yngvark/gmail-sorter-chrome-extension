// Taxonomy of actions the classifier may choose from, plus the default rules
// prompt. Users can override rules in the options page without changing the
// action list (the action → Gmail-diff mapping in classify.js depends on it).

export const ACTIONS = Object.freeze([
  "Star",
  "Archive",
  "Mark read",
  "Move: Follow-up",
  "Leave alone",
]);

export const DEFAULT_RULES = `\
Personal, human messages from a real person to me → Star.
Receipts, order confirmations, newsletters, promotional mail → Archive.
Security alerts or notifications that don't need action → Mark read.
Colleagues or teammates asking for something from me (a review, a reply, a meeting) → Move: Follow-up.
Automated reminders about events that already exist in my calendar → Leave alone.
When genuinely unsure → Leave alone.`;

export const DEFAULT_SETTINGS = Object.freeze({
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel:   "hf.co/NbAiLab/borealis-4b-instruct-preview-gguf:Q8_0",
  numCtx:        64000,
  rules:         DEFAULT_RULES,
  maxInbox:      50,
  dryRun:        false,
  diagnostics:   false,
});

// Returned when the model's answer is unparseable. Safe fallback: don't
// mutate the user's mailbox.
export const SAFE_FALLBACK_ACTION = "Leave alone";
