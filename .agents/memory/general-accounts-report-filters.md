---
name: General Accounts report client-side filters
description: How the zatca-invoicing TrialBalance/BalanceSheet/IncomeStatement reports apply the zero/parent/level filters
---

The three General Accounts reports (`pages/accounting/reports/{TrialBalance,BalanceSheet,IncomeStatement}.tsx`) share a client-side filter trio — zero-balance toggle (default OFF), parent-account multi-select (parent + descendants), and account-level (all/first=root/last=leaf). AccountStatement is intentionally EXCLUDED.

**Rule:** filtering is purely client-side (no API/query change). Shared helpers live in `lib/accountTree.ts` (`buildAccountTree`, `descendantIds`, `matchesAccountFilters`) + `hooks/useAccountTree.ts` (fetches `/api/accounts`, React Query dedups). Filter UI = `components/AccountParentFilter.tsx` + `AccountLevelFilter.tsx`.

**Why totals are recomputed:** BalanceSheet section totals and IncomeStatement revenue/expense/net are RECOMPUTED from the *filtered* rows, NOT taken from the backend aggregate fields (`data.totalAssets`, `data.totalRevenue`, …). This keeps the displayed total equal to the sum of visible lines. In the default view (no parent/level filter, zeros hidden) the recomputed sum equals the backend total because zero rows contribute 0 — so the balance check is unchanged.

**How to apply:** when touching these reports, drive grid + print + export from the single filtered array; never reintroduce a server-side zero filter (the old `select` zero-filter was removed). Zero-gate semantics differ per report: TrialBalance = movement OR opening/closing ≠ 0; BalanceSheet = `balance !== 0`; IncomeStatement = `totalCredit !== totalDebit`. Account level is derived by walking the parentId chain (stored `accounts.level` is bulk-import-stale — see account-level-from-parent-chain.md).
