---
name: Opening balances edit-after-unpost
description: How the opening-balances screen re-loads and re-posts the existing opening JE keeping the same number
---

The opening-balances screen is dual-mode: create (POST) or edit (PUT on the latest non-party-import opening JE loaded via a literal `/opening-entry` sub-route registered before `/:id`).

Rules learned:
- **PUT rebuilds lines wholesale** — the edit payload MUST carry forward seeded amounts for accounts that are now inactive/non-posting (they aren't rendered in the grid) or those lines are silently dropped from the JE.
- **PUT defaults entryType to "general"** — the edit payload must explicitly send `entryType:"opening"` or the entry stops being found by `/opening-entry`.
- Same-number re-post works for free: PUT never touches `docNumber`, so save-then-`/post` keeps the original sequence number; posted-only reports pick it up with no report changes.
- If PUT succeeds but `/post` fails, surface a loud error (edits saved, still draft) — never a soft success — and re-hydrate the edit-mode query in BOTH onSuccess and onError.
- Party-import opening JEs carry a hidden `[ob:` marker in description and must be excluded from this screen (managed by the bulk importer).

**How to apply:** any screen that "edits a single well-known JE in place" needs the same trio: explicit entryType, wholesale-line preservation, and hard failure on post-after-put.
