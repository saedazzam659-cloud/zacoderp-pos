---
name: Full-company backup catalog contract
description: Safety rules for dynamic full-tenant export and replace restore.
---

Schema-v2 full-company restore must compare the uploaded manifest bidirectionally against the complete live catalog before deleting anything: exact tables, ordered columns, primary-key metadata, and foreign keys. Missing or unsupported relationships must fail closed, never degrade to a partial restore.

**Why:** An uploaded manifest is attacker-controlled. If it can omit a table or FK, “full replace” silently leaves old rows behind or inserts raw IDs that can reference another tenant. Generic secret-name matching is also unsafe because business hashes such as invoice hashes and ZATCA PIH are evidence, not credentials.

**How to apply:** Discover company roots and dependent children from PostgreSQL metadata; sanitize actual credentials recursively (including signed URLs and JSONB) while preserving business hashes; restore in one transaction with ID remapping. Explicitly report file references whose bytes are not embedded.