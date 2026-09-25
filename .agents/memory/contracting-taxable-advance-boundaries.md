---
name: Contracting taxable advance boundaries
description: Tax-point ownership, fiscal-only certificates, legacy safety, and partial advance settlement.
---

Taxable advance retries must preserve the original entered amount and inclusive/exclusive meaning rather than reprice against the contract's current VAT rate. Later certificate mode changes consume the original frozen principal and VAT. Unsupported rates or unrepresentable recovery cents must fail explicitly; never substitute a rate or convert historical accounting-only advances.

**Why:** The user approved matching the sales invoice inclusive checkbox for explicit taxable owner advances without changing historical advances or payment methods. An inclusive 100000 at 15% must freeze base 86956.52 and VAT 13043.48.

**How to apply:** Compare retries with the original input identity, and use the original invoice's tax split for subsequent receipt and recovery.

Keep new and editable owner and incoming subcontract-certificate VAT on current-period certified work before retention. Do not retrospectively recompute approved or posted snapshots, including approved legacy draft-journal evidence. The prior incoming legacy-preserve decision is superseded only for new/editable incoming certificates.

**Why:** Retention defers collection rather than reducing taxable work. Recomputing historical documents would detach their values from existing journals and electronic evidence.

**How to apply:** Use the same direction-explicit calculation for owner and subcontract creation, preview, editing and approval. Inconsistent historical VAT requires explicit correction, not silent repricing during fiscal issuance.

An explicitly taxable advance invoice owns the tax-point accrual; its receipt clears that invoice's receivable, rather than recognizing advance liability or VAT again. A certificate's electronic document references the existing certificate accounting and is not another sales posting.

**Why:** Routing a contracting fiscal document through ordinary sales posting would duplicate receivables or journals. Issuing an advance invoice before cash also means VAT cannot simply be deferred to the later receipt.

**How to apply:** Require explicit dedicated receivable mapping, preserve immutable source identity, and include fiscal documents in the existing registration's invoice chain. Never automatically reclassify legacy accounting-only advances.

Keep advance principal, VAT and gross cash distinct, with cumulative exact-cent allocation for partial receipts and recoveries.

**Why:** The older advance amount served both principal and payment roles. Reusing that ambiguity for taxable advances causes duplicated VAT or incorrect remaining balances; independent rounding of slices also loses the final cent.

**How to apply:** Recover original VAT with principal, use immutable original invoice references for ZATCA adjustments, and count each source once in tax and customer reporting. Protect source journals from generic editing/unposting, not only from the contracting screens.

Official reference: ZATCA XML Implementation Standard v1.2, section 9.5 (prepayment references and zero-value adjustment lines); implementation tests are not a substitute for actual ZATCA acceptance.