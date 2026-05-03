// Gmail Sorter — service worker entry.
// Owns: panel behaviour, message routing, Gmail + Ollama orchestration.

import { MSG, reply, replyError } from "../lib/messages.js";
import { getToken, signOut, maskToken } from "./auth.js";
import * as pipeline from "./pipeline.js";
import * as store from "./storage.js";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[gmail-sorter] setPanelBehavior failed:", err));

// ------------------------------------------------------------
// Message router
// ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(async (response) => {
      // Top-level wrapper diagnostic. Note: per-handler diagnostics live in
      // pipeline.js for the handlers that have their own taxonomy.
      try {
        await store.appendDiag({ kind: "msg", type: msg?.type, ok: Boolean(response?.ok) });
      } catch { /* never let diag errors break the response path */ }
      sendResponse(response);
    })
    .catch(async (err) => {
      console.error("[gmail-sorter]", msg?.type, err);
      try {
        await store.appendDiag({ kind: "msg", type: msg?.type, ok: false });
      } catch { /* see above */ }
      sendResponse(replyError({ kind: "unknown", message: String(err?.message || err) }));
    });
  return true; // keep the message channel open for async response
});

async function handle(msg) {
  switch (msg?.type) {
    case MSG.AUTH_TEST: {
      const token = await getToken({ interactive: true });
      console.log("[gmail-sorter] token obtained:", maskToken(token));
      return reply({ token: maskToken(token) });
    }
    case MSG.AUTH_SIGN_OUT: {
      await signOut();
      return reply({ signedOut: true });
    }
    case MSG.FETCH_INBOX: {
      const result = await pipeline.fetchInbox({ maxResults: msg.maxResults || 50 });
      return reply(result);
    }
    case MSG.CLASSIFY_ONE: {
      const result = await pipeline.classifyOne(msg.emailId);
      return reply(result);
    }
    case MSG.CLASSIFY_INBOX: {
      const result = await pipeline.classifyInbox();
      return reply(result);
    }
    case MSG.APPLY_ONE: {
      const result = await pipeline.applyOne(msg.emailId, msg.chosenAction);
      return result.ok ? reply(result) : replyError(result.error);
    }
    case MSG.APPLY_ALL: {
      const result = await pipeline.applyAll();
      return reply(result);
    }
    case MSG.GET_DIAG: {
      const events = await store.getDiag();
      return reply({ events });
    }
    case MSG.CLEAR_DIAG: {
      await store.clearDiag();
      return reply({ cleared: true });
    }
    case MSG.IMPROVE_PROMPT: {
      const result = await pipeline.improvePrompt();
      return result.ok ? reply(result) : replyError(result.error);
    }
    default:
      return replyError({ kind: "unknown-message", message: `Unknown message type: ${msg?.type}` });
  }
}
