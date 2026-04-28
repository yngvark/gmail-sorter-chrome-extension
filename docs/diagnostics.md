# Diagnostics mode

A redacted, opt-in event log to make user-reported bugs reproducible without
asking anyone to read mail.

## Why

Issues like "Archive does nothing" (issues.md #1) leave no on-screen trace.
The only signals were `console.log` calls in the side panel and service
worker, invisible to a user who isn't sitting in DevTools. To diagnose, we
either had to ask the user to open DevTools and paste logs (high friction,
fragile) or read their inbox (not acceptable).

Diagnostics mode adds a small ring buffer of structured events, copyable
from the Settings page, that captures *what* happened without ever capturing
*who from* or *what about*.

## Privacy contract

The buffer never stores:

- `from` (sender address or display name)
- `subject`
- `snippet` (Gmail's preview text)
- `body`
- Any other field that derives from the email's content

It MAY store:

- Gmail's opaque message ID (e.g. `18f1a2c…`). This is a database key, not
  content. Without an OAuth token tied to the same account it can't be
  resolved to anything human-readable.
- The classifier action ("Archive", "Star", etc.) — picked from a fixed
  enum, not derived from content.
- Error kinds and HTTP status hints — the `message` text we emit is our
  own copy, not a Gmail/Ollama response body.
- `ts` (Unix milliseconds) per event.

Reviewer rule: when adding a new event, every key/value must be either a
fixed enum, an opaque ID, a numeric counter, or our own static string.
If you find yourself writing `from`, `subject`, `snippet`, or `body`,
stop — it doesn't belong in a diagnostic event.

## Buffer shape

- Stored at `chrome.storage.local[KEYS.DIAG_LOG]`.
- Capped at `DIAG_BUFFER_MAX` (200) most-recent events. Older entries fall
  off the front. 200 covers a few classify-and-apply runs comfortably.
- Each event is `{ ts: <epoch ms>, kind: <string>, ...details }`.
- `appendDiag()` is a no-op when `settings.diagnostics` is false. Call sites
  do not gate; the helper does.

## Event taxonomy

### Top-level message wrapper

Every `chrome.runtime` message that hits the service worker:

```json
{ "ts": 1730000000000, "kind": "msg", "type": "APPLY_ONE", "ok": true }
```

`type` is the `MSG.*` enum value. `ok` reflects whether the handler
returned `{ ok: true, ... }`. Useful for sanity-checking that the click
even reached the worker.

### Fetch inbox

```json
{ "kind": "fetch_inbox.start", "maxResults": 50 }
{ "kind": "fetch_inbox.done",  "fetched":    37 }
```

### Classify inbox

```json
{ "kind": "classify_inbox.start", "total": 12 }
{ "kind": "classify_inbox.email", "emailId": "18f…", "action": "Archive", "ok": true }
{ "kind": "classify_inbox.email", "emailId": "18g…", "ok": false }
{ "kind": "classify_inbox.done",  "done": 12, "total": 12, "aborted": false }
```

`action` is omitted on `ok: false` rows (we have no action to report).

### Apply one

```json
{ "kind": "apply_one.start", "emailId": "18f…", "action": "Archive" }
{ "kind": "apply_one.done",  "emailId": "18f…", "ok": true }
{ "kind": "apply_one.done",  "emailId": "18f…", "ok": true, "dryRun": true }
{ "kind": "apply_one.done",  "emailId": "18f…", "ok": true, "noop":   true }
{ "kind": "apply_one.done",  "emailId": "18f…", "ok": false, "errorKind": "gmail" }
```

#### Smoking-gun event

```json
{ "kind": "apply_one.unmapped_action", "emailId": "18f…", "action": "archive" }
```

Emitted when `actionToLabelDiff(sugg.action)` falls through to its default
`{ noop: true }` branch *and* the action wasn't `"Leave alone"`. This means
the suggestion's `action` string didn't match any case — typoed, wrong
case, trailing whitespace, etc. This is one of the prime suspects for
issue #1 ("Archive does nothing"): the row would clear locally without any
Gmail call ever happening, leaving the email in the inbox.

## Visible apply failures

Independent of diagnostics, `pipeline.applyOne` now writes every non-ok
return to `KEYS.APPLY_ERRORS`, not just thrown errors from
`gmail.modifyLabels`. The side panel renders `applyErrors` as toasts via
`renderToasts`, so any failure path — missing suggestion, auth blow-up
before the Gmail call, label creation failure — produces a visible
"Couldn't apply" toast. Previously these failed silently to `console.error`
only.

The side panel also writes a fallback toast directly when the
`MSG.APPLY_ONE` response is non-ok, so the user sees feedback immediately
even if the storage-onChanged path is delayed.

## Enabling

1. Open the extension's Settings page (Settings link in the side panel
   footer).
2. Under **Scope**, tick **Diagnostics mode**.
3. Click **Save changes**.

Diagnostics is off by default. Toggling it on does not retroactively log
older events.

## Sharing a buffer

1. Reproduce the bug (e.g. click Archive on a suggestion).
2. Return to Settings.
3. Click **Copy diagnostics**. The buffer is JSON-stringified and placed
   on the clipboard.
4. Paste into the GitHub issue.

There is also a **Clear** button if you want to start a fresh buffer
before reproducing.

## Operational notes

- The buffer lives in `chrome.storage.local`, so it survives service-worker
  suspension but not extension reinstall.
- Concurrent `appendDiag` calls are serialised through a promise chain to
  prevent lost writes when the pipeline emits events in parallel.
- The buffer write is `await`ed by call sites, but failures are swallowed
  in the message-wrapper path so a diag write can never break the response.
