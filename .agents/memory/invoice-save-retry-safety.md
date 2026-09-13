---
name: Invoice save retry safety
description: Prevent duplicate invoices from repeated clicks, ambiguous responses, and post-create failures.
---

Invoice creation needs a stable per-form request key plus a synchronous save lock. Capture the persisted invoice ID immediately after create, before posting or navigation; subsequent saves update that invoice.

**Why:** A successful POST followed by a failed post/navigation leaves a new-document screen open. Button pending state alone neither closes same-render double-click windows nor protects ambiguous network retries.

**How to apply:** Keep the request key across failures; rotate only for a genuinely new document. Commit the replay claim, invoice, lines, and fallible create-side effects together. Never expose a replay target that later compensation may delete. Keep operational replay claims excluded from full-company backups to avoid breaking exact-catalog compatibility and replaying stale request identities after restore.