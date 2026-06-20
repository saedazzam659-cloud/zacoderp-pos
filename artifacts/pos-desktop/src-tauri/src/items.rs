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
    pub uom_id: Option<i64>,
    // Pharmacy vertical (Task #200) — all nullable, present only when the
    // store's vertical is "pharmacy". Generic catalog rows leave these NULL.
    pub active_ingredient: Option<String>,
    pub dosage_form: Option<String>,
    pub strength: Option<String>,
    pub manufacturer: Option<String>,
    pub requires_prescription: Option<bool>,
    pub controlled: Option<bool>,
    pub expiry_date: Option<String>, // ISO date 'YYYY-MM-DD'
    pub batch_no: Option<String>,
    // Scale (Task #201) — weighed items charged per-kg, optional 4–5 digit
    // PLU used by both manual look-up and embedded-weight barcode resolution.
    pub is_weighed: Option<bool>,
    pub price_per_kg: Option<f64>,
    pub plu: Option<String>,
}

const MAX_ROWS: i64 = 2000;

const SELECT_COLS: &str =
    "id, cloud_id, code, name_ar, name_en, barcode, sale_price, vat_rate, \
     active_ingredient, dosage_form, strength, manufacturer, requires_prescription, \
     controlled, expiry_date, batch_no, is_weighed, price_per_kg, plu, uom_id";

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
        active_ingredient: row.get(8).ok().flatten(),
        dosage_form: row.get(9).ok().flatten(),
        strength: row.get(10).ok().flatten(),
        manufacturer: row.get(11).ok().flatten(),
        requires_prescription: row.get::<_, Option<i64>>(12).ok().flatten().map(|v| v != 0),
        controlled: row.get::<_, Option<i64>>(13).ok().flatten().map(|v| v != 0),
        expiry_date: row.get(14).ok().flatten(),
        batch_no: row.get(15).ok().flatten(),
        is_weighed: row.get::<_, Option<i64>>(16).ok().flatten().map(|v| v != 0),
        price_per_kg: row.get(17).ok().flatten(),
        plu: row.get(18).ok().flatten(),
        uom_id: row.get(19).ok().flatten(),
    })
}

/// Lazy migration: ensure all the Task #200 + #199 columns exist on
/// `items_local`. `db.rs` is shared scaffolding we don't edit, so we
/// PRAGMA-sniff and ALTER as needed on every open. SQLite ALTER ADD COLUMN
/// is idempotent only via this sniff (there's no IF NOT EXISTS form).
fn ensure_schema(conn: &rusqlite::Connection) -> Result<()> {
    let existing: std::collections::HashSet<String> = conn
        .prepare("PRAGMA table_info(items_local)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .collect();
    let want: &[(&str, &str)] = &[
        ("uom_id", "INTEGER"),
        ("active_ingredient", "TEXT"),
        ("dosage_form", "TEXT"),
        ("strength", "TEXT"),
        ("manufacturer", "TEXT"),
        ("requires_prescription", "INTEGER"),
        ("controlled", "INTEGER"),
        ("expiry_date", "TEXT"),
        ("batch_no", "TEXT"),
        // Scale (Task #201)
        ("is_weighed", "INTEGER"),
        ("price_per_kg", "REAL"),
        ("plu", "TEXT"),
    ];
    for (col, ty) in want {
        if !existing.contains(*col) {
            conn.execute(&format!("ALTER TABLE items_local ADD COLUMN {col} {ty}"), [])?;
        }
    }
    // PLU uniqueness (Task #201 review round 3). A partial unique index
    // means duplicate PLUs raise a clear SQLITE_CONSTRAINT at write time
    // instead of letting `find_item_by_plu` silently resolve to whichever
    // row the planner returned first. NULL plus are exempt so generic
    // (non-weighed) catalog rows aren't accidentally roped in.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS items_local_plu_unique \
         ON items_local(plu) WHERE plu IS NOT NULL AND plu <> ''",
        [],
    )?;
    Ok(())
}

