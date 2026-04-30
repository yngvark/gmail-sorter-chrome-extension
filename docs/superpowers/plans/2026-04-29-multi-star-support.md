# Multi-variant Star Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `Star` action with three variant-specific actions (`Star: Yellow`, `Star: Red`, `Star: Red bang`) that map to Gmail superstar label IDs (`^ss_sy`, `^ss_sr`, `^ss_cr`).

**Architecture:** Extend the string-based action taxonomy in `extension/lib/schema.js`, add three switch cases to `actionToLabelDiff` in `extension/background/classify.js`, render glyph-prefixed text in the side panel pill, and expand the dev probe to verify all three variant IDs are writable against the user's Gmail account in one click.

**Tech Stack:** Chrome MV3 extension, ES modules, Node's built-in test runner (`node --test`), vanilla JS / CSS in the side panel, no build step.

**Spec:** `docs/superpowers/specs/2026-04-29-multi-star-design.md`.

---

## File Structure

| Path | Role |
|---|---|
| `extension/lib/schema.js` | Source of truth for `ACTIONS` and `DEFAULT_RULES` |
| `extension/background/classify.js` | Action→label-diff mapping in `actionToLabelDiff` |
| `extension/background/gmail.js` | New `probeAllSuperstars` helper (existing `probeSuperstar` unchanged) |
| `extension/background/pipeline.js` | `probeSuperstar` export replaced with `probeAllSuperstars` |
| `extension/background/background.js` | `MSG.PROBE_SUPERSTAR` handler routes to new pipeline export |
| `extension/sidepanel/sidepanel.js` | New `actionPillContent` helper, dev-button rewire, hydrate-time filter |
| `extension/sidepanel/sidepanel.css` | Action-pill rules for the three new variants; old `[data-action="Star"]` rule removed |
| `extension/sidepanel/sidepanel.html` | Dev button label tweak (`Probe ★` → `Probe stars`) |
| `extension/tests/classify.test.js` | Update mapping tests to cover three variants and regression-guard plain `Star` |
| `extension/tests/apply.test.js` | Replace existing `Star` apply test with three variant-apply tests |
| `extension/tests/classify-inbox.test.js` | If it asserts the prompt action list, update |
| `extension/tests/superstar.test.js` | New test for `probeAllSuperstars` |
| `extension/tests/sidepanel-pill.test.js` (new) | Test for `actionPillContent` helper |
| `docs/2026-04-29-multi-star-support.md` (new) | yngvark-org rule: design doc summarising the feature |

`tests-e2e/` is currently empty — no existing user stories to update. A starter Playwright corpus is *not* in scope for this plan; deferred.

---

### Task 1: Update the ACTIONS taxonomy

**Files:**
- Modify: `extension/lib/schema.js`
- Test: `extension/tests/classify.test.js` (the existing test reading from `ACTIONS`)

- [ ] **Step 1: Write failing tests for the new taxonomy**

Add to the bottom of `extension/tests/classify.test.js` (above the last closing brace of the file):

```js
describe("ACTIONS taxonomy", () => {
  test("contains three star variants and no plain 'Star'", () => {
    assert.ok(ACTIONS.includes("Star: Yellow"));
    assert.ok(ACTIONS.includes("Star: Red"));
    assert.ok(ACTIONS.includes("Star: Red bang"));
    assert.ok(!ACTIONS.includes("Star"), "plain 'Star' must be removed");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd extension && node --test tests/classify.test.js`
Expected: 1 failing test in the "ACTIONS taxonomy" describe block (`Star: Yellow` not found).

- [ ] **Step 3: Edit `ACTIONS`**

Replace lines 5-11 of `extension/lib/schema.js`:

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

- [ ] **Step 4: Run the new tests; the existing buildMessages test should also still pass**

