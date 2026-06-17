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

        -- POS register payment methods (Task #4). User-managed; each maps to a
        -- GL account (cash/bank) or, for kind='credit', to receivables (1500).
        -- Drives the register's dynamic payment buttons + the debit leg of the
        -- POS sale journal entry posted by accounting::post_pos_invoice_je.
        CREATE TABLE IF NOT EXISTS pos_payment_methods_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name_ar     TEXT NOT NULL,
            kind        TEXT NOT NULL DEFAULT 'cash',
            account_id  INTEGER REFERENCES accounts_local(id),
            is_active   INTEGER NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0
        );

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

        -- Salespersons / sales reps (مندوبو المبيعات). Full master mirroring
        -- the web module: linked to back-office sales invoices via
        -- sales_invoices_local.sales_rep_id with an optional commission %.
        CREATE TABLE IF NOT EXISTS salespersons_local (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            code           TEXT UNIQUE,
            name_ar        TEXT NOT NULL,
            name_en        TEXT,
            phone          TEXT,
            email          TEXT,
            commission_pct REAL NOT NULL DEFAULT 0,
            is_active      INTEGER NOT NULL DEFAULT 1,
            notes          TEXT,
            created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

        -- Purchase orders (أوامر الشراء): NON-posting procurement documents.
        -- Lifecycle draft → confirmed → converted (spawns a purchase invoice) |
        -- cancelled. They NEVER touch stock or the GL on their own.
        CREATE TABLE IF NOT EXISTS purchase_orders_local (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no             TEXT NOT NULL UNIQUE,
            supplier_id          INTEGER NOT NULL REFERENCES suppliers_local(id),
            order_date           TEXT NOT NULL,
            expected_date        TEXT,
            payment_method       TEXT NOT NULL DEFAULT 'credit'
                                 CHECK (payment_method IN ('credit','cash','bank')),
            status               TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','confirmed','converted','cancelled')),
            converted_invoice_id INTEGER REFERENCES purchases_local(id),
            subtotal             REAL NOT NULL DEFAULT 0,
            vat_total            REAL NOT NULL DEFAULT 0,
            grand_total          REAL NOT NULL DEFAULT 0,
            notes                TEXT,
            branch_id            INTEGER,
            cost_center_id       INTEGER,
            warehouse_id         INTEGER,
            cash_box_id          INTEGER REFERENCES cash_boxes_local(id),
            bank_id              INTEGER REFERENCES banks_local(id),
            supplier_invoice_no  TEXT,
            created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders_local(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders_local(order_date DESC);

        CREATE TABLE IF NOT EXISTS purchase_order_lines_local (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id          INTEGER NOT NULL REFERENCES purchase_orders_local(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES items_local(id),
            qty               REAL NOT NULL,
            unit_cost         REAL NOT NULL,
            vat_rate          REAL NOT NULL DEFAULT 15,
            line_total        REAL NOT NULL,
            uom_id            INTEGER,
            uom_name          TEXT,
            conversion_factor REAL NOT NULL DEFAULT 1,
            warehouse_id      INTEGER
        );

        -- Goods receipts (سندات الاستلام): receive stock BEFORE the supplier
        -- invoice arrives. Posting books DR Inventory / CR Receiving-Clearing
        -- (11091) at goods cost (ex-VAT) and pushes stock IN. Converting to an
        -- invoice clears 11091 + claims input VAT against the supplier, WITHOUT
        -- re-receiving stock. Lifecycle draft → posted → converted.
        CREATE TABLE IF NOT EXISTS goods_receipts_local (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_no           TEXT NOT NULL UNIQUE,
            supplier_id          INTEGER NOT NULL REFERENCES suppliers_local(id),
            receipt_date         TEXT NOT NULL,
            supplier_invoice_no  TEXT,
            status               TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','posted','converted')),
            je_id                INTEGER REFERENCES journal_entries_local(id),
            converted_invoice_id INTEGER REFERENCES purchases_local(id),
            subtotal             REAL NOT NULL DEFAULT 0,
            vat_total            REAL NOT NULL DEFAULT 0,
            grand_total          REAL NOT NULL DEFAULT 0,
            notes                TEXT,
            branch_id            INTEGER,
            cost_center_id       INTEGER,
            warehouse_id         INTEGER,
            created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_grn_supplier ON goods_receipts_local(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_grn_date ON goods_receipts_local(receipt_date DESC);

        CREATE TABLE IF NOT EXISTS goods_receipt_lines_local (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id        INTEGER NOT NULL REFERENCES goods_receipts_local(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES items_local(id),
            qty               REAL NOT NULL,
            unit_cost         REAL NOT NULL,
            vat_rate          REAL NOT NULL DEFAULT 15,
            line_total        REAL NOT NULL,
            uom_id            INTEGER,
            uom_name          TEXT,
            conversion_factor REAL NOT NULL DEFAULT 1,
            warehouse_id      INTEGER,
            batch_no          TEXT,
            expiry_date       TEXT
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

        -- ── Supplier groups (مجموعات الموردين) ───────────────────────
        -- Classification + default discount % for suppliers. suppliers_local
        -- carries an optional group_id (added via ALTER below).
        CREATE TABLE IF NOT EXISTS supplier_groups_local (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            code             TEXT NOT NULL,
            name_ar          TEXT NOT NULL,
            name_en          TEXT,
            discount_percent REAL NOT NULL DEFAULT 0,
            notes            TEXT,
            is_active        INTEGER NOT NULL DEFAULT 1,
            created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_groups_code ON supplier_groups_local(code);

        -- ── Supplier settlements (تسوية الموردين / سند صرف للمورد) ────
        -- Outgoing settlement against a supplier's payable. Posting books
        -- DR supplier-payable / CR cash|bank. Lifecycle draft → posted.
        CREATE TABLE IF NOT EXISTS supplier_settlements_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_no          TEXT NOT NULL UNIQUE,
            settlement_date TEXT NOT NULL,
            supplier_id     INTEGER NOT NULL REFERENCES suppliers_local(id),
            payment_method  TEXT NOT NULL DEFAULT 'cash'
                            CHECK (payment_method IN ('cash','bank')),
            cash_box_id     INTEGER REFERENCES cash_boxes_local(id),
            bank_id         INTEGER REFERENCES banks_local(id),
            amount          REAL NOT NULL DEFAULT 0,
            currency_code   TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate   REAL NOT NULL DEFAULT 1,
            status          TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','posted')),
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            branch_id       INTEGER,
            cost_center_id  INTEGER,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_setl_supplier ON supplier_settlements_local(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_setl_date ON supplier_settlements_local(settlement_date DESC);

        -- ── Letters of credit (الاعتمادات المستندية) ─────────────────
        -- An LC is a bank-issued purchasing facility. total_amount is the
        -- face value in lc currency; used_amount accumulates the base-currency
        -- goods value drawn down by linked posted purchase invoices.
        -- settlement_account_id is the clearing/asset account a linked
        -- purchase invoice credits for its goods portion. Lifecycle
        -- open → partial → closed (auto by usage, or manual close/reopen).
        CREATE TABLE IF NOT EXISTS letters_of_credit_local (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            lc_number             TEXT NOT NULL UNIQUE,
            lc_date               TEXT NOT NULL,
            supplier_id           INTEGER NOT NULL REFERENCES suppliers_local(id),
            bank_name             TEXT,
            currency_code         TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate         REAL NOT NULL DEFAULT 1,
            total_amount          REAL NOT NULL DEFAULT 0,
            used_amount           REAL NOT NULL DEFAULT 0,
            settlement_account_id INTEGER REFERENCES accounts_local(id),
            status                TEXT NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','partial','closed')),
            notes                 TEXT,
            branch_id             INTEGER,
            cost_center_id        INTEGER,
            created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_lc_supplier ON letters_of_credit_local(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_lc_date ON letters_of_credit_local(lc_date DESC);

        CREATE TABLE IF NOT EXISTS lc_expenses_local (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            lc_id         INTEGER NOT NULL REFERENCES letters_of_credit_local(id) ON DELETE CASCADE,
            expense_type  TEXT NOT NULL,
            account_id    INTEGER REFERENCES accounts_local(id),
            amount        REAL NOT NULL DEFAULT 0,
            currency_code TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate REAL NOT NULL DEFAULT 1,
            notes         TEXT,
            created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_lcexp_lc ON lc_expenses_local(lc_id);

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

        -- ── Multi-currency (Task #209) ────────────────────────────────
        -- Currencies registry. is_base=1 marks the base currency (only one
        -- row may have it). All amounts on accounts_local are stored in
        -- base currency; transactional tables carry their native currency
        -- + exchange_rate to base so the JE can be posted in base currency.
        CREATE TABLE IF NOT EXISTS currencies_local (
            code        TEXT PRIMARY KEY,
            name_ar     TEXT NOT NULL,
            name_en     TEXT,
            symbol      TEXT,
            decimals    INTEGER NOT NULL DEFAULT 2,
            is_base     INTEGER NOT NULL DEFAULT 0,
            is_active   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Exchange rates history. rate_to_base = how many BASE units one
        -- unit of currency_code is worth on as_of_date. The "current"
        -- rate is the row with MAX(as_of_date) for that currency.
        CREATE TABLE IF NOT EXISTS currency_rates_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            currency_code   TEXT NOT NULL REFERENCES currencies_local(code),
            rate_to_base    REAL NOT NULL,
            as_of_date      TEXT NOT NULL,
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(currency_code, as_of_date)
        );
        CREATE INDEX IF NOT EXISTS idx_rates_code_date ON currency_rates_local(currency_code, as_of_date DESC);

        -- Treasury transfers between cash boxes / banks. Supports BOTH
        -- same-currency (amount_from == amount_to) and cross-currency
        -- (operator-entered exchange_rate, fx_diff -> fx_gain/fx_loss).
        CREATE TABLE IF NOT EXISTS treasury_transfers_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_no     TEXT NOT NULL UNIQUE,
            transfer_date   TEXT NOT NULL,
            from_kind       TEXT NOT NULL CHECK (from_kind IN ('cash','bank')),
            from_id         INTEGER NOT NULL,
            from_currency   TEXT NOT NULL,
            to_kind         TEXT NOT NULL CHECK (to_kind IN ('cash','bank')),
            to_id           INTEGER NOT NULL,
            to_currency     TEXT NOT NULL,
            amount_from     REAL NOT NULL,
            amount_to       REAL NOT NULL,
            exchange_rate   REAL NOT NULL DEFAULT 1,
            fx_diff         REAL NOT NULL DEFAULT 0,
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_treasury_date ON treasury_transfers_local(transfer_date DESC);

        -- ── Sales invoices & returns (back-office, full local accounting) ──
        -- Symmetric to purchases_local. These are NOT the POS offline_invoices
        -- (sync queue); they post local JEs + COGS + stock OUT and maintain the
        -- customer AR shadow balance, exactly mirroring the purchase subsystem.
        CREATE TABLE IF NOT EXISTS sales_invoices_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no      TEXT NOT NULL UNIQUE,
            customer_id     INTEGER REFERENCES customers_local(id),
            invoice_date    TEXT NOT NULL,
            subtotal        REAL NOT NULL DEFAULT 0,
            vat_total       REAL NOT NULL DEFAULT 0,
            grand_total     REAL NOT NULL DEFAULT 0,
            cogs_total      REAL NOT NULL DEFAULT 0,
            payment_method  TEXT NOT NULL CHECK (payment_method IN ('credit','cash','bank')),
            cash_box_id     INTEGER REFERENCES cash_boxes_local(id),
            bank_id         INTEGER REFERENCES banks_local(id),
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            currency_code   TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate   REAL NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales_invoices_local(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_invoices_local(invoice_date DESC);

        CREATE TABLE IF NOT EXISTS sales_invoice_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id  INTEGER NOT NULL REFERENCES sales_invoices_local(id) ON DELETE CASCADE,
            item_id     INTEGER NOT NULL REFERENCES items_local(id),
            qty         REAL NOT NULL,
            unit_price  REAL NOT NULL,
            unit_cost   REAL NOT NULL DEFAULT 0,
            vat_rate    REAL NOT NULL DEFAULT 15,
            line_total  REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sales_returns_local (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            return_no       TEXT NOT NULL UNIQUE,
            customer_id     INTEGER REFERENCES customers_local(id),
            invoice_id      INTEGER REFERENCES sales_invoices_local(id),
            return_date     TEXT NOT NULL,
            subtotal        REAL NOT NULL DEFAULT 0,
            vat_total       REAL NOT NULL DEFAULT 0,
            grand_total     REAL NOT NULL DEFAULT 0,
            cogs_total      REAL NOT NULL DEFAULT 0,
            payment_method  TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('credit','cash','bank')),
            cash_box_id     INTEGER REFERENCES cash_boxes_local(id),
            bank_id         INTEGER REFERENCES banks_local(id),
            je_id           INTEGER REFERENCES journal_entries_local(id),
            notes           TEXT,
            currency_code   TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate   REAL NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sret_customer ON sales_returns_local(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sret_date ON sales_returns_local(return_date DESC);

        CREATE TABLE IF NOT EXISTS sales_return_lines_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            return_id   INTEGER NOT NULL REFERENCES sales_returns_local(id) ON DELETE CASCADE,
            item_id     INTEGER NOT NULL REFERENCES items_local(id),
            qty         REAL NOT NULL,
            unit_price  REAL NOT NULL,
            unit_cost   REAL NOT NULL DEFAULT 0,
            vat_rate    REAL NOT NULL DEFAULT 15,
            line_total  REAL NOT NULL
        );

        -- ── Quotations (عروض الأسعار) — purely non-financial documents ─────
        -- No journal entry, no stock movement. Header + lines mirror the sales
        -- invoice shape so a quotation can be converted into a sales invoice
        -- (which is what posts the JE + COGS + stock). `status` lifecycle:
        -- draft → sent → accepted/rejected → converted. `converted_invoice_id`
        -- links to the sales invoice produced by the conversion.
        CREATE TABLE IF NOT EXISTS quotations_local (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_no               TEXT NOT NULL UNIQUE,
            customer_id          INTEGER REFERENCES customers_local(id),
            quotation_date       TEXT NOT NULL,
            valid_until          TEXT,
            subtotal             REAL NOT NULL DEFAULT 0,
            vat_total            REAL NOT NULL DEFAULT 0,
            grand_total          REAL NOT NULL DEFAULT 0,
            notes                TEXT,
            status               TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','sent','accepted','rejected','converted')),
            converted_invoice_id INTEGER REFERENCES sales_invoices_local(id),
            warehouse_id         INTEGER REFERENCES warehouses_local(id),
            branch_id            INTEGER REFERENCES branches_local(id),
            cost_center_id       INTEGER REFERENCES cost_centers_local(id),
            sales_rep_id         INTEGER REFERENCES salespersons_local(id),
            commission_pct       REAL NOT NULL DEFAULT 0,
            invoice_type         TEXT,
            buyer_name           TEXT,
            buyer_vat            TEXT,
            buyer_address        TEXT,
            currency_code        TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate        REAL NOT NULL DEFAULT 1,
            created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_quot_customer ON quotations_local(customer_id);
        CREATE INDEX IF NOT EXISTS idx_quot_date ON quotations_local(quotation_date DESC);

        CREATE TABLE IF NOT EXISTS quotation_lines_local (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            quotation_id      INTEGER NOT NULL REFERENCES quotations_local(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES items_local(id),
            qty               REAL NOT NULL,
            unit_price        REAL NOT NULL,
            vat_rate          REAL NOT NULL DEFAULT 15,
            line_total        REAL NOT NULL,
            uom_id            INTEGER,
            uom_name          TEXT,
            conversion_factor REAL NOT NULL DEFAULT 1,
            free_qty          REAL NOT NULL DEFAULT 0,
            note              TEXT,
            warehouse_id      INTEGER
        );

        -- ── Sales Orders (أوامر البيع) — purely non-financial documents ───
        -- Same idea as quotations but with a payment method captured up-front
        -- (carried into the invoice on conversion). `status` lifecycle:
        -- draft → confirmed → converted (or cancelled). Conversion requires
        -- the order to be 'confirmed'.
        CREATE TABLE IF NOT EXISTS sales_orders_local (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_no               TEXT NOT NULL UNIQUE,
            customer_id          INTEGER REFERENCES customers_local(id),
            order_date           TEXT NOT NULL,
            expected_delivery    TEXT,
            payment_method       TEXT NOT NULL DEFAULT 'credit'
                                 CHECK (payment_method IN ('credit','cash','bank')),
            cash_box_id          INTEGER REFERENCES cash_boxes_local(id),
            bank_id              INTEGER REFERENCES banks_local(id),
            subtotal             REAL NOT NULL DEFAULT 0,
            vat_total            REAL NOT NULL DEFAULT 0,
            grand_total          REAL NOT NULL DEFAULT 0,
            notes                TEXT,
            status               TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','confirmed','cancelled','converted')),
            converted_invoice_id INTEGER REFERENCES sales_invoices_local(id),
            warehouse_id         INTEGER REFERENCES warehouses_local(id),
            branch_id            INTEGER REFERENCES branches_local(id),
            cost_center_id       INTEGER REFERENCES cost_centers_local(id),
            sales_rep_id         INTEGER REFERENCES salespersons_local(id),
            commission_pct       REAL NOT NULL DEFAULT 0,
            invoice_type         TEXT,
            buyer_name           TEXT,
            buyer_vat            TEXT,
            buyer_address        TEXT,
            currency_code        TEXT NOT NULL DEFAULT 'SAR',
            exchange_rate        REAL NOT NULL DEFAULT 1,
            created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sord_customer ON sales_orders_local(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sord_date ON sales_orders_local(order_date DESC);

        CREATE TABLE IF NOT EXISTS sales_order_lines_local (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id          INTEGER NOT NULL REFERENCES sales_orders_local(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES items_local(id),
            qty               REAL NOT NULL,
            unit_price        REAL NOT NULL,
            vat_rate          REAL NOT NULL DEFAULT 15,
            line_total        REAL NOT NULL,
            uom_id            INTEGER,
            uom_name          TEXT,
            conversion_factor REAL NOT NULL DEFAULT 1,
            free_qty          REAL NOT NULL DEFAULT 0,
            note              TEXT,
            warehouse_id      INTEGER
        );

        -- ── Accounting dimensions: branches & cost centers ───────────────
        -- Both are optional analytic tags attached to journal entries (and
        -- the documents that generate them). They let the financial reports
        -- be filtered by branch (الفرع) and cost center (مركز التكلفة),
        -- mirroring the web app. cost_centers_local is a tree (parent_id);
        -- only is_posting=1 (leaf) centers may be selected on documents.
        CREATE TABLE IF NOT EXISTS branches_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT NOT NULL UNIQUE,
            name_ar     TEXT NOT NULL,
            name_en     TEXT,
            is_active   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS cost_centers_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT NOT NULL UNIQUE,
            name_ar     TEXT NOT NULL,
            name_en     TEXT,
            parent_id   INTEGER REFERENCES cost_centers_local(id),
            is_posting  INTEGER NOT NULL DEFAULT 1,
            is_active   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cost_centers_parent ON cost_centers_local(parent_id);

        -- Tax definitions (الضرائب) — dynamic master list. Each tax has its
        -- own GL account (account_id) + rate. rate_type 'percent' applies a
        -- percentage of the base; 'value' is a fixed amount (master-data only,
        -- not auto-applied to the percentage-based invoice/JE engines yet).
        -- Per-direction *_enabled gates which invoice types may pick the tax;
        -- *_nature ('debit'|'credit') is the side the tax account takes for
        -- that direction. Exactly one row may have is_default=1.
        CREATE TABLE IF NOT EXISTS taxes_local (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            code                     TEXT NOT NULL UNIQUE,
            name_ar                  TEXT NOT NULL,
            name_en                  TEXT,
            currency_code            TEXT,
            branch_id                INTEGER REFERENCES branches_local(id),
            rate_type                TEXT NOT NULL DEFAULT 'percent',
            rate_value               REAL NOT NULL DEFAULT 0,
            account_id               INTEGER REFERENCES accounts_local(id),
            sales_enabled            INTEGER NOT NULL DEFAULT 1,
            sales_nature             TEXT NOT NULL DEFAULT 'credit',
            sales_return_enabled     INTEGER NOT NULL DEFAULT 1,
            sales_return_nature      TEXT NOT NULL DEFAULT 'debit',
            purchase_enabled         INTEGER NOT NULL DEFAULT 1,
            purchase_nature          TEXT NOT NULL DEFAULT 'debit',
            purchase_return_enabled  INTEGER NOT NULL DEFAULT 1,
            purchase_return_nature   TEXT NOT NULL DEFAULT 'credit',
            is_default               INTEGER NOT NULL DEFAULT 0,
            is_active                INTEGER NOT NULL DEFAULT 1,
            created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_taxes_account ON taxes_local(account_id);

        -- ── Standalone ZATCA onboarding state (Task #233) ──
        -- Single-row (id=1) snapshot of the device's direct-to-ZATCA
        -- onboarding. The actual secrets (EGS private key + compliance /
        -- production CSID binary security tokens + API secrets) live in the
        -- OS keyring (see zatca.rs), NOT here. This table only holds the
        -- non-secret lifecycle state so the UI can resume an interrupted
        -- onboarding and show which environment is active.
        --   environment           — 'sandbox' | 'simulation' | 'production'
        --   status                — 'none' | 'csr' | 'compliance' | 'production'
        --   csr_pem               — the generated PKCS#10 CSR (public, re-issuable)
        --   org_json              — cached CSR params (CN/VAT/serial/address...)
        --   compliance_request_id — requestID returned by the compliance CSID call
        --   production_request_id — requestID returned by the production CSID call
        CREATE TABLE IF NOT EXISTS zatca_onboarding (
            id                     INTEGER PRIMARY KEY CHECK (id = 1),
            environment            TEXT NOT NULL DEFAULT 'sandbox',
            status                 TEXT NOT NULL DEFAULT 'none',
            csr_pem                TEXT,
            org_json               TEXT,
            compliance_request_id  TEXT,
            production_request_id  TEXT,
            last_error             TEXT,
            updated_at             TEXT
        );

        -- ── Per-invoice ZATCA submission status + PIH/ICV chain (Task #233) ──
        -- One row per locally-signed e-invoice. The chain is ordered by `icv`
        -- (Invoice Counter Value, strictly monotonic per device); `pih` is the
        -- Previous Invoice Hash (base64 sha256 of the prior signed XML, or the
        -- genesis hash for icv=1). `invoice_hash` is THIS invoice's base64
        -- hash, which becomes the next row's pih. status tracks the direct
        -- submission lifecycle so the offline queue can retry.
        --   status        — 'pending' | 'reported' | 'cleared' | 'rejected' | 'queued'
        --   invoice_type  — 'simplified' (reporting) | 'standard' (clearance)
        CREATE TABLE IF NOT EXISTS zatca_invoices (
            local_uuid     TEXT PRIMARY KEY,
            icv            INTEGER NOT NULL,
            pih            TEXT NOT NULL,
            invoice_hash   TEXT NOT NULL,
            invoice_no     TEXT,
            invoice_type   TEXT,
            signed_xml     TEXT,
            qr_base64      TEXT,
            status         TEXT NOT NULL DEFAULT 'pending',
            zatca_status   TEXT,
            warnings_json  TEXT,
            response_json  TEXT,
            submitted_at   TEXT,
            created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_zatca_inv_icv ON zatca_invoices(icv);
        CREATE INDEX IF NOT EXISTS idx_zatca_inv_status ON zatca_invoices(status);
        "#,
    )?;
    let _ = conn.execute("ALTER TABLE offline_invoices ADD COLUMN synced_at TEXT", []);

    // ── Idempotent column additions for multi-currency (Task #209) ──
    // SQLite has no `ADD COLUMN IF NOT EXISTS`, so duplicate-column errors
    // are silently ignored. All new columns default to 'SAR' / 1.0 so
    // existing rows keep their meaning post-upgrade.
    let alters: &[&str] = &[
        "ALTER TABLE cash_boxes_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE banks_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE suppliers_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE customers_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE items_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE purchases_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE purchases_local ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1",
        "ALTER TABLE purchase_returns_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE purchase_returns_local ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1",
        "ALTER TABLE journal_entries_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE journal_entries_local ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1",
        "ALTER TABLE financial_transactions_local ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'SAR'",
        "ALTER TABLE financial_transactions_local ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1",
        // Customer shadow balance (suppliers_local already has one). Positive =
        // customer owes us (AR debit nature). Maintained by opening balance +
        // financial transactions.
        "ALTER TABLE customers_local ADD COLUMN balance REAL NOT NULL DEFAULT 0",
        // Credit control. credit_limit = max outstanding AR allowed; when
        // enforce_credit_limit=1 a credit sale that would push the balance past
        // the limit is rejected. payment_terms_days = grace days before an
        // unpaid credit invoice counts as overdue (0 = no term check). These
        // are LOCAL settings — upsert_from_cloud never overwrites them.
        "ALTER TABLE customers_local ADD COLUMN credit_limit REAL NOT NULL DEFAULT 0",
        "ALTER TABLE customers_local ADD COLUMN enforce_credit_limit INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE customers_local ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 0",
        // ── Customer profile parity with web (Phase 1A) ──
        // CR number, email, full national address, geolocation, statement
        // participation flag, and default home branch. All locally-set; the
        // cloud Pull (upsert_customers_from_cloud) never overwrites them.
        "ALTER TABLE customers_local ADD COLUMN cr_number TEXT",
        "ALTER TABLE customers_local ADD COLUMN email TEXT",
        "ALTER TABLE customers_local ADD COLUMN city TEXT",
        "ALTER TABLE customers_local ADD COLUMN district TEXT",
        "ALTER TABLE customers_local ADD COLUMN street TEXT",
        "ALTER TABLE customers_local ADD COLUMN building_number TEXT",
        "ALTER TABLE customers_local ADD COLUMN postal_code TEXT",
        "ALTER TABLE customers_local ADD COLUMN country TEXT DEFAULT 'SA'",
        "ALTER TABLE customers_local ADD COLUMN national_address_short TEXT",
        "ALTER TABLE customers_local ADD COLUMN location_lat TEXT",
        "ALTER TABLE customers_local ADD COLUMN location_lng TEXT",
        "ALTER TABLE customers_local ADD COLUMN location_link TEXT",
        "ALTER TABLE customers_local ADD COLUMN include_in_statements INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE customers_local ADD COLUMN branch_id INTEGER",
        // ── Supplier profile parity with web (Phase W2) ──
        // CR number, email, full national address, and statement-participation
        // flag mirroring the customer columns. ap_account_id already exists.
        // All locally-set; the cloud Pull never overwrites them.
        "ALTER TABLE suppliers_local ADD COLUMN email TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN cr_number TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN city TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN district TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN street TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN building_number TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN postal_code TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN country TEXT DEFAULT 'SA'",
        "ALTER TABLE suppliers_local ADD COLUMN national_address_short TEXT",
        "ALTER TABLE suppliers_local ADD COLUMN include_in_statements INTEGER NOT NULL DEFAULT 1",
        // ── Purchase invoice header parity (Phase W2) ──
        // supplier_invoice_no = the supplier's OWN document number (reference).
        // The header warehouse is persisted so the edit form can prefill it and
        // reversal can restore stock to the right warehouse (also stored per
        // line for an exact, warehouse-correct unwind).
        "ALTER TABLE purchases_local ADD COLUMN supplier_invoice_no TEXT",
        "ALTER TABLE purchases_local ADD COLUMN warehouse_id INTEGER",
        "ALTER TABLE purchase_lines_local ADD COLUMN warehouse_id INTEGER",
        // Line-level unit of measure (الوحدة). uom_id/uom_name are the selected
        // unit; conversion_factor converts the line qty into BASE units for the
        // stock ledger & COGS (e.g. carton=12 → factor 12). Financial totals stay
        // qty × unit_price (price is per selected unit). Defaults keep old rows as
        // 1-to-1 base-unit lines. Local-only — never overwritten by cloud sync.
        "ALTER TABLE purchase_lines_local ADD COLUMN uom_id INTEGER",
        "ALTER TABLE purchase_lines_local ADD COLUMN uom_name TEXT",
        "ALTER TABLE purchase_lines_local ADD COLUMN conversion_factor REAL NOT NULL DEFAULT 1",
        "ALTER TABLE purchase_return_lines_local ADD COLUMN uom_id INTEGER",
        "ALTER TABLE purchase_return_lines_local ADD COLUMN uom_name TEXT",
        "ALTER TABLE purchase_return_lines_local ADD COLUMN conversion_factor REAL NOT NULL DEFAULT 1",
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN uom_id INTEGER",
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN uom_name TEXT",
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN conversion_factor REAL NOT NULL DEFAULT 1",
        "ALTER TABLE sales_return_lines_local ADD COLUMN uom_id INTEGER",
        "ALTER TABLE sales_return_lines_local ADD COLUMN uom_name TEXT",
        "ALTER TABLE sales_return_lines_local ADD COLUMN conversion_factor REAL NOT NULL DEFAULT 1",
        // Free (bonus) qty on a return line — mirrors the invoice-line column so
        // the Free-Quantities report can net returned free qty against sold free
        // qty. Nullable→0; no return UI sets it yet, so existing rows stay 0.
        "ALTER TABLE sales_return_lines_local ADD COLUMN free_qty REAL NOT NULL DEFAULT 0",
        // ── Accounting dimensions (branch + cost center) ──
        // Optional analytic tags on the JE header (and the documents that
        // generate it) so the financial reports can be filtered by branch
        // and cost center. cost_center_id is also stored on every JE line
        // (propagated from the header) so line-level report queries can
        // filter without a header join. All nullable — old rows = untagged.
        "ALTER TABLE journal_entries_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE journal_entries_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE journal_entry_lines_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE sales_invoices_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE sales_invoices_local ADD COLUMN cost_center_id INTEGER",
        // ── ZATCA bridge: link a back-office sales invoice to the cached QR
        // and to the offline_invoices sync row (local_uuid) that carries it to
        // the cloud for ZATCA reporting/clearance. Both nullable — only set for
        // SA invoices that went through the bridge; non-SA rows stay untagged.
        "ALTER TABLE sales_invoices_local ADD COLUMN zatca_qr_base64 TEXT",
        "ALTER TABLE sales_invoices_local ADD COLUMN zatca_offline_uuid TEXT",
        "ALTER TABLE sales_returns_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE sales_returns_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE purchases_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE purchases_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE purchase_returns_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE purchase_returns_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE purchase_returns_local ADD COLUMN reason TEXT",
        "ALTER TABLE purchases_local ADD COLUMN source_goods_receipt_id INTEGER",
        // ── W4: supplier groups + letters of credit links ──
        // group_id classifies a supplier (soft ref to supplier_groups_local);
        // lc_id links a purchase invoice to a letter of credit so posting can
        // clear the LC settlement account + draw down used_amount. Both
        // nullable — existing rows stay unclassified / non-LC.
        "ALTER TABLE suppliers_local ADD COLUMN group_id INTEGER",
        "ALTER TABLE purchases_local ADD COLUMN lc_id INTEGER",
        "ALTER TABLE financial_transactions_local ADD COLUMN branch_id INTEGER",
        "ALTER TABLE financial_transactions_local ADD COLUMN cost_center_id INTEGER",
        // ── Manual journal-entry parity with the web app ──
        // entry_type mirrors the web entry kinds (general / opening / closing /
        // adjustment / depreciation). status is the draft↔posted lifecycle: a
        // 'draft' JE has NO balance impact and is excluded from every financial
        // report; a 'posted' JE is applied to account balances and reports.
        // Every existing row (system-generated documents + previously-saved
        // manual entries) already moved balances, so both columns default to
        // values that preserve current behaviour ('general' / 'posted').
        "ALTER TABLE journal_entries_local ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'general'",
        "ALTER TABLE journal_entries_local ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'",
        // ── Fiscal-period link (الفترات المحاسبية) ──
        // Closing entries (close-pl / transfer-profit) are tagged with the
        // period they belong to so hard-close can verify the closing cycle ran.
        // Nullable — ordinary entries are matched to a period by date range.
        "ALTER TABLE journal_entries_local ADD COLUMN period_id INTEGER",
        // ── Chart-of-accounts parity with the web app ──
        // Extra metadata mirroring the web COA form. All nullable / defaulted
        // so existing seeded + user accounts keep working untouched:
        //   cost_center_id  — optional analytic tag (soft ref to cost_centers_local)
        //   report_direction — manual override of the auto-by-type financial
        //                      report bucket ('balance_sheet' | 'income_statement');
        //                      NULL = derive from account type.
        //   level           — tree depth hint (informational; default 1)
        //   notes           — free text
        //   is_active       — soft enable/disable (1 = active, default)
        "ALTER TABLE accounts_local ADD COLUMN cost_center_id INTEGER",
        "ALTER TABLE accounts_local ADD COLUMN report_direction TEXT",
        "ALTER TABLE accounts_local ADD COLUMN level INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE accounts_local ADD COLUMN notes TEXT",
        "ALTER TABLE accounts_local ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
        // ── Back-office sales invoice parity with the web app (T1B) ──
        // Header: salesperson link + commission snapshot, ZATCA document type
        // (standard B2B vs simplified B2C) and a frozen buyer snapshot so the
        // invoice keeps what was billed even if the customer record changes.
        "ALTER TABLE sales_invoices_local ADD COLUMN sales_rep_id INTEGER",
        "ALTER TABLE sales_invoices_local ADD COLUMN commission_pct REAL NOT NULL DEFAULT 0",
        "ALTER TABLE sales_invoices_local ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'simplified'",
        "ALTER TABLE sales_invoices_local ADD COLUMN buyer_name TEXT",
        "ALTER TABLE sales_invoices_local ADD COLUMN buyer_vat TEXT",
        "ALTER TABLE sales_invoices_local ADD COLUMN buyer_address TEXT",
        // Lines: free (bonus) qty — no revenue/VAT but still consumes stock &
        // COGS; an optional per-line note; and a per-line warehouse override
        // (NULL → falls back to the header/default warehouse).
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN free_qty REAL NOT NULL DEFAULT 0",
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN note TEXT",
        "ALTER TABLE sales_invoice_lines_local ADD COLUMN warehouse_id INTEGER",
        // Posting lock: a back-office invoice is created 'posted' (full impact
        // applied). فك الترحيل flips it to 'draft' (impact reversed, lines kept)
        // so it can be edited/deleted; ترحيل re-applies impact. Pre-existing
        // rows default to 'posted', matching their already-applied impact.
        "ALTER TABLE sales_invoices_local ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'",
        "ALTER TABLE purchases_local ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'",
        // Voucher → document link (سند تحصيل/صرف applied against a specific
        // invoice) so the invoice list can show a paid-amount per row.
        "ALTER TABLE financial_transactions_local ADD COLUMN applied_doc_type TEXT",
        "ALTER TABLE financial_transactions_local ADD COLUMN applied_doc_id INTEGER",
    ];
    for sql in alters { let _ = conn.execute(sql, []); }

    // Seed a default branch on first run so documents have something to
    // tag against out of the box (idempotent — user edits never clobbered).
    let _ = conn.execute(
        "INSERT OR IGNORE INTO branches_local(code,name_ar,is_active) VALUES('MAIN','الفرع الرئيسي',1)",
        [],
    );

    // ── Document numbering series (full operator control) ──
    // One row per document type. `next_number` is the value the NEXT issued
    // document will use; it is consumed+incremented atomically inside the
    // create transaction. Seeded once via INSERT OR IGNORE so user edits made
    // from the "أرقام المسلسلات" screen are never clobbered on later startups.
    // Seed value = MAX(id)+1 of each table so numbering continues from any
    // documents created before this feature existed (no UNIQUE collisions).
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS number_series_local (
            doc_type    TEXT PRIMARY KEY,
            prefix      TEXT NOT NULL DEFAULT '',
            next_number INTEGER NOT NULL DEFAULT 1,
            padding     INTEGER NOT NULL DEFAULT 6
        );

        -- Fiscal years (السنوات المالية) + periods (الفترات المحاسبية).
        -- status lifecycle mirrors the web app:
        --   open               — postable
        --   closed             — soft close (reversible from the wizard)
        --   permanently_closed — hard close (irreversible; blocks posting)
        CREATE TABLE IF NOT EXISTS fiscal_years_local (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            start_date  TEXT NOT NULL,
            end_date    TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','closed','permanently_closed')),
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS fiscal_periods_local (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            fiscal_year_id INTEGER NOT NULL REFERENCES fiscal_years_local(id) ON DELETE CASCADE,
            name           TEXT NOT NULL,
            start_date     TEXT NOT NULL,
            end_date       TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','closed','permanently_closed')),
            created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_year ON fiscal_periods_local(fiscal_year_id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_dates ON fiscal_periods_local(start_date, end_date);
        "#,
    )?;
    let seeds: &[(&str, &str, &str)] = &[
        ("journal_entry",   "JE-",   "journal_entries_local"),
        ("purchase",        "PUR-",  "purchases_local"),
        ("purchase_return", "PRT-",  "purchase_returns_local"),
        ("purchase_order",  "PO-",   "purchase_orders_local"),
        ("goods_receipt",   "GRN-",  "goods_receipts_local"),
        ("sales_invoice",   "SINV-", "sales_invoices_local"),
        ("sales_return",    "SRT-",  "sales_returns_local"),
        ("quotation",       "QT-",   "quotations_local"),
        ("sales_order",     "SO-",   "sales_orders_local"),
        ("supplier_settlement", "SETL-", "supplier_settlements_local"),
        ("letter_of_credit",    "LC-",   "letters_of_credit_local"),
    ];
    for (doc_type, prefix, table) in seeds {
        let sql = format!(
            "INSERT OR IGNORE INTO number_series_local(doc_type,prefix,next_number,padding)
             SELECT '{doc_type}', '{prefix}', COALESCE(MAX(id),0)+1, 6 FROM {table}"
        );
        let _ = conn.execute(&sql, []);
    }

    // Seed default chart of accounts on first run (only when empty).
    seed_default_accounts(&conn)?;
    // Seed default warehouse + inventory-variance accounts on first run.
    seed_inventory_defaults(&conn)?;
    // Seed currencies + fx gain/loss accounts (idempotent).
    seed_currencies(&conn)?;
    // Seed default POS payment methods (cash + card) on first run.
    seed_pos_payment_methods(&conn)?;
    // Seed the current fiscal year + its 12 monthly periods on first run.
    seed_fiscal_year(&conn)?;
    // Seed default commercial master data (walk-in customer + supplier).
    seed_company_masters(&conn)?;
    // If a country was already chosen (e.g. cloud activation persisted it before
    // this open), base the accounting currency to match. No-op for SA, unknown
    // countries, or any DB that already has transactions.
    let chosen_country: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key='pos_desktop_country'",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(iso) = chosen_country {
        let _ = rebase_currency_for_country(&conn, &iso);
    }
    Ok(())
}

/// ISO-2 country → (currency code, name_ar, name_en, symbol, decimals).
/// Mirrors the Arab-state catalogue in `src/lib/currency.ts` so the offline DB
/// base currency matches the operator's chosen country.
fn currency_for_country(
    iso: &str,
) -> Option<(&'static str, &'static str, &'static str, &'static str, i64)> {
    let v = match iso.to_uppercase().as_str() {
        "SA" => ("SAR", "الريال السعودي", "Saudi Riyal", "ر.س", 2),
        "EG" => ("EGP", "الجنيه المصري", "Egyptian Pound", "ج.م", 2),
        "AE" => ("AED", "الدرهم الإماراتي", "UAE Dirham", "د.إ", 2),
        "KW" => ("KWD", "الدينار الكويتي", "Kuwaiti Dinar", "د.ك", 3),
        "QA" => ("QAR", "الريال القطري", "Qatari Riyal", "ر.ق", 2),
        "BH" => ("BHD", "الدينار البحريني", "Bahraini Dinar", "د.ب", 3),
        "OM" => ("OMR", "الريال العُماني", "Omani Rial", "ر.ع", 3),
        "JO" => ("JOD", "الدينار الأردني", "Jordanian Dinar", "د.أ", 3),
        "LB" => ("LBP", "الليرة اللبنانية", "Lebanese Pound", "ل.ل", 2),
        "IQ" => ("IQD", "الدينار العراقي", "Iraqi Dinar", "د.ع", 2),
        "YE" => ("YER", "الريال اليمني", "Yemeni Rial", "ر.ي", 2),
        "SY" => ("SYP", "الليرة السورية", "Syrian Pound", "ل.س", 2),
        "DZ" => ("DZD", "الدينار الجزائري", "Algerian Dinar", "د.ج", 2),
        "TN" => ("TND", "الدينار التونسي", "Tunisian Dinar", "د.ت", 3),
        "MA" => ("MAD", "الدرهم المغربي", "Moroccan Dirham", "د.م", 2),
        "LY" => ("LYD", "الدينار الليبي", "Libyan Dinar", "د.ل", 3),
        "SD" => ("SDG", "الجنيه السوداني", "Sudanese Pound", "ج.س", 2),
        "PS" => ("ILS", "الشيكل", "Israeli Shekel", "₪", 2),
        "MR" => ("MRU", "الأوقية الموريتانية", "Mauritanian Ouguiya", "أوقية", 2),
        "SO" => ("SOS", "الشلن الصومالي", "Somali Shilling", "ش.ص", 2),
        "DJ" => ("DJF", "الفرنك الجيبوتي", "Djiboutian Franc", "ف.ج", 2),
        "KM" => ("KMF", "الفرنك القمري", "Comorian Franc", "ف.ق", 2),
        _ => return None,
    };
    Some(v)
}

/// Re-base the offline accounting currency to the country's currency. Safe ONLY
/// on a fresh company with no journal entries or invoices yet — re-basing after
/// transactions exist would corrupt the books, so it is a no-op then. Also a
/// no-op when the country maps to the currency that is already the base.
pub fn rebase_currency_for_country(conn: &Connection, iso: &str) -> Result<()> {
    use rusqlite::params;
    let (code, name_ar, name_en, symbol, dec) = match currency_for_country(iso) {
        Some(v) => v,
        None => return Ok(()),
    };
    // Already the base? nothing to do.
    let already: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM currencies_local WHERE code=?1 AND is_base=1",
            params![code],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }
    // Guard: only re-base a pristine ledger.
    let je: i64 = conn
        .query_row("SELECT COUNT(*) FROM journal_entries_local", [], |r| r.get(0))
        .unwrap_or(0);
    let inv: i64 = conn
        .query_row("SELECT COUNT(*) FROM offline_invoices", [], |r| r.get(0))
        .unwrap_or(0);
    if je > 0 || inv > 0 {
        return Ok(());
    }
    // Ensure the target currency row exists before flipping the base flag.
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM currencies_local WHERE code=?1",
            params![code],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        let _ = conn.execute(
            "INSERT INTO currencies_local(code,name_ar,name_en,symbol,decimals,is_base,is_active) VALUES(?1,?2,?3,?4,?5,0,1)",
            params![code, name_ar, name_en, symbol, dec],
        );
    }
    conn.execute("UPDATE currencies_local SET is_base=0", [])?;
    conn.execute(
        "UPDATE currencies_local SET is_base=1, is_active=1 WHERE code=?1",
        params![code],
    )?;
    let today: String = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let _ = conn.execute(
        "INSERT OR IGNORE INTO currency_rates_local(currency_code,rate_to_base,as_of_date,notes) VALUES(?1,1.0,?2,'تلقائي — العملة الأساسية')",
        params![code, today],
    );
    Ok(())
}

fn seed_fiscal_year(conn: &Connection) -> Result<()> {
    use rusqlite::params;
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM fiscal_years_local", [], |r| r.get(0))
        .unwrap_or(0);
    if n > 0 {
        return Ok(());
    }
    let year: i32 = chrono::Utc::now()
        .format("%Y")
        .to_string()
        .parse()
        .unwrap_or(2025);
    conn.execute(
        "INSERT INTO fiscal_years_local(name,start_date,end_date,status) VALUES(?1,?2,?3,'open')",
        params![
            format!("السنة المالية {year}"),
            format!("{year}-01-01"),
            format!("{year}-12-31")
        ],
    )?;
    let fy_id = conn.last_insert_rowid();
    let months = [
        "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر",
        "أكتوبر", "نوفمبر", "ديسمبر",
    ];
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    for (i, mname) in months.iter().enumerate() {
        let m = (i + 1) as i32;
        let last_day = match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => {
                if leap {
                    29
                } else {
                    28
                }
            }
            _ => 30,
        };
        conn.execute(
            "INSERT INTO fiscal_periods_local(fiscal_year_id,name,start_date,end_date,status) VALUES(?1,?2,?3,?4,'open')",
            params![
                fy_id,
                format!("{mname} {year}"),
                format!("{year}-{m:02}-01"),
                format!("{year}-{m:02}-{last_day:02}")
            ],
        )?;
    }
    Ok(())
}

fn seed_company_masters(conn: &Connection) -> Result<()> {
    // Default walk-in customer (editable/deletable like any other).
    let nc: i64 = conn
        .query_row("SELECT COUNT(*) FROM customers_local", [], |r| r.get(0))
        .unwrap_or(0);
    if nc == 0 {
        let _ = conn.execute(
            "INSERT INTO customers_local(name_ar,name_en) VALUES('عميل نقدي','Cash Customer')",
            [],
        );
    }
    // Default supplier.
    let ns: i64 = conn
        .query_row("SELECT COUNT(*) FROM suppliers_local", [], |r| r.get(0))
        .unwrap_or(0);
    if ns == 0 {
        let _ = conn.execute(
            "INSERT INTO suppliers_local(code,name_ar,name_en) VALUES('SUP-001','مورد افتراضي','Default Supplier')",
            [],
        );
    }
    Ok(())
}

fn seed_pos_payment_methods(conn: &Connection) -> Result<()> {
    use rusqlite::params;
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM pos_payment_methods_local", [], |r| r.get(0))
        .unwrap_or(0);
    if n > 0 { return Ok(()); }
    // Cash → the seeded main treasury leaf (1101). Card starts UNLINKED so the
    // operator picks a bank/POS-clearing account in إعدادات حسابات نقاط البيع;
    // until then the JE falls back to the default cash account (never fails).
    let cash_acc: Option<i64> = conn
        .query_row("SELECT id FROM accounts_local WHERE code='1101'", [], |r| r.get(0))
        .ok();
    conn.execute(
        "INSERT INTO pos_payment_methods_local(name_ar,kind,account_id,is_active,sort_order) VALUES('نقداً','cash',?1,1,0)",
        params![cash_acc],
    )?;
    conn.execute(
        "INSERT INTO pos_payment_methods_local(name_ar,kind,account_id,is_active,sort_order) VALUES('بطاقة','bank',NULL,1,1)",
        [],
    )?;
    Ok(())
}

fn seed_currencies(conn: &Connection) -> Result<()> {
    use rusqlite::params;
    // Default currencies — SAR is the base, others can be activated/deactivated.
    let seed: &[(&str, &str, &str, &str, i64, i64)] = &[
        ("SAR", "الريال السعودي", "Saudi Riyal", "ر.س", 2, 1),
        ("USD", "الدولار الأمريكي", "US Dollar", "$",   2, 0),
        ("EUR", "اليورو",            "Euro",        "€",   2, 0),
        ("AED", "الدرهم الإماراتي",  "UAE Dirham",  "د.إ", 2, 0),
        ("EGP", "الجنيه المصري",     "Egyptian Pound","ج.م",2,0),
        ("KWD", "الدينار الكويتي",   "Kuwaiti Dinar","د.ك",3, 0),
    ];
    for (code, name_ar, name_en, symbol, dec, is_base) in seed {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM currencies_local WHERE code=?1",
            params![code], |r| r.get(0),
        ).unwrap_or(0);
        if exists > 0 { continue; }
        let _ = conn.execute(
            "INSERT INTO currencies_local(code,name_ar,name_en,symbol,decimals,is_base,is_active) VALUES(?1,?2,?3,?4,?5,?6,1)",
            params![code, name_ar, name_en, symbol, dec, is_base],
        );
        // Seed an initial rate row of 1.0 only for the base currency. Others
        // start without a rate so the operator MUST enter one before use.
        if *is_base == 1 {
            let today: String = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO currency_rates_local(currency_code,rate_to_base,as_of_date,notes) VALUES(?1,1.0,?2,'تلقائي — العملة الأساسية')",
                params![code, today],
            );
        }
    }
    // FX gain/loss accounts (idempotent).
    let fx: &[(&str, &str, &str, &str)] = &[
        ("4900", "أرباح فروقات العملة", "revenue", "4000"),
        ("5900", "خسائر فروقات العملة", "expense", "5000"),
    ];
    for (code, name, typ, parent_code) in fx {
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
        ("1201", "البنك الرئيسي",         "asset",     Some("1200"), 1),
        ("1300", "المخزون",               "asset",     Some("1000"), 1),
        ("11091","وسيط استلام البضاعة",   "asset",     Some("1000"), 1),
        ("1400", "ضريبة القيمة المضافة - مدخلات", "asset", Some("1000"), 1),
        ("1500", "العملاء (مدينون)",      "asset",     Some("1000"), 1),
        ("1102", "العهد والسلف",          "asset",     Some("1000"), 1),
        ("1103", "مصروفات مدفوعة مقدماً", "asset",     Some("1000"), 1),
        ("1600", "الأصول الثابتة",        "asset",     Some("1000"), 0),
        ("1610", "أراضٍ ومبانٍ",          "asset",     Some("1600"), 1),
        ("1620", "أثاث ومعدات",           "asset",     Some("1600"), 1),
        ("1630", "أجهزة وحاسبات",         "asset",     Some("1600"), 1),
        ("1640", "سيارات ووسائل نقل",     "asset",     Some("1600"), 1),
        ("1700", "مجمع إهلاك الأصول الثابتة","asset",  Some("1000"), 1),
        ("2000", "الخصوم",                "liability", None,         0),
        ("2100", "الموردون (دائنون)",     "liability", Some("2000"), 1),
        ("2200", "ضريبة القيمة المضافة - مخرجات", "liability", Some("2000"), 1),
        ("2105", "رواتب وأجور مستحقة",    "liability", Some("2000"), 1),
        ("2106", "الزكاة وضريبة الدخل مستحقة","liability",Some("2000"),1),
        ("2107", "مصروفات مستحقة",        "liability", Some("2000"), 1),
        ("2300", "قروض طويلة الأجل",      "liability", Some("2000"), 1),
        ("2310", "مخصص مكافأة نهاية الخدمة","liability",Some("2000"), 1),
        ("3000", "حقوق الملكية",          "equity",    None,         1),
        ("3100", "رأس المال المدفوع",     "equity",    Some("3000"), 1),
        ("3200", "الأرباح المُرحّلة",      "equity",    Some("3000"), 1),
        ("3300", "أرباح/خسائر العام الحالي","equity",  Some("3000"), 1),
        ("3400", "المسحوبات الشخصية",     "equity",    Some("3000"), 1),
        ("4000", "الإيرادات",             "revenue",   None,         0),
        ("4100", "إيرادات المبيعات",      "revenue",   Some("4000"), 1),
        ("4200", "إيرادات أخرى",          "revenue",   Some("4000"), 1),
        ("4300", "خصم مكتسب",             "revenue",   Some("4000"), 1),
        ("5000", "المصروفات",             "expense",   None,         0),
        ("5100", "تكلفة البضاعة المباعة","expense",   Some("5000"), 1),
        ("5200", "مصروفات تشغيلية",       "expense",   Some("5000"), 1),
        ("5400", "رواتب وأجور",           "expense",   Some("5000"), 1),
        ("5410", "إيجارات",               "expense",   Some("5000"), 1),
        ("5420", "كهرباء ومياه واتصالات", "expense",   Some("5000"), 1),
        ("5430", "مصروف الإهلاك",         "expense",   Some("5000"), 1),
        ("5440", "صيانة وإصلاحات",        "expense",   Some("5000"), 1),
        ("5450", "تسويق ودعاية",          "expense",   Some("5000"), 1),
        ("5460", "مصروفات ورسوم بنكية",   "expense",   Some("5000"), 1),
        ("5500", "خصم مسموح به",          "expense",   Some("5000"), 1),
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
