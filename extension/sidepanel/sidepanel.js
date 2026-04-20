// Gmail Sorter — side panel view.
//
// Step 1: placeholder renderer with a local classify-state machine so the
// visual states can be verified. Step 2: adds a dev-only "Test auth" affordance
// (gated on `?dev=1`) that round-trips to the service worker.
// Subsequent steps replace the placeholder data source with chrome.storage
// reads and message-passing to the service worker.

import { MSG } from "../lib/messages.js";
import { KEYS } from "../background/storage.js";
import { DEFAULT_SETTINGS } from "../lib/schema.js";

// ------------------------ Config ------------------------

const FADE_DURATION_MS = 200;
const APPLY_ALL_STAGGER_MS = 250;

const PLACEHOLDER_SUGGESTIONS = [
  { emailId: "p1", from: "Mom",              subject: "Dinner Saturday?",       action: "Star" },
  { emailId: "p2", from: "Stripe",           subject: "Receipt for $47.00",     action: "Archive" },
  { emailId: "p3", from: "Alex (colleague)", subject: "Can you review the PR?", action: "Move: Follow-up" },
  { emailId: "p4", from: "Google",           subject: "Security alert",         action: "Mark read" },
  { emailId: "p5", from: "LinkedIn",         subject: "8 new jobs for you",     action: "Archive" },
];

// True when running inside the extension (chrome.runtime is populated). In
// development the side panel HTML can be loaded plain — we render placeholder
// data and wire no message passing.
const isExtension = Boolean(globalThis.chrome?.runtime?.id);

// ------------------------ State ------------------------

const state = {
  inbox: {},                  // { [id]: { id, from, subject, ... } }
  suggestions: isExtension ? {} : arrayToById(PLACEHOLDER_SUGGESTIONS),
  classifying: false,
  classifyProgress: 0,
  classifyTotal: 0,
  hasClassified: !isExtension,
  applyingAll: false,
  applyProgress: 0,
  applyTotal: 0,
  lastError: null,            // { kind, message, hint } from storage.session
  applyErrors: {},            // { [emailId]: { message } }
  settings: DEFAULT_SETTINGS,
};

function arrayToById(arr) {
  const o = {};
  for (const s of arr) o[s.emailId] = s;
  return o;
}

function sortedSuggestions() {
  return Object.values(state.suggestions);
}

function sortedInbox() {
  return Object.values(state.inbox);
}

// ------------------------ DOM refs ------------------------

const els = {
  classifyBtn:    document.getElementById("classify-btn"),
  classifyCount:  document.getElementById("classify-count"),
  progress:       document.getElementById("progress"),
  progressBar:    document.getElementById("progress-bar"),
  suggestionList: document.getElementById("suggestion-list"),
  suggestionCount:document.getElementById("suggestion-count"),
  emptyState:     document.getElementById("empty-state"),
  promptState:    document.getElementById("prompt-state"),
  applyAllBtn:    document.getElementById("apply-all-btn"),
  applyCount:     document.getElementById("apply-count"),
  optionsLink:    document.getElementById("options-link"),
  corsBanner:     document.getElementById("cors-banner"),
  corsTitle:      document.getElementById("cors-title"),
  corsBody:       document.getElementById("cors-body"),
  corsCode:       document.getElementById("cors-code"),
  toasts:         document.getElementById("toasts"),
  dryRunPill:     document.getElementById("dry-run-pill"),
  rowTpl:         document.getElementById("suggestion-row-template"),
  inboxDetails:   document.getElementById("inbox-details"),
  inboxCount:     document.getElementById("inbox-count"),
  inboxList:      document.getElementById("inbox-list"),
  devTools:       document.getElementById("dev-tools"),
  devAuthBtn:     document.getElementById("dev-auth-btn"),
  devFetchBtn:    document.getElementById("dev-fetch-btn"),
  devClassifyBtn: document.getElementById("dev-classify-btn"),
  devSuperstarBtn:document.getElementById("dev-superstar-btn"),
  devResult:      document.getElementById("dev-result"),
};

// ------------------------ Rendering ------------------------

