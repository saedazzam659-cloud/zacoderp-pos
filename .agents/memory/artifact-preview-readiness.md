---
name: Artifact preview readiness
description: Distinguish local Vite readiness from artifact-managed preview readiness.
---

**Rule:** A Vite “ready” log and a successful local HTTP request prove the process bound and served a response; they do not prove the artifact's managed preview check succeeded. Verify the local port and the routed app preview independently.

**Why:** During a security-center change, the Vite dev server served locally and the app router rendered the login page, while the managed web workflow still reported a failed preview health check. The issue was not a compile error or a port mismatch.

**How to apply:** On an artifact preview failure, compare the workflow's expected port with the service manifest and bind address, then check both `curl localhost:<port>` and the routed app preview. If both serve correctly while workflow status remains failed, report the discrepancy rather than changing ports or repeating restarts without a configuration fix. Do not leave a manually started Vite process as a permanent substitute for the managed workflow.