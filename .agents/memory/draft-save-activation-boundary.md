---
name: Draft-save activation boundary
description: Preserve legacy document workflows unless draft saving is explicitly enabled from Approval Permissions.
---

Draft saving is opt-in per user and document type through the Users → Approval Permissions screen. Existing users and companies must keep their current save, numbering, and posting behavior unless an administrator enables the specific document type. An enabled user without approval authority for that type is draft-only; a user with approval authority may still use the normal workflow.

**Why:** The ERP has many existing tenants and established posting/numbering flows; enabling a new draft workflow globally would change their behavior without consent.

**How to apply:** Keep all stored defaults empty/false, hide draft controls unless granted, and enforce the same rule in server save and post paths. Treat draft numbering as separate from official sequence numbers.
