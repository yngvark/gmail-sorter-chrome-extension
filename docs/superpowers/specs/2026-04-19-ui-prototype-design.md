# Gmail Sorter — UI Prototype Design

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Scope:** UX prototype only. Not a working extension.

## Purpose

Iterate on the side-panel UX for the Gmail Sorter extension (see `PLAN.md`) before writing any extension code. The prototype lets the designer/developer see and feel the classification → suggestion → apply flow in a real browser with realistic timing, without touching OAuth, Ollama, or the Gmail API.

## Non-goals

- Not a Chrome extension. Opens as a plain HTML file in any modern browser.
- No real Ollama or Gmail calls. All data is hardcoded.
- No OAuth, no `chrome.*` APIs, no build step, no npm.
- No error states (CORS failure, Gmail failure, partial classification). Happy path only.
- No options/settings page.
- No persistence. Refresh resets everything.

## Shape

Single page, two-pane split-screen:

```
┌─────────────────────────────────┬──────────────────┐
│ Inbox (fake Gmail)              │ Gmail Sorter     │
│                                 │                  │
│ Mom — Dinner?                   │ [Classify inbox] │
│ Stripe — Receipt                │                  │
│ LinkedIn — Jobs for you…        │   Suggestions…   │
│ … (~12 rows)                    │                  │
│                                 │ [Apply all]      │
└─────────────────────────────────┴──────────────────┘
```

- **Left pane (fake Gmail):** minimal email list. Neutral styling — not a Gmail look-alike. Reacts to actions applied from the side panel.
- **Right pane (side panel):** fixed ~360px wide. Classification UI. Mirrors the side panel layout sketched in `PLAN.md`.

## Files

Three files, no build step, double-click `prototype.html` to open:

| File | Contents |
|---|---|
| `prototype.html` | Markup for both panes. Mock email data embedded inline as a `<script type="application/json">` block. |
| `prototype.css` | Styles. Shares look with `sidepanel-test/` (system-ui font, neutral greys). |
| `prototype.js` | State (`emails`, `suggestions`), DOM rendering, timing simulation, event handlers. |

Location: top-level `prototype/` directory in the repo.

## Mock data

~12 emails covering the action vocabulary. Each mock email carries a pre-baked classification (no real LLM runs):

| Example sender / subject | Pre-baked action |
|---|---|
| Mom — Dinner Saturday? | Star |
| Stripe — Receipt for $47.00 | Archive |
| Amazon — Your order has shipped | Archive |
| LinkedIn — 8 new jobs for you | Archive |
| Substack — This week in AI | Archive |
| Colleague — Can you review the PR? | Label: Follow-up |
| GitHub — [repo] New issue opened | Label: Follow-up |
| Google — Security alert (already read) | Mark read |
| Friend — Coffee next week? | Star |
| Calendar — Reminder: 1:1 tomorrow | Leave alone |
| Short one-liner from unknown sender | Leave alone |
| Newsletter — boring update | Archive |

Exact copy can be adjusted during implementation; the *distribution* of actions is what matters.

**Action vocabulary:** `Star`, `Archive`, `Mark read`, `Label: Follow-up`, `Leave alone`. This is a strict subset of the actions in `PLAN.md` — enough to exercise the UX without bloating the prototype.

## Interaction flow

### 1. Initial state

- Gmail pane shows all 12 emails. Unread ones bold.
- Side panel shows `[Classify inbox]` button and nothing else below.

### 2. Click `Classify inbox`

- Button text changes to `Classifying… 0 / 12` and disables.
- Every 250–500 ms (randomized per email) the counter ticks up: `1 / 12`, `2 / 12`, … The counter counts *all* classifications, including `Leave alone`, so progress feels continuous.
- For each non-`Leave alone` classification, a suggestion row appears in the panel below.
- Each suggestion row shows: sender, subject, and a single action button whose label is the suggested action (e.g. `Star`, `Archive`).
- Rows with action `Leave alone` are *not* rendered (nothing to do) but still count toward the counter.
- When done, button returns to `Classify inbox` enabled; re-runnable.

### 3. Click a per-email action button

- Side panel: row fades out (~200 ms) and is removed.
- Gmail pane reacts based on the action:
  - `Archive` → corresponding row fades out and is removed.
  - `Star` → ⭐ glyph appears at the start of the row; row stays.
  - `Mark read` → bold removed from the row.
  - `Label: Follow-up` → small pill "Follow-up" appears next to the subject.

### 4. Click `Apply all`

- Button appears once there is at least one suggestion.
- Clicking it applies each remaining suggestion in sequence with a ~150 ms stagger so the cascade is visible in both panes.
- Button shows progress (e.g. `Applying… 3 / 7`), then disappears when nothing is left.

### 5. Empty state

- When all suggestions have been applied (or dismissed), the panel shows:

  > No suggestions. Click **Classify inbox** to re-run.

- `Classify inbox` remains clickable; on re-run, emails that already had an action applied are treated as `Leave alone` (they count toward the counter, no suggestion row rendered). Archived emails are likewise skipped — they no longer exist in the inbox.

## Visual style

- System-native: `font-family: system-ui, sans-serif`, neutral greys, no brand colors.
- Matches `sidepanel-test/` styling so the prototype feels continuous with existing project artifacts.
- Side panel visually distinguished from Gmail pane with a left border (1px solid #e0e0e0).
- Buttons are plain rectangles (like `sidepanel-test/`), no icons.
- Animations: simple opacity transitions (`transition: opacity 200ms`). No slide-outs, no complex choreography.

## State model

In-memory JavaScript objects:

```
emails: [
  { id, from, subject, read, starred, labels: [], archived: false, preBakedAction }
]

suggestions: [
  { emailId, action }   // populated during classification, drained on apply
]
```

Rendering is triggered after every state mutation — a single `render()` function that rebuilds both panes from state. Simple; sufficient for ~12 rows.

## Build order for implementation

1. Static HTML/CSS layout with hardcoded emails. Both panes render, nothing interactive.
2. `render()` function driven from in-memory state. Refresh shows same thing.
3. `Classify inbox` button drives streaming suggestion rendering.
4. Per-email action button applies the action (updates both panes).
5. Gmail-side visual reactions (fade-out, star glyph, label pill, bold removal).
6. `Apply all` button with staggered cascade.
7. Empty state + re-run behavior.
8. Polish: animation timings, spacing, copy.
