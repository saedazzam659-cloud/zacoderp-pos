---
name: Cash-flow yearly statement tab
description: How the قائمة التدفقات (النموذج السنوي) view in CashFlowReport works and its invariants
---

The cash-flow report has three views: `statement` (yearly model), `summary` (partner schedule), `detail`. The statement view is a pure client-side re-grouping of the SAME backend 16-key summary into operating/investing/financing sections (STATEMENT_IN/OUT_SECTIONS) — never add classification logic there.

**Invariants:**
- Every backend SUMMARY_NOTES key must appear in exactly ONE statement section; a new backend note key must be added to a section or it silently drops out of the statement totals (but not the summary tab).
- The "full year" column is a second query over the fiscal year containing `toDate`, read from `/api/accounting-reports/fiscal-years` — a report-gated read-only copy, because `/api/fiscal/years` requires the separate `accounts` module permission which report-only users lack. Never point the report at `/api/fiscal/years`.
- Fiscal-year fetch must FAIL LOUDLY on !ok (calendar-year fallback only on a successful empty list), or non-calendar fiscal years silently show wrong full-year figures.

**Why:** an architect review caught the 403→[]→calendar-fallback bug producing wrong full-year columns for permission-limited users.
