// Gmail REST API client.
// Only the endpoints we actually use. No caching — the service worker may be
// torn down between calls, so callers hold the token.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ------------------------ Core fetch with backoff ------------------------

async function gfetch(url, { token, method = "GET", body, headers = {} } = {}) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  let attempt = 0;
  while (true) {
    const res = await fetch(url, opts);
    if (res.ok) return res.json();

    // 429 / 503: back off and retry
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 400 * Math.pow(2, attempt);
      await sleep(wait);
      attempt++;
      continue;
    }

    // 401 → token likely expired; surface as typed error so caller can refresh.
    const payload = await safeJson(res);
    const message = payload?.error?.message || res.statusText;
    const err = new Error(`Gmail ${res.status}: ${message}`);
    err.status = res.status;
    err.kind = res.status === 401 ? "auth" : "gmail";
    throw err;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function safeJson(res) { try { return await res.json(); } catch { return null; } }

// ------------------------ Public API ------------------------

export async function listInboxIds(token, { maxResults = 50, q = "in:inbox" } = {}) {
  const u = new URL(`${BASE}/messages`);
  u.searchParams.set("q", q);
  u.searchParams.set("maxResults", String(maxResults));
  const body = await gfetch(u.toString(), { token });
  return (body.messages || []).map((m) => m.id);
}

export async function getMessageMetadata(token, id) {
  const u = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
  u.searchParams.set("format", "metadata");
  u.searchParams.append("metadataHeaders", "From");
  u.searchParams.append("metadataHeaders", "Subject");
  const m = await gfetch(u.toString(), { token });
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    snippet: m.snippet || "",
    from:    headerValue(m, "From"),
    subject: headerValue(m, "Subject"),
  };
}

export async function getMessageFull(token, id) {
  const u = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
  u.searchParams.set("format", "full");
  const m = await gfetch(u.toString(), { token });
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    snippet: m.snippet || "",
    from:    headerValue(m, "From"),
    subject: headerValue(m, "Subject"),
    body:    extractBody(m.payload),
  };
}

export async function modifyLabels(token, id, { add = [], remove = [] } = {}) {
  if (add.length === 0 && remove.length === 0) return null;
  const u = `${BASE}/messages/${encodeURIComponent(id)}/modify`;
  return gfetch(u, {
    token,
    method: "POST",
    body: { addLabelIds: add, removeLabelIds: remove },
  });
}

export async function batchModify(token, ids, { add = [], remove = [] } = {}) {
  if (ids.length === 0) return null;
  const u = `${BASE}/messages/batchModify`;
  return gfetch(u, {
    token,
    method: "POST",
    body: { ids, addLabelIds: add, removeLabelIds: remove },
  });
}

export async function listLabels(token) {
  const body = await gfetch(`${BASE}/labels`, { token });
  return body.labels || [];
}

export async function createLabel(token, { name, color } = {}) {
  return gfetch(`${BASE}/labels`, {
    token,
    method: "POST",
    body: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      ...(color ? { color } : {}),
    },
  });
}

// ------------------------ Header + body parsing ------------------------

export function headerValue(m, name) {
  const hs = m?.payload?.headers || [];
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

// Prefer text/plain; fall back to a stripped text/html. Handles nested
// multipart/alternative and multipart/mixed. `DOMParser` isn't available in
// service workers, so the HTML stripper is intentionally tiny and
// regex-based — it's a first-pass for classification, not a renderer.
export function extractBody(payload) {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain.body?.data || "");
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBase64Url(html.body?.data || ""));
  return "";
}

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part;
  if (part.parts) {
    for (const p of part.parts) {
      const hit = findPart(p, mime);
      if (hit) return hit;
    }
  }
  return null;
}

export function decodeBase64Url(s) {
  if (!s) return "";
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "===".slice((padded.length + 3) % 4));
  // Decode as UTF-8
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

export function stripHtml(s) {
  if (!s) return "";
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
