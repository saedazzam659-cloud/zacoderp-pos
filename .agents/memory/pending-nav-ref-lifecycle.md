---
name: Pending-navigation ref lifecycle
description: URL-param-seeded refs that trigger post-save navigation must be cleared on form reset/cancel
---

A ref seeded from a URL param (e.g. `?newDraft=1` → navigate to a new draft invoice after saving a return) that fires in a mutation `onSuccess` must be:

1. **Cleared inside `reset()`** (the shared save/cancel exit path) along with deleting the seeding URL params (`fromInvoice`, `full`, `newDraft`) via `history.replaceState`.
2. **Captured into a local before calling `reset()`** in `onSuccess`, then used for navigation — otherwise clearing in reset breaks the intended redirect.

**Why:** if only the success branch clears the ref, cancelling the seeded flow leaves a stale ref that redirects a later, unrelated create in the same mounted page.

**How to apply:** any list-page form where a URL param arms a one-shot post-save action (returns pages, doc converters). Pattern lives in the sales/purchase returns pages.
