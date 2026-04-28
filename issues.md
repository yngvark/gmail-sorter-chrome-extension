# Open issues

Tracking work from 2026-04-27 reporting session. Severity is the user's
ranking, most-severe first.

---

## 1. [HIGH] Clicking "Archive" on a suggestion does nothing visible

**Symptom (reported):** The user clicks the Archive action pill on an email
suggestion in the side panel and nothing happens — the row doesn't disappear
and the email isn't archived in Gmail.

**Where the click is wired:**
- `extension/sidepanel/sidepanel.js:152` — `pill.addEventListener("click", () => applyOne(s.emailId))`
- `extension/sidepanel/sidepanel.js:311` — `applyOne()` adds `leaving` class, sends `MSG.APPLY_ONE` to background
- `extension/background/background.js:49` — routes to `pipeline.applyOne(msg.emailId)`
- `extension/background/pipeline.js:193` — `applyOne()` looks up suggestion, gets diff via `actionToLabelDiff`, calls `gmail.modifyLabels`
- `extension/background/classify.js:80` — Archive → `{ add: [], remove: ["INBOX"] }`
- `extension/background/gmail.js:90` — `modifyLabels` short-circuits to `null` only if BOTH add and remove are empty — Archive has `remove=["INBOX"]`, so it should call the API.

**Root cause: not yet identified.** Plausible failure modes, in order:

1. **Background returns `ok:false` and the row un-fades** — sidepanel.js:319
   does `row.classList.remove("leaving")` on failure. To the user this looks
   like "nothing happened". The console-only log on line 320 is invisible
   unless the user opens DevTools on the side panel.
2. **Action string mismatch** — if `sugg.action` arrives with a different
   case, whitespace, or punctuation than the literals in `actionToLabelDiff`,
   it falls through to `default → { noop: true }` which silently clears the
   suggestion without touching Gmail. Row would fade and disappear locally,
   but the email stays in the inbox.
3. **Auth/Gmail API failure** — `getToken` throws or `modifyLabels` returns
   non-2xx. We do call `store.putApplyError(emailId, err.message)` on
   pipeline.js:236, which surfaces as a toast (sidepanel.js:239
   `renderToasts`). If the toast isn't appearing, either the error isn't
   reaching that path or the toast rendering is broken.
