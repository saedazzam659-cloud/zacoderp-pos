---
name: Authenticated browser readiness
description: Avoid false browser timeouts caused by persistent realtime connections.
---

Use DOM readiness followed by visible-control assertions for authenticated browser navigation; do not require global network idleness.

**Why:** The live authenticated SPA keeps a realtime connection open, so a functioning page can fail a network-idle navigation wait. This caused false failures during isolated contracting browser verification.

**How to apply:** Wait for the specific heading, picker, or report result needed by the next action. Treat fixture-seeded report totals as UI aggregation evidence, not proof of the financial posting lifecycle.