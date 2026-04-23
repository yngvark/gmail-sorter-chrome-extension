# Gmail Sorter (extension)

A Chromium extension that reads your Gmail inbox, asks a **local Ollama
model** to classify each email, and applies labels / archive / star
actions via the Gmail REST API. **No email content leaves your machine.**
Every classification and every mutation is triggered by the user —
nothing runs automatically.

Tested in Brave and Chrome.

## Prerequisites

- **Chromium-based browser** — [Chrome](https://www.google.com/chrome/) or
  [Brave](https://brave.com/download/). Other Chromium browsers should work
  but are untested.
- **Ollama** — [ollama.com/download](https://ollama.com/download) (macOS,
  Linux, Windows). The extension talks to it over `http://localhost:11434`.
- **Node.js 20+** — only if you want to run the test suite
  ([nodejs.org](https://nodejs.org/)). Not required to use the extension.

## First-time setup

Four things to wire up once. None of them need to be done again.

### 1 — Allow the extension to reach Ollama (CORS)

Chromium blocks extension requests to `localhost:11434` unless Ollama
is told which origins may talk to it.

**On macOS**, Ollama runs as a background app that auto-starts at login
(look for its llama icon in the menu bar). It already owns port 11434,
so running `ollama serve` in a terminal won't help — you need to tell
that background app to allow extension origins:

1. In Terminal, run:
   ```bash
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ```
   This sets the env var at the macOS launch-services level, so any
   process launched afterwards inherits it.
2. Click the Ollama icon in the menu bar → **Quit Ollama**.
3. Relaunch Ollama (Spotlight → "Ollama", or from Applications). It now
   picks up the env var and accepts extension requests.

**On Linux/Windows**, set `OLLAMA_ORIGINS=chrome-extension://*` in
Ollama's environment before starting the server. See the Ollama FAQ
link below for platform-specific instructions.

Why `*` and not a specific extension ID: the ID of an unpacked extension
changes when the extension is first loaded into a browser, and pinning
it in Ollama's config means updating two places whenever you reload.
Once you ship a packed extension with a stable key, you can narrow this.

Reference: [Ollama FAQ — How can I allow additional web
origins to access Ollama?](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-allow-additional-web-origins-to-access-ollama)

### 2 — Pull a model

```bash
ollama pull hf.co/NbAiLab/borealis-4b-instruct-preview-gguf:Q8_0
```

The `hf.co/` prefix tells Ollama to fetch from Hugging Face rather than
from its own registry. `:Q8_0` is the 8-bit quantization (~4 GB) — a good
quality/size tradeoff. Other tags on the same repo: `:BF16`, `:F16`
(larger, slightly higher quality).

The default model is
`hf.co/NbAiLab/borealis-4b-instruct-preview-gguf:Q8_0` (small, English-
and Norwegian-friendly). Any instruction-tuned model with decent JSON
compliance will work — change it in the options page. Smaller models
classify faster; larger models are more accurate on edge cases.

### 3 — Load the extension and record its ID

The extension's ID is derived from where Chrome/Brave first loaded it.
You need that ID in the next step, so load the extension first.

1. Copy the manifest template to its working location:
   ```bash
   cp extension/manifest.template.json extension/manifest.json
   ```
   `manifest.json` is gitignored — it holds your personal OAuth Client
   ID and must never be committed. `manifest.template.json` is the
   version checked into git (with a `PUT_YOUR_CLIENT_ID_HERE`
   placeholder).
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select this `extension/` directory.
5. Copy the extension ID shown under the extension's name. You'll
   paste it into Google Cloud in the next step.

> **Tip:** This ID changes if you ever reload from a different path or
> machine, which will break your Google OAuth redirect URI. If you plan
> to keep this installed long-term, read **Pin the extension ID across
> reloads** at the bottom of this section and do it now, before
> continuing to step 4.

### 4 — Create a Google Cloud OAuth client ID

The extension uses OAuth 2.0 Authorization Code + PKCE via
`chrome.identity.launchWebAuthFlow`. This requires a **Web application**
OAuth client (not "Chrome Extension" — Google deprecated that flow and
it now returns `Error 400: invalid_request — Custom URI scheme is not
supported on Chrome apps`).

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
   and create or pick a project.
2. **APIs & Services → Enable APIs** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → pick **External** →
   fill in the required fields.
4. **Add yourself as a test user.** On the OAuth consent screen (or
   under **Audience** in the newer UI), find the **Test users**
   section → **Add users** → enter the Gmail address you'll sign in
   with → Save. Without this, Google rejects the sign-in with
   `Error 400: invalid_request` because the app is in Testing mode
   and only listed test users are allowed.
5. **APIs & Services → Credentials → Create credentials → OAuth client
   ID**. Application type: **Web application**. Give it any name.
6. Under **Authorized redirect URIs**, add exactly:
   ```
   https://<extension-id>.chromiumapp.org/
   ```
   replacing `<extension-id>` with the ID you copied in step 3. The
   trailing slash is required.
7. Click **Create**. Copy the **Client ID** that appears.
8. Paste the Client ID into
   [`extension/manifest.json`](./manifest.json), replacing
   `PUT_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com`.
9. Back on `chrome://extensions`, click the extension's **reload**
   icon.

### 5 — Pin the extension ID (strongly recommended)

Without a `key` in `manifest.json`, the extension ID changes whenever
you load the extension from a different path or machine. That
invalidates the redirect URI you registered in step 4.

1. Generate a key. Run:
   ```bash
   openssl genrsa 2048 | openssl rsa -pubout -outform DER | base64 -w0
   ```
2. Copy the base64 output (one long line).
3. Open `extension/manifest.json`.
4. Add `"key": "<paste-the-string>"` as a top-level field.
5. Save the file.
6. On `chrome://extensions`, click the extension's **reload** icon.
7. Look at the extension's ID on `chrome://extensions`. If it's
   different from the one you used in step 4, repeat step 4 with the
   new ID — the ID is now permanent, so you'll only do this once.

Reference: [Keep consistent extension ID](https://developer.chrome.com/docs/extensions/reference/manifest/key).

## Using it

1. Click the Gmail Sorter icon in your browser's toolbar (top-right of
   the browser window; if it's not pinned, open the puzzle-piece
   extensions menu and click it there). The side panel opens. You don't
   need to be on a Gmail tab — the extension talks to the Gmail API
   directly, so any tab works.
2. Click **Classify inbox** — the extension fetches your inbox (default
   50 most recent), asks Ollama about each one, and streams suggestions
   into the panel.
3. Click an action pill (**Star**, **Archive**, **Move: Follow-up**,
   **Mark read**) to apply that action to that email.
4. Or click **Apply all** to apply every pending suggestion.

Dry-run mode in the options page lets you audit the classifier without
mutating Gmail.

## Architecture

See [`../docs/gmail-sorter-design.md`](../docs/gmail-sorter-design.md).

## Tests

```bash
npm test     # runs every unit and integration test via node:test
```

66 tests cover the Gmail client, Ollama client, classification,
pipeline orchestration (classify-inbox, apply-one, apply-all), the
Follow-up label lifecycle, and the superstar probe. The tests mock
`fetch` and `chrome.storage` via a lightweight shim — they don't
require a real Gmail account, a real Ollama, or a browser.

UI behaviour was validated manually against a local HTTP server +
Playwright during development (screenshots captured under `.scratch/`);
the extension's visible state machine is covered by the storage/pipeline
tests because the side panel is a pure view over `chrome.storage`.

## Known / to verify

- **Superstar label writability** (Gmail's coloured and iconised stars
  — internal label IDs of the form `^ss_*`). The plan flags this as
  undocumented by Google. `PROBE_SUPERSTAR` (dev button ★ in the side
  panel) runs a live check against one of your inbox messages. Record
  the result here once you've run it:

  - `^ss_sr` (red): _unverified_
  - Fallback if not writable: user-created labels named e.g.
    `🔴 Important` with a coloured background, added via `labels.create`.
