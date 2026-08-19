---
name: Demo-device link lifecycle
description: Concurrency and authorization rules for isolated per-device demo workspaces and one-time pairing.
---

All lifecycle operations for one demo source account—device claim, pair-code creation, redemption, and revocation—must serialize on the same per-source lock. Pair-code redemption must also prove that the device which created the code is still ready and not revoked. Issuing the final bearer session must atomically require that the exact device link remains ready and unrevoked.

**Why:** Checking a link and then writing a code or session in separate steps creates narrow races where revocation can be followed by a newly valid pair code, or a stale login can reactivate a shadow user and receive a token.

**How to apply:** Any new login, pairing, device-reset, or administrative revoke path must join this lifecycle rather than performing an independent read-then-write. Keep source-qualified device ownership checks at the administrative boundary, and preserve one-time code consumption.