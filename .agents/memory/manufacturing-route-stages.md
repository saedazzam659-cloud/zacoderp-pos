---
name: Variable manufacturing routes
description: Smart Manufacturing production routes can contain different stage counts and sequences across factories and products.
---

In Smart Manufacturing, the number and sequence of production stages come from the selected route/order snapshot. A factory or product may use four, six, ten, or another number of stages; never hard-code a six-stage assumption.

**Why:** The user confirmed that production processes differ across factories and products, so the tab layout must remain usable for both short and long routes.

**How to apply:** Render tabs and stage indicators from the route data, derive accessible position and total counts from the current list, and cycle visual accent colors independently of the number of stages.

Routing stages may assign multiple employees. Copy those IDs into each production order's independent stage snapshot so order edits never change the reusable route. Keep the first selected employee as the legacy operator for existing cost/report attribution; retain the full list for operational assignment and stage events.

**Why:** The owner needs route defaults to flow into manufacturing orders while allowing order-specific staffing changes, without changing established accounting attribution.

**How to apply:** Validate every assigned employee as active and company-scoped; validate branch scope when executing an order stage. Keep assignment lists separate from singular legacy operator fields.

Material-stage assignments are tied to recipe-line IDs and copied into each new production order. Changes to a reusable route must not rewrite existing orders; each new order can adjust its mapping before stock is issued.

**Why:** The user chose an independent snapshot per order and needs to avoid ambiguous mapping when a recipe repeats the same item on multiple lines.

**How to apply:** Preserve the order's material-stage mapping as its own snapshot. Never silently reassign a material line with an active stock issue; any later edit must preserve the issue history.