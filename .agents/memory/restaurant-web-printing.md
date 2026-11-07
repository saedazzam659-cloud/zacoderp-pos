---
name: Restaurant web printing
description: The restaurant POS is web-only; printer routing must not depend on POS Desktop.
---

The restaurant POS remains a web application. Do not route its kitchen printing through the separate POS Desktop product. Branch computers currently run Windows. Automatic selection of branch printers and primary-to-backup failover requires an independent local print bridge on the restaurant network; browser printing alone cannot guarantee silent printer selection or detect a completed physical print.

**Why:** The user explicitly clarified that the restaurant system is entirely web, selected a standalone local bridge rather than POS Desktop for automatic printing, and confirmed Windows on branch computers.

**How to apply:** Keep restaurant screens and order workflows in the web POS. Treat any local printer service as a separate companion component, scoped to a branch and connected to the web API with its own authorization.
