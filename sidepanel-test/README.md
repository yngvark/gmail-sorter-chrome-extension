# Side Panel Test

Minimal extension to verify whether Chrome's `chrome.sidePanel` API works in Brave. Before committing to a side-panel UX for the Gmail sorter, we need to confirm Brave does not hit the known bugs:

- [Brave #32132](https://github.com/brave/brave-browser/issues/32132) — panel disappears after ~1 second
- [Brave #31328](https://github.com/brave/brave-browser/issues/31328) — browser crash when sidepanel extension is installed
- [Brave #31334](https://github.com/brave/brave-browser/issues/31334) — no sidebar UI to activate sidepanel extensions

## Load in Brave

1. Open `brave://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `sidepanel-test/` directory.
4. Pin the extension icon to the toolbar (puzzle-piece menu → pin).

## What to test

Click the pinned toolbar icon. Then check:

| # | Check                                                                | Pass |
|---|----------------------------------------------------------------------|------|
| 1 | Brave does not crash on install or on click                          | [x]  |
| 2 | Panel opens on the right side of the window                          | [x]  |
| 3 | Panel stays open (title + "Panel opened at" visible) after 5 seconds | [x]  |
| 4 | `Tick:` counter keeps incrementing (proves JS keeps running)         | [x]  |
| 5 | "Click me" button registers clicks in the log                        | [x]  |
| 6 | Panel survives switching tabs and returning                          | [x]  |
| 7 | Panel reopens reliably after closing it                              | [ ]  |

If all seven pass, Brave's `chrome.sidePanel` support is good enough for the Gmail sorter. If any fail, fall back to a content script scoped to the Gmail inbox list view.

## Files

- `manifest.json` — declares `sidePanel` permission and `side_panel.default_path`
- `background.js` — calls `setPanelBehavior({ openPanelOnActionClick: true })` so the toolbar icon opens the panel
- `sidepanel.html` / `sidepanel.js` — renders a timestamp, a click counter, and a 1-second tick
