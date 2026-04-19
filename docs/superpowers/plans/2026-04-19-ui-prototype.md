# Gmail Sorter UI Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone vanilla HTML/JS/CSS prototype of the Gmail Sorter side-panel UX, rendered next to a minimal fake Gmail pane, so the user can iterate on timing, layout, and flow without touching OAuth, Ollama, or the Gmail API.

**Architecture:** Single HTML page. Two-pane split: fake Gmail on the left, side panel on the right. All mock email data hardcoded in JS. An in-memory state object (`emails`, `suggestions`) is the single source of truth; one `render()` function rebuilds both panes from state after every mutation. Classification is faked with `setTimeout` to simulate Ollama latency. No build step, no npm, no frameworks.

**Tech Stack:** Vanilla HTML, CSS, JavaScript (ES2020+). Browser: any modern (Brave/Chrome/Firefox). Verification: `playwright-cli` / playwright skill for screenshots of each milestone.

**Reference:** Spec at `docs/superpowers/specs/2026-04-19-ui-prototype-design.md`.

---

## File Structure

All files under a new top-level `prototype/` directory:

| File | Responsibility |
|---|---|
| `prototype/prototype.html` | Markup for both panes; links CSS and JS. |
| `prototype/prototype.css` | Two-pane layout, typography, subtle animation. |
| `prototype/prototype.js` | Mock data, state, `render()`, event handlers, simulated classification. |

No test files. The prototype is verified visually via the playwright skill at each milestone — this matches user's global instruction "ALWAYS use playwright skill for verifying UI or frontend changes."

---

## Task 1: Scaffold files and static layout

**Files:**
- Create: `prototype/prototype.html`
- Create: `prototype/prototype.css`
- Create: `prototype/prototype.js`

Goal: double-clicking `prototype.html` shows two labeled panes side by side. No data yet.

- [ ] **Step 1: Create `prototype/prototype.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gmail Sorter — UI Prototype</title>
    <link rel="stylesheet" href="prototype.css" />
  </head>
  <body>
    <main class="layout">
      <section class="gmail-pane" aria-label="Inbox">
        <h1>Inbox</h1>
        <ul class="email-list" id="email-list"></ul>
      </section>

      <aside class="side-panel" aria-label="Gmail Sorter">
        <h1>Gmail Sorter</h1>
        <button id="classify-btn" type="button">Classify inbox</button>
        <ul class="suggestion-list" id="suggestion-list"></ul>
        <button id="apply-all-btn" type="button" hidden>Apply all</button>
        <p class="empty-state" id="empty-state" hidden>
          No suggestions. Click <strong>Classify inbox</strong> to re-run.
        </p>
      </aside>
    </main>

    <script src="prototype.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `prototype/prototype.css`**

```css
* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  color: #222;
  background: #fafafa;
}

.layout {
  display: flex;
  min-height: 100vh;
}

.gmail-pane {
  flex: 1;
  padding: 16px 24px;
  background: #fff;
}

.side-panel {
  width: 360px;
  flex-shrink: 0;
  padding: 16px;
  border-left: 1px solid #e0e0e0;
  background: #fafafa;
}

h1 {
  font-size: 16px;
  margin: 0 0 16px;
}

button {
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  background: #fff;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
}

button:disabled {
  cursor: default;
  opacity: 0.6;
}

.email-list,
.suggestion-list {
  list-style: none;
  padding: 0;
  margin: 16px 0 0;
}

.empty-state {
  color: #666;
  font-size: 13px;
  margin-top: 16px;
}
```

- [ ] **Step 3: Create `prototype/prototype.js`**

```javascript
// Gmail Sorter — UI Prototype
// Scaffolding only. State, rendering, and interactions arrive in later tasks.

console.log("prototype.js loaded");
```

- [ ] **Step 4: Verify with playwright skill**

Open `file:///workspace/prototype/prototype.html` in playwright. Take a screenshot.

Expected: two panes visible. Left pane shows "Inbox" heading. Right pane shows "Gmail Sorter" heading and a `Classify inbox` button. No other content. No layout overflow.

