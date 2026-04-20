// Gmail Sorter — side panel view.
//
// Step 1: pure placeholder. Renders demo suggestions and provides a local
// classify-state machine so the visual states can be verified without the
// service worker. Subsequent steps replace the placeholder data source with
// chrome.storage reads and message-passing to the service worker.

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

// ------------------------ State ------------------------

const state = {
  suggestions: PLACEHOLDER_SUGGESTIONS.slice(),
  classifying: false,
  classifyProgress: 0,
  classifyTotal: 0,
  hasClassified: true,        // placeholder mode: pretend we already classified
  applyingAll: false,
  applyProgress: 0,
  applyTotal: 0,
  corsError: false,
};

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
  for (const s of state.suggestions) {
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
  els.suggestionCount.textContent = String(state.suggestions.length);
}

function renderApplyAll() {
  const label = els.applyAllBtn.querySelector(".btn__label");
  const hasSuggestions = state.suggestions.length > 0;
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
  const hasSuggestions = state.suggestions.length > 0;
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
    state.suggestions = state.suggestions.filter((s) => s.emailId !== emailId);
    render();
  };
  if (row) fadeOutThen(row, mutate);
  else mutate();
}

function applyAll() {
  if (state.suggestions.length === 0 || state.applyingAll) return;
  const queue = state.suggestions.slice();
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

// Simulated classification so the visual states can be verified in step 1.
// Replaced in step 5 with chrome.runtime messaging + chrome.storage subscription.
function simulateClassify() {
  if (state.classifying) return;
  const demoPool = [
    { emailId: "s1", from: "GitHub",    subject: "[repo] PR #42 opened", action: "Move: Follow-up" },
    { emailId: "s2", from: "Substack",  subject: "This week in AI",      action: "Archive" },
    { emailId: "s3", from: "Sam",       subject: "Coffee next week?",    action: "Star" },
    { emailId: "s4", from: "Calendar",  subject: "Reminder: 1:1",        action: "Mark read" },
    { emailId: "s5", from: "Amazon",    subject: "Your order shipped",   action: "Archive" },
  ];

  state.suggestions = [];
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
    state.suggestions.push(demoPool[i]);
    i++;
    state.classifyProgress = i;
    render();
    setTimeout(step, 260 + Math.random() * 260);
  }
  setTimeout(step, 200);
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

els.classifyBtn.addEventListener("click", simulateClassify);
els.applyAllBtn.addEventListener("click", applyAll);
els.optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
});

render();
