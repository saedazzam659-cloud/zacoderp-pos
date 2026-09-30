---
name: Unified module reports
description: Design constraints for unified report selectors across ERP modules.
---

Unified report screens are navigation and selection layers, not replacement report implementations. They must load the existing report route so its query behavior, server calls, and route-level authorization remain canonical.

**Why:** Duplicating report screens risks drift in calculations, filters, or permissions. The inventory selector also has an established independent agent setting that must remain compatible with module-level selection.

**How to apply:** Keep each module's enablement selective and agent-scoped, preserve the legacy inventory toggle, and key the remembered report by both user and active company.