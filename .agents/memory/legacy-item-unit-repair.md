---
name: Legacy item-unit repair
description: Safe first-base repair for old items whose flat unit links predate the directed conversion graph.
---

For an item with no configured base, an explicit user-selected base may normalize flat legacy item-unit rows by preserving each saved positive `conversionFactor` as a direct factor to the chosen base. Historical invoices and stock movements remain unchanged. Do not change an already configured base. Reject rows with missing/invalid saved factors, existing relationship edges, or historical unit IDs outside the item graph.

For a legacy item with no linked unit rows, the first explicit source-to-reference conversion may establish the reference as base when its user-entered factor creates a valid proposed graph containing every non-null historical unit ID. Validate the proposed graph and update the item base plus first relationship in one transaction. Keep blocking when history names any unit outside that graph; do not infer its factor.

When the item already has a saved base unit but no item-unit rows, new alternate-unit forms should default their reference to that saved base. Do not make the user establish a second base or leave the required reference blank.

**Why:** Legacy items can have `items.unit_id` populated while the alternate-unit table is empty; the backend treats the saved unit as the current base, so a new non-base unit without a reference is rejected.

**How to apply:** Seed the add-unit form's reference from the item's saved base whenever one exists; only default the new row itself as base when both the saved base and item-unit rows are absent.

**Why:** Legacy items may have document lines with explicit unit IDs but no item-owned conversion graph. Saved factors are trusted only for proven flat legacy links; a user-entered first conversion establishes only the relationship explicitly supplied, without rewriting historical movements.

**How to apply:** Use saved factors only for proven flat legacy graphs; use the submitted relation factor only for the first explicit source-to-reference link. Keep graph validation, base assignment, and relationship insertion atomic. Reject incomplete or ambiguous historical coverage.