- [ ] **Step 5: Commit**

```bash
git add prototype/
git commit -m "Scaffold UI prototype two-pane layout"
```

---

## Task 2: Mock data and `render()` driving both panes

**Files:**
- Modify: `prototype/prototype.js`

Goal: page load renders all 12 emails in the Gmail pane. Unread emails appear bold. Side panel still shows only the `Classify inbox` button.

- [ ] **Step 1: Replace `prototype/prototype.js` contents**

```javascript
// Gmail Sorter — UI Prototype

// ---------- Mock data ----------

const MOCK_EMAILS = [
  { id: "e1",  from: "Mom",                 subject: "Dinner Saturday?",          read: false, preBakedAction: "Star" },
  { id: "e2",  from: "Stripe",              subject: "Receipt for $47.00",        read: false, preBakedAction: "Archive" },
  { id: "e3",  from: "Amazon",              subject: "Your order has shipped",    read: false, preBakedAction: "Archive" },
  { id: "e4",  from: "LinkedIn",            subject: "8 new jobs for you",        read: false, preBakedAction: "Archive" },
  { id: "e5",  from: "Substack",            subject: "This week in AI",           read: false, preBakedAction: "Archive" },
  { id: "e6",  from: "Alex (colleague)",    subject: "Can you review the PR?",    read: false, preBakedAction: "Label: Follow-up" },
  { id: "e7",  from: "GitHub",              subject: "[repo] New issue opened",   read: false, preBakedAction: "Label: Follow-up" },
  { id: "e8",  from: "Google",              subject: "Security alert",            read: false, preBakedAction: "Mark read" },
  { id: "e9",  from: "Sam (friend)",        subject: "Coffee next week?",         read: false, preBakedAction: "Star" },
  { id: "e10", from: "Calendar",            subject: "Reminder: 1:1 tomorrow",    read: false, preBakedAction: "Leave alone" },
  { id: "e11", from: "unknown@example.com", subject: "hi",                        read: false, preBakedAction: "Leave alone" },
  { id: "e12", from: "Newsletter",          subject: "Weekly update",             read: false, preBakedAction: "Archive" },
];

// ---------- State ----------

const state = {
  emails: MOCK_EMAILS.map(e => ({
    ...e,
    starred: false,
    archived: false,
    labels: [],
  })),
  suggestions: [],    // [{ emailId, action }]
  classifying: false,
  classifyProgress: 0,
};

// ---------- Rendering ----------

function renderEmailList() {
  const ul = document.getElementById("email-list");
  ul.innerHTML = "";
  for (const email of state.emails) {
    if (email.archived) continue;
    const li = document.createElement("li");
    li.className = "email-row";
    if (!email.read) li.classList.add("unread");
    li.dataset.emailId = email.id;

    const star = document.createElement("span");
    star.className = "star";
    star.textContent = email.starred ? "\u2B50" : "";

    const from = document.createElement("span");
    from.className = "from";
    from.textContent = email.from;

    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = email.subject;

    li.append(star, from, subject);

    for (const label of email.labels) {
      const pill = document.createElement("span");
      pill.className = "label-pill";
      pill.textContent = label;
      li.append(pill);
    }

    ul.append(li);
  }
}

function renderSidePanel() {
  // Suggestions, Apply all, empty state — filled in later tasks.
  // Keep stub so render() is callable now.
}

function render() {
  renderEmailList();
  renderSidePanel();
}

// ---------- Boot ----------

render();
```

- [ ] **Step 2: Add email-row styles to `prototype/prototype.css`**

Append to the end of the file:

```css
.email-row {
  display: grid;
  grid-template-columns: 20px 140px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
  transition: opacity 200ms;
}

.email-row.unread .from,
.email-row.unread .subject {
  font-weight: 600;
}

.email-row .star {
  font-size: 14px;
  text-align: center;
}

.email-row .from {
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.email-row .subject {
  color: #555;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: #e8f0ff;
  color: #1a4a9c;
}
```

