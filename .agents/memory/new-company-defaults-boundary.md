---
name: New company defaults boundary
description: Scope approved for initial company settings and numbering without changing existing tenants or posting logic.
---

Apply the requested settings only when creating a genuinely new company: horizontal navigation, hidden quick item entry strip, five-digit numbering starting at 1, and initial accounting mappings.

**Why:** The user explicitly approved creation-time initialization but emphasized that existing companies must not change. This approval does not cover changing accounting calculations, posting rules, resetting existing counters, or copying defaults onto restored/imported companies.

**How to apply:** Keep this policy out of startup migrations, company updates, clone/restore/import paths, and approval of already-created pending companies. Deployed independent agents need an application update before their own future creations can use new defaults.

Independent numbering means separate document namespaces, not separate payment methods within the same document namespace.

**Why:** Cash/credit/bank invoices and auto-generated journal subtypes can share uniqueness constraints; starting each subtype independently at `00001` would create collisions.

**How to apply:** Preserve existing numbering allocation and uniqueness behavior. Group shared-namespace variants on one plain five-digit counter while keeping different document classes separate. Preserve explicit industry mappings; do not overwrite them to force a default.