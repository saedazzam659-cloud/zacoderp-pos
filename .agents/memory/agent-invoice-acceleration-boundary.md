---
name: Agent invoice acceleration boundary
description: Durable isolation and concurrency rules for optional acceleration of externally stored agent invoices.
---

Acceleration control state and latency telemetry belong only in the central control plane. External agent databases must exclude them both when a fresh schema is copied and during later schema reconciliation. Invoice business writes remain fail-closed to the external database.

**Why:** A shared schema can otherwise leak central controls into fresh external databases, and a cache-based mode switch can change the algorithm of an already-running save or let a new save miss a manual Off.

**How to apply:** Treat mode changes as generations. Every transition increments the generation; an active cached request captures it at the middleware's first await under a row lock, and admission compares it under lock later. A changed generation preserves the in-flight algorithm without joining a new trial. Cached Off must remain independent of the central admission path. Disconnect telemetry follows the completed business outcome, not merely the socket close.