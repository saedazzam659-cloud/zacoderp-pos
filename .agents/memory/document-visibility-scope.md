---
name: Document visibility scope
description: Product boundary for optional per-user ownership filters on business documents and reports.
---

Per-user visibility controls must default off to preserve existing behavior. When enabled for a document type, scope reads to the authenticated creator; company admins and superadmins retain company-wide visibility. Reports must apply the same scope to the documents they aggregate, and must not expose unscoped side-data as part of an own-only report.

**Why:** The requested control is an optional visibility restriction, not a change to company ownership or document permissions. Managers need a full-company view, while users without the setting must see no behavior change.

**How to apply:** Keep the setting separate from ordinary action permissions, enforce it in server-side list/detail/report queries, and treat missing ownership attribution as not visible in own-only mode.
