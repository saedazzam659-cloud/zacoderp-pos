---
name: Smart manufacturing stage permissions
description: User-approved access boundary between Smart Manufacturing route setup and stage execution.
---

Use separate per-user grants for changing route/stage structure and recording operational stage execution. Existing users who already have the current edit grant retain their existing capabilities; execution-only users can enter operational facts without changing the route snapshot.

**Why:** The user chose role-specific permissions over a company-wide switch and explicitly wanted the current access to remain the default for existing users.

**How to apply:** For future Smart Manufacturing permission work, keep route/resource/unit/employee assignment changes under edit access, and keep execution-only access limited to hours, worker count, quantities, and waste. Do not broaden this grant to advanced production unless explicitly requested.
