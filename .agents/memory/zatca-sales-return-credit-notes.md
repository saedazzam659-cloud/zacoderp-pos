---
name: ZATCA sales-return credit notes
description: Durable rules for submitting ERP sales returns as ZATCA UBL 381 credit notes.
---

Sales returns sent to ZATCA are positive-valued UBL credit notes (`InvoiceTypeCode 381`), not negative tax invoices. They must reference the original posted invoice number and carry a return reason.

**Why:** ZATCA document semantics perform the reversal. Negative amounts or an independent return chain produce invalid documents, while submitting inside the accounting post makes a gateway outage look like a failed financial posting.

**How to apply:** Invoice and return submissions must serialize on the same per-company advisory lock and choose ICV/PIH from the unified successful chain. A cleared/reported return is immutable and idempotently treated as already sent. Automatic submission starts only after the return is posted, runs in the background, and records rejection/network failure without undoing stock or journal effects.