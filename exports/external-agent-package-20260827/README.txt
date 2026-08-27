Zacode ERP external agent package - 2026-08-27

Upload mapping:
- Backend: backend.tgz
- Frontend: frontend.tgz
- Database: database-sanitized.dump

Database safety:
- Built from an isolated clone; the original Replit database was not modified.
- Business records are retained for realistic testing.
- User/customer/supplier/employee/company identity fields were replaced with demo values.
- Passwords, tokens, API credentials, ZATCA credentials, sessions, outbound email, integrations, notifications and automatic backups are disabled or cleared.

Updates:
- New Replit publishes are offered to the external full agent.
- Installation requires local SuperAdmin approval and health-check rollback; no automatic restart.

Verify files:
sha256sum -c SHA256SUMS.txt
