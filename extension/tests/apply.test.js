// Integration test: pipeline.applyOne against mocked Gmail + chrome.storage.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

function seedSuggestion(storage, s, email = {}) {
  storage.local.set("suggestions", { [s.emailId]: s });
  storage.local.set("inboxEmails", { [s.emailId]: { id: s.emailId, ...email } });
}

describe("pipeline.applyOne", () => {
  let shim;
  let origFetch;
  let fetchCalls;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      // Default: echo an empty object.
      return new Response("{}", { status: 200 });
    };
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("Archive: calls modify with remove INBOX, drops suggestion + inbox row", async () => {
    seedSuggestion(shim.storage, { emailId: "m1", from: "a", subject: "b", action: "Archive" });

    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);
    assert.equal(r.applied, "Archive");

    const call = fetchCalls[0];
    assert.match(call.url, /messages\/m1\/modify$/);
    assert.deepEqual(JSON.parse(call.opts.body), {
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });

    assert.deepEqual(await store.getSuggestions(), {});
    assert.deepEqual(await store.getInbox(), {});
  });

  test("Star: add STARRED, remove INBOX", async () => {
    seedSuggestion(shim.storage, { emailId: "m1", from: "Mom", subject: "Dinner", action: "Star" });
    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
      addLabelIds: ["STARRED"],
      removeLabelIds: ["INBOX"],
    });
  });

  test("Move: Follow-up creates label on first use and caches id", async () => {
    seedSuggestion(shim.storage, { emailId: "m1", from: "Alex", subject: "PR", action: "Move: Follow-up" });

    // First fetch: listLabels (no Follow-up yet). Second: createLabel. Third: modify.
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      seen.push({ url, method: opts.method || "GET", body: opts.body });
      if (url.endsWith("/labels") && (!opts.method || opts.method === "GET")) {
        return new Response(JSON.stringify({ labels: [] }), { status: 200 });
      }
      if (url.endsWith("/labels") && opts.method === "POST") {
        return new Response(JSON.stringify({ id: "Label_99", name: "Follow-up" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);

    // labels GET, labels POST, modify POST
    assert.equal(seen.length, 3);
    assert.match(seen[0].url, /\/labels$/); assert.equal(seen[0].method, "GET");
    assert.match(seen[1].url, /\/labels$/); assert.equal(seen[1].method, "POST");
    assert.match(seen[2].url, /\/messages\/m1\/modify$/);
    assert.deepEqual(JSON.parse(seen[2].body), {
      addLabelIds: ["Label_99"],
      removeLabelIds: ["INBOX"],
    });

    // Cached in sync storage
    assert.equal(shim.storage.sync.get("followUpLabelId"), "Label_99");
  });

  test("Move: Follow-up reuses cached label id on subsequent calls", async () => {
    shim.storage.sync.set("followUpLabelId", "Label_99");
    seedSuggestion(shim.storage, { emailId: "m1", from: "x", subject: "y", action: "Move: Follow-up" });

    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);
    // Only one call (modify) — no label list / create.
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/messages\/m1\/modify$/);
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
      addLabelIds: ["Label_99"],
      removeLabelIds: ["INBOX"],
    });
  });

  test("Leave alone: clears suggestion locally, makes no Gmail call", async () => {
    seedSuggestion(shim.storage, { emailId: "m1", from: "a", subject: "b", action: "Leave alone" });
    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);
    assert.equal(r.noop, true);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(await store.getSuggestions(), {});
  });

  test("dryRun mode skips the Gmail call but clears local state", async () => {
    shim.storage.sync.set("settings", { dryRun: true });
    seedSuggestion(shim.storage, { emailId: "m1", from: "a", subject: "b", action: "Archive" });
    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(await store.getSuggestions(), {});
  });

  test("Gmail error surfaces to applyErrors", async () => {
    seedSuggestion(shim.storage, { emailId: "m1", from: "a", subject: "b", action: "Archive" });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "forbidden" } }),
      { status: 403 },
    );

    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "gmail");

    const errors = await store.get("local", "applyErrors", {});
    assert.ok(errors.m1);
    assert.match(errors.m1.message, /403/);

    // Suggestion preserved so the user can retry.
    assert.ok((await store.getSuggestions()).m1);
  });

  test("missing suggestion returns typed error", async () => {
    const r = await pipeline.applyOne("ghost");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "missing");
  });
});
