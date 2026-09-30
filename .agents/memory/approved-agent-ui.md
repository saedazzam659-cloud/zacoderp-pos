---
name: Approved agent UI
description: Preserve the user's approved current web UI while making agent-specific customization optional.
---

Treat the current agent-facing web UI and its design as approved. Do not replace or globally redesign it as part of adding UI customization.

**Why:** The user is fully satisfied with the current design and explicitly requires that the new feature not break or alter it.

**How to apply:** New views and report navigation must be independently enabled per agent, default off, and reversible. Agents without the feature enabled must keep the existing layout, routes, reports, permissions, and workflows unchanged. Keep UI preferences separate from business data and server-side authorization. Persist agent controls in the central registry, exclude their columns from external-agent schema healing and fresh schema dumps, and expose only allow-listed display policy.

For module shortcut icon styling, the approved scope is shortcut grids across modules plus the General Settings tab grid. Do not extend it to sidebars, inline links, data/KPI cards, or unrelated clickable controls without a new request.

**Why:** The user explicitly chose all module shortcut grids while keeping the treatment optional per agent; expanding the visual change to other controls would exceed that scope.

**How to apply:** Gate any future shortcut-grid styling with the agent's central preference and preserve existing hrefs, filtering, permissions, and screen logic.