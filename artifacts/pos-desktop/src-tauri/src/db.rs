// Local SQLite (SQLCipher-encrypted) database for offline POS operations.
// TODO Step 7: full migration set mirroring relevant cloud tables.

use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    // %APPDATA%\com.zacoderp.pos\pos.db
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    std::fs::create_dir_all(&p).ok();
    p.push("pos.db");
    p
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path())?;
    // SQLCipher key (TODO: derive from machine-bound secret in keyring)
    conn.pragma_update(None, "key", "REPLACE_AT_RUNTIME")?;
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
            sync_status     TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_offline_inv_status ON offline_invoices(sync_status);
        "#,
    )?;
    Ok(())
}
