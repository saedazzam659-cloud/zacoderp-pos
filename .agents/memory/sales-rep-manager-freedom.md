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
2. Backend attribution — create and update must resolve a normal user's active linked rep
   before considering any submitted `salesRepId`; the link is server-authoritative and a
   patched client cannot select another rep. Managers bypass this and may pick any rep or none.

**Why:** the picker is the only thing the user sees, but the create handler is what actually
writes `salesRepId`. Fixing only the UI lets a manager pick "no rep" yet still get auto-tagged
to their linked rep on save. Both must agree.

**How to apply:** role field is `req.authUser.role`. Resolve `repIdForUser` for normal users
on invoice create/update, use it ahead of submitted values, and snapshot commission from that
effective rep. Admin/superadmin skip linked-rep resolution.
