---
name: Approved agent UI
description: Preserve the user's approved current web UI while making agent-specific customization optional.
---

Treat the current agent-facing web UI and its design as approved. Do not replace or globally redesign it as part of adding UI customization.

**Why:** The user is fully satisfied with the current design and explicitly requires that the new feature not break or alter it.

**How to apply:** New views and report navigation must be independently enabled per agent, default off, and reversible. Agents without the feature enabled must keep the existing layout, routes, reports, permissions, and workflows unchanged. Keep UI preferences separate from business data and server-side authorization.