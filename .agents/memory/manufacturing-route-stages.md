---
name: Variable manufacturing routes
description: Smart Manufacturing production routes can contain different stage counts and sequences across factories and products.
---

In Smart Manufacturing, the number and sequence of production stages come from the selected route/order snapshot. A factory or product may use four, six, ten, or another number of stages; never hard-code a six-stage assumption.

**Why:** The user confirmed that production processes differ across factories and products, so the tab layout must remain usable for both short and long routes.

**How to apply:** Render tabs and stage indicators from the route data, derive accessible position and total counts from the current list, and cycle visual accent colors independently of the number of stages.