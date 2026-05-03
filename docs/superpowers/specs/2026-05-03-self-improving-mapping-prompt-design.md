# Gmail Sorter — Self-Improving Mapping Prompt

**Date:** 2026-05-03
**Status:** Approved for implementation planning
**Scope:** Capture user disagreements with the classifier's predictions, and use the same local Ollama model to rewrite the rules portion of the classification prompt on demand.

## Purpose

Today the classifier reads a fixed `rules` string from settings and picks one action per email. The rules are only updated by hand on the options page. The user wants the system to **self-improve**: every time the user picks a different action than the one the classifier predicted, that disagreement is recorded; on demand, an "Improve mapping prompt" button asks the LLM to rewrite the rules so future predictions match the user's choices.

Three principles drive this design:

1. **Visibility.** The full system message sent to the model — the *mapping prompt* — must be visible in the side panel. So must the disagreement list and the meta-prompt that drives Improve. Nothing the model sees should be hidden from the user.
2. **User-triggered.** Improvement runs only when the user clicks Improve. No background work.
3. **Reversible state.** A failed Improve must leave the rules and disagreements untouched, so the user can retry or edit manually.

## Non-goals

- No prompt-version history or rollback. New rules overwrite the old.
- No retention of disagreements across an Improve run. Successful Improve clears the list.
- No automatic detection of "Improve made things worse". User detects this by observing the new suggestions and either re-edits manually or accumulates new disagreements and Improves again.
- No editing of the meta-prompt by the user. It is rendered read-only.
- No background or scheduled improvement.
- No A/B comparison of old vs new rules.
- No per-disagreement "ignore" or "delete" controls.

## Concept: the mapping prompt

The "mapping prompt" is the **full system message** the classifier sends to the model. It has three parts:

1. **Action list** — the seven entries in `ACTIONS` (`Star: Yellow`, `Star: Red`, `Star: Red bang`, `Archive`, `Mark read`, `Move: Follow-up`, `Leave alone`). Fixed in code, because each action name is bound to a specific Gmail label diff in `actionToLabelDiff`.
2. **Rules** — `settings.rules`, a free-text string read from `chrome.storage.sync`. **This is the only mutable part.** Both manual edits and Improve writes here.
3. **JSON contract** — the `Respond with strict JSON: {"action": ...}` instruction. Fixed in code; the response parser depends on it.

The side panel renders all three parts read-only as a single block, then exposes the rules section a second time as an editable textarea below. This makes the *actual* prompt visible while keeping the editable surface small.

## Disagreement signal

Each email row in the side panel shows **all seven actions inline as icon+text buttons**, not just the predicted one. The predicted action is visually highlighted (filled accent style). The other six are muted (ghost style).

- Click the predicted action → accept. Same behavior as today: apply, fade out, remove suggestion. No disagreement recorded.
- Click any other action → disagreement. Record `{emailId, predictedAction, chosenAction, from, subject, snippet, ts}`, apply the **chosen** action's Gmail diff, fade out, remove suggestion.

The chosen action's Gmail diff is computed by the same `actionToLabelDiff` function used by the classify-time apply path. No new diff logic.

Initial icon set (refinable during implementation; emoji keep the implementation dependency-free):

| Action | Icon |
|---|---|
| Star: Yellow | ⭐ |
| Star: Red | 🔴 |
| Star: Red bang | ‼️ |
| Archive | 📥 |
| Mark read | ✓ |
| Move: Follow-up | ↪ |
| Leave alone | 💤 |

## Side panel layout

The side panel gains a **bottom-of-panel "Mapping prompt" section**, appended after the apply-all area. The user scrolls down to reach it. This keeps the suggestions area unchanged at the top.

The section contains, in order:

1. **Sent to the model** (read-only block, fixed-width font). The full system message — action list, rules, JSON contract — exactly as it would be sent for the next classification.
2. **Rules (improvable)** — an editable textarea pre-filled with the current rules. A **Save rules** button writes to `settings.rules`. Manual edits behave exactly like today's options-page edit.
3. **Disagreements pending: N** — a header with a count badge and a disclosure triangle. Closed by default. When opened, lists each pending disagreement as `From — Subject — predicted: X → chose: Y`, with the snippet underneath in muted text.
4. **Improvement prompt** — read-only block, the meta-prompt template with placeholders unsubstituted. Always visible (matches the "see the prompt" principle).
5. **[Improve mapping prompt]** button.
   - Disabled when the disagreement count is zero. Tooltip: *"Click an action that differs from the suggestion to record a disagreement first."*
   - Disabled while a classify run is in progress.
   - Disabled while a previous Improve is still running.
   - During Improve: label changes to *Improving…*.

The options page rules textarea remains as a mirror of the same setting; either surface can edit.

## Data model

### New storage keys

Added to `extension/background/storage.js`:

