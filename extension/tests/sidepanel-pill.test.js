// Unit test for the actionPillContent helper that prefixes the pill text
// with a glyph for star variants and returns plain text otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { actionPillContent } from "../sidepanel/sidepanel-pill.js";

describe("actionPillContent", () => {
  test("Star: Yellow gets a ★ prefix", () => {
    assert.equal(actionPillContent("Star: Yellow"), "★ Star: Yellow");
  });
  test("Star: Red gets a ★ prefix", () => {
    assert.equal(actionPillContent("Star: Red"), "★ Star: Red");
  });
  test("Star: Red bang gets a ❗ prefix", () => {
    assert.equal(actionPillContent("Star: Red bang"), "❗ Star: Red bang");
  });
  test("Non-star actions are returned verbatim", () => {
    assert.equal(actionPillContent("Archive"), "Archive");
    assert.equal(actionPillContent("Mark read"), "Mark read");
    assert.equal(actionPillContent("Move: Follow-up"), "Move: Follow-up");
    assert.equal(actionPillContent("Leave alone"), "Leave alone");
  });
});
