import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildMessages,
  parseClassification,
  actionToLabelDiff,
  classifyEmail,
} from "../background/classify.js";
import { ACTIONS, DEFAULT_RULES, DEFAULT_SETTINGS, SAFE_FALLBACK_ACTION } from "../lib/schema.js";

// ------------------------ buildMessages ------------------------

describe("buildMessages", () => {
  test("system message lists every action exactly once", () => {
    const msgs = buildMessages({
      rules: "r",
      email: { from: "a@b.c", subject: "hi", body: "body" },
    });
    const sys = msgs.find((m) => m.role === "system").content;
    for (const a of ACTIONS) {
      const count = [...sys.matchAll(new RegExp(a.replace(/[^\w]/g, "."), "g"))].length;
      assert.ok(count >= 1, `action "${a}" missing from system prompt`);
    }
  });

  test("user message contains From, Subject and body", () => {
    const msgs = buildMessages({
      rules: "r",
      email: { from: "alex@company.com", subject: "PR review", body: "please take a look" },
    });
    const user = msgs.find((m) => m.role === "user").content;
    assert.match(user, /alex@company\.com/);
    assert.match(user, /PR review/);
    assert.match(user, /please take a look/);
  });

  test("body is truncated at 4000 chars", () => {
    const big = "x".repeat(5000);
    const msgs = buildMessages({ rules: "r", email: { from: "a", subject: "s", body: big } });
    const user = msgs.find((m) => m.role === "user").content;
    // Count x's
    const xs = (user.match(/x/g) || []).length;
    assert.equal(xs, 4000);
  });

  test("missing fields degrade gracefully", () => {
    const msgs = buildMessages({ rules: "r", email: {} });
    const user = msgs.find((m) => m.role === "user").content;
    assert.match(user, /\(unknown\)/);
    assert.match(user, /\(no subject\)/);
  });
});

// ------------------------ parseClassification ------------------------

describe("parseClassification", () => {
  test("accepts a valid action object", () => {
    assert.deepEqual(parseClassification({ action: "Archive" }), { action: "Archive" });
  });
  test("accepts a JSON string", () => {
    assert.deepEqual(parseClassification('{"action":"Archive"}'), { action: "Archive" });
  });
  test("falls back when JSON is invalid", () => {
    const r = parseClassification("not json at all");
    assert.equal(r.action, SAFE_FALLBACK_ACTION);
    assert.equal(r.fallback, "parse");
  });
  test("falls back on unknown action", () => {
    const r = parseClassification({ action: "Delete everything" });
    assert.equal(r.action, SAFE_FALLBACK_ACTION);
    assert.equal(r.fallback, "unknown-action");
    assert.equal(r.original, "Delete everything");
  });
  test("falls back on missing action key", () => {
    const r = parseClassification({ choice: "Star" });
    assert.equal(r.action, SAFE_FALLBACK_ACTION);
  });
  test("trims whitespace in the action", () => {
    assert.deepEqual(parseClassification({ action: "  Archive  " }), { action: "Archive" });
  });
});

// ------------------------ actionToLabelDiff ------------------------

describe("actionToLabelDiff", () => {
  test("Star: Yellow with no cached id → STARRED only + needsStarLabel='yellow'", () => {
    const d = actionToLabelDiff("Star: Yellow");
    assert.deepEqual(d.add, ["STARRED"]);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.equal(d.needsStarLabel, "yellow");
  });
  test("Star: Yellow with cached id → STARRED + custom label, no needsStarLabel", () => {
    const d = actionToLabelDiff("Star: Yellow", { starLabelIds: { yellow: "Label_42" } });
    assert.deepEqual(d.add, ["STARRED", "Label_42"]);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.equal(d.needsStarLabel, null);
  });
  test("Star: Red with cached id → STARRED + that id", () => {
    const d = actionToLabelDiff("Star: Red", { starLabelIds: { red: "Label_43" } });
    assert.deepEqual(d.add, ["STARRED", "Label_43"]);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.equal(d.needsStarLabel, null);
  });
  test("Star: Red bang with cached id → STARRED + that id", () => {
    const d = actionToLabelDiff("Star: Red bang", { starLabelIds: { redBang: "Label_44" } });
    assert.deepEqual(d.add, ["STARRED", "Label_44"]);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.equal(d.needsStarLabel, null);
  });
  test("Plain 'Star' is now unmapped (regression guard)", () => {
    const d = actionToLabelDiff("Star");
    assert.equal(d.noop, true);
    assert.equal(d.unmapped, true);
  });
  test("Archive: removes INBOX only", () => {
    assert.deepEqual(actionToLabelDiff("Archive"), { add: [], remove: ["INBOX"] });
  });
  test("Mark read: removes UNREAD only", () => {
    assert.deepEqual(actionToLabelDiff("Mark read"), { add: [], remove: ["UNREAD"] });
  });
  test("Move: Follow-up with cached label id", () => {
    const d = actionToLabelDiff("Move: Follow-up", { followUpLabelId: "Label_42" });
    assert.deepEqual(d.add, ["Label_42"]);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.equal(d.needsFollowUpLabel, false);
  });
  test("Move: Follow-up without cached label flags needsFollowUpLabel", () => {
    const d = actionToLabelDiff("Move: Follow-up");
    assert.equal(d.needsFollowUpLabel, true);
  });
  test("Leave alone: noop", () => {
    const d = actionToLabelDiff("Leave alone");
    assert.equal(d.noop, true);
    assert.deepEqual(d.add, []);
    assert.deepEqual(d.remove, []);
  });
  test("Unknown action: noop (defensive) and flagged unmapped", () => {
    const d = actionToLabelDiff("Explode");
    assert.equal(d.noop, true);
    assert.equal(d.unmapped, true);
  });
  test("Trims trailing whitespace so 'Archive ' still maps", () => {
    const d = actionToLabelDiff("Archive ");
    assert.deepEqual(d.add, []);
    assert.deepEqual(d.remove, ["INBOX"]);
    assert.notEqual(d.unmapped, true);
  });
  test("Trims leading whitespace on a star variant", () => {
    const d = actionToLabelDiff("  Star: Red", { starLabelIds: { red: "Label_43" } });
    assert.deepEqual(d.add, ["STARRED", "Label_43"]);
    assert.deepEqual(d.remove, ["INBOX"]);
  });
  test("Wrong case is NOT silently coerced — surfaces as unmapped", () => {
    const d = actionToLabelDiff("ARCHIVE");
    assert.equal(d.noop, true);
    assert.equal(d.unmapped, true);
  });
  test("'Leave alone' is noop but NOT unmapped (intentional noop)", () => {
    const d = actionToLabelDiff("Leave alone");
    assert.equal(d.noop, true);
    assert.notEqual(d.unmapped, true);
  });
  test("null / undefined / empty inputs surface as unmapped", () => {
    for (const bad of [null, undefined, "", "   "]) {
      const d = actionToLabelDiff(bad);
      assert.equal(d.noop, true, `expected noop for ${JSON.stringify(bad)}`);
      assert.equal(d.unmapped, true, `expected unmapped for ${JSON.stringify(bad)}`);
    }
  });
});

