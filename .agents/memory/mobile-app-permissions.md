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

## Quotation keys + mobile-channel RBAC fallback (2026-08)
- New keys: quotations_view / quotation_create / quotation_edit / quotation_delete (edit covers status-change + convert; convert ALSO requires invoice_create — it mints a sales invoice).
- Generic web RBAC (`requirePermission`/pathRbac) blocked mobile users («صلاحيات غير كافية … sales_invoices»). Fix: permGuard in api-server middleware/permissions.ts falls back to `mobileChannelAllowed()` via MOBILE_MODULE_KEYS (must stay in lockstep with mobilePerms.ts known-keys + web Users.tsx MOBILE_PERM_KEYS).
- ESCALATION GUARD: the fallback GRANTS what web RBAC denied, so it requires DB sessionChannel==='mobile' AND a NON-NULL mobilePermissions set. NULL (= all-allowed back-compat) grants only in the restricting guard requireMobilePerm, never in the fallback — otherwise spoofing x-app-channel at login bypasses web RBAC.
- Quotation GET list/detail also carry requireMobilePerm(quotations_view) (web/desktop callers pass through). PUT enforces terminal-state immutability server-side (only draft/sent editable).
- Quotations list API returns no customerName — mobile list resolves it client-side from /api/customers.

## Mobile UI gates are mp()-only (2026-08)
- Web `permissions` is GRANULAR (sales_invoices, customers…) and usually lacks group keys like `sales_module`; gating mobile UI on `can('sales_module',…)` blanked the + menu for every non-admin user. Mobile screens/buttons gate on mp() (mobile perms) only; server still enforces web RBAC + mobile fallback.
- sales_invoice_lines.item_name is NOT NULL: mobile buildBody must send itemName per line, and mapInvoiceLine/mapQuotationLine keep a never-null fallback — the crash surfaced on saving an invoice converted from a quotation (PUT rebuilds ALL lines wholesale).

## Live sync + bottom bar + themes (2026-08)
- Live sync: api-server lib/dataVersion.ts bumps a per-company in-memory version after any successful mutating /api request (identity from req.authUser ONLY; body companyId trusted just for superadmin). Web gets SSE "data_changed" (sessionEvents, debounced 400ms) → invalidateQueries; mobile polls GET /api/realtime/data-version every 5s while active. Single-process by design.
- Mobile nav: native Tabs bar hidden (display:none); the persistent Facebook-style bar is components/BottomBar.tsx rendered in root _layout under the Stack — new tab screens must be added THERE, and each item gated by mp('screen_*') mobile perm keys (screen_invoices/customers/new/reports) editable from the web Users mobile-perms matrix «إظهار الشاشة» column.
- Theming: useColors now reads ThemeContext (AsyncStorage 'app_theme_key'); add new palettes in contexts/ThemeContext.tsx overrides, never hardcode brand colors in screens.

## تقرير حضوري (my-attendance)
- Employee↔user link lives on `employees.user_id` (partial unique index `employees_company_user_uniq (company_id,user_id)` — one employee per user per company); POST/PUT tenant-validate the linked user. Endpoint GET /api/employees/my-attendance (registered BEFORE /:id or it's shadowed), gated by mobile key `hr_attendance_view`; month upper bound must be the real last day (never `-31` — Feb/30-day months make Postgres reject the date with a 500).
