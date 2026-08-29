---
name: KARM production role
description: Defines the deployment and database-safety boundary between the central development platform and the KARM production server.
---

KARM AZZAM is the primary live production platform and must receive the complete frontend, backend, modules, and additive schema upgrades. The central platform is used for development and testing.

**Why:** The owner explicitly confirmed that KARM serves the real customers while the central environment is where changes are developed and tried. Treating KARM as an ordinary limited agent, or restoring the development database during routine updates, risks data loss and feature drift.

**How to apply:** Routine releases install frontend/backend and migrate KARM’s existing database in place. Never restore or replace its database from central unless an explicit first-install or disaster-recovery operation has been separately confirmed. Keep production files and attachments local to KARM.