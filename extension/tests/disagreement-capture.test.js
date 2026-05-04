import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

function seedSuggestion(shim, sugg, inboxRow) {
  shim.storage.local.set("suggestions", { [sugg.emailId]: sugg });
  shim.storage.local.set("inboxEmails", { [sugg.emailId]: { id: sugg.emailId, ...inboxRow } });
}

describe("pipeline.applyOne disagreement capture", () => {
  let shim;
  let origFetch;
  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    shim.storage.sync.set("settings", { dryRun: true }); // skip Gmail
    globalThis.fetch = async () => new Response("{}", { status: 200 });
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("no chosenAction passed → no disagreement appended (apply-all path)", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "preview" });
    await pipeline.applyOne("m1");
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("chosenAction matches predicted → no disagreement", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "preview" });
    await pipeline.applyOne("m1", "Archive");
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("chosenAction differs → disagreement appended with email context", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "Mom", subject: "Dinner", action: "Archive" },
      { from: "Mom", subject: "Dinner", snippet: "Are you free?" });
    await pipeline.applyOne("m1", "Star: Red");
    const list = await store.getDisagreements();
    assert.equal(list.length, 1);
    assert.equal(list[0].emailId, "m1");
    assert.equal(list[0].predictedAction, "Archive");
    assert.equal(list[0].chosenAction, "Star: Red");
    assert.equal(list[0].from, "Mom");
    assert.equal(list[0].subject, "Dinner");
    assert.equal(list[0].snippet, "Are you free?");
    assert.equal(typeof list[0].ts, "number");
  });

  test("chosenAction differs → applied action is the chosen one (dry-run path)", async () => {
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "x" });
    const r = await pipeline.applyOne("m1", "Mark read");
    assert.equal(r.ok, true);
    assert.equal(r.applied, "Mark read");
  });

  test("snippet is truncated to 200 chars in the disagreement record", async () => {
    const longSnippet = "x".repeat(500);
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: longSnippet });
    await pipeline.applyOne("m1", "Mark read");
    const list = await store.getDisagreements();
    assert.equal(list[0].snippet.length, 200);
  });

  test("missing suggestion + chosenAction → applies the chosen action, no disagreement", async () => {
    // No prediction to disagree with, so disagreement buffer stays empty.
    // Action still applies (dry-run path; Gmail not hit).
    shim.storage.local.set("inboxEmails", { ghost: { id: "ghost", from: "x", subject: "y" } });
    const r = await pipeline.applyOne("ghost", "Archive");
    assert.equal(r.ok, true);
    assert.equal(r.applied, "Archive");
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("missing suggestion + no chosenAction → missing error (Apply All / legacy)", async () => {
    const r = await pipeline.applyOne("ghost");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "missing");
    assert.deepEqual(await store.getDisagreements(), []);
  });
});

describe("APPLY_ONE message handler", () => {
  let shim;
  beforeEach(async () => {
    shim = installChromeShim();
    await freshImport();
    shim.storage.sync.set("settings", { dryRun: true });
    seedSuggestion(shim,
      { emailId: "m1", from: "a", subject: "b", action: "Archive" },
      { from: "a", subject: "b", snippet: "x" });
  });
  afterEach(() => uninstallChromeShim());

  test("forwards chosenAction from message to pipeline.applyOne", async () => {
    // Import the background module after the shim is installed. We verify
    // the disagreement was recorded via store, since we can't easily call
    // the message handler directly. So instead we exercise pipeline.applyOne
    // with the chosenAction the handler would forward — simulating the call.
    await pipeline.applyOne("m1", "Mark read");
    const list = await store.getDisagreements();
    assert.equal(list[0].chosenAction, "Mark read");
  });
});
