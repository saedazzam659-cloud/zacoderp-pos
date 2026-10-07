---
name: Cash expense boundary
description: Product and security constraints for cash expenses linked to existing cashboxes and payment-voucher accounting.
---

# Cash expense boundary

Cash expenses reuse existing cashboxes, branch access, and payment-voucher posting and cancellation, but remain a distinct source type. Generic payment-voucher routes and generic object-file reads must not expose cash-expense records or receipts.

The seven cash-expense mobile permissions require an explicit grant, including for administrators and legacy users. Assign a cashbox manager explicitly to each cashbox; a branchless cashbox does not imply a default or main cashbox. User and sales-representative attribution comes from the authenticated server-side relationship, not client input.

Receipts are optional, stored privately, and readable only through the permission-checked cash-expense endpoint. Cancellation uses the existing payment-voucher lifecycle rather than creating a separate reversing journal entry.

Reports may show a combined total only when every included amount has the same known currency. For mixed or unknown currencies, show each grouped amount but omit the aggregate.

**Why:** The feature must reuse the established accounting lifecycle without granting access to existing users implicitly, leaking receipts through shared storage routes, or combining unlike currencies.

**How to apply:** Preserve the distinct source-type filter, explicit per-user permission checks, per-cashbox access assignment, and safe currency aggregation whenever this feature is extended.
