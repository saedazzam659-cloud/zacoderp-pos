---
name: Gated download URL exposure
description: Protected/metered download flows must not leak the resource URL before the use is consumed.
---

# Gated download URL must come only from the consuming step

For any flow that meters downloads behind a code/quota (e.g. the install-wizard
`/api/download-wizard/*`), the "preview/release info" endpoint must return
**metadata only** (version, size, checksum, notes) and NEVER the actual
`downloadUrl`. Hand out the URL exclusively from the atomic consume endpoint
(`/claim`) AFTER `usedCount` is incremented.

**Why:** If `/release` returns the real URL, a caller verifies once, reads the
URL, and downloads forever without ever calling `/claim` — so `maxUses` /
`usedCount` enforce nothing. Found in architect review of the install wizard.

**How to apply:** Put every gating condition (isActive, maxUses cap, expiresAt,
companyId binding) inside the atomic `UPDATE ... WHERE` of the consume step, not
just in a pre-check, to also close the TOCTOU window. The pre-check is only for
nice error messages; the WHERE is the real guard.
