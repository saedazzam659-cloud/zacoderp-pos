---
name: Manual journal numbering continuity
description: The user's chosen numbering behavior for the QYD company's manual journals.
---

For the QYD company, new manual general journal entries should continue the existing company-wide suffix series in the `QYD/{MM}/` format. Do not start a separate year-prefixed `QYD/{YYYY}-{MM}/` stream unless the user explicitly requests it.

**Why:** The user chose continuity with the existing monthly-format journal series after seeing the 2026-scoped sequence preview add a year segment and use a lower independent counter, then confirmed that disabling fiscal-year restart corrected it.

**How to apply:** When changing the 2026 `journal_entry` sequence, keep the monthly token and continuous counter, disable annual reset, and verify the next suffix against all existing journal numbers before saving. Never renumber existing entries.
