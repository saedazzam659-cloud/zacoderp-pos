---
name: Shared-database top-N tests
description: Keep leaderboard integration tests deterministic when using the shared development database.
---

When a test asserts that its seeded tenant appears in a global top-N endpoint, the fixture must rank above existing shared-database tenants by a clear margin, or the test must run against an isolated database. Equal fixture/live rankings make row order nondeterministic.

**Why:** A fleet test seeded 80 critical runs per tenant, but existing development tenants also had 80; valid tie ordering excluded every test tenant from the top five.

**How to apply:** Check current shared-data scale before choosing fixture sizes. Prefer isolated test databases for global ranking assertions; if the shared DB is required, seed with headroom and keep inserted data modest.
