---
name: POS Desktop data survives updates + pre-update auto-backup
description: Why the offline pos.db is NOT lost across an MSI update, and the automatic safety snapshot taken before each in-app install.
---

# Data preservation across POS Desktop updates

The offline SQLite `pos.db` lives in `%APPDATA%\com.zacoderp.pos` (or a relocated
folder via `datadir.cfg`), resolved by app code (`db::data_root`) — NOT by the
installer. A normal per-machine MSI **upgrade or uninstall replaces binaries in
Program Files and never touches `%APPDATA%`**, so data survives reinstalls and the
old→new transition. Field reports of "lost all data after deleting the old
version" come from MANUAL folder deletion or a much older build, not from the MSI.

**Rule:** never tell the user data is lost on update. The fix for "update won't
apply" is the already-landed installer track (pinned WiX UpgradeCode, MSI-only,
direct `msiexec /i /passive /norestart`, startup `cleanup.rs`). A client stuck on
a pre-fix build can't self-heal — it needs ONE manual clean MSI install, after
which updates apply cleanly forever (cleanup.rs prunes strictly-older builds).

## Belt-and-suspenders: pre-update auto-backup
`backup::pre_update_backup()` snapshots `pos.db` into `<data_root>/backups/
pre-update-<YYYYMMDD-HHMMSS>.db` (keeps newest 10) and is called from
`updater.rs` **before** spawning msiexec — synchronous, non-fatal on error so it
never blocks the update. The backups folder is inside `%APPDATA%`, which the MSI
never removes, so a worst-case bad install is always recoverable via the existing
Backup→Import (restore) UI.

**Why:** the data was already safe, but the user's primary fear is data loss; an
automatic snapshot makes loss impossible in practice and is the trust-builder.
**How to apply:** keep the backup call ordered before msiexec; any new install
path (offline wizard, etc.) that replaces the db must take the same snapshot.
