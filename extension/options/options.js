// Settings page. Reads/writes chrome.storage.sync.settings; falls back to
// DEFAULT_SETTINGS for missing fields so users upgrading from older versions
// get sensible defaults without any migration logic.

import { MSG } from "../lib/messages.js";
import { DEFAULT_SETTINGS, DEFAULT_RULES } from "../lib/schema.js";
import { KEYS } from "../background/storage.js";

const els = {
  form:           document.getElementById("settings-form"),
  ollamaBaseUrl:  document.getElementById("ollamaBaseUrl"),
  ollamaModel:    document.getElementById("ollamaModel"),
  numCtx:         document.getElementById("numCtx"),
  rules:          document.getElementById("rules"),
  maxInbox:       document.getElementById("maxInbox"),
  dryRun:         document.getElementById("dryRun"),
  saveBtn:        document.getElementById("save-btn"),
  resetBtn:       document.getElementById("reset-btn"),
  signoutBtn:     document.getElementById("signout-btn"),
  saveStatus:     document.getElementById("save-status"),
  signoutStatus:  document.getElementById("signout-status"),
};

// ---------------------- Load / save ----------------------

async function loadSettings() {
  const saved = (await chrome.storage.sync.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  populate(settings);
}

function populate(s) {
  els.ollamaBaseUrl.value = s.ollamaBaseUrl;
  els.ollamaModel.value   = s.ollamaModel;
  els.numCtx.value        = s.numCtx;
  els.rules.value         = s.rules;
  els.maxInbox.value      = s.maxInbox;
  els.dryRun.checked      = Boolean(s.dryRun);
}

function collect() {
  return {
    ollamaBaseUrl: els.ollamaBaseUrl.value.trim() || DEFAULT_SETTINGS.ollamaBaseUrl,
    ollamaModel:   els.ollamaModel.value.trim()   || DEFAULT_SETTINGS.ollamaModel,
    numCtx:        clamp(Number(els.numCtx.value) || DEFAULT_SETTINGS.numCtx, 2048, 131072),
    rules:         els.rules.value.trim()         || DEFAULT_RULES,
    maxInbox:      clamp(Number(els.maxInbox.value) || DEFAULT_SETTINGS.maxInbox, 1, 500),
    dryRun:        Boolean(els.dryRun.checked),
  };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

async function save(evt) {
  evt.preventDefault();
  const settings = collect();
  try {
    await chrome.storage.sync.set({ [KEYS.SETTINGS]: settings });
    flashStatus(els.saveStatus, "Saved.", false);
  } catch (err) {
    flashStatus(els.saveStatus, `Save failed: ${err.message}`, true);
  }
}

function reset() {
  populate(DEFAULT_SETTINGS);
  flashStatus(els.saveStatus, "Reverted to defaults — click Save to apply.", false);
}

async function signOut() {
  els.signoutBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.AUTH_SIGN_OUT });
    if (res?.ok) flashStatus(els.signoutStatus, "Signed out.", false);
    else         flashStatus(els.signoutStatus, "Sign-out failed.", true);
  } catch (err) {
    flashStatus(els.signoutStatus, err.message, true);
  } finally {
    els.signoutBtn.disabled = false;
  }
}

function flashStatus(el, text, isError) {
  el.textContent = text;
  el.classList.toggle("--error", Boolean(isError));
  setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 4000);
}

// ---------------------- Copy-to-clipboard ----------------------

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-target]");
  if (!btn) return;
  const target = document.getElementById(btn.dataset.copyTarget);
  if (!target) return;
  navigator.clipboard.writeText(target.textContent.trim()).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = prev), 1200);
  });
});

// ---------------------- Boot ----------------------

els.form.addEventListener("submit", save);
els.resetBtn.addEventListener("click", reset);
els.signoutBtn.addEventListener("click", signOut);

// Guard — when the page is loaded standalone (no chrome.runtime), show defaults.
if (globalThis.chrome?.storage?.sync) {
  loadSettings();
} else {
  populate(DEFAULT_SETTINGS);
}
