---
name: Email sender channel routing
description: Two-channel email routing — security via Outlook connector, general via company sender → system SMTP → connector fallback
---

# Email sender channel routing

Rule: `sendEmail` in the api-server email lib takes `channel` + optional `companyId`.
- `channel:"security"` (SuperAdmin OTP/new-device/failed-login/password-change/device-approval/recovery) → Outlook connector mailbox FIRST (asilkarmazzam@outlook.com), SMTP only as fallback.
- General (default channel) resolves sender in order: company sender (per-company SMTP columns on `companies`, password AES-256-GCM encrypted keyed by SESSION_SECRET) → system SMTP env (`SMTP_HOST/PORT/USER/PASS/FROM`, defaults to zacoderp@outlook.com) → connector last resort.

**Why:** general system mail must NOT come from the personal connector mailbox; the connector is reserved for SuperAdmin security self-sends. Per-company senders let tenants brand their own outgoing mail.

**How to apply:**
- ANY new security-related email helper must pass `channel:"security"` (no test guards this — drift risk).
- ANY new general email call site that is tenant-scoped should pass `companyId` so the company sender is honored.
- Sender-settings API: GET never returns the password (only `hasPassword`); PUT password semantics undefined=keep, ""=clear; the `/test` endpoint is strict — configured company SMTP must work, no silent fallback (surfaces the real SMTP error).
- The Outlook connector is NOT visible from the code-execution sandbox (`listConnections('outlook')` returns 0 there); it only works inside api-server via @replit/connectors-sdk.
