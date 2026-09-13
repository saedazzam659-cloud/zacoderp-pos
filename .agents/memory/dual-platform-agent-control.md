---
name: Dual-platform agent control
description: Security and fencing rules for linking one external agent shell to multiple management platforms.
---

A secondary management platform must authenticate the agent with a link-scoped controller token derived during the one-time pairing flow. It must never receive or validate the agent's raw license key. The portable link file contains neither credential.

**Why:** The license is a reusable root credential for the original control plane. Sending it to another platform breaks isolation even if the exported link file itself is sanitized.

**How to apply:** The shell-visible controller token is limited to heartbeat/release authentication. Leadership transitions use a separate platform-only credential plus a per-link Ed25519 authorization signed by the source; neither secret may enter shell config or browser responses.

Agent heartbeats are telemetry-only and must never mutate `controllerEpoch` or `activeControllerId`. A transition is accepted only through direct controller-to-controller compare-and-swap for the exact next epoch and a source-signed authorization bound to that state.

**Why:** An agent shell holds its heartbeat credential and may be compromised; allowing its report to choose leadership bypasses the operator confirmation and permits split-brain or permanent epoch jumps.

**How to apply:** Fence the currently active controller first so transitions may briefly have no active controller but never two. Treat ambiguous network or shell-sync outcomes as in-doubt, preserve a recognizable epoch state, and require read-back before idempotent repair.

Keep controller transfer separate from package replacement: preserving runtime must not require an external-package installation.

**Why:** Operators need to change the managing platform without migrating business data or replacing a centrally supplied application. Package provenance is not an appropriate gate for opening that workflow.

**How to apply:** Offer the handoff entry point independently of package-specific controls; retain backend readiness checks and explicit confirmation before transfer.

Delegated business management must keep database credentials on the source platform and use explicit operation and field allowlists. Bind authorization to both link state and the live installation/domain/database fingerprint before opening the agent database.

**Why:** Copying management metadata is not proof that the underlying database identity has remained unchanged. Serializing complete company rows can disclose SMTP or OTP material even with a broad secret-name filter.

**How to apply:** Reject stale identity or leadership, project explicit management DTOs, and preserve branding. This delegation depends on source-platform availability; it is not a standalone migration away from the source.