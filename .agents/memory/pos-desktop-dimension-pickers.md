---
name: POS Desktop dimension pickers (branch / cost center)
description: When to show ALL vs only active/posting branches & cost centers in POS-desktop pickers.
---

# POS Desktop branch & cost-center pickers

Two distinct option builders live in `artifacts/pos-desktop/src/pages/_reportFilters.tsx`:

- **Report filters** use `branchOptions` / `costCenterOptions` — these include a
  leading "كل الفروع" / "كل مراكز التكلفة" (ALL) entry and list **every** row
  regardless of `isActive` / `isPosting`. Reports must be able to slice historic
  data that may reference a now-inactive dimension.
- **Entry forms** (sales/purchase invoices+returns, journal entries, financial
  transactions) use `branchPickerOptions` / `costCenterPickerOptions` — leading
  "بدون" (none) entry, and they FILTER to `isActive` branches and
  `isActive && isPosting` cost centers.

**Why:** an entry must post to a valid, currently-active, posting-enabled
dimension; offering inactive/non-posting targets in a create form leads to
rejected or semantically-wrong postings. Reports have the opposite need — they
must still surface rows tagged with dimensions that were later deactivated.

**How to apply:** any NEW POS-desktop create/edit form that tags a branch or
cost center must import the `*PickerOptions` variants, never the report ones.
New report pages do the reverse.
