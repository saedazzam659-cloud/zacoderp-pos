---
name: Cost-center hierarchy levels
description: Scope level corrections to new centers and explicitly moved subtrees.
---

Derive a new center's level from its parent chain, not the stored `level` fields. When a center is explicitly moved, recalculate that node and its descendants from the new parent depth. Do not backfill or rewrite untouched legacy centers.

**Why:** The user approved correcting new and moved centers only to avoid changing existing companies' records or historical accounting behavior.

**How to apply:** Treat `parentId` as the hierarchy source of truth. Preserve an existing center's stored level during unrelated edits; only update its subtree levels as part of an explicit parent change.
