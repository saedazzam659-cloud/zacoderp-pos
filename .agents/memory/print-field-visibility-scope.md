---
name: Print field visibility scope
description: Product scope for saved print-field visibility controls across sales, purchasing, and vouchers.
---

Sales invoice, quotation, return, and sales-order field visibility is scoped to the selected print template and document type. Custom templates support quotation settings only. Purchase orders, purchase invoices, receipt vouchers, and payment vouchers remain company-wide.

**Why:** Sales templates are selected independently, so a company-wide sales setting would unexpectedly change other templates. The non-sales controls retain their existing company-wide settings scope.

**How to apply:** Keep sales overrides namespaced by template and document type, preserve current print behavior when no override exists, and do not move purchasing or voucher controls without explicit direction.
