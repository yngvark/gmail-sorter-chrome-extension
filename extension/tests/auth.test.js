import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

// ------------------------ maskToken ------------------------

describe("maskToken", () => {
  test("returns *** for short/empty input", async () => {
    const { maskToken } = await import("../background/auth.js");
    assert.equal(maskToken(""), "***");
    assert.equal(maskToken(null), "***");
    assert.equal(maskToken("short"), "***");
  });

  test("reveals first 6 + last 4, hides the middle", async () => {
    const { maskToken } = await import("../background/auth.js");
    const t = "ya29.a0AfH6SMBabcdef1234567890XYZ";
    const m = maskToken(t);
    assert.equal(m, "ya29.a…0XYZ");
    assert.ok(m.startsWith(t.slice(0, 6)));
    assert.ok(m.endsWith(t.slice(-4)));
    assert.ok(!m.includes(t.slice(10, -6)), "middle must be hidden");
  });
});

// ------------------------ Pure helpers ------------------------

describe("buildAuthUrl", () => {
  test("emits the expected OAuth 2.0 auth-code + PKCE params", async () => {
    const { buildAuthUrl } = await import("../background/auth.js");
    const url = buildAuthUrl({
      client_id: "cid",
      redirect_uri: "https://abc.chromiumapp.org/",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      code_challenge: "ch",
      state: "st",
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("client_id"), "cid");
    assert.equal(u.searchParams.get("redirect_uri"), "https://abc.chromiumapp.org/");
    assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.modify");
    assert.equal(u.searchParams.get("code_challenge"), "ch");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("state"), "st");
    assert.equal(u.searchParams.get("access_type"), "offline");
    assert.equal(u.searchParams.get("prompt"), "consent");
  });
});

describe("parseAuthResponse", () => {
  test("extracts code + state from successful redirect", async () => {
    const { parseAuthResponse } = await import("../background/auth.js");
    const r = parseAuthResponse("https://abc.chromiumapp.org/?code=abc&state=xyz");
    assert.deepEqual(r, { code: "abc", returnedState: "xyz", error: null });
  });

  test("extracts error when redirect carries one", async () => {
    const { parseAuthResponse } = await import("../background/auth.js");
    const r = parseAuthResponse("https://abc.chromiumapp.org/?error=access_denied&state=xyz");
    assert.equal(r.error, "access_denied");
    assert.equal(r.code, null);
  });
});

describe("normalizeTokenResponse", () => {
  test("maps Google token response to internal shape", async () => {
    const { normalizeTokenResponse } = await import("../background/auth.js");
    const before = Date.now();
    const out = normalizeTokenResponse({
      access_token: "ya29.x",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
    const after = Date.now();
    assert.equal(out.token, "ya29.x");
    assert.ok(out.expires_at >= before + 3_600_000 - 10);
    assert.ok(out.expires_at <= after + 3_600_000 + 10);
    assert.equal(out.scope, "https://www.googleapis.com/auth/gmail.modify");
  });
});

describe("isFresh", () => {
  test("returns true when token has >60s life left", async () => {
    const { isFresh } = await import("../background/auth.js");
    const now = 1_000_000;
    assert.equal(isFresh({ expires_at: now + 120_000 }, now), true);
  });
  test("returns false within 60s of expiry", async () => {
    const { isFresh } = await import("../background/auth.js");
    const now = 1_000_000;
    assert.equal(isFresh({ expires_at: now + 30_000 }, now), false);
  });
  test("returns false when access is missing", async () => {
    const { isFresh } = await import("../background/auth.js");
    assert.equal(isFresh(null, Date.now()), false);
  });
});

// ------------------------ PKCE ------------------------

describe("PKCE", () => {
  test("generateCodeVerifier produces URL-safe string of reasonable length", async () => {
    const { generateCodeVerifier } = await import("../background/auth.js");
    const v = generateCodeVerifier();
    assert.ok(v.length >= 43 && v.length <= 128, `unexpected length ${v.length}`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(v), "must be URL-safe base64");
  });

  test("deriveCodeChallenge yields RFC-7636 base64url(SHA-256(verifier))", async () => {
    const { deriveCodeChallenge } = await import("../background/auth.js");
    // RFC 7636 Appendix B worked example:
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.equal(await deriveCodeChallenge(verifier), expected);
  });
});

// ------------------------ getToken integration ------------------------

// Stub fetch globally. Each test assigns its own handler.
let fetchCalls;
let fetchHandler;

function installFetchStub() {
  fetchCalls = [];
  fetchHandler = () => { throw new Error("no fetchHandler set for this test"); };
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchHandler(url, opts);
  };
}

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

async function freshAuthModule() {
  // Bust the ES-module cache so module-level `inflight` is reset per test.
  const url = new URL("../background/auth.js?t=" + Math.random(), import.meta.url).href;
  return import(url);
}

describe("getToken — happy path (interactive)", () => {
  beforeEach(() => { installChromeShim({ seedAccessToken: false }); installFetchStub(); });
  afterEach(() => { uninstallChromeShim(); delete globalThis.fetch; });

  test("runs full PKCE flow, stores access + refresh, returns access token", async () => {
    fetchHandler = (url, opts) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.ok(opts.body.includes("client_secret=test-client-secret"),
        "token exchange must include client_secret (Google Web app clients require it even with PKCE)");
      assert.ok(opts.body.includes("code_verifier="), "PKCE verifier must be included");
      return makeJsonResponse(200, {
        access_token: "access-123",
        expires_in: 3600,
        refresh_token: "refresh-456",
        scope: "https://www.googleapis.com/auth/gmail.modify",
        token_type: "Bearer",
      });
    };

    const { getToken } = await freshAuthModule();
    const t = await getToken({ interactive: true });
    assert.equal(t, "access-123");

    // Verify storage side-effects.
    const session = await globalThis.chrome.storage.session.get("auth.access");
    assert.equal(session["auth.access"].token, "access-123");
    const local = await globalThis.chrome.storage.local.get("auth.refresh");
    assert.equal(local["auth.refresh"].token, "refresh-456");
    // Pending PKCE state must be cleared.
    const pending = await globalThis.chrome.storage.local.get("auth.pending");
    assert.deepEqual(pending, {});
  });
});

