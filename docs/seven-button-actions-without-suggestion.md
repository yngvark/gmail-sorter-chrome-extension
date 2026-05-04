# Seven-button actions without a suggestion

## What

The side panel renders all seven action buttons on every email row, even
emails that have no stored suggestion. Clicking any button now executes
the chosen action and clears the row (or noops, for "Leave alone")
instead of failing with `suggestion not found`.

Two paths into "no stored suggestion":

1. **Email never classified.** The user fetched the inbox and clicked an
   action before running Classify, or classification ran but excluded the
   row (e.g. it arrived after).
2. **Classifier picked "Leave alone".** Previously these were silently
   dropped on the way to storage, leaving the row with no highlighted
   prediction and every click on it failing. They are now stored and
   highlighted like any other prediction.

## Why

The seven-button row replaced a single action pill that was hidden when
no suggestion existed. The backend kept the pre-seven-button assumption
that `applyOne` always has a suggestion to look up, so any click on a
row without one returned `{ ok: false, error: { kind: "missing", ... } }`
and surfaced the "Couldn't apply / suggestion not found" toast.

The seven-button UI is an explicit invitation to act on any row at any
time — including rows the model never had an opinion on. The fix makes
the backend match that invitation.

## Design choices

- **`applyOne(emailId, chosenAction)` accepts a missing suggestion** when
  `chosenAction` is provided. No suggestion → no prediction to disagree
  with → no disagreement is recorded; the action simply applies.
- **Missing suggestion + missing `chosenAction` still returns `missing`.**
  The legacy "click the predicted pill" path and `applyAll` both rely on
  `applyOne` knowing what to apply from storage. Removing the error
  there would silently no-op those callers.
- **"Leave alone" is now stored as a suggestion.** The seven-button UI's
  prediction highlight is meaningless without it. The existing `noop`
  branch in `applyOne` handles the apply: suggestion cleared, Gmail
  untouched, inbox row preserved.
- **Side panel un-fades the row on `ok && noop`.** The fade-on-click
  optimism assumed every successful apply removes the inbox row. Noop
  leaves the row in place, so the fade is rolled back to avoid a
  half-faded row sitting in the list.

## Out of scope

- Auto-classifying on first click. The user can still run Classify
  explicitly; making clicks classify implicitly would block the click
  on a model round-trip and surprise users who just want to act.
- Hiding the seven-button row until classification has run. The design
  intent is "act anytime"; gating buttons on classification state would
  reverse that.
- Cleaning up the placeholder/dev path in `sidepanel.js` so it mirrors
  the new noop semantics. The placeholder always drops the row on
  apply; that's fine for visual iteration and not worth diverging the
  two paths over.
