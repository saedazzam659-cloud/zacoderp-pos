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
    pub currency_code: String,
    pub balance: f64,
    pub credit_limit: f64,
    pub enforce_credit_limit: bool,
    pub payment_terms_days: i64,
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
        currency_code: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "SAR".to_string()),
        balance: row.get(8)?,
        credit_limit: row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
        enforce_credit_limit: row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
        payment_terms_days: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
    })
}

#[tauri::command]
pub fn list_customers(search: Option<String>) -> Result<Vec<LocalCustomer>, String> {
    list(search.as_deref()).map_err(|e| e.to_string())
}

fn list(search: Option<&str>) -> Result<Vec<LocalCustomer>> {
    let conn = db::open()?;
    let sql = "SELECT id, cloud_id, name_ar, name_en, phone, vat_number, updated_at, currency_code, balance,
                      credit_limit, enforce_credit_limit, payment_terms_days
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
#[allow(clippy::too_many_arguments)]
pub fn create_customer_local(
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
    currency_code: Option<String>,
    opening_balance: Option<f64>,
    opening_nature: Option<String>,
    opening_date: Option<String>,
    credit_limit: Option<f64>,
    enforce_credit_limit: Option<bool>,
    payment_terms_days: Option<i64>,
) -> Result<LocalCustomer, String> {
    create(name_ar, name_en, phone, vat_number, currency_code, opening_balance, opening_nature, opening_date,
           credit_limit, enforce_credit_limit, payment_terms_days)
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn create(
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
    currency_code: Option<String>,
    opening_balance: Option<f64>,
    opening_nature: Option<String>,
    opening_date: Option<String>,
    credit_limit: Option<f64>,
    enforce_credit_limit: Option<bool>,
    payment_terms_days: Option<i64>,
) -> Result<LocalCustomer> {
    let mut conn = db::open()?;
    let cur = currency_code.unwrap_or_else(|| "SAR".to_string());
    let cl = credit_limit.unwrap_or(0.0);
    let enforce = enforce_credit_limit.unwrap_or(false);
    let terms = payment_terms_days.unwrap_or(0);
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO customers_local (cloud_id, name_ar, name_en, phone, vat_number, currency_code,
                                      credit_limit, enforce_credit_limit, payment_terms_days, updated_at)
         VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)",
        rusqlite::params![name_ar, name_en, phone, vat_number, cur, cl, enforce as i64, terms],
    )?;
    let id = tx.last_insert_rowid();
    let ob = opening_balance.unwrap_or(0.0).abs();
    if ob > 1e-9 {
        let nature = opening_nature.as_deref().unwrap_or("debit");
        let date = match opening_date {
            Some(d) if !d.trim().is_empty() => d,
            _ => tx.query_row("SELECT date('now','localtime')", [], |r| r.get(0))?,
        };
        crate::accounting::post_party_opening_balance(&tx, "customer", id, &cur, ob, nature, &date)?;
    }
    let balance: f64 = tx.query_row("SELECT balance FROM customers_local WHERE id=?1", rusqlite::params![id], |r| r.get(0))?;
    tx.commit()?;
    Ok(LocalCustomer {
        id,
        cloud_id: None,
        name_ar,
        name_en,
        phone,
        vat_number,
        updated_at: None,
        currency_code: cur,
        balance,
        credit_limit: cl,
        enforce_credit_limit: enforce,
        payment_terms_days: terms,
    })
}

/// Persist editable scalar fields (incl. credit control) to SQLite. Unlike the
/// LS-overlay path used by the browser fallback, this writes the canonical row
/// so the Rust-side credit-limit enforcement on sales reads the true values.
/// Only non-None fields are updated (COALESCE keeps the existing value).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_customer_local(
    id: i64,
    name_ar: Option<String>,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
    currency_code: Option<String>,
    credit_limit: Option<f64>,
    enforce_credit_limit: Option<bool>,
    payment_terms_days: Option<i64>,
) -> Result<LocalCustomer, String> {
    update(id, name_ar, name_en, phone, vat_number, currency_code,
           credit_limit, enforce_credit_limit, payment_terms_days)
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn update(
    id: i64,
    name_ar: Option<String>,
    name_en: Option<String>,
    phone: Option<String>,
    vat_number: Option<String>,
    currency_code: Option<String>,
    credit_limit: Option<f64>,
    enforce_credit_limit: Option<bool>,
    payment_terms_days: Option<i64>,
) -> Result<LocalCustomer> {
    let conn = db::open()?;
    let enforce_int: Option<i64> = enforce_credit_limit.map(|b| b as i64);
    conn.execute(
        "UPDATE customers_local SET
           name_ar              = COALESCE(?2, name_ar),
           name_en              = COALESCE(?3, name_en),
           phone                = COALESCE(?4, phone),
           vat_number           = COALESCE(?5, vat_number),
           currency_code        = COALESCE(?6, currency_code),
           credit_limit         = COALESCE(?7, credit_limit),
           enforce_credit_limit = COALESCE(?8, enforce_credit_limit),
           payment_terms_days   = COALESCE(?9, payment_terms_days),
           updated_at           = CURRENT_TIMESTAMP
         WHERE id = ?1",
        rusqlite::params![id, name_ar, name_en, phone, vat_number, currency_code,
                          credit_limit, enforce_int, payment_terms_days],
    )?;
    conn.query_row(
        "SELECT id, cloud_id, name_ar, name_en, phone, vat_number, updated_at, currency_code, balance,
                credit_limit, enforce_credit_limit, payment_terms_days
         FROM customers_local WHERE id = ?1",
        rusqlite::params![id],
        row_to_customer,
    ).map_err(Into::into)
}
