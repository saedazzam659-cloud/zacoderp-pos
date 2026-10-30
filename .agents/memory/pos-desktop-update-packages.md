---
name: POS Desktop update packages
description: User-confirmed separation between the online updater MSI and the full offline installer.
---

Keep both POS Desktop installer variants. The small online MSI remains the source for in-app updates and `/download`; the large offline MSI remains available through `/install`. They must stay on separate release platform keys so the full offline build cannot replace the small online update.

**Why:** The user confirmed that both sources should remain active; the problem to solve is availability of a newer online release, not removal of the offline installer.

**How to apply:** When changing release selection or synchronization, preserve `win-x64` for the in-app/web path and `win-x64-exe` for the full offline installer.

Tag pushes create a draft GitHub Release containing both online and offline installer assets. The release sync ignores drafts; after publication it mirrors both platforms automatically.

**Why:** The current workflow sets `draft: true`, while the server sync selects only non-draft releases and mirrors both installer channels.

**How to apply:** Before releasing only one channel, ensure the published release contains only the intended asset or confirm both channels should advance. Publishing makes the release public; use the workflow's version-matching tag and confirm before public release.

Windows Installer can return success while doing no update when the MSI enters maintenance mode and selects no features.

**Why:** The user's verbose log showed `Product registered: entering maintenance mode`, skipped `FindRelatedProducts`, and `Request: Null; Action: Null` for installed features.

**How to apply:** Inspect the MSI log; only in confirmed maintenance mode retry with `REINSTALL=ALL` so the package actually replaces its files.
