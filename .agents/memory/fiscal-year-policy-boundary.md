---
name: Fiscal-year policy boundary
description: Company-specific fiscal-year settings, annual close, and preservation of existing fiscal-year records.
---

The first fiscal year for a newly activated company starts on its effective subscription/activation date and ends on December 31 of that year; do not seed periods before activation. Older operations are added only through an explicit migration/import. A custom company cycle repeats annually with the same duration. Monthly close must not create a fiscal year. Final annual close remains an authorized approval; reuse an exact, open successor instead of creating another year, and derive carry-forward from posted history without a duplicate opening journal. If posted opening entries already exist in that successor, compare them by account and block close with visible differences rather than editing entries or posting an automatic adjustment. Existing and historical year records are not rewritten when policy changes, and manual creation remains available.

**Why:** Companies activate in different months, so automatically creating earlier periods implies an operating history the company may not have. Changing historical periods can also corrupt period assignments and accounting evidence.

**How to apply:** Pass the effective activation date through every new-company provisioning path. Treat configured cycles as company-scoped templates after the initial stub year. Before rollover, reuse the exact open successor and reconcile any posted opening journal against prior-year closing balances; require manual resolution for differences. Keep manual creation available for migration and existing-year setup.
