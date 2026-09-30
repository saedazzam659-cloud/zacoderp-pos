---
name: Sales batch print provenance
description: Keep print-only sales lot traceability accurate without changing fiscal payloads or legacy layouts.
---

# Sales batch print provenance

**Rule:** For posted sales invoices and returns, derive printed lot, expiry, warehouse, and quantity details from stock-ledger movements linked to the source line. For an unposted invoice, show only saved manual picks and label them as unposted; do not present a FIFO/FEFO suggestion as an actual issue. Add the lot block only when batch identifiers are available, and keep it outside ZATCA payloads.

**Why:** Before posting, a batch selection is only a plan; the posting transaction revalidates it against locked stock. After posting, the ledger records what actually moved. Conditional line annotations preserve existing print layouts for documents without tracked lots, while keeping fiscal data unchanged.

**How to apply:** When adding sales batch details to another print/export path, use posted ledger provenance, include individual and bulk document output, and never print current on-hand availability as if it were a historical invoice fact.