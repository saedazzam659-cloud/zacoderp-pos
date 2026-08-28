---
name: Full-company backup catalog contract
description: Safety rules for dynamic full-tenant export and replace restore.
---

Schema-v2 full-company restore must compare the uploaded manifest bidirectionally against the complete live catalog before deleting anything: exact tables, ordered columns, primary-key metadata, and foreign keys. Missing or unsupported relationships must fail closed, never degrade to a partial restore. The only allowed column-drift boundary is the protected users table: users are never deleted, imported identities are disabled, and values must be reconciled to live columns/defaults.

**Why:** An uploaded manifest is attacker-controlled. If it can omit a table or FK, “full replace” silently leaves old rows behind or inserts raw IDs that can reference another tenant. Generic secret-name matching is also unsafe because business hashes such as invoice hashes and ZATCA PIH are evidence, not credentials.

**How to apply:** Discover company roots and dependent children from PostgreSQL metadata; sanitize actual credentials recursively (including signed URLs and JSONB) while preserving business hashes; restore in one transaction with ID remapping. Keep business-table catalogs exact. For protected users only, ignore source-only columns, apply live defaults for absent/legacy-null required fields, and normalize boolean encodings. Explicitly report file references whose bytes are not embedded.

Company-settings restore must bind every value with `sql.param` after type normalization; never interpolate raw arrays/JSON into a dynamic SET list.

**Why:** Drizzle can expand an interpolated JSON array into multiple query parameters, producing a PostgreSQL bind-count mismatch only at the final company-settings step. The transaction then rolls back all otherwise-restored module rows.

Portable company backups must carry private object bytes with a per-file SHA-256 manifest, then restore them under fresh target-company object keys before rewriting database references. Never reuse source paths or copy arbitrary external URLs.

**Why:** Database-only copies leave invoice/archive/image references pointing at missing or source-owned objects. Reusing those paths also couples tenant access and deletion lifecycles.

**How to apply:** Deduplicate identical private object paths, bound and hash every file, reject unsafe package structure before upload, clean staged target objects if database restore fails, and preserve legacy JSON as data-only restore.