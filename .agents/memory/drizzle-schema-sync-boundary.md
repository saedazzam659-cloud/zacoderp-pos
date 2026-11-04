---
name: Drizzle schema sync boundary
description: Avoid unsafe Drizzle pushes against the monorepo's broad, drifted ERP schema.
---

Do not use `drizzle-kit push --force` or assume a partial schema plus `tablesFilter` is isolated in this workspace. A school-only schema/filter attempt still generated drop statements for unrelated shared enums and sequences. The development database also contains many existing tables absent from the Drizzle barrel; a full push prompts about unrelated tables before reaching the requested change. The project post-merge script makes API `ensureSchema` the approved reconciliation path. A new table may use a complete, idempotent additive helper there when it is needed on central/agent databases; keep the helper lock-bounded and scoped to its feature.

**Why:** Forced push can approve destructive changes, and a subset source schema can be interpreted as removal of every omitted object. Recent schema introspection confirmed the development database and Drizzle source are materially out of sync. The repository's explicit `post-merge.sh` contract supersedes the older assumption that all new tables require the generic push/publish flow.

**How to apply:** Never force or filter Drizzle push to add one feature to this broad schema. Follow `scripts/post-merge.sh`: declare the schema, add narrowly scoped additive DDL to the existing ensureSchema flow for new tables, and let generic healing add safe nullable/defaulted columns. Use the existing bounded DDL/lock conventions, preserve central-versus-agent ownership, and do not include unrelated cleanup or default/constraint repairs.
