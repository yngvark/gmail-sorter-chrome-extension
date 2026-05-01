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