- [ ] **Step 3: Verify with playwright skill**

Reload `file:///workspace/prototype/prototype.html`. Screenshot.

Expected: Gmail pane lists all 12 emails, each showing sender and subject. The Google "Security alert" row (already read) appears normal weight; the other 11 appear bold.

- [ ] **Step 4: Commit**

```bash
git add prototype/
git commit -m "Render mock emails in Gmail pane from state"
```

---

## Task 3: `Classify inbox` button with streaming suggestions

**Files:**
- Modify: `prototype/prototype.js`
- Modify: `prototype/prototype.css`

Goal: clicking `Classify inbox` disables the button, increments a counter, and streams suggestion rows into the side panel every 250–500 ms. `Leave alone` classifications count toward the counter but do not render rows.

- [ ] **Step 1: Add classification logic to `prototype/prototype.js`**

At the bottom of `prototype.js`, above the `render()` call at the end, add:

```javascript
// ---------- Classification (simulated) ----------

const CLASSIFY_MIN_MS = 250;
const CLASSIFY_MAX_MS = 500;

function randomDelay() {
  return CLASSIFY_MIN_MS + Math.random() * (CLASSIFY_MAX_MS - CLASSIFY_MIN_MS);
}

function emailsToClassify() {
  // Emails still in the inbox that have no pending suggestion and are unhandled.
  // "Unhandled" = not archived, not starred, not already read, not already labelled.
  // Leave-alone emails never acquire any of those flags, so they remain eligible
  // on every re-run (which is the desired behaviour — their counter still ticks).
  return state.emails.filter(e =>
    !e.archived &&
    !e.starred &&
    !e.read &&
    !e.labels.includes("Follow-up") &&
    !state.suggestions.some(s => s.emailId === e.id)
  );
}

function startClassify() {
  if (state.classifying) return;
  const queue = emailsToClassify();
  if (queue.length === 0) return;

  state.classifying = true;
  state.classifyProgress = 0;
  render();

  let i = 0;
  function next() {
    if (i >= queue.length) {
      state.classifying = false;
      render();
      return;
    }
    const email = queue[i++];
    state.classifyProgress = i;
    if (email.preBakedAction !== "Leave alone") {
      state.suggestions.push({ emailId: email.id, action: email.preBakedAction });
    }
    render();
    setTimeout(next, randomDelay());
  }
  setTimeout(next, randomDelay());
}

document.getElementById("classify-btn").addEventListener("click", startClassify);
```

- [ ] **Step 2: Fill out `renderSidePanel()` in `prototype/prototype.js`**

Replace the stub `renderSidePanel()` with:

```javascript
function renderSidePanel() {
  const btn = document.getElementById("classify-btn");
  const list = document.getElementById("suggestion-list");
  const applyAll = document.getElementById("apply-all-btn");
  const empty = document.getElementById("empty-state");

  const total = state.emails.filter(e => !e.archived).length;
  if (state.classifying) {
    btn.disabled = true;
    btn.textContent = `Classifying\u2026 ${state.classifyProgress} / ${total}`;
  } else {
    btn.disabled = false;
    btn.textContent = "Classify inbox";
  }

  list.innerHTML = "";
  for (const sugg of state.suggestions) {
    const email = state.emails.find(e => e.id === sugg.emailId);
    if (!email) continue;
    const li = document.createElement("li");
    li.className = "suggestion-row";
    li.dataset.emailId = email.id;

    const meta = document.createElement("div");
    meta.className = "suggestion-meta";
    const from = document.createElement("div");
    from.className = "from";
    from.textContent = email.from;
    const subj = document.createElement("div");
    subj.className = "subject";
    subj.textContent = email.subject;
    meta.append(from, subj);

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "action-btn";
    actionBtn.textContent = sugg.action;
    // Wiring of click handler added in Task 4.

    li.append(meta, actionBtn);
    list.append(li);
  }

  const hasSuggestions = state.suggestions.length > 0;
  applyAll.hidden = !hasSuggestions;
  empty.hidden = state.classifying || hasSuggestions;
}
```

