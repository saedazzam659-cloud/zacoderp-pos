---
name: Invoice number reclamation safety
description: Draft-only repair, deleted-number proof, and isolation of independent invoice numbering streams.
---

Only reclaim deleted invoice numbers with durable proof that the deleted invoice was an unsigned draft. Ordinary deletion must preserve that proof atomically; absence of a live row alone does not establish legal eligibility.

**Why:** Sequence logs outlive invoices, and historical issued numbers must not become reusable merely because their rows disappeared. Old deletions without reliable evidence must fail closed.

**How to apply:** Repair locks the same sequence and counter as issuance. Ordinary single-draft corrections never rewind the counter. An explicitly requested atomic draft correction plus rewind must validate the remaining stream's protected high-water and retain durable evidence for any released old claim. Numeric-equivalent strings with different zero padding conflict only within that stream. Specialized POS/mobile/conversion allocators must not be guessed.

Require a server capability check before sending read-only previews to the repair POST endpoint.

**Why:** Older servers ignore an unknown preview flag and could execute the repair instead. A client-only preview button would therefore become a live write during a staggered upgrade.

**How to apply:** Disable the new preview/correction flow until the server advertises support, bind successful previews to the exact target and inputs, and revalidate inside the committing transaction.

Require at least one real tenant-owned item on invoice writes, but also keep the header and all lines in one transaction.

**Why:** Validating input cannot prevent an empty persisted invoice if the header commits and a later line insert fails. Description-only lines do not satisfy the requirement; real service items do.