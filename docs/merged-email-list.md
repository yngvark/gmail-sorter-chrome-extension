# Merged inbox + suggestions list

## Context

The side panel previously rendered two separate sections:

- A collapsible `<details>` "Inbox" panel listing every fetched email by
  from + subject. Hidden when the inbox map was empty.
- A "Suggestions" section listing every classified email with a clickable
  action pill (Archive, Star, etc.).

After fetching but before classifying, the user saw the inbox in a
collapsed-by-default panel and an empty suggestions list with the prompt
"Your inbox is waiting. Press *Classify inbox* above to begin." After
classifying, they saw the same emails *again* in the suggestions section,
this time with pills. Each email could appear in two places: the inbox
list and the suggestions list. "Leave alone" classifications appeared in
neither.

The mismatch was confusing in user testing: the inbox panel and the
suggestions panel are two views of the same underlying object (an email),
diverging only on whether a pill is attached. Two sections per email is
extra UI for no extra information.

## Decision

Merge into a single "Inbox" list. Every fetched email is one row. A row
has an action pill iff a suggestion exists for that email id; otherwise
the pill slot is `hidden` and the row is just from + subject.

Concretely:

- One section, one list, one count. Driven by `state.inbox`.
- Pill visibility is derived per-row from `state.suggestions[email.id]`.
- The "fade and remove" behaviour on apply now removes the entire row,
  not just the pill — the email is gone from inbox after Gmail accepts
  the mutation.

## Visual states

| State | Driver | What the user sees |
| --- | --- | --- |
| Empty | inbox `{}` | "Your inbox is empty. Press *Fetch inbox* above to pull new mail." |
| Fetched, not classified | inbox populated, suggestions `{}` | List of rows, no pills |
| Classifying | suggestions filling in | Pills appear progressively next to rows as the classifier streams |
| Classified | inbox + suggestions populated | Every row has a pill |
| After single apply | row removed | The applied row fades out and is replaced by the rows below |

## Wiring

- `renderEmails()` (was `renderSuggestions` + `renderInbox`) iterates
  `sortedInbox()` and creates/updates one row per email. For each row, it
  reads `state.suggestions[email.id]` and toggles the pill's `hidden`
  attribute and `data-action` accordingly.
- The existing DOM-diff strategy is preserved: rows whose backing inbox
  entry has vanished get `leaving` added so their fade-out completes
  before they're removed from the DOM. Without this, a `storage.onChanged`
  re-render would interrupt the click animation and the row would pop
  out instead of fading.
- `pipeline.applyOne` already deletes both the suggestion *and* the inbox
  entry on success (`store.deleteSuggestion(emailId)` +
  `removeFromInbox(emailId)`), so the merged-list behaviour falls out of
  the existing storage diffs without backend changes. The placeholder
  `applyOne` (non-extension mode) was updated to mirror this — it now
  also removes from `state.inbox`, so local UI iteration matches the
  in-extension fade.
- The "prompt-state" message ("Your inbox is waiting. Press Classify
  inbox above to begin") is gone. Its replacement is the empty-state
  message above, anchored to the inbox being empty rather than to a
  classify-was-run flag.

## Why tie pills to inbox rows, not the other way around

A previous draft considered driving the list from `state.suggestions`
and falling back to `state.inbox` for unclassified rows. That works but
has two drawbacks:

1. The conceptual primary object is the email; the suggestion is a
   per-email annotation. Driving rendering from the inbox makes that
   relationship obvious in code.
2. "Leave alone" classifications never produce a suggestion (by design
   in `pipeline.classifyInbox`). If we drove the list from suggestions,
   a "Leave alone" email would silently fall back to the inbox-only
   render, which reads the same as "not classified yet" and is
   indistinguishable from a row the classifier hasn't touched. Users
   would have no way to tell whether the absence of a pill meant
   "still pending" or "deliberately nothing to do".

The current shape doesn't solve "Leave alone" visibility either — both
states render identically — but the issue belongs to a future
classification-result enrichment, not to list layout.

## Related

- `docs/fetch-button.md` — the always-visible Fetch inbox button this
  refactor depends on (without it, there's no way for a user to populate
  the inbox without running classify, which makes the merged list less
  useful).
- `extension/sidepanel/sidepanel.js` — `renderEmails`, `applyOne`.
