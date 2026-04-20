// Gmail Sorter — service worker entry.
// Minimal in step 1: make the toolbar icon open the side panel. Messaging,
// OAuth, Gmail and Ollama are added in subsequent steps.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[gmail-sorter] setPanelBehavior failed:", err));
