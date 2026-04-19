# Gmail Sorter Chrome Extension — Plan

A Chrome extension that sorts the Gmail inbox by asking a **locally-running Ollama model** to classify each email, then applying labels / archive / star actions via the Gmail API. Privacy: email content never leaves the user's machine.

## Background research

### Ollama integration (how nanobrowser does it)

Evidence from [nanobrowser](https://github.com/nanobrowser/nanobrowser) source:

- Uses `@langchain/ollama` as a convenience wrapper, but under the hood it's just an HTTP client talking to `http://localhost:11434` (Ollama's default HTTP server). We do not need LangChain — a plain `fetch` is enough.
- Default `baseUrl: 'http://localhost:11434'` (`packages/storage/lib/settings/llmProviders.ts:139`).
- `apiKey` is required by the library signature but ignored by Ollama (`helper.ts:336`).
- **Critical CORS gotcha**: Chrome blocks extension requests to Ollama unless Ollama is launched with:
  ```
  OLLAMA_ORIGINS=chrome-extension://*
  ```
  Nanobrowser surfaces this prominently in its settings UI (`pages/options/src/components/ModelSettings.tsx:1527-1548`). We will do the same. See [Ollama FAQ on origins](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-allow-additional-web-origins-to-access-ollama).
- Nanobrowser sets `numCtx: 64000`; `128000` caused models to be reloaded between calls when multiple models are in use.

### Ollama HTTP API

Endpoint: `POST http://localhost:11434/api/chat` with JSON body `{ model, messages, stream: false, format: "json" }`. Reference: [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md).

### OAuth 2.0 vs OpenID Connect

Different problems:

- **OpenID Connect (OIDC)** = *authentication*. Answers "who is this user?" You get an ID token (signed JWT). Not needed for this extension.
- **OAuth 2.0** = *authorization*. Answers "what API calls may this app make on behalf of this user?" You get an access token.

We only need OAuth 2.0 access tokens. `chrome.identity.getAuthToken` returns an OAuth2 access token, caches it in memory, and handles expiration automatically ([Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)).

### Gmail API capabilities

Everything in Gmail is modeled as labels. `users.messages.modify` takes `addLabelIds` and `removeLabelIds` (up to 100 each) in one call ([Gmail API reference](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/modify)).

| Desired action | How it's done |
|---|---|
| Archive | `removeLabelIds: ["INBOX"]` |
| Star (plain) | `addLabelIds: ["STARRED"]` |
| Mark read | `removeLabelIds: ["UNREAD"]` |
| Move to trash | `users.messages.trash` endpoint |
| Apply custom label | `users.labels.create` once, then `addLabelIds: [<id>]` |
| Mark important | `addLabelIds: ["IMPORTANT"]` |
| Category tabs | `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, etc. |

**Superstars (colored stars, icon stars)**: Gmail's colored stars have internal label IDs such as `^ss_sr` (red), `^ss_sb` (blue), `^ss_cg` (green check) ([unofficial reference](https://codematcher.com/questions/unable-to-search-for-specific-coloured-star-superstars-using-advanced-search-i)). Querying with `q=has:red-star` works. Whether `addLabelIds: ["^ss_sr"]` works via `messages.modify` is **not documented by Google** and must be verified early. If it doesn't work, fall back to custom user labels with colors.

## Architecture

- **Manifest v3 Chrome extension.** All logic in the service worker (background). No content script. Do not scrape the Gmail DOM — fragile.
- **Auth**: `chrome.identity.getAuthToken`, scope `https://www.googleapis.com/auth/gmail.modify` (read, label, archive, trash; cannot permanently delete, cannot send). If auto-reply is later added, also request `gmail.send`. Avoid the full-access `https://mail.google.com/` scope.
- **LLM**: direct `fetch` to local Ollama. No LangChain.
- **Trigger**: `chrome.alarms` every N minutes → poll `users.messages.list?q=in:inbox is:unread -label:nano-processed`. The `-label:nano-processed` guard prevents re-classifying. (Push via Pub/Sub requires a public endpoint — skip.)

### Manifest sketch

```json
{
  "manifest_version": 3,
  "name": "Gmail Sorter",
  "version": "0.1.0",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["identity", "storage", "alarms"],
  "host_permissions": [
    "http://localhost:11434/*",
    "https://gmail.googleapis.com/*"
  ],
  "oauth2": {
    "client_id": "<from Google Cloud Console>.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/gmail.modify"]
  },
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

## Processing loop

For each new message:

1. `users.messages.get?format=metadata` (headers only — cheap).
2. If needed, `format=full` to get body. Decode base64url body parts.
3. Build prompt: system message with category taxonomy; user message with `From`, `Subject`, body. Request `format: "json"` from Ollama.
4. POST to `http://localhost:11434/api/chat`.
5. Parse the classification, validate against allowed categories, map to Gmail label operations.
6. `users.messages.modify` with `addLabelIds` / `removeLabelIds`.
7. Add a `nano-processed` custom label so the message is not re-classified.

## UX

- **Popup**: "Processed N emails in last run. M pending." Run-now button. Link to options.
- **Options page**:
  - Ollama URL + model name.
  - **Prominent reminder about `OLLAMA_ORIGINS=chrome-extension://*`** with copy button.
  - Category taxonomy: category name → Gmail action (add/remove label IDs).
  - Classification prompt (editable, with default).
  - Dry-run toggle (log what it would do; do not modify).
  - Polling interval.
- **Dry-run mode**: logs decisions to `chrome.storage.local` and shows them in the popup for review before enabling writes.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Local Ollama latency on 50 emails | Small batches; allow batching multiple emails per prompt; configurable concurrency |
| Hallucinated / invalid categories | Ollama `format: "json"` + schema validation; fall back to "leave alone" on parse failure |
| Gmail API rate limits | Batch `messages.modify` where possible; exponential backoff on 429 |
| Superstar label IDs may not be writable | Verify early; fall back to custom colored user labels |
| User mis-launches Ollama without `OLLAMA_ORIGINS` | Detect CORS failure and show actionable error in popup |
| Destructive misclassification | Default to safe actions (label only); require opt-in for archive / trash; dry-run first |

## Build order

1. Skeleton extension. OAuth working. Log access token.
2. List inbox. Print subjects to console.
3. Call Ollama with a hardcoded prompt. Log classification.
4. Wire classification → `messages.modify` with a single action (archive).
5. Expand taxonomy. Options UI. `nano-processed` dedup label.
6. Verify whether superstar label IDs are writable; decide on fallback.
7. Polish: dry-run mode, popup stats, error handling, CORS-failure detection.

## Out of scope (v1)

- Gmail Pub/Sub push notifications.
- Auto-reply / sending mail.
- Multiple Gmail accounts.
- Non-Ollama LLM providers.
- Mobile / Gmail app (extension runs in desktop Chrome only).