function renderClassifyButton() {
  const label = els.classifyBtn.querySelector(".btn__label");
  if (state.classifying) {
    label.textContent = "Classifying";
    els.classifyCount.hidden = false;
    els.classifyCount.textContent = `${state.classifyProgress} / ${state.classifyTotal}`;
    els.classifyBtn.disabled = true;
    els.progress.hidden = false;
    const pct = state.classifyTotal
      ? Math.round((state.classifyProgress / state.classifyTotal) * 100)
      : 0;
    els.progressBar.style.width = `${pct}%`;
  } else {
    label.textContent = "Classify inbox";
    els.classifyCount.hidden = true;
    els.classifyBtn.disabled = false;
    els.progress.hidden = true;
    els.progressBar.style.width = "0%";
  }
}

// Renders the suggestion list as a DOM diff. Existing rows are kept so
// in-progress fade-outs aren't interrupted when storage.onChanged fires a
// re-render. Rows whose backing suggestion has vanished are marked
// "leaving" and removed once their fade animation finishes.
function renderSuggestions() {
  const list = sortedSuggestions();
  const wantedIds = new Set(list.map((s) => s.emailId));

  // Remove rows whose suggestions no longer exist. A row may already be in
  // the "leaving" state — either we marked it for fade on click, or an
  // earlier render pass did. Use dataset.removing to avoid double-scheduling
  // the removal timer.
  for (const row of [...els.suggestionList.children]) {
    const id = row.dataset.emailId;
    if (wantedIds.has(id)) continue;
    if (!row.classList.contains("leaving")) row.classList.add("leaving");
    if (!row.dataset.removing) {
      row.dataset.removing = "1";
      setTimeout(() => row.remove(), FADE_DURATION_MS + 20);
    }
  }

  // Add rows for new suggestions. Keep existing ones in place (updating their
  // action pill if it changed).
  const existing = new Map();
  for (const row of els.suggestionList.children) existing.set(row.dataset.emailId, row);

  for (const s of list) {
    let row = existing.get(s.emailId);
    if (!row) {
      row = els.rowTpl.content.firstElementChild.cloneNode(true);
      row.dataset.emailId = s.emailId;
      row.querySelector(".suggestion-row__from").textContent = s.from;
      row.querySelector(".suggestion-row__subject").textContent = s.subject;
      const pill = row.querySelector(".action-pill");
      pill.addEventListener("click", () => applyOne(s.emailId));
      els.suggestionList.append(row);
    }
    const pill = row.querySelector(".action-pill");
    if (pill.textContent !== s.action) pill.textContent = s.action;
    pill.dataset.action = s.action;
  }

  // Count reflects non-leaving rows only — visual counter should match what
  // the user sees.
  els.suggestionCount.textContent = String(list.length);
}

function renderInbox() {
  const rows = sortedInbox();
  if (rows.length === 0) {
    els.inboxDetails.hidden = true;
    return;
  }
  els.inboxDetails.hidden = false;
  els.inboxCount.textContent = String(rows.length);
  els.inboxList.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "inbox__item";
    const from = document.createElement("span");
    from.className = "inbox__from";
    from.textContent = r.from || "(unknown)";
    const subj = document.createElement("span");
    subj.className = "inbox__subject";
    subj.textContent = r.subject || "(no subject)";
    li.append(from, subj);
    els.inboxList.append(li);
  }
}

function renderApplyAll() {
  const label = els.applyAllBtn.querySelector(".btn__label");
  const hasSuggestions = sortedSuggestions().length > 0;
  els.applyAllBtn.hidden = !hasSuggestions;

  if (state.applyingAll) {
    label.textContent = "Applying";
    els.applyCount.hidden = false;
    els.applyCount.textContent = `${state.applyProgress} / ${state.applyTotal}`;
    els.applyAllBtn.disabled = true;
  } else {
    label.textContent = "Apply all";
    els.applyCount.hidden = true;
    els.applyAllBtn.disabled = false;
  }
}

function renderEmptyStates() {
  const hasSuggestions = sortedSuggestions().length > 0;
  const showEmpty = !state.classifying && !hasSuggestions && state.hasClassified;
  const showPrompt = !state.classifying && !hasSuggestions && !state.hasClassified;
  els.emptyState.hidden = !showEmpty;
  els.promptState.hidden = !showPrompt;
}

