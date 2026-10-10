---
name: Item import requirements
description: User-defined required fields and atomic preflight behavior for bulk item imports.
---

Bulk item imports require an item code, Arabic item name, and an existing company unit. If any row lacks a required field or references an unknown unit, reject the entire file before writing any items and report the affected spreadsheet row and missing value so the user can correct it.

The item template includes the per-item POS visibility column. For older templates that omit it, preserve the item's established default visibility rather than rejecting the file.

**Why:** The user explicitly requires complete item identity and unit data before import, with actionable correction guidance instead of partial imports.

**How to apply:** Keep client-side validation for immediate feedback and repeat the validation on the API before any mutations. Do not infer a missing unit or Arabic name.
