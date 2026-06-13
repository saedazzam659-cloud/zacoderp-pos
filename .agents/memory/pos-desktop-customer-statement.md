---
name: POS Desktop customer account statement
description: How the desktop customer statement (كشف حساب عميل) derives AR with no per-customer GL sub-account
---

The desktop app has NO per-customer GL sub-account, so the customer statement is
built purely in TS from source documents, not from a ledger account.

**Rule:** only `paymentMethod === "credit"` sales invoices (debit AR) and credit
sales returns (credit AR) move AR — cash/bank docs settle on the spot and are
excluded. Customer `FinancialTx` receipt vouchers credit AR, payment vouchers
debit AR. Opening = net debit−credit of every qualifying doc dated strictly
before `fromDate`. The in-range window is INCLUSIVE on BOTH ends
(`fromDate <= date <= toDate`) — forgetting the `toDate` upper bound silently
pulls future movements into the period and corrupts the closing balance.

**Why:** mirrors the web CustomerStatement semantics without a real AR
sub-ledger; cash/bank invoices never create a receivable so including them would
double-count.

**How to apply:** any new doc type that affects customer AR (e.g. opening-balance
JE, debit notes) must be folded into the same TS aggregation, with the same
credit-only gate and the same inclusive date window.
