---
name: SuperAdmin device-approval public decide
description: Emailed device-approval flow — token split, public password re-auth page, chicken-and-egg lockout
---

The device-approval email links to a PUBLIC page `/device-approval?token=…` (no session) where the SuperAdmin enters the account password to approve/reject — this breaks the chicken-and-egg lockout when NO trusted device has an active session.

**Why:** the old link pointed to the authed `/admin/security-superadmin` page, which requires an already-logged-in trusted device — impossible for a user with zero trusted sessions, so login sat on "pending" forever.

**Critical invariant — token split:** `/login` returns the polling `approvalToken` to the UNTRUSTED requesting device. That token must NEVER be accepted by the public decide endpoint, or password-only attackers self-approve. A SEPARATE secret goes only in the email; DB stores its sha256 (`sa_device_approvals.email_token_hash`), and `POST /device-approvals/:token/public-decide` matches on that hash. The authed decide endpoint still uses `approvalToken`.

**How to apply:** any new "act via emailed link without a session" flow needs (a) its own emailed secret distinct from anything returned to the requester, (b) password (or equivalent) re-auth, (c) per-token attempt cap + IP rate limit, (d) one generic error for missing/expired/decided (no state oracle).
