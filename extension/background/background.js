// Gmail Sorter — service worker entry.
// Owns: panel behaviour, message routing, Gmail + Ollama orchestration.

import { MSG, reply, replyError } from "../lib/messages.js";
import { getToken, signOut, maskToken } from "./auth.js";
import * as pipeline from "./pipeline.js";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[gmail-sorter] setPanelBehavior failed:", err));

// ------------------------------------------------------------
// Message router
// ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[gmail-sorter]", msg?.type, err);
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
    default:
      return replyError({ kind: "unknown-message", message: `Unknown message type: ${msg?.type}` });
  }
}
