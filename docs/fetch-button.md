# Always-visible "Fetch inbox" button

## Context

The side panel originally exposed two ways to refresh the inbox snapshot:

- The dev-tools row in the footer (`extension/sidepanel/sidepanel.html`,
  `<div class="dev-tools">`), which contains a "Fetch inbox" button. This
  row is hidden unless the URL has `?dev=1` or the manifest's
  `version_name` contains "dev".
- The "Classify inbox" primary button. `pipeline.classifyInbox` falls
  through to `fetchInbox` only when the inbox storage map is empty, so
  on subsequent clicks the inbox is never re-fetched (see issue #2).

Result: a non-dev user has no way to refresh the inbox snapshot from the
UI. They reported expecting a Fetch button to be always visible, and got
confused when it disappeared after toggling out of dry-run / dev mode.

## Decision

Promote a "Fetch inbox" button to the primary-action section of the side
panel, rendered above "Classify inbox" with the secondary visual variant
(`btn--secondary`) so Classify remains the primary call-to-action.

The dev-tools row keeps its own `dev-fetch-btn`. It still shows the raw
`fetched: N` result in the dev-result span, which is useful for testing
auth and Gmail wiring without going through the storage subscription.

## Wiring

- Click handler sends `{ type: MSG.FETCH_INBOX }` to the service worker,
  same message the dev button uses. Routed via
  `extension/background/background.js` to `pipeline.fetchInbox`, which
  writes the result via `store.setInbox`.
- The side panel's `subscribeToStorage` already listens on
  `KEYS.INBOX` and triggers `renderInbox`, which un-hides the inbox
  `<details>` panel (`#inbox-details`) when there are rows. No
  additional render plumbing was needed.
- While the request is pending, the button label changes to "Fetching"
  and the button is disabled, mirroring `renderClassifyButton`.
- In standalone (non-extension) mode, a `simulateFetch` populates a
  small placeholder inbox so the button is exercisable during local UI
  iteration, mirroring `simulateClassify`.

## Why secondary variant

Classify is the primary action — it's what the user comes to the panel
to do. Fetch is a supporting action: refresh the snapshot before
classifying. Reflecting that hierarchy with `btn--secondary` (outlined,
ink-on-paper) keeps the visual emphasis on Classify.

## Related

- Issue #3 in `issues.md` — discoverability of Fetch.
- Issue #2 in `issues.md` — `classifyInbox` not re-fetching. Adding the
  Fetch button gives the user manual control over snapshot refresh; it
  does not change `classifyInbox`'s fetch policy.