- [ ] **Step 3: Add suggestion-row styles to `prototype/prototype.css`**

Append to the end of the file:

```css
.suggestion-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #ececec;
  transition: opacity 200ms;
}

.suggestion-meta {
  flex: 1;
  min-width: 0;
}

.suggestion-meta .from {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion-meta .subject {
  font-size: 12px;
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#apply-all-btn {
  margin-top: 16px;
  width: 100%;
}
```

- [ ] **Step 4: Verify with playwright skill**

Reload the page, click `Classify inbox`. Watch the button text change to `Classifying… N / 12` and suggestion rows stream in over ~3–6 seconds. When done, 10 suggestion rows present (the 2 `Leave alone` emails contribute to the counter but not the list). `Apply all` button is now visible at the bottom of the panel.

Take a screenshot mid-classification and a second screenshot after it finishes.

- [ ] **Step 5: Commit**

```bash
git add prototype/
git commit -m "Stream classification suggestions into side panel"
```

---

## Task 4: Per-email action button applies action to both panes

**Files:**
- Modify: `prototype/prototype.js`

Goal: clicking the action button on a suggestion row mutates email state and re-renders. Gmail side reacts correctly per action.

- [ ] **Step 1: Add `applyAction()` function to `prototype/prototype.js`**

Add near the top of the classification section:

```javascript
// ---------- Action application ----------

function applyAction(emailId, action) {
  const email = state.emails.find(e => e.id === emailId);
  if (!email) return;

  switch (action) {
    case "Star":
      email.starred = true;
      break;
    case "Archive":
      email.archived = true;
      break;
    case "Mark read":
      email.read = true;
      break;
    case "Label: Follow-up":
      if (!email.labels.includes("Follow-up")) email.labels.push("Follow-up");
      break;
    case "Leave alone":
      // no-op
      break;
  }

  // Drop this email's suggestion.
  state.suggestions = state.suggestions.filter(s => s.emailId !== emailId);
  render();
}
```

- [ ] **Step 2: Wire the suggestion action button in `renderSidePanel()`**

In `renderSidePanel()`, replace the line `// Wiring of click handler added in Task 4.` with:

```javascript
    actionBtn.addEventListener("click", () => applyAction(sugg.emailId, sugg.action));
```

- [ ] **Step 3: Verify with playwright skill**

Reload. Click `Classify inbox`, wait for classification to finish. Then:
- Click `Archive` on the Stripe row → that suggestion disappears from the panel; the Stripe row disappears from the Gmail pane.
- Click `Star` on the Mom row → that suggestion disappears from the panel; the Mom row in the Gmail pane gets a ⭐ glyph prepended.
- Click `Mark read` on the Google row → that suggestion disappears; the Google row in the Gmail pane changes from bold to normal weight.
- Click `Label: Follow-up` on the Alex row → that suggestion disappears; a blue "Follow-up" pill appears on the Alex row in the Gmail pane.

Take screenshots before/after for each of the four actions above.

- [ ] **Step 4: Commit**

```bash
git add prototype/
git commit -m "Apply per-email action and update both panes"
```

---

## Task 5: `Apply all` button with staggered cascade

**Files:**
- Modify: `prototype/prototype.js`

Goal: clicking `Apply all` applies every remaining suggestion in sequence with ~150 ms stagger, shows progress, then hides itself.

- [ ] **Step 1: Add `applyAll()` function to `prototype/prototype.js`**

Append after `applyAction()`:

```javascript
const APPLY_ALL_STAGGER_MS = 150;

function applyAll() {
  const queue = [...state.suggestions];
  if (queue.length === 0) return;

  const applyAllBtn = document.getElementById("apply-all-btn");
  applyAllBtn.disabled = true;

  let i = 0;
  function next() {
    if (i >= queue.length) {
      applyAllBtn.disabled = false;
      return;
    }
    const sugg = queue[i++];
    applyAllBtn.textContent = `Applying\u2026 ${i} / ${queue.length}`;
    applyAction(sugg.emailId, sugg.action);
    setTimeout(next, APPLY_ALL_STAGGER_MS);
  }
  next();
}

document.getElementById("apply-all-btn").addEventListener("click", applyAll);
```

