---
name: Cross-server company transfer
description: Safety rules for moving a tenant and its private objects between central and full-agent servers.
---

Run attachment-inclusive transfers by building and restoring the portable backup package on the server that owns each side’s object storage. Move the temporary package through SSH only after strict host-key pinning. Create the target suspended with its administrator disabled, and activate both only after restore succeeds.

**Why:** Database routing alone cannot move private objects between central cloud storage and an agent’s local filesystem. Also, treating cleanup failure after a committed restore as transfer failure invites a duplicate retry, while activating the target before restore can expose partial data.

**How to apply:** Keep upload/preflight/restore failures fatal and cleanup-protected. Once restore has returned success, preserve that success even if final temporary-file deletion fails; return and audit an explicit cleanup warning instead. Never transfer ZATCA EGS identity or signing secrets.