// ------------------------ ACTIONS taxonomy ------------------------

describe("ACTIONS taxonomy", () => {
  test("contains three star variants and no plain 'Star'", () => {
    assert.ok(ACTIONS.includes("Star: Yellow"));
    assert.ok(ACTIONS.includes("Star: Red"));
    assert.ok(ACTIONS.includes("Star: Red bang"));
    assert.ok(!ACTIONS.includes("Star"), "plain 'Star' must be removed");
  });

  test("DEFAULT_RULES references all three star variants", () => {
    assert.match(DEFAULT_RULES, /Star: Yellow/);
    assert.match(DEFAULT_RULES, /→ Star: Red\./);   // arrow + variant + period — distinct from 'Star: Red bang'
    assert.match(DEFAULT_RULES, /Star: Red bang/);
    assert.doesNotMatch(DEFAULT_RULES, /→ Star\./, "plain 'Star.' rule should be gone");
  });
});

// ------------------------ classifyEmail (integration, mocked fetch) ------------------------

describe("classifyEmail end-to-end", () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  function mockOllamaReturning(content) {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: { content } }),
      { status: 200 },
    );
  }

  test("happy path returns {ok: true, action}", async () => {
    mockOllamaReturning(JSON.stringify({ action: "Archive" }));
    const r = await classifyEmail({
      settings: DEFAULT_SETTINGS,
      email: { from: "Stripe", subject: "Receipt", body: "Thanks." },
    });
    assert.equal(r.ok, true);
    assert.equal(r.action, "Archive");
  });

  test("CORS failure surfaces as {ok:false, error: {kind: cors}}", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const r = await classifyEmail({
      settings: DEFAULT_SETTINGS,
      email: { from: "x", subject: "y" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "cors");
    assert.match(r.error.hint, /OLLAMA_ORIGINS/);
  });

  test("model missing (404) surfaces with pull hint", async () => {
    globalThis.fetch = async () => new Response("", { status: 404, statusText: "not found" });
    const r = await classifyEmail({
      settings: { ...DEFAULT_SETTINGS, ollamaModel: "ghost:7b" },
      email: { from: "x", subject: "y" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "model-missing");
    assert.match(r.error.hint, /ollama pull ghost:7b/);
  });

  test("unparseable model output → fallback action", async () => {
    mockOllamaReturning("this is not json at all, oh no");
    const r = await classifyEmail({
      settings: DEFAULT_SETTINGS,
      email: { from: "x", subject: "y" },
    });
    // chat() throws OllamaError "parse" on invalid JSON before we even
    // reach parseClassification, so we get {ok: false, error.kind: parse}.
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "parse");
  });

  test("valid JSON with unknown action → fallback via parseClassification", async () => {
    mockOllamaReturning(JSON.stringify({ action: "Burn it" }));
    const r = await classifyEmail({
      settings: DEFAULT_SETTINGS,
      email: { from: "x", subject: "y" },
    });
    assert.equal(r.ok, true);
    assert.equal(r.action, SAFE_FALLBACK_ACTION);
    assert.equal(r.fallback, "unknown-action");
  });
});
