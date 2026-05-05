# Remove "Move: Follow-up" action

Date: 2026-05-05

## Context

Gmail Sorter started with seven actions: three star variants (Yellow, Red,
Red bang), Archive, Mark read, **Move: Follow-up**, and Leave alone. The
Follow-up action removed the message from the inbox and tagged it with a
custom Gmail label called `Follow-up`, lazy-created on first use.

In practice the user already uses **stars** to mark anything they need
to come back to — that is the entire purpose of the three star variants
introduced in 2026-04-29. The Follow-up label became a redundant second
"come back to this" mechanism that competed with stars rather than
complementing them.

## Decision

Remove `Move: Follow-up` from the action taxonomy. Star variants are
now the only "remember this" mechanism.

## Changes

- `extension/lib/schema.js` — drop the entry from `ACTIONS` and the
  matching line from `DEFAULT_RULES`. The "Things I need to reply to
  or act on soon → Star: Red" rule already covers the colleague-asks-
  for-something case that previously routed to Follow-up, so deleting
  is sufficient — no replacement rule needed.
- `extension/background/classify.js` — drop the `Move: Follow-up`
  branch from `actionToLabelDiff` and the `followUpLabelId` parameter.
  Any classifier output of `Move: Follow-up` now falls through to the
  unmapped path, which surfaces a toast and preserves the suggestion
  (same defensive behaviour as wrong-case `ARCHIVE`).
- `extension/background/pipeline.js` — delete `ensureFollowUpLabel`,
  `FOLLOWUP_LABEL_NAME`, and the lazy-create branch in `applyOne`.
- `extension/background/storage.js` — remove
  `KEYS.FOLLOWUP_LABEL_ID`. Existing users may still have the cached
  id under the `followUpLabelId` key in `chrome.storage.sync`; it
  becomes orphan data, but that is harmless and clears on any
  manual storage reset.
- `extension/sidepanel/sidepanel-pill.js` — drop the `↪` icon entry.
- `extension/sidepanel/sidepanel.css` — drop the unused `--violet`
  semantic-color variables (only Follow-up referenced them).
- `extension/sidepanel/sidepanel.js`, `extension/options/options.html`,
  `extension/README.md` — drop visible references in copy and demo
  data.
- `extension/tests/classify.test.js`, `extension/tests/apply.test.js` —
  the previous "happy path" tests for Follow-up become regression
  guards: `Move: Follow-up` must now resolve to `unmapped` so it
  surfaces a toast instead of silently mutating the inbox.

## Migration

Suggestions stored under the old `Move: Follow-up` action are dropped
on next side-panel load by the existing taxonomy migration in
`sidepanel.js::hydrateFromStorage` (any suggestion whose action is no
longer in `ACTIONS` is removed). Re-classify will repopulate them
under one of the remaining actions.

The `Follow-up` Gmail label, if it exists in the user's Gmail, is
left untouched. Users can delete it manually from Gmail's label
manager if they want to.

## Tests

`npm test` — 157 tests pass (down from 159; the two Follow-up
happy-path tests collapsed into a pair of regression guards).

UI verified by serving `extension/` locally and confirming each row
in the side panel renders six action buttons (no Follow-up) and the
"Sent to the model" preview omits the Follow-up rule.
