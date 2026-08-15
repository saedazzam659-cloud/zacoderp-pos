---
name: Mobile app permissions (صلاحيات تطبيقات الموبايل)
description: Per-user mobile-channel permission map — key lockstep, session-bound channel, server price enforcement
---

- `users.mobile_permissions` JSONB mirrors posting_permissions semantics: NULL/missing = allowed, explicit false = denied, admin/superadmin bypass.
- Permission keys live in THREE lockstep places: api-server `lib/mobilePerms.ts` (doc comment), web `Users.tsx` `MOBILE_PERM_KEYS`, and the mobile app's `mp('<key>')` call sites. Adding a key means touching all three.
- **Channel binding:** never trust `x-app-channel` per-request only. Login stores `users.session_channel` ('mobile'|'web') and enforcement fires when session_channel==='mobile' OR header says mobile — dropping/forging the header can't unbind a mobile session.
- **Why:** the header is client-controlled; a denied user could replay the authenticated call without it.
- **Price lock:** when `invoice_edit_price` is denied, server checks each line unitPrice vs items.salePrice (±0.01) AND recomputes subtotal/VAT/total from lines (rejects forged header totals/discounts), and rejects PUT edits that omit lines.
- Mobile UI gates are cosmetic for view keys (by design); only sales create/edit is server-enforced.
- Live perms: mobile polls /api/auth/me every 30s (`useMobilePerms`); fresh prices via react-query staleTime 0 + refetchOnMount 'always' + useFocusEffect refetch on item screens.

## Edit/delete keys + mobileGuard (2026-08)
- 8 more keys: invoice/return/voucher/customer × _edit/_delete (NULL=allowed, same semantics).
- Reusable server gate: api-server `lib/mobileGuard.ts → requireMobilePerm(req,res,companyId,key,msg)` — returns false AFTER writing 403; caller must `return`. Applied on PUT/DELETE of sales-invoices, sales-returns, receipt-vouchers, customers. Web callers pass (session_channel + x-app-channel both checked; single-session token rotation makes channel binding safe).
- Web Users.tsx matrix: MOBILE_PERM_KEYS rows carry optional editKey/deleteKey → 3 checkbox columns; ALL_MOBILE_KEYS flatMap drives seed/deny-all.
- Mobile UX rule from review: delete must be reachable when only *_delete is granted — render the delete button in the read-only/edit-denied branch too, never only inside the editable branch.
