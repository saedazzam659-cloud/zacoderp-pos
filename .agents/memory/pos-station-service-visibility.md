---
name: POS station service visibility
description: User-facing rule for hiding POS shortcuts according to the selected station and cashier service settings.
---

Only POS services enabled for the selected station or cashier appear as shortcuts on the cashier screen, including when an administrator is using that station. Hide unconfigured services. Keep company-module and signed-in-user permission checks as separate access gates.

**Why:** The user expects the terminal's service selections to control which tools appear in the POS screen.

**How to apply:** Resolve the selected station's and cashier's service settings before rendering service shortcuts; an empty or unconfigured selection means no optional service shortcuts.
