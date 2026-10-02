---
name: Retroactive sequence protection
description: Agreed behavior for activating numbered-record protection on an existing company.
---

When SuperAdmin enables sequence protection for an existing company, protect every existing record with a non-empty document number, including drafts and numbered journal entries. Keep the company setting change and sweep atomic, and coordinate them with concurrent number-bearing inserts, edits, and deletions. The record-level protection marker remains effective if the company later disables the package.

**Why:** The user explicitly selected a full retroactive sweep, including drafts, and required existing records to remain protected after package disablement.

**How to apply:** Keep the sweep scoped to the canonical numbered-document table map. Any activation implementation must serialize number-bearing writes with the sweep and fail closed if a mapped existing table is missing required columns.