function renderCorsBanner() {
  const err = state.lastError;
  if (!err) { els.corsBanner.hidden = true; return; }

  els.corsBanner.hidden = false;
  // Tailor the banner to the error kind.
  if (err.kind === "cors") {
    els.corsTitle.textContent = "Can\u2019t reach Ollama";
    els.corsBody.textContent  = "Start Ollama with origins allowed for this extension:";
    els.corsCode.textContent  = "OLLAMA_ORIGINS=chrome-extension://* ollama serve";
  } else if (err.kind === "model-missing") {
    els.corsTitle.textContent = "Model not installed";
    els.corsBody.textContent  = err.message;
    els.corsCode.textContent  = err.hint || `ollama pull ${state.settings.ollamaModel}`;
  } else if (err.kind === "timeout") {
    els.corsTitle.textContent = "Ollama timed out";
    els.corsBody.textContent  = err.message;
    els.corsCode.textContent  = "ollama serve   # ensure it's running";
  } else {
    els.corsTitle.textContent = "Something went wrong";
    els.corsBody.textContent  = err.message || String(err);
    els.corsCode.textContent  = err.hint || "";
    if (!err.hint) els.corsCode.hidden = true; else els.corsCode.hidden = false;
  }
}

function renderToasts() {
  const errors = Object.entries(state.applyErrors);
  // Keep existing toasts in place; add new; remove gone.
  const have = new Map();
  for (const t of els.toasts.children) have.set(t.dataset.emailId, t);

  const wanted = new Set(errors.map(([id]) => id));
  for (const [id, node] of have) {
    if (!wanted.has(id)) node.remove();
  }
  for (const [id, err] of errors) {
    if (have.has(id)) continue;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.emailId = id;

    const title = document.createElement("div");
    title.className = "toast__title";
    title.textContent = "Couldn\u2019t apply";

    const body = document.createElement("div");
    body.className = "toast__body";
    body.textContent = err.message;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00D7";
    close.addEventListener("click", () => dismissToast(id));

    toast.append(title, body, close);
    els.toasts.append(toast);
  }
}

function dismissToast(emailId) {
  if (isExtension) {
    // Clear from storage; storage.onChanged will rerender.
    chrome.storage.local.get(KEYS.APPLY_ERRORS).then((res) => {
      const all = res[KEYS.APPLY_ERRORS] || {};
      delete all[emailId];
      chrome.storage.local.set({ [KEYS.APPLY_ERRORS]: all });
    });
  } else {
    delete state.applyErrors[emailId];
    render();
  }
}

function renderDryRunPill() {
  els.dryRunPill.hidden = !state.settings?.dryRun;
}

function render() {
  renderClassifyButton();
  renderInbox();
  renderSuggestions();
  renderApplyAll();
  renderEmptyStates();
  renderCorsBanner();
  renderToasts();
  renderDryRunPill();
}

// ------------------------ Actions ------------------------

function fadeOutThen(el, cb) {
  el.classList.add("leaving");
  setTimeout(cb, FADE_DURATION_MS);
}

async function applyOne(emailId) {
  const row = els.suggestionList.querySelector(`[data-email-id="${emailId}"]`);
  if (row) row.classList.add("leaving");

  if (isExtension) {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.APPLY_ONE, emailId });
      if (!res?.ok) {
        if (row) row.classList.remove("leaving");
        console.error("apply failed", res);
      }
      // On success, storage.onChanged drops the suggestion; renderSuggestions
      // diff keeps the row fading then removes it when the fade completes.
    } catch (err) {
      if (row) row.classList.remove("leaving");
      console.error(err);
    }
    return;
  }

  // Placeholder path (outside the extension): local mutation only.
  setTimeout(() => {
    delete state.suggestions[emailId];
    render();
  }, FADE_DURATION_MS);
}

