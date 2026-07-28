---
name: Per-user posting rights
description: users.posting_permissions matrix (post/unpost per AutoPostDocType) — allow-by-default semantics + ALS request context enforcement
---

The rule: per-user post/unpost rights live in `users.posting_permissions` jsonb keyed by the SAME AutoPostDocType keys as the company auto-post toggles. Missing map / missing key / undefined = ALLOWED; only explicit `false` denies. Admin & superadmin always bypass (`lib/postingRights.ts`).

**Why:** user chose "keep current behavior by default" — nobody loses access when the feature ships; deny is opt-in per user. Several unpost endpoints previously required admin; that was deliberately RELAXED to the unpost-right check.

**How to apply:**
- Enforcement has TWO layers that must both be covered for any NEW doc type / route:
  1. `requirePostRight(docType)` / `requireUnpostRight(docType)` middleware on every /post and /unpost endpoint (sister-companies returns/settlements were missed on the first pass — audit ALL post routes of a module, not just the obvious ones).
  2. `resolvePostingStatus` returns "draft" for users lacking the post right — the user comes from an AsyncLocalStorage request context (`lib/requestContext.ts`, mounted in app.ts, filled by extractAuth), so deep JE builders (hr/fa/contracting/adjustments) need NO param threading. Scheduler/system context = no user = allowed.
- Frontend matrix (Users.tsx "posting" tab) seeds every checkbox CHECKED unless stored false; server `sanitizePostingPermissions` collapses malformed payloads to null (= all allowed).
