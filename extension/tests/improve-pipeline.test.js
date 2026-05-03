import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChromeShim, uninstallChromeShim } from "./chrome-shim.js";

let pipeline, store;
async function freshImport() {
  const bust = "?t=" + Math.random();
  pipeline = await import("../background/pipeline.js" + bust);
  store    = await import("../background/storage.js" + bust);
}

describe("pipeline.improvePrompt", () => {
  let shim;
  let origFetch;
  let fetchCalls;
  beforeEach(async () => {
    origFetch = globalThis.fetch;
    shim = installChromeShim();
    await freshImport();
    fetchCalls = [];
    // Default fetch: respond as Ollama with a valid rewritten-rules JSON
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (String(url).includes("11434")) {
        return new Response(JSON.stringify({
          message: { content: JSON.stringify({ rules: "Archive newsletters\nStar: Red urgent" }) },
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    shim.storage.local.set("disagreements", [{
      emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
      from: "Mom", subject: "Hi", snippet: "x", ts: 1,
    }]);
    shim.storage.sync.set("settings", { ollamaModel: "test", rules: "Old rules" });
  });
  afterEach(() => { uninstallChromeShim(); globalThis.fetch = origFetch; });

  test("success: writes new rules, clears disagreements, clears IMPROVE_ERROR", async () => {
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, true);

    const settings = await store.getSettings();
    assert.match(settings.rules, /Archive newsletters/);

    assert.deepEqual(await store.getDisagreements(), []);
    assert.equal(await store.getImproveError(), null);
    assert.equal(await store.getImproving(), false);
  });

  test("validation failure (no-action) preserves rules and disagreements, sets IMPROVE_ERROR", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ rules: "be helpful" }) },
    }), { status: 200 });

    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "no-action");

    const settings = await store.getSettings();
    assert.equal(settings.rules, "Old rules");

    const dis = await store.getDisagreements();
    assert.equal(dis.length, 1);

    const err = await store.getImproveError();
    assert.equal(err.kind, "no-action");
    assert.equal(await store.getImproving(), false);
  });

  test("CORS error preserves rules and disagreements, sets IMPROVE_ERROR", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "cors");

    const settings = await store.getSettings();
    assert.equal(settings.rules, "Old rules");
    assert.equal((await store.getDisagreements()).length, 1);
    assert.equal((await store.getImproveError()).kind, "cors");
  });

  test("busy guard: classifyProgress.classifying=true → returns busy", async () => {
    shim.storage.session.set("classifyProgress", { classifying: true, progress: 0, total: 5 });
    const r = await pipeline.improvePrompt();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "busy");
    // No state mutations
    assert.equal((await store.getDisagreements()).length, 1);
    assert.equal(await store.getImproveError(), null);
  });

  test("busy guard: a second concurrent call returns busy", async () => {
    const a = pipeline.improvePrompt();
    const b = await pipeline.improvePrompt();
    assert.equal(b.ok, false);
    assert.equal(b.error.kind, "busy");
    await a;
  });

  test("success path triggers a classifyInbox run (token requested)", async () => {
    await pipeline.improvePrompt();
    // classifyInbox calls fetchInbox → list inbox; we can't easily verify it
    // ran end-to-end without more shimming, but we can assert classifyProgress
    // was touched (set/cleared) by the time improvePrompt returns.
    const cp = shim.storage.session.get("classifyProgress");
    assert.ok(cp !== undefined, "classifyInbox should have set classifyProgress");
  });
});
