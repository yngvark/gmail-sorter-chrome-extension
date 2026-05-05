// Gmail Sorter — side panel view.
//
// Step 1: placeholder renderer with a local classify-state machine so the
// visual states can be verified. Step 2: adds a dev-only "Test auth" affordance
// (gated on `?dev=1`) that round-trips to the service worker.
// Subsequent steps replace the placeholder data source with chrome.storage
// reads and message-passing to the service worker.

import { MSG } from "../lib/messages.js";
import { KEYS } from "../background/storage.js";
import { ACTIONS, DEFAULT_SETTINGS, META_PROMPT } from "../lib/schema.js";
import { actionPillContent, ACTION_ICONS } from "./sidepanel-pill.js";

// ------------------------ Config ------------------------

const FADE_DURATION_MS = 200;
const APPLY_ALL_STAGGER_MS = 250;

const PLACEHOLDER_INBOX = [
  { id: "i1", from: "GitHub",   subject: "[repo] PR #42 opened",  internalDate: 5 },
  { id: "i2", from: "Substack", subject: "This week in AI",       internalDate: 4 },
  { id: "i3", from: "Sam",      subject: "Coffee next week?",     internalDate: 3 },
  { id: "i4", from: "Calendar", subject: "Reminder: 1:1",         internalDate: 2 },
  { id: "i5", from: "Amazon",   subject: "Your order shipped",    internalDate: 1 },
];

const PLACEHOLDER_SUGGESTIONS = [
  { emailId: "i1", from: "GitHub",   subject: "[repo] PR #42 opened", action: "Star: Red" },
  { emailId: "i2", from: "Substack", subject: "This week in AI",      action: "Archive" },
  { emailId: "i3", from: "Sam",      subject: "Coffee next week?",    action: "Star: Red" },
  { emailId: "i4", from: "Calendar", subject: "Reminder: 1:1",        action: "Mark read" },
  { emailId: "i5", from: "Amazon",   subject: "Your order shipped",   action: "Archive" },
];

// True when running inside the extension (chrome.runtime is populated). In
// development the side panel HTML can be loaded plain — we render placeholder
// data and wire no message passing.
const isExtension = Boolean(globalThis.chrome?.runtime?.id);

// ------------------------ State ------------------------

const state = {
  inbox: isExtension ? {} : inboxArrayToById(PLACEHOLDER_INBOX),
  suggestions: isExtension ? {} : arrayToById(PLACEHOLDER_SUGGESTIONS),
  classifying: false,
  classifyProgress: 0,
  classifyTotal: 0,
  hasClassified: !isExtension,
  fetching: false,
  applyingAll: false,
  applyProgress: 0,
  applyTotal: 0,
  lastError: null,            // { kind, message, hint } from storage.session
  applyErrors: {},            // { [emailId]: { message } }
  settings: DEFAULT_SETTINGS,
  disagreements: [],          // [{ emailId, predictedAction, chosenAction, from, subject, snippet, ts }]
  improving: false,
  improveError: null,         // { kind, message, hint? }
  rulesEditDirty: false,      // local: true while textarea diverges from saved
};

function arrayToById(arr) {
  const o = {};
  for (const s of arr) o[s.emailId] = s;
  return o;
}

function inboxArrayToById(arr) {
  const o = {};
  for (const r of arr) o[r.id] = r;
  return o;
}

function sortedSuggestions() {
  return Object.values(state.suggestions);
}

// Match Gmail's own ordering: newest received first. Gmail's `internalDate`
// is the millis-since-epoch when Gmail received the message — the same value
// the Gmail UI sorts by. Without an explicit sort, iteration order is
// whatever survives the chrome.storage roundtrip and isn't guaranteed.
function sortedInbox() {
  return Object.values(state.inbox).sort(
    (a, b) => (b.internalDate || 0) - (a.internalDate || 0),
  );
}

// ------------------------ DOM refs ------------------------

