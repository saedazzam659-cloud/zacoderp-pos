---
name: Operational report rendering boundary
description: Shared journal-style grids, branded report exports, and safe totals for operational sales and purchase reports.
---

Operational sales and purchase reports should use the shared `AdvancedReportGrid` interaction model and `ExportButtons` export path for branded Excel, PDF, and formatted printing. Do not replace those with a one-off HTML table, CSV-only download, or browser `window.print()` path. Do not adapt account-statement export data to operational reports; statements carry debit/credit and opening/closing-balance semantics that operational report rows do not.

**Why:** Users expect operational reports to match the existing accounting report grid and company-branded export experience, while reusing statement-specific fields would misrepresent the report.

**How to apply:** Extend the shared grid/export adapter for new operational report fields. Sum monetary columns only when every row has the same known currency; with mixed, missing, or unknown currencies, keep those totals out of both the grid and exported totals. Count totals may still be shown.