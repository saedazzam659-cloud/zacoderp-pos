---
name: Account level from parentId chain, not stored column
description: When minting a sub-account, derive its tree level by walking the parentId chain — the stored accounts.level column is unreliable.
---

# Account level must come from the parentId chain

When auto-creating a sub-account under a chosen parent, compute the child's
`level` from the parent's TRUE depth in the parentId chain (root = 1), e.g.
`accountDepth(parent) + 1`. Do NOT use `parent.level + 1`.

**Why:** The chart-of-accounts bulk-import persists `level = 2` for ANY account
that merely has a parent, regardless of how deep it actually sits. So a visually
level-4 account can have `accounts.level = 2` stored. The chart UI ignores the
column and draws depth from the parentId chain instead, so trusting the stored
`level` makes minted children land at the wrong level (e.g. 3 instead of 5).

**How to apply:** Any account-minting path (party importer, entity ledger
helpers, etc.) should walk the parentId chain with a `seen` cycle guard and stop
safely on a missing ancestor. Applies wherever a new posting sub-account is
created under a user-chosen parent.
