---
name: Zero-priced service sales
description: Web sales invoices and quotations containing zero-priced service items.
---

When the company enables zero-priced service items, web quotations may be saved with those lines. A web sales invoice containing any zero-priced service line must remain a draft and must not post, even if other invoice lines have positive prices. Keep the existing mobile-channel behavior unchanged.

**Why:** The user clarified that the setting is for allowing zero-priced service lines, not permission to post them; automatic posting produced a misleading failure where the invoice should have been saved as a draft.

**How to apply:** Allow the setting in quotation validation and save flows, skip web invoice auto-post for qualifying lines, and retain a server-side posting guard. If the user wants to post, require removing the zero-priced service line or assigning it a positive price.
