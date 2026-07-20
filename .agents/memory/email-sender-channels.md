---
name: Email sender channel routing
description: Two-channel email routing — security via Outlook connector, general via company sender → system SMTP → connector fallback
---

# Email sender channel routing

Rule: `sendEmail` in the api-server email lib takes `channel` + optional `companyId` (+ `skipChannelSenders` for diagnostics).
- SuperAdmin can pin a mailbox PER CHANNEL (training / security / documents) via إدارة إيميلات الإرسال (`system_settings` key `channel_sender:<ch>`, JSON with AES-encrypted pass, 30s cache + invalidate on save).
- `channel:"security"`/`"training"` → pinned channel SMTP FIRST → Outlook connector → system SMTP.
- General (default channel) resolves sender in order: company sender (ضبط المرسلات — ALWAYS wins for tenant mail, per explicit owner requirement) → `documents` channel mailbox → system SMTP env (`SMTP_HOST/PORT/USER/PASS/FROM`) → connector last resort.
- Each channel config carries `strictNoFallback` (وضع صارم): if the pinned channel SMTP fails, `sendEmail` returns `{ok:false, reason:"strict_no_fallback|<real reason>"}` and NEVER falls back to connector/system SMTP. PUT preserves the stored flag when omitted. GET/PUT/DELETE responses include `connector:{enabled,address}` (live Graph /v1.0/me, cached) so the screen always shows which mailbox the fallback would use.
- `skipChannelSenders:true` bypasses ALL pinned channel mailboxes — used by the reports SMTP-config `/test` endpoint so it validates the GLOBAL SMTP path only. Any new "test global SMTP" diagnostics must pass it too.

**Why:** general system mail must NOT come from the personal connector mailbox; the connector is reserved for SuperAdmin security self-sends. Per-company senders let tenants brand their own outgoing mail.

**How to apply:**
- ANY new security-related email helper must pass `channel:"security"` (no test guards this — drift risk).
- ANY new general email call site that is tenant-scoped should pass `companyId` so the company sender is honored.
- Sender-settings API: GET never returns the password (only `hasPassword`); PUT password semantics undefined=keep, ""=clear; the `/test` endpoint is strict — configured company SMTP must work, no silent fallback (surfaces the real SMTP error).
- The Outlook connector is NOT visible from the code-execution sandbox (`listConnections('outlook')` returns 0 there); it only works inside api-server via @replit/connectors-sdk.
