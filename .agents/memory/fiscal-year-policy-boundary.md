---
name: Fiscal-year policy boundary
description: Company-specific fiscal-year settings, annual close, and preservation of existing fiscal-year records.
---

The first fiscal year for a newly activated company starts on its effective subscription/activation date and ends on December 31 of that year; do not seed periods before activation. Older operations are added only through an explicit migration/import. A custom company cycle repeats annually with the same duration. Monthly close must not create a fiscal year. Final annual close remains an authorized approval; the successor uses the closed year's actual dates and posted ledger history, without a duplicate opening journal. Existing and historical year records are not rewritten when policy changes, and manual creation remains available for migrations.

**Why:** Companies activate in different months, so automatically creating earlier periods implies an operating history the company may not have. Changing historical periods can also corrupt period assignments and accounting evidence.

**How to apply:** Pass the effective activation date through every new-company provisioning path. Treat configured cycles as company-scoped templates after the initial stub year. Before rollover, ensure the actual fiscal-year record matches the policy; use explicit, audited workflows for any change to an existing period.
