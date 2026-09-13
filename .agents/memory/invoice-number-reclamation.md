---
name: Invoice number reclamation safety
description: Draft-only repair, deleted-number proof, and isolation of independent invoice numbering streams.
---

Only reclaim deleted invoice numbers with durable proof that the deleted invoice was an unsigned draft. Ordinary deletion must preserve that proof atomically; absence of a live row alone does not establish legal eligibility.

**Why:** Sequence logs outlive invoices, and historical issued numbers must not become reusable merely because their rows disappeared. Old deletions without reliable evidence must fail closed.

**How to apply:** Repair locks the same sequence and counter as issuance. Single-draft corrections may advance but never rewind the counter; explicit rewind checks the high-water within the actual kind/branch/period/payment/foreign stream. Numeric-equivalent strings with different zero padding conflict only within that stream. Specialized POS/mobile/conversion allocators must not be guessed.

Require at least one real tenant-owned item on invoice writes, but also keep the header and all lines in one transaction.

**Why:** Validating input cannot prevent an empty persisted invoice if the header commits and a later line insert fails. Description-only lines do not satisfy the requirement; real service items do.