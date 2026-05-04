// improve.js — builds the meta-prompt used to ask the LLM to rewrite the
// rules section of the classification prompt. Validates the response and
// runs the end-to-end Improve call. Pure functions are exported for testing;
// the orchestration around them lives in pipeline.improvePrompt.

import { ACTIONS, META_PROMPT } from "../lib/schema.js";
import { chat, OllamaError } from "./ollama.js";

// ------------------------ Meta-prompt builder ------------------------

export function buildMetaPrompt({ rules, disagreements }) {
  const actionList = ACTIONS.map((a) => `- ${a}`).join("\n");
  const block = (disagreements || []).map((d) =>
    `- From: ${d.from} | Subject: ${d.subject}\n` +
    `  Snippet: ${(d.snippet || "").slice(0, 200)}\n` +
    `  Predicted: ${d.predictedAction}  →  Chosen: ${d.chosenAction}`
  ).join("\n");

  return META_PROMPT
    .replace("{ACTION_LIST}",        actionList)
    .replace("{CURRENT_RULES}",      rules || "")
    .replace("{DISAGREEMENTS_BLOCK}", block);
}

// ------------------------ Response validator ------------------------

const MAX_RULES_CHARS = 4000;

export function parseImproveResponse(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); }
    catch { return { ok: false, error: { kind: "parse", message: "Model returned non-JSON" } }; }
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: { kind: "parse", message: "Model returned non-object" } };
  }
  const rules = typeof obj.rules === "string" ? obj.rules.trim() : "";
  if (!rules) {
    return { ok: false, error: { kind: "empty", message: "Model returned empty rules" } };
  }
  if (rules.length > MAX_RULES_CHARS) {
    return {
      ok: false,
      error: { kind: "too-long", message: `Rules exceed ${MAX_RULES_CHARS} chars` },
    };
  }
  if (!ACTIONS.some((a) => rules.includes(a))) {
    return {
      ok: false,
      error: { kind: "no-action", message: "Rules don't reference any action name" },
    };
  }
  return { ok: true, rules };
}

// ------------------------ End-to-end Improve call ------------------------

export async function improveRules({ settings, rules, disagreements }) {
  const prompt = buildMetaPrompt({ rules, disagreements });
  try {
    const { json, raw } = await chat({
      baseUrl: settings.ollamaBaseUrl,
      model:   settings.ollamaModel,
      numCtx:  settings.numCtx,
      messages: [
        { role: "system", content: "You rewrite email-classification rules. Output strict JSON only." },
        { role: "user",   content: prompt },
      ],
    });
    const result = parseImproveResponse(json ?? raw);
    if (!result.ok) {
      console.warn("[gmail-sorter] improve: parse failed —", result.error.kind, "raw response:", raw);
      const snippet = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 200);
      if (snippet) result.error.hint = `Model said: ${snippet}`;
    }
    return result;
  } catch (err) {
    if (err instanceof OllamaError) {
      return { ok: false, error: { kind: err.kind, message: err.message, hint: err.hint } };
    }
    return { ok: false, error: { kind: "unknown", message: String(err?.message || err) } };
  }
}
