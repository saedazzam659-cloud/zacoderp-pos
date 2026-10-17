---
name: Optional module dashboards
description: Product boundary for the separately gated module-dashboard capability.
---

Keep the existing core home dashboard unchanged. The multi-module dashboard capability is an additional company module, default-off for companies, with its own user permission. Each dashboard must use authoritative module/report data and preserve company, branch, warehouse, and user authorization. Never combine monetary totals across currencies.

**Why:** The existing core dashboard is part of the always-on ERP baseline. Reusing or disabling its key would break access for existing companies, while dashboard aggregates can expose data beyond the source module's permissions or misstate money if they merge currencies.

**How to apply:** When adding a module dashboard, gate the company module and API independently from the core home page, require both the dashboard grant and relevant source-module view permission, reuse established report semantics, and expose only filters the source data and access scope support.
