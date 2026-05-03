import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { actionPillContent, ACTION_ICONS } from "../sidepanel/sidepanel-pill.js";
import { ACTIONS } from "../lib/schema.js";

describe("actionPillContent", () => {
  test("Star: Yellow has the yellow-star glyph", () => {
    assert.match(actionPillContent("Star: Yellow"), /★/);
  });
  test("Star: Red bang has the bang glyph", () => {
    assert.match(actionPillContent("Star: Red bang"), /❗/);
  });
  test("non-star actions render verbatim", () => {
    assert.equal(actionPillContent("Archive"), "Archive");
  });
});

describe("ACTION_ICONS", () => {
  test("has an entry for every action in ACTIONS", () => {
    for (const a of ACTIONS) {
      assert.ok(ACTION_ICONS[a], `missing icon for "${a}"`);
      assert.equal(typeof ACTION_ICONS[a], "string");
    }
  });
});
