---
name: Audit-grid numeric column wiring
description: How many spots a new numeric column needs in zatca-invoicing audit grids; SalesAuditGrid has extra hidden ones.
---

Adding a numeric column to a zatca-invoicing audit grid touches more than the COLUMNS array.

**Shared-hook grids** (SalesQuotations/Orders/Returns, Purchase*, etc. — use `useAuditGridLayout`): 5 spots — COLUMNS entry (with `valueOf` → sort/filter come free), `totals` reduce accumulator + initial object, row render switch `case`, footer `if (col.key === …)`, and the XLSX `handleExportExcel` row object (+ one `{ wch }`). CSV (`exportCsv`) is generic over `visibleColumns`+`valueOf` — no change. Print/HTML builders are separate and usually out of scope.

**SalesAuditGrid is bespoke** and needs ~8 spots: COLUMNS, the **filter** cellValue switch, the **sort** getCell switch (returns `{v,isNum}`), the footer `totals` reduce, the tfoot `totalByKey` map, plus THREE export builders — `buildExportColumns`, `buildExportRows`, and **`buildExportTotals`** (the totals row is a SEPARATE function from the footer, easy to miss — architect caught exactly this omission once).

**Why:** SalesAuditGrid does not reuse the footer totals for its export; the export totals row is computed independently. Forgetting `buildExportTotals` leaves a blank totals cell in the XLSX even when the on-screen footer is correct.

**How to apply:** when adding any numeric column to SalesAuditGrid, grep the file for the existing `total`/`totalAmount` key and make sure every one of the 8 reader sites gets the new key — especially the export-totals builder.