Run: `cd extension && node --test tests/classify.test.js`
Expected: All `ACTIONS` taxonomy tests pass. `buildMessages` "system message lists every action exactly once" passes (it iterates over `ACTIONS`). Other tests in the file may now fail — that's expected and addressed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/schema.js extension/tests/classify.test.js
git commit -m "feat(schema): replace Star action with three variant-specific actions"
```

---

### Task 2: Update DEFAULT_RULES wording

**Files:**
- Modify: `extension/lib/schema.js`
- Test: `extension/tests/classify.test.js`

- [ ] **Step 1: Write failing test**

Add to the "ACTIONS taxonomy" describe block in `extension/tests/classify.test.js`:

```js
test("DEFAULT_RULES references all three star variants", () => {
  assert.match(DEFAULT_RULES, /Star: Yellow/);
  assert.match(DEFAULT_RULES, /Star: Red\b/);     // \b so 'Red' alone doesn't match 'Red bang'
  assert.match(DEFAULT_RULES, /Star: Red bang/);
  assert.doesNotMatch(DEFAULT_RULES, /→ Star\./, "plain 'Star.' rule should be gone");
});
```

Add `DEFAULT_RULES` to the import at the top of the test file:

```js
import { ACTIONS, DEFAULT_RULES, DEFAULT_SETTINGS, SAFE_FALLBACK_ACTION } from "../lib/schema.js";
```

- [ ] **Step 2: Run; confirm fail**

Run: `cd extension && node --test tests/classify.test.js`
Expected: new test fails (rules text still says `→ Star.`).

- [ ] **Step 3: Rewrite `DEFAULT_RULES`**

Replace lines 13-19 of `extension/lib/schema.js`:

```js
export const DEFAULT_RULES = `\
Personal, human messages from a real person to me → Star: Yellow.
Things I need to reply to or act on soon → Star: Red.
Urgent — needs my attention today → Star: Red bang.
Receipts, order confirmations, newsletters, promotional mail → Archive.
Security alerts or notifications that don't need action → Mark read.
Colleagues or teammates asking for something from me (a review, a reply, a meeting) → Move: Follow-up.
Automated reminders about events that already exist in my calendar → Leave alone.
When genuinely unsure → Leave alone.`;
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/classify.test.js`
Expected: new `DEFAULT_RULES` test passes.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/schema.js extension/tests/classify.test.js
git commit -m "feat(schema): rewrite default rules around the three star variants"
```

---

### Task 3: Map new actions to label diffs

**Files:**
- Modify: `extension/background/classify.js:77-98` (`actionToLabelDiff`)
- Test: `extension/tests/classify.test.js`

- [ ] **Step 1: Replace the existing `Star` mapping tests with variant-mapping tests**

In `extension/tests/classify.test.js`, the existing `actionToLabelDiff` describe block has tests at lines 87-91 (the original `Star` test) and 125-129 (the `'  Star'` whitespace test). Replace those two tests with the following three; also add a regression test below them.

Locate this test:

```js
test("Star: stars and archives (remove INBOX, add STARRED)", () => {
  const d = actionToLabelDiff("Star");
  assert.deepEqual(d.add, ["STARRED"]);
  assert.deepEqual(d.remove, ["INBOX"]);
});
```

Replace it with:

```js
test("Star: Yellow → add ^ss_sy, remove INBOX", () => {
  const d = actionToLabelDiff("Star: Yellow");
  assert.deepEqual(d.add, ["^ss_sy"]);
  assert.deepEqual(d.remove, ["INBOX"]);
  assert.notEqual(d.unmapped, true);
});
test("Star: Red → add ^ss_sr, remove INBOX", () => {
  const d = actionToLabelDiff("Star: Red");
  assert.deepEqual(d.add, ["^ss_sr"]);
  assert.deepEqual(d.remove, ["INBOX"]);
  assert.notEqual(d.unmapped, true);
});
test("Star: Red bang → add ^ss_cr, remove INBOX", () => {
  const d = actionToLabelDiff("Star: Red bang");
  assert.deepEqual(d.add, ["^ss_cr"]);
  assert.deepEqual(d.remove, ["INBOX"]);
  assert.notEqual(d.unmapped, true);
});
test("Plain 'Star' is now unmapped (regression guard)", () => {
  const d = actionToLabelDiff("Star");
  assert.equal(d.noop, true);
  assert.equal(d.unmapped, true);
});
```

Also locate the trailing-whitespace test:

```js
test("Trims leading whitespace too", () => {
  const d = actionToLabelDiff("  Star");
  assert.deepEqual(d.add, ["STARRED"]);
  assert.deepEqual(d.remove, ["INBOX"]);
});
```

