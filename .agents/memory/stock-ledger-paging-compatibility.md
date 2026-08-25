---
name: Stock-ledger paging compatibility
description: Compatibility and export rules for server-paged stock-ledger reports.
---

Stock-ledger pagination must remain opt-in. Requests carrying pagination parameters receive a page envelope with filtered totals; requests without them retain the legacy array response.

**Why:** Other screens consume the same endpoint as a direct array. Changing the default response shape would break those screens, while loading all ledger rows before client-side paging defeats the report's scalability requirement.

**How to apply:** New paged reports should request the page envelope explicitly, calculate totals over the complete filtered result on the server, and fetch all pages only after the user starts a full export.