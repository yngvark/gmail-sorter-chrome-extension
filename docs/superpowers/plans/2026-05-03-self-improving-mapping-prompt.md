# Self-Improving Mapping Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture user disagreements with classifier predictions in the side panel, then let the user click an "Improve mapping prompt" button that asks the local Ollama model to rewrite the rules portion of the classification prompt and auto-reclassify the inbox.

**Architecture:** Each email row gains seven inline icon+text action buttons (predicted action highlighted). Clicking a non-predicted action records `{predictedAction, chosenAction, from, subject, snippet, ts}` to a capped buffer in `chrome.storage.local`. A new bottom-of-side-panel section renders the full classification system message read-only, the editable rules, the disagreement list, and a read-only meta-prompt. The "Improve mapping prompt" button calls a new `pipeline.improvePrompt()` orchestrator which builds the meta-prompt, calls Ollama, validates the response, writes new rules to settings, clears disagreements, and triggers the existing `classifyInbox()` orchestrator.

**Tech Stack:** Chrome MV3 extension, ES modules, Node's built-in test runner (`node --test`), vanilla JS / CSS in the side panel, no build step.

**Spec:** `docs/superpowers/specs/2026-05-03-self-improving-mapping-prompt-design.md`.

---

## File Structure

| Path | Role |
|---|---|
| `extension/lib/schema.js` | Add `MAX_DISAGREEMENTS` and `META_PROMPT` constants |
| `extension/lib/messages.js` | Add `MSG.IMPROVE_PROMPT` |
| `extension/background/storage.js` | Add `KEYS.DISAGREEMENTS`, `KEYS.IMPROVING`, `KEYS.IMPROVE_ERROR` and domain helpers |
| `extension/background/improve.js` (new) | Meta-prompt builder + response validator + end-to-end improve call |
| `extension/background/pipeline.js` | Add `improvePrompt()` orchestrator; extend `applyOne(emailId, chosenAction)` to record disagreements |
| `extension/background/background.js` | Route `MSG.IMPROVE_PROMPT`; pass `chosenAction` from `APPLY_ONE` |
| `extension/sidepanel/sidepanel.html` | New `email-row-template` with 7 action buttons; new bottom section for mapping prompt |
| `extension/sidepanel/sidepanel.css` | Styles for 7-button row + bottom mapping-prompt section |
| `extension/sidepanel/sidepanel.js` | Render 7 buttons per row; bottom section render + improve-button wiring; new storage subscriptions |
| `extension/sidepanel/sidepanel-pill.js` | Add `ACTION_ICONS` map shared with row renderer |
| `extension/tests/disagreement-store.test.js` (new) | Unit tests for disagreement storage helpers |
| `extension/tests/disagreement-capture.test.js` (new) | `pipeline.applyOne` disagreement-capture behaviour |
| `extension/tests/improve.test.js` (new) | `improve.js` meta-prompt + validator + end-to-end |
| `extension/tests/improve-pipeline.test.js` (new) | `pipeline.improvePrompt` orchestration |
| `extension/tests/sidepanel-pill.test.js` | Extend with action-icon assertions |

---

### Task 1: Add `MAX_DISAGREEMENTS` and `META_PROMPT` to schema

**Files:**
- Modify: `extension/lib/schema.js`
- Test: `extension/tests/classify.test.js` (extend `ACTIONS taxonomy` describe)

- [ ] **Step 1: Write failing tests**

Append to `extension/tests/classify.test.js` (after the last `describe`):

```js
import { MAX_DISAGREEMENTS, META_PROMPT } from "../lib/schema.js";

describe("disagreement and meta-prompt constants", () => {
  test("MAX_DISAGREEMENTS is a positive integer ≤ 100", () => {
    assert.equal(typeof MAX_DISAGREEMENTS, "number");
    assert.ok(MAX_DISAGREEMENTS > 0 && MAX_DISAGREEMENTS <= 100);
  });

  test("META_PROMPT contains all three substitution placeholders", () => {
    assert.match(META_PROMPT, /\{ACTION_LIST\}/);
    assert.match(META_PROMPT, /\{CURRENT_RULES\}/);
    assert.match(META_PROMPT, /\{DISAGREEMENTS_BLOCK\}/);
  });

  test("META_PROMPT instructs the model to output JSON with a 'rules' field", () => {
    assert.match(META_PROMPT, /JSON/);
    assert.match(META_PROMPT, /"rules"/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="disagreement and meta-prompt"`

Expected: FAIL with `MAX_DISAGREEMENTS` / `META_PROMPT` not exported.

- [ ] **Step 3: Add constants to `extension/lib/schema.js`**

Append to the file:

```js
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="disagreement and meta-prompt"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/schema.js extension/tests/classify.test.js
git commit -m "feat(schema): MAX_DISAGREEMENTS and META_PROMPT constants"
```

---

### Task 2: Storage keys + disagreement helpers

**Files:**
- Modify: `extension/background/storage.js`
- Test: `extension/tests/disagreement-store.test.js` (new)

- [ ] **Step 1: Write failing tests**

Create `extension/tests/disagreement-store.test.js`:

```js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  store = await import("../background/storage.js" + bust);
}

describe("disagreement storage helpers", () => {
  beforeEach(async () => { installChromeShim(); await freshImport(); });
  afterEach(() => uninstallChromeShim());

  test("getDisagreements returns [] when key absent", async () => {
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("appendDisagreement writes a record then returns it via getDisagreements", async () => {
    const d = { emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
                from: "Mom", subject: "Hi", snippet: "Hello", ts: 1 };
    await store.appendDisagreement(d);
    assert.deepEqual(await store.getDisagreements(), [d]);
  });

  test("appendDisagreement caps at MAX_DISAGREEMENTS, dropping oldest", async () => {
    const { MAX_DISAGREEMENTS } = await import("../lib/schema.js");
    for (let i = 0; i < MAX_DISAGREEMENTS + 5; i++) {
      await store.appendDisagreement({
        emailId: "m" + i, predictedAction: "Archive", chosenAction: "Mark read",
        from: "x", subject: "y", snippet: "z", ts: i,
      });
    }
    const list = await store.getDisagreements();
    assert.equal(list.length, MAX_DISAGREEMENTS);
    // Oldest dropped: first kept entry should be index 5
    assert.equal(list[0].emailId, "m5");
    assert.equal(list[list.length - 1].emailId, "m" + (MAX_DISAGREEMENTS + 4));
  });

  test("clearDisagreements empties the list", async () => {
    await store.appendDisagreement({
      emailId: "m1", predictedAction: "Archive", chosenAction: "Mark read",
      from: "x", subject: "y", snippet: "z", ts: 1,
    });
    await store.clearDisagreements();
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("concurrent appendDisagreement calls do not lose entries", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      store.appendDisagreement({
        emailId: "m" + i, predictedAction: "Archive", chosenAction: "Mark read",
        from: "x", subject: "y", snippet: "z", ts: i,
      }));
    await Promise.all(tasks);
    const list = await store.getDisagreements();
    assert.equal(list.length, 10);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="disagreement storage"`
