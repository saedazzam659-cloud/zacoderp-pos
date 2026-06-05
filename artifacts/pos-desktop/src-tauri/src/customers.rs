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
    // ── Profile parity with web (Phase 1A) ──
    pub cr_number: Option<String>,
    pub email: Option<String>,
    pub city: Option<String>,
    pub district: Option<String>,
    pub street: Option<String>,
    pub building_number: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub national_address_short: Option<String>,
    pub location_lat: Option<String>,
    pub location_lng: Option<String>,
    pub location_link: Option<String>,
    pub include_in_statements: bool,
    pub branch_id: Option<i64>,
}

const MAX_ROWS: i64 = 500;

// Shared SELECT column list — keep order in lockstep with `row_to_customer`.
const SELECT_COLS: &str = "id, cloud_id, name_ar, name_en, phone, vat_number, updated_at, currency_code, balance, \
     credit_limit, enforce_credit_limit, payment_terms_days, \
     cr_number, email, city, district, street, building_number, postal_code, country, \
     national_address_short, location_lat, location_lng, location_link, include_in_statements, branch_id";

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
        cr_number: row.get(12)?,
        email: row.get(13)?,
        city: row.get(14)?,
        district: row.get(15)?,
        street: row.get(16)?,
        building_number: row.get(17)?,
        postal_code: row.get(18)?,
        country: row.get(19)?,
        national_address_short: row.get(20)?,
        location_lat: row.get(21)?,
        location_lng: row.get(22)?,
        location_link: row.get(23)?,
        include_in_statements: row.get::<_, Option<i64>>(24)?.unwrap_or(1) != 0,
        branch_id: row.get(25)?,
    })
}

#[tauri::command]
pub fn list_customers(search: Option<String>) -> Result<Vec<LocalCustomer>, String> {
    list(search.as_deref()).map_err(|e| e.to_string())
}

fn list(search: Option<&str>) -> Result<Vec<LocalCustomer>> {
    let conn = db::open()?;
    let sql = format!(
        "SELECT {SELECT_COLS}
               FROM customers_local
               WHERE (?1 IS NULL OR name_ar LIKE ?2 OR phone LIKE ?2 OR vat_number LIKE ?2)
               ORDER BY name_ar
               LIMIT ?3"
    );
    let pattern = search.map(|s| format!("%{}%", s));
    let mut stmt = conn.prepare(&sql)?;
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

/// Optional profile fields shared by create + update. Bundling them in one
/// struct keeps the Tauri command signatures sane as the customer model grows.
/// JS passes a single `profile` object (camelCase keys → serde rename).
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerProfile {
    pub cr_number: Option<String>,
    pub email: Option<String>,
    pub city: Option<String>,
    pub district: Option<String>,
    pub street: Option<String>,
    pub building_number: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub national_address_short: Option<String>,
    pub location_lat: Option<String>,
    pub location_lng: Option<String>,
    pub location_link: Option<String>,
    pub include_in_statements: Option<bool>,
    pub branch_id: Option<i64>,
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
    profile: Option<CustomerProfile>,
) -> Result<LocalCustomer, String> {
    create(name_ar, name_en, phone, vat_number, currency_code, opening_balance, opening_nature, opening_date,
           credit_limit, enforce_credit_limit, payment_terms_days, profile.unwrap_or_default())
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
    profile: CustomerProfile,
) -> Result<LocalCustomer> {
    let mut conn = db::open()?;
    let cur = currency_code.unwrap_or_else(|| "SAR".to_string());
    let cl = credit_limit.unwrap_or(0.0);
    let enforce = enforce_credit_limit.unwrap_or(false);
    let terms = payment_terms_days.unwrap_or(0);
    let country = profile.country.clone().unwrap_or_else(|| "SA".to_string());
    let include = profile.include_in_statements.unwrap_or(true);
    // 0 is the "no branch" sentinel from the JS wire (see toProfile); SQLite
    // branch ids start at 1, so collapse it to NULL on insert.
    let branch_id = match profile.branch_id {
        Some(0) => None,
        other => other,
    };
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO customers_local (cloud_id, name_ar, name_en, phone, vat_number, currency_code,
                                      credit_limit, enforce_credit_limit, payment_terms_days,
                                      cr_number, email, city, district, street, building_number, postal_code,
                                      country, national_address_short, location_lat, location_lng, location_link,
                                      include_in_statements, branch_id, updated_at)
         VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20,
                 ?21, ?22, CURRENT_TIMESTAMP)",
        rusqlite::params![
            name_ar, name_en, phone, vat_number, cur, cl, enforce as i64, terms,
            profile.cr_number, profile.email, profile.city, profile.district, profile.street,
            profile.building_number, profile.postal_code, country, profile.national_address_short,
            profile.location_lat, profile.location_lng, profile.location_link,
            include as i64, branch_id,
        ],
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
        cr_number: profile.cr_number,
        email: profile.email,
        city: profile.city,
        district: profile.district,
        street: profile.street,
        building_number: profile.building_number,
        postal_code: profile.postal_code,
        country: Some(country),
        national_address_short: profile.national_address_short,
        location_lat: profile.location_lat,
        location_lng: profile.location_lng,
        location_link: profile.location_link,
        include_in_statements: include,
        branch_id,
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
    profile: Option<CustomerProfile>,
) -> Result<LocalCustomer, String> {
    update(id, name_ar, name_en, phone, vat_number, currency_code,
           credit_limit, enforce_credit_limit, payment_terms_days, profile.unwrap_or_default())
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
    profile: CustomerProfile,
) -> Result<LocalCustomer> {
    let conn = db::open()?;
    let enforce_int: Option<i64> = enforce_credit_limit.map(|b| b as i64);
    let include_int: Option<i64> = profile.include_in_statements.map(|b| b as i64);
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
           cr_number              = COALESCE(?10, cr_number),
           email                  = COALESCE(?11, email),
           city                   = COALESCE(?12, city),
           district               = COALESCE(?13, district),
           street                 = COALESCE(?14, street),
           building_number        = COALESCE(?15, building_number),
           postal_code            = COALESCE(?16, postal_code),
           country                = COALESCE(?17, country),
           national_address_short = COALESCE(?18, national_address_short),
           location_lat           = COALESCE(?19, location_lat),
           location_lng           = COALESCE(?20, location_lng),
           location_link          = COALESCE(?21, location_link),
           include_in_statements  = COALESCE(?22, include_in_statements),
           branch_id              = CASE WHEN ?23 IS NULL THEN branch_id
                                         WHEN ?23 = 0 THEN NULL
                                         ELSE ?23 END,
           updated_at           = CURRENT_TIMESTAMP
         WHERE id = ?1",
        rusqlite::params![
            id, name_ar, name_en, phone, vat_number, currency_code,
            credit_limit, enforce_int, payment_terms_days,
            profile.cr_number, profile.email, profile.city, profile.district, profile.street,
            profile.building_number, profile.postal_code, profile.country, profile.national_address_short,
            profile.location_lat, profile.location_lng, profile.location_link,
            include_int, profile.branch_id,
        ],
    )?;
    let sql = format!("SELECT {SELECT_COLS} FROM customers_local WHERE id = ?1");
    conn.query_row(
        &sql,
        rusqlite::params![id],
        row_to_customer,
    ).map_err(Into::into)
}
