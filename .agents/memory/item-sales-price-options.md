---
name: Item sales price options
description: User decision for direction-like categories such as right, left, up, and down on one item.
---

The user chose a selectable per-item price option: choosing a category changes the invoice line's price while inventory remains on the same base item. Do not model this as a separate stock variant or as a brand.

**Why:** The intended use is one catalog item with several sales categories and different prices, not separate stock balances for each category. The desktop brand picker is distinct: it is tied to real brands and print metadata.

**How to apply:** Configure option names and prices with the item; render a compact selector inside the existing item cell without adding a grid column; persist the selected label with the invoice line; preserve item stock, COGS, tax, and real-brand behavior.
