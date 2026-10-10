---
name: Drizzle schema sync boundary
description: Avoid unsafe Drizzle pushes against the monorepo's broad, drifted ERP schema.
---

Do not use `drizzle-kit push --force` or assume a partial schema plus `tablesFilter` is isolated in this workspace. A school-only schema/filter attempt still generated drop statements for unrelated shared enums and sequences. The full-schema push is intentionally omitted from the post-merge script because accumulated drift can span unrelated ERP modules.

**Why:** Forced push can approve destructive changes, and a subset source schema can be interpreted as removal of every omitted object.

**How to apply:** Use the approved development-schema flow only after reviewing the complete diff. Runtime schema healing may not create newly declared tables; if the full diff includes unrelated missing objects or constraints, stop rather than force or filter it. Keep production schema changes in Replit Publish; do not add startup DDL or custom production migrations.
