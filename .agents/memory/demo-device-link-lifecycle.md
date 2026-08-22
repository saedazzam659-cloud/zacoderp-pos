---
name: Demo session browser handoff and cookie binding
description: One-active-browser handoff rules for demo-isolated accounts, including legacy shadow workspaces.
---

A demo-isolated account has one active browser binding:

- The first browser binds to the source workspace.
- A returning active browser logs in normally.
- A different browser must explicitly confirm transfer after valid credentials. Preflight and cancellation are read-only.
- Transfer never creates another clone. For legacy multi-browser data, retain the most recently seen ready workspace/user, even when it is a shadow rather than the old primary.
- The per-browser token remains an HttpOnly cookie re-verified with the bearer on every authenticated request; a copied bearer alone is useless.

**Why:** Revoking the old browser before the new bearer is durably issued can strand the account with no usable session. Preferring an old primary over a newer legacy shadow makes current demo data appear lost.

**How to apply:**
- Under the per-source-user advisory lock, choose the most recently seen ready workspace.
- In one DB transaction, revoke prior links, retain that workspace/user, create the replacement link, and issue its bearer. Any issuance failure must roll the whole handoff back.
- Disable only superseded legacy shadow users; keep the retained shadow active.
- `decorateDemoShadowUser` must resolve `demoSourceUserId` from the ready, non-revoked link.
- `/auth/me` must not reject every `isDemoShadow` user after `resolveBearerToken` succeeds; the resolver's ready-link + cookie check is the authority. Otherwise login succeeds but the first focus refresh logs out a retained legacy workspace.
- SameSite=None seen in the Replit preview is proxy rewriting, not a bug.
- First-browser preparation and transfer UX must use the credential-gated, read-only server probe against the HttpOnly cookie.
