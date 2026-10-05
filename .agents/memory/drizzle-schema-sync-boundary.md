---
name: Drizzle schema sync boundary
description: Avoid unsafe Drizzle pushes against the monorepo's broad, drifted ERP schema.
---

Do not use `drizzle-kit push --force` or assume a partial schema plus `tablesFilter` is isolated in this workspace. A school-only schema/filter attempt still generated drop statements for unrelated shared enums and sequences. The full-schema push is intentionally omitted from the post-merge script because accumulated drift can span unrelated ERP modules.

**Why:** Forced push can approve destructive changes, and a subset source schema can be interpreted as removal of every omitted object.

**How to apply:** Use only the project's approved development-schema flow after reviewing its complete diff. Keep production schema changes in Replit Publish; do not add startup DDL or custom production migrations.
