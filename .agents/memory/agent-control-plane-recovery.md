---
name: Agent control-plane recovery
description: Safety rule for recovering crashed agent-server operations that mutate both remote hosts and external providers.
---

Crash recovery for an agent-server operation must fence every mutation plane, not only the central database. Start a conditional heartbeat immediately after the atomic claim; remote scripts must share a host-side exclusive lock plus an operation-generation marker; external provider calls must be time-bounded and recorded as an in-flight phase. Recovery may replace the old lease only after the heartbeat is stale and the provider safety window has elapsed, then must revoke the remote generation before releasing the lease.

**Why:** A database-only lease can be cleared while an old SSH script or DNS request is still alive. That stale worker may then mutate the host or provider after the UI declares recovery complete.

**How to apply:** Any new deploy, provision, wipe, firewall, DNS, or remote-policy path must claim the same lease before preflight, heartbeat throughout, assert ownership around side effects, use the remote operation wrapper for SSH, and use a bounded provider-mutation wrapper for external control-plane writes.