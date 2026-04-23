# OAuth Client ID handling

## Context

The extension authenticates to Gmail via `chrome.identity.launchWebAuthFlow`
(see [`oauth-launch-web-auth-flow.md`](./oauth-launch-web-auth-flow.md)),
which reads `oauth2.client_id` from `manifest.json`. Each user of the
repo creates their own Google Cloud OAuth client (tied to their own
extension ID), so the Client ID is per-machine, not per-repo.

## Problem

`manifest.json` was tracked by git with a `PUT_YOUR_CLIENT_ID_HERE`
placeholder. Once a user substitutes their real Client ID locally, git
sees the file as modified — any `git add` of the extension directory,
or a catch-all `git add -A`, would commit that Client ID to the public
repo.

The Client ID is not a secret in the cryptographic sense — Chrome
extension OAuth clients have no client secret, and the ID is bound to
the registered extension ID server-side, so another extension cannot
use it. But committing it still:

- Ties the public repo to a specific maintainer's Google Cloud project.
- Offers no value to contributors, since each needs their own anyway.
- Creates an always-dirty working tree, which is a footgun.

## Design

Split the manifest into a template and a local copy:

- `extension/manifest.template.json` — tracked in git, contains the
  placeholder. Source of truth for the manifest's structure.
- `extension/manifest.json` — gitignored, created locally by copying
  the template. Contains the real Client ID. Loaded by Chrome at runtime.

Setup flow becomes: clone → `cp manifest.template.json manifest.json`
→ paste Client ID into `manifest.json` → load unpacked. The template
can be updated in git without disturbing local Client IDs, and local
Client IDs cannot be accidentally committed.

## Alternatives considered

- **`git update-index --skip-worktree`** on the tracked file. Rejected:
  per-clone, doesn't survive re-clone, silently breaks on upstream
  changes to the file, easy to forget.
- **Runtime Client ID in `chrome.storage`** (entered via the options
  page). Rejected: the Client ID is not a secret, `manifest.json` is a
  single well-known place to put it, and moving it to storage adds UI
  surface area for no gain at the scale this extension targets.

## Related history

The extension has since moved off `chrome.identity.getAuthToken` to
`chrome.identity.launchWebAuthFlow` — not because of how the Client ID
is stored, but because Google deprecated the older flow. See
[`oauth-launch-web-auth-flow.md`](./oauth-launch-web-auth-flow.md). The
split-manifest pattern here is unchanged by that switch.
