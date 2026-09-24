---
name: New company defaults boundary
description: Scope approved for initial company settings and numbering without changing existing tenants or posting logic.
---

Apply the requested settings only when creating a genuinely new company: horizontal navigation, hidden quick item entry strip, five-digit numbering starting at 1, and initial accounting mappings.

**Why:** The user explicitly approved creation-time initialization but emphasized that existing companies must not change. This approval does not cover changing accounting calculations, posting rules, resetting existing counters, or copying defaults onto restored/imported companies.

**How to apply:** Keep this policy out of startup migrations, company updates, clone/restore/import paths, and approval of already-created pending companies. Deployed independent agents need an application update before their own future creations can use new defaults.

Contracting and manufacturing accounting have a separately authorized exception: provision their module-specific chart accounts and mappings for fresh companies only when the module is enabled, and fill missing defaults during an explicit disabled-to-enabled module transition.

**Why:** The user explicitly requested ready-to-use module accounting on central and agent installations, while accounting settings should show only the company's enabled modules.

**How to apply:** Do not backfill every existing company at startup. Preserve existing mapped accounts and historical postings; disabling a module hides settings rather than deleting accounts. Fresh template defaults must not bypass module selection. Manufacturing defaults use the canonical manufacturing settings, not duplicate accounting-mapping records. This exception does not authorize resetting other company defaults.

Independent numbering means separate document namespaces, not separate payment methods within the same document namespace.

**Why:** Cash/credit/bank invoices and auto-generated journal subtypes can share uniqueness constraints; starting each subtype independently at `00001` would create collisions.

**How to apply:** Preserve existing numbering allocation and uniqueness behavior. Group shared-namespace variants on one plain five-digit counter while keeping different document classes separate. Preserve explicit industry mappings; do not overwrite them to force a default.

Country-based defaults are initial settings, not a promise of jurisdiction-specific e-invoicing compliance.

**Why:** The user requested Egypt → EGP and 14% default VAT while explicitly keeping calculation/business logic unchanged. This does not authorize building ETA integration or assuming every Egyptian transaction is taxable at that rate.

**How to apply:** Apply currency/tax defaults only to fresh companies, retain editable tax treatment, and explain compliance boundaries. Do not replace existing tenant tax settings when deploying this feature.