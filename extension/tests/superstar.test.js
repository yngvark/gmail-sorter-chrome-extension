// Unit test for gmail.probeSuperstar: verifies it does a modify-add then
// read-back and reports writability based on whether the label id appears
// in labelIds after the round-trip.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { probeSuperstar, SUPERSTAR_IDS } from "../background/gmail.js";

describe("probeSuperstar", () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  test("reports writable:true when the label id appears after modify", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, method: opts.method || "GET", body: opts.body });
      if (url.includes("/modify")) return new Response("{}", { status: 200 });
      // getMessageMetadata
      return new Response(JSON.stringify({
        id: "m1",
        labelIds: ["INBOX", "^ss_sr"],
        payload: { headers: [] },
      }), { status: 200 });
    };

    const r = await probeSuperstar("tok", "m1", "red");
    assert.equal(r.writable, true);
    assert.equal(r.labelId, "^ss_sr");
    assert.deepEqual(r.labelIdsAfter, ["INBOX", "^ss_sr"]);

    // Two modifies (add + cleanup remove) + one metadata read = 3 calls.
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /\/messages\/m1\/modify$/);
    assert.deepEqual(JSON.parse(calls[0].body), {
      addLabelIds: ["^ss_sr"], removeLabelIds: [],
    });
    assert.match(calls[1].url, /\/messages\/m1\?format=metadata/);
    assert.match(calls[2].url, /\/messages\/m1\/modify$/);
    assert.deepEqual(JSON.parse(calls[2].body), {
      addLabelIds: [], removeLabelIds: ["^ss_sr"],
    });
  });

  test("reports writable:false when the label isn't on the message after add", async () => {
    globalThis.fetch = async (url) => {
      if (url.includes("/modify")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({
        id: "m1",
        labelIds: ["INBOX"],
        payload: { headers: [] },
      }), { status: 200 });
    };
    const r = await probeSuperstar("tok", "m1", "blue");
    assert.equal(r.writable, false);
    assert.equal(r.labelId, SUPERSTAR_IDS.blue);
  });

  test("unknown variant throws", async () => {
    await assert.rejects(
      () => probeSuperstar("tok", "m1", "chartreuse"),
      /unknown superstar variant/,
    );
  });
});
