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
    conn.pragma_update(None, "foreign_keys", "ON")?;
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

        -- ── Accounting & Operations (Task #207) ──────────────────────
        -- Standalone-only: cloud mode is unaffected. Tables live next to
        -- the existing local catalog. Each entity that affects accounts
        -- has a generated journal entry linked via *_je_id.

        -- Chart of accounts. Seeded on first run with a minimal default
        -- tree (assets/liab/equity/revenue/expenses). Type drives DR/CR
        -- conventions and report grouping. Parent_id supports tree.
        CREATE TABLE IF NOT EXISTS accounts_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT NOT NULL UNIQUE,
            name_ar     TEXT NOT NULL,
            name_en     TEXT,
            type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
            parent_id   INTEGER REFERENCES accounts_local(id),
            is_leaf     INTEGER NOT NULL DEFAULT 1,
            balance     REAL NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts_local(parent_id);

        -- Suppliers (الموردين). AR balance posted via JE on purchase/return/payment.
        CREATE TABLE IF NOT EXISTS suppliers_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT UNIQUE,
            name_ar     TEXT NOT NULL,
            name_en     TEXT,
            phone       TEXT,
            vat_number  TEXT,
            balance     REAL NOT NULL DEFAULT 0,
            ap_account_id INTEGER REFERENCES accounts_local(id),
            notes       TEXT,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Cash boxes (الخزن).
        CREATE TABLE IF NOT EXISTS cash_boxes_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            balance     REAL NOT NULL DEFAULT 0,
            account_id  INTEGER REFERENCES accounts_local(id),
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Bank accounts (البنوك).
        CREATE TABLE IF NOT EXISTS banks_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            account_no  TEXT,
            balance     REAL NOT NULL DEFAULT 0,
            account_id  INTEGER REFERENCES accounts_local(id),
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Journal entries header (القيود اليومية).
        CREATE TABLE IF NOT EXISTS journal_entries_local (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_no      TEXT NOT NULL UNIQUE,
            entry_date    TEXT NOT NULL,
            description   TEXT,
            total_debit   REAL NOT NULL DEFAULT 0,
            total_credit  REAL NOT NULL DEFAULT 0,
            source_type   TEXT,
            source_id     INTEGER,
            created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries_local(entry_date DESC);

        CREATE TABLE IF NOT EXISTS journal_entry_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id    INTEGER NOT NULL REFERENCES journal_entries_local(id) ON DELETE CASCADE,
            account_id  INTEGER NOT NULL REFERENCES accounts_local(id),
            debit       REAL NOT NULL DEFAULT 0,
            credit      REAL NOT NULL DEFAULT 0,
            description TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_je_lines_entry ON journal_entry_lines_local(entry_id);
        CREATE INDEX IF NOT EXISTS idx_je_lines_account ON journal_entry_lines_local(account_id);

        -- Purchase invoices.
        CREATE TABLE IF NOT EXISTS purchases_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no      TEXT NOT NULL UNIQUE,
            supplier_id     INTEGER NOT NULL REFERENCES suppliers_local(id),
            invoice_date    TEXT NOT NULL,
            subtotal        REAL NOT NULL DEFAULT 0,
            vat_total       REAL NOT NULL DEFAULT 0,
            grand_total     REAL NOT NULL DEFAULT 0,
            payment_method  TEXT NOT NULL CHECK (payment_method IN ('credit','cash','bank')),
            cash_box_id     INTEGER REFERENCES cash_boxes_local(id),
            bank_id         INTEGER REFERENCES banks_local(id),
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases_local(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases_local(invoice_date DESC);

        CREATE TABLE IF NOT EXISTS purchase_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            purchase_id INTEGER NOT NULL REFERENCES purchases_local(id) ON DELETE CASCADE,
            item_id     INTEGER NOT NULL REFERENCES items_local(id),
            qty         REAL NOT NULL,
            unit_cost   REAL NOT NULL,
            vat_rate    REAL NOT NULL DEFAULT 15,
            line_total  REAL NOT NULL
        );

        -- Purchase returns (مرتجع المشتريات).
        CREATE TABLE IF NOT EXISTS purchase_returns_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            return_no       TEXT NOT NULL UNIQUE,
            supplier_id     INTEGER NOT NULL REFERENCES suppliers_local(id),
            purchase_id     INTEGER REFERENCES purchases_local(id),
            return_date     TEXT NOT NULL,
            subtotal        REAL NOT NULL DEFAULT 0,
            vat_total       REAL NOT NULL DEFAULT 0,
            grand_total     REAL NOT NULL DEFAULT 0,
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pret_supplier ON purchase_returns_local(supplier_id);

        CREATE TABLE IF NOT EXISTS purchase_return_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            return_id   INTEGER NOT NULL REFERENCES purchase_returns_local(id) ON DELETE CASCADE,
            item_id     INTEGER NOT NULL REFERENCES items_local(id),
            qty         REAL NOT NULL,
            unit_cost   REAL NOT NULL,
            vat_rate    REAL NOT NULL DEFAULT 15,
            line_total  REAL NOT NULL
        );

        -- Financial transactions (المعاملات المالية): receipts & payments.
        --   tx_type 'receipt'  → DR cash/bank, CR customer/revenue
        --   tx_type 'payment'  → DR supplier/expense, CR cash/bank
        CREATE TABLE IF NOT EXISTS financial_transactions_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tx_no       TEXT NOT NULL UNIQUE,
            tx_date     TEXT NOT NULL,
            tx_type     TEXT NOT NULL CHECK (tx_type IN ('receipt','payment')),
            party_type  TEXT CHECK (party_type IN ('customer','supplier','none')),
            party_id    INTEGER,
            cash_box_id INTEGER REFERENCES cash_boxes_local(id),
            bank_id     INTEGER REFERENCES banks_local(id),
            counter_account_id INTEGER REFERENCES accounts_local(id),
            amount      REAL NOT NULL,
            description TEXT,
            je_id       INTEGER REFERENCES journal_entries_local(id),
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_fintx_date ON financial_transactions_local(tx_date DESC);

        -- Per-user screen permissions (overrides on top of role defaults).
        -- A row means "user_id has explicit can_view for screen_key".
        -- Absence → fall back to role default.
        CREATE TABLE IF NOT EXISTS user_permissions_local (
            user_id     TEXT NOT NULL,
            screen_key  TEXT NOT NULL,
            can_view    INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (user_id, screen_key)
        );

        -- ── Inventory & Warehouses (Task #208) ───────────────────────
        -- Multi-warehouse model. Stock-on-hand is denormalised into
        -- stock_on_hand_local for O(1) lookups; the canonical history
        -- lives in stock_ledger_local (append-only journal). Every
        -- write that changes stock MUST insert a ledger row AND upsert
        -- the on-hand row inside the same transaction.

        CREATE TABLE IF NOT EXISTS warehouses_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            address     TEXT,
            is_default  INTEGER NOT NULL DEFAULT 0,
            is_active   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_on_hand_local (
            item_id      INTEGER NOT NULL REFERENCES items_local(id),
            warehouse_id INTEGER NOT NULL REFERENCES warehouses_local(id),
            qty          REAL NOT NULL DEFAULT 0,
            last_cost    REAL NOT NULL DEFAULT 0,
            updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (item_id, warehouse_id)
        );

        CREATE TABLE IF NOT EXISTS stock_ledger_local (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id      INTEGER NOT NULL REFERENCES items_local(id),
            warehouse_id INTEGER NOT NULL REFERENCES warehouses_local(id),
            qty_delta    REAL NOT NULL,
            unit_cost    REAL NOT NULL DEFAULT 0,
            balance_after REAL NOT NULL DEFAULT 0,
            ref_type     TEXT NOT NULL,
            ref_id       INTEGER,
            entry_date   TEXT NOT NULL,
            notes        TEXT,
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_item_wh ON stock_ledger_local(item_id, warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_date ON stock_ledger_local(entry_date DESC);
        CREATE INDEX IF NOT EXISTS idx_ledger_ref ON stock_ledger_local(ref_type, ref_id);

        CREATE TABLE IF NOT EXISTS stock_adjustments_local (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            adj_no        TEXT NOT NULL UNIQUE,
            adj_date      TEXT NOT NULL,
            warehouse_id  INTEGER NOT NULL REFERENCES warehouses_local(id),
            reason        TEXT,
            je_id         INTEGER REFERENCES journal_entries_local(id),
            created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_adjustment_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            adj_id      INTEGER NOT NULL REFERENCES stock_adjustments_local(id) ON DELETE CASCADE,
            item_id     INTEGER NOT NULL REFERENCES items_local(id),
            qty_diff    REAL NOT NULL,
            unit_cost   REAL NOT NULL DEFAULT 0,
            line_total  REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS stock_transfers_local (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_no       TEXT NOT NULL UNIQUE,
            transfer_date     TEXT NOT NULL,
            from_warehouse_id INTEGER NOT NULL REFERENCES warehouses_local(id),
            to_warehouse_id   INTEGER NOT NULL REFERENCES warehouses_local(id),
            notes             TEXT,
            created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_transfer_lines_local (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id  INTEGER NOT NULL REFERENCES stock_transfers_local(id) ON DELETE CASCADE,
            item_id      INTEGER NOT NULL REFERENCES items_local(id),
            qty          REAL NOT NULL,
            unit_cost    REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS stocktakes_local (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            stocktake_no  TEXT NOT NULL UNIQUE,
            stocktake_date TEXT NOT NULL,
            warehouse_id  INTEGER NOT NULL REFERENCES warehouses_local(id),
            status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
            adjustment_id INTEGER REFERENCES stock_adjustments_local(id),
            notes         TEXT,
            created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stocktake_lines_local (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            stocktake_id  INTEGER NOT NULL REFERENCES stocktakes_local(id) ON DELETE CASCADE,
            item_id       INTEGER NOT NULL REFERENCES items_local(id),
            system_qty    REAL NOT NULL DEFAULT 0,
            counted_qty   REAL NOT NULL DEFAULT 0,
            unit_cost     REAL NOT NULL DEFAULT 0
        );
        "#,
    )?;
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);

    // Seed default chart of accounts on first run (only when empty).
    seed_default_accounts(&conn)?;
    // Seed default warehouse + inventory-variance accounts on first run.
    seed_inventory_defaults(&conn)?;
    Ok(())
}

fn seed_inventory_defaults(conn: &Connection) -> Result<()> {
    use rusqlite::params;
    // Two extra accounts needed for stock adjustments (variance gain/loss).
    // Created idempotently — only inserted if missing.
    let extras: &[(&str, &str, &str, &str)] = &[
        ("1310", "فروقات جرد المخزون (ربح)", "revenue", "4000"),
        ("5300", "فروقات جرد المخزون (خسارة)", "expense", "5000"),
    ];
    for (code, name, typ, parent_code) in extras {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM accounts_local WHERE code=?1", params![code], |r| r.get(0),
        ).unwrap_or(0);
        if exists > 0 { continue; }
        let parent_id: Option<i64> = conn.query_row(
            "SELECT id FROM accounts_local WHERE code=?1", params![parent_code], |r| r.get(0),
        ).ok();
        let _ = conn.execute(
            "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,?3,?4,1)",
            params![code, name, typ, parent_id],
        );
    }
    // Seed a default warehouse if none exists.
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM warehouses_local", [], |r| r.get(0)).unwrap_or(0);
    if n == 0 {
        let _ = conn.execute(
            "INSERT INTO warehouses_local(code,name,is_default,is_active) VALUES('WH-01','المخزن الرئيسي',1,1)",
            [],
        );
    }
    Ok(())
}

fn seed_default_accounts(conn: &Connection) -> Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM accounts_local", [], |r| r.get(0))?;
    if n > 0 { return Ok(()); }

    // (code, name_ar, type, parent_code, is_leaf)
    let seed: &[(&str, &str, &str, Option<&str>, i64)] = &[
        ("1000", "الأصول",                "asset",     None,         0),
        ("1100", "الخزن",                 "asset",     Some("1000"), 0),
        ("1101", "الخزينة الرئيسية",      "asset",     Some("1100"), 1),
        ("1200", "البنوك",                "asset",     Some("1000"), 0),
        ("1300", "المخزون",               "asset",     Some("1000"), 1),
        ("1400", "ضريبة القيمة المضافة - مدخلات", "asset", Some("1000"), 1),
        ("1500", "العملاء (مدينون)",      "asset",     Some("1000"), 1),
        ("2000", "الخصوم",                "liability", None,         0),
        ("2100", "الموردون (دائنون)",     "liability", Some("2000"), 1),
        ("2200", "ضريبة القيمة المضافة - مخرجات", "liability", Some("2000"), 1),
        ("3000", "حقوق الملكية",          "equity",    None,         1),
        ("4000", "الإيرادات",             "revenue",   None,         0),
        ("4100", "إيرادات المبيعات",      "revenue",   Some("4000"), 1),
        ("5000", "المصروفات",             "expense",   None,         0),
        ("5100", "تكلفة البضاعة المباعة","expense",   Some("5000"), 1),
        ("5200", "مصروفات تشغيلية",       "expense",   Some("5000"), 1),
    ];

    use rusqlite::params;
    use std::collections::HashMap;
    let mut by_code: HashMap<String, i64> = HashMap::new();
    for (code, name, typ, parent_code, is_leaf) in seed {
        let parent_id: Option<i64> = parent_code.and_then(|c| by_code.get(c).copied());
        conn.execute(
            "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,?3,?4,?5)",
            params![code, name, typ, parent_id, is_leaf],
        )?;
        by_code.insert((*code).to_string(), conn.last_insert_rowid());
    }

    // Seed a default cash box backed by the main treasury account.
    if let Some(acc_id) = by_code.get("1101") {
        conn.execute(
            "INSERT INTO cash_boxes_local(name,balance,account_id) VALUES('الخزينة الرئيسية',0,?1)",
            params![acc_id],
        )?;
    }
    Ok(())
}
