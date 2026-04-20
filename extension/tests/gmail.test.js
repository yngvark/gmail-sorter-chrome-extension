import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  decodeBase64Url,
  extractBody,
  stripHtml,
  headerValue,
  listInboxIds,
  modifyLabels,
  getMessageMetadata,
} from "../background/gmail.js";

// ------------------------ decodeBase64Url ------------------------

describe("decodeBase64Url", () => {
  test("round-trips ASCII", () => {
    // "Hello, world!" in base64url
    assert.equal(decodeBase64Url("SGVsbG8sIHdvcmxkIQ"), "Hello, world!");
  });
  test("handles UTF-8 (æ, ø, Å)", () => {
    // "Håken" (contains á-range) → base64url
    assert.equal(decodeBase64Url("SMOla2Vu"), "Håken");
  });
  test("handles - and _ substitutions", () => {
    // "?>?" base64 = "Pz4_" (has -/_ variants)
    const raw = "subject=?utf-8?";
    const b64 = Buffer.from(raw, "utf8").toString("base64url");
    assert.equal(decodeBase64Url(b64), raw);
  });
  test("empty input returns empty", () => {
    assert.equal(decodeBase64Url(""), "");
    assert.equal(decodeBase64Url(null), "");
  });
});

// ------------------------ stripHtml ------------------------

describe("stripHtml", () => {
  test("strips tags and entities", () => {
    assert.equal(
      stripHtml("<p>Hello &amp; <b>world</b>&nbsp;!</p>"),
      "Hello & world !",
    );
  });
  test("drops <style> and <script>", () => {
    assert.equal(
      stripHtml("<style>a{color:red}</style><p>x</p><script>evil()</script>"),
      "x",
    );
  });
  test("collapses whitespace", () => {
    assert.equal(stripHtml("<p>a\n\n    b</p>"), "a b");
  });
});

// ------------------------ headerValue ------------------------

describe("headerValue", () => {
  test("is case-insensitive", () => {
    const m = { payload: { headers: [{ name: "From", value: "a@b.c" }] } };
    assert.equal(headerValue(m, "from"), "a@b.c");
    assert.equal(headerValue(m, "FROM"), "a@b.c");
  });
  test("returns empty string when missing", () => {
    assert.equal(headerValue({}, "From"), "");
  });
});

// ------------------------ extractBody ------------------------

describe("extractBody", () => {
  test("prefers text/plain in multipart/alternative", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html",  body: { data: Buffer.from("<p>HTML</p>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from("PLAIN").toString("base64url") } },
      ],
    };
    assert.equal(extractBody(payload), "PLAIN");
  });

  test("falls back to stripped text/html", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>Hi <b>there</b></p>").toString("base64url") } },
      ],
    };
    assert.equal(extractBody(payload), "Hi there");
  });

  test("drills into nested multipart", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("deep").toString("base64url") } },
          ],
        },
        { mimeType: "application/pdf", body: { attachmentId: "x" } },
      ],
    };
    assert.equal(extractBody(payload), "deep");
  });

  test("empty payload returns empty string", () => {
    assert.equal(extractBody(null), "");
    assert.equal(extractBody({}), "");
  });
});

// ------------------------ URL / fetch integration ------------------------

describe("Gmail fetch endpoints", () => {
  let fetchCalls;
  let origFetch;

  beforeEach(() => {
    fetchCalls = [];
    origFetch = globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  function mockFetch(handler) {
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return handler(url, opts);
    };
  }

  test("listInboxIds builds correct URL and returns id list", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ messages: [{ id: "a" }, { id: "b" }] }),
      { status: 200 },
    ));
    const ids = await listInboxIds("tok", { maxResults: 5 });
    assert.deepEqual(ids, ["a", "b"]);
    const u = new URL(fetchCalls[0].url);
    assert.equal(u.pathname, "/gmail/v1/users/me/messages");
    assert.equal(u.searchParams.get("q"), "in:inbox");
    assert.equal(u.searchParams.get("maxResults"), "5");
    assert.equal(fetchCalls[0].opts.headers.Authorization, "Bearer tok");
  });

  test("modifyLabels posts diff body", async () => {
    mockFetch(async () => new Response("{}", { status: 200 }));
    await modifyLabels("tok", "m1", { add: ["STARRED"], remove: ["INBOX"] });
    const call = fetchCalls[0];
    assert.equal(call.opts.method, "POST");
    assert.deepEqual(JSON.parse(call.opts.body), {
      addLabelIds: ["STARRED"],
      removeLabelIds: ["INBOX"],
    });
    assert.equal(call.opts.headers["Content-Type"], "application/json");
  });

  test("modifyLabels short-circuits on empty diff", async () => {
    mockFetch(async () => { throw new Error("should not be called"); });
    const r = await modifyLabels("tok", "m1", { add: [], remove: [] });
    assert.equal(r, null);
    assert.equal(fetchCalls.length, 0);
  });

  test("retries on 429 honoring Retry-After", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "rate" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    const t0 = Date.now();
    await listInboxIds("tok", { maxResults: 1 });
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 < 500, "zero Retry-After shouldn't cause long sleep");
  });

  test("401 throws typed auth error", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ error: { message: "invalid creds" } }),
      { status: 401 },
    ));
    await assert.rejects(
      () => getMessageMetadata("tok", "m1"),
      (e) => {
        assert.equal(e.status, 401);
        assert.equal(e.kind, "auth");
        return true;
      },
    );
  });
});
