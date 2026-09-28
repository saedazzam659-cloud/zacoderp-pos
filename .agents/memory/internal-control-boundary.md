---
name: Internal control boundary
description: Monitoring-only scope, permission intent, and evidence limits for internal control.
---

Internal control observes existing ERP cycles; it must never repair, block, post, reverse, or delete operational documents automatically.

**Why:** The requested module is human review, not a replacement accounting or approval workflow. A difference is not proof of misconduct.

**How to apply:** Keep rule outcomes as review cases with factual evidence. Reuse existing audit events; do not reconstruct missing historical before/after values from today's records. Skip historical policy comparisons when snapshots cannot establish the policy at the event date, and expose the limitation.

Company enablement is an upper bound, not a user grant. The company manager must be able to hide internal control from any company user, including an explicitly denied company-admin account, without changing other modules' admin conventions.

**Why:** The user explicitly required both superadmin-only company activation and company-manager control of individual access.

**How to apply:** Preserve default-off company activation and independent user grants across UI and API. Scope the explicit-admin-denial exception to internal control only.