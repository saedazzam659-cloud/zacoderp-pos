---
name: Developer/Partner self-service portal
description: The platform_partners portal is a deliberate 1:1 mirror of the reseller portal — what must stay in lockstep, and the shared-logout gap inherited from it.
---

# Developer / Partner portal (platform_partners)

A self-service portal for platform developers/partners, built as a deliberate
1:1 mirror of the **reseller portal**. When extending either, change both sides
together — they are intentionally parallel (auth shape, capability gates, the
three App.tsx routing spots).

## Durable invariants
- Partners live in `platform_partners`, resellers in `resellers` — NEITHER in
  `users`. Both authenticate via their own `/login`, resolve through `/api/auth/me`
  to a distinct role (`"partner"` / `"reseller"`) with `companyId:null` + their own
  id + granular `*Permissions`, and scope every portal route to their own record
  + linked-company id set.
- Portal access guard requires BOTH active AND an "approved/active" status, not
  just credentials — an unapproved/inactive partner must fail login closed.
- Commissions + commissions-summary are gated on the SAME capability
  (`view_reports`); a portal identity with empty permissions gets 403 on both.

## Inherited shared-logout gap (deliberate, not a bug to fix one-sided)
The portal UIs call the shared `logout()` → `/api/auth/logout`, which only revokes
`users` and SuperAdmin session tokens — NOT reseller/partner `sessionToken` rows.
The dedicated `/api/{reseller,partner}/logout` endpoints DO revoke, but the UIs
don't call them. **Why:** the partner portal mirrors the reseller portal exactly;
fixing token revocation for partners alone would diverge from the canonical
source. If you ever close this gap, close it for BOTH (e.g. add a partner+reseller
branch to the shared `/api/auth/logout` handler), not one in isolation.
