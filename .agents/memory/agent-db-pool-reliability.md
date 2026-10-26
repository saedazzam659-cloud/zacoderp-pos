---
name: Agent database pool reliability
description: Reliability boundaries for external agent PostgreSQL pools and stale transactions.
---

Agent database pool saturation must not take down login or the wider agent interface. Treat spare pool capacity as reserved for authentication and health traffic, and use bounded admission for operations that hold a dedicated database lock client while issuing their own queries. Under overload, return a retryable error before exhausting the pool.

**Why:** The user explicitly said this failure must not recur after an agent's external pool reached 20/20 and login requests timed out.

**How to apply:** For changes to external-agent pools, advisory locks, and transaction lifecycles, preserve reserved connection capacity, test timeout/error cleanup, and do not claim zero recurrence risk until the code-level cause and production behavior are verified. Automatic idle-transaction rollback requires explaining that uncommitted work can be rolled back.
