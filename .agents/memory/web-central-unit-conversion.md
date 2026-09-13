---
name: Web central unit conversion
description: Item-specific conversion ownership and historical quantity preservation.
---
Unit relationships belong to each item, not to the global unit catalog. A catalog factor is only a default/reference; it cannot establish that every carton contains the same count, or infer a weight-to-piece relationship.

**Why:** The user explicitly requested one central conversion service for the web ERP, extending existing unit and item-unit records rather than duplicating tables or screens.

**How to apply:** Maintain one base unit and an unambiguous rooted relationship graph per item. Resolve new operations through that graph. Reject unlinked, inactive, cyclic, or conflicting relationships instead of guessing a factor.

Legacy exception: when the item has no declared base and exactly one total item-owned mapping that is active and has no reference edge, that sole mapping can deterministically be the base. Ignore a stale legacy-conflict marker only for this exact shape, in both graph resolution and final row validation.

**Why:** Older single-unit items lacked explicit base markers; rejecting them blocked both sales and purchase saves. A graph-only exception was insufficient because a later conflict check rejected the same valid mapping again. Multi-row or referenced graphs still require explicit repair.

Stored document and stage conversion snapshots are authoritative for historical operations. Updating item relationships must never rebase existing stock, journal costs, or saved document quantities. Ambiguous legacy base declarations require explicit repair, not automatic selection.

**Why:** A correct new graph must not retroactively change the meaning of purchases, sales, manufacturing consumption, reversals, or stock counts.

**How to apply:** Only trusted persisted rows may supply historical factors to the resolver. Use exact arithmetic through conversion and a documented decimal boundary for existing numeric storage; never pass rational fraction strings directly to PostgreSQL numeric or JavaScript Number.

Historical factors must follow stable persisted line identities, never array position or the first matching item.

First-base assignment for a used legacy item is initialization, not a base-unit change, when it has no established base and its relationships and historical unit labels are compatible with the selected unit. Unlabelled legacy quantities remain numerically unchanged; conflicting labelled history must block assignment.

**Why:** Applying the used-item base-change ban to missing bases traps old items: invoices require a base, but the editor cannot supply one.

**How to apply:** Keep tenant validation and transactional item/relationship synchronization. Do not rescale historical balances or infer conversions between conflicting units; an established used base remains immutable.

**Why:** The same item can appear twice with different units or saved factors; reordering those lines can otherwise silently change stock and cost.

**How to apply:** Carry database line IDs through edit forms and source-line IDs through returns. When legacy data cannot identify a unique match, reject the ambiguous operation rather than guessing. UI-generated temporary IDs are not database identities.