const els = {
  fetchBtn:       document.getElementById("fetch-btn"),
  classifyBtn:    document.getElementById("classify-btn"),
  classifyCount:  document.getElementById("classify-count"),
  progress:       document.getElementById("progress"),
  progressBar:    document.getElementById("progress-bar"),
  emailList:      document.getElementById("email-list"),
  emailCount:     document.getElementById("email-count"),
  emptyState:     document.getElementById("empty-state"),
  applyAllBtn:    document.getElementById("apply-all-btn"),
  applyCount:     document.getElementById("apply-count"),
  optionsLink:    document.getElementById("options-link"),
  corsBanner:     document.getElementById("cors-banner"),
  corsTitle:      document.getElementById("cors-title"),
  corsBody:       document.getElementById("cors-body"),
  corsCode:       document.getElementById("cors-code"),
  toasts:         document.getElementById("toasts"),
  dryRunPill:     document.getElementById("dry-run-pill"),
  rowTpl:         document.getElementById("email-row-template"),
  devTools:       document.getElementById("dev-tools"),
  devAuthBtn:     document.getElementById("dev-auth-btn"),
  devFetchBtn:    document.getElementById("dev-fetch-btn"),
  devClassifyBtn: document.getElementById("dev-classify-btn"),
  devResult:      document.getElementById("dev-result"),
  mappingSystem:    document.getElementById("mapping-system"),
  mappingRules:     document.getElementById("mapping-rules"),
  mappingSaveBtn:   document.getElementById("mapping-save-btn"),
  mappingSaveStatus:document.getElementById("mapping-save-status"),
  mappingDisCount:  document.getElementById("mapping-dis-count"),
  mappingDisList:   document.getElementById("mapping-dis-list"),
  mappingMeta:      document.getElementById("mapping-meta"),
  improveBtn:       document.getElementById("improve-btn"),
  mappingError:     document.getElementById("mapping-error"),
};

// ------------------------ Rendering ------------------------

function renderFetchButton() {
  const label = els.fetchBtn.querySelector(".btn__label");
  if (state.fetching) {
    label.textContent = "Fetching";
    els.fetchBtn.disabled = true;
  } else {
    label.textContent = "Fetch inbox";
    els.fetchBtn.disabled = false;
  }
}

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