Replace it with:

```js
test("Trims leading whitespace on a star variant", () => {
  const d = actionToLabelDiff("  Star: Red");
  assert.deepEqual(d.add, ["^ss_sr"]);
  assert.deepEqual(d.remove, ["INBOX"]);
});
```

- [ ] **Step 2: Run tests; confirm 4 new tests fail**

Run: `cd extension && node --test tests/classify.test.js`
Expected: the four `Star: …` / regression / whitespace tests all fail (mapping not yet present).

- [ ] **Step 3: Update `actionToLabelDiff`**

Replace lines 83-97 of `extension/background/classify.js` (the `switch (normalized)` body) with:

```js
  switch (normalized) {
    case "Star: Yellow":     return { add: ["^ss_sy"],            remove: ["INBOX"] };
    case "Star: Red":        return { add: ["^ss_sr"],            remove: ["INBOX"] };
    case "Star: Red bang":   return { add: ["^ss_cr"],            remove: ["INBOX"] };
    case "Archive":          return { add: [],                    remove: ["INBOX"] };
    case "Mark read":        return { add: [],                    remove: ["UNREAD"] };
    case "Move: Follow-up":  return {
      add: followUpLabelId ? [followUpLabelId] : [],
      remove: ["INBOX"],
      needsFollowUpLabel: !followUpLabelId,
    };
    case "Leave alone":      return { add: [], remove: [], noop: true };
    // Unmapped: distinguishable from "Leave alone" via `unmapped: true` so
    // pipeline.applyOne can refuse to silently delete the suggestion. The
    // diagnostic event in pipeline.js surfaces the offending action string.
    default:                 return { add: [], remove: [], noop: true, unmapped: true };
  }
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/classify.test.js`
Expected: all `actionToLabelDiff` tests pass.

The `parseClassification` test at line 62 — `parseClassification('{"action":"Star"}')` — will now fail because plain `"Star"` is no longer in `ACTIONS`. Update that test to use a current action:

```js
test("accepts a JSON string", () => {
  assert.deepEqual(parseClassification('{"action":"Archive"}'), { action: "Archive" });
});
```

Re-run; expected: green.

- [ ] **Step 5: Commit**

```bash
git add extension/background/classify.js extension/tests/classify.test.js
git commit -m "feat(classify): map three star variants to ^ss_* superstar label ids"
```

---

### Task 4: Update apply-path tests for the new variants

**Files:**
- Test: `extension/tests/apply.test.js`

- [ ] **Step 1: Replace the existing `Star` test with three variant tests**

In `extension/tests/apply.test.js`, locate the test at lines 56-64:

```js
test("Star: add STARRED, remove INBOX", async () => {
  seedSuggestion(shim.storage, { emailId: "m1", from: "Mom", subject: "Dinner", action: "Star" });
  const r = await pipeline.applyOne("m1");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    addLabelIds: ["STARRED"],
    removeLabelIds: ["INBOX"],
  });
});
```

Replace it with:

```js
test("Star: Yellow → add ^ss_sy, remove INBOX", async () => {
  seedSuggestion(shim.storage, { emailId: "m1", from: "Mom", subject: "Dinner", action: "Star: Yellow" });
  const r = await pipeline.applyOne("m1");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    addLabelIds: ["^ss_sy"],
    removeLabelIds: ["INBOX"],
  });
});
test("Star: Red → add ^ss_sr, remove INBOX", async () => {
  seedSuggestion(shim.storage, { emailId: "m1", from: "Alex", subject: "PR", action: "Star: Red" });
  const r = await pipeline.applyOne("m1");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    addLabelIds: ["^ss_sr"],
    removeLabelIds: ["INBOX"],
  });
});
test("Star: Red bang → add ^ss_cr, remove INBOX", async () => {
  seedSuggestion(shim.storage, { emailId: "m1", from: "Boss", subject: "URGENT", action: "Star: Red bang" });
  const r = await pipeline.applyOne("m1");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    addLabelIds: ["^ss_cr"],
    removeLabelIds: ["INBOX"],
  });
});
```

