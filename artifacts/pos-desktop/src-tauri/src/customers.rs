// Local customers catalog backed by SQLite (`customers_local` table).
//
// Three read/write paths consumed by JS-side lib/customers.ts:
//   - list_customers          : full catalog for the admin grid
//   - upsert_customers_from_cloud : batched insert/update from /api/sync/pull
//   - create_customer_local   : cashier-created row (cloud_id NULL until push)
//
// The cloud sync key is `cloud_id` (UNIQUE in db.rs). A locally-created
// customer has cloud_id=NULL; the JS-side push queue eventually assigns
// one after a successful /api/sync/push response.

use crate::db;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LocalCustomer {
    pub id: i64,
    pub cloud_id: Option<i64>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub vat_number: Option<String>,
    pub updated_at: Option<String>,
}

const MAX_ROWS: i64 = 500;

fn row_to_customer(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalCustomer> {
    Ok(LocalCustomer {
        id: row.get(0)?,
        cloud_id: row.get(1)?,
        name_ar: row.get(2)?,
        name_en: row.get(3)?,
        phone: row.get(4)?,
        vat_number: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

#[tauri::command]
pub fn list_customers(search: Option<String>) -> Result<Vec<LocalCustomer>, String> {
    list(search.as_deref()).map_err(|e| e.to_string())
}

fn list(search: Option<&str>) -> Result<Vec<LocalCustomer>> {
    let conn = db::open()?;
    let sql = "SELECT id, cloud_id, name_ar, name_en, phone, vat_number, updated_at
               FROM customers_local
               WHERE (?1 IS NULL OR name_ar LIKE ?2 OR phone LIKE ?2 OR vat_number LIKE ?2)
               ORDER BY name_ar
               LIMIT ?3";
    let pattern = search.map(|s| format!("%{}%", s));
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        rusqlite::params![search, pattern, MAX_ROWS],
        row_to_customer,
    )?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[derive(Deserialize, Debug)]
pub struct CloudCustomer {
    pub cloud_id: i64,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub vat_number: Option<String>,
}

#[tauri::command]
pub fn upsert_customers_from_cloud(rows: Vec<CloudCustomer>) -> Result<u64, String> {
    upsert_from_cloud(rows).map_err(|e| e.to_string())
}

fn upsert_from_cloud(rows: Vec<CloudCustomer>) -> Result<u64> {
    let mut conn = db::open()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut stmt = tx.prepare(
        "INSERT INTO customers_local
           (cloud_id, name_ar, name_en, phone, vat_number, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
         ON CONFLICT(cloud_id) DO UPDATE SET
           name_ar = excluded.name_ar,
           name_en = excluded.name_en,
           phone = excluded.phone,
           vat_number = excluded.vat_number,
           updated_at = CURRENT_TIMESTAMP",
    )?;
    let mut count = 0_u64;
    for r in &rows {
        stmt.execute(rusqlite::params![
            r.cloud_id, r.name_ar, r.name_en, r.phone, r.vat_number,
        ])?;
        count += 1;
    }
    drop(stmt);
    tx.commit()?;
    Ok(count)
}

#[tauri::command]
pub fn create_customer_local(
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
) -> Result<LocalCustomer, String> {
    create(name_ar, name_en, phone, vat_number).map_err(|e| e.to_string())
}

fn create(
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
) -> Result<LocalCustomer> {
    let conn = db::open()?;
    conn.execute(
        "INSERT INTO customers_local (cloud_id, name_ar, name_en, phone, vat_number, updated_at)
         VALUES (NULL, ?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
        rusqlite::params![name_ar, name_en, phone, vat_number],
    )?;
    let id = conn.last_insert_rowid();
    Ok(LocalCustomer {
        id,
        cloud_id: None,
        name_ar,
        name_en,
        phone,
        vat_number,
        updated_at: None,
    })
}
