import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  store = await import("../background/storage.js" + bust);
}

describe("disagreement storage helpers", () => {
  beforeEach(async () => { installChromeShim(); await freshImport(); });
  afterEach(() => uninstallChromeShim());

  test("getDisagreements returns [] when key absent", async () => {
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("appendDisagreement writes a record then returns it via getDisagreements", async () => {
    const d = { emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
                from: "Mom", subject: "Hi", snippet: "Hello", ts: 1 };
    await store.appendDisagreement(d);
    assert.deepEqual(await store.getDisagreements(), [d]);
  });

  test("appendDisagreement caps at MAX_DISAGREEMENTS, dropping oldest", async () => {
    const { MAX_DISAGREEMENTS } = await import("../lib/schema.js");
    for (let i = 0; i < MAX_DISAGREEMENTS + 5; i++) {
      await store.appendDisagreement({
        emailId: "m" + i, predictedAction: "Archive", chosenAction: "Mark read",
        from: "x", subject: "y", snippet: "z", ts: i,
      });
    }
    const list = await store.getDisagreements();
    assert.equal(list.length, MAX_DISAGREEMENTS);
    // Oldest dropped: first kept entry should be index 5
    assert.equal(list[0].emailId, "m5");
    assert.equal(list[list.length - 1].emailId, "m" + (MAX_DISAGREEMENTS + 4));
  });

  test("clearDisagreements empties the list", async () => {
    await store.appendDisagreement({
      emailId: "m1", predictedAction: "Archive", chosenAction: "Mark read",
      from: "x", subject: "y", snippet: "z", ts: 1,
    });
    await store.clearDisagreements();
    assert.deepEqual(await store.getDisagreements(), []);
  });

  test("concurrent appendDisagreement calls do not lose entries", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      store.appendDisagreement({
        emailId: "m" + i, predictedAction: "Archive", chosenAction: "Mark read",
        from: "x", subject: "y", snippet: "z", ts: i,
      }));
    await Promise.all(tasks);
    const list = await store.getDisagreements();
    assert.equal(list.length, 10);
  });
});
