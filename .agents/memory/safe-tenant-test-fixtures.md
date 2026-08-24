---
name: Safe tenant test fixtures
description: Rules for browser/database tests that create tenant-scoped fixtures.
---

Test fixtures must never create, rename, or delete a company that may already exist. Use a dedicated unique tenant identifier, verify ownership before cleanup, and assert the tenant still exists before and after the test.

**Why:** A cleanup step in an end-to-end test can cascade-delete the entire tenant and its data if setup accidentally reuses a real company code.

**How to apply:** Prefer a disposable fixture tenant with an ownership marker; if a test cannot prove it owns the tenant, it must not delete or cascade-clean it.