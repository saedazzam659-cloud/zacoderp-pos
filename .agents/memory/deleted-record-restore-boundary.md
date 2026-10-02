---
name: Deleted-record restoration boundary
description: Platform-level access and data-integrity rules for restoring deleted records.
---

Keep deleted-record restoration as a platform-wide SuperAdmin tool, not a tenant entitlement. A missing setting means the tool is off; only a SuperAdmin can enable it. Restoration must fail closed when a snapshot is incomplete, has unsupported child data, conflicts with current records, or carries posting or fiscal-submission artifacts.

**Why:** Restoring only a document header can create incomplete accounting or inventory history, while tenant-level switches would expose a platform recovery tool to company users. Passing a policy check against an example payload does not establish that a specific historical snapshot is complete.

**How to apply:** When extending restoration or acting on historical records, inspect the actual agent/company snapshot and current uniqueness conflicts first. Do not make production restore writes from development without explicit approval.