| Key | Area | Shape | Purpose |
|---|---|---|---|
| `DISAGREEMENTS` | `local` | `[{ emailId, predictedAction, chosenAction, from, subject, snippet, ts }]` | Append-only list. Cleared on successful Improve. |
| `IMPROVING` | `session` | `{ improving: bool, ts }` | UI state during Improve call. |
| `IMPROVE_ERROR` | `session` | `{ kind, message, hint? }` | Last Improve failure (parse, validation, CORS, model-missing, timeout). Cleared on next attempt. |

`settings.rules` is reused for the editable rules — no schema change.

### Cap

`MAX_DISAGREEMENTS = 50`, defined alongside `ACTIONS` in `lib/schema.js`. When a 51st disagreement is appended, the oldest is dropped silently. This bounds the meta-prompt payload so it doesn't exceed the model's context window.

### Concurrency

Reuses the existing `withSuggestionsLock` pattern: a new `withDisagreementsLock` serialises append/clear so concurrent disagreement writes (e.g. from rapid clicks) don't lose entries.

### Message types

`extension/lib/messages.js` gets one new entry: `IMPROVE_PROMPT`.

`APPLY_ONE` payload changes from `{type, emailId}` to `{type, emailId, chosenAction}`. The service worker reads the stored suggestion to get `predictedAction`, compares, and records a disagreement if they differ.

### Side panel storage subscription

`hydrateFromStorage` and `chrome.storage.onChanged` are extended to watch `KEYS.DISAGREEMENTS`, `KEYS.IMPROVING`, `KEYS.IMPROVE_ERROR`. The bottom panel re-renders count, list, button state, and error toasts from these.

## Improve pipeline

### Files

- **New:** `extension/background/improve.js` — meta-prompt builder, response validator, end-to-end Improve call.
- **Modified:** `extension/background/pipeline.js` — adds `improvePrompt()` orchestrator.
- **Modified:** `extension/background/background.js` — registers the `IMPROVE_PROMPT` handler.
- **Modified:** `extension/lib/messages.js` — adds `IMPROVE_PROMPT`.
- **Modified:** `extension/lib/schema.js` — adds `META_PROMPT` constant and `MAX_DISAGREEMENTS`.

### Meta-prompt template

Stored as `META_PROMPT` in `lib/schema.js`. Rendered with substitutions for the three placeholders:

```
You are tuning an email-classification ruleset.

The classifier picks one of these actions for each email:
{ACTION_LIST}

Current rules (free text the classifier reads to decide):
---
{CURRENT_RULES}
---

The user reviewed the classifier's predictions and disagreed with these:
{DISAGREEMENTS_BLOCK}

Each disagreement shows: From / Subject / Snippet, the action the classifier chose,
and the action the user actually wanted.

Rewrite the rules so that the classifier would have picked the user's chosen action
for each disagreement, while preserving the spirit of the existing rules for cases
not in the list.

Constraints:
- Use only the action names listed above. Do NOT invent new actions.
- Keep the rules concise — short bullet points or one-line statements.
- Do not include preamble, explanation, or commentary. Output only the new rules text.

Respond with JSON: {"rules": "<the new rules text>"}.
```

The disagreement block is one entry per item:

```
- From: <from> | Subject: <subject>
  Snippet: <snippet up to 200 chars>
  Predicted: <predictedAction>  →  Chosen: <chosenAction>
```

### Validation of the LLM response

In `improve.js`, after `chat()` returns:

1. Parse JSON. Failure → `IMPROVE_ERROR = {kind: "parse"}`.
2. `rules` field must be a non-empty trimmed string. Failure → `{kind: "empty"}`.
3. The new rules must mention at least one action name from `ACTIONS` (case-sensitive substring match). Failure → `{kind: "no-action"}`. This is a soft sanity check that catches generic-advice responses.
4. Length ≤ 4000 characters. Failure → `{kind: "too-long"}`.

On any failure: write `IMPROVE_ERROR`, leave `settings.rules` untouched, leave `DISAGREEMENTS` untouched. The user can retry without losing data.

### Orchestration (`pipeline.improvePrompt`)

```
1. If session.IMPROVING.improving === true → return {ok: false, kind: "busy"}.
2. If session.classifyProgress.classifying === true → return {ok: false, kind: "busy"}.
3. Set session.IMPROVING = {improving: true, ts: now}.
4. Read settings.rules and local.DISAGREEMENTS.
5. Build meta-prompt → call ollama.chat() with format: "json".
6. Validate response.
7a. On failure → write session.IMPROVE_ERROR, set session.IMPROVING = {improving: false}, return {ok: false, error}.
7b. On success →
       - settings.rules = newRules
       - local.DISAGREEMENTS = []
       - session.IMPROVE_ERROR = null
       - session.IMPROVING = {improving: false}
       - call existing pipeline.classifyInbox()  // re-classify with new rules
       - return {ok: true}.
```

The same Ollama model from settings is used. Errors from `ollama.chat()` (CORS, timeout, model-missing) propagate through `OllamaError` and become `IMPROVE_ERROR` entries with the matching `kind`.

