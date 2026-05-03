// Renders the text content for an action pill, prefixing star variants
// with a glyph so the user can tell yellow / red / red bang apart at a
// glance without relying on color alone (border color also differs; see
// sidepanel.css). Non-star actions render verbatim.

export function actionPillContent(action) {
  if (action === "Star: Yellow")   return "★ Star: Yellow";
  if (action === "Star: Red")      return "★ Star: Red";
  if (action === "Star: Red bang") return "❗ Star: Red bang";
  return action;
}

// Icons rendered inside each action button. Emoji keep this dependency-free
// and visible at any font size. Refining to inline SVG is a separate change.
export const ACTION_ICONS = Object.freeze({
  "Star: Yellow":   "⭐",
  "Star: Red":      "🔴",
  "Star: Red bang": "‼️",
  "Archive":        "📥",
  "Mark read":      "✓",
  "Move: Follow-up":"↪",
  "Leave alone":    "💤",
});
