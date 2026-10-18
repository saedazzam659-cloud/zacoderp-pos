---
name: Searchable web dropdowns
description: Use the current web app's searchable combobox for dropdowns added or modified in ERP web forms.
---

When adding or modifying a dropdown in the ERP web app, use the existing `SearchCombobox` pattern rather than a native select. For catalog pickers, keep search tenant-scoped and bounded, and hydrate already-selected values.

**Why:** The user explicitly asked that future dropdown additions use searchable combo boxes because native lists have repeatedly required them to return and request a second edit.

**How to apply:** Reuse the existing shared search combobox and match its keyboard, RTL, empty, loading, and selected-value behavior. For large item catalogs, follow the bounded-search and selected-item hydration rules in `item-catalog-performance.md`.
