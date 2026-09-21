---
name: Invoice number reclamation safety
description: Draft-only repair, deleted-number proof, and isolation of independent invoice numbering streams.
---

Automatic reclamation requires durable proof that the deleted invoice was an unsigned draft. Ordinary deletion must preserve that proof atomically; absence of a live row alone does not establish legal eligibility.

**Why:** Sequence logs outlive invoices, and historical issued numbers must not become reusable merely because their rows disappeared. Old deletions without reliable evidence must fail closed.

**How to apply:** Repair locks the same sequence and counter as issuance. Ordinary single-draft corrections never rewind the counter. An explicitly requested atomic draft correction plus rewind must validate the remaining stream's protected high-water and retain durable evidence for any released old claim. Numeric-equivalent strings with different zero padding conflict only within that stream. Specialized POS/mobile/conversion allocators must not be guessed.

An explicit superadmin manual exception for unknown legacy reservations is permitted only with informed acknowledgement, a recorded reason, preview, and durable exact-claim audit history. Never describe that exception as verified unsigned deletion evidence or erase the original reservation.

**Why:** On 2026-09-22 the user explicitly accepted the risk that missing historical data cannot prove a number was never issued, and approved a manual exception within the existing tool to recover their numbering sequence.

**How to apply:** Keep strict rejection as the default; refuse known live owners, signed/fiscal evidence, and known issued history even with the exception. Limit the exception to the selected draft's atomic renumber-and-counter repair, with tenant and stream isolation.

Require a server capability check before sending read-only previews to the repair POST endpoint.

**Why:** Older servers ignore an unknown preview flag and could execute the repair instead. A client-only preview button would therefore become a live write during a staggered upgrade.

**How to apply:** Disable the new preview/correction flow until the server advertises support, bind successful previews to the exact target and inputs, and revalidate inside the committing transaction.

Require at least one real tenant-owned item on invoice writes, but also keep the header and all lines in one transaction.

**Why:** Validating input cannot prevent an empty persisted invoice if the header commits and a later line insert fails. Description-only lines do not satisfy the requirement; real service items do.