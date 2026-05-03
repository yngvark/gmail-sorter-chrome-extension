# Self-improving mapping prompt

## What

The "mapping prompt" is the system message Gmail Sorter sends to the local
Ollama model when classifying inbox emails. Its rules section is editable
and improvable. Each email row in the side panel shows all seven actions
inline; the predicted action is highlighted. Clicking a non-predicted
action records a disagreement. The bottom of the side panel shows the full
mapping prompt, the rules editor, the disagreement list, the read-only
meta-prompt, and an "Improve mapping prompt" button. Improve sends rules
+ disagreements to Ollama via the meta-prompt, validates the response,
overwrites the rules on success, clears disagreements, and re-classifies
the inbox.

## Why

Manually rewriting rules whenever the classifier mispredicts is friction
the user shouldn't pay. Capturing every disagreement at the click site and
periodically asking the same model to refine its own ruleset closes the
feedback loop without ever sending email content off the local machine.
Visibility is non-negotiable: the user wants to *see* every prompt the
model receives — both the classification system message and the meta-prompt
that drives Improve — and *see* the rules change after Improve runs.

## Design choices

- **Overwrite, no history.** Simplicity over rollback. Bad improvements
  are corrected by editing manually or accumulating new disagreements.
- **Clear disagreements on success.** Each Improve cycle starts fresh.
  Failures preserve the buffer so retry is possible without re-clicking.
- **Cap at 50 disagreements.** Bounds the meta-prompt size against the
  model's context window; oldest dropped silently.
- **One Ollama model.** Same model classifies and improves. Rules are
  validated to mention at least one action name as a sanity check.
- **Bottom-of-panel placement.** The user scrolls down to reach the
  mapping section; suggestions stay at the top, where attention belongs
  during normal use.

## Out of scope

- Prompt-version history / rollback.
- A/B testing old vs new rules.
- Editable meta-prompt.
- Background or scheduled improvement.
- Per-disagreement ignore / delete controls.