The `kind:"busy"` return at steps 1–2 is **not** persisted to `IMPROVE_ERROR` — busy is a transient, recoverable state and the UI already reflects it via the existing `classifyProgress` and `IMPROVING` flags. The synchronous return is for the side-panel `sendMessage` round-trip only.

## Edge cases

| Case | Handling |
|---|---|
| User clicks chosen-action while classify is running | Disagreement recorded normally. The suggestion may be replaced by a re-classification; the disagreement record is independent. |
| User clicks Improve while classify is running | Returns `{ok:false, kind:"busy"}`; UI also disables the button when `classifying` flag is set. |
| Ollama times out / CORS fails during Improve | Same `OllamaError` types as classify; surfaced via `IMPROVE_ERROR`. UI shows the same banner pattern as the classify-time CORS error, titled per `kind`. |
| Validation fails (parse / empty / no-action / too-long) | `IMPROVE_ERROR` with the `kind`; rules and disagreements unchanged; user retries. |
| Buffer cap (50) reached | Oldest disagreement dropped silently when the 51st is appended. The count badge keeps showing the current size. |
| User edits rules manually while disagreements pending | Allowed. Disagreements stay. Next Improve uses the manually-edited rules as input. |
| Improve produces worse rules | No automatic detection. User edits manually or accumulates new disagreements and re-Improves. (No rollback per the overwrite policy.) |
| Existing user with no captured disagreements | Disagreement list starts empty. No migration. |
| `chosenAction` not in `ACTIONS` | Worker rejects the message with an error; row stays. Defensive — should never happen since the side panel only renders the seven valid buttons. |

## Testing

Matches existing test conventions in `extension/tests/` (Node test runner with `chrome-shim.js`).

- **`tests/improve.test.js`** — pure unit tests for `improve.js`:
  - `buildMetaPrompt({rules, disagreements})` returns the expected text.
  - `parseImproveResponse({"rules": "..."})` returns `{ok: true, rules: "..."}`.
  - Empty rules / missing field → error with `kind`.
  - No action name mention → error.
  - Length > 4000 → error.

- **`tests/disagreement-capture.test.js`** — service-worker handler:
  - `APPLY_ONE` with `chosenAction === predictedAction` → no disagreement appended.
  - `APPLY_ONE` with different `chosenAction` → disagreement appended with `{from, subject, snippet}` from `KEYS.INBOX`.
  - 51st append evicts the oldest entry.

- **`tests/improve-pipeline.test.js`** — end-to-end with mocked `chat()`:
  - Successful Improve writes new rules, clears disagreements, calls `classifyInbox`.
  - Validation failure leaves rules + disagreements untouched and writes `IMPROVE_ERROR`.
  - Busy guard: improve while classifying returns `{ok:false, kind:"busy"}`.

- **Side-panel tests** — extend the existing pattern in `tests/sidepanel-pill.test.js`:
  - Renders all 7 action buttons per row; predicted has the highlighted style.
  - Click predicted → sends `APPLY_ONE` with `chosenAction === predictedAction`.
  - Click non-predicted → sends `APPLY_ONE` with the chosen action.
  - Bottom panel: count badge updates when `KEYS.DISAGREEMENTS` changes.
  - Improve button disabled at zero disagreements; tooltip text correct.

## Risks

| Risk | Mitigation |
|---|---|
| Small models write incoherent rules | Validation gates (action-name mention, length cap). On failure, rules unchanged. User can retry or edit manually. |
| Re-classification floods the model with 50 calls | Existing classify pipeline already handles this with concurrency limits and progress UI. No new cost. |
| Disagreement list contains stale snippets after Improve+reclassify | List is cleared on successful Improve, so this is a non-issue in the happy path. |
| User opens side panel mid-Improve and clicks Improve again | Busy guard returns `{kind:"busy"}`; button is disabled in UI as soon as `IMPROVING` flips. |
| Privacy: snippets are stored in chrome.storage.local | Already the case for `KEYS.INBOX` and `KEYS.SUGGESTIONS`. No new privacy surface — Improve doesn't send anything to a remote service; the meta-prompt goes to the local Ollama instance just like classification. |

## Build order (sketch — full plan deferred to writing-plans)

1. Schema additions: `MAX_DISAGREEMENTS`, `META_PROMPT` constant.
2. Storage helpers: `KEYS.DISAGREEMENTS`, `KEYS.IMPROVING`, `KEYS.IMPROVE_ERROR`, `withDisagreementsLock`, append/clear/cap.
3. `APPLY_ONE` payload change + worker-side disagreement capture.
4. Side-panel email row redesign: 7-button per-row layout with predicted highlight.
5. `improve.js`: meta-prompt builder + response validator.
6. `pipeline.improvePrompt` orchestrator + `MSG.IMPROVE_PROMPT` handler.
7. Side-panel bottom section: read-only prompt block, editable rules + Save, disagreement list, read-only meta-prompt, Improve button.
8. Storage subscription in side panel for the new keys.
9. Error banner / toast wiring for `IMPROVE_ERROR`.
10. Tests for each unit, end-to-end, and side-panel rendering.
