---
name: Line-level UOM picker needs seeded units
description: Why the الوحدة (unit-of-measure) picker on sales/purchase document lines looks "missing" and how it is fixed at the tenant level.
---

The line-level "الوحدة" picker exists in all four web document forms (sales invoice / sales return / purchase invoice / purchase return). Each cell renders a `<Select>` **only when the company's global units list is non-empty**, otherwise it silently degrades to a free-text `<Input>`.

**Symptom:** users report the unit field is "missing" or "not at line level" — in reality the column header is always there but the control became a plain text box because the company has no measurement units defined.

**Rule:** a new tenant must be seeded with default measurement units, the same way it is seeded with a default chart of accounts, or the picker degrades to free-text for that company.

**Why:** before the fix, nothing seeded units on company creation, so almost every tenant had zero units and the picker never showed a dropdown.

**How to apply:** unit seeding is wired into company creation alongside chart-of-accounts seeding (idempotent, skips companies that already have units). When diagnosing "unit field missing", check `units` rows for the tenant FIRST before touching the form code — the forms are already correct.
