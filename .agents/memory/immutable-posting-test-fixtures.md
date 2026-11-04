---
name: Immutable posting test fixtures
description: Avoid leaving irreversible posted stock evidence in the shared development database during integration tests.
---

When testing real invoice-posting routes against the shared development database, use service-only invoice lines unless the harness can roll back all posted stock evidence. A stock post may create immutable ledger attribution that cannot be deleted during fixture teardown.

**Why:** A real stock-posting integration run created protected provenance records, so its disposable tenant could not be removed after the test.

**How to apply:** Prefer service-only lines for tax and invoice lifecycle coverage. For stock-posting coverage, use a genuinely isolated database or a transaction-aware test harness that can discard the entire fixture safely.