Also locate the `pipeline.applyAll` test at lines 241-274 that seeds `m2` with `action: "Star"`. Change that line:

```js
m2: { emailId: "m2", from: "c", subject: "d", action: "Star" },
```

to:

```js
m2: { emailId: "m2", from: "c", subject: "d", action: "Star: Yellow" },
```

- [ ] **Step 2: Run tests**

Run: `cd extension && node --test tests/apply.test.js`
Expected: all three new variant tests pass; `applyAll` tests still pass.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/apply.test.js
git commit -m "test(apply): cover the three new star variants end-to-end"
```

---

### Task 5: Sweep classify-inbox.test.js for stale references

**Files:**
- Test: `extension/tests/classify-inbox.test.js`

- [ ] **Step 1: Inspect the file for hard-coded `"Star"` references**

Run: `cd extension && grep -n '"Star"\| Star\b' tests/classify-inbox.test.js`
Expected: list of any matches.

- [ ] **Step 2: Run the test file as-is**

Run: `cd extension && node --test tests/classify-inbox.test.js`
Note any failures. Stale `"Star"` strings (e.g. as a fake model output) cause the suggestion's `action` to fall back to `"Leave alone"` via `parseClassification`'s unknown-action path.

- [ ] **Step 3: Replace any `"Star"` model-output literal with a current variant**

For each occurrence, change the literal to `"Star: Yellow"`. If a test asserts a *specific* action came out, update both the input literal and the expected value.

Example (illustrative — apply only if the pattern is present):

```js
// before:
mockOllamaReturning(JSON.stringify({ action: "Star" }));
// after:
mockOllamaReturning(JSON.stringify({ action: "Star: Yellow" }));
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/classify-inbox.test.js`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/classify-inbox.test.js
git commit -m "test(classify-inbox): use Star: Yellow in place of legacy Star literals"
```

If `grep` in step 1 returned no matches, skip steps 3-5 and mark this task complete.

---

### Task 6: Add `probeAllSuperstars` helper in gmail.js

**Files:**
- Modify: `extension/background/gmail.js`
- Test: `extension/tests/superstar.test.js`

- [ ] **Step 1: Write a failing test**

Append to `extension/tests/superstar.test.js`:

```js
import { probeAllSuperstars } from "../background/gmail.js";

describe("probeAllSuperstars", () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  test("calls probeSuperstar for yellow, red, redBang and aggregates results", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method || "GET", body: opts?.body });
      if (url.includes("/modify")) return new Response("{}", { status: 200 });
      // metadata read echoes back whatever was added in the previous modify
      const lastModify = calls.filter((c) => c.url.includes("/modify") && c.body).at(-1);
      const added = lastModify ? JSON.parse(lastModify.body).addLabelIds : [];
      return new Response(JSON.stringify({
        id: "m1",
        labelIds: ["INBOX", ...added],
        payload: { headers: [] },
      }), { status: 200 });
    };

    const r = await probeAllSuperstars("tok", "m1");
    assert.equal(r.yellow.writable, true);
    assert.equal(r.yellow.labelId, "^ss_sy");
    assert.equal(r.red.writable, true);
    assert.equal(r.red.labelId, "^ss_sr");
    assert.equal(r.redBang.writable, true);
    assert.equal(r.redBang.labelId, "^ss_cr");

    // Three round-trips: each variant does add → metadata-read → cleanup-remove.
    // 3 variants × 3 fetches = 9 calls.
    assert.equal(calls.length, 9);
  });
});
```

- [ ] **Step 2: Run; confirm fail (import error)**

Run: `cd extension && node --test tests/superstar.test.js`
Expected: import error or runtime error — `probeAllSuperstars` is not exported.

- [ ] **Step 3: Add `probeAllSuperstars` to gmail.js**

Append after the existing `probeSuperstar` function in `extension/background/gmail.js` (after line 165):