4. **The pill click handler isn't firing at all** — possible if the row is
   re-created on every render (it isn't, per the diff in `renderSuggestions`)
   or if event delegation is missing. Less likely.

**What we need before proposing a fix:** Diagnostic instrumentation that does
not require reading the user's email content. See issue #5 — we should ship
a "diagnostic mode" first and have the user reproduce while it's on.

**Proposed fix scope (after diagnosis):**
- Whatever the root cause is, also surface a user-visible error when
  `apply` fails — currently the only signal is `console.error`. The toast
  path exists (`KEYS.APPLY_ERRORS`) but it's only reached when the
  underlying mutation throws, not when `applyOne` short-circuits to a
  non-`ok` response with no apply-error stored.

---

## 2. [MEDIUM] "Classify inbox" silently does nothing on subsequent clicks

**Status:** Fixed in 550bdb6

**Symptom (reported):** The user clicks "Classify inbox" and no new emails
are fetched; nothing visible happens. Unclear what the button is supposed to
do.

**Root cause (confirmed by reading the code):**
`extension/background/pipeline.js:83` — `classifyInbox()` only fetches when
the inbox storage map is empty:

```js
let inbox = await store.getInbox();
if (Object.keys(inbox).length === 0) {
  await fetchInbox({ maxResults: settings.maxInbox });
  inbox = await store.getInbox();
}
const existing = await store.getSuggestions();
const todo = Object.values(inbox).filter((e) => !existing[e.id]);
```

After a previous run the inbox map is populated, so `fetchInbox` is skipped.
`todo` then filters out anything that already has a suggestion. If every
remaining inbox row was classified as "Leave alone" on the previous run,
it has no suggestion, but every subsequent classify will re-classify it
forever. Conversely, if everything has a suggestion, `todo.length === 0`
and the function returns immediately with `total: 0`.

Either way, the button label "Classify inbox" promises a fetch that doesn't
happen. The user has no way to refresh the inbox snapshot from the UI.

**Proposed fix (one of):**
- (a) Always re-fetch at the start of `classifyInbox`. Cheap on Gmail's
  metadata endpoint and matches the button's name.
- (b) Add an explicit "Fetch inbox" button (see issue #3) and document
  Classify as "classify what's already fetched". This is more honest about
  the underlying state machine.

(a) and (b) aren't mutually exclusive. (b) alone solves the discoverability
problem from issue #3 and would let the user refresh manually; (a) makes
the most-clicked button do the right thing without reading docs.

---

## 3. [MEDIUM] No always-visible "Fetch inbox" button

**Status:** Fixed in 38181df

**Symptom (reported):** The user wants a Fetch button visible in the side
panel even outside dry-run mode, so they can fetch without applying any
changes. They thought it was tied to dry-run / debug mode and got confused
when it disappeared.

**Why it's hidden:**
- `extension/sidepanel/sidepanel.html:77` — `<div class="dev-tools" id="dev-tools" hidden>` contains all four dev buttons including `dev-fetch-btn`.
- `extension/sidepanel/sidepanel.js:465-469` — dev-tools only un-hidden when URL has `?dev=1` or manifest `version_name` contains "dev".

The user is right that it's not tied to dry-run; it's tied to dev mode.
Their mental model ("I had it because I was in debug") matches what the
code actually does.

**Proposed fix:** Promote a "Fetch inbox" button to the primary section of
the side panel, next to or above "Classify inbox". Should call the same
`MSG.FETCH_INBOX` handler. The dev-tools fetch button can stay or be
removed — it would be redundant.

Open question for the user: what should the button render after a fetch?
Current dev path just shows `fetched: N` in the dev-result span. A user-
facing version probably wants to populate the inbox `<details>` panel
(`extension/sidepanel/sidepanel.html:45`) which already exists but is
hidden when empty.

---

## 4. [LOW] Settings rejects the default num_ctx (64000) as invalid

**Status:** Fixed in 3ef04b2

**Symptom (reported):** Editing the context-window field in settings shows
a Brave/Chrome HTML5 validation popup: "Please enter a valid value. The two
nearest valid values are 63488 and 64512. The prefilled value is 64000."

**Root cause (confirmed):**
- `extension/options/options.html:61` — `<input type="number" id="numCtx" min="2048" max="131072" step="1024" />`
- `extension/lib/schema.js:24` — `numCtx: 64000`

`step="1024"` makes the browser require values that satisfy
`(value - min) % step === 0`. Starting from `min=2048`, valid values are
`2048, 3072, …, 63488, 64512, …` — 64000 is exactly between two valid
steps (63488 = 62×1024, 64512 = 63×1024). The default value collides with
its own validation.

**Proposed fix (one of):**
- (a) Drop `step="1024"` (or set `step="1"`). Users can type any integer.
  Backend uses `clamp(Number(...), 2048, 131072)` already
  (`extension/options/options.js:45`), so we don't need step for safety.
- (b) Change default to a step-aligned value like 65536 (64×1024). Cleaner
  numerically but the user-facing hint says "64 000 is a good default" —
  changing it requires updating the hint too, and has user-visible churn.

(a) is the smaller change and matches the "any integer is fine" reality of
Ollama's `num_ctx`.

---

## 5. [INFRASTRUCTURE] No way to debug user-reported bugs without reading their email

**Symptom (reported):** The user explicitly noted they don't want anyone
reading their inbox to debug, and asked for tools so issues can be
investigated without that.

**Current state:** All extension diagnostics live in `console.log` /
`console.error` calls inside the side panel and service worker. The only
on-screen surfaces for problems are:
- The CORS banner (`extension/sidepanel/sidepanel.html:19`) — only shows
  for the four error kinds in `renderCorsBanner`.
- Per-email apply-error toasts (`renderToasts`) — only for errors raised
  inside `pipeline.applyOne`.

If something fails outside those paths (e.g. classify message handler
returns `ok:false` with a kind we don't recognise, or the side panel can't
reach the service worker at all), the user sees nothing and we have no
artefact to inspect.

**Proposed scope:**
- Add a "Diagnostics" toggle in settings that, when on:
  - Logs structured events to a ring buffer in `chrome.storage.local`
    (event type, timestamp, message kind, ok/not-ok, error kind, redacted
    email id — never `from`/`subject`/`body`/`snippet`).
  - Surfaces a "Copy diagnostics" button that puts the buffer on the
    clipboard so the user can paste it into an issue.
- Always: surface "apply failed" outcomes as visible toasts even when no
  apply-error was stored, so issue #1 stops being silent regardless of
  root cause.

This is a prerequisite for diagnosing issue #1.