pub fn list(search: Option<&str>) -> Result<Vec<LocalItem>> {
    let conn = db::open()?;
    ensure_schema(&conn)?;
    let sql = format!(
        "SELECT {SELECT_COLS} FROM items_local
         WHERE (?1 IS NULL OR name_ar LIKE ?2 OR barcode LIKE ?2 OR code LIKE ?2
                OR active_ingredient LIKE ?2)
         ORDER BY name_ar
         LIMIT ?3"
    );
    let pattern = search.map(|s| format!("%{}%", s));
    let mut stmt = conn.prepare(&sql)?;
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
    ensure_schema(&conn)?;
    let sql = format!("SELECT {SELECT_COLS} FROM items_local WHERE barcode = ?1 LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([barcode], row_to_item)?;
    if let Some(r) = rows.next() { Ok(Some(r?)) } else { Ok(None) }
}

/// Items whose expiry_date is non-NULL and within the next `within_days`
/// days (or already expired, when `within_days >= 0`). Sorted soonest-first.
pub fn list_expiring(within_days: i64) -> Result<Vec<LocalItem>> {
    let conn = db::open()?;
    ensure_schema(&conn)?;
    let sql = format!(
        "SELECT {SELECT_COLS} FROM items_local
         WHERE expiry_date IS NOT NULL
           AND julianday(expiry_date) - julianday('now') <= ?1
         ORDER BY expiry_date ASC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![within_days, MAX_ROWS], row_to_item)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn seed_demo_if_empty() -> Result<u64> {
    let mut conn = db::open()?;
    // BEGIN IMMEDIATE acquires the RESERVED lock straight away so two
    // concurrent callers cannot both pass the checks below (architect-flagged:
    // a previous version was racy under parallel invocations).
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // Seed the demo catalog only ONCE per install. After the first run the
    // `demo_seeded` flag is set, so a deliberate "delete all items" by the
    // operator is respected — the demo rows must NOT resurrect on the next
    // Sales/Register screen mount. (The previous version reseeded whenever the
    // table was empty, which is exactly the delete-all case the user hit.)
    let seeded: i64 = tx.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = 'demo_seeded'",
        [],
        |r| r.get(0),
    )?;
    if seeded > 0 {
        tx.rollback().ok();
        return Ok(0);
    }
    // Claim the one-and-only seeding opportunity up-front, inside the same
    // IMMEDIATE tx, regardless of which branch we take below.
    tx.execute(
        "INSERT INTO app_settings(key, value) VALUES('demo_seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'",
        [],
    )?;
    let existing: i64 = tx.query_row("SELECT COUNT(*) FROM items_local", [], |r| r.get(0))?;
    if existing > 0 {
        // Upgrade path: the operator already has a catalog — just record that
        // seeding is done and never touch their data.
        tx.commit()?;
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

/// Trim an optional text field and treat the empty string as NULL. Critical for
/// `code`, which carries the partial UNIQUE index `uniq_items_local_code` — an
/// empty string "" is a real, collidable value there, so a blank code field
/// (the common case) MUST persist as NULL or the SECOND blank-code item would
/// fail with `UNIQUE constraint failed`.
fn norm_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
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

#[tauri::command]
pub fn list_expiring_items(within_days: i64) -> Result<Vec<LocalItem>, String> {
    list_expiring(within_days).map_err(|e| e.to_string())
}

/// Insert a pharmacy / extended-metadata item directly into SQLite. Used by
/// the EDA catalog import (and any future bulk seed) — does NOT enqueue a
/// cloud push since in standalone mode there is no cloud, and in cloud mode
/// the seed is a one-time local-only operation.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn insert_local_item(
    code: Option<String>,
    name_ar: String,
    name_en: Option<String>,
    barcode: Option<String>,
    sale_price: f64,
    vat_rate: f64,
    uom_id: Option<i64>,
    active_ingredient: Option<String>,
    dosage_form: Option<String>,
    strength: Option<String>,
    manufacturer: Option<String>,
    requires_prescription: Option<bool>,
    controlled: Option<bool>,
    expiry_date: Option<String>,
    batch_no: Option<String>,
    // Scale (Task #201) — all optional; default to non-weighed when unset.
    is_weighed: Option<bool>,
    price_per_kg: Option<f64>,
    plu: Option<String>,
) -> Result<i64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    // Blank code/barcode → NULL so the partial UNIQUE index on `code` never
    // treats an empty string as a collidable value.
    let code = norm_opt(code);
    let barcode = norm_opt(barcode);
    conn.execute(
        "INSERT INTO items_local
           (code, name_ar, name_en, barcode, sale_price, vat_rate, uom_id,
            active_ingredient, dosage_form, strength, manufacturer,
            requires_prescription, controlled, expiry_date, batch_no,
            is_weighed, price_per_kg, plu, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,CURRENT_TIMESTAMP)",
        rusqlite::params![
            code, name_ar, name_en, barcode, sale_price, vat_rate, uom_id,
            active_ingredient, dosage_form, strength, manufacturer,
            requires_prescription.map(|b| if b { 1_i64 } else { 0_i64 }),
            controlled.map(|b| if b { 1_i64 } else { 0_i64 }),
            expiry_date, batch_no,
            is_weighed.map(|b| if b { 1_i64 } else { 0_i64 }),
            price_per_kg, plu,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Update the CORE columns of a locally-created item (standalone mode).
/// Pharmacy + scale fields keep their dedicated commands
/// (`update_local_item_extended` / `_weighed`); this one owns the columns the
/// regular items form edits: code/name/barcode/price/vat/uom. Returns the
/// number of rows touched (0 means no such id).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn update_local_item(
    id: i64,
    code: Option<String>,
    name_ar: String,
    name_en: Option<String>,
    barcode: Option<String>,
    sale_price: f64,
    vat_rate: f64,
    uom_id: Option<i64>,
) -> Result<u64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    // Blank code/barcode → NULL so re-saving a row with an empty code can't
    // collide on the partial UNIQUE index on `code`.
    let code = norm_opt(code);
    let barcode = norm_opt(barcode);
    let n = conn.execute(
        "UPDATE items_local SET
           code = ?1, name_ar = ?2, name_en = ?3, barcode = ?4,
           sale_price = ?5, vat_rate = ?6, uom_id = ?7,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?8",
        rusqlite::params![code, name_ar, name_en, barcode, sale_price, vat_rate, uom_id, id],
    ).map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// Hard-delete a locally-created item (standalone mode). In cloud mode the JS
/// layer keeps using the tombstone overlay so a later pull can't resurrect a
/// row that still exists on the server; standalone has no cloud, so a plain
/// DELETE is correct and keeps the table from accumulating tombstones.
#[tauri::command]
pub fn delete_local_item(id: i64) -> Result<u64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM items_local WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// Update the Task-#201 weighed fields on an existing row. Mirrors
/// `update_local_item_extended` for the pharmacy block — needed because
/// cloud-pulled / EDA-imported rows have no LS overlay to absorb the
/// edit (see memory `pos-desktop-overlay-pattern`).
#[tauri::command]
pub fn update_local_item_weighed(
    id: i64,
    is_weighed: Option<bool>,
    price_per_kg: Option<f64>,
    plu: Option<String>,
) -> Result<u64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE items_local SET
           is_weighed = ?1, price_per_kg = ?2, plu = ?3,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?4",
        rusqlite::params![
            is_weighed.map(|b| if b { 1_i64 } else { 0_i64 }),
            price_per_kg, plu, id,
        ],
    ).map_err(|e| {
        // Surface duplicate PLU as a clear Arabic error the form can show.
        let s = e.to_string();
        if s.contains("items_local_plu_unique") || s.contains("UNIQUE constraint failed") {
            "رقم PLU مستخدم في صنف آخر — يجب أن يكون فريداً".to_string()
        } else { s }
    })?;
    Ok(n as u64)
}

/// Resolve a PLU (4–5 digit code printed on the scale-station label and
/// also embedded in barcode-scale stickers) to its catalog row. Used by
/// the embedded-weight barcode path on SalesScreen.
#[tauri::command]
pub fn find_item_by_plu(plu: String) -> Result<Option<LocalItem>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {SELECT_COLS} FROM items_local WHERE plu = ?1 LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let row = stmt.query_row([plu], row_to_item).ok();
    Ok(row)
}

/// Update the pharmacy-extended fields on an existing row. Used by the
/// items admin form when the operator edits expiry/batch info.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn update_local_item_extended(
    id: i64,
    active_ingredient: Option<String>,
    dosage_form: Option<String>,
    strength: Option<String>,
    manufacturer: Option<String>,
    requires_prescription: Option<bool>,
    controlled: Option<bool>,
    expiry_date: Option<String>,
    batch_no: Option<String>,
) -> Result<u64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE items_local SET
           active_ingredient = ?1, dosage_form = ?2, strength = ?3,
           manufacturer = ?4, requires_prescription = ?5, controlled = ?6,
           expiry_date = ?7, batch_no = ?8,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?9",
        rusqlite::params![
            active_ingredient, dosage_form, strength, manufacturer,
            requires_prescription.map(|b| if b { 1_i64 } else { 0_i64 }),
            controlled.map(|b| if b { 1_i64 } else { 0_i64 }),
            expiry_date, batch_no, id,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(n as u64)
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
    ensure_schema(&conn)?;
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
