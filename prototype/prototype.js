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
  // Suggestions, Apply all, empty state — filled in later tasks.
  // Keep stub so render() is callable now.
}

function render() {
  renderEmailList();
  renderSidePanel();
}

// ---------- Boot ----------

render();
