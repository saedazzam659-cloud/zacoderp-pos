---
name: ZacodeHR employee portal
description: Separate employee self-service portal (artifacts/zacodehr) — auth realm, seat limits, punch pipeline, contract notes.
---

# ZacodeHR portal (بوابة الموظف)

- **Separate auth realm** from ERP users: credentials live ON the employees row (`login_username`, `login_password_hash` bcryptjs, `portal_active`). Login = company `code` (upper) + username (lower) + password. Token is a stateless HMAC-SHA256 token signed with SESSION_SECRET (`payload.mac`, kind `hr_portal`, 14-day TTL) — NOT users.sessionToken. `verifyToken`/`signToken` must fail closed when SESSION_SECRET is empty (empty-key HMAC = forgeable tokens).
- **Why:** employees are not `users` rows; reusing the users session table would mix tenants/roles and consume ERP seats.
- Every request re-loads the employee and 401s if creds removed / `portal_active=false` / status≠active — revocation is instant despite stateless tokens.
- **Seat limit** = count of employees with `login_username IS NOT NULL` vs `subscriptions.max_hr_users` (default 10; editable in إدارة التراخيص). Pre-check + post-write recount-and-revert (`hrSeatOverflowRevert`) because the pre-check alone races.
- **No HR engine duplication:** punch inserts `attendance_movements` (source "mobile", onConflictDoNothing) then calls exported `recalcDay` from attendance-plus; استئذان/إجازات insert PENDING rows approved from existing HR screens; payslips join payroll runs with status <> 'draft'.
- Punch date/time must both be LOCAL (toISOString date + local time mixes days around midnight). Geofence vs employee workLat/workLng/workRadiusM (default 200 m); GPS is client-attested — bounds-check and reject 0,0.
- Login endpoint is public → in-memory rate limiter per IP and per company+username (10 fails / 10 min).
- Frontend: 401 redirect must use `import.meta.env.BASE_URL + "login"` — the app is served under /zacodehr/, bare "/login" escapes to the main app.
- Employee API responses always pass through `stripCreds` (drops hash, adds `hasPortalPassword` for the "leave blank to keep" UI).