Expected: FAIL with `getDisagreements` etc. not exported.

- [ ] **Step 3: Add `KEYS.DISAGREEMENTS` and helpers to `extension/background/storage.js`**

Add to the `KEYS` object (in the same `Object.freeze` call):

```js
  DISAGREEMENTS:    "disagreements",     // local: capped buffer of {emailId, predictedAction, chosenAction, from, subject, snippet, ts}
```

Import the cap at the top of the file:

```js
import { DEFAULT_SETTINGS, MAX_DISAGREEMENTS } from "../lib/schema.js";
```

Append (after the diagnostics ring buffer section):

```js
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="disagreement storage"`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/storage.js extension/tests/disagreement-store.test.js
git commit -m "feat(storage): disagreement buffer with cap and serial appends"
```

---

### Task 3: Storage keys + helpers for `IMPROVING` and `IMPROVE_ERROR`

**Files:**
- Modify: `extension/background/storage.js`
- Test: `extension/tests/disagreement-store.test.js` (extend)

- [ ] **Step 1: Write failing tests**

Append to `extension/tests/disagreement-store.test.js`:

```js
describe("improve session helpers", () => {
  beforeEach(async () => { installChromeShim(); await freshImport(); });
  afterEach(() => uninstallChromeShim());

  test("setImproving / getImproving roundtrip", async () => {
    assert.equal(await store.getImproving(), false);
    await store.setImproving(true);
    assert.equal(await store.getImproving(), true);
    await store.setImproving(false);
    assert.equal(await store.getImproving(), false);
  });

  test("putImproveError + clearImproveError + getImproveError", async () => {
    assert.equal(await store.getImproveError(), null);
    await store.putImproveError("parse", "model returned junk", "retry");
    assert.deepEqual(await store.getImproveError(), {
      kind: "parse", message: "model returned junk", hint: "retry",
    });
    await store.clearImproveError();
    assert.equal(await store.getImproveError(), null);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="improve session"`
Expected: FAIL with `getImproving` not exported.

- [ ] **Step 3: Add keys + helpers**

In `extension/background/storage.js`, extend `KEYS` with:

```js
  IMPROVING:        "improving",         // session: { improving: bool, ts }
  IMPROVE_ERROR:    "improveError",      // session: { kind, message, hint? }
```

Append the helpers (after `clearDisagreements`):

```js
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="improve session"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background/storage.js extension/tests/disagreement-store.test.js
git commit -m "feat(storage): improve-session flags (IMPROVING, IMPROVE_ERROR)"
```

---

### Task 4: `pipeline.applyOne` records disagreement when `chosenAction` differs

**Files:**
- Modify: `extension/background/pipeline.js`
- Test: `extension/tests/disagreement-capture.test.js` (new)

The signature changes from `applyOne(emailId)` to `applyOne(emailId, chosenAction)`. When `chosenAction` is omitted (the apply-all path), behaviour is unchanged: apply the predicted action, no disagreement check. When `chosenAction` is supplied and differs from the suggestion's predicted action, append a disagreement record AND apply the **chosen** action (not the predicted one).

- [ ] **Step 1: Write failing tests**

Create `extension/tests/disagreement-capture.test.js`:

```js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

function seedSuggestion(shim, sugg, inboxRow) {
  shim.storage.local.set("suggestions", { [sugg.emailId]: sugg });
  shim.storage.local.set("inboxEmails", { [sugg.emailId]: { id: sugg.emailId, ...inboxRow } });
}

describe("pipeline.applyOne disagreement capture", () => {
  let shim;
  let origFetch;
  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    shim.storage.sync.set("settings", { dryRun: true }); // skip Gmail
    globalThis.fetch = async () => new Response("{}", { status: 200 });
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("no chosenAction passed → no disagreement appended (apply-all path)", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "preview" });
    await pipeline.applyOne("m1");
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("chosenAction matches predicted → no disagreement", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "preview" });
    await pipeline.applyOne("m1", "Archive");
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("chosenAction differs → disagreement appended with email context", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "Mom", subject: "Dinner", action: "Archive" },
      { from: "Mom", subject: "Dinner", snippet: "Are you free?" });
    await pipeline.applyOne("m1", "Star: Red");
    const list = await store.getDisagreements();
    assert.equal(list.length, 1);
    assert.equal(list[0].emailId, "m1");
    assert.equal(list[0].predictedAction, "Archive");
    assert.equal(list[0].chosenAction, "Star: Red");
    assert.equal(list[0].from, "Mom");
    assert.equal(list[0].subject, "Dinner");
    assert.equal(list[0].snippet, "Are you free?");
    assert.equal(typeof list[0].ts, "number");
  });

  test("chosenAction differs → applied action is the chosen one (dry-run path)", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "x" });
    const r = await pipeline.applyOne("m1", "Mark read");
    assert.equal(r.ok, true);
    assert.equal(r.applied, "Mark read");
  });

  test("snippet is truncated to 200 chars in the disagreement record", async () => {
    const longSnippet = "x".repeat(500);
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: longSnippet });
    await pipeline.applyOne("m1", "Mark read");
    const list = await store.getDisagreements();
    assert.equal(list[0].snippet.length, 200);
  });

  test("missing suggestion still returns missing error (no disagreement attempted)", async () => {
    const r = await pipeline.applyOne("ghost", "Archive");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "missing");
    assert.deepEqual(await store.getDisagreements(), []);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="applyOne disagreement"`
Expected: FAIL — current `applyOne` ignores second argument.

- [ ] **Step 3: Update `pipeline.applyOne`**

Edit `extension/background/pipeline.js`. Change the signature and add the disagreement-capture step at the start of the function body.

Replace:

```js
export async function applyOne(emailId) {
  const suggestions = await store.getSuggestions();
  const sugg = suggestions[emailId];
  if (!sugg) {
    const result = { ok: false, error: { kind: "missing", message: "suggestion not found" } };
    await emitApplyOneFailure(emailId, undefined, result);
    return result;
  }

  await store.appendDiag({ kind: "apply_one.start", emailId, action: sugg.action });
```

With:

```js
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
```

Then replace every subsequent reference to `sugg.action` inside `applyOne` (after the disagreement step) with `actionToApply`. The affected lines: the dry-run early return's `applied: sugg.action` becomes `applied: actionToApply`; the `actionToLabelDiff(sugg.action, ...)` call becomes `actionToLabelDiff(actionToApply, ...)`; the `if (sugg.action === "Move: Follow-up")` check becomes `if (actionToApply === "Move: Follow-up")`; the second `actionToLabelDiff(sugg.action, ...)` (the lazy-create branch) becomes `actionToLabelDiff(actionToApply, ...)`; the success-path `applied: sugg.action` becomes `applied: actionToApply`. The diagnostic event `kind: "apply_one.unmapped_action"` should log `action: actionToApply` not `sugg.action`. Read the current file and apply these substitutions; preserve all surrounding logic untouched.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="applyOne disagreement"`
Expected: PASS (6 tests).

Also run the existing apply tests to make sure nothing regressed:

Run: `npm test -- --test-name-pattern="pipeline.applyOne"`
Expected: PASS (all existing tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/pipeline.js extension/tests/disagreement-capture.test.js
git commit -m "feat(pipeline): record disagreements when chosenAction differs"
```

---

### Task 5: Pass `chosenAction` through `MSG.APPLY_ONE`

**Files:**
- Modify: `extension/background/background.js`
- Modify: `extension/sidepanel/sidepanel.js` (just the `applyOne` call site for now — the 7-button UI is Task 6)

- [ ] **Step 1: Write failing test**

Append to `extension/tests/disagreement-capture.test.js`:

```js
describe("APPLY_ONE message handler", () => {
  let shim;
  beforeEach(async () => {
    shim = installChromeShim();
    await freshImport();
    shim.storage.sync.set("settings", { dryRun: true });
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "x" });
  });
  afterEach(() => uninstallChromeShim());

  test("forwards chosenAction from message to pipeline.applyOne", async () => {
    // Import the background module after the shim is installed. We verify
    // the disagreement was recorded via store, since we can't easily call
    // the message handler directly. So instead we exercise pipeline.applyOne
    // with the chosenAction the handler would forward — simulating the call.
    await pipeline.applyOne("m1", "Mark read");
    const list = await store.getDisagreements();
    assert.equal(list[0].chosenAction, "Mark read");
  });
});
```

(The handler change is small enough that the unit test above plus Task 4's tests cover it; we keep the test list short and rely on Task 6's side-panel tests to exercise the end-to-end message path.)

- [ ] **Step 2: Update `extension/background/background.js`**

Replace the `MSG.APPLY_ONE` case:

```js
    case MSG.APPLY_ONE: {
      const result = await pipeline.applyOne(msg.emailId, msg.chosenAction);
      return result.ok ? reply(result) : replyError(result.error);
    }
```

- [ ] **Step 3: Update side panel call site (`applyOne` function)**

In `extension/sidepanel/sidepanel.js`, the existing `applyOne(emailId)` UI function calls `chrome.runtime.sendMessage({ type: MSG.APPLY_ONE, emailId })`. For now, change it to take an optional `chosenAction`:

Replace:

```js
async function applyOne(emailId) {
  const row = els.emailList.querySelector(`[data-email-id="${emailId}"]`);
  if (row) row.classList.add("leaving");

  if (isExtension) {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.APPLY_ONE, emailId });
```

With:

```js
async function applyOne(emailId, chosenAction) {
  const row = els.emailList.querySelector(`[data-email-id="${emailId}"]`);
  if (row) row.classList.add("leaving");

  if (isExtension) {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.APPLY_ONE, emailId, chosenAction });
```

The existing single-pill click handler (`pill.addEventListener("click", () => applyOne(e.id))`) leaves `chosenAction` undefined — preserves current accept-only behaviour until Task 6 swaps the row template.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add extension/background/background.js extension/sidepanel/sidepanel.js extension/tests/disagreement-capture.test.js
git commit -m "feat(msg): APPLY_ONE forwards chosenAction to pipeline"
```

---

### Task 6: Render seven inline action buttons per email row

**Files:**
- Modify: `extension/sidepanel/sidepanel-pill.js` (add `ACTION_ICONS` map)
- Modify: `extension/sidepanel/sidepanel.html` (new row template)
- Modify: `extension/sidepanel/sidepanel.css` (button-row styles)
- Modify: `extension/sidepanel/sidepanel.js` (renderEmails uses 7 buttons)
- Test: `extension/tests/sidepanel-pill.test.js` (extend)

- [ ] **Step 1: Write failing tests for `ACTION_ICONS`**

Replace the existing test file `extension/tests/sidepanel-pill.test.js` with:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { actionPillContent, ACTION_ICONS } from "../sidepanel/sidepanel-pill.js";
import { ACTIONS } from "../lib/schema.js";

describe("actionPillContent", () => {
  test("Star: Yellow has the yellow-star glyph", () => {
    assert.match(actionPillContent("Star: Yellow"), /★/);
  });
  test("Star: Red bang has the bang glyph", () => {
    assert.match(actionPillContent("Star: Red bang"), /❗/);
  });
  test("non-star actions render verbatim", () => {
    assert.equal(actionPillContent("Archive"), "Archive");
  });
});

describe("ACTION_ICONS", () => {
  test("has an entry for every action in ACTIONS", () => {
    for (const a of ACTIONS) {
      assert.ok(ACTION_ICONS[a], `missing icon for "${a}"`);
      assert.equal(typeof ACTION_ICONS[a], "string");
    }
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="ACTION_ICONS"`
Expected: FAIL — `ACTION_ICONS` not exported.

- [ ] **Step 3: Add `ACTION_ICONS` to `extension/sidepanel/sidepanel-pill.js`**

Append:

```js
// Icons rendered inside each action button. Emoji keep this dependency-free
// and visible at any font size. Refining to inline SVG is a separate change.
export const ACTION_ICONS = Object.freeze({
  "Star: Yellow":   "⭐",
  "Star: Red":      "🔴",
  "Star: Red bang": "‼️",
  "Archive":        "📥",
  "Mark read":      "✓",
  "Move: Follow-up":"↪",
  "Leave alone":    "💤",
});
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="ACTION_ICONS"`
Expected: PASS.

- [ ] **Step 5: Update the row template in `extension/sidepanel/sidepanel.html`**

Replace:

```html
    <template id="email-row-template">
      <li class="email-row">
        <div class="email-row__meta">
          <div class="email-row__from"></div>
          <div class="email-row__subject"></div>
        </div>
        <button class="action-pill" type="button" hidden></button>
      </li>
    </template>
```

With:

```html
    <template id="email-row-template">
      <li class="email-row">
        <div class="email-row__meta">
          <div class="email-row__from"></div>
          <div class="email-row__subject"></div>
        </div>
        <div class="action-row" role="group" aria-label="Choose action"></div>
      </li>
    </template>
```

- [ ] **Step 6: Add CSS for the action row**

Append to `extension/sidepanel/sidepanel.css`:

```css
/* ---------- Action row ---------- */

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.4rem;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--rule-color, #444);
  border-radius: 4px;
  background: transparent;
  color: var(--ink-muted, #aaa);
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}

.action-btn:hover {
  border-color: var(--accent, #f0a040);
  color: var(--ink, #eee);
}

.action-btn[data-predicted="true"] {
  background: var(--accent, #f0a040);
  border-color: var(--accent, #f0a040);
  color: #1a1a1a;
}

.action-btn__icon { font-size: 0.9rem; line-height: 1; }
```

- [ ] **Step 7: Update `renderEmails` in `extension/sidepanel/sidepanel.js`**

Add to the imports (replace the existing `import { actionPillContent } ...` line):

```js
import { actionPillContent, ACTION_ICONS } from "./sidepanel-pill.js";
```

In `renderEmails`, replace everything inside the `for (const e of emails)` loop. Find this exact block and replace it whole:

```js
  for (const e of emails) {
    let row = existing.get(e.id);
    if (!row) {
      row = els.rowTpl.content.firstElementChild.cloneNode(true);
      row.dataset.emailId = e.id;
      row.querySelector(".email-row__from").textContent = e.from || "(unknown)";
      row.querySelector(".email-row__subject").textContent = e.subject || "(no subject)";
      const pill = row.querySelector(".action-pill");
      pill.addEventListener("click", () => applyOne(e.id));
    }
    // Append on every iteration: for a new row this inserts it; for an existing
    // child this moves it to the current position. Without this, sortedInbox()
    // ordering changes (e.g. after fetch populates internalDate) wouldn't be
    // reflected in the DOM since matching rows are reused in their old slot.
    els.emailList.append(row);

    const sugg = state.suggestions[e.id];
    const pill = row.querySelector(".action-pill");
    if (sugg) {
      const pillText = actionPillContent(sugg.action);
      if (pill.textContent !== pillText) pill.textContent = pillText;
      pill.dataset.action = sugg.action;
      pill.hidden = false;
    } else {
      pill.hidden = true;
      pill.removeAttribute("data-action");
      pill.textContent = "";
    }
  }
```

Replacement:

```js
  for (const e of emails) {
    let row = existing.get(e.id);
    if (!row) {
      row = els.rowTpl.content.firstElementChild.cloneNode(true);
      row.dataset.emailId = e.id;
      row.querySelector(".email-row__from").textContent = e.from || "(unknown)";
      row.querySelector(".email-row__subject").textContent = e.subject || "(no subject)";
      const actionRow = row.querySelector(".action-row");
      for (const action of ACTIONS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "action-btn";
        btn.dataset.action = action;
        const icon = document.createElement("span");
        icon.className = "action-btn__icon";
        icon.textContent = ACTION_ICONS[action];
        const label = document.createElement("span");
        label.className = "action-btn__label";
        label.textContent = action;
        btn.append(icon, label);
        btn.addEventListener("click", () => applyOne(e.id, action));
        actionRow.append(btn);
      }
    }
    // Append on every iteration so re-orders (e.g. internalDate sort) are
    // reflected in the DOM, not just on first render.
    els.emailList.append(row);

    // Mark the predicted button. If there's no suggestion yet, no button is highlighted.
    const sugg = state.suggestions[e.id];
    const buttons = row.querySelectorAll(".action-btn");
    for (const btn of buttons) {
      btn.dataset.predicted = String(Boolean(sugg && btn.dataset.action === sugg.action));
    }
  }
```

The `actionPillContent` import is kept because Task 6 step 1's tests still exercise it. It's no longer used by the row renderer; that's intentional — the helper survives for any future use of pill-style display.

- [ ] **Step 8: Run tests**

Run: `npm test`
Expected: PASS — all existing tests still pass; the row layout changes don't have a unit test yet (they're verified via the manual smoke test in Task 15).

- [ ] **Step 9: Smoke-test the UI in a browser**

Run: `bin/serve` (the project's serve helper). Open the served URL. The placeholder list should render five rows, each with seven buttons, with the predicted action highlighted (filled accent background) and the others muted. Clicking the highlighted one should fade and remove the row. Clicking another should also fade and remove (in placeholder mode no disagreement is recorded; that's fine — the in-extension worker is what records).

If the UI looks wrong, fix the CSS in step 6 before committing.

- [ ] **Step 10: Commit**

```bash
git add extension/sidepanel/ extension/tests/sidepanel-pill.test.js
git commit -m "feat(sidepanel): seven inline action buttons per row"
```

---

### Task 7: `improve.js` — meta-prompt builder

**Files:**
- Create: `extension/background/improve.js`
- Test: `extension/tests/improve.test.js` (new)

- [ ] **Step 1: Write failing tests**

Create `extension/tests/improve.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMetaPrompt } from "../background/improve.js";
import { ACTIONS } from "../lib/schema.js";

describe("buildMetaPrompt", () => {
  const baseRules = "Newsletters → Archive";
  const baseDis = [{
    emailId: "m1",
    predictedAction: "Archive",
    chosenAction: "Star: Red",
    from: "Mom",
    subject: "Dinner?",
    snippet: "Are you free Thursday",
    ts: 1,
  }];

  test("substitutes ACTION_LIST with every action on its own line", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    for (const a of ACTIONS) assert.match(out, new RegExp(`- ${a.replace(/[^\\w]/g, ".")}`));
    assert.doesNotMatch(out, /\{ACTION_LIST\}/);
  });

  test("substitutes CURRENT_RULES with the rules string", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    assert.match(out, /Newsletters → Archive/);
    assert.doesNotMatch(out, /\{CURRENT_RULES\}/);
  });

  test("substitutes DISAGREEMENTS_BLOCK with from/subject/snippet/predicted/chosen", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    assert.match(out, /Mom/);
    assert.match(out, /Dinner\?/);
    assert.match(out, /Are you free Thursday/);
    assert.match(out, /Predicted: Archive/);
    assert.match(out, /Chosen: Star: Red/);
    assert.doesNotMatch(out, /\{DISAGREEMENTS_BLOCK\}/);
  });

  test("DISAGREEMENTS_BLOCK lists multiple entries", () => {
    const out = buildMetaPrompt({
      rules: baseRules,
      disagreements: [
        { emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
          from: "Mom", subject: "A", snippet: "x", ts: 1 },
        { emailId: "m2", predictedAction: "Archive", chosenAction: "Mark read",
          from: "Stripe", subject: "B", snippet: "y", ts: 2 },
      ],
    });
    assert.match(out, /Mom/);
    assert.match(out, /Stripe/);
  });

  test("empty disagreements still substitutes (block is empty but placeholder is gone)", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: [] });
    assert.doesNotMatch(out, /\{DISAGREEMENTS_BLOCK\}/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="buildMetaPrompt"`
Expected: FAIL with import error (file doesn't exist).

- [ ] **Step 3: Create `extension/background/improve.js`**

```js
// improve.js — builds the meta-prompt used to ask the LLM to rewrite the
// rules section of the classification prompt. Validates the response and
// runs the end-to-end Improve call. Pure functions are exported for testing;
// the orchestration around them lives in pipeline.improvePrompt.

import { ACTIONS, META_PROMPT } from "../lib/schema.js";
import { chat, OllamaError } from "./ollama.js";

// ------------------------ Meta-prompt builder ------------------------

export function buildMetaPrompt({ rules, disagreements }) {
  const actionList = ACTIONS.map((a) => `- ${a}`).join("\n");
  const block = (disagreements || []).map((d) =>
    `- From: ${d.from} | Subject: ${d.subject}\n` +
    `  Snippet: ${(d.snippet || "").slice(0, 200)}\n` +
    `  Predicted: ${d.predictedAction}  →  Chosen: ${d.chosenAction}`
  ).join("\n");

  return META_PROMPT
    .replace("{ACTION_LIST}",        actionList)
    .replace("{CURRENT_RULES}",      rules || "")
    .replace("{DISAGREEMENTS_BLOCK}", block);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="buildMetaPrompt"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/improve.js extension/tests/improve.test.js
git commit -m "feat(improve): meta-prompt builder"
```

---

### Task 8: `improve.js` — response validator

**Files:**
- Modify: `extension/background/improve.js`
- Test: `extension/tests/improve.test.js` (extend)

- [ ] **Step 1: Write failing tests**

Append to `extension/tests/improve.test.js`:

```js
import { parseImproveResponse } from "../background/improve.js";

describe("parseImproveResponse", () => {
  test("happy path: { rules: '...' } with action mention → ok", () => {
    const r = parseImproveResponse({ rules: "Newsletters → Archive" });
    assert.equal(r.ok, true);
    assert.equal(r.rules, "Newsletters → Archive");
  });

  test("string input is JSON-parsed", () => {
    const r = parseImproveResponse('{"rules":"Newsletters → Archive"}');
    assert.equal(r.ok, true);
  });

  test("unparseable string → ok:false kind:'parse'", () => {
    const r = parseImproveResponse("not json");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "parse");
  });

  test("missing rules field → ok:false kind:'empty'", () => {
    const r = parseImproveResponse({ foo: "bar" });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "empty");
  });

  test("empty rules → ok:false kind:'empty'", () => {
    const r = parseImproveResponse({ rules: "   " });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "empty");
  });

  test("rules with no action name → ok:false kind:'no-action'", () => {
    const r = parseImproveResponse({ rules: "Just be helpful." });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "no-action");
  });

  test("rules over 4000 chars → ok:false kind:'too-long'", () => {
    const huge = "Archive\n".repeat(1000); // mentions Archive but length > 4000
    const r = parseImproveResponse({ rules: huge });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "too-long");
  });

  test("rules trimmed to non-empty string in success path", () => {
    const r = parseImproveResponse({ rules: "  Archive newsletters  " });
    assert.equal(r.ok, true);
    assert.equal(r.rules, "Archive newsletters");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="parseImproveResponse"`
Expected: FAIL — `parseImproveResponse` not exported.

- [ ] **Step 3: Add validator to `improve.js`**

Append:

```js
// ------------------------ Response validator ------------------------

const MAX_RULES_CHARS = 4000;

export function parseImproveResponse(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); }
    catch { return { ok: false, error: { kind: "parse", message: "Model returned non-JSON" } }; }
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: { kind: "parse", message: "Model returned non-object" } };
  }
  const rules = typeof obj.rules === "string" ? obj.rules.trim() : "";
  if (!rules) {
    return { ok: false, error: { kind: "empty", message: "Model returned empty rules" } };
  }
  if (rules.length > MAX_RULES_CHARS) {
    return {
      ok: false,
      error: { kind: "too-long", message: `Rules exceed ${MAX_RULES_CHARS} chars` },
    };
  }
  if (!ACTIONS.some((a) => rules.includes(a))) {
    return {
      ok: false,
      error: { kind: "no-action", message: "Rules don't reference any action name" },
    };
  }
  return { ok: true, rules };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="parseImproveResponse"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/improve.js extension/tests/improve.test.js
git commit -m "feat(improve): response validator"
```

---

### Task 9: `improve.js` — end-to-end `improveRules` call

**Files:**
- Modify: `extension/background/improve.js`
- Test: `extension/tests/improve.test.js` (extend)

- [ ] **Step 1: Write failing tests**

Append to `extension/tests/improve.test.js`:

```js
import { improveRules } from "../background/improve.js";
import { DEFAULT_SETTINGS } from "../lib/schema.js";

describe("improveRules", () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  function mockOllamaReturning(content) {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: { content } }),
      { status: 200 },
    );
  }

  test("happy path returns ok with new rules", async () => {
    mockOllamaReturning(JSON.stringify({
      rules: "Newsletters → Archive\nPersonal mail → Star: Yellow",
    }));
    const r = await improveRules({
      settings: DEFAULT_SETTINGS,
      rules: "Old rules",
      disagreements: [{
        emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Yellow",
        from: "Mom", subject: "Hi", snippet: "x", ts: 1,
      }],
    });
    assert.equal(r.ok, true);
    assert.match(r.rules, /Newsletters/);
  });

  test("CORS surfaces as error.kind 'cors'", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const r = await improveRules({
      settings: DEFAULT_SETTINGS, rules: "x", disagreements: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "cors");
  });

  test("validation failure (no-action) propagates", async () => {
    mockOllamaReturning(JSON.stringify({ rules: "be helpful" }));
    const r = await improveRules({
      settings: DEFAULT_SETTINGS, rules: "x", disagreements: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "no-action");
  });
});
```

Add `import { beforeEach, afterEach } from "node:test";` to the imports if not already there.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="improveRules"`
Expected: FAIL — `improveRules` not exported.

- [ ] **Step 3: Add `improveRules` to `improve.js`**

Append:

```js
// ------------------------ End-to-end Improve call ------------------------

export async function improveRules({ settings, rules, disagreements }) {
  const prompt = buildMetaPrompt({ rules, disagreements });
  try {
    const { json, raw } = await chat({
      baseUrl: settings.ollamaBaseUrl,
      model:   settings.ollamaModel,
      numCtx:  settings.numCtx,
      messages: [
        { role: "system", content: "You rewrite email-classification rules. Output strict JSON only." },
        { role: "user",   content: prompt },
      ],
    });
    return parseImproveResponse(json ?? raw);
  } catch (err) {
    if (err instanceof OllamaError) {
      return { ok: false, error: { kind: err.kind, message: err.message, hint: err.hint } };
    }
    return { ok: false, error: { kind: "unknown", message: String(err?.message || err) } };
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="improveRules"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/improve.js extension/tests/improve.test.js
git commit -m "feat(improve): end-to-end improveRules call"
```

---

### Task 10: `pipeline.improvePrompt` orchestrator

**Files:**
- Modify: `extension/background/pipeline.js`
- Test: `extension/tests/improve-pipeline.test.js` (new)

- [ ] **Step 1: Write failing tests**

Create `extension/tests/improve-pipeline.test.js`:

```js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

describe("pipeline.improvePrompt", () => {
  let shim;
  let origFetch;
  let fetchCalls;
  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    fetchCalls = [];
    // Default fetch: respond as Ollama with a valid rewritten-rules JSON
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (String(url).includes("11434")) {
        return new Response(JSON.stringify({
          message: { content: JSON.stringify({ rules: "Archive newsletters\nStar: Red urgent" }) },
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    shim.storage.local.set("disagreements", [{
      emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
      from: "Mom", subject: "Hi", snippet: "x", ts: 1,
    }]);
    shim.storage.sync.set("settings", { ollamaModel: "test", rules: "Old rules" });
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("success: writes new rules, clears disagreements, clears IMPROVE_ERROR", async () => {
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, true);

    const settings = await store.getSettings();
    assert.match(settings.rules, /Archive newsletters/);

    assert.deepEqual(await store.getDisagreements(), []);
    assert.equal(await store.getImproveError(), null);
    assert.equal(await store.getImproving(), false);
  });

  test("validation failure (no-action) preserves rules and disagreements, sets IMPROVE_ERROR", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ rules: "be helpful" }) },
    }), { status: 200 });

    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "no-action");

    const settings = await store.getSettings();
    assert.equal(settings.rules, "Old rules");

    const dis = await store.getDisagreements();
    assert.equal(dis.length, 1);

    const err = await store.getImproveError();
    assert.equal(err.kind, "no-action");
    assert.equal(await store.getImproving(), false);
  });

  test("CORS error preserves rules and disagreements, sets IMPROVE_ERROR", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "cors");

    const settings = await store.getSettings();
    assert.equal(settings.rules, "Old rules");
    assert.equal((await store.getDisagreements()).length, 1);
    assert.equal((await store.getImproveError()).kind, "cors");
  });

  test("busy guard: classifyProgress.classifying=true → returns busy", async () => {
    shim.storage.session.set("classifyProgress", { classifying: true, progress: 0, total: 5 });
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "busy");
    // No state mutations
    assert.equal((await store.getDisagreements()).length, 1);
    assert.equal(await store.getImproveError(), null);
  });

  test("busy guard: a second concurrent call returns busy", async () => {
    const a = pipeline.improvePrompt();
    const b = await pipeline.improvePrompt();
    assert.equal(b.ok, false);
    assert.equal(b.error.kind, "busy");
    await a;
  });

  test("success path triggers a classifyInbox run (token requested)", async () => {
    await pipeline.improvePrompt();
    // classifyInbox calls fetchInbox → list inbox; we can't easily verify it
    // ran end-to-end without more shimming, but we can assert classifyProgress
    // was touched (set/cleared) by the time improvePrompt returns.
    const cp = shim.storage.session.get("classifyProgress");
    assert.ok(cp !== undefined, "classifyInbox should have set classifyProgress");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --test-name-pattern="pipeline.improvePrompt"`
Expected: FAIL — `improvePrompt` not exported.

- [ ] **Step 3: Add `improvePrompt` to `pipeline.js`**

Add to imports:

```js
import { improveRules } from "./improve.js";
```

Add the orchestrator (place after `applyAll`):

```js
// ------------------------ improvePrompt ------------------------

let improveInFlight = false;

export async function improvePrompt() {
  if (improveInFlight) {
    return { ok: false, error: { kind: "busy", message: "Improve already running" } };
  }
  // Refuse while a classify run is in flight; the IMPROVING flag and the
  // classifyProgress flag are independent, so we check both.
  const progress = await store.get("session", store.KEYS.CLASSIFY_PROGRESS, null);
  if (progress?.classifying) {
    return { ok: false, error: { kind: "busy", message: "Classify is running" } };
  }

  improveInFlight = true;
  try {
    await store.setImproving(true);
    await store.clearImproveError();

    const settings = await store.getSettings();
    const disagreements = await store.getDisagreements();
    const rules = settings.rules;

    const r = await improveRules({ settings, rules, disagreements });

    if (!r.ok) {
      await store.putImproveError(r.error.kind, r.error.message, r.error.hint);
      return r;
    }

    await store.setSettings({ rules: r.rules });
    await store.clearDisagreements();
    await store.clearImproveError();

    // Re-classify with the new rules. classifyInbox already manages its own
    // progress/state and is idempotent against double-invocation.
    await classifyInbox();

    return { ok: true };
  } finally {
    await store.setImproving(false);
    improveInFlight = false;
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --test-name-pattern="pipeline.improvePrompt"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/background/pipeline.js extension/tests/improve-pipeline.test.js
git commit -m "feat(pipeline): improvePrompt orchestrator"
```

---

### Task 11: Wire `MSG.IMPROVE_PROMPT` through `background.js`

**Files:**
- Modify: `extension/lib/messages.js`
- Modify: `extension/background/background.js`

- [ ] **Step 1: Add the message type**

In `extension/lib/messages.js`, extend the `MSG` object:

```js
  IMPROVE_PROMPT:  "IMPROVE_PROMPT",   // run the rules-improvement LLM call
```

- [ ] **Step 2: Add the handler case**

In `extension/background/background.js`, in the `handle` switch, add:

```js
    case MSG.IMPROVE_PROMPT: {
      const result = await pipeline.improvePrompt();
      return result.ok ? reply(result) : replyError(result.error);
    }
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS — no new tests, but nothing should regress.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/messages.js extension/background/background.js
git commit -m "feat(msg): IMPROVE_PROMPT message + handler"
```

---

### Task 12: Bottom mapping-prompt section — HTML + CSS

**Files:**
- Modify: `extension/sidepanel/sidepanel.html`
- Modify: `extension/sidepanel/sidepanel.css`

- [ ] **Step 1: Add the HTML**

In `extension/sidepanel/sidepanel.html`, append a new `<section>` after the existing `<section class="emails">` block (before `</main>`):

```html
      <section class="mapping" id="mapping-section" aria-label="Mapping prompt">
        <header class="mapping__head">
          <h2 class="mapping__title">Mapping prompt</h2>
        </header>

        <div class="mapping__group">
          <div class="mapping__label">Sent to the model</div>
          <pre class="mapping__readonly" id="mapping-system"></pre>
        </div>

        <div class="mapping__group">
          <div class="mapping__label">Rules (improvable)</div>
          <textarea class="mapping__textarea" id="mapping-rules" rows="8"></textarea>
          <div class="mapping__row">
            <button class="pill-btn" type="button" id="mapping-save-btn">Save rules</button>
            <span class="mapping__status" id="mapping-save-status"></span>
          </div>
        </div>

        <details class="mapping__group" id="mapping-disagreements">
          <summary class="mapping__summary">
            Disagreements pending: <span id="mapping-dis-count">0</span>
          </summary>
          <ul class="mapping__list" id="mapping-dis-list"></ul>
        </details>

        <div class="mapping__group">
          <div class="mapping__label">Improvement prompt</div>
          <pre class="mapping__readonly" id="mapping-meta"></pre>
        </div>

        <div class="mapping__group">
          <button class="btn btn--primary" id="improve-btn" type="button" disabled
                  title="Click an action that differs from the suggestion to record a disagreement first.">
            <span class="btn__label">Improve mapping prompt</span>
          </button>
          <div class="mapping__error" id="mapping-error" hidden></div>
        </div>
      </section>
```

- [ ] **Step 2: Add the CSS**

Append to `extension/sidepanel/sidepanel.css`:

```css
/* ---------- Mapping prompt section ---------- */

.mapping {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--rule-color, #444);
}

.mapping__title {
  font-size: 1rem;
  margin: 0 0 0.5rem 0;
}

.mapping__group {
  margin-bottom: 1rem;
}

.mapping__label {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ink-muted, #888);
  margin-bottom: 0.25rem;
}

.mapping__readonly {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  background: var(--paper-shadow, #1c1c1c);
  border: 1px solid var(--rule-color, #444);
  padding: 0.5rem;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 16rem;
  overflow: auto;
}

.mapping__textarea {
  width: 100%;
  font: inherit;
  font-size: 0.85rem;
  padding: 0.5rem;
  background: var(--paper-shadow, #1c1c1c);
  border: 1px solid var(--rule-color, #444);
  color: var(--ink, #eee);
  resize: vertical;
}

.mapping__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.mapping__status { font-size: 0.78rem; color: var(--ink-muted, #888); }

.mapping__summary {
  font-size: 0.85rem;
  cursor: pointer;
  user-select: none;
  padding: 0.25rem 0;
}

.mapping__list {
  list-style: none;
  padding: 0;
  margin: 0.25rem 0 0 0;
  font-size: 0.78rem;
}

.mapping__list li {
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--rule-color, #333);
}

.mapping__list li:last-child { border-bottom: none; }

.mapping__list .mapping__dis-line { color: var(--ink, #ddd); }
.mapping__list .mapping__dis-snippet { color: var(--ink-muted, #888); margin-top: 0.15rem; }

.mapping__error {
  background: #2a1414;
  border: 1px solid #6a2222;
  padding: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: #f0bcbc;
}

#improve-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Run `bin/serve` and visually confirm the section appears at the bottom**

Run: `bin/serve` and navigate to the side panel. Scroll down past the inbox; the new section should be visible with empty placeholder content. The Improve button should be visibly disabled with a tooltip on hover.

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel/sidepanel.html extension/sidepanel/sidepanel.css
git commit -m "feat(sidepanel): bottom mapping-prompt section markup"
```

---

### Task 13: Render the bottom section from state

**Files:**
- Modify: `extension/sidepanel/sidepanel.js`

The existing `state` object gains four fields. The render function gains a new `renderMapping()` step that populates the four read-only / interactive blocks added in Task 12.

- [ ] **Step 1: Add new state fields**

At the top of `extension/sidepanel/sidepanel.js`, in the `const state = { ... }` block, add:

```js
  disagreements: [],          // [{ emailId, predictedAction, chosenAction, from, subject, snippet, ts }]
  improving: false,
  improveError: null,         // { kind, message, hint? }
  rulesEditDirty: false,      // local: true while textarea diverges from saved
```

- [ ] **Step 2: Add new DOM refs**

In the `els = { ... }` block, add:

```js
  mappingSystem:    document.getElementById("mapping-system"),
  mappingRules:     document.getElementById("mapping-rules"),
  mappingSaveBtn:   document.getElementById("mapping-save-btn"),
  mappingSaveStatus:document.getElementById("mapping-save-status"),
  mappingDisCount:  document.getElementById("mapping-dis-count"),
  mappingDisList:   document.getElementById("mapping-dis-list"),
  mappingMeta:      document.getElementById("mapping-meta"),
  improveBtn:       document.getElementById("improve-btn"),
  mappingError:     document.getElementById("mapping-error"),
```

- [ ] **Step 3: Add imports**

At the top of the file, change the existing schema import to include `META_PROMPT`:

```js
import { ACTIONS, DEFAULT_SETTINGS, META_PROMPT } from "../lib/schema.js";
```

- [ ] **Step 4: Add `renderMapping()`**

Add this function (place above the `render` function):

```js
function buildSystemMessage(rules) {
  // Mirrors classify.js buildMessages — kept in sync manually. If the
  // classifier prompt changes, update here too.
  const actionList = ACTIONS.map((a) => `  - ${a}`).join("\n");
  return `You classify emails. Choose exactly one action from this list for each email:

${actionList}

Rules:
${rules}

Respond with strict JSON: {"action": "<one of the actions above>"}. No prose. No explanation.`;
}

function renderMapping() {
  const rules = state.settings?.rules || "";
  els.mappingSystem.textContent = buildSystemMessage(rules);
  els.mappingMeta.textContent   = META_PROMPT;

  if (!state.rulesEditDirty && document.activeElement !== els.mappingRules) {
    els.mappingRules.value = rules;
  }

  // Disagreement list
  const list = state.disagreements;
  els.mappingDisCount.textContent = String(list.length);
  els.mappingDisList.replaceChildren();
  for (const d of list) {
    const li = document.createElement("li");
    const line = document.createElement("div");
    line.className = "mapping__dis-line";
    line.textContent = `${d.from} — ${d.subject} — predicted: ${d.predictedAction} → chose: ${d.chosenAction}`;
    const snippet = document.createElement("div");
    snippet.className = "mapping__dis-snippet";
    snippet.textContent = d.snippet || "";
    li.append(line, snippet);
    els.mappingDisList.append(li);
  }

  // Improve button enable state
  const canImprove =
    list.length > 0 && !state.improving && !state.classifying;
  els.improveBtn.disabled = !canImprove;
  const lbl = els.improveBtn.querySelector(".btn__label");
  lbl.textContent = state.improving ? "Improving…" : "Improve mapping prompt";

  // Error block
  if (state.improveError) {
    els.mappingError.hidden = false;
    els.mappingError.textContent =
      `${state.improveError.message}` +
      (state.improveError.hint ? `  — ${state.improveError.hint}` : "");
  } else {
    els.mappingError.hidden = true;
    els.mappingError.textContent = "";
  }
}
```

- [ ] **Step 5: Call `renderMapping` from `render`**

In the existing `render()` function, add:

```js
  renderMapping();
```

(place at the end, after `renderDryRunPill()`).

- [ ] **Step 6: Smoke-test in the browser**

Run: `bin/serve`. The bottom section should now show the system-message read-only block with the placeholder rules, the meta-prompt block with placeholders, an empty disagreements list, and a disabled Improve button.

- [ ] **Step 7: Commit**

```bash
git add extension/sidepanel/sidepanel.js
git commit -m "feat(sidepanel): render mapping-prompt section from state"
```

---

### Task 14: Wire Save Rules + Improve button + storage subscription

**Files:**
- Modify: `extension/sidepanel/sidepanel.js`
- Modify: `extension/background/storage.js` (export `KEYS` is already done; verify nothing else needed)

- [ ] **Step 1: Add Save-rules wiring**

In `extension/sidepanel/sidepanel.js`, after the existing event-listener block (`els.fetchBtn.addEventListener("click", handleFetchClick);` and the others), append:

```js
els.mappingRules.addEventListener("input", () => {
  state.rulesEditDirty = els.mappingRules.value !== (state.settings?.rules || "");
});

els.mappingSaveBtn.addEventListener("click", async () => {
  const next = els.mappingRules.value.trim();
  if (!next) return;
  if (isExtension) {
    const cur = await chrome.storage.sync.get(KEYS.SETTINGS);
    const merged = { ...DEFAULT_SETTINGS, ...(cur[KEYS.SETTINGS] || {}), rules: next };
    await chrome.storage.sync.set({ [KEYS.SETTINGS]: merged });
  } else {
    state.settings = { ...state.settings, rules: next };
  }
  state.rulesEditDirty = false;
  els.mappingSaveStatus.textContent = "Saved.";
  setTimeout(() => { els.mappingSaveStatus.textContent = ""; }, 1500);
  render();
});

els.improveBtn.addEventListener("click", async () => {
  if (!isExtension) return;
  state.improving = true; render();
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.IMPROVE_PROMPT });
    if (!res?.ok) {
      state.improveError = res?.error || { kind: "unknown", message: "Improve failed" };
    }
  } catch (err) {
    state.improveError = { kind: "unknown", message: err.message || String(err) };
  } finally {
    state.improving = false;
    render();
  }
});
```

- [ ] **Step 2: Extend `hydrateFromStorage` to read the new keys**

Replace the body of `hydrateFromStorage` so it also pulls `KEYS.DISAGREEMENTS`, `KEYS.IMPROVING`, `KEYS.IMPROVE_ERROR`. Add to the `local` get list:

```js
  const local = await chrome.storage.local.get([
    KEYS.INBOX, KEYS.SUGGESTIONS, KEYS.HAS_CLASSIFIED, KEYS.APPLY_ERRORS, KEYS.DISAGREEMENTS,
  ]);
```

Add to the `session` get list:

```js
  const session = await chrome.storage.session.get([
    KEYS.CLASSIFY_PROGRESS, KEYS.APPLY_PROGRESS, KEYS.ERROR, KEYS.IMPROVING, KEYS.IMPROVE_ERROR,
  ]);
```

After the existing `state.applyErrors = local[KEYS.APPLY_ERRORS] || {};` line, add:

```js
  state.disagreements = local[KEYS.DISAGREEMENTS] || [];
  state.improving = Boolean(session[KEYS.IMPROVING]?.improving);
  state.improveError = session[KEYS.IMPROVE_ERROR] || null;
```

- [ ] **Step 3: Extend `subscribeToStorage`**

Inside the `chrome.storage.onChanged.addListener` callback, add to the `local` branch:

```js
      if (KEYS.DISAGREEMENTS in changes) {
        state.disagreements = changes[KEYS.DISAGREEMENTS].newValue || [];
        dirty = true;
      }
```

And to the `session` branch:

```js
      if (KEYS.IMPROVING in changes) {
        state.improving = Boolean(changes[KEYS.IMPROVING].newValue?.improving);
        dirty = true;
      }
      if (KEYS.IMPROVE_ERROR in changes) {
        state.improveError = changes[KEYS.IMPROVE_ERROR].newValue || null;
        dirty = true;
      }
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Smoke-test in browser**

Run: `bin/serve`. Outside the extension the buttons won't reach the worker, but the rules editor and Save status flash should work. Inside Chrome with the extension loaded:
1. Fetch + classify produces suggestions.
2. Click a non-predicted action on a row → row disappears; scroll down; the disagreement count badge increments and the entry appears in the list when expanded.
3. Click "Improve mapping prompt" → button shows "Improving…", then rules update in the textarea above and the disagreements list empties; classify-progress UI re-engages at the top.
4. If Ollama is offline, the error block under the Improve button shows the error.

If anything is broken, fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add extension/sidepanel/sidepanel.js
git commit -m "feat(sidepanel): wire save-rules and improve-button"
```

---

### Task 15: End-to-end smoke test + design doc

**Files:**
- Create: `docs/self-improving-mapping-prompt.md` (per yngvark-org rule: design doc lives in `docs/` for context)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 2: Run the extension end-to-end**

Reload the extension in Chrome/Brave. Fetch the inbox, classify, then disagree with at least three suggestions. Click Improve. Confirm:
- Rules text updates visibly in the textarea.
- Disagreements list empties.
- Classify automatically re-runs and the new pills reflect the updated rules.
- Buffer cap: append 51 disagreements (across multiple classify runs if needed); confirm the count holds at 50 and the oldest is dropped.

If any assertion fails, debug before committing the design doc.

- [ ] **Step 3: Write the design doc**

Create `docs/self-improving-mapping-prompt.md`:

```markdown
# Self-improving mapping prompt

## What

The "mapping prompt" is the system message Gmail Sorter sends to the local
Ollama model when classifying inbox emails. Its rules section is editable
and improvable. Each email row in the side panel shows all seven actions
inline; the predicted action is highlighted. Clicking a non-predicted
action records a disagreement. The bottom of the side panel shows the full
mapping prompt, the rules editor, the disagreement list, the read-only
meta-prompt, and an "Improve mapping prompt" button. Improve sends rules
+ disagreements to Ollama via the meta-prompt, validates the response,
overwrites the rules on success, clears disagreements, and re-classifies
the inbox.

## Why

Manually rewriting rules whenever the classifier mispredicts is friction
the user shouldn't pay. Capturing every disagreement at the click site and
periodically asking the same model to refine its own ruleset closes the
feedback loop without ever sending email content off the local machine.
Visibility is non-negotiable: the user wants to *see* every prompt the
model receives — both the classification system message and the meta-prompt
that drives Improve — and *see* the rules change after Improve runs.

## Design choices

- **Overwrite, no history.** Simplicity over rollback. Bad improvements
  are corrected by editing manually or accumulating new disagreements.
- **Clear disagreements on success.** Each Improve cycle starts fresh.
  Failures preserve the buffer so retry is possible without re-clicking.
- **Cap at 50 disagreements.** Bounds the meta-prompt size against the
  model's context window; oldest dropped silently.
- **One Ollama model.** Same model classifies and improves. Rules are
  validated to mention at least one action name as a sanity check.
- **Bottom-of-panel placement.** The user scrolls down to reach the
  mapping section; suggestions stay at the top, where attention belongs
  during normal use.

## Out of scope

- Prompt-version history / rollback.
- A/B testing old vs new rules.
- Editable meta-prompt.
- Background or scheduled improvement.
- Per-disagreement ignore / delete controls.
```

- [ ] **Step 4: Commit the design doc**

```bash
git add docs/self-improving-mapping-prompt.md
git commit -m "docs: design doc for self-improving mapping prompt"
```

---

## Self-review checklist

After completing all tasks:
- [ ] All tests pass: `npm test`.
- [ ] Manual smoke test (Task 15 step 2) confirmed: fetch → classify → disagree → improve → re-classify cycle works end-to-end against a live Ollama instance.
- [ ] No silent failures: an Ollama outage during Improve surfaces a visible error and leaves rules untouched.
- [ ] No new dependencies added (`package.json` unchanged).