- [ ] **Step 2: Ensure `renderSidePanel()` resets the `Apply all` label when no longer applying**

In `renderSidePanel()`, right before the `applyAll.hidden = !hasSuggestions;` line, add:

```javascript
  if (!applyAll.disabled) applyAll.textContent = "Apply all";
```

- [ ] **Step 3: Verify with playwright skill**

Reload. Click `Classify inbox`, wait until done. Click `Apply all`. Watch the button label tick up (`Applying… 1 / 10`, `2 / 10`, …) while suggestions disappear from the panel and the Gmail pane updates in a cascading fashion over ~1.5 s. When done, `Apply all` is hidden and empty-state text appears.

Take a screenshot mid-cascade and after it completes.

- [ ] **Step 4: Commit**

```bash
git add prototype/
git commit -m "Add Apply all cascade"
```

---

## Task 6: Empty state and re-run behaviour

**Files:**
- Modify: `prototype/prototype.js`

Goal: once all suggestions are applied, the side panel shows the empty-state message. Clicking `Classify inbox` again classifies only unhandled emails (counter reflects remaining inbox size).

- [ ] **Step 1: Confirm `emailsToClassify()` covers re-run correctly**

Re-read the `emailsToClassify()` function from Task 3. The filter excludes archived, starred, read, labelled, and currently-queued emails. `Leave alone` emails acquire none of these flags, so they remain eligible on every re-run — the counter ticks for them but they never produce a suggestion row. No code change for this step.

- [ ] **Step 2: Update counter total in `renderSidePanel()` to reflect the classify queue**

Currently the classifying counter shows `N / total-inbox`. Replace it with `N / remaining-to-classify` so the fraction is meaningful on re-runs.

In `renderSidePanel()`, replace:

```javascript
  const total = state.emails.filter(e => !e.archived).length;
```

with:

```javascript
  const total = state.classifying
    ? (state.classifyTotal ?? 0)
    : emailsToClassify().length;
```

- [ ] **Step 3: Set `classifyTotal` in `startClassify()`**

In `startClassify()`, right after `const queue = emailsToClassify();`, add:

```javascript
  state.classifyTotal = queue.length;
```

Inside the inner `next()` function, right after the line `state.classifying = false;`, add:

```javascript
      state.classifyTotal = 0;
```

- [ ] **Step 4: Verify with playwright skill**

Reload. Click `Classify inbox`, then `Apply all`, and wait for completion.

Expected final state:
- Side panel shows the text "No suggestions. Click **Classify inbox** to re-run." and nothing else below the button.
- `Apply all` button is hidden.
- `Classify inbox` button reads "Classify inbox" and is enabled.

Now click `Classify inbox` a second time.

Expected: the counter ticks but only for emails that weren't handled (e.g. the two `Leave alone` and any emails not yet touched — with the default mock data, after `Apply all` there are typically 2 remaining). Once complete, no new suggestions appear (because the remainders are `Leave alone`).

Take a screenshot of the empty state and one of the re-run in progress.

- [ ] **Step 5: Commit**

```bash
git add prototype/
git commit -m "Implement empty state and re-run behaviour"
```

---

## Task 7: Animation polish

**Files:**
- Modify: `prototype/prototype.css`
- Modify: `prototype/prototype.js`

Goal: suggestion rows and archived email rows fade out (~200 ms) instead of disappearing instantly. Star appearance and label-pill appearance are subtly animated. No other changes.

- [ ] **Step 1: Add fade-out helper to `prototype/prototype.js`**

Append after the `render()` function:

```javascript
// ---------- Animations ----------

function fadeOutThen(element, callback) {
  element.style.opacity = "0";
  element.style.pointerEvents = "none";
  setTimeout(callback, 200);
}
```

- [ ] **Step 2: Wrap `applyAction()` to fade the corresponding row before mutating state**

Replace the existing `applyAction()` function body with:

