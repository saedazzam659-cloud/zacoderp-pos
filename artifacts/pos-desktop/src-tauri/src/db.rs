// Local SQLite database for offline POS operations.
//
// Storage: %APPDATA%\com.zacoderp.pos\pos.db (Windows). The directory is
// ACL-restricted to the current user. At-rest encryption (SQLCipher) was
// piloted in Task #176 but deferred — it required building OpenSSL from
// source on the Windows CI runner which proved unreliable. Re-enable in a
// future task once a stable Windows OpenSSL toolchain is in place.

use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    std::fs::create_dir_all(&p).ok();
    p.push("pos.db");
    p
}

pub fn open() -> Result<Connection> {
    let path = db_path();
    let conn = Connection::open(&path)?;
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

        -- Standalone install mode (Task #199): three tables that replace
        -- the localStorage-based standalone store. SQLCipher is deferred
        -- (see windows-openssl-trap memory) — for now we rely on the
        -- %APPDATA% ACLs that already protect pos.db.
        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_license (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            file_json   TEXT NOT NULL,
            installed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_users (
            id            TEXT PRIMARY KEY,
            username      TEXT NOT NULL UNIQUE,
            display_name  TEXT NOT NULL,
            role          TEXT NOT NULL CHECK (role IN ('admin','cashier')),
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            last_login_at TEXT
        );
        "#,
    )?;
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);
    Ok(())
}
