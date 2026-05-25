// Local SQLite database for offline POS operations.
//
// At-rest encryption (Task #176)
// ──────────────────────────────
// The on-disk DB file (`%APPDATA%\com.zacoderp.pos\pos.db` on Windows) is
// encrypted with SQLCipher AES-256. The 256-bit raw key is generated on
// first launch and sealed in the OS keyring (Windows Credential Manager
// on Windows, Keychain on macOS, Secret Service on Linux) under the
// `db-key-v1` slot — separate from the device-token and user-token slots
// so wiping one credential never collaterally orphans the DB.
//
// We use `rusqlite`'s `bundled-sqlcipher-vendored-openssl` feature, which
// statically links a vendored OpenSSL into the binary — no runtime DLL
// dependencies to bundle in the MSI (the original blocker that deferred
// this work out of Task #174).
//
// Auto-migration: if a *plain* (unencrypted) DB from an older install is
// found at the same path, we transparently transcode it into an
// encrypted copy via SQLCipher's `sqlcipher_export()`, then atomically
// replace the file. The original plain file is preserved alongside as
// `pos.db.plain.bak` for one upgrade cycle in case of corruption.

use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

const KEYRING_SERVICE: &str = "com.zacoderp.pos";
const KEYRING_ACCOUNT_DB_KEY: &str = "db-key-v1";

pub fn db_path() -> PathBuf {
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    std::fs::create_dir_all(&p).ok();
    p.push("pos.db");
    p
}

/// Fetch (or lazily generate + persist) the 64-char hex SQLCipher key.
/// 32 random bytes from the OS CSPRNG, hex-encoded for use with the raw
/// `PRAGMA key = "x'…'"` form (skips PBKDF2 — the key is already
/// full-entropy random).
fn db_key() -> Result<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_DB_KEY)
        .context("create keyring entry for db key")?;
    match entry.get_password() {
        Ok(k) if k.len() == 64 && k.chars().all(|c| c.is_ascii_hexdigit()) => Ok(k),
        Ok(_) => Err(anyhow!("stored db key has unexpected shape")),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            getrandom::getrandom(&mut bytes).context("generate random db key")?;
            let key = hex::encode(bytes);
            entry
                .set_password(&key)
                .context("persist db key into OS keyring")?;
            log::info!("Generated and stored a new SQLCipher key in OS keyring.");
            Ok(key)
        }
        Err(e) => Err(e).context("read db key from OS keyring"),
    }
}

/// Apply `PRAGMA key` (must be the FIRST statement on the connection,
/// before any other access — otherwise SQLCipher rejects further pragmas
/// with "file is not a database").
fn apply_key(conn: &Connection, hex_key: &str) -> Result<()> {
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
    Ok(())
}

/// Returns true iff the file at `path` is a *plain* (unencrypted) SQLite
/// DB — i.e. its sqlite_master is readable without supplying a key.
/// A SQLCipher-encrypted DB will fail this probe ("file is not a database").
fn is_plain_sqlite(path: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
        .is_ok()
}

/// One-shot migration: re-encrypt an existing plain DB in place.
/// No-op when the DB is already encrypted (or doesn't exist).
fn migrate_plain_to_encrypted(path: &Path, hex_key: &str) -> Result<()> {
    if !path.exists() || !is_plain_sqlite(path) {
        return Ok(());
    }
    log::warn!(
        "Detected unencrypted POS DB at {:?} — migrating to SQLCipher.",
        path
    );

    let tmp = path.with_extension("encrypting");
    let _ = std::fs::remove_file(&tmp);

    let conn = Connection::open(path).context("open plain DB for migration")?;
    // ATTACH a fresh encrypted sibling, export everything into it, detach.
    conn.execute(
        &format!(
            "ATTACH DATABASE ?1 AS encrypted KEY \"x'{}'\"",
            hex_key
        ),
        [tmp.to_string_lossy().as_ref()],
    )
    .context("attach encrypted target for migration")?;
    conn.query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))
        .context("sqlcipher_export into encrypted target")?;
    conn.execute("DETACH DATABASE encrypted", [])
        .context("detach encrypted target")?;
    drop(conn);

    // Swap atomically: keep the plain copy as a one-cycle safety net.
    let backup = path.with_extension("plain.bak");
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(path, &backup).context("backup plain DB")?;
    std::fs::rename(&tmp, path).context("promote encrypted DB into place")?;

    // Best-effort: drop the WAL/SHM siblings of the plain DB — they were
    // produced by the old unencrypted engine and would confuse SQLCipher.
    for ext in ["db-wal", "db-shm"] {
        let mut sibling = path.to_path_buf();
        sibling.set_extension(ext);
        let _ = std::fs::remove_file(sibling);
    }

    log::info!(
        "Migration complete. Plain backup retained at {:?} — delete after verifying the upgrade.",
        backup
    );
    Ok(())
}

pub fn open() -> Result<Connection> {
    let path = db_path();
    let key = db_key()?;
    migrate_plain_to_encrypted(&path, &key)?;
    let conn = Connection::open(&path)?;
    apply_key(&conn, &key)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
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

        -- Parked carts (Task #175) — in-progress sales the cashier set aside.
        -- Scoped to a pos_session_id so logging out / closing the shift purges
        -- the previous cashier's carts (handled by parked_carts_clear_session).
        -- NEVER pushed to the cloud — the cloud is the source of truth for
        -- FINALIZED invoices; this table is scratchpad-only.
        CREATE TABLE IF NOT EXISTS parked_carts (
            id              TEXT PRIMARY KEY,
            pos_session_id  INTEGER NOT NULL,
            label           TEXT NOT NULL,
            customer_note   TEXT,
            cart_json       TEXT NOT NULL,
            grand_total     REAL NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_parked_session ON parked_carts(pos_session_id, updated_at DESC);
        "#,
    )?;
    // Migration: add synced_at column on DBs from earlier builds.
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);
    Ok(())
}