```js
// Convenience wrapper: probes the three superstar variants the extension
// uses (yellow, red, red bang) against a single message and returns the
// per-variant probe results. Each probe is non-destructive (cleanup remove
// runs on success).
export async function probeAllSuperstars(token, messageId) {
  const variants = ["yellow", "red", "redBang"];
  const out = {};
  for (const v of variants) {
    out[v] = await probeSuperstar(token, messageId, v);
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/superstar.test.js`
Expected: all probe tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/background/gmail.js extension/tests/superstar.test.js
git commit -m "feat(gmail): probeAllSuperstars helper for three-variant writability check"
```

---

### Task 7: Replace pipeline.probeSuperstar with probeAllSuperstars

**Files:**
- Modify: `extension/background/pipeline.js:316-324`
- Modify: `extension/background/background.js:68-71`

- [ ] **Step 1: Replace the pipeline export**

In `extension/background/pipeline.js`, replace lines 314-324 (the `// Superstar probe (dev)` block) with:

```js
// ------------------------ Superstar probe (dev) ------------------------

export async function probeAllSuperstars({ emailId } = {}) {
  const inbox = await store.getInbox();
  const row = emailId ? inbox[emailId] : Object.values(inbox)[0];
  if (!row) return { error: "inbox is empty — run fetchInbox first" };
  const token = await getToken({ interactive: true });
  const result = await gmail.probeAllSuperstars(token, row.id);
  console.log("[gmail-sorter] superstar probe (all) →", result);
  return result;
}
```

- [ ] **Step 2: Update the message handler**

In `extension/background/background.js`, locate the case at line 68:

```js
case MSG.PROBE_SUPERSTAR: {
  const result = await pipeline.probeSuperstar({ variant: msg.variant });
  ...
}
```

Replace the `pipeline.probeSuperstar(...)` call with `pipeline.probeAllSuperstars()`. The full block becomes:

```js
case MSG.PROBE_SUPERSTAR: {
  const result = await pipeline.probeAllSuperstars();
  return reply(result);
}
```

