---
name: POS Desktop customer account statement
description: How the desktop customer statement (كشف حساب عميل) derives AR with no per-customer GL sub-account
---

The desktop app has NO per-customer GL sub-account, so the customer statement is
built purely in TS from source documents, not from a ledger account.

**Rule:** only `paymentMethod === "credit"` sales invoices (debit AR) and credit
sales returns (credit AR) move AR — cash/bank docs settle on the spot. Customer
`FinancialTx` receipt vouchers credit AR, payment vouchers debit AR. Opening =
net debit−credit of every qualifying doc dated strictly before `fromDate`. The
in-range window is INCLUSIVE on BOTH ends (`fromDate <= date <= toDate`) —
forgetting the `toDate` upper bound silently pulls future movements into the
period and corrupts the closing balance.

**Cash invoices are SHOWN but net-zero (opt-in, default ON).** A `includeCash`
toggle (mirrored on the supplier statement) adds each cash/bank invoice as a
PAIRED pair of lines on the same date+docNo: the invoice (debit for customer AR /
credit for supplier AP) PLUS an immediate "سداد فوري" settlement on the opposite
side. Net balance impact is zero, so the running/opening/closing math is
unchanged, but the operator can now see cash activity per invoice. Cash sales
returns get the mirror pair (return credit + refund debit). SAFE because cash
invoices/returns do NOT create a `financial_transactions_local` row, so the
synthetic settlement never double-counts a real voucher. Paired-line adjacency
relies on the stable sort (same date+docNo → comparator 0) — fine on WebView2.

**Why:** mirrors the web CustomerStatement semantics without a real AR
sub-ledger; cash docs net to zero against AR so the paired representation keeps
the balance correct while restoring per-invoice visibility the user asked for.

**How to apply:** any new doc type that affects customer AR (e.g. opening-balance
JE, debit notes) must be folded into the same TS aggregation, with the same
credit-only gate and the same inclusive date window.

**Opening overlay must be a dated movement, not a strict-`<fromDate` seed.** The
create-time opening overlay (`getCustomerOpening`) must be injected into the doc
list as a synthetic StmtLine dated on `openingDate`, then run through the SAME
date-window loop. Seeding it only when `openingDate < fromDate` (strict) silently
DROPPED any opening dated inside the period — the classic case being: add a
customer today with an opening balance, then open the default this-year statement
(`fromDate = firstOfYear`). The opening (dated today) was neither `< fromDate`
(so not in opening) nor a document (so not a line) → it vanished entirely and the
statement looked empty. As a dated line it folds into opening when before the
period and shows as a visible "رصيد افتتاحي" row when inside it. No double-count
risk: this screen reads documents, never the GL opening JE.