async function applyAll() {
  const queue = sortedSuggestions();
  if (queue.length === 0 || state.applyingAll) return;

  if (isExtension) {
    // Optimistic flip; the worker will then stream progress via storage.
    state.applyingAll = true;
    state.applyTotal = queue.length;
    state.applyProgress = 0;
    renderApplyAll();
    try {
      await chrome.runtime.sendMessage({ type: MSG.APPLY_ALL });
    } catch (err) {
      console.error(err);
      state.applyingAll = false;
      render();
    }
    return;
  }

  // Placeholder loop for standalone UI iteration.
  state.applyingAll = true;
  state.applyTotal = queue.length;
  state.applyProgress = 0;
  renderApplyAll();

  let i = 0;
  function next() {
    if (i >= queue.length) {
      state.applyingAll = false;
      render();
      return;
    }
    const s = queue[i++];
    state.applyProgress = i;
    renderApplyAll();
    applyOne(s.emailId);
    setTimeout(next, APPLY_ALL_STAGGER_MS);
  }
  next();
}

// Dev simulation used when the side panel is loaded outside the extension
// (browser-served for visual iteration). Replaced in step 5 by chrome.runtime
// messaging in-extension.
function simulateClassify() {
  if (state.classifying) return;
  const demoPool = [
    { emailId: "s1", from: "GitHub",    subject: "[repo] PR #42 opened", action: "Move: Follow-up" },
    { emailId: "s2", from: "Substack",  subject: "This week in AI",      action: "Archive" },
    { emailId: "s3", from: "Sam",       subject: "Coffee next week?",    action: "Star" },
    { emailId: "s4", from: "Calendar",  subject: "Reminder: 1:1",        action: "Mark read" },
    { emailId: "s5", from: "Amazon",    subject: "Your order shipped",   action: "Archive" },
  ];

  state.suggestions = {};
  state.classifying = true;
  state.classifyProgress = 0;
  state.classifyTotal = demoPool.length;
  state.hasClassified = false;
  render();

  let i = 0;
  function step() {
    if (i >= demoPool.length) {
      state.classifying = false;
      state.hasClassified = true;
      render();
      return;
    }
    const s = demoPool[i++];
    state.suggestions[s.emailId] = s;
    state.classifyProgress = i;
    render();
    setTimeout(step, 260 + Math.random() * 260);
  }
  setTimeout(step, 200);
}

async function handleClassifyClick() {
  if (!isExtension) { simulateClassify(); return; }
  try {
    // Optimistic UI: flip classifying flag immediately so the button disables
    // without waiting for the service worker to wake up and write session
    // storage. The real progress will arrive via storage.onChanged shortly.
    state.classifying = true;
    state.classifyProgress = 0;
    state.classifyTotal = 0;
    render();
    const res = await chrome.runtime.sendMessage({ type: MSG.CLASSIFY_INBOX });
    if (!res?.ok) {
      state.classifying = false;
      render();
      console.error("classify failed", res);
    }
  } catch (err) {
    state.classifying = false;
    render();
    console.error(err);
  }
}

// ------------------------ Copy-to-clipboard ------------------------

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

// ------------------------ Boot ------------------------

els.classifyBtn.addEventListener("click", handleClassifyClick);
els.applyAllBtn.addEventListener("click", applyAll);
els.optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
});

// ------------------------ Dev tools ------------------------

const devMode =
  new URLSearchParams(location.search).has("dev") ||
  globalThis.chrome?.runtime?.getManifest?.().version_name?.includes("dev");

if (devMode) els.devTools.hidden = false;

