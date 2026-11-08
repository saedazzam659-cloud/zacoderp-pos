---
name: Legacy item-unit repair
description: Safe first-base repair for old items whose flat unit links predate the directed conversion graph.
---

For an item with no configured base, an explicit user-selected base may normalize flat legacy item-unit rows by preserving each saved positive `conversionFactor` as a direct factor to the chosen base. Historical invoices and stock movements remain unchanged.

Do not change an already configured base by default. With the SuperAdmin-only company opt-in, a valid linked graph may be rerooted to another active linked unit: reverse only the edges on the path to the old root, preserve the remaining edges, and refresh cached factors in the same transaction. Reversed factors use the database numeric column's 18-decimal precision. Do not rewrite historical invoices or stock movements. Reject invalid/disconnected graphs, unlinked requested bases, and graphs whose current root is not explicitly linked.

For flat legacy rows, reject missing/invalid saved factors or historical unit IDs outside the item graph.

For a legacy item with no linked unit rows, the first explicit source-to-reference conversion may establish the reference as base when its user-entered factor creates a valid proposed graph containing every non-null historical unit ID. Validate the proposed graph and update the item base plus first relationship in one transaction. Keep blocking when history names any unit outside that graph; do not infer its factor.

For invoice-time resolution, the saved item base and active reference edges define the current graph. If legacy base/conflict metadata contradicts those edges, normalize only the stale markers in memory when the entire graph still resolves. Do not write during invoice save or alter historical snapshots; keep missing roots, unlinked references, cycles, duplicate active units, and invalid factors blocked.

**Why:** A production item can visibly show a valid base plus linked alternate unit while stale compatibility markers contradict the graph and block invoice creation. Requiring the user to edit an otherwise valid unit is not an acceptable save precondition.

**How to apply:** Use relation factors for new invoices after validating the complete graph; treat `conversionFactor` only as a cached value, not as authority over the explicit graph. Normalize stale metadata in memory only and preserve strict rejection for structural graph errors.

When the item already has a saved base unit but no item-unit rows, new alternate-unit forms should default their reference to that saved base. Do not make the user establish a second base or leave the required reference blank.

**Why:** Legacy items can have `items.unit_id` populated while the alternate-unit table is empty; the backend treats the saved unit as the current base, so a new non-base unit without a reference is rejected.

**How to apply:** Seed the add-unit form's reference from the item's saved base whenever one exists; only default the new row itself as base when both the saved base and item-unit rows are absent.

**Why:** Legacy items may have document lines with explicit unit IDs but no item-owned conversion graph. Saved factors are trusted only for proven flat legacy links; a user-entered first conversion establishes only the relationship explicitly supplied, without rewriting historical movements.

**How to apply:** Use saved factors only for proven flat legacy graphs; use the submitted relation factor only for the first explicit source-to-reference link. Keep graph validation, base assignment, and relationship insertion atomic. Reject incomplete or ambiguous historical coverage.

**Why:** Some companies explicitly need to correct a base unit after historical use. Keeping the company's default-off opt-in separate from structural graph validation permits that correction without silently rewriting old quantities or bypassing tenant isolation.

**How to apply:** Require company opt-in for rerooting an established graph, audit every changed link, retain its conversion topology, and leave historical document/movement quantities untouched.
