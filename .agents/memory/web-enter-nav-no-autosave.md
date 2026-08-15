---
name: Web voucher Enter-nav must not auto-save
description: Enter on the last form field must never trigger save — it silently created duplicate draft vouchers.
---

**Rule:** In zatca-invoicing form-wide Enter-key navigation (`advanceFromTarget` in the 4 PV/RV forms — Payment/Receipt × Simple/Multi), reaching the last field must FOCUS the save button (`pv-save-draft`/`rv-save-draft`), never call `save("draft")`.

**Why:** A stray Enter mid-entry silently POSTed a draft voucher; the user then finished the form and pressed «حفظ وترحيل», minting a second voucher + JE. Looked like "editing created a new voucher" (prod company 10, PYB-105/106, 2026-08-15). Backend PUT was proven correct — edit never duplicates; the phantom create came from this auto-save.

**How to apply:** Any new form that copies this Enter-nav pattern must end the chain at the save button focus, not an implicit save.
