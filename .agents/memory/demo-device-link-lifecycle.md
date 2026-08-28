---
name: Phone-keyed demo workspaces and browser handoff
description: Demo workspace identity and one-active-browser handoff rules after phone isolation.
---

A shared demo source account creates one independent workspace per normalized phone:

- A first login for a phone must clone master/setup data into a shadow company; it must never bind the phone to the shared source company.
- The same phone reuses its existing ready workspace. A different browser must explicitly confirm transfer after valid credentials.
- A different phone creates a different workspace even when both use the same shared demo credentials.
- A new phone workspace must use a deterministic code-owned baseline, not clone mutable master rows from the shared source or another phone workspace. Seed a fresh COA plus the canonical branch/warehouse/SAR/cost-center/customer/supplier/cash/bank/item set in the company-creation transaction.
- Never re-seed an existing ready phone workspace; same-phone restoration must preserve everything that user already configured.
- Never copy invoices, journals, vouchers, stock balances, stock movements, or ledgers between demo workspaces.
- The per-browser token remains an HttpOnly cookie re-verified with the bearer on every authenticated request; a copied bearer alone is useless.

**Why:** Source-user-only binding merged every demo visitor into one company. Phone-keyed workspaces preserve each visitor's data across devices without exposing another visitor's operations.

**How to apply:**
- Normalize and require the phone before provisioning. Scope active-link queries and revocation by both source user and phone.
- Under the source-user advisory lock, claim a provisioning row before cloning so concurrent first logins cannot create duplicate workspaces.
- Keep the deterministic baseline gated to internal phone-demo provisioning. Normal company cloning and other demo-company seeders must retain their own behavior.
- On same-phone transfer, retain the most recently seen ready workspace and issue the replacement bearer in the same transaction that revokes the prior phone-scoped link.
- Disable only superseded legacy shadow users; keep the retained shadow active.
- `decorateDemoShadowUser` must resolve `demoSourceUserId` from the ready, non-revoked link.
- `/auth/me` must not reject every `isDemoShadow` user after `resolveBearerToken` succeeds; the resolver's ready-link + cookie check is the authority. Otherwise login succeeds but the first focus refresh logs out a retained legacy workspace.
- Source-user RBAC edits and source-company menu grants must propagate to every ready, non-revoked retained shadow workspace and emit a refresh for the shadow company. A normal user needs both layers; an admin can hide this drift because it bypasses per-user RBAC.
- `/auth/me` must self-heal a retained shadow's user permissions and company menu permissions from its source records. This repairs workspaces that were already stale before live propagation existed, without making the admin toggle settings again.
- SameSite=None seen in the Replit preview is proxy rewriting, not a bug.
- First-browser preparation and transfer UX must use the credential-gated, read-only server probe against the HttpOnly cookie and submitted phone.
