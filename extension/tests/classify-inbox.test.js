// Integration test: pipeline.classifyInbox end-to-end with mocked Gmail,
// Ollama and chrome.storage. Verifies progress writes, suggestion writes,
// Leave-alone skipping, and CORS abort behaviour.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;

async function freshImport() {
  // Bust module cache by appending a query string (works for file: URL
  // imports in Node's ESM loader).
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

function seedInbox(storage, rows) {
  const byId = {};
  for (const r of rows) byId[r.id] = r;
  storage.local.set("inboxEmails", byId);
}

// Build a fetch handler that routes Gmail metadata requests to canned
// rows and forwards everything else (Ollama) to `ollamaHandler`.
//
// classifyInbox now always re-fetches the inbox before classifying, so
// every test must answer `listInboxIds` (returns ids) and `getMessageMetadata`
// (returns from/subject) for the rows under test. We feed the metadata fetch
// the same `from`/`subject` the test seeded so the Ollama prompt is stable.
function gmailRouter(rows, ollamaHandler) {
  const byId = {};
  for (const r of rows) byId[r.id] = r;

  return async (url, opts) => {
    const u = String(url);

    // listInboxIds: GET /gmail/v1/users/me/messages?...
    if (u.includes("/gmail/v1/users/me/messages?")) {
      return new Response(
        JSON.stringify({ messages: rows.map((r) => ({ id: r.id })) }),
        { status: 200 },
      );
    }

    // getMessageMetadata: GET /gmail/v1/users/me/messages/<id>?format=metadata
    const metaMatch = u.match(/\/gmail\/v1\/users\/me\/messages\/([^/?]+)\?/);
    if (metaMatch && u.includes("format=metadata")) {
      const id = decodeURIComponent(metaMatch[1]);
      const r = byId[id];
      if (!r) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          id: r.id,
          threadId: r.id,
          labelIds: ["INBOX"],
          snippet: "",
          payload: {
            headers: [
              { name: "From", value: r.from },
              { name: "Subject", value: r.subject },
            ],
          },
        }),
        { status: 200 },
      );
    }

    // getMessageFull: GET /gmail/v1/users/me/messages/<id>?format=full
    if (metaMatch && u.includes("format=full")) {
      const id = decodeURIComponent(metaMatch[1]);
      const r = byId[id];
      if (!r) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          id: r.id,
          threadId: r.id,
          labelIds: ["INBOX"],
          snippet: "",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: r.from },
              { name: "Subject", value: r.subject },
            ],
            body: { data: Buffer.from(r.body || "").toString("base64url") },
          },
        }),
        { status: 200 },
      );
    }

    // Anything else → Ollama handler (or chat completions endpoint).
    return ollamaHandler(url, opts);
  };
}

function mockFetch(handler) { globalThis.fetch = handler; }

