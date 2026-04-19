# Gmail Sorter Chrome Extension — Plan

A Chrome/Brave extension that sorts the Gmail inbox by asking a **locally-running Ollama model** to classify each email, then applying labels / archive / star actions via the Gmail API. Privacy: email content never leaves the user's machine. Every action is triggered by the user — nothing runs automatically.

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

### Side Panel API in Brave — verified

Tested with `sidepanel-test/` against Brave. All seven checks pass: no crashes, panel opens on toolbar-icon click, stays open, runs JS continuously, survives tab switching, reopens reliably. Historical Brave bugs ([#32132](https://github.com/brave/brave-browser/issues/32132), [#31328](https://github.com/brave/brave-browser/issues/31328), [#31334](https://github.com/brave/brave-browser/issues/31334)) do not reproduce. In-memory state is lost when the panel is closed — this is standard Chrome behavior, not a Brave bug, and is handled by persisting state to `chrome.storage`.

## Architecture

- **Manifest v3 extension. No content script.** No DOM parsing. All Gmail interaction goes through the Gmail REST API.
- **UI surface**: Chrome's [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) (`chrome.sidePanel`). User clicks the toolbar icon; panel opens docked to the right, alongside Gmail.
- **Service worker** (background): handles OAuth, Gmail API calls, Ollama calls. The panel is a thin view; the worker does the work.
- **Auth**: `chrome.identity.getAuthToken`, scope `https://www.googleapis.com/auth/gmail.modify` (read, label, archive, trash; cannot permanently delete, cannot send). Avoid the full-access `https://mail.google.com/` scope.
- **LLM**: direct `fetch` to local Ollama. No LangChain.
- **Nothing runs automatically.** No `chrome.alarms`, no polling, no push. Every classification and every Gmail mutation is user-triggered.

### Persistence model

The side panel page is torn down when the user closes it and re-mounted on open. To survive close/reopen, state lives outside the panel:

| State | Storage | Lifetime |
|---|---|---|
| Classifications (message ID → suggested action) | `chrome.storage.local` | Persists across browser restart |
| "Classifying in progress" / counters | `chrome.storage.session` | Cleared on browser close |
| Settings (Ollama URL, model, prompt, category mapping) | `chrome.storage.sync` | Synced across user's Chrome |

On mount, the panel reads storage and renders. The service worker writes to storage during classification/application; the panel subscribes to storage changes via `chrome.storage.onChanged` for live updates.

### Manifest sketch

```json
{
  "manifest_version": 3,
  "name": "Gmail Sorter",
  "version": "0.1.0",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["identity", "storage", "sidePanel"],
  "host_permissions": [
    "http://localhost:11434/*",
    "https://gmail.googleapis.com/*"
  ],
  "oauth2": {
    "client_id": "<from Google Cloud Console>.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/gmail.modify"]
  },
  "action": { "default_title": "Open Gmail Sorter" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_page": "options.html"
}
```

The service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so clicking the toolbar icon opens the panel.

## UX

### Side panel

```
┌──────────────────────┐
│ Gmail Sorter         │
│                      │
│ [Classify inbox]     │  ← triggers LLM classification
│                      │
│ ─ Suggestions ─      │
│                      │
│ Mom — Dinner?        │
│   [Star]             │  ← button text = suggested action
│                      │
│ Stripe — Receipt     │
│   [Archive]          │
│                      │
│ LinkedIn — Jobs...   │
│   [Archive]          │
│                      │
│ [Apply all]          │  ← applies all pending suggestions
│                      │
│ ⚙ Settings           │
└──────────────────────┘
```

- **`Classify inbox`** button: calls Gmail API to list inbox messages, then runs each through Ollama. Suggestions written to `chrome.storage.local`. Panel renders them as they arrive.
- **Per-email row**: From + subject + a single button whose label is the suggested action (`Star`, `Archive`, `Mark read`, `Label: Follow-up`, etc.). Clicking the button applies that action via the Gmail API. Row disappears (or shows ✓) on success.
- **`Apply all`** button: applies every pending suggestion in one batch. Progress indicator; failures listed.
- No popups. No notifications. No automatic work.

### Options page

- Ollama URL + model name.
- **Prominent reminder about `OLLAMA_ORIGINS=chrome-extension://*`** with a copy button and a link to the Ollama FAQ.
- Category taxonomy: category name → Gmail action (add/remove label IDs).
- Classification prompt (editable, with default).

## Processing flow

User clicks `Classify inbox`:

1. Service worker gets OAuth token via `chrome.identity.getAuthToken`.
2. `users.messages.list?q=in:inbox&maxResults=50` → list of message IDs.
3. For each message ID (with small concurrency, e.g. 2–4 at a time):
   a. `users.messages.get?format=metadata` for headers.
   b. If needed, `format=full` for body; decode base64url body parts.
   c. Build prompt (system: taxonomy; user: From + Subject + body).
   d. POST to `http://localhost:11434/api/chat` with `format: "json"`.
   e. Parse classification, validate against taxonomy.
   f. Write `{ messageId, from, subject, action, labelIdsToAdd, labelIdsToRemove }` to `chrome.storage.local`.
4. Panel re-renders as entries arrive.

User clicks a per-email button or `Apply all`:

1. Service worker calls `users.messages.modify` (or `trash`) with the stored label diff.
2. On success, remove entry from `chrome.storage.local` (or mark applied).
3. Panel updates.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Local Ollama latency on 50 emails | Small concurrency; show progress; user can stop |
| Hallucinated / invalid categories | Ollama `format: "json"` + schema validation; fall back to "leave alone" on parse failure |
| Gmail API rate limits | Small concurrency; exponential backoff on 429 |
| Superstar label IDs may not be writable | Verify early; fall back to custom colored user labels |
| CORS failure when `OLLAMA_ORIGINS` missing | Detect in service worker and surface actionable error in panel |
| Destructive misclassification | Default taxonomy to safe actions (label only); user opts in to archive / trash; nothing applied until user clicks |
| Panel state lost on close | State lives in `chrome.storage`; panel is a pure view |

## Build order

1. Skeleton extension. Toolbar icon opens side panel. Static panel content.
2. OAuth working. Log access token from service worker.
3. Gmail API: list inbox, render From + Subject in the panel.
4. Ollama call: classify one email end-to-end, log result.
5. Wire classification → storage → panel renders suggested action as button.
6. Single-action apply button works (e.g. Archive).
7. Apply-all button. Concurrency. Progress feedback.
8. Options page. Settings in `chrome.storage.sync`.
9. Verify whether superstar label IDs are writable; decide on fallback.
10. Polish: CORS-failure detection, error toasts in panel, dry-run mode.

## Out of scope (v1)

- Content-script-based inline buttons in the Gmail DOM.
- Gmail Pub/Sub push notifications.
- Auto-reply / sending mail.
- Automatic / scheduled classification.
- Multiple Gmail accounts.
- Non-Ollama LLM providers.
- Mobile / Gmail app (extension runs in desktop Chrome/Brave only).
- Gmail views other than the inbox list.
