import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "../background/pipeline.js";

describe("mapWithConcurrency", () => {
  test("respects the limit (never more than N in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    assert.equal(peak, 4);
  });

  test("preserves item order in results", async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await mapWithConcurrency(items, 3, async (x) => {
      // Invert delay so later items finish first
      await new Promise((r) => setTimeout(r, 20 - x / 10));
      return x * 2;
    });
    assert.deepEqual(result, [20, 40, 60, 80, 100]);
  });

  test("collects errors in the result without aborting the pool", async () => {
    const items = ["ok", "fail", "ok"];
    const result = await mapWithConcurrency(items, 2, async (x) => {
      if (x === "fail") throw new Error("boom");
      return x;
    });
    assert.equal(result[0], "ok");
    assert.ok(result[1]._error instanceof Error);
    assert.equal(result[1]._error.message, "boom");
    assert.equal(result[2], "ok");
  });

  test("works with empty input", async () => {
    const result = await mapWithConcurrency([], 4, async () => 1);
    assert.deepEqual(result, []);
  });
});
