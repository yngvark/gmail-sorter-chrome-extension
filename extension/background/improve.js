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
