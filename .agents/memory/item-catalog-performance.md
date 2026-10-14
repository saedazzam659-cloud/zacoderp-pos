---
name: Item catalog performance
description: Keep large item catalogs fast in operational selectors without changing full-list behavior for reports.
---

Operational item selectors should use authenticated, tenant-scoped bounded search and batch-load the IDs already selected on an edited document. Keep the existing full-list contract for reports or screens that require the complete catalog; do not silently truncate the shared endpoint.

**Why:** The ERP item catalog exceeds 6,000 items, which makes full-list downloads and client-side filtering slow in invoice entry. Changing the old endpoint globally could silently omit items from reports and legacy consumers.

**How to apply:** When adding or changing an item picker, use server-side search with a strict result cap and preserve selected-item hydration. Only use a full catalog query when the screen genuinely calculates or displays across the entire catalog.

The picker’s local filter must search every name language returned by the API, not only the currently displayed label. When multiple item pickers share one remote query, clear that query when a picker closes and rank exact/prefix matches ahead of broad substring matches.

**Why:** A correct server substring match can still disappear in the client’s second filter, and a stale shared query can make a newly opened picker appear to have missing items. Broad one-character queries also need useful ranking within a bounded result set.

**How to apply:** Include alternate-language names and item code in searchable picker fields, reset shared query state on close, preserve selected-item hydration, and keep substring search available after exact and prefix matches. Normalize exact code/name ranking with the same trim and case-insensitive rules used by duplicate checks, so a duplicate remains at the top of a short bounded search.

Remote item pickers must remain mounted when a search returns zero results. Replacing the picker with a plain text input disconnects subsequent typing from the remote search callback, making the user unable to recover without leaving the form.

**Why:** In invoice and inventory document forms, the picker had been conditionally replaced when its result list was empty; after one no-match query, later queries never reached the server.

**How to apply:** Render the searchable picker whenever the authenticated form is active, regardless of current result count; render an empty-results state inside the picker and let the user continue typing.