describe("pipeline.classifyInbox", () => {
  let shim;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
  });

  afterEach(() => {
    uninstallChromeShim();
    globalThis.fetch = origFetch;
  });

  test("writes suggestions, progress flag flips classifying to false on finish", async () => {
    const rows = [
      { id: "m1", from: "Stripe", subject: "Receipt", body: "x" },
      { id: "m2", from: "Sam",    subject: "Coffee?",  body: "y" },
    ];
    seedInbox(shim.storage, rows);

    // Ollama mock: m1 → Archive, m2 → Star: Yellow. Route by request body.
    mockFetch(gmailRouter(rows, async (_url, opts) => {
      const msg = JSON.parse(opts.body).messages.find((m) => m.role === "user");
      const action = msg.content.includes("Stripe") ? "Archive" : "Star: Yellow";
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ action }) } }),
        { status: 200 },
      );
    }));

    const result = await pipeline.classifyInbox();
    assert.equal(result.started, true);
    assert.equal(result.total, 2);
    assert.equal(result.done, 2);

    const suggestions = await store.getSuggestions();
    assert.deepEqual(Object.keys(suggestions).sort(), ["m1", "m2"]);
    assert.equal(suggestions.m1.action, "Archive");
    assert.equal(suggestions.m2.action, "Star: Yellow");

    const progress = shim.storage.session.get("classifyProgress");
    assert.equal(progress.classifying, false);
    assert.equal(progress.progress, 2);
    assert.equal(progress.total, 2);

    assert.equal(shim.storage.local.get("hasClassified"), true);
  });

  test("Leave alone does not create a suggestion", async () => {
    const rows = [
      { id: "m1", from: "Calendar", subject: "Reminder", body: "x" },
    ];
    seedInbox(shim.storage, rows);

    mockFetch(gmailRouter(rows, async () => new Response(
      JSON.stringify({ message: { content: JSON.stringify({ action: "Leave alone" }) } }),
      { status: 200 },
    )));

    await pipeline.classifyInbox();
    const suggestions = await store.getSuggestions();
    assert.deepEqual(suggestions, {});
  });

  test("CORS error aborts the run and writes session.lastError", async () => {
    const rows = [
      { id: "m1", from: "a", subject: "b", body: "c" },
      { id: "m2", from: "d", subject: "e", body: "f" },
    ];
    seedInbox(shim.storage, rows);

    mockFetch(gmailRouter(rows, async () => { throw new TypeError("Failed to fetch"); }));

    const result = await pipeline.classifyInbox();
    assert.equal(result.started, true);
    assert.equal(result.aborted, true);

    const err = shim.storage.session.get("lastError");
    assert.equal(err.kind, "cors");
    assert.match(err.hint, /OLLAMA_ORIGINS/);

    // No suggestions persisted on CORS abort
    const suggestions = await store.getSuggestions();
    assert.deepEqual(suggestions, {});
  });

  test("skips already-classified emails (idempotent re-run)", async () => {
    const rows = [
      { id: "m1", from: "a", subject: "b", body: "c" },
      { id: "m2", from: "d", subject: "e", body: "f" },
    ];
    seedInbox(shim.storage, rows);
    shim.storage.local.set("suggestions", {
      m1: { emailId: "m1", from: "a", subject: "b", action: "Star: Yellow" },
    });

    let callCount = 0;
    mockFetch(gmailRouter(rows, async () => {
      callCount++;
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ action: "Archive" }) } }),
        { status: 200 },
      );
    }));

    const result = await pipeline.classifyInbox();
    assert.equal(result.total, 1, "only m2 should be in todo");
    assert.equal(callCount, 1);

    const suggestions = await store.getSuggestions();
    assert.equal(suggestions.m1.action, "Star: Yellow", "existing suggestion preserved");
    assert.equal(suggestions.m2.action, "Archive", "new suggestion added");
  });

  test("always re-fetches inbox even when storage map is non-empty", async () => {
    // Pre-seed with a stale row that is NOT in the canonical Gmail response.
    // After classifyInbox runs, fetchInbox should have replaced inbox with
    // the freshly-listed rows, so the stale id must be gone.
    seedInbox(shim.storage, [
      { id: "stale", from: "Old", subject: "Gone", body: "z" },
    ]);

    const fresh = [
      { id: "m1", from: "Fresh", subject: "Hi", body: "x" },
    ];

    let listInboxCalls = 0;
    mockFetch(async (url, opts) => {
      const u = String(url);
      if (u.includes("/gmail/v1/users/me/messages?")) {
        listInboxCalls++;
        return new Response(
          JSON.stringify({ messages: fresh.map((r) => ({ id: r.id })) }),
          { status: 200 },
        );
      }
      // Delegate metadata / Ollama via the shared router.
      return gmailRouter(fresh, async () => new Response(
        JSON.stringify({ message: { content: JSON.stringify({ action: "Archive" }) } }),
        { status: 200 },
      ))(url, opts);
    });

    const result = await pipeline.classifyInbox();
    assert.equal(listInboxCalls, 1, "fetchInbox must run unconditionally");
    assert.equal(result.total, 1, "only the freshly-fetched row is classified");

    const inbox = await store.getInbox();
    assert.deepEqual(Object.keys(inbox).sort(), ["m1"]);
    assert.equal(inbox.stale, undefined, "stale row replaced by fresh fetch");
  });

  test("double-invocation while in flight returns already-running", async () => {
    const rows = [{ id: "m1", from: "x", subject: "y", body: "z" }];
    seedInbox(shim.storage, rows);

    let resolveOllama;
    mockFetch(gmailRouter(rows, () => new Promise((r) => { resolveOllama = r; })));

    const a = pipeline.classifyInbox();
    // Give the first call time to reach the in-flight guard
    await new Promise((r) => setTimeout(r, 10));
    const b = await pipeline.classifyInbox();
    assert.equal(b.started, false);
    assert.equal(b.reason, "already-running");

    resolveOllama(new Response(
      JSON.stringify({ message: { content: JSON.stringify({ action: "Archive" }) } }),
      { status: 200 },
    ));
    await a;
  });
});
