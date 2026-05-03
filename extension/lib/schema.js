// Taxonomy of actions the classifier may choose from, plus the default rules
// prompt. Users can override rules in the options page without changing the
// action list (the action → Gmail-diff mapping in classify.js depends on it).

export const ACTIONS = Object.freeze([
  "Star: Yellow",
  "Star: Red",
  "Star: Red bang",
  "Archive",
  "Mark read",
  "Move: Follow-up",
  "Leave alone",
]);

export const DEFAULT_RULES = `\
Personal, human messages from a real person to me → Star: Yellow.
Things I need to reply to or act on soon → Star: Red.
Urgent — needs my attention today → Star: Red bang.
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

// Cap on captured disagreements. Bounds the meta-prompt payload so it
// doesn't exceed the model's context window. When full, oldest is dropped.
export const MAX_DISAGREEMENTS = 50;

// The meta-prompt template used by improve.js. Three placeholders are
// substituted at render time: {ACTION_LIST}, {CURRENT_RULES},
// {DISAGREEMENTS_BLOCK}. Kept verbatim in code so the user can see the
// instruction the LLM receives — the side panel renders it read-only.
export const META_PROMPT = `You are tuning an email-classification ruleset.

The classifier picks one of these actions for each email:
{ACTION_LIST}

Current rules (free text the classifier reads to decide):
---
{CURRENT_RULES}
---

The user reviewed the classifier's predictions and disagreed with these:
{DISAGREEMENTS_BLOCK}

Each disagreement shows: From / Subject / Snippet, the action the classifier
chose, and the action the user actually wanted.

Rewrite the rules so that the classifier would have picked the user's chosen
action for each disagreement, while preserving the spirit of the existing
rules for cases not in the list.

Constraints:
- Use only the action names listed above. Do NOT invent new actions.
- Keep the rules concise — short bullet points or one-line statements.
- Do not include preamble, explanation, or commentary. Output only the new rules text.

Respond with JSON: {"rules": "<the new rules text>"}.`;
