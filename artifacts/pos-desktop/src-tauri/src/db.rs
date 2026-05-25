// Local SQLite database for offline POS operations.
//
// NOTE on encryption:
//   We previously used SQLCipher (`bundled-sqlcipher` feature) to encrypt
//   the file at rest with a per-device key kept in the OS keyring. That
//   pulled in an OpenSSL runtime DLL dependency that proved fragile to
//   bundle into the Windows MSI (libcrypto-3-x64.dll search-path issues).
//
//   For the v0.1.x line we ship plain SQLite. The DB still lives under
//   `%APPDATA%\com.zacoderp.pos\pos.db`, which Windows ACL-restricts to
//   the current user, and the device's JWT (the only true secret) is
//   kept in Windows Credential Manager via `keyring` (see main.rs).
//
//   Re-introducing at-rest encryption later is tracked as a follow-up:
//   options include shipping the OpenSSL DLLs via a WiX fragment, or
//   switching to a pure-Rust crypto backend (e.g. rusqlcipher-ng).

use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    // %APPDATA%\com.zacoderp.pos\pos.db on Windows.
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    std::fs::create_dir_all(&p).ok();
    p.push("pos.db");
    p
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path())?;
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
        "#,
    )?;
    // Migration: add synced_at column on DBs from earlier builds.
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);
    Ok(())
}
