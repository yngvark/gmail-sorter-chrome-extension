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
    seedInbox(shim.storage, [
      { id: "m1", from: "Stripe", subject: "Receipt", body: "x" },
      { id: "m2", from: "Sam",    subject: "Coffee?",  body: "y" },
    ]);

    // Ollama mock: m1 → Archive, m2 → Star. Route by request body.
    mockFetch(async (url, opts) => {
      const msg = JSON.parse(opts.body).messages.find((m) => m.role === "user");
      const action = msg.content.includes("Stripe") ? "Archive" : "Star";
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ action }) } }),
        { status: 200 },
      );
    });

    const result = await pipeline.classifyInbox();
    assert.equal(result.started, true);
    assert.equal(result.total, 2);
    assert.equal(result.done, 2);

    const suggestions = await store.getSuggestions();
    assert.deepEqual(Object.keys(suggestions).sort(), ["m1", "m2"]);
    assert.equal(suggestions.m1.action, "Archive");
    assert.equal(suggestions.m2.action, "Star");

    const progress = shim.storage.session.get("classifyProgress");
    assert.equal(progress.classifying, false);
    assert.equal(progress.progress, 2);
    assert.equal(progress.total, 2);

    assert.equal(shim.storage.local.get("hasClassified"), true);
  });

  test("Leave alone does not create a suggestion", async () => {
    seedInbox(shim.storage, [
      { id: "m1", from: "Calendar", subject: "Reminder", body: "x" },
    ]);
    mockFetch(async () => new Response(
      JSON.stringify({ message: { content: JSON.stringify({ action: "Leave alone" }) } }),
      { status: 200 },
    ));

    await pipeline.classifyInbox();
    const suggestions = await store.getSuggestions();
    assert.deepEqual(suggestions, {});
  });

  test("CORS error aborts the run and writes session.lastError", async () => {
    seedInbox(shim.storage, [
      { id: "m1", from: "a", subject: "b", body: "c" },
      { id: "m2", from: "d", subject: "e", body: "f" },
    ]);
    mockFetch(async () => { throw new TypeError("Failed to fetch"); });

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
    seedInbox(shim.storage, [
      { id: "m1", from: "a", subject: "b", body: "c" },
      { id: "m2", from: "d", subject: "e", body: "f" },
    ]);
    shim.storage.local.set("suggestions", {
      m1: { emailId: "m1", from: "a", subject: "b", action: "Star" },
    });

    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ action: "Archive" }) } }),
        { status: 200 },
      );
    });

    const result = await pipeline.classifyInbox();
    assert.equal(result.total, 1, "only m2 should be in todo");
    assert.equal(callCount, 1);

    const suggestions = await store.getSuggestions();
    assert.equal(suggestions.m1.action, "Star", "existing suggestion preserved");
    assert.equal(suggestions.m2.action, "Archive", "new suggestion added");
  });

  test("double-invocation while in flight returns already-running", async () => {
    seedInbox(shim.storage, [{ id: "m1", from: "x", subject: "y", body: "z" }]);
    let resolveFetch;
    mockFetch(() => new Promise((r) => { resolveFetch = r; }));

    const a = pipeline.classifyInbox();
    // Give the first call time to reach the in-flight guard
    await new Promise((r) => setTimeout(r, 10));
    const b = await pipeline.classifyInbox();
    assert.equal(b.started, false);
    assert.equal(b.reason, "already-running");

    resolveFetch(new Response(
      JSON.stringify({ message: { content: JSON.stringify({ action: "Archive" }) } }),
      { status: 200 },
    ));
    await a;
  });
});
