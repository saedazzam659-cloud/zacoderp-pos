---
name: Protected production agent deployment isolation
description: User's standing restriction on central releases and maintenance affecting a designated production agent.
---

The user has designated a production agent whose hosted companies must remain unaffected by central publishing and updates. Never include that agent in automatic release fan-out, restart, reinitialization, or fingerprint planting without the user's explicit approval for that operation.

**Why:** The hosted companies depend on uninterrupted login, and the user explicitly requires central updates not to disrupt this agent.

**How to apply:** Before any release or agent maintenance, verify the exact target list excludes the designated agent. If exclusion cannot be proven, do not proceed; diagnose production symptoms read-only and ask before any potentially disruptive action.
