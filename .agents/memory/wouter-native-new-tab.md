---
name: Native new-tab navigation with Wouter
description: Preserve true browser new-tab behavior for links in Wouter-routed artifacts.
---

Use a native `<a target="_blank" rel="noopener noreferrer">` when an affordance should open a route in a new tab. Build its href from `import.meta.env.BASE_URL` plus the internal route so artifact path-based routing is preserved.

**Why:** Wouter's `Link` handles an unmodified left-click by preventing the browser default and calling SPA navigation; it does this even if `target="_blank"` is passed, so the click does not reliably open a new tab.

**How to apply:** Keep the normal Wouter `Link` for the card's primary click and render a separate native anchor for the new-tab control. The native anchor must be outside the primary link and use the artifact base path.