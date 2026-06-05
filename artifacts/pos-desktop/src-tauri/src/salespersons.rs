// ─────────────────────────────────────────────────────────────────────────
// Salespersons / sales reps (مندوبو المبيعات) — full local master.
//
// Mirrors the web sales-rep module: a simple master managed from
// SalespersonsAdmin and linked to back-office sales invoices via
// sales_invoices_local.sales_rep_id (+ commission_pct snapshot). Local-only;
// never synced to the cloud (back-office desktop concern).
// ─────────────────────────────────────────────────────────────────────────

use crate::db;
use anyhow::Result;
use serde::{Deserialize, Serialize};

const MAX_ROWS: i64 = 1000;

const SELECT_COLS: &str =
    "id, code, name_ar, name_en, phone, email, commission_pct, is_active, notes";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Salesperson {
    pub id: i64,
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub commission_pct: f64,
    pub is_active: bool,
    pub notes: Option<String>,
}

fn row_to_salesperson(r: &rusqlite::Row) -> rusqlite::Result<Salesperson> {
    Ok(Salesperson {
        id: r.get(0)?,
        code: r.get(1)?,
        name_ar: r.get(2)?,
        name_en: r.get(3)?,
        phone: r.get(4)?,
        email: r.get(5)?,
        commission_pct: r.get(6)?,
        is_active: r.get::<_, i64>(7)? != 0,
        notes: r.get(8)?,
    })
}

#[tauri::command]
pub fn list_salespersons(include_inactive: Option<bool>) -> Result<Vec<Salesperson>, String> {
    list(include_inactive.unwrap_or(true)).map_err(|e| e.to_string())
}

fn list(include_inactive: bool) -> Result<Vec<Salesperson>> {
    let conn = db::open()?;
    let sql = format!(
        "SELECT {SELECT_COLS} FROM salespersons_local
         WHERE (?1 = 1 OR is_active = 1)
         ORDER BY is_active DESC, name_ar
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![include_inactive as i64, MAX_ROWS],
        row_to_salesperson,
    )?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalespersonInput {
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub commission_pct: Option<f64>,
    pub is_active: Option<bool>,
    pub notes: Option<String>,
}

#[tauri::command]
pub fn create_salesperson_local(input: SalespersonInput) -> Result<Salesperson, String> {
    create(input).map_err(|e| e.to_string())
}

fn create(input: SalespersonInput) -> Result<Salesperson> {
    let name = input.name_ar.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("اسم المندوب مطلوب"));
    }
    let conn = db::open()?;
    let code = input.code.as_deref().map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO salespersons_local
           (code, name_ar, name_en, phone, email, commission_pct, is_active, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            code,
            name,
            input.name_en,
            input.phone,
            input.email,
            input.commission_pct.unwrap_or(0.0),
            input.is_active.unwrap_or(true) as i64,
            input.notes,
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {SELECT_COLS} FROM salespersons_local WHERE id=?1");
    let sp = conn.query_row(&sql, rusqlite::params![id], row_to_salesperson)?;
    Ok(sp)
}

#[tauri::command]
pub fn update_salesperson_local(id: i64, input: SalespersonInput) -> Result<Salesperson, String> {
    update(id, input).map_err(|e| e.to_string())
}

fn update(id: i64, input: SalespersonInput) -> Result<Salesperson> {
    let name = input.name_ar.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("اسم المندوب مطلوب"));
    }
    let conn = db::open()?;
    let code = input.code.as_deref().map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE salespersons_local SET
           code=?2, name_ar=?3, name_en=?4, phone=?5, email=?6,
           commission_pct=?7, is_active=?8, notes=?9
         WHERE id=?1",
        rusqlite::params![
            id,
            code,
            name,
            input.name_en,
            input.phone,
            input.email,
            input.commission_pct.unwrap_or(0.0),
            input.is_active.unwrap_or(true) as i64,
            input.notes,
        ],
    )?;
    let sql = format!("SELECT {SELECT_COLS} FROM salespersons_local WHERE id=?1");
    let sp = conn.query_row(&sql, rusqlite::params![id], row_to_salesperson)?;
    Ok(sp)
}

#[tauri::command]
pub fn delete_salesperson_local(id: i64) -> Result<(), String> {
    delete(id).map_err(|e| e.to_string())
}

fn delete(id: i64) -> Result<()> {
    let conn = db::open()?;
    // Refuse to hard-delete a rep that is referenced by any invoice — soft
    // deactivation keeps historical commission/attribution intact.
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sales_invoices_local WHERE sales_rep_id=?1",
        rusqlite::params![id],
        |r| r.get(0),
    )?;
    if used > 0 {
        return Err(anyhow::anyhow!(
            "لا يمكن حذف المندوب لارتباطه بـ {used} فاتورة — يمكنك إلغاء تنشيطه بدلاً من ذلك"
        ));
    }
    conn.execute("DELETE FROM salespersons_local WHERE id=?1", rusqlite::params![id])?;
    Ok(())
}
