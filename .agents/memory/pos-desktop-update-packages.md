---
name: POS Desktop update packages
description: User-confirmed separation between the online updater MSI and the full offline installer.
---

Keep both POS Desktop installer variants. The small online MSI remains the source for in-app updates and `/download`; the large offline MSI remains available through `/install`. They must stay on separate release platform keys so the full offline build cannot replace the small online update.

**Why:** The user confirmed that both sources should remain active; the problem to solve is availability of a newer online release, not removal of the offline installer.

**How to apply:** When changing release selection or synchronization, preserve `win-x64` for the in-app/web path and `win-x64-exe` for the full offline installer.
