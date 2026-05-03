import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMetaPrompt } from "../background/improve.js";
import { ACTIONS } from "../lib/schema.js";

describe("buildMetaPrompt", () => {
  const baseRules = "Newsletters → Archive";
  const baseDis = [{
    emailId: "m1",
    predictedAction: "Archive",
    chosenAction: "Star: Red",
    from: "Mom",
    subject: "Dinner?",
    snippet: "Are you free Thursday",
    ts: 1,
  }];

  test("substitutes ACTION_LIST with every action on its own line", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    for (const a of ACTIONS) assert.match(out, new RegExp(`- ${a.replace(/[^\\w]/g, ".")}`));
    assert.doesNotMatch(out, /\{ACTION_LIST\}/);
  });

  test("substitutes CURRENT_RULES with the rules string", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    assert.match(out, /Newsletters → Archive/);
    assert.doesNotMatch(out, /\{CURRENT_RULES\}/);
  });

  test("substitutes DISAGREEMENTS_BLOCK with from/subject/snippet/predicted/chosen", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: baseDis });
    assert.match(out, /Mom/);
    assert.match(out, /Dinner\?/);
    assert.match(out, /Are you free Thursday/);
    assert.match(out, /Predicted: Archive/);
    assert.match(out, /Chosen: Star: Red/);
    assert.doesNotMatch(out, /\{DISAGREEMENTS_BLOCK\}/);
  });

  test("DISAGREEMENTS_BLOCK lists multiple entries", () => {
    const out = buildMetaPrompt({
      rules: baseRules,
      disagreements: [
        { emailId: "m1", predictedAction: "Archive", chosenAction: "Star: Red",
          from: "Mom", subject: "A", snippet: "x", ts: 1 },
        { emailId: "m2", predictedAction: "Archive", chosenAction: "Mark read",
          from: "Stripe", subject: "B", snippet: "y", ts: 2 },
      ],
    });
    assert.match(out, /Mom/);
    assert.match(out, /Stripe/);
  });

  test("empty disagreements still substitutes (block is empty but placeholder is gone)", () => {
    const out = buildMetaPrompt({ rules: baseRules, disagreements: [] });
    assert.doesNotMatch(out, /\{DISAGREEMENTS_BLOCK\}/);
  });
});
