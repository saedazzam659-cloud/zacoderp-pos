---
name: Company document field controls
description: Product safety boundaries for company-level document-field visibility and editability settings.
---

The document-field control feature is opt-in per company and disabled by default. Only SuperAdmin can enable it. When enabled, a company manager edits one company-wide default that also applies to the manager; when disabled, manager access must be rejected by the API, not just hidden in the UI. Item-line tax rate is read-only by default.

**Why:** The user identified that unrestricted field changes could make ordinary users think the ERP is malfunctioning; gated rollout keeps the controls unavailable until deliberately enabled per company.

**How to apply:** Keep UI visibility and every read/write endpoint behind the same server-side company flag. Preserve ordinary document view/print behavior; apply field modes to create/edit forms only.
