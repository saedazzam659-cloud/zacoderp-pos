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

Renewing expired unimported links requires fresh target-authenticated proof of absence, not merely a missing readback or timeout.

**Why:** Failed exports can leave duplicate pending links, while ordinary reconciliation needs a paired winner. Blind deletion or credential rotation can invalidate a real pairing; unauthenticated presence queries expose registry information.

**How to apply:** Authenticate the caller's fresh invite secret before checking target records, fail closed on uncertainty, and fence renewal with prior credential generation as well as leadership epoch. Keep renewed signed files intact and re-download locally rather than exporting again.

Renewal diagnostics may identify failed source-side predicates, but must not return compared values. Keep target refusal generic; never reveal whether an invite was expired, consumed, invalid, or mismatched. Distinguish a generic target refusal from transport unavailability and a confirmed existing pairing.

**Why:** Source-side names help operators fix stale registry state without exposing identifiers or fingerprints. Detailed target errors would turn the proof endpoint into an invitation-state oracle.

**How to apply:** Preserve every Epoch 0, active-controller, installation, domain, and database-fingerprint check. Return only fixed failure codes for source checks; keep target proof and acceptance criteria unchanged.

Optimistic renewal writes must not compare PostgreSQL timestamp columns to JavaScript `Date` values for exact equality. PostgreSQL can retain sub-millisecond precision that JavaScript dates discard, making an unchanged link look stale after target proof.

**Why:** A valid renewal can otherwise repeatedly fail its final compare-and-swap while leaving all rows untouched.

**How to apply:** Guard renewal with stable link identity, credential, installation, fingerprint, epoch, and active-controller fields, or use an exact database-native version token. Do not use a round-tripped `Date` as the concurrency token.

If the link-registry transaction commits but the remote shell sync fails, preserve the committed row and provide an idempotent recovery that re-proves target absence before retrying sync or reissuing the file.

**Why:** Rolling back or blindly rotating credentials after an ambiguous remote write can desynchronize the source registry from the agent shell.

**How to apply:** Record only a sanitized sync diagnostic, let a matching fresh invite identify the already-committed renewal, and retry synchronization without changing the stored link credentials or signing key.

Standalone agent fingerprint setup is incomplete until the database row, central registry, and the agent's runtime `config.json` agree and a fresh heartbeat is accepted. A database-only check must report connectivity separately from fingerprint validity.

**Why:** The heartbeat reads its fingerprint from the agent's runtime config; planting only the database row can leave the agent sending an old or empty fingerprint while the control panel says initialized.

**How to apply:** After verifying active licensing and saved SSH identity, sync the expected fingerprint to the agent config, let the heartbeat decide whether the suspension marker can clear, and report completion only after a fresh accepted heartbeat. Never equate `SELECT version()` success with fingerprint validation.

Full agent `init-db` is a maintenance operation that can take several minutes; while it copies or reconciles the external schema, routed agent-domain API requests may return `AGENT_SCHEMA_PREPARING` and the browser can show a blank app shell.

**Why:** Re-running initialization when the site is already healthy can cause avoidable downtime; a successful completion is distinct from the temporary unavailability during the operation.

**How to apply:** Check the active `init-db` request and fresh domain/API responses before retrying. If initialization has completed successfully, do not run it again just to recover the website; refresh the browser after the schema-ready gate clears.