describe("getToken — cached token", () => {
  beforeEach(() => { installChromeShim({ seedAccessToken: false }); installFetchStub(); });
  afterEach(() => { uninstallChromeShim(); delete globalThis.fetch; });

  test("returns cached access token without fetching or launching", async () => {
    await globalThis.chrome.storage.session.set({
      "auth.access": { token: "cached-xyz", expires_at: Date.now() + 10 * 60_000, scope: "" },
    });

    let launched = false;
    globalThis.chrome.identity.launchWebAuthFlow = () => { launched = true; };

    const { getToken } = await freshAuthModule();
    const t = await getToken({ interactive: true });
    assert.equal(t, "cached-xyz");
    assert.equal(fetchCalls.length, 0, "must not call token endpoint when cache is fresh");
    assert.equal(launched, false, "must not launch auth when cache is fresh");
  });
});

describe("getToken — silent refresh", () => {
  beforeEach(() => { installChromeShim({ seedAccessToken: false }); installFetchStub(); });
  afterEach(() => { uninstallChromeShim(); delete globalThis.fetch; });

  test("exchanges refresh token when access is expired; no interactive flow", async () => {
    await globalThis.chrome.storage.session.set({
      "auth.access": { token: "stale", expires_at: Date.now() - 1000, scope: "" },
    });
    await globalThis.chrome.storage.local.set({
      "auth.refresh": { token: "r-token", obtained_at: Date.now() - 9_000_000 },
    });

    let launched = false;
    globalThis.chrome.identity.launchWebAuthFlow = () => { launched = true; };

    fetchHandler = (_url, opts) => {
      assert.ok(opts.body.includes("grant_type=refresh_token"));
      assert.ok(opts.body.includes("refresh_token=r-token"));
      return makeJsonResponse(200, {
        access_token: "fresh-token",
        expires_in: 3600,
      });
    };

    const { getToken } = await freshAuthModule();
    const t = await getToken({ interactive: true });
    assert.equal(t, "fresh-token");
    assert.equal(launched, false);
  });

  test("falls back to interactive when refresh is rejected", async () => {
    await globalThis.chrome.storage.local.set({
      "auth.refresh": { token: "bad", obtained_at: Date.now() },
    });

    let tokenCalls = 0;
    fetchHandler = () => {
      tokenCalls++;
      if (tokenCalls === 1) return makeJsonResponse(400, { error: "invalid_grant" });
      return makeJsonResponse(200, {
        access_token: "after-interactive",
        expires_in: 3600,
        refresh_token: "new-refresh",
      });
    };

    const { getToken } = await freshAuthModule();
    const t = await getToken({ interactive: true });
    assert.equal(t, "after-interactive");
    // Refresh token must have been rotated.
    const local = await globalThis.chrome.storage.local.get("auth.refresh");
    assert.equal(local["auth.refresh"].token, "new-refresh");
  });

  test("throws auth error when refresh fails and interactive=false", async () => {
    await globalThis.chrome.storage.local.set({
      "auth.refresh": { token: "bad", obtained_at: Date.now() },
    });

    fetchHandler = () => makeJsonResponse(400, { error: "invalid_grant" });

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: false }),
      (err) => err.kind === "auth",
    );
  });
});

