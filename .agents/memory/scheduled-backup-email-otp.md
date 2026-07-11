---
name: Scheduled auto-backup + OTP email destination
description: How the per-company scheduled master-data backup + verified email cloud destination is wired, and the invariants that keep it correct/secure.
---

# Scheduled auto-backup + email cloud destination

Per-company scheduled snapshot of **master data only** (do NOT expand to transactions without asking). Backend `artifacts/api-server/src/routes/backup.ts`, UI `GeneralSettings.tsx` backup tab. 13 `companies` columns (auto_backup_* / backup_email_* / last_auto_backup_at) applied via ensureSchema.

## Interval-unit contract (was a real bug)
- Frontend picker sends **plural** unit values (`minutes|hours|days|weeks|months`); the value is stored verbatim and read back to re-populate the select.
- `UNIT_MINUTES` in backup.ts therefore maps **both** plural and singular keys → minutes. If you add a unit, add BOTH forms or the UI save 400s ("وحدة زمنية غير صالحة") and/or the picker won't rehydrate on reload.
- `effectiveIntervalMinutes(value, unit, frequencyHours)` prefers (value,unit), falls back to legacy `frequencyHours*60`. month ≈ 30 days (no calendar lib).

## Scheduler invariants
- One `setInterval(tick, 60_000)` (+ 5s startup run). Minute granularity is intentional.
- **Single-flight guard** `tickInFlight` (reset in `finally`) is mandatory: a slow tick must never overlap the next, or two runs read the same stale `last_auto_backup_at` and each writes a duplicate snapshot.
- Due when `Date.now() - lastAt >= effectiveIntervalMinutes*60000`. `persistSnapshot(id,"scheduled",true)` — the `true` = also deliver to the verified email destination.

## Email destination = verified-only, OTP-gated
- Address never becomes active until a 6-digit OTP mailed to it is confirmed (proves mailbox control). `/email/request` → `/email/verify` → sets `backupEmailVerified` + enables delivery atomically.
- **Enable toggle cannot bypass verification**: `/auto/settings` refuses `autoBackupEmailEnabled=true` unless `backupEmailVerified`.
- OTP stored as sha256 hash, 10-min TTL, max 5 wrong attempts (429 then burnt).
- **Anti-flood on `/email/request`**: 60s resend cooldown derived from `expiresAt - OTP_TTL_MS` (no separate lastSent column). `/email/verify` attempt-caps but request flooding needed its own guard.
- Email transport uses `emailConfigured()`/`sendEmail` (lib/email.ts, supports attachments). SMTP secrets may be MISSING in dev → `emailTransportReady=false` surfaces an amber banner; feature still saves, just can't send.

## Multi-tenancy
- Every endpoint resolves tenant via `resolveCompanyId(req, body.companyId?)` — same convention as other routes; tenant users stay scoped, SA impersonation honored.

## Gotcha
- backup.ts has PRE-EXISTING tsc errors (`success` not on WriteRow; SnapshotRow@~436; unknown@~667) — runs fine under tsx. Grep for YOUR line ranges; don't chase these.
- Snapshot download from the UI uses fetch→blob with the token in the header (not an `<a href>`), because the download route is auth-guarded.
