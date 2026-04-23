# OAuth via `chrome.identity.launchWebAuthFlow`

## Context

The extension originally used `chrome.identity.getAuthToken` — the
path recommended by Chrome's own extension docs. Chrome managed the
token cache and refresh transparently; the manifest declared
`oauth2.client_id` + `oauth2.scopes` and the API Just Worked.

## Problem

Against a newly-created Google Cloud OAuth client (any "Chrome
Extension"-type client with `gmail.modify` scope, circa 2025+), the
`getAuthToken` flow is rejected by Google's sign-in servers with:

```
Error 400: invalid_request
Custom URI scheme is not supported on Chrome apps.
Request details: flowName=GeneralOAuthFlow
```

This happens in both Chrome and Brave, with or without the account
listed as a test user, with a correctly-registered extension ID. The
root cause is Google-side: the legacy custom-scheme redirect path
behind `getAuthToken` has been deprecated, and new OAuth clients are
routed onto it anyway when an extension uses `getAuthToken`.

There is no server-side config that makes it work. The only fix is a
different client-side flow.

## Decision

Switch to `chrome.identity.launchWebAuthFlow` with OAuth 2.0
Authorization Code + PKCE against a **Web application** OAuth client.

- Redirect URI: `https://<extension-id>.chromiumapp.org/` — generated at
  runtime by `chrome.identity.getRedirectURL()`, registered manually on
  the OAuth client.
- PKCE (S256 challenge) replaces the client secret: a Web application
  client normally requires one, but the secret cannot be stored safely
  in an unpacked extension. PKCE is the documented public-client
  pattern.
- Refresh tokens (via `access_type=offline` + `prompt=consent`) give
  silent 1-hour refresh without re-prompting the user.

## Token lifecycle

- **Access token** (~1h): stored in `chrome.storage.session` so it
  survives service-worker suspension but is dropped on browser close.
- **Refresh token** (long-lived): stored in `chrome.storage.local`.
  Persists across browser restarts.
- **In-flight PKCE state** (`code_verifier`, `state`): stored in
  `chrome.storage.local` during the redirect round-trip, cleared
  immediately after.

`getToken({ interactive })` tries: cached access → silent refresh →
interactive auth. Preserving this signature means `pipeline.js` and
`background.js` needed no changes.

Concurrent `getToken` calls within one service-worker lifetime are
deduplicated via a module-level in-flight promise, so five parallel
pipeline calls don't trigger five refreshes.

## Sign-out

Best-effort `POST oauth2.googleapis.com/revoke` for both the access and
refresh tokens, then clear both storage areas. Also still calls
`chrome.identity.clearAllCachedAuthTokens` as a defensive sweep for
users migrating from the `getAuthToken`-era build — safe to drop after
one or two releases.

## Trade-offs

- **Slightly more code in the extension.** Chrome no longer manages the
  token cache, so `auth.js` does (with storage).
- **User sets up a different OAuth client type.** "Web application"
  instead of "Chrome Extension", and must paste a redirect URI. README
  step 4 walks through it.
- **Extension ID stability matters more.** The redirect URI is derived
  from the ID, so any change invalidates the registration. README now
  promotes the `"key"` field from "optional" to "strongly recommended".
- **Refresh tokens persist across restarts.** A more valuable credential
  than before sits in `chrome.storage.local`. Storage is per-profile and
  not synced, but it's worth flagging: a compromised browser profile
  exposes ~1 refresh-token's worth of Gmail access. Revoke via sign-out
  or at <https://myaccount.google.com/permissions>.

## Alternatives considered

- **Implicit grant (response_type=token).** Simpler — no token exchange,
  no refresh token. Rejected: Google has deprecated the implicit flow
  for new clients, and no refresh token means re-prompting the user
  every hour.
- **`getAuthToken` with a workaround key/setting.** None found. The
  deprecation is unconditional on Google's side.
- **Runtime-configurable client ID (options page + storage).** Rejected
  for the same reason as in
  [`oauth-client-id-handling.md`](./oauth-client-id-handling.md): the
  client ID is not a secret, and a `manifest.json`-local copy is
  friction-free for the single-user setup the extension targets.

## Related

- [`oauth-client-id-handling.md`](./oauth-client-id-handling.md) —
  why `manifest.json` is gitignored and the template is tracked.
- [`gmail-sorter-design.md`](./gmail-sorter-design.md) — overall
  architecture.
