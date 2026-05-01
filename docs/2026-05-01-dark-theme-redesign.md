# Dark theme redesign

A visual overhaul of the side panel and options page. The "Inbox Gazette"
editorial concept (italic display headings, all-caps tracked-out
eyebrows, hairline rules) is preserved, but the warm-paper palette is
replaced with a refined dark surface and a single saffron signal accent.

## Why

The previous palette — warm cream paper (`#f3ede1`), forest green
primary, sienna error, gold highlight — drew complaints that the colors
were "awful". The cream read as muddy and dated next to Gmail's bright
white UI, and the action pills were low-contrast on the cream
background, which hurt scannability. Dark surface + bright accent
fixes both problems: the panel reads as a focused tool pane distinct
from Gmail, and tinted action pills become first-class signals against
the dark.

## Direction

Refined dark, editorial-tech. Deep ink surfaces, warm off-white text,
single saffron accent (`#f4b740`) for primary actions and decorative
markers. Each classification action retains a distinctive hue, but
those hues are now tuned for legibility against the dark surface
rather than the cream.

## Palette

```css
/* Surfaces — top-down by elevation */
--ink-0:      #0d0e12;   /* deepest, body bg */
--ink-1:      #14161c;   /* primary surface */
--ink-2:      #1c1f29;   /* raised surface (cards, banners) */
--ink-3:      #262a37;   /* hover surface */
--rule:       #2d3242;   /* hairline borders */
--rule-soft:  #1a1d27;   /* whisper-quiet separators */

/* Foreground */
--paper:      #f1ebdf;   /* primary text — warm off-white */
--paper-2:    #c8c1b3;   /* secondary text */
--paper-3:    #847d6f;   /* tertiary, captions */
--paper-4:    #524d44;   /* very muted */

/* Signal */
--accent:     #f4b740;   /* saffron */
--accent-hi:  #ffd06b;   /* lighter, hover */

/* Action semantics — distinct hues, dark-surface tuned */
--gold:       #f4b740;   /* Star: Yellow */
--coral:      #ff6360;   /* Star: Red */
--coral-hot:  #ff3b3b;   /* Star: Red bang */
--mint:       #5fe2a8;   /* Archive */
--violet:     #a594ff;   /* Move: Follow-up */
--slate:      #8896a8;   /* Mark read */
```

Off-white is `#f1ebdf` (warm) rather than pure white — pure white
against deep ink reads as clinical and harsh. The warm tint preserves
the editorial cadence while the surface beneath is unambiguously
modern dark.

## Action pill treatment

Pills use a tinted, low-alpha background tile with the action's accent
text and a soft border at rest; on hover they lift to a solid accent
fill with a colored drop shadow. This keeps rows scannable without
shouting six different colors at once, but each suggestion is still
instantly identifiable by hue:

| Action          | Hue   | Why                                  |
| --------------- | ----- | ------------------------------------ |
| Star: Yellow    | gold  | matches the star color users expect  |
| Star: Red       | coral | matches the red star                 |
| Star: Red bang  | hot red, bolder weight | escalation cue        |
| Archive         | mint  | "done / out of the way" semantics    |
| Move: Follow-up | violet | distinct from stars and from archive |
| Mark read       | slate | quietest — least-action action       |

Saffron doubles as primary accent and Star: Yellow color. They never
compete in practice: the Classify button is full-width and only shown
once at the top, while pills are small and tied to specific rows.

## Decorative motifs

The `❦` floret used in the warm-paper version reads as twee on dark.
It's replaced with a small saffron diamond glyph (drawn with rotated
4-6px squares, no font dependency) that appears:

- as bullets either side of the eyebrow in mastheads
- at the center of horizontal rules
- as a section marker preceding each `field-group__title` on the
  options page

Atmospheric backdrop is a pair of very low-opacity radial gradients
(saffron top-right, cool wash bottom-left) and a 3px-pitch horizontal
scanline pattern at ~1% opacity for press-print texture without going
loud.

## Typography

Same Gmail font stack
(`"Google Sans", "Roboto", ..., sans-serif`) — see `typography.md` for
why we still don't bundle a web font. Editorial character comes from
weight, italic, and tracking, not a different family. Italic 400 at
32px (panel) / 56px (options page) for the masthead title, semibold
all-caps with 0.22-0.28em letter-spacing for eyebrows, italic body for
hints and standfirst paragraphs.

`--mono` is unchanged. Code blocks (the `OLLAMA_ORIGINS=...` snippet,
input values like the Ollama base URL, classification rules textarea)
render in monospace and pick up `--accent-hi` for color so they read
as terminal-flavored and a little gem-like against the deep surface.

## Component changes summary

- `extension/sidepanel/sidepanel.css` — full rewrite, same selectors.
- `extension/options/options.css` — full rewrite, same selectors.
- HTML (`sidepanel.html`, `options.html`) — unchanged. The eyebrow
  diamond bullets are CSS pseudo-elements; nothing in the markup needs
  to know about them.

The 117 existing unit/integration tests still pass; CSS changes don't
touch any behavior they cover.

## Trade-offs considered

- **Why not light & airy**: Linear-style off-white with one accent
  would feel modern but blend into Gmail. The whole point of a
  side-panel tool is to be a distinct surface.
- **Why not keep editorial + recolor**: Retried with cool ivory and
  Klein blue — still felt like the same flavor that prompted the
  complaint. A categorical break (dark) was the right move.
- **Why not bold maximalist**: Strong gradients and layered colors
  would compete with the email content the panel exists to surface.
  Dark + one accent leaves the user's data as the loudest thing on
  screen, which is correct.
