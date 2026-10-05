---
name: School academic-control boundary
description: Durable grading, publication, and guardian-visibility rules for the existing school module.
---

Keep academic control inside the existing school records and guardian portal; do not create a second student, enrollment, or portal data flow.

Configure midyear and year-end component weights independently for each grade and subject. Each weight group must total 100%. Do not assume official passing marks, second-round thresholds, or grade bands; the school configures them.

Do not approve a weighted result while any positive-weight component is missing. Approval publishes a fixed result snapshot. Editing published grades requires an administrator to reopen the result, with the action recorded in the audit trail.

Guardian accounts are read-only. Show final results only from active approved snapshots, and show daily assessments only when the subject policy explicitly enables guardian visibility.

**Why:** Schools may follow different grading rules, and published results must remain stable and auditable without exposing unapproved marks to guardians.

**How to apply:** Preserve these boundaries in changes to school assessments, approval/reopen flows, result reports, and the guardian portal.
