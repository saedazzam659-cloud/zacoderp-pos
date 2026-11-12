---
name: Developer Cloud backup and recovery boundary
description: Keep backup/recovery isolated from existing agent tools and never import a database during code restore.
---

Developer Cloud backup and recovery must remain additive to the existing agent-server tools. A recovery bundle contains the central runtime release and a full PostgreSQL snapshot from the selected source. Uploading a bundle to an agent is a separate, explicit action because the encrypted bundle may contain company data. Restoring an agent sends only the runtime code; it must never copy or import the database snapshot. Replit central recovery remains manual through project checkpoints followed by republishing.

**Why:** The user explicitly required that currently working agent-server tools remain unchanged, selected both central and agent recovery, and required preserving company data during code restoration.

**How to apply:** Keep new backup routes and UI separate from existing agent-management routes. Require clear consent before sending a full encrypted snapshot to an agent, and preserve the database in place during every code-only restore.
