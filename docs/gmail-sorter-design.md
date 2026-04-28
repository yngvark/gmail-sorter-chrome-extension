# Gmail Sorter — Design

This document records **why** the extension is built the way it is.
The *what* is in the code; this file is for the decisions that don't
leave a fingerprint.

## Problem

Email triage is a time sink that doesn't need a brain: most messages are
receipts, newsletters, security alerts, or automated notifications that
the user will archive or ignore. A small fraction deserve real
attention. Rather than pay per-token to a cloud LLM to classify every
message (expensive, privacy-unfriendly), we ask a **locally-running
Ollama model** and apply Gmail actions through the REST API.

Design constraints:

1. **No email content leaves the machine.** The classifier is local.
2. **Nothing runs automatically.** No polling, no alarms, no push. Every
   classify and every mutation is triggered by the user.
3. **No content scripts.** No DOM parsing of Gmail. All Gmail
   interaction is REST.
4. **Must feel good.** The user looks at this panel multiple times a
   day. It should not look like an admin tool.

## Non-goals

- Auto-reply or drafting.
- Scheduled classification.
- Multi-account support.
- Non-Ollama LLM providers.

## Surface: side panel, not content script

The extension uses Chrome's [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
Rationale:

- Content scripts that re-render inside Gmail's DOM break every time
  Google ships a Gmail redesign.
- The side panel docks to the right of Gmail and is visually distinct —
  users can tell what's "us" vs "Google".
- Brave has historically had bugs with this API ([#32132](https://github.com/brave/brave-browser/issues/32132),
  [#31328](https://github.com/brave/brave-browser/issues/31328),
  [#31334](https://github.com/brave/brave-browser/issues/31334)). We
  verified all seven UX checks pass in current Brave before committing
  to this direction — see `sidepanel-test/`.

## State lives in storage, panel is a view

MV3 side panels are torn down whenever the user closes them and
re-mounted on open. Any in-memory state is lost. So the panel reads
from `chrome.storage` on mount and subscribes to `chrome.storage.onChanged`
for live updates; the service worker writes to storage during classify
and apply. Split by persistence:

| Area      | Lifetime                 | Contents |
| --------- | ------------------------ | -------- |
| `local`   | across browser restarts  | inbox rows, suggestions, apply-errors, hasClassified flag |
| `session` | cleared when browser closes | classify / apply progress, last-error banner |
| `sync`    | synced to the user's Google account | user settings, cached Follow-up label id |

This means the service worker suspending mid-classify is safe: when the
panel wakes it re-reads state and picks up where we left off.

## Why the side panel is a diff, not a rerender

`innerHTML = ""; append(newRows)` destroys in-progress fade-out
animations. When the user clicks an action pill, the row is marked
`leaving` (CSS transitions opacity + max-height), the service worker
applies the change, storage updates, `storage.onChanged` fires, and the
panel re-renders. If that re-render wipes the DOM, the fade is
interrupted and the row disappears instantly. So `renderEmails()` is
a DOM diff that preserves existing rows and schedules their removal only
when their fade finishes.

## Why no LangChain

Nanobrowser's evidence: the `@langchain/ollama` wrapper is a thin HTTP
client around `http://localhost:11434`. For one endpoint
(`/api/chat` with `format: "json"`) we don't need the framework. Plain
`fetch`, ~80 lines, zero dependencies.

## Why concurrency=2 for classify

Ollama is effectively single-threaded on most setups: requests queue
inside the server when the model is loaded. Running more than 2 in
parallel from the client gains nothing (requests just wait in Ollama's
queue) and makes progress feedback choppy. 2 gives a modest latency
improvement (start decoding the next email while the current one is
finishing) without flooding.

## Why serial apply with a visual stagger

Gmail's `messages.modify` is a fast call (<100ms typical). Running them
in parallel would clear the suggestion list in a single frame, which
reads as "glitch, did it work?" rather than "yes, that's done, onto the
next." So `applyAll` is a serial loop with a 250ms minimum per item
(matching the prototype). On a fast network the stagger is the
bottleneck; on a slow network the network is.

## Why the action→label diff maps `Star` to `remove INBOX`

The prototype's semantic is "starring an email also archives it" —
starred mail is what you've decided you care about and want to see in
your starred view, not in the inbox. `actionToLabelDiff("Star")`
therefore does both: `addLabelIds: ["STARRED"]`, `removeLabelIds:
["INBOX"]`. Users who want star-without-archive can edit the mapping in
`classify.js`.

## Why a lock around `putSuggestion`

`chrome.storage` exposes `get` and `set` but no transaction primitive.
Two concurrent classifier workers doing
`get(suggestions) → mutate → set(suggestions)` race: both read `{}`,
both add their own key, both write back — one wins, one is lost.

We caught this via a failing integration test that seeded two inbox
rows, mocked Ollama to return two different actions, and asserted that
*both* suggestions persisted. Fix: a promise-chain lock around
`putSuggestion` and `deleteSuggestion`. Not all storage writes need this
— only those that do read-modify-write on a shared map.

## Why CORS failure surfaces as a banner, not a toast

Missing `OLLAMA_ORIGINS` is the most common first-run failure. The
error is fixable with one command the user can copy and run. A banner
with the exact command + a Copy button is more useful than a generic
"something failed" toast. The banner is kind-aware: CORS gets one
message, model-missing gets another with the `ollama pull` command for
the configured model, timeout gets a third.

## OAuth client ID is a placeholder in the repo

Anyone who forks this repo needs their own Google Cloud OAuth client
anyway — the client ID is tied to a Chrome extension ID, which is tied
to whoever loaded the unpacked extension first. Documenting the setup
in the README is less fragile than trying to share a client ID across
contributors.

## What the prototype taught us

`prototype/` is a standalone HTML/CSS/JS mock that simulated the full
UX (classify, per-row apply with fade, apply-all with stagger) against
pre-baked classifications. Building it first let us argue about UX
without Gmail OAuth in the way. Two constants made the jump straight
from the prototype to production: `FADE_DURATION_MS = 200` and
`APPLY_ALL_STAGGER_MS = 250`. The state machine
(idle / classifying+progress / has-suggestions / empty-after-classify)
is the same too — only the data source changed from a mock array to
`chrome.storage`.

## Open questions

- **Superstar writability** (`^ss_*` label IDs). Google doesn't
  document this. `pipeline.probeSuperstar` performs a live check. If
  writable, the taxonomy can include coloured-star actions; if not,
  fallback is custom coloured user labels.
- **HTML email body stripping**. `DOMParser` is unavailable in service
  workers. The current regex stripper is first-pass; pathological HTML
  (deeply nested, inline-styled, tracking-pixel heavy) may leak
  markup into the prompt. If we see classification quality suffer on
  HTML-heavy inboxes, move decoding to an offscreen document.
- **Service-worker suspension during long runs**. All state lives in
  storage so the pipeline is resumable, but we haven't stress-tested a
  1000-email classify against SW suspension. First-day-of-vacation
  inboxes are a realistic worst case.
