// Gmail Sorter — side panel view.
//
// Step 1: placeholder renderer with a local classify-state machine so the
// visual states can be verified. Step 2: adds a dev-only "Test auth" affordance
// (gated on `?dev=1`) that round-trips to the service worker.
// Subsequent steps replace the placeholder data source with chrome.storage
// reads and message-passing to the service worker.

import { MSG } from "../lib/messages.js";
import { KEYS } from "../background/storage.js";

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
  corsError: false,
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
  rowTpl:         document.getElementById("suggestion-row-template"),
  inboxDetails:   document.getElementById("inbox-details"),
  inboxCount:     document.getElementById("inbox-count"),
  inboxList:      document.getElementById("inbox-list"),
  devTools:       document.getElementById("dev-tools"),
  devAuthBtn:     document.getElementById("dev-auth-btn"),
  devFetchBtn:    document.getElementById("dev-fetch-btn"),
  devClassifyBtn: document.getElementById("dev-classify-btn"),
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

function renderSuggestions() {
  els.suggestionList.innerHTML = "";
  const list = sortedSuggestions();
  for (const s of list) {
    const node = els.rowTpl.content.firstElementChild.cloneNode(true);
    node.dataset.emailId = s.emailId;
    node.querySelector(".suggestion-row__from").textContent = s.from;
    node.querySelector(".suggestion-row__subject").textContent = s.subject;
    const pill = node.querySelector(".action-pill");
    pill.textContent = s.action;
    pill.dataset.action = s.action;
    pill.addEventListener("click", () => applyOne(s.emailId));
    els.suggestionList.append(node);
  }
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
  els.corsBanner.hidden = !state.corsError;
}

function render() {
  renderClassifyButton();
  renderInbox();
  renderSuggestions();
  renderApplyAll();
  renderEmptyStates();
  renderCorsBanner();
}

// ------------------------ Actions ------------------------

function fadeOutThen(el, cb) {
  el.classList.add("leaving");
  setTimeout(cb, FADE_DURATION_MS);
}

function applyOne(emailId) {
  const row = els.suggestionList.querySelector(`[data-email-id="${emailId}"]`);
  const mutate = () => {
    delete state.suggestions[emailId];
    render();
  };
  if (row) fadeOutThen(row, mutate);
  else mutate();
}

function applyAll() {
  const queue = sortedSuggestions();
  if (queue.length === 0 || state.applyingAll) return;
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

// ------------------------ Storage subscription ------------------------

async function hydrateFromStorage() {
  if (!isExtension) return;
  const local = await chrome.storage.local.get([
    KEYS.INBOX, KEYS.SUGGESTIONS, KEYS.HAS_CLASSIFIED,
  ]);
  const session = await chrome.storage.session.get([
    KEYS.CLASSIFY_PROGRESS, KEYS.APPLY_PROGRESS, KEYS.ERROR,
  ]);
  state.inbox = local[KEYS.INBOX] || {};
  state.suggestions = local[KEYS.SUGGESTIONS] || {};
  state.hasClassified = Boolean(local[KEYS.HAS_CLASSIFIED]);
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
  state.corsError = session[KEYS.ERROR]?.kind === "cors";
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
        state.corsError = changes[KEYS.ERROR].newValue?.kind === "cors";
        dirty = true;
      }
    }
    if (dirty) render();
  });
}

hydrateFromStorage();
subscribeToStorage();

render();
