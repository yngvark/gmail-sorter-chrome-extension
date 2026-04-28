// Diagnostics ring buffer: respects the settings flag, trims to the cap,
// getDiag/clearDiag round-trip. Also verifies pipeline.applyOne always
// writes to APPLY_ERRORS for any non-ok return — not just thrown errors
// from the Gmail call.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let store, pipeline;
async function freshImport() {
  const bust = "?t=" + Math.random();
  store    = await import("../background/storage.js" + bust);
  pipeline = await import("../background/pipeline.js" + bust);
}

describe("diagnostics ring buffer", () => {
  let shim;

  beforeEach(async () => {
    shim = installChromeShim();
    await freshImport();
  });
  afterEach(() => { uninstallChromeShim(); });

  test("appendDiag is a no-op when settings.diagnostics is false (default)", async () => {
    await store.appendDiag({ kind: "msg", type: "X", ok: true });
    const events = await store.getDiag();
    assert.deepEqual(events, [], "no events stored when flag off");
    // The DIAG_LOG key should not even be written.
    assert.equal(shim.storage.local.has(store.KEYS.DIAG_LOG), false);
  });

  test("appendDiag persists events when settings.diagnostics is true", async () => {
    shim.storage.sync.set("settings", { diagnostics: true });

    await store.appendDiag({ kind: "msg", type: "FETCH_INBOX", ok: true });
    await store.appendDiag({ kind: "apply_one.start", emailId: "abc", action: "Archive" });

    const events = await store.getDiag();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "msg");
    assert.equal(events[0].type, "FETCH_INBOX");
    assert.ok(typeof events[0].ts === "number" && events[0].ts > 0);
    assert.equal(events[1].kind, "apply_one.start");
    assert.equal(events[1].emailId, "abc");
  });

  test("ring buffer trims to the most-recent 200 entries", async () => {
    shim.storage.sync.set("settings", { diagnostics: true });

    // Append 250 events sequentially. Use the lock so order is deterministic.
    for (let i = 0; i < 250; i++) {
      await store.appendDiag({ kind: "msg", type: "T", ok: true, n: i });
    }

    const events = await store.getDiag();
    assert.equal(events.length, 200, "buffer capped at 200");
    // The oldest 50 should be gone, so the first remaining n is 50.
    assert.equal(events[0].n, 50);
    assert.equal(events.at(-1).n, 249);
  });

  test("clearDiag empties the buffer", async () => {
    shim.storage.sync.set("settings", { diagnostics: true });
    await store.appendDiag({ kind: "msg", type: "X", ok: true });
    assert.equal((await store.getDiag()).length, 1);

    await store.clearDiag();
    assert.deepEqual(await store.getDiag(), []);
  });

  test("getDiag returns [] when nothing has been logged yet", async () => {
    assert.deepEqual(await store.getDiag(), []);
  });

  test("never stores email content fields (from/subject/snippet/body)", async () => {
    // Defence in depth: even if a caller mistakenly passes content, the
    // event record we *intentionally* emit doesn't include those fields.
    // This test is a smoke check on what *we* write, not a sanitiser.
    shim.storage.sync.set("settings", { diagnostics: true });
    await store.appendDiag({ kind: "msg", type: "X", ok: true });
    const events = await store.getDiag();
    for (const ev of events) {
      assert.equal(ev.from,    undefined);
      assert.equal(ev.subject, undefined);
      assert.equal(ev.snippet, undefined);
      assert.equal(ev.body,    undefined);
    }
  });
});

// Helper for chrome-shim Map exposure (matches what the shim returns).
// Some assertions above use `.has` directly on the Map.
describe("pipeline.applyOne always surfaces failures via applyErrors", () => {
  let shim;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    globalThis.fetch = async () => new Response("{}", { status: 200 });
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("missing suggestion writes to APPLY_ERRORS", async () => {
    const r = await pipeline.applyOne("ghost");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "missing");

    const errors = (await store.get("local", "applyErrors", {})) || {};
    assert.ok(errors.ghost, "applyErrors entry must exist for the missing emailId");
    assert.match(errors.ghost.message, /not found|missing|Apply failed/i);
  });

  test("Gmail mutation failure still writes to APPLY_ERRORS (regression)", async () => {
    shim.storage.local.set("suggestions", {
      m1: { emailId: "m1", from: "a", subject: "b", action: "Archive" },
    });
    shim.storage.local.set("inboxEmails", { m1: { id: "m1" } });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "forbidden" } }),
      { status: 403 },
    );

    const r = await pipeline.applyOne("m1");
    assert.equal(r.ok, false);

    const errors = (await store.get("local", "applyErrors", {})) || {};
    assert.ok(errors.m1, "applyErrors entry must exist for the failed emailId");
  });
});
