# Typography

The side panel and options page use Gmail's font stack:

```
"Google Sans", "Roboto", "RobotoDraft", "Helvetica", "Arial", sans-serif
```

This stack was lifted from Gmail's email-list-row computed style.

## Why match Gmail

The panel docks next to Gmail. Two side-by-side surfaces with different
typography read as two unrelated apps; matching the stack makes the
extension feel like a natural extension of the inbox rather than an
admin tool bolted on.

## What the multi-name stack means

It is a fallback chain, not multiple fonts loaded at once. The browser
tries each name in order and uses the first one installed locally:

1. **Google Sans** — Google's product font; only installed if the user
   has certain Google software locally.
2. **Roboto** — Google's open-source UI font; widely installed on
   Android and many desktop systems.
3. **RobotoDraft** — historical name for an early version of Roboto;
   present on a small number of older systems.
4. **Helvetica** — common on macOS.
5. **Arial** — common on Windows and elsewhere.
6. **sans-serif** — the browser's generic sans fallback if none of the
   above are installed.

No web fonts are loaded. The extension does not embed Google Sans
because it is proprietary and not free to redistribute, and shipping
Roboto would add weight for marginal benefit — almost every user
already has one of the fallbacks.

## How the stack is wired in CSS

`extension/sidepanel/sidepanel.css` and `extension/options/options.css`
both define a single `--gmail-stack` custom property and point the
existing typography variables at it:

```css
--gmail-stack:   "Google Sans", "Roboto", "RobotoDraft", "Helvetica", "Arial", sans-serif;
--serif-display: var(--gmail-stack);
--serif-body:    var(--gmail-stack);
--sans:          var(--gmail-stack);
--mono:          "JetBrains Mono", "SF Mono", ...;
```

The `--serif-display`, `--serif-body`, and `--sans` names are kept so
existing `font-family: var(--serif-body)` rules across the stylesheets
do not need to be touched. They all resolve to the same family now;
the names are historical and a future cleanup can collapse them.

`--mono` is intentionally untouched — counters, timestamps, and
inline `<code>` elements (e.g. the `OLLAMA_ORIGINS=...` snippet on the
options page) keep their monospace family because monospace carries
functional meaning there.

## What changed

Before this swap, the panel used an editorial serif stack
(Iowan Old Style → Charter → Georgia) for body and display text, and a
separate sans (Söhne → Inter Tight → Helvetica Neue) for UI furniture.
That stack gave the panel a distinct "warm paper" identity but read as
unrelated to Gmail. The palette, layout, italic display headings, and
hairline rules stay; only the family changes.
