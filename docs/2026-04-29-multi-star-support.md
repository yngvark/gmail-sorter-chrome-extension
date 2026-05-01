# Multi-variant Star support

**Date:** 2026-04-29

## What changed

The classifier picks between three star variants instead of a single "Star" action:

- `Star: Yellow` — generic important / personal mail
- `Star: Red` — needs a reply or action soon
- `Star: Red bang` — urgent, needs attention today

Each variant applies the system `STARRED` label *plus* a custom user-label whose name matches the action and whose color matches the intended star variant:

| Variant | Label name | bg color | text color |
|---|---|---|---|
| yellow | `Star/Yellow` | `#fad165` | `#594c05` |
| red | `Star/Red` | `#cc3a21` | `#ffffff` |
| redBang | `Star/RedBang` | `#ac2b16` | `#ffffff` |

The labels are lazy-created on the first apply for each variant and cached in `chrome.storage.sync` (mirroring the existing `Move: Follow-up` pattern). The action also archives the message (removes `INBOX`).

Why custom labels and not Gmail's actual coloured stars? Gmail's superstar IDs (`^ss_sy`, `^ss_sr`, `^ss_cr`) are real and read-back-correct, but the public REST API rejects writes to them with `400 Invalid label`. Gmail's UI applies them via an internal RPC the extension cannot reach. Custom labels are the documented, supported alternative.

## Multiple Inboxes

The user runs Gmail's Multiple Inboxes feature with star-based panes below the main inbox. To preserve per-priority panes after this change, update each pane's search query in Gmail Settings → Inbox → Multiple Inboxes:

- `has:yellow-star` → `label:Star/Yellow`
- `has:red-star` → `label:Star/Red`
- `has:red-bang` → `label:Star/RedBang`

The system `STARRED` label is also applied, so a generic `is:starred` view still catches all three.

## Why three variants

The previous single `Star` action only produced the default yellow star. The user uses three star variants as priority markers — yellow for general important mail, red for "reply soon", red bang for "urgent today" — and the classifier needs to drive that workflow rather than collapsing all three into one.

## Why specific variant names instead of semantic names

Action strings use color names (`Star: Red`) rather than meaning names (`Star: Reply soon`). The user reasons about their mailbox in colors because that's what Gmail shows. The semantic mapping lives in `DEFAULT_RULES` text, not in the action labels.

## Verification

Superstar label IDs (`^ss_sy`, `^ss_sr`, `^ss_cr`) were tested for writability via `messages.modify` and `threads.modify`. Both returned `400 Invalid label` for all variants. Gmail's UI applies them via an internal RPC, not the public REST API. Custom labels (above) are the solution.

## Spec

`docs/superpowers/specs/2026-04-29-multi-star-design.md`.
