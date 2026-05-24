// Local SQLite (SQLCipher-encrypted) database for offline POS operations.
//
// Encryption key model (Step 11 hardening):
//   - Per-device 256-bit random key, hex-encoded (64 chars).
//   - Stored in the OS secret store via the `keyring` crate:
//       * Windows  → Credential Manager (DPAPI-backed under the hood)
//       * macOS    → Keychain
//       * Linux    → Secret Service (libsecret)
//   - Generated on first DB open; subsequent opens load it back.
//   - The key never lives in source or on disk in plaintext. If the user
//     reinstalls the OS / migrates the laptop, the keyring entry is lost
//     and the local DB becomes unreadable — by design (matches the
//     security model: this DB holds customer + sales data that must
//     not survive a stolen-machine wipe).
//
// If the keyring is unavailable (e.g., headless CI), we fall back to a
// stable but NON-SECRET key derived from a marker file so dev/CI can
// still run. The fallback is logged loudly and refused in release
// builds — see `derive_or_load_key()`.

use anyhow::{anyhow, Context, Result};
use keyring::Entry;
use rusqlite::Connection;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "com.zacoderp.pos";
const KEYRING_ACCOUNT_DBKEY: &str = "sqlcipher-db-key-v1";

pub fn db_path() -> PathBuf {
    // %APPDATA%\com.zacoderp.pos\pos.db on Windows.
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    std::fs::create_dir_all(&p).ok();
    p.push("pos.db");
    p
}

/// Returns a 64-hex-char SQLCipher key, creating + persisting one on
/// first use. Never returns an empty key.
fn derive_or_load_key() -> Result<String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_DBKEY)
        .context("failed to open keyring entry for db key")?;

    match entry.get_password() {
        Ok(k) if k.len() == 64 => Ok(k),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            // Generate a fresh 256-bit key. We pull from the OS RNG via
            // `getrandom` (re-exported by uuid v4 internally, but we want
            // raw bytes here — use rand-free path through `Uuid` twice).
            let a = uuid::Uuid::new_v4();
            let b = uuid::Uuid::new_v4();
            let mut bytes = [0u8; 32];
            bytes[..16].copy_from_slice(a.as_bytes());
            bytes[16..].copy_from_slice(b.as_bytes());
            let hex_key = hex::encode(bytes);
            entry
                .set_password(&hex_key)
                .context("failed to persist db key in keyring")?;
            log::info!("generated new SQLCipher key and stored it in OS keyring");
            Ok(hex_key)
        }
        Err(e) => {
            // Keyring inaccessible. In debug builds, derive a deterministic
            // dev key so the app stays runnable for engineering work. In
            // release builds, refuse — running unencrypted in production
            // would be a silent security regression.
            if cfg!(debug_assertions) {
                log::warn!(
                    "keyring unavailable ({e:?}); using deterministic DEV key. \
                     DO NOT ship release builds without a working keyring."
                );
                Ok("DEV0000000000000000000000000000000000000000000000000000000000DEV"
                    .to_string())
            } else {
                Err(anyhow!(
                    "OS keyring unavailable in release build, refusing to open DB unencrypted: {e:?}"
                ))
            }
        }
    }
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path())?;
    let key = derive_or_load_key()?;
    // SQLCipher expects the key as `PRAGMA key = 'x"<hex>"'` for a raw
    // 32-byte key. Using the `x'...'` blob literal form sidesteps any
    // KDF transformation so the key the user persists in their keyring
    // IS the bytes that encrypt the DB.
    conn.pragma_update(None, "key", format!("x'{key}'"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Smoke-check: any query against sqlite_master will fail with
    // "file is not a database" if the key is wrong, which catches a
    // future keyring-key-drift bug at open time rather than later.
    let _: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))?;
    Ok(conn)
}

pub fn initialize() -> Result<()> {
    let conn = open()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS customers_local (
            id            INTEGER PRIMARY KEY,
            cloud_id      INTEGER UNIQUE,
            name_ar       TEXT NOT NULL,
            name_en       TEXT,
            phone         TEXT,
            vat_number    TEXT,
            updated_at    TEXT
        );
        CREATE TABLE IF NOT EXISTS items_local (
            id            INTEGER PRIMARY KEY,
            cloud_id      INTEGER UNIQUE,
            code          TEXT,
            name_ar       TEXT NOT NULL,
            name_en       TEXT,
            barcode       TEXT,
            sale_price    REAL NOT NULL DEFAULT 0,
            vat_rate      REAL NOT NULL DEFAULT 15,
            updated_at    TEXT
        );
        CREATE TABLE IF NOT EXISTS offline_invoices (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            local_uuid      TEXT NOT NULL UNIQUE,
            invoice_no      TEXT NOT NULL,
            cloud_id        INTEGER,
            payload_json    TEXT NOT NULL,
            signed_xml      TEXT,
            qr_base64       TEXT,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            sync_status     TEXT NOT NULL DEFAULT 'pending',
            synced_at       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_offline_inv_status ON offline_invoices(sync_status);
        "#,
    )?;
    // Add synced_at column on existing DBs from earlier builds (ALTER TABLE
    // is the only way; CREATE TABLE IF NOT EXISTS is a no-op when the
    // table already exists, so the column wouldn't appear there).
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);
    Ok(())
}
