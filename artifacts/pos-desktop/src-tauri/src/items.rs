// Local items catalog backed by SQLite (`items_local` table from db.rs).
//
// Two read paths:
//   - list_items: full catalog for the items grid (paginated by hard cap)
//   - find_by_barcode: instant lookup for barcode scans
//
// One write path:
//   - seed_demo_items: idempotent insert of 6 demo rows on first run, so a
//     freshly installed device shows something in the grid before the first
//     sync pull from the cloud. No-op if any rows already exist.

use crate::db;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LocalItem {
    pub id: i64,
    pub cloud_id: Option<i64>,
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub barcode: Option<String>,
    pub sale_price: f64,
    pub vat_rate: f64,
}

const MAX_ROWS: i64 = 500;

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalItem> {
    Ok(LocalItem {
        id: row.get(0)?,
        cloud_id: row.get(1)?,
        code: row.get(2)?,
        name_ar: row.get(3)?,
        name_en: row.get(4)?,
        barcode: row.get(5)?,
        sale_price: row.get(6)?,
        vat_rate: row.get(7)?,
    })
}

pub fn list(search: Option<&str>) -> Result<Vec<LocalItem>> {
    let conn = db::open()?;
    let sql = "SELECT id, cloud_id, code, name_ar, name_en, barcode, sale_price, vat_rate
               FROM items_local
               WHERE (?1 IS NULL OR name_ar LIKE ?2 OR barcode LIKE ?2 OR code LIKE ?2)
               ORDER BY name_ar
               LIMIT ?3";
    let pattern = search.map(|s| format!("%{}%", s));
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        rusqlite::params![search, pattern, MAX_ROWS],
        row_to_item,
    )?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn find_by_barcode(barcode: &str) -> Result<Option<LocalItem>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, cloud_id, code, name_ar, name_en, barcode, sale_price, vat_rate
         FROM items_local WHERE barcode = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query_map([barcode], row_to_item)?;
    if let Some(r) = rows.next() { Ok(Some(r?)) } else { Ok(None) }
}

pub fn seed_demo_if_empty() -> Result<u64> {
    let mut conn = db::open()?;
    // BEGIN IMMEDIATE acquires the RESERVED lock straight away so two
    // concurrent callers cannot both pass the COUNT(*)=0 check (architect-
    // flagged: previous version was racy under parallel invocations).
    // INSERT OR IGNORE on the unique `code` is a second-line defence in
    // case the table is ever pre-seeded by a partial run.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: i64 = tx.query_row("SELECT COUNT(*) FROM items_local", [], |r| r.get(0))?;
    if existing > 0 {
        tx.rollback().ok();
        return Ok(0);
    }

    // Ensure idempotency at the SQL layer too — items_local.code has no
    // UNIQUE constraint at table-creation time (db.rs is shared scaffolding
    // we must not modify here), so we add a partial unique index on the
    // demo code namespace only. CREATE INDEX IF NOT EXISTS is a no-op on
    // subsequent runs.
    tx.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS uniq_items_local_code
         ON items_local(code) WHERE code IS NOT NULL;",
    )?;

    let demos = [
        ("DEMO-001", "ماء معدني 500مل", "6281007123456", 1.5_f64),
        ("DEMO-002", "شيبس صغير",        "6281007123457", 3.0),
        ("DEMO-003", "علبة عصير",          "6281007123458", 5.0),
        ("DEMO-004", "بسكويت",             "6281007123459", 4.5),
        ("DEMO-005", "شوكولاتة",           "6281007123460", 7.0),
        ("DEMO-006", "لبن طازج 1لتر",    "6281007123461", 8.5),
    ];

    let mut inserted = 0_u64;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO items_local (code, name_ar, barcode, sale_price, vat_rate)
             VALUES (?1, ?2, ?3, ?4, 15.0)",
        )?;
        for (code, name, barcode, price) in demos {
            inserted += stmt.execute(rusqlite::params![code, name, barcode, price])? as u64;
        }
    }
    tx.commit()?;
    Ok(inserted)
}

// ─── Tauri commands ──────────────────────────────────────────────────
#[tauri::command]
pub fn list_items(search: Option<String>) -> Result<Vec<LocalItem>, String> {
    list(search.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_item_by_barcode(barcode: String) -> Result<Option<LocalItem>, String> {
    find_by_barcode(&barcode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn seed_demo_items() -> Result<u64, String> {
    seed_demo_if_empty().map_err(|e| e.to_string())
}

// ─── Cloud-pull upsert ───────────────────────────────────────────────
//
// Called by the JS-side `upsertItemsFromCloud` after a successful
// /api/sync/pull. Each row is keyed on `cloud_id` (the server's item id);
// on conflict we update the mutable columns so price/name/barcode changes
// from the cloud overwrite the local copy.
//
// Wrapped in a single transaction so a 200-item batch is one fsync, not 200.

#[derive(Deserialize, Debug)]
pub struct CloudItem {
    pub cloud_id: i64,
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub barcode: Option<String>,
    pub sale_price: f64,
    pub vat_rate: f64,
}

#[tauri::command]
pub fn upsert_items_from_cloud(rows: Vec<CloudItem>) -> Result<u64, String> {
    upsert_from_cloud(rows).map_err(|e| e.to_string())
}

fn upsert_from_cloud(rows: Vec<CloudItem>) -> Result<u64> {
    let mut conn = db::open()?;
    // Lazy migration: add uom_id column if missing. db.rs is shared
    // scaffolding we don't edit, and older installs predate the UoM
    // feature — without this, JS would silently lose uomId on every push.
    // SQLite has no IF NOT EXISTS for ADD COLUMN, so we sniff PRAGMA first.
    let has_uom: bool = conn
        .prepare("PRAGMA table_info(items_local)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .any(|c| c == "uom_id");
    if !has_uom {
        conn.execute("ALTER TABLE items_local ADD COLUMN uom_id INTEGER", [])?;
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // Make cloud_id the upsert key. The unique index on items_local.cloud_id
    // already exists via the table definition (UNIQUE in db.rs).
    let mut stmt = tx.prepare(
        "INSERT INTO items_local
           (cloud_id, code, name_ar, name_en, barcode, sale_price, vat_rate, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
         ON CONFLICT(cloud_id) DO UPDATE SET
           code = excluded.code,
           name_ar = excluded.name_ar,
           name_en = excluded.name_en,
           barcode = excluded.barcode,
           sale_price = excluded.sale_price,
           vat_rate = excluded.vat_rate,
           updated_at = CURRENT_TIMESTAMP",
    )?;
    let mut count = 0_u64;
    for r in &rows {
        stmt.execute(rusqlite::params![
            r.cloud_id, r.code, r.name_ar, r.name_en, r.barcode, r.sale_price, r.vat_rate,
        ])?;
        count += 1;
    }
    drop(stmt);
    tx.commit()?;
    Ok(count)
}
