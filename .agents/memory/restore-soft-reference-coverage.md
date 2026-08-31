---
name: Restore soft-reference coverage
description: How to keep strict full-company backup reference validation compatible with real historical backups.
---

When strengthening full-company restore validation, inventory and test the complete set of non-FK identifier columns before release. Include discriminator-based references, historical audit references, and journal aliases such as `journal_id`, not only conventionally named foreign keys.

**Why:** Strict unknown-ID rejection was correct for tenant safety, but incomplete coverage blocked a valid production backup repeatedly, revealing one unsupported column at a time after each prior blocker was fixed.

**How to apply:** Keep unknown identifiers fail-closed. Add explicit discriminator-aware mappings for operational references, nullable handling for missing historical rows, and regression fixtures that exercise every known soft-reference family together before publishing backup changes.

Historical rows may outlive their user. If a user reference is missing, synthesize one deterministic disabled archive identity per missing source user and remap both logical and physical references to it; do not assign activity to a live user, delete history, or reject a required `NOT NULL` reference.

**Why:** Work-session history used a required soft `user_id`; deleted users made valid backups fail, while NULL or row deletion would lose attribution.

**How to apply:** Reuse the same archive identity across all references to that source user, keep it unable to log in, and preserve unknown non-user references as fail-closed.

**Confirmed:** A legacy full-company import with deleted historical users completed successfully under this policy.

JE-number reservations are a narrow exception to required missing soft references: preserve and remap them while their source document exists, but drop only an orphan reservation row when that source is absent. Never retain its raw source ID across servers.

**Why:** Reservations are temporary unpost→repost state. An orphan cannot be consumed legitimately, while preserving its source ID can collide with an unrelated future target row and rejecting it blocks an otherwise valid company backup.

**How to apply:** Keep every other missing required business reference fail-closed; this exception belongs only to `je_number_reservations.source_id`.