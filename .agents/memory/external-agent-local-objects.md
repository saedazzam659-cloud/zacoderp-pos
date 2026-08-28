---
name: External-agent local objects
description: Storage portability rule for private files on full external agents.
---

Full external agents must treat `/objects/<key>` as a backend-neutral reference. When the local agent config is present, private object reads, writes, metadata, and deletes use a filesystem root; cloud installations continue using Replit Object Storage.

**Why:** Full agents run independently and may have no Replit bucket or sidecar. Making an import or restored attachment depend on `PRIVATE_OBJECT_DIR` being a cloud bucket causes a production-only 400 and leaves copied file references unusable.

**How to apply:** Keep browser/database paths as `/objects/...`; select the backend server-side. When packaging legacy rows, canonicalize relative/absolute filesystem references only if they resolve to an existing file beneath the configured private root. Direct local uploads must be authenticated, company-scoped, size-bound, one-shot, short-lived, mode `0600`, traversal-safe, and cleaned after restore or failure.