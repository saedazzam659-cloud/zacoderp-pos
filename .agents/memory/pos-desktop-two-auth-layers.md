---
name: POS Desktop two-layer auth
description: Device token + cashier token live in separate keyring slots; logout must never wipe the device binding.
---

The Tauri POS desktop runs **two** auth tokens that must stay independent:

1. **Device token** — `X-Device-Token` header, keyring slot `device-token-v1`. Issued once per machine via `/api/device-licenses/activate`. Forever (until deactivate/revoke). Identifies the physical terminal.
2. **Cashier user token** — `Authorization: Bearer …`, keyring slot `user-token-v1`. Issued by `/api/auth/login`. Rotates on every login/logout.

**Why two slots:** logging out a cashier (`onLogoutCashier`) must only wipe slot 2; logging out the device (`onSignOut`, e.g. deactivate) wipes both. A single slot would force a full re-activation every shift change.

**How to apply when adding endpoints to `lib/api.ts`:**
- Cloud calls that need only the device → pass `userToken: null` to `createApi`.
- Calls that need the cashier (sessions, invoices) → require BOTH tokens; `createApi` attaches each header conditionally.
- `/api/auth/me` returns the user object at top level (NOT wrapped in `{ user }`) — `cashierMe()` is typed `CashierUser`, not `{ user: CashierUser }`. Easy mistake to make from JS-side naming.

Boot phases (`App.tsx`): `checking → needs-activation → needs-cashier → signed-in`. Network-offline boot trusts cached `CashierContext` (localStorage) so a cashier can keep ringing sales when the cloud is unreachable; `/auth/me` revalidation only kicks in when the request succeeds.
