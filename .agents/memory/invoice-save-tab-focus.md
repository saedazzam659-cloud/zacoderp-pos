---
name: Invoice save tab focus
description: Preserve the initial invoice creation order while focusing saved invoices on their item lines after save.
---

New sales and purchase invoices must continue to open on the basic-data tab. After a successful save, the saved invoice should open or remain on the items tab. This changes only the post-save focus; it must not reorder fields, bypass validation, or alter save/post behavior.

**Why:** The user needs to continue reviewing invoice lines immediately after saving without disrupting the established new-invoice flow.

**How to apply:** In invoice forms, change the active tab only after successful persistence. For newly created invoices, carry an explicit post-save tab hint to the saved-document route; do not make the items tab the initial tab on `/new`.
