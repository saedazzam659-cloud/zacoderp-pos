---
name: Zid invoice source boundary
description: Per-company ZATCA invoice ownership and safe Zid OAuth integration.
---

Each company must explicitly choose one source for tax invoices: Zid or the ERP. Keep the Zid integration off by default and enable it only through SuperAdmin company permissions. Use Zid's official server-side OAuth flow; never collect merchant passwords or pasted access/refresh tokens. Do not let an imported sale be submitted to ZATCA by both systems. The direct Zid credit-note path must be verified before returns rely on it.

Do not activate a Zid connection immediately after OAuth. Show the returned Zid store name/ID together with the ERP company that initiated authorization and require explicit confirmation. A store ID may belong to only one active ERP company, and each ERP company may have only one active Zid store.

**Why:** The user selected per-company issuer ownership to prevent duplicate tax invoices. Zid offers its own direct ZATCA channel, and duplicate or missing credit notes create fiscal risk.

**How to apply:** Before enabling order or return synchronization, check the company's current issuer choice server-side, preserve idempotency across imports, and route each fiscal document through exactly one issuer. For OAuth, confirm the company/store pair before activation and reject an active store already claimed by another ERP company.
