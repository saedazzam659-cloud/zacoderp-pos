---
name: Item sales price options
description: User decision for direction-like categories such as right, left, up, and down on one item.
---

The user chose a selectable per-item price option: choosing a category changes the invoice line's price while inventory remains on the same base item. Do not model this as a separate stock variant or as a brand.

**Why:** The intended use is one catalog item with several sales categories and different prices, not separate stock balances for each category. The desktop brand picker is distinct: it is tied to real brands and print metadata.

**How to apply:** Configure option names and prices with the item, show the selection on the web invoice line, persist a historical option snapshot on the invoice line, and preserve existing item stock, COGS, tax, and brand behavior.
