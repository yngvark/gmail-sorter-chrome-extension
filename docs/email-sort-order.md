# Inbox sort order

The side panel renders the inbox newest-first by `internalDate`, matching
the order Gmail itself shows.

## Context

Before this change, `sortedInbox()` in `extension/sidepanel/sidepanel.js`
returned `Object.values(state.inbox)` with no explicit ordering. The map
was populated from `gmail.listInboxIds`, which returns IDs newest-first,
so on the happy path the iteration order was already correct. But the
inbox map round-trips through `chrome.storage.local`: serialised to JSON,
deserialised back. Object property order across that boundary isn't a
guarantee anyone wants to lean on, and concurrent writes from
`pipeline.classifyInbox` (via `mapWithConcurrency`) can shuffle insertion
order before the storage write lands.

The user-visible symptom: emails appearing in the side panel in an order
that didn't match Gmail's list view.

## Decision

Fetch `internalDate` from Gmail and sort on it explicitly.

- `getMessageMetadata` and `getMessageFull` (`extension/background/gmail.js`)
  now extract `internalDate` from the API response and coerce it to a
  number (Gmail returns it as a string of millis-since-epoch).
- `sortedInbox()` sorts descending by `internalDate`, with `0` as the
  fallback for missing values so degraded rows sink to the bottom rather
  than crashing the comparator.

`internalDate` is the value Gmail's own UI sorts by — the moment Gmail
*received* the message — and isn't manipulable by the sender (unlike the
`Date` header). That makes it the right field to mirror the user's
expectation.

## Why not sort once, at write time?

The map shape (`{ [id]: row }`) is convenient for fast lookups in
`renderEmails` (the merge loop matches suggestions to emails by id). An
array would force linear scans there or a parallel index. Sorting on
read is a single pass over a small list (capped at `settings.maxInbox`,
default 50), so the cost is irrelevant.

## Test coverage

`extension/tests/gmail.test.js`:

- `getMessageMetadata returns internalDate as a number` — checks the
  string-to-number coercion.
- `getMessageMetadata defaults missing internalDate to 0` — checks the
  fallback.

The sort itself was verified by loading the side panel with deliberately
shuffled placeholder data and confirming the rendered order matched
`internalDate` descending.