describe("getToken — error paths", () => {
  beforeEach(() => { installChromeShim({ seedAccessToken: false }); installFetchStub(); });
  afterEach(() => { uninstallChromeShim(); delete globalThis.fetch; });

  test("rejects with kind=auth when user cancels the flow", async () => {
    globalThis.chrome.identity.launchWebAuthFlow = (_opts, cb) => {
      globalThis.chrome.runtime.lastError = { message: "The user did not approve access." };
      cb(undefined);
      globalThis.chrome.runtime.lastError = null;
    };

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: true }),
      (err) => err.kind === "auth" && /approve|cancel|User/i.test(err.message),
    );
  });

  test("rejects with kind=auth on state mismatch", async () => {
    globalThis.chrome.identity.launchWebAuthFlow = (_opts, cb) => {
      cb("https://abc.chromiumapp.org/?code=c&state=WRONG");
    };

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: true }),
      (err) => err.kind === "auth" && /state/i.test(err.message),
    );
  });

  test("rejects with kind=auth when redirect carries error param", async () => {
    globalThis.chrome.identity.launchWebAuthFlow = (opts, cb) => {
      const state = new URL(opts.url).searchParams.get("state");
      cb(`https://abc.chromiumapp.org/?error=access_denied&state=${state}`);
    };

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: true }),
      (err) => err.kind === "auth" && /access_denied/.test(err.message),
    );
  });

  test("rejects with kind=auth when manifest client_id is the placeholder", async () => {
    installChromeShim({
      seedAccessToken: false,
      manifest: {
        oauth2: {
          client_id: "PUT_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com",
          client_secret: "anything",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
      },
    });

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: true }),
      (err) => err.kind === "auth" && /client_id/.test(err.message),
    );
  });

  test("rejects with kind=auth when manifest client_secret is the placeholder", async () => {
    installChromeShim({
      seedAccessToken: false,
      manifest: {
        oauth2: {
          client_id: "real.apps.googleusercontent.com",
          client_secret: "PUT_YOUR_CLIENT_SECRET_HERE",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
      },
    });

    const { getToken } = await freshAuthModule();
    await assert.rejects(
      () => getToken({ interactive: true }),
      (err) => err.kind === "auth" && /client_secret/.test(err.message),
    );
  });
});

// ------------------------ signOut ------------------------

describe("signOut", () => {
  beforeEach(() => { installChromeShim({ seedAccessToken: false }); installFetchStub(); });
  afterEach(() => { uninstallChromeShim(); delete globalThis.fetch; });

  test("revokes refresh + access tokens and clears storage", async () => {
    await globalThis.chrome.storage.session.set({
      "auth.access": { token: "a-tok", expires_at: Date.now() + 60_000, scope: "" },
    });
    await globalThis.chrome.storage.local.set({
      "auth.refresh": { token: "r-tok", obtained_at: Date.now() },
    });

    const revoked = [];
    fetchHandler = (url, opts) => {
      assert.equal(url, "https://oauth2.googleapis.com/revoke");
      revoked.push(opts.body);
      return makeJsonResponse(200, {});
    };

    const { signOut } = await freshAuthModule();
    await signOut();

    assert.equal(revoked.length, 2, "both tokens should be revoked");
    assert.ok(revoked.some((b) => b.includes("r-tok")));
    assert.ok(revoked.some((b) => b.includes("a-tok")));

    const session = await globalThis.chrome.storage.session.get("auth.access");
    const local = await globalThis.chrome.storage.local.get(["auth.refresh", "auth.pending"]);
    assert.deepEqual(session, {});
    assert.deepEqual(local, {});
  });

  test("tolerates revoke network failures (best-effort)", async () => {
    await globalThis.chrome.storage.local.set({
      "auth.refresh": { token: "r-tok", obtained_at: Date.now() },
    });
    fetchHandler = () => { throw new Error("network down"); };

    const { signOut } = await freshAuthModule();
    await signOut();  // must not throw

    const local = await globalThis.chrome.storage.local.get("auth.refresh");
    assert.deepEqual(local, {});
  });
});
