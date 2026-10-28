---
name: POS Desktop release publishing
description: GitHub Actions tag-based Windows MSI releases and their authorization constraints.
---

For POS Desktop, pushing a `pos-desktop-vX.Y.Z` tag starts the Windows MSI workflow, which creates a draft release when the build succeeds.

**Why:** Replit's HTTPS Git credential can lack GitHub's `workflow` scope even when the GitHub integration appears authorized. SSH deploy-key access is a separate path and must be loaded in the same shell that pushes.

**How to apply:** Confirm the local commit and tag, push only the tag using an authorized repository SSH key, then verify the Actions result and draft assets. Never publish or sync a draft to customers without explicit approval.
