---
name: Dual-platform agent control
description: Security and fencing rules for linking one external agent shell to multiple management platforms.
---

A secondary management platform must authenticate the agent with a link-scoped controller token derived during the one-time pairing flow. It must never receive or validate the agent's raw license key. The portable link file contains neither credential.

**Why:** The license is a reusable root credential for the original control plane. Sending it to another platform breaks isolation even if the exported link file itself is sanitized.

**How to apply:** Store the source-side controller token encrypted only for shell configuration and the target-side verifier only. Heartbeats and release downloads choose credentials per controller origin.

Leadership state is totally ordered by `(controllerEpoch, activeControllerId)`. Equal epochs must use the same locale-independent string comparison in backend helpers and generated shell code.

**Why:** Independent platforms can issue same-epoch switches concurrently. Locale-aware and code-unit comparisons disagree for mixed-case or punctuated IDs, causing permanent split-brain.

**How to apply:** Every importer, heartbeat reconciler, release gate, and shell updater must share the exact ordering rule; evaluate suspension only after selecting the final active controller.