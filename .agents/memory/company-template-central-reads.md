---
name: Company template seeding across agent DBs
description: Template-company reads must come from centralDb; writes stay on ALS db
---
The new-company template (template company id 10, `companyTemplate.ts`) lives ONLY in the central DB.

**Why:** On agent domains the ALS-proxied `db` targets the agent's external DB, where company 10 doesn't exist — template reads through `db` silently found nothing and new agent companies fell back to the generic default COA.

**How to apply:** All TEMPLATE-source reads (settings, sequences, party-account exclusions, COA) use `centralDb` explicitly; every write for the NEW company stays on the ALS `db` so it lands in whichever DB the company was created in. Same rule for any future template-driven seeding.

Related: company rename is a dedicated SA-only `PUT /api/companies/:id/rename` (partial body {nameAr,nameEn?}, strict `?agent=` validation → runWithAgentScope). The generic PUT requires the FULL UpdateCompanyBody — never patch one field through it; and a malformed `?agent=` must 400, never fall through to the central DB.
