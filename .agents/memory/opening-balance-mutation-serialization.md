---
name: Opening-balance mutation serialization
description: Concurrency and fiscal-close invariants for inventory-backed opening journal entries.
---

All mutations that can read, replace, or post the managed inventory lines of an opening journal entry must serialize on one tenant-scoped lock. The lock must be acquired before reading the managed lines and held until the mutation is complete.

**Why:** Serializing only import and posting still permits a concurrent manual edit to restore a stale managed-line snapshot after a successful import. Separately, restricting close checks to the target date range permits closing another period while an unresolved opening draft still exists.

**How to apply:** Any future opening-entry mutation path must join the same lock protocol. Fiscal validation, profit/loss closing, transfer, soft close, hard close, and year close must all treat any company-wide unbalanced opening draft as a blocker.