---
name: POS display-group boundary
description: Preserve the distinction between cashier display groups and accounting item categories.
---

POS display groups are a separate classification for cashier tabs and their images. Keep the existing item category and its accounting behavior unchanged; do not reuse the accounting category as the display-group assignment.

**Why:** The user explicitly required adding display grouping without changing the existing item category.

**How to apply:** Use a dedicated POS-group assignment in item editing and cashier tab rendering. Keep accounting-category selection, reports, and posting paths on the existing category field.
