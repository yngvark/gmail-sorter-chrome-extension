// Gmail Sorter — UI Prototype

// ---------- Mock data ----------

const MOCK_EMAILS = [
  { id: "e1",  from: "Mom",                 subject: "Dinner Saturday?",          read: false, preBakedAction: "Star" },
  { id: "e2",  from: "Stripe",              subject: "Receipt for $47.00",        read: false, preBakedAction: "Archive" },
  { id: "e3",  from: "Amazon",              subject: "Your order has shipped",    read: false, preBakedAction: "Archive" },
  { id: "e4",  from: "LinkedIn",            subject: "8 new jobs for you",        read: false, preBakedAction: "Archive" },
  { id: "e5",  from: "Substack",            subject: "This week in AI",           read: false, preBakedAction: "Archive" },
  { id: "e6",  from: "Alex (colleague)",    subject: "Can you review the PR?",    read: false, preBakedAction: "Label: Follow-up" },
  { id: "e7",  from: "GitHub",              subject: "[repo] New issue opened",   read: false, preBakedAction: "Label: Follow-up" },
  { id: "e8",  from: "Google",              subject: "Security alert",            read: false, preBakedAction: "Mark read" },
  { id: "e9",  from: "Sam (friend)",        subject: "Coffee next week?",         read: false, preBakedAction: "Star" },
  { id: "e10", from: "Calendar",            subject: "Reminder: 1:1 tomorrow",    read: false, preBakedAction: "Leave alone" },
  { id: "e11", from: "unknown@example.com", subject: "hi",                        read: false, preBakedAction: "Leave alone" },
  { id: "e12", from: "Newsletter",          subject: "Weekly update",             read: false, preBakedAction: "Archive" },
];

// ---------- State ----------

const state = {
  emails: MOCK_EMAILS.map(e => ({
    ...e,
    starred: false,
    archived: false,
    labels: [],
  })),
  suggestions: [],    // [{ emailId, action }]
  classifying: false,
  classifyProgress: 0,
  classifyTotal: 0,
};

// ---------- Rendering ----------

function renderEmailList() {
  const ul = document.getElementById("email-list");
  ul.innerHTML = "";
  for (const email of state.emails) {
    if (email.archived) continue;
    const li = document.createElement("li");
    li.className = "email-row";
    if (!email.read) li.classList.add("unread");
    li.dataset.emailId = email.id;

    const star = document.createElement("span");
    star.className = "star";
    star.textContent = email.starred ? "\u2B50" : "";

    const from = document.createElement("span");
    from.className = "from";
    from.textContent = email.from;

    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = email.subject;

    li.append(star, from, subject);

    for (const label of email.labels) {
      const pill = document.createElement("span");
      pill.className = "label-pill";
      pill.textContent = label;
      li.append(pill);
    }

    ul.append(li);
  }
}

function renderSidePanel() {
  const btn = document.getElementById("classify-btn");
  const list = document.getElementById("suggestion-list");
  const applyAll = document.getElementById("apply-all-btn");
  const empty = document.getElementById("empty-state");

  const total = state.classifying
    ? state.classifyTotal
    : emailsToClassify().length;
  if (state.classifying) {
    btn.disabled = true;
    btn.textContent = `Classifying\u2026 ${state.classifyProgress} / ${total}`;
  } else {
    btn.disabled = false;
    btn.textContent = "Classify inbox";
  }

  list.innerHTML = "";
  for (const sugg of state.suggestions) {
    const email = state.emails.find(e => e.id === sugg.emailId);
    if (!email) continue;
    const li = document.createElement("li");
    li.className = "suggestion-row";
    li.dataset.emailId = email.id;

    const meta = document.createElement("div");
    meta.className = "suggestion-meta";
    const from = document.createElement("div");
    from.className = "from";
    from.textContent = email.from;
    const subj = document.createElement("div");
    subj.className = "subject";
    subj.textContent = email.subject;
    meta.append(from, subj);

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "action-btn";
    actionBtn.textContent = sugg.action;
    actionBtn.addEventListener("click", () => applyAction(sugg.emailId, sugg.action));

    li.append(meta, actionBtn);
    list.append(li);
  }

  const hasSuggestions = state.suggestions.length > 0;
  if (!applyAll.disabled) applyAll.textContent = "Apply all";
  applyAll.hidden = !hasSuggestions;
  empty.hidden = state.classifying || hasSuggestions;
}

function render() {
  renderEmailList();
  renderSidePanel();
}

// ---------- Action application ----------

function applyAction(emailId, action) {
  const email = state.emails.find(e => e.id === emailId);
  if (!email) return;

  switch (action) {
    case "Star":
      email.starred = true;
      break;
    case "Archive":
      email.archived = true;
      break;
    case "Mark read":
      email.read = true;
      break;
    case "Label: Follow-up":
      if (!email.labels.includes("Follow-up")) email.labels.push("Follow-up");
      break;
    case "Leave alone":
      // no-op
      break;
  }

  // Drop this email's suggestion.
  state.suggestions = state.suggestions.filter(s => s.emailId !== emailId);
  render();
}

const APPLY_ALL_STAGGER_MS = 150;

function applyAll() {
  const queue = [...state.suggestions];
  if (queue.length === 0) return;

  const applyAllBtn = document.getElementById("apply-all-btn");
  applyAllBtn.disabled = true;

  let i = 0;
  function next() {
    if (i >= queue.length) {
      applyAllBtn.disabled = false;
      return;
    }
    const sugg = queue[i++];
    applyAllBtn.textContent = `Applying\u2026 ${i} / ${queue.length}`;
    applyAction(sugg.emailId, sugg.action);
    setTimeout(next, APPLY_ALL_STAGGER_MS);
  }
  next();
}

document.getElementById("apply-all-btn").addEventListener("click", applyAll);

// ---------- Classification (simulated) ----------

const CLASSIFY_MIN_MS = 250;
const CLASSIFY_MAX_MS = 500;

function randomDelay() {
  return CLASSIFY_MIN_MS + Math.random() * (CLASSIFY_MAX_MS - CLASSIFY_MIN_MS);
}

function emailsToClassify() {
  // Emails still in the inbox that have no pending suggestion and are unhandled.
  // "Unhandled" = not archived, not starred, not already read, not already labelled.
  // Leave-alone emails never acquire any of those flags, so they remain eligible
  // on every re-run (which is the desired behaviour — their counter still ticks).
  return state.emails.filter(e =>
    !e.archived &&
    !e.starred &&
    !e.read &&
    !e.labels.includes("Follow-up") &&
    !state.suggestions.some(s => s.emailId === e.id)
  );
}

function startClassify() {
  if (state.classifying) return;
  const queue = emailsToClassify();
  if (queue.length === 0) return;
  state.classifyTotal = queue.length;

  state.classifying = true;
  state.classifyProgress = 0;
  render();

  let i = 0;
  function next() {
    if (i >= queue.length) {
      state.classifying = false;
      state.classifyTotal = 0;
      render();
      return;
    }
    const email = queue[i++];
    state.classifyProgress = i;
    if (email.preBakedAction !== "Leave alone") {
      state.suggestions.push({ emailId: email.id, action: email.preBakedAction });
    }
    render();
    setTimeout(next, randomDelay());
  }
  setTimeout(next, randomDelay());
}

document.getElementById("classify-btn").addEventListener("click", startClassify);

// ---------- Boot ----------

render();
