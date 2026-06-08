---
name: ZATCA PIH/ICV chain is per-EGS, not per-table
description: Why submitting two independent invoice tables under one CSID/PCSID forks the ZATCA chain and how the correct fix looks.
---

ZATCA's invoice counter (ICV) and previous-invoice-hash (PIH) form ONE
continuous chain per EGS unit (i.e. per CSID/PCSID certificate). Each submitted
invoice's PIH must equal the hash of the immediately previous invoice submitted
under the SAME certificate, and ICV must increment by exactly 1 across that
single stream.

**The trap:** this ERP has two separate invoice tables that can both submit to
ZATCA — web `invoices` (chain in `invoices.invoiceCounterValue` /
`previousInvoiceHash`) and back-office `sales_invoices` (chain in
`sales_invoices.zatca_icv` / `invoice_hash`). Each computes its own
`MAX(icv)+1` and its own "last hash" independently. If a company uses BOTH flows
under the SAME company CSID/PCSID, the two streams interleave at the gateway and
the chain forks: PIH won't match the last invoice ZATCA actually saw, and ICVs
duplicate/skip → ZATCA rejects.

**Why it usually doesn't blow up immediately:** most companies use only one of
the two paths, so the single-stream invariant holds by accident.

**Correct fix (deferred — significant refactor, ask before doing):** unify both
flows onto a SINGLE per-company chain head (one source of truth for ICV+PIH,
e.g. a dedicated `zatca_chain` row or a shared sequence), and consume the next
ICV atomically inside one transaction (advisory lock or conditional update) so
concurrent submissions can't mint the same ICV. Until then, a company must pick
ONE submission path.

**How to apply:** any time you add a NEW ZATCA submission path for a different
document table, do NOT give it its own ICV/PIH counter — route it through the
same per-company chain head as existing paths.
