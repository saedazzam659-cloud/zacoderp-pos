---
name: Legacy item-unit repair
description: Safe first-base repair for old items whose flat unit links predate the directed conversion graph.
---

For an item with no configured base, an explicit user-selected base may normalize flat legacy item-unit rows by preserving each saved positive `conversionFactor` as a direct factor to the chosen base. Historical invoices and stock movements remain unchanged. Do not change an already configured base. Reject rows with missing/invalid saved factors, existing relationship edges, or historical unit IDs outside the item graph.

**Why:** The user reported older items whose unit links were created before the graph safeguards; their saved factors are the trusted repair source, but historical movements must not be rewritten.

**How to apply:** Use this only during the first base assignment for an item with no base. Keep the entire graph repair and item update in one transaction, and leave ambiguous non-flat or incomplete legacy data blocked.
