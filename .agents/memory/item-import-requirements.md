---
name: Item import requirements
description: User-defined required fields and atomic preflight behavior for bulk item imports.
---

Bulk item imports require an item code, Arabic item name, and an existing company unit. If any row lacks a required field or references an unknown unit, reject the entire file before writing any items and report the affected spreadsheet row and missing value so the user can correct it.

The item template includes the per-item POS visibility column. For older templates that omit it, preserve the item's established default visibility rather than rejecting the file.

Item import retries use the company-scoped item code as the identity: create missing codes, update rows whose imported values changed, and skip unchanged rows. Re-uploading after a timeout must not create duplicates.

**Why:** Large imports can outlast a browser/proxy request, so users need a safe way to retry the same workbook and finish missing rows.

**How to apply:** Keep preflight validation ahead of writes, preserve the existing update-on-code behavior, and make retry reports distinguish created, updated, and unchanged rows.

**Why:** The user explicitly requires complete item identity and unit data before import, with actionable correction guidance instead of partial imports.

**How to apply:** Keep client-side validation for immediate feedback and repeat the validation on the API before any mutations. Do not infer a missing unit or Arabic name.
