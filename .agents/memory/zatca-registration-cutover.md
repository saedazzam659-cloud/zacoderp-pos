---
name: ZATCA registration cutover
description: Safety invariants for moving one live EGS registration between central and external-agent databases.
---

Freeze and bind both source and target under their own shared ZATCA chain locks before creating a usable hand-off. The source stays permanently blocked after activation; cancellation is allowed only while the target is still frozen and unchanged.

**Why:** Freezing only the source leaves a matching target registration able to submit concurrently. Cross-database completion can also fail after target activation, so reopening the source would create two active systems using one PCSID.

**How to apply:** Treat an active target carrying the exact transfer ID, binding, and credential fingerprint as authoritative proof that activation committed. Recovery may finalize the central record after expiry and after the target chain advances; never reset its seed or require the old chain head in that recovery branch.