(Confirm the surrounding `return reply(result);` matches what's already there. If the existing block uses a different reply pattern, preserve it — just swap the function call.)

- [ ] **Step 3: Re-run all extension tests**

Run: `cd extension && node --test tests/`
Expected: green. No test imports `pipeline.probeSuperstar` directly (verified during planning), so renaming is safe.

- [ ] **Step 4: Commit**

```bash
git add extension/background/pipeline.js extension/background/background.js
git commit -m "feat(pipeline): probe all three star variants in one round-trip"
```

---

### Task 8: Rewire the side-panel dev probe button

**Files:**
- Modify: `extension/sidepanel/sidepanel.js:557-563`
- Modify: `extension/sidepanel/sidepanel.html:72`

- [ ] **Step 1: Update the dev button label**

In `extension/sidepanel/sidepanel.html`, change line 72 from:

```html
<button class="dev-btn" id="dev-superstar-btn" type="button">Probe &#9733;</button>
```

to:

```html
<button class="dev-btn" id="dev-superstar-btn" type="button">Probe stars</button>
```

- [ ] **Step 2: Update the click handler**

In `extension/sidepanel/sidepanel.js`, replace lines 557-563 (the existing `els.devSuperstarBtn.addEventListener` block) with:

```js
els.devSuperstarBtn.addEventListener("click", () =>
  runDevMessage(els.devSuperstarBtn, { type: MSG.PROBE_SUPERSTAR }, (d) => {
    if (d?.error) return d.error;
    const fmt = (k, r) => `${k}: ${r?.writable ? "✓" : "✗"}`;
    return [
      fmt("yellow", d.yellow),
      fmt("red", d.red),
      fmt("red bang", d.redBang),
    ].join(" / ");
  }),
);
```

- [ ] **Step 3: Sanity check — start the local server, open the side panel standalone**

Run: `bin/serve` (background) then visit the extension's side panel URL in a browser. The dev tools panel won't actually probe outside the extension context (no chrome.runtime), so this step is just to confirm there are no JS syntax/load errors.

If the panel renders without console errors, proceed.

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel/sidepanel.html extension/sidepanel/sidepanel.js
git commit -m "feat(sidepanel): dev probe button reports writability of all three star variants"
```

---

### Task 9: Add `actionPillContent` helper

**Files:**
- Modify: `extension/sidepanel/sidepanel.js`
- Test: `extension/tests/sidepanel-pill.test.js` (new)

- [ ] **Step 1: Write a failing test**

Create `extension/tests/sidepanel-pill.test.js`:

```js
// Unit test for the actionPillContent helper that prefixes the pill text
// with a glyph for star variants and returns plain text otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { actionPillContent } from "../sidepanel/sidepanel-pill.js";

describe("actionPillContent", () => {
  test("Star: Yellow gets a ★ prefix", () => {
    assert.equal(actionPillContent("Star: Yellow"), "★ Star: Yellow");
  });
  test("Star: Red gets a ★ prefix", () => {
    assert.equal(actionPillContent("Star: Red"), "★ Star: Red");
  });
  test("Star: Red bang gets a ❗ prefix", () => {
    assert.equal(actionPillContent("Star: Red bang"), "❗ Star: Red bang");
  });
  test("Non-star actions are returned verbatim", () => {
    assert.equal(actionPillContent("Archive"), "Archive");
    assert.equal(actionPillContent("Mark read"), "Mark read");
    assert.equal(actionPillContent("Move: Follow-up"), "Move: Follow-up");
    assert.equal(actionPillContent("Leave alone"), "Leave alone");
  });
});
```

The helper goes in its own module (`sidepanel-pill.js`) so the test can import it without pulling in the full `sidepanel.js` (which expects DOM globals).

- [ ] **Step 2: Run; confirm fail (module not found)**

Run: `cd extension && node --test tests/sidepanel-pill.test.js`
Expected: import error.

- [ ] **Step 3: Create the helper module**

Create `extension/sidepanel/sidepanel-pill.js`:

```js
// Renders the text content for an action pill, prefixing star variants
// with a glyph so the user can tell yellow / red / red bang apart at a
// glance without relying on color alone (border color also differs; see
// sidepanel.css). Non-star actions render verbatim.

export function actionPillContent(action) {
  if (action === "Star: Yellow")   return "★ Star: Yellow";
  if (action === "Star: Red")      return "★ Star: Red";
  if (action === "Star: Red bang") return "❗ Star: Red bang";
  return action;
}
```

- [ ] **Step 4: Run tests**

Run: `cd extension && node --test tests/sidepanel-pill.test.js`
Expected: green.

- [ ] **Step 5: Wire the helper into the renderer**

In `extension/sidepanel/sidepanel.js`, add the import near the top alongside the existing imports (after line 11):

```js
import { actionPillContent } from "./sidepanel-pill.js";
```

In `renderEmails`, replace line 186 (the existing `if (pill.textContent !== sugg.action) pill.textContent = sugg.action;`) with:

```js
const pillText = actionPillContent(sugg.action);
if (pill.textContent !== pillText) pill.textContent = pillText;
```

- [ ] **Step 6: Update placeholder data so the standalone panel exercises the new pill**

In `extension/sidepanel/sidepanel.js`, update `PLACEHOLDER_SUGGESTIONS` (line 26+). Replace the row with `action: "Star"` to use a specific variant:

```js
{ emailId: "i3", from: "Sam",      subject: "Coffee next week?",    action: "Star: Red" },
```

Also update the duplicated list around line 410+ (the `defaultSuggestions` reset path — search for `action: "Star"` and apply the same change).

- [ ] **Step 7: Run all extension tests**

Run: `cd extension && node --test tests/`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add extension/sidepanel/sidepanel-pill.js extension/sidepanel/sidepanel.js extension/tests/sidepanel-pill.test.js
git commit -m "feat(sidepanel): glyph-prefixed pill text for star variants"
```

---

### Task 10: CSS — pill border colors for the new variants

**Files:**
- Modify: `extension/sidepanel/sidepanel.css:494-501`

- [ ] **Step 1: Replace the action-specific tints block**

In `extension/sidepanel/sidepanel.css`, locate the comment and rules at lines 493-501:

```css
/* Action-specific tints (matches semantic meaning) */
.action-pill[data-action="Star"]              { border-color: var(--gold); color: var(--gold); }
.action-pill[data-action="Star"]:hover        { background: var(--gold); color: var(--paper); }
.action-pill[data-action="Archive"]           { border-color: var(--forest); color: var(--forest); }
.action-pill[data-action="Archive"]:hover     { background: var(--forest); color: var(--paper); }
.action-pill[data-action^="Move:"]            { border-color: var(--ink-2); color: var(--ink-2); }
.action-pill[data-action^="Move:"]:hover      { background: var(--ink-2); color: var(--paper); }
.action-pill[data-action="Mark read"]         { border-color: var(--ink-3); color: var(--ink-3); }
.action-pill[data-action="Mark read"]:hover   { background: var(--ink-3); color: var(--paper); }
```

Replace with:

```css
/* Action-specific tints (matches semantic meaning) */
.action-pill[data-action="Star: Yellow"]       { border-color: var(--gold); color: var(--gold); }
.action-pill[data-action="Star: Yellow"]:hover { background: var(--gold); color: var(--paper); }
.action-pill[data-action="Star: Red"]          { border-color: var(--sienna); color: var(--sienna); }
.action-pill[data-action="Star: Red"]:hover    { background: var(--sienna); color: var(--paper); }
.action-pill[data-action="Star: Red bang"]       { border-color: var(--sienna); color: var(--sienna); }
.action-pill[data-action="Star: Red bang"]:hover { background: var(--sienna); color: var(--paper); }
.action-pill[data-action="Archive"]           { border-color: var(--forest); color: var(--forest); }
.action-pill[data-action="Archive"]:hover     { background: var(--forest); color: var(--paper); }
.action-pill[data-action^="Move:"]            { border-color: var(--ink-2); color: var(--ink-2); }
.action-pill[data-action^="Move:"]:hover      { background: var(--ink-2); color: var(--paper); }
.action-pill[data-action="Mark read"]         { border-color: var(--ink-3); color: var(--ink-3); }
.action-pill[data-action="Mark read"]:hover   { background: var(--ink-3); color: var(--paper); }
```

Note: `[data-action^="Move:"]` (prefix selector) does NOT match `Star: Red` or `Star: Red bang` because the prefix is `Move:`, not `Star:`. No selector adjustment needed there.

- [ ] **Step 2: Visual sanity check**

Run: `bin/serve`, open the side panel page in a browser, confirm the Sam / Coffee row pill renders with a red border and `★ Star: Red` text. The other rows (Archive, Mark read, Follow-up) still render in their existing colors.

If verification using a real browser is unavailable, skip the visual check — the CSS change is mechanical and a typo would surface in step 3 of Task 11.

- [ ] **Step 3: Commit**

```bash
git add extension/sidepanel/sidepanel.css
git commit -m "feat(sidepanel): pill tints for the three star variants"
```

---

### Task 11: Hydrate-time filter for stale `"Star"` suggestions

**Files:**
- Modify: `extension/sidepanel/sidepanel.js` (`hydrateFromStorage`)

- [ ] **Step 1: Filter suggestions on load**

In `extension/sidepanel/sidepanel.js`, locate `hydrateFromStorage` (line 567+). After the line `state.suggestions = local[KEYS.SUGGESTIONS] || {};` (around line 578), add the filter:

```js
state.suggestions = local[KEYS.SUGGESTIONS] || {};
// Migration: drop any suggestion whose action is no longer in the current
// taxonomy (e.g. legacy plain "Star" entries from before the multi-star
// change). Re-classify will repopulate them. Auto-mapping plain "Star" to
// a specific variant would mis-mark urgent mail; safer to drop.
{
  const valid = new Set(ACTIONS);
  for (const [id, sugg] of Object.entries(state.suggestions)) {
    if (!valid.has(sugg.action)) delete state.suggestions[id];
  }
}
```

Add `ACTIONS` to the import at the top of the file (line 11):

```js
import { ACTIONS, DEFAULT_SETTINGS } from "../lib/schema.js";
```

- [ ] **Step 2: Run extension tests**

Run: `cd extension && node --test tests/`
Expected: green. (No existing test exercises hydrateFromStorage with stale data; manual verification covers it.)

- [ ] **Step 3: Commit**

```bash
git add extension/sidepanel/sidepanel.js
git commit -m "fix(sidepanel): drop legacy 'Star' suggestions on hydrate"
```

---

### Task 12: Manual verification (one-time, real browser)

This task is a checklist you run by hand. It validates the assumption the design rests on: that Gmail accepts writes for `^ss_sy`, `^ss_sr`, `^ss_cr` against the user's account.

- [ ] **Step 1: Reload the extension**

Open `chrome://extensions`, find Gmail Sorter, click the reload icon.

- [ ] **Step 2: Open the side panel with dev tools**

Open the side panel and append `?dev=1` to the URL so the dev tools section is visible. Click **Probe stars**.

- [ ] **Step 3: Read the dev result line**

Expected output: `yellow: ✓ / red: ✓ / red bang: ✓`.

If any variant shows `✗`, **stop** and report. The implementation halts here; design needs revisiting (custom labels with color is the documented fallback, separate work).

- [ ] **Step 4: Classify a small inbox**

Click **Fetch inbox** then **Classify**. Confirm the resulting pills render with the correct glyph and tint per variant. Expected: red pills for messages flagged "reply soon", red bang glyph for urgent ones, yellow for personal mail. Visual differences should match Task 10's CSS.

- [ ] **Step 5: Apply one suggestion of each variant**

For each star variant present in the suggestions, click the pill once. In Gmail (separate tab), verify:
- The message acquires the correct star glyph (yellow / red / red bang).
- The message disappears from the main inbox.
- The message appears in the corresponding star pane below the main inbox (Multiple Inboxes feature).

- [ ] **Step 6: Confirm no console errors**

Open the side panel devtools (right-click → Inspect). Console should be free of `[gmail-sorter]` errors.

If everything passes, proceed to Task 13.

---

### Task 13: Design doc + README update

**Files:**
- Create: `docs/2026-04-29-multi-star-support.md`
- Modify: `extension/README.md:180-181`

- [ ] **Step 1: Write the design doc**

Create `docs/2026-04-29-multi-star-support.md` with content:

```markdown
# Multi-variant Star support

**Date:** 2026-04-29

## What changed

The classifier now picks between three star variants instead of a single "Star" action:

- `Star: Yellow` — generic important / personal mail
- `Star: Red` — needs a reply or action soon
- `Star: Red bang` — urgent, needs attention today

Each maps to the corresponding Gmail superstar label ID (`^ss_sy`, `^ss_sr`, `^ss_cr`) and also archives the message (removes `INBOX`). The user runs Gmail's Multiple Inboxes feature with star-based panes below the main inbox, so star + archive routes the message into the right pane rather than hiding it.

## Why three variants

The previous single `Star` action only produced the default yellow star. The user uses three star variants as priority markers — yellow for general important mail, red for "reply soon", red bang for "urgent today" — and the classifier needs to drive that workflow rather than collapsing all three into one.

## Why specific variant names instead of semantic names

Action strings use color names (`Star: Red`) rather than meaning names (`Star: Reply soon`). The user reasons about their mailbox in colors because that's what Gmail shows. The semantic mapping lives in `DEFAULT_RULES` text, not in the action labels.

## Verification

Google does not document whether superstar label IDs are writable via `messages.modify`. The extension exposes a dev-tools probe (`Probe stars`) that does a non-destructive add/read/remove round-trip for each variant. If any variant probes as not writable on the user's account, the documented fallback is to switch to custom labels with color badges — not implemented yet.

## Spec

`docs/superpowers/specs/2026-04-29-multi-star-design.md`.
```

- [ ] **Step 2: Update the README's action vocabulary**

In `extension/README.md`, lines 180-181 currently read:

```
3. Click an action pill (**Star**, **Archive**, **Move: Follow-up**,
   **Mark read**) to apply that action to that email.
```

Replace with:

```
3. Click an action pill (**Star: Yellow**, **Star: Red**, **Star: Red
   bang**, **Archive**, **Move: Follow-up**, **Mark read**) to apply
   that action to that email.
```

- [ ] **Step 3: Commit**

```bash
git add docs/2026-04-29-multi-star-support.md extension/README.md
git commit -m "docs: design doc + README update for multi-variant star support"
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-29-multi-star-support.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — A fresh subagent runs each task, with review between tasks. Good for plans with mechanical steps where independent verification keeps drift down.

**2. Inline Execution** — Tasks run in this session with checkpoints, faster turnaround, fewer context switches.

Which approach?
