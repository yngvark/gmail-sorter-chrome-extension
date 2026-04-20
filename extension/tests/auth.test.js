import { test } from "node:test";
import assert from "node:assert/strict";

import { maskToken } from "../background/auth.js";

test("maskToken returns ***  for short/empty input", () => {
  assert.equal(maskToken(""), "***");
  assert.equal(maskToken(null), "***");
  assert.equal(maskToken("short"), "***");
});

test("maskToken reveals first 6 + last 4, hides the middle", () => {
  const t = "ya29.a0AfH6SMBabcdef1234567890XYZ";
  const m = maskToken(t);
  assert.equal(m, "ya29.a…0XYZ");
  assert.ok(m.startsWith(t.slice(0, 6)));
  assert.ok(m.endsWith(t.slice(-4)));
  assert.ok(!m.includes(t.slice(10, -6)), "middle must be hidden");
});
