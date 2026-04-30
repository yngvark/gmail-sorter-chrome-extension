# Gmail Sorter — Multi-variant Star Support

**Date:** 2026-04-29
**Status:** Approved for implementation planning
**Scope:** Add three star variants (yellow, red, red bang) to the action taxonomy, replacing the single `Star` action.

## Purpose

Today the classifier emits a single `"Star"` action that maps to Gmail's system `STARRED` label — i.e. the default yellow star. The user runs Multiple Inboxes with star-based panes (yellow, red, red bang) below the main inbox and uses each variant for a different priority level. The current taxonomy can't drive that workflow.

This change replaces `"Star"` with three variant-specific actions tied to Gmail's superstar label IDs (`^ss_sy`, `^ss_sr`, `^ss_cr`).

## Non-goals

- Other Gmail superstar variants (orange, green, blue, purple, question mark, info) are out of scope. The user uses three; we expose three.
- No options-page UI for picking which variants are enabled. The taxonomy is hard-coded; if more variants are needed later, add them by extending `ACTIONS` and the `actionToLabelDiff` switch.
- No automated migration of the user's custom rules text. If the user has overridden the default rules, they update them by hand.
- No fallback path is implemented yet. If the verification probe fails for the user's account, this design is halted and a separate design (custom labels with color badges) is opened. We do not pre-build the fallback.

## Semantics

The user's intended mapping (driven by their workflow):

| Variant | Label ID | Meaning |
|---|---|---|
| Yellow | `^ss_sy` | Generic important / personal mail from a real person |
| Red | `^ss_sr` | Needs a reply or action soon |
| Red bang | `^ss_cr` | Urgent — needs attention today |

All three actions also remove `INBOX` (i.e. archive). The user's Multiple Inboxes setup keeps starred messages visible in the corresponding star pane below the main inbox, so star-and-archive does not hide the message — it routes it to the right pane.

## Action taxonomy

`extension/lib/schema.js`:

```js
export const ACTIONS = Object.freeze([
  "Star: Yellow",
  "Star: Red",
  "Star: Red bang",
  "Archive",
  "Mark read",
  "Move: Follow-up",
  "Leave alone",
]);
```

`"Star"` is removed entirely (no alias). The classifier must commit to a specific variant. Plain `"Star"` falls into the existing `unmapped` branch in `actionToLabelDiff`, which surfaces as a diagnostic — a regression guard against silent re-introduction.

`DEFAULT_RULES` is rewritten:

```
Personal, human messages from a real person to me → Star: Yellow.
Things I need to reply to or act on soon → Star: Red.
Urgent — needs my attention today → Star: Red bang.
Receipts, order confirmations, newsletters, promotional mail → Archive.
Security alerts or notifications that don't need action → Mark read.
Colleagues or teammates asking for something from me (a review, a reply, a meeting) → Move: Follow-up.
Automated reminders about events that already exist in my calendar → Leave alone.
When genuinely unsure → Leave alone.
```

## Action → Gmail diff

`extension/background/classify.js`, in `actionToLabelDiff`:

| Action | `add` | `remove` |
|---|---|---|
| `Star: Yellow` | `["^ss_sy"]` | `["INBOX"]` |
| `Star: Red` | `["^ss_sr"]` | `["INBOX"]` |
| `Star: Red bang` | `["^ss_cr"]` | `["INBOX"]` |
| `Archive` | `[]` | `["INBOX"]` (unchanged) |
| `Mark read` | `[]` | `["UNREAD"]` (unchanged) |
| `Move: Follow-up` | `[followUpLabelId]` | `["INBOX"]` (unchanged) |
| `Leave alone` | `[]` | `[]` (unchanged) |

Note: today's `Star` action also adds `STARRED`. The new three variants do *not* add `STARRED` — only the variant superstar ID. Gmail's UI shows the variant glyph regardless; `STARRED` would just be redundant. (To be confirmed by the verification probe; if Gmail strips superstar IDs unless `STARRED` is also present, the implementation adds `STARRED` to the `add` array. This is a single-line fix discovered at probe time.)

## Side-panel rendering

`extension/sidepanel/sidepanel.js` and `extension/sidepanel/sidepanel.css`.

The pill is a `<button class="action-pill" data-action="…">` (`sidepanel.html:83`). The existing CSS already styles pills per action via attribute selectors (e.g. `.action-pill[data-action="Star"] { border-color: var(--gold); … }` at `sidepanel.css:494`). The new variants extend this pattern:

| Action | Border / hover color | Pill glyph (prefixes the text) |
|---|---|---|
| `Star: Yellow` | `var(--gold)` (existing yellow) | ★ |
| `Star: Red` | new red token (`--star-red`, e.g. `#d93025`) | ★ |
| `Star: Red bang` | same red token | ❗ |

The old `[data-action="Star"]` rule is removed.

Glyph rendering: in `sidepanel.js`, the pill update path (currently `pill.textContent = sugg.action` at line 186) is replaced with a tiny helper that prefixes the glyph for star actions:

```js
function actionPillContent(action) {
  if (action === "Star: Yellow")   return "★ Star: Yellow";
  if (action === "Star: Red")      return "★ Star: Red";
  if (action === "Star: Red bang") return "❗ Star: Red bang";
  return action;
}
```

