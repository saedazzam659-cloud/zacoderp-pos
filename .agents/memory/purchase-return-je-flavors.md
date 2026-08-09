---
name: Purchase return JE two flavors
description: post_variance flag on purchase_returns controls doc-value vs actual-cost JE
---
Purchase returns post one of two JE flavors via per-return `post_variance` (default FALSE):
- FALSE (conventional): Dr supplier gross / Cr inventory at DOCUMENT net value per warehouse / Cr VAT. No variance account needed.
- TRUE: Cr inventory at actual stock-out cost; doc-vs-cost delta → purchase_return.variance mapping account (this role must stay in the accounting-mappings whitelist).

**Traps:**
- paidLineValue is RAW discounted line value — gross when priceIncludesVat. Doc mode must SCALE all warehouse buckets proportionally so they sum to subtotal (net of VAT); never dump the residual into the last bucket.
- Doc mode with zero stockable lines but subtotal>0 must hard-error (JE would unbalance).
- PUT must preserve the stored flag when the field is absent (partial PUT clients).
- UI: checkbox in the invoice return popup passes `&variance=1` to /purchasing/returns; form has its own checkbox.
