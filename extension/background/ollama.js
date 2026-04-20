// Thin client for the local Ollama HTTP server. One call — /api/chat with
// JSON mode — is all we need. See https://github.com/ollama/ollama/blob/main/docs/api.md
//
// CORS note: Chrome blocks extension → http://localhost:11434 unless Ollama
// is started with OLLAMA_ORIGINS=chrome-extension://*. When that's missing,
// `fetch` rejects with "TypeError: Failed to fetch" and no response object.
// We catch that and return a typed {kind:"cors"} error so the side panel can
// show an actionable banner with the exact command to run.

export class OllamaError extends Error {
  constructor(kind, message, hint) {
    super(message);
    this.name = "OllamaError";
    this.kind = kind;
    this.hint = hint;
  }
}

export async function chat({
  baseUrl = "http://localhost:11434",
  model,
  messages,
  numCtx = 64000,
  format = "json",
  timeoutMs = 60_000,
} = {}) {
  if (!model) throw new OllamaError("config", "Ollama model not configured");

  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format,
        options: { num_ctx: numCtx },
      }),
    });
  } catch (err) {
    // In MV3 service workers CORS failures surface as TypeError with no
    // response. Aborts also land here.
    if (err?.name === "AbortError") {
      throw new OllamaError("timeout", `Ollama didn't respond within ${timeoutMs}ms`);
    }
    throw new OllamaError(
      "cors",
      "Can't reach Ollama (likely a CORS or network error)",
      "Start Ollama with: OLLAMA_ORIGINS=chrome-extension://* ollama serve",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new OllamaError(
      res.status === 404 ? "model-missing" : "http",
      `Ollama ${res.status}: ${text || res.statusText}`,
      res.status === 404
        ? `Run: ollama pull ${model}`
        : undefined,
    );
  }

  const data = await res.json();
  const content = data?.message?.content ?? "";
  if (!content) throw new OllamaError("empty", "Ollama returned an empty response");

  if (format === "json") {
    try {
      return { raw: content, json: JSON.parse(content) };
    } catch (err) {
      throw new OllamaError("parse", `Model did not return valid JSON: ${err.message}`);
    }
  }
  return { raw: content };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
