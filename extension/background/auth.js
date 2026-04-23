// OAuth 2.0 Authorization Code + PKCE via chrome.identity.launchWebAuthFlow.
//
// We intentionally do NOT use chrome.identity.getAuthToken — Google rejects it
// with `Error 400: invalid_request — Custom URI scheme is not supported on
// Chrome apps` for newly-created OAuth clients. launchWebAuthFlow + PKCE works
// against a standard "Web application" OAuth client.
//
// Token storage:
//   chrome.storage.session  → access token + expiry (cleared on browser close)
//   chrome.storage.local    → refresh token + in-flight PKCE state
//
// The service worker may be torn down mid-flow; everything auth-related lives
// in storage so a revived SW can resume. An in-memory in-flight promise
// deduplicates concurrent callers during a single SW lifetime.

const AUTH_URL   = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL  = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const SESSION_KEY_ACCESS  = "auth.access";   // { token, expires_at, scope }
const LOCAL_KEY_REFRESH   = "auth.refresh";  // { token, obtained_at }
const LOCAL_KEY_PENDING   = "auth.pending";  // { code_verifier, state, created_at }

// Treat the access token as expired this many ms before its real expiry, so a
// request that starts now can still finish before the server rejects it.
const EXPIRY_SKEW_MS = 60 * 1000;

let inflight = null;

export async function getToken({ interactive = true } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    try { return await getTokenImpl({ interactive }); }
    finally { inflight = null; }
  })();
  return inflight;
}

async function getTokenImpl({ interactive }) {
  const cached = await readAccess();
  if (cached && isFresh(cached)) return cached.token;

  const refresh = await readRefresh();
  if (refresh) {
    try {
      const next = await refreshAccessToken(refresh.token);
      await writeAccess(next);
      return next.token;
    } catch {
      // Refresh token rejected (revoked, expired, scope change). Drop it and
      // fall through to either interactive auth or an error.
      await clearRefresh();
    }
  }

  if (!interactive) throw authError("no valid token; interactive auth required");

  const fresh = await runInteractiveAuth();
  return fresh.token;
}

async function runInteractiveAuth() {
  const { client_id, client_secret, scopes } = readManifestOAuthConfig();
  const redirect_uri  = chrome.identity.getRedirectURL();
  const code_verifier = generateCodeVerifier();
  const code_challenge = await deriveCodeChallenge(code_verifier);
  const state = randomString(32);

  await chrome.storage.local.set({
    [LOCAL_KEY_PENDING]: { code_verifier, state, created_at: Date.now() },
  });

  const url = buildAuthUrl({ client_id, redirect_uri, scopes, code_challenge, state });

  let redirectUrl;
  try {
    redirectUrl = await launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    await chrome.storage.local.remove(LOCAL_KEY_PENDING);
    throw authError(err.message || "launchWebAuthFlow failed");
  }

  const { code, returnedState, error } = parseAuthResponse(redirectUrl);
  if (error) {
    await chrome.storage.local.remove(LOCAL_KEY_PENDING);
    throw authError(`oauth error: ${error}`);
  }
  if (returnedState !== state) {
    await chrome.storage.local.remove(LOCAL_KEY_PENDING);
    throw authError("oauth state mismatch");
  }

  const tokenResponse = await exchangeCode({ client_id, client_secret, redirect_uri, code, code_verifier });
  const access = normalizeTokenResponse(tokenResponse);
  await writeAccess(access);
  if (tokenResponse.refresh_token) await writeRefresh(tokenResponse.refresh_token);
  await chrome.storage.local.remove(LOCAL_KEY_PENDING);
  return access;
}

// ------------------------ Public helpers ------------------------

export async function signOut() {
  const access  = await readAccess();
  const refresh = await readRefresh();

  // Best-effort server-side revocation (separate requests; ignore failures).
  for (const t of [refresh?.token, access?.token].filter(Boolean)) {
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(t)}`,
      });
    } catch { /* ignore */ }
  }

  await chrome.storage.session.remove(SESSION_KEY_ACCESS);
  await chrome.storage.local.remove([LOCAL_KEY_REFRESH, LOCAL_KEY_PENDING]);

  // Defensive: users migrating from the old getAuthToken flow may have a
  // leftover Chrome-managed token cache. Drop it too. Safe to remove once
  // no more users are migrating.
  if (chrome.identity?.clearAllCachedAuthTokens) {
    await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(() => r()));
  }
}

export function maskToken(token) {
  if (!token || token.length < 10) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ------------------------ Pure helpers (exported for tests) ------------------------

export function buildAuthUrl({ client_id, redirect_uri, scopes, code_challenge, state }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client_id);
  u.searchParams.set("redirect_uri", redirect_uri);
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("code_challenge", code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");  // force refresh_token issuance
  return u.toString();
}

export function parseAuthResponse(redirectUrl) {
  const u = new URL(redirectUrl);
  return {
    code:          u.searchParams.get("code"),
    returnedState: u.searchParams.get("state"),
    error:         u.searchParams.get("error"),
  };
}

export function normalizeTokenResponse(r) {
  return {
    token:      r.access_token,
    expires_at: Date.now() + (Number(r.expires_in) || 0) * 1000,
    scope:      r.scope || "",
  };
}

export function isFresh(access, now = Date.now()) {
  return !!access && access.expires_at - now > EXPIRY_SKEW_MS;
}

export function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function deriveCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(new Uint8Array(digest));
}

// ------------------------ Internals ------------------------

function authError(message) {
  const e = new Error(message);
  e.kind = "auth";
  return e;
}

function readManifestOAuthConfig() {
  const m = chrome.runtime.getManifest();
  const client_id     = m?.oauth2?.client_id;
  const client_secret = m?.oauth2?.client_secret;
  const scopes        = m?.oauth2?.scopes || [];
  if (!client_id || client_id.startsWith("PUT_YOUR_CLIENT_ID_HERE")) {
    throw authError("manifest.oauth2.client_id is not set — see README step 4");
  }
  if (!client_secret || client_secret.startsWith("PUT_YOUR_CLIENT_SECRET_HERE")) {
    throw authError("manifest.oauth2.client_secret is not set — see README step 4");
  }
  return { client_id, client_secret, scopes };
}

async function refreshAccessToken(refresh_token) {
  const { client_id, client_secret } = readManifestOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id,
    client_secret,
    refresh_token,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  return normalizeTokenResponse(await res.json());
}

async function exchangeCode({ client_id, client_secret, redirect_uri, code, code_verifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id,
    client_secret,
    redirect_uri,
    code,
    code_verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw authError(`token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

function launchWebAuthFlow({ url, interactive }) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "launchWebAuthFlow failed"));
        return;
      }
      if (!redirectUrl) {
        reject(new Error("no redirect URL returned (user cancelled?)"));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

function base64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(n) {
  const bytes = new Uint8Array(Math.ceil((n * 3) / 4));
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes).slice(0, n);
}

async function readAccess() {
  const o = await chrome.storage.session.get(SESSION_KEY_ACCESS);
  return o[SESSION_KEY_ACCESS] || null;
}
async function writeAccess(access) {
  await chrome.storage.session.set({ [SESSION_KEY_ACCESS]: access });
}
async function readRefresh() {
  const o = await chrome.storage.local.get(LOCAL_KEY_REFRESH);
  return o[LOCAL_KEY_REFRESH] || null;
}
async function writeRefresh(token) {
  await chrome.storage.local.set({
    [LOCAL_KEY_REFRESH]: { token, obtained_at: Date.now() },
  });
}
async function clearRefresh() {
  await chrome.storage.local.remove(LOCAL_KEY_REFRESH);
}
