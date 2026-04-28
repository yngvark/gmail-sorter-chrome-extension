// Builds the classification prompt, validates the model's JSON response,
// and maps the chosen action to a Gmail label-diff that callers pass to
// gmail.modifyLabels().
//
// The prompt is intentionally terse: small models struggle with long
// instructions. We ask for strict JSON with one field.

import { ACTIONS, SAFE_FALLBACK_ACTION } from "../lib/schema.js";
import { chat, OllamaError } from "./ollama.js";

// ------------------------ Prompt ------------------------

export function buildMessages({ rules, email }) {
  const actionList = ACTIONS.map((a) => `  - ${a}`).join("\n");
  const system = `You classify emails. Choose exactly one action from this list for each email:

${actionList}

Rules:
${rules}

Respond with strict JSON: {"action": "<one of the actions above>"}. No prose. No explanation.`;

  const body = email.body ? email.body.slice(0, 4000) : "";
  const user = `From: ${email.from || "(unknown)"}
Subject: ${email.subject || "(no subject)"}
${email.snippet ? `Snippet: ${email.snippet.slice(0, 400)}` : ""}
${body ? `\nBody:\n${body}` : ""}`;

  return [
    { role: "system", content: system },
    { role: "user",   content: user },
  ];
}

// ------------------------ Response parsing ------------------------

export function parseClassification(raw) {
  const obj = typeof raw === "string" ? tryJson(raw) : raw;
  if (!obj || typeof obj !== "object") {
    return { action: SAFE_FALLBACK_ACTION, fallback: "parse" };
  }
  const action = String(obj.action || "").trim();
  if (!ACTIONS.includes(action)) {
    return { action: SAFE_FALLBACK_ACTION, fallback: "unknown-action", original: action };
  }
  return { action };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ------------------------ End-to-end classify ------------------------

export async function classifyEmail({ settings, email }) {
  const messages = buildMessages({ rules: settings.rules, email });
  try {
    const { json, raw } = await chat({
      baseUrl: settings.ollamaBaseUrl,
      model:   settings.ollamaModel,
      numCtx:  settings.numCtx,
      messages,
    });
    const parsed = parseClassification(json ?? raw);
    return { ok: true, ...parsed };
  } catch (err) {
    if (err instanceof OllamaError) {
      return { ok: false, error: { kind: err.kind, message: err.message, hint: err.hint } };
    }
    return { ok: false, error: { kind: "unknown", message: String(err?.message || err) } };
  }
}

// ------------------------ Action → Gmail diff ------------------------

export function actionToLabelDiff(action, { followUpLabelId } = {}) {
  // Trim incoming action so trivial whitespace from the model (e.g. "Archive ")
  // doesn't fall through to the unmapped branch. We deliberately do NOT
  // lowercase: case mismatches indicate a real model bug and we want them
  // surfaced as `unmapped` rather than silently coerced.
  const normalized = String(action ?? "").trim();
  switch (normalized) {
    case "Star":             return { add: ["STARRED"],         remove: ["INBOX"] };
    case "Archive":          return { add: [],                   remove: ["INBOX"] };
    case "Mark read":        return { add: [],                   remove: ["UNREAD"] };
    case "Move: Follow-up":  return {
      add: followUpLabelId ? [followUpLabelId] : [],
      remove: ["INBOX"],
      needsFollowUpLabel: !followUpLabelId,
    };
    case "Leave alone":      return { add: [], remove: [], noop: true };
    // Unmapped: distinguishable from "Leave alone" via `unmapped: true` so
    // pipeline.applyOne can refuse to silently delete the suggestion. The
    // diagnostic event in pipeline.js surfaces the offending action string.
    default:                 return { add: [], remove: [], noop: true, unmapped: true };
  }
}
