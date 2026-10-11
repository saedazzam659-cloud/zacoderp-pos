---
name: Item catalog performance
description: Keep large item catalogs fast in operational selectors without changing full-list behavior for reports.
---

Operational item selectors should use authenticated, tenant-scoped bounded search and batch-load the IDs already selected on an edited document. Keep the existing full-list contract for reports or screens that require the complete catalog; do not silently truncate the shared endpoint.

**Why:** The ERP item catalog exceeds 6,000 items, which makes full-list downloads and client-side filtering slow in invoice entry. Changing the old endpoint globally could silently omit items from reports and legacy consumers.

**How to apply:** When adding or changing an item picker, use server-side search with a strict result cap and preserve selected-item hydration. Only use a full catalog query when the screen genuinely calculates or displays across the entire catalog.
