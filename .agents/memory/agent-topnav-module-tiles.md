---
name: Agent top navigation and module tiles
description: How server-level top-navigation availability combines with selected module tile hubs.
---

On agent domains, `mainNavDropdowns` controls whether the company can use the top-navigation layout. When enabled and a company selects that layout, entries selected by `moduleScreensAsTiles` open their existing module tile hubs; remaining groups keep their dropdown menus. Do not replace this behavior with decorative icons on dropdown triggers.

**Why:** The two server settings are complementary: one enables the top-navigation presentation, and the other selects modules that should open their existing card screens instead of dropdowns.

**How to apply:** When changing agent navigation, verify the sidebar fallback while top navigation is disabled, the top bar when both settings are enabled, selected module hub links, and dropdown behavior for unselected groups.