```javascript
function applyAction(emailId, action) {
  const sidePanelRow = document.querySelector(`.suggestion-row[data-email-id="${emailId}"]`);
  const gmailRow = document.querySelector(`.email-row[data-email-id="${emailId}"]`);
  const willRemoveGmailRow = action === "Archive";

  const doMutate = () => {
    const email = state.emails.find(e => e.id === emailId);
    if (!email) return;
    switch (action) {
      case "Star":              email.starred = true; break;
      case "Archive":           email.archived = true; break;
      case "Mark read":         email.read = true; break;
      case "Label: Follow-up":
        if (!email.labels.includes("Follow-up")) email.labels.push("Follow-up");
        break;
      case "Leave alone":       break;
    }
    state.suggestions = state.suggestions.filter(s => s.emailId !== emailId);
    render();
  };

  const elementsToFade = [sidePanelRow, willRemoveGmailRow ? gmailRow : null].filter(Boolean);
  if (elementsToFade.length === 0) {
    doMutate();
    return;
  }
  let pending = elementsToFade.length;
  for (const el of elementsToFade) {
    fadeOutThen(el, () => {
      pending--;
      if (pending === 0) doMutate();
    });
  }
}
```

- [ ] **Step 3: Keep the CSS transitions already set in earlier tasks**

The `.email-row` and `.suggestion-row` rules already include `transition: opacity 200ms`, so `fadeOutThen()` sets `opacity: 0` and the transition fires. No CSS change required.

- [ ] **Step 4: Verify with playwright skill**

Reload. Classify, then click actions one by one and watch each suggestion row fade over ~200 ms before being removed. Archive actions also fade the corresponding Gmail row. Star / label-pill / bold-toggle actions leave the Gmail row intact (only the suggestion row fades).

Run `Apply all` and observe the cascade: each step fades its row before the next begins.

Take a short video (or 3 staged screenshots) of the cascade.

- [ ] **Step 5: Commit**

```bash
git add prototype/
git commit -m "Add fade-out animation for applied rows"
```

---

## Task 8: Final cross-check

**Files:**
- Read-only: all prototype files + `docs/superpowers/specs/2026-04-19-ui-prototype-design.md`

Goal: walk through each item in the spec against the running prototype. Capture any gaps.

- [ ] **Step 1: Re-read the spec**

Read `docs/superpowers/specs/2026-04-19-ui-prototype-design.md` end to end.

- [ ] **Step 2: Verify each spec section against the running prototype via playwright skill**

Walk through:

- [ ] Two-pane layout, fake Gmail left, fixed 360 px side panel right — pass?
- [ ] 12 mock emails with the given action distribution — pass?
- [ ] `Classify inbox` streams suggestions with randomized 250–500 ms delay — pass?
- [ ] Counter ticks across all 12 including `Leave alone` — pass?
- [ ] Per-email action buttons work for all 4 non-leave actions — pass?
- [ ] Archive removes from Gmail pane; Star adds ⭐; Mark read un-bolds; Follow-up shows pill — pass?
- [ ] `Apply all` cascades with ~150 ms stagger and progress label — pass?
- [ ] Empty state appears when suggestions drained — pass?
- [ ] Re-run classifies only unhandled emails — pass?
- [ ] Fade animations on row removal — pass?

If any item fails, file a follow-up task note in this same commit and fix it. If all pass, proceed to commit.

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add prototype/
git commit -m "Cross-check prototype against spec"
```

If no fixes were needed, skip this commit.

---

## Out of scope

Do not add any of the following. If discovered missing, resist the urge:

- Unit test harness. Verification is visual via playwright.
- Error states (CORS failure, Gmail failure) — user explicitly scoped these out.
- Options / settings page.
- Persistence (no `localStorage`). Page refresh resets to initial state.
- Real Chrome extension wiring. This prototype will never be loaded as an extension.
- Realistic Gmail look-alike styling. The Gmail pane is intentionally minimal.
- Keyboard shortcuts, accessibility beyond semantic HTML, i18n.