async function runDevMessage(button, msg, renderResult) {
  button.disabled = true;
  els.devResult.textContent = "…";
  try {
    const res = await chrome.runtime.sendMessage(msg);
    els.devResult.textContent = res?.ok
      ? renderResult(res.data)
      : `error: ${res?.error?.message ?? "unknown"}`;
  } catch (err) {
    els.devResult.textContent = `error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

els.devAuthBtn.addEventListener("click", () =>
  runDevMessage(els.devAuthBtn, { type: MSG.AUTH_TEST }, (d) => `token: ${d.token}`),
);

els.devFetchBtn.addEventListener("click", () =>
  runDevMessage(els.devFetchBtn, { type: MSG.FETCH_INBOX }, (d) => `fetched: ${d.fetched}`),
);

els.devClassifyBtn.addEventListener("click", () =>
  runDevMessage(els.devClassifyBtn, { type: MSG.CLASSIFY_ONE }, (d) =>
    d.ok ? `→ ${d.action}${d.fallback ? ` (fallback: ${d.fallback})` : ""}`
         : `error: ${d.error?.message ?? "unknown"}`,
  ),
);

els.devSuperstarBtn.addEventListener("click", () =>
  runDevMessage(els.devSuperstarBtn, { type: MSG.PROBE_SUPERSTAR, variant: "red" }, (d) =>
    d.writable === true  ? `^ss_sr writable ✓`
  : d.writable === false ? `^ss_sr NOT writable (use custom labels)`
  : `probe: ${JSON.stringify(d)}`,
  ),
);

// ------------------------ Storage subscription ------------------------

async function hydrateFromStorage() {
  if (!isExtension) return;
  const local = await chrome.storage.local.get([
    KEYS.INBOX, KEYS.SUGGESTIONS, KEYS.HAS_CLASSIFIED, KEYS.APPLY_ERRORS,
  ]);
  const session = await chrome.storage.session.get([
    KEYS.CLASSIFY_PROGRESS, KEYS.APPLY_PROGRESS, KEYS.ERROR,
  ]);
  const sync = await chrome.storage.sync.get([KEYS.SETTINGS]);

  state.inbox = local[KEYS.INBOX] || {};
  state.suggestions = local[KEYS.SUGGESTIONS] || {};
  state.hasClassified = Boolean(local[KEYS.HAS_CLASSIFIED]);
  state.applyErrors = local[KEYS.APPLY_ERRORS] || {};

  const cp = session[KEYS.CLASSIFY_PROGRESS];
  if (cp) {
    state.classifying = Boolean(cp.classifying);
    state.classifyProgress = cp.progress || 0;
    state.classifyTotal = cp.total || 0;
  }
  const ap = session[KEYS.APPLY_PROGRESS];
  if (ap) {
    state.applyingAll = Boolean(ap.applying);
    state.applyProgress = ap.progress || 0;
    state.applyTotal = ap.total || 0;
  }
  state.lastError = session[KEYS.ERROR] || null;
  state.settings = { ...DEFAULT_SETTINGS, ...(sync[KEYS.SETTINGS] || {}) };
  render();
}

function subscribeToStorage() {
  if (!isExtension) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    let dirty = false;
    if (area === "local") {
      if (KEYS.INBOX in changes)          { state.inbox       = changes[KEYS.INBOX].newValue       || {}; dirty = true; }
      if (KEYS.SUGGESTIONS in changes)    { state.suggestions = changes[KEYS.SUGGESTIONS].newValue || {}; dirty = true; }
      if (KEYS.HAS_CLASSIFIED in changes) { state.hasClassified = Boolean(changes[KEYS.HAS_CLASSIFIED].newValue); dirty = true; }
      if (KEYS.APPLY_ERRORS in changes)   { state.applyErrors = changes[KEYS.APPLY_ERRORS].newValue || {}; dirty = true; }
    } else if (area === "session") {
      if (KEYS.CLASSIFY_PROGRESS in changes) {
        const cp = changes[KEYS.CLASSIFY_PROGRESS].newValue || {};
        state.classifying = Boolean(cp.classifying);
        state.classifyProgress = cp.progress || 0;
        state.classifyTotal = cp.total || 0;
        dirty = true;
      }
      if (KEYS.APPLY_PROGRESS in changes) {
        const ap = changes[KEYS.APPLY_PROGRESS].newValue || {};
        state.applyingAll = Boolean(ap.applying);
        state.applyProgress = ap.progress || 0;
        state.applyTotal = ap.total || 0;
        dirty = true;
      }
      if (KEYS.ERROR in changes) {
        state.lastError = changes[KEYS.ERROR].newValue || null;
        dirty = true;
      }
    } else if (area === "sync") {
      if (KEYS.SETTINGS in changes) {
        state.settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}) };
        dirty = true;
      }
    }
    if (dirty) render();
  });
}

hydrateFromStorage();
subscribeToStorage();

render();