`textContent` assignment is preserved — the glyph lives inside the same string, no extra DOM nodes, no escaping concerns. The `data-action` attribute drives border color via CSS as today.

Placeholder data in `sidepanel.js` (`PLACEHOLDER_SUGGESTIONS` at line 26+ and the secondary list around line 410+) is updated to use `Star: Red` for the personal-mail row to exercise the new rendering when the panel is opened standalone.

## Verification probe

Verification is one-time, manual, run by the user via the dev tools panel after install.

`extension/background/gmail.js` gets a new helper alongside `probeSuperstar`:

```js
export async function probeAllSuperstars(token, messageId) {
  const variants = ["yellow", "red", "redBang"];
  const out = {};
  for (const v of variants) {
    out[v] = await probeSuperstar(token, messageId, v);
  }
  return out;
}
```

Each underlying `probeSuperstar` call is non-destructive (adds, reads back, removes). Three sequential round-trips against one message — no side effects on success.

`extension/background/pipeline.js` `probeSuperstar` is replaced by `probeAllSuperstars`, which picks the first inbox row from storage and calls the gmail helper.

Side panel dev tools: the existing `dev-superstar-btn` is re-wired to call `probeAllSuperstars` and render results into `#dev-result` as a small table:

```
yellow:    writable ✓
red:       writable ✓
red bang:  writable ✓
```

If any row shows ✗, the user halts and reports — implementation does not silently degrade. (This design becomes invalid; a separate custom-labels-with-color design replaces it.)

## Migration

Two storage surfaces hold action strings.

**`KEYS.suggestions`** — emailId → suggestion. Pre-existing entries with `action: "Star"` would be ambiguous (the user did not pick a variant). On side-panel load, the renderer filters out any suggestion whose action is not in the current `ACTIONS` list. The next classify run re-populates with new variants. No auto-mapping.

**User's custom `rules` text in settings** — if the user has edited the default, it may still mention "Star". Not auto-edited. The default `DEFAULT_RULES` constant is updated; users on default rules pick up the new wording on next read. Users on custom rules update by hand.

## Testing

### Unit (Node, existing pattern in `extension/tests/`)

- `classify.test.js` — assert each new action maps to the correct label diff (`{add, remove}`). One test per variant. One regression test that plain `"Star"` lands in the `unmapped` branch.
- `apply.test.js` — end-to-end: a suggestion with `action: "Star: Red"` calls `messages.modify` with `addLabelIds: ["^ss_sr"]` and `removeLabelIds: ["INBOX"]`.
- `superstar.test.js` — new test for `probeAllSuperstars`: stubs three round-trips, asserts result shape `{ yellow, red, redBang }`, asserts cleanup-removes are issued for each variant.
- `classify-inbox.test.js` — if it asserts the prompt's action list, update to the new seven entries.
- New test for `actionPillContent` helper: three star inputs return prefixed strings; non-star inputs return the action verbatim.

### E2E user-story corpus (`tests-e2e/`)

The implementation plan inspects existing stories. Stories that referenced the old `Star` action are updated to use a specific variant (likely `Star: Red`, the most common user choice). One new story is added: "the side panel renders different glyphs for the three star variants". If the corpus has no relevant story to update, only the new one is added.

### Manual verification (one-time, post-implementation)

1. Reload extension.
2. Open side panel with `?dev=1`.
3. Click "Superstar probe (all)" → confirm three ✓ in `#dev-result`.
4. Classify a small inbox.
5. Confirm pills render with the right glyph and color for each star variant.
6. Apply one suggestion of each variant; confirm in Gmail UI:
   - The right star type appears on the message.
   - The message moves out of the main inbox into the corresponding star pane.

If step 3 fails for any variant, halt and reopen the design.

## Files touched

| File | Change |
|---|---|
| `extension/lib/schema.js` | New `ACTIONS` list, new `DEFAULT_RULES` text |
| `extension/background/classify.js` | Three new cases in `actionToLabelDiff`, removal of plain `"Star"` case |
| `extension/background/gmail.js` | New `probeAllSuperstars` helper |
| `extension/background/pipeline.js` | Replace `probeSuperstar` export with `probeAllSuperstars` |
| `extension/sidepanel/sidepanel.js` | Pill glyph rendering, `actionDecoration` helper, updated placeholder data, dev button re-wired |
| `extension/sidepanel/sidepanel.css` | Pill glyph styles |
| `extension/tests/classify.test.js` | Variant mapping tests + regression for plain `"Star"` |
| `extension/tests/apply.test.js` | End-to-end variant apply test |
| `extension/tests/superstar.test.js` | `probeAllSuperstars` test |
| `extension/tests/classify-inbox.test.js` | Prompt action-list assertion (if present) |
| `extension/tests/sidepanel-pill.test.js` (new) | `actionPillContent` helper test |
| `tests-e2e/user-stories.spec.ts` | Update star stories, add glyph story |
| `extension/README.md` | Update action vocabulary section if it lists actions |

## Build order

1. Schema + classify mapping changes. Tests prove the diff is right.
2. Probe helper + dev button rewire. Manual probe run; halt if any ✗.
3. Side-panel glyph rendering + placeholder data update.
4. Apply-path test confirms end-to-end.
5. E2E story updates.
6. Manual verification flow on a real inbox.