// Renders the unified email list as a DOM diff. Driven by state.inbox; each
// row gains an action pill iff a suggestion exists for that email id. Existing
// rows are kept so in-progress fade-outs aren't interrupted when
// storage.onChanged fires a re-render.
function renderEmails() {
  const emails = sortedInbox();
  const wantedIds = new Set(emails.map((e) => e.id));

  for (const row of [...els.emailList.children]) {
    const id = row.dataset.emailId;
    if (wantedIds.has(id)) continue;
    if (!row.classList.contains("leaving")) row.classList.add("leaving");
    if (!row.dataset.removing) {
      row.dataset.removing = "1";
      setTimeout(() => row.remove(), FADE_DURATION_MS + 20);
    }
  }

  const existing = new Map();
  for (const row of els.emailList.children) existing.set(row.dataset.emailId, row);

  for (const e of emails) {
    let row = existing.get(e.id);
    if (!row) {
      row = els.rowTpl.content.firstElementChild.cloneNode(true);
      row.dataset.emailId = e.id;
      row.querySelector(".email-row__from").textContent = e.from || "(unknown)";
      row.querySelector(".email-row__subject").textContent = e.subject || "(no subject)";
      const actionRow = row.querySelector(".action-row");
      for (const action of ACTIONS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "action-btn";
        btn.dataset.action = action;
        const icon = document.createElement("span");
        icon.className = "action-btn__icon";
        icon.textContent = ACTION_ICONS[action];
        const label = document.createElement("span");
        label.className = "action-btn__label";
        label.textContent = action;
        btn.append(icon, label);
        btn.addEventListener("click", () => applyOne(e.id, action));
        actionRow.append(btn);
      }
    }
    // Append on every iteration so re-orders (e.g. internalDate sort) are
    // reflected in the DOM, not just on first render.
    els.emailList.append(row);

    // Mark the predicted button. If there's no suggestion yet, no button is highlighted.
    const sugg = state.suggestions[e.id];
    const buttons = row.querySelectorAll(".action-btn");
    for (const btn of buttons) {
      btn.dataset.predicted = String(Boolean(sugg && btn.dataset.action === sugg.action));
    }
  }

  els.emailCount.textContent = String(emails.length);
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

function renderEmailEmptyState() {
  const hasEmails = sortedInbox().length > 0;
  els.emptyState.hidden = hasEmails || state.fetching;
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

function buildSystemMessage(rules) {
  // Mirrors classify.js buildMessages — kept in sync manually. If the
  // classifier prompt changes, update here too.
  const actionList = ACTIONS.map((a) => `  - ${a}`).join("\n");
  return `You classify emails. Choose exactly one action from this list for each email:

${actionList}

Rules:
${rules}

Respond with strict JSON: {"action": "<one of the actions above>"}. No prose. No explanation.`;
}

function renderMapping() {
  const rules = state.settings?.rules || "";
  els.mappingSystem.textContent = buildSystemMessage(rules);
  els.mappingMeta.textContent   = META_PROMPT;

  if (!state.rulesEditDirty && document.activeElement !== els.mappingRules) {
    els.mappingRules.value = rules;
  }

  // Disagreement list
  const list = state.disagreements;
  els.mappingDisCount.textContent = String(list.length);
  els.mappingDisList.replaceChildren();
  for (const d of list) {
    const li = document.createElement("li");
    const line = document.createElement("div");
    line.className = "mapping__dis-line";
    line.textContent = `${d.from} — ${d.subject} — predicted: ${d.predictedAction} → chose: ${d.chosenAction}`;
    const snippet = document.createElement("div");
    snippet.className = "mapping__dis-snippet";
    snippet.textContent = d.snippet || "";
    li.append(line, snippet);
    els.mappingDisList.append(li);
  }

  // Improve button enable state
  const canImprove =
    list.length > 0 && !state.improving && !state.classifying;
  els.improveBtn.disabled = !canImprove;
  const lbl = els.improveBtn.querySelector(".btn__label");
  lbl.textContent = state.improving ? "Improving…" : "Improve mapping prompt";

  // Error block
  if (state.improveError) {
    els.mappingError.hidden = false;
    els.mappingError.textContent =
      `${state.improveError.message}` +
      (state.improveError.hint ? `  — ${state.improveError.hint}` : "");
  } else {
    els.mappingError.hidden = true;
    els.mappingError.textContent = "";
  }
}

function render() {
  renderFetchButton();
  renderClassifyButton();
  renderEmails();
  renderApplyAll();
  renderEmailEmptyState();
  renderCorsBanner();
  renderToasts();
  renderDryRunPill();
  renderMapping();
}

// ------------------------ Actions ------------------------

function fadeOutThen(el, cb) {
  el.classList.add("leaving");
  setTimeout(cb, FADE_DURATION_MS);
}

async function applyOne(emailId, chosenAction) {
  const row = els.emailList.querySelector(`[data-email-id="${emailId}"]`);
  if (row) row.classList.add("leaving");

  if (isExtension) {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.APPLY_ONE, emailId, chosenAction });
      if (!res?.ok) {
        if (row) row.classList.remove("leaving");
        console.error("apply failed", res);
        // Surface a fallback toast immediately so the user sees the failure
        // even if the storage.onChanged path is delayed or the background
        // didn't write to KEYS.APPLY_ERRORS for some reason. Keyed by
        // emailId so it merges with the storage-driven toast harmlessly.
        const message = res?.error?.message || "Apply failed.";
        if (!state.applyErrors[emailId]) {
          state.applyErrors[emailId] = { message };
          renderToasts();
        }
      } else if (res.noop && row) {
        // Noop apply (e.g. "Leave alone"): pipeline cleared the suggestion but
        // the inbox row is intentionally untouched. Drop the fade so the row
        // stays visible without the half-faded look.
        row.classList.remove("leaving");
      }
      // On a non-noop success, storage.onChanged drops both the suggestion
      // and the inbox row; renderEmails' diff keeps the row fading then
      // removes it when the fade completes.
    } catch (err) {
      if (row) row.classList.remove("leaving");
      console.error(err);
      const message = err?.message || "Apply failed.";
      if (!state.applyErrors[emailId]) {
        state.applyErrors[emailId] = { message };
        renderToasts();
      }
    }
    return;
  }

  // Placeholder path (outside the extension): mirror in-extension behavior by
  // dropping both the suggestion and the inbox row, so the merged list fades
  // the row out instead of just stripping its pill.
  setTimeout(() => {
    delete state.suggestions[emailId];
    delete state.inbox[emailId];
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
    { emailId: "i1", from: "GitHub",    subject: "[repo] PR #42 opened", action: "Star: Red" },
    { emailId: "i2", from: "Substack",  subject: "This week in AI",      action: "Archive" },
    { emailId: "i3", from: "Sam",       subject: "Coffee next week?",    action: "Star: Red" },
    { emailId: "i4", from: "Calendar",  subject: "Reminder: 1:1",        action: "Mark read" },
    { emailId: "i5", from: "Amazon",    subject: "Your order shipped",   action: "Archive" },
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

// Placeholder fetch used outside the extension so the button is testable
// during local UI iteration. Mirrors `simulateClassify`'s pattern.
function simulateFetch() {
  if (state.fetching) return;
  state.fetching = true;
  render();
  setTimeout(() => {
    state.inbox = inboxArrayToById(PLACEHOLDER_INBOX);
    state.fetching = false;
    render();
  }, 400);
}

async function handleFetchClick() {
  if (!isExtension) { simulateFetch(); return; }
  if (state.fetching) return;
  try {
    state.fetching = true;
    renderFetchButton();
    const res = await chrome.runtime.sendMessage({ type: MSG.FETCH_INBOX });
    if (!res?.ok) console.error("fetch failed", res);
  } catch (err) {
    console.error(err);
  } finally {
    state.fetching = false;
    renderFetchButton();
  }
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

els.fetchBtn.addEventListener("click", handleFetchClick);
els.classifyBtn.addEventListener("click", handleClassifyClick);
els.applyAllBtn.addEventListener("click", applyAll);

els.mappingRules.addEventListener("input", () => {
  state.rulesEditDirty = els.mappingRules.value !== (state.settings?.rules || "");
});

els.mappingSaveBtn.addEventListener("click", async () => {
  const next = els.mappingRules.value.trim();
  if (!next) return;
  if (isExtension) {
    const cur = await chrome.storage.sync.get(KEYS.SETTINGS);
    const merged = { ...DEFAULT_SETTINGS, ...(cur[KEYS.SETTINGS] || {}), rules: next };
    await chrome.storage.sync.set({ [KEYS.SETTINGS]: merged });
  } else {
    state.settings = { ...state.settings, rules: next };
  }
  state.rulesEditDirty = false;
  els.mappingSaveStatus.textContent = "Saved.";
  setTimeout(() => { els.mappingSaveStatus.textContent = ""; }, 1500);
  render();
});

els.improveBtn.addEventListener("click", async () => {
  if (!isExtension) return;
  state.improving = true; render();
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.IMPROVE_PROMPT });
    if (!res?.ok) {
      state.improveError = res?.error || { kind: "unknown", message: "Improve failed" };
    }
  } catch (err) {
    state.improveError = { kind: "unknown", message: err.message || String(err) };
  } finally {
    state.improving = false;
    render();
  }
});
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
    KEYS.INBOX, KEYS.SUGGESTIONS, KEYS.HAS_CLASSIFIED, KEYS.APPLY_ERRORS, KEYS.DISAGREEMENTS,
  ]);
  const session = await chrome.storage.session.get([
    KEYS.CLASSIFY_PROGRESS, KEYS.APPLY_PROGRESS, KEYS.ERROR, KEYS.IMPROVING, KEYS.IMPROVE_ERROR,
  ]);
  const sync = await chrome.storage.sync.get([KEYS.SETTINGS]);

  state.inbox = local[KEYS.INBOX] || {};
  state.suggestions = local[KEYS.SUGGESTIONS] || {};
  // Migration: drop any suggestion whose action is no longer in the current
  // taxonomy (e.g. legacy plain "Star" entries from before the multi-star
  // change). Re-classify will repopulate them. Auto-mapping plain "Star" to
  // a specific variant would mis-mark urgent mail; safer to drop.
  {
    const valid = new Set(ACTIONS);
    for (const [id, sugg] of Object.entries(state.suggestions)) {
      if (!valid.has(sugg.action)) delete state.suggestions[id];
    }
  }
  state.hasClassified = Boolean(local[KEYS.HAS_CLASSIFIED]);
  state.applyErrors = local[KEYS.APPLY_ERRORS] || {};
  state.disagreements = local[KEYS.DISAGREEMENTS] || [];
  state.improving = Boolean(session[KEYS.IMPROVING]?.improving);
  state.improveError = session[KEYS.IMPROVE_ERROR] || null;

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
      if (KEYS.DISAGREEMENTS in changes) {
        state.disagreements = changes[KEYS.DISAGREEMENTS].newValue || [];
        dirty = true;
      }
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
      if (KEYS.IMPROVING in changes) {
        state.improving = Boolean(changes[KEYS.IMPROVING].newValue?.improving);
        dirty = true;
      }
      if (KEYS.IMPROVE_ERROR in changes) {
        state.improveError = changes[KEYS.IMPROVE_ERROR].newValue || null;
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
