---
name: Purchase picker last-purchase price
description: Suggested purchase price follows the latest posted supplier purchase; inventory WAC remains a separate valuation measure.
---

For purchase invoice defaults, use the latest posted purchase price for the selected currency, normalized to the item's base unit and converted to the chosen unit by its conversion factor. Draft invoices must not affect the suggestion. Keep current weighted-average inventory cost separate and visible as a valuation measure. If there is no posted purchase history, use a positive catalog unit cost; otherwise leave the price blank. Currency-specific item prices remain explicit overrides.

**Why:** The user requires purchase-form defaults to represent what was most recently paid to a supplier, not the current carrying value of stock. Treating WAC as the purchase quote obscures supplier price movement.

**How to apply:** When changing purchase defaults or unit selection, read only posted purchase lines in the chosen currency, normalize using the historical unit conversion factor, then convert to the selected unit. Do not change the existing WAC recalculation, posting, return, or reversal paths.
