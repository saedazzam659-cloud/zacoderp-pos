---
name: Sales-rep picker lock vs manager freedom
description: Why admin/superadmin must be exempt from rep-picker lock AND auto-attribution, in two separate places.
---

The sales-document rep dropdown locks to a single rep when the logged-in user is
linked to a sales rep (`sales_reps.user_id`). Company managers (`role=admin`) and
superadmins must keep FULL freedom to pick any rep (or none), even when their own
user happens to be linked to a rep.

**Rule:** manager-role exemption must be enforced in BOTH places, or the fix is half-done:
1. Frontend picker lock — `GET /api/sales-reps/me/current` must return 404 (treated as
   "not linked") for `req.authUser.role` admin/superadmin, so the UI keeps the picker open.
2. Backend create auto-attribution — `POST /sales-invoices` falls back to `repIdForUser`
   only for non-managers (`isManagerRole ? null : await repIdForUser(...)`). Note `null ?? x`
   is nullish-falsy, so even an explicit empty `salesRepId` would otherwise re-trigger the
   fallback and silently tag the manager's linked rep.

**Why:** the picker is the only thing the user sees, but the create handler is what actually
writes `salesRepId`. Fixing only the UI lets a manager pick "no rep" yet still get auto-tagged
to their linked rep on save. Both must agree.

**How to apply:** role field is `req.authUser.role`. Auto-attribution helper `repIdForUser`
is used only in invoice-create; order/quotation/return/update paths use explicit `salesRepId`
and don't force the linked rep. Normal (non-manager) reps keep auto-tagging on omitted field.
