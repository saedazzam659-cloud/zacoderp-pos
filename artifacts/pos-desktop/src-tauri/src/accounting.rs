// Standalone accounting & operations (Task #207).
//
// Tables live in db.rs. This module exposes the Tauri commands that the
// React screens call. All money-moving operations open a transaction,
// insert the row, post a balanced journal entry, and update affected
// account/party balances atomically.

use crate::db;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }
fn today_iso() -> String { chrono::Utc::now().format("%Y-%m-%d").to_string() }

// ───────────────────────── Chart of Accounts ─────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub r#type: String,
    pub parent_id: Option<i64>,
    pub is_leaf: bool,
    pub balance: f64,
}

fn row_to_account(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        code: r.get(1)?,
        name_ar: r.get(2)?,
        name_en: r.get(3)?,
        r#type: r.get(4)?,
        parent_id: r.get(5)?,
        is_leaf: r.get::<_, i64>(6)? != 0,
        balance: r.get(7)?,
    })
}

#[tauri::command]
pub fn accounts_list() -> Result<Vec<Account>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,type,parent_id,is_leaf,balance FROM accounts_local ORDER BY code"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_account).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub r#type: String,
    pub parent_id: Option<i64>,
    pub is_leaf: bool,
}

#[tauri::command]
pub fn accounts_create(input: AccountInput) -> Result<i64, String> {
    if !["asset","liability","equity","revenue","expense"].contains(&input.r#type.as_str()) {
        return Err("نوع الحساب غير صالح".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO accounts_local(code,name_ar,name_en,type,parent_id,is_leaf) VALUES(?1,?2,?3,?4,?5,?6)",
        params![input.code, input.name_ar, input.name_en, input.r#type, input.parent_id, if input.is_leaf {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود الحساب موجود".to_string() } else { e.to_string() })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn accounts_update(id: i64, input: AccountInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts_local SET code=?1,name_ar=?2,name_en=?3,type=?4,parent_id=?5,is_leaf=?6 WHERE id=?7",
        params![input.code, input.name_ar, input.name_en, input.r#type, input.parent_id, if input.is_leaf {1} else {0}, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn accounts_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM journal_entry_lines_local WHERE account_id=?1", params![id], |r| r.get(0)
    ).map_err(|e| e.to_string())?;
    if used > 0 { return Err("الحساب مستخدم في قيود محاسبية ولا يمكن حذفه".into()); }
    conn.execute("DELETE FROM accounts_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn account_type(conn: &Connection, id: i64) -> Result<String> {
    let t: String = conn.query_row("SELECT type FROM accounts_local WHERE id=?1", params![id], |r| r.get(0))?;
    Ok(t)
}

fn signed_delta(typ: &str, debit: f64, credit: f64) -> f64 {
    match typ {
        "asset" | "expense" => debit - credit,
        _ => credit - debit,
    }
}

fn apply_balance(tx: &Transaction, account_id: i64, debit: f64, credit: f64) -> Result<()> {
    let typ = account_type(tx, account_id)?;
    let delta = signed_delta(&typ, debit, credit);
    tx.execute("UPDATE accounts_local SET balance=balance+?1 WHERE id=?2", params![delta, account_id])?;
    Ok(())
}

fn account_id_by_code(conn: &Connection, code: &str) -> Result<i64> {
    let id: i64 = conn.query_row("SELECT id FROM accounts_local WHERE code=?1", params![code], |r| r.get(0))
        .map_err(|_| anyhow!(format!("الحساب {code} غير موجود في شجرة الحسابات")))?;
    Ok(id)
}

fn next_entry_no(conn: &Connection) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COALESCE(MAX(id),0)+1 FROM journal_entries_local", [], |r| r.get(0))?;
    Ok(format!("JE-{:06}", n))
}

// ───────────────────────── Journal Entries ───────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: i64,
    pub entry_no: String,
    pub entry_date: String,
    pub description: Option<String>,
    pub total_debit: f64,
    pub total_credit: f64,
    pub source_type: Option<String>,
    pub source_id: Option<i64>,
    pub lines: Vec<JournalEntryLine>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryLine {
    pub id: Option<i64>,
    pub account_id: i64,
    pub account_code: Option<String>,
    pub account_name: Option<String>,
    pub debit: f64,
    pub credit: f64,
    pub description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryInput {
    pub entry_date: String,
    pub description: Option<String>,
    pub lines: Vec<JournalEntryLine>,
}

fn insert_journal_entry(
    tx: &Transaction,
    entry_date: &str,
    description: Option<&str>,
    source_type: Option<&str>,
    source_id: Option<i64>,
    lines: &[JournalEntryLine],
) -> Result<i64> {
    let total_debit: f64 = lines.iter().map(|l| l.debit).sum();
    let total_credit: f64 = lines.iter().map(|l| l.credit).sum();
    if (total_debit - total_credit).abs() > 0.001 {
        return Err(anyhow!(format!("القيد غير متوازن: مدين={total_debit:.2} دائن={total_credit:.2}")));
    }
    if lines.len() < 2 { return Err(anyhow!("القيد يحتاج سطرين على الأقل")); }
    let entry_no = next_entry_no(tx)?;
    tx.execute(
        "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,source_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![entry_no, entry_date, description, total_debit, total_credit, source_type, source_id],
    )?;
    let je_id = tx.last_insert_rowid();
    for l in lines {
        tx.execute(
            "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit,description) VALUES(?1,?2,?3,?4,?5)",
            params![je_id, l.account_id, l.debit, l.credit, l.description],
        )?;
        apply_balance(tx, l.account_id, l.debit, l.credit)?;
    }
    Ok(je_id)
}

#[tauri::command]
pub fn journal_entries_list(limit: Option<i64>) -> Result<Vec<JournalEntry>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT id,entry_no,entry_date,description,total_debit,total_credit,source_type,source_id
         FROM journal_entries_local ORDER BY id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(JournalEntry {
        id: r.get(0)?, entry_no: r.get(1)?, entry_date: r.get(2)?, description: r.get(3)?,
        total_debit: r.get(4)?, total_credit: r.get(5)?, source_type: r.get(6)?, source_id: r.get(7)?,
        lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn journal_entry_get(id: i64) -> Result<JournalEntry, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut entry: JournalEntry = conn.query_row(
        "SELECT id,entry_no,entry_date,description,total_debit,total_credit,source_type,source_id FROM journal_entries_local WHERE id=?1",
        params![id], |r| Ok(JournalEntry {
            id: r.get(0)?, entry_no: r.get(1)?, entry_date: r.get(2)?, description: r.get(3)?,
            total_debit: r.get(4)?, total_credit: r.get(5)?, source_type: r.get(6)?, source_id: r.get(7)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT l.id,l.account_id,a.code,a.name_ar,l.debit,l.credit,l.description
         FROM journal_entry_lines_local l
         JOIN accounts_local a ON a.id=l.account_id
         WHERE l.entry_id=?1 ORDER BY l.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(JournalEntryLine {
        id: r.get(0)?, account_id: r.get(1)?, account_code: r.get(2)?, account_name: r.get(3)?,
        debit: r.get(4)?, credit: r.get(5)?, description: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { entry.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(entry)
}

#[tauri::command]
pub fn journal_entry_create(input: JournalEntryInput) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = insert_journal_entry(&tx, &input.entry_date, input.description.as_deref(), Some("manual"), None, &input.lines)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

// ───────────────────────── Suppliers ─────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    pub id: i64,
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub vat_number: Option<String>,
    pub balance: f64,
    pub notes: Option<String>,
}

fn row_to_supplier(r: &rusqlite::Row<'_>) -> rusqlite::Result<Supplier> {
    Ok(Supplier {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        phone: r.get(4)?, vat_number: r.get(5)?, balance: r.get(6)?, notes: r.get(7)?,
    })
}

#[tauri::command]
pub fn suppliers_list() -> Result<Vec<Supplier>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,phone,vat_number,balance,notes FROM suppliers_local ORDER BY name_ar"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_supplier).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInput {
    pub code: Option<String>,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub phone: Option<String>,
    pub vat_number: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub fn suppliers_create(input: SupplierInput) -> Result<i64, String> {
    if input.name_ar.trim().is_empty() { return Err("اسم المورد مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let ap = account_id_by_code(&conn, "2100").map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO suppliers_local(code,name_ar,name_en,phone,vat_number,notes,ap_account_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![input.code, input.name_ar, input.name_en, input.phone, input.vat_number, input.notes, ap],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn suppliers_update(id: i64, input: SupplierInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE suppliers_local SET code=?1,name_ar=?2,name_en=?3,phone=?4,vat_number=?5,notes=?6 WHERE id=?7",
        params![input.code, input.name_ar, input.name_en, input.phone, input.vat_number, input.notes, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn suppliers_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let used: i64 = conn.query_row("SELECT COUNT(*) FROM purchases_local WHERE supplier_id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف مورد لديه فواتير".into()); }
    conn.execute("DELETE FROM suppliers_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────────────── Cash Boxes ────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CashBox {
    pub id: i64,
    pub name: String,
    pub balance: f64,
    pub account_id: Option<i64>,
}

#[tauri::command]
pub fn cash_boxes_list() -> Result<Vec<CashBox>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,name,balance,account_id FROM cash_boxes_local ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(CashBox {
        id: r.get(0)?, name: r.get(1)?, balance: r.get(2)?, account_id: r.get(3)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashBoxInput {
    pub name: String,
    pub account_id: Option<i64>,
}

#[tauri::command]
pub fn cash_boxes_create(input: CashBoxInput) -> Result<i64, String> {
    if input.name.trim().is_empty() { return Err("اسم الخزينة مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    // Auto-create child account under 1100 if not provided.
    let acc_id = match input.account_id {
        Some(a) => a,
        None => {
            let parent = account_id_by_code(&conn, "1100").map_err(|e| e.to_string())?;
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM cash_boxes_local", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let code = format!("11{:02}", n + 2);
            conn.execute(
                "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,'asset',?3,1)",
                params![code, format!("خزينة - {}", input.name), parent],
            ).map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };
    conn.execute("INSERT INTO cash_boxes_local(name,account_id) VALUES(?1,?2)", params![input.name, acc_id])
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn cash_boxes_update(id: i64, input: CashBoxInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("UPDATE cash_boxes_local SET name=?1 WHERE id=?2", params![input.name, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cash_boxes_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let bal: f64 = conn.query_row("SELECT balance FROM cash_boxes_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if bal.abs() > 0.001 { return Err("لا يمكن حذف خزينة لديها رصيد".into()); }
    conn.execute("DELETE FROM cash_boxes_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────────────── Banks ─────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bank {
    pub id: i64,
    pub name: String,
    pub account_no: Option<String>,
    pub balance: f64,
    pub account_id: Option<i64>,
}

#[tauri::command]
pub fn banks_list() -> Result<Vec<Bank>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,name,account_no,balance,account_id FROM banks_local ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Bank {
        id: r.get(0)?, name: r.get(1)?, account_no: r.get(2)?, balance: r.get(3)?, account_id: r.get(4)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankInput {
    pub name: String,
    pub account_no: Option<String>,
}

#[tauri::command]
pub fn banks_create(input: BankInput) -> Result<i64, String> {
    if input.name.trim().is_empty() { return Err("اسم البنك مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let parent = account_id_by_code(&conn, "1200").map_err(|e| e.to_string())?;
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM banks_local", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let code = format!("12{:02}", n + 1);
    conn.execute(
        "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,'asset',?3,1)",
        params![code, format!("بنك - {}", input.name), parent],
    ).map_err(|e| e.to_string())?;
    let acc_id = conn.last_insert_rowid();
    conn.execute("INSERT INTO banks_local(name,account_no,account_id) VALUES(?1,?2,?3)",
        params![input.name, input.account_no, acc_id]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn banks_update(id: i64, input: BankInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("UPDATE banks_local SET name=?1,account_no=?2 WHERE id=?3",
        params![input.name, input.account_no, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn banks_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let bal: f64 = conn.query_row("SELECT balance FROM banks_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if bal.abs() > 0.001 { return Err("لا يمكن حذف بنك لديه رصيد".into()); }
    conn.execute("DELETE FROM banks_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────────────── Purchases ─────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLine {
    pub id: Option<i64>,
    pub item_id: i64,
    pub item_name: Option<String>,
    pub qty: f64,
    pub unit_cost: f64,
    pub vat_rate: f64,
    pub line_total: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub id: i64,
    pub invoice_no: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub invoice_date: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
    pub lines: Vec<PurchaseLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInput {
    pub supplier_id: i64,
    pub invoice_date: String,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub notes: Option<String>,
    pub lines: Vec<PurchaseLine>,
}

fn next_purchase_no(conn: &Connection) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COALESCE(MAX(id),0)+1 FROM purchases_local", [], |r| r.get(0))?;
    Ok(format!("PUR-{:06}", n))
}

#[tauri::command]
pub fn purchases_list(limit: Option<i64>) -> Result<Vec<Purchase>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT p.id,p.invoice_no,p.supplier_id,s.name_ar,p.invoice_date,p.subtotal,p.vat_total,p.grand_total,
                p.payment_method,p.cash_box_id,p.bank_id,p.je_id,p.notes
         FROM purchases_local p JOIN suppliers_local s ON s.id=p.supplier_id
         ORDER BY p.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(Purchase {
        id: r.get(0)?, invoice_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
        payment_method: r.get(8)?, cash_box_id: r.get(9)?, bank_id: r.get(10)?, je_id: r.get(11)?,
        notes: r.get(12)?, lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn purchase_get(id: i64) -> Result<Purchase, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut p: Purchase = conn.query_row(
        "SELECT p.id,p.invoice_no,p.supplier_id,s.name_ar,p.invoice_date,p.subtotal,p.vat_total,p.grand_total,
                p.payment_method,p.cash_box_id,p.bank_id,p.je_id,p.notes
         FROM purchases_local p JOIN suppliers_local s ON s.id=p.supplier_id
         WHERE p.id=?1",
        params![id], |r| Ok(Purchase {
            id: r.get(0)?, invoice_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
            payment_method: r.get(8)?, cash_box_id: r.get(9)?, bank_id: r.get(10)?, je_id: r.get(11)?,
            notes: r.get(12)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total
         FROM purchase_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.purchase_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { p.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(p)
}

#[tauri::command]
pub fn purchase_create(input: PurchaseInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ فاتورة بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Compute totals.
    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in &input.lines {
        let line_sub = l.qty * l.unit_cost;
        let line_vat = line_sub * l.vat_rate / 100.0;
        subtotal += line_sub;
        vat_total += line_vat;
    }
    let grand_total = subtotal + vat_total;

    let invoice_no = next_purchase_no(&tx).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO purchases_local(invoice_no,supplier_id,invoice_date,subtotal,vat_total,grand_total,payment_method,cash_box_id,bank_id,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![invoice_no, input.supplier_id, input.invoice_date, subtotal, vat_total, grand_total,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes],
    ).map_err(|e| e.to_string())?;
    let purchase_id = tx.last_insert_rowid();

    for l in &input.lines {
        let line_sub = l.qty * l.unit_cost;
        let line_vat = line_sub * l.vat_rate / 100.0;
        let lt = line_sub + line_vat;
        tx.execute(
            "INSERT INTO purchase_lines_local(purchase_id,item_id,qty,unit_cost,vat_rate,line_total) VALUES(?1,?2,?3,?4,?5,?6)",
            params![purchase_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt],
        ).map_err(|e| e.to_string())?;
    }

    // Build & post JE: DR Inventory(subtotal) + DR VAT-In(vat) / CR (supplier|cash|bank)(grand)
    let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
    let vat_in_acc = account_id_by_code(&tx, "1400").map_err(|e| e.to_string())?;
    let cr_account_id = resolve_payment_credit_account(&tx, &input.payment_method, input.supplier_id, input.cash_box_id, input.bank_id)
        .map_err(|e| e.to_string())?;

    let mut lines = vec![
        JournalEntryLine { id: None, account_id: inv_acc, account_code: None, account_name: None, debit: subtotal, credit: 0.0, description: Some(format!("شراء {invoice_no}")) },
    ];
    if vat_total > 0.0 {
        lines.push(JournalEntryLine { id: None, account_id: vat_in_acc, account_code: None, account_name: None, debit: vat_total, credit: 0.0, description: None });
    }
    lines.push(JournalEntryLine { id: None, account_id: cr_account_id, account_code: None, account_name: None, debit: 0.0, credit: grand_total, description: None });

    let je_id = insert_journal_entry(&tx, &input.invoice_date, Some(&format!("فاتورة شراء {invoice_no}")), Some("purchase"), Some(purchase_id), &lines)
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE purchases_local SET je_id=?1 WHERE id=?2", params![je_id, purchase_id]).map_err(|e| e.to_string())?;

    // Update party balance shadow.
    if input.payment_method == "credit" {
        tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![grand_total, input.supplier_id]).map_err(|e| e.to_string())?;
    } else if input.payment_method == "cash" {
        if let Some(cb) = input.cash_box_id {
            tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![grand_total, cb]).map_err(|e| e.to_string())?;
        }
    } else if input.payment_method == "bank" {
        if let Some(b) = input.bank_id {
            tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![grand_total, b]).map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(purchase_id)
}

fn resolve_payment_credit_account(
    conn: &Connection,
    method: &str,
    supplier_id: i64,
    cash_box_id: Option<i64>,
    bank_id: Option<i64>,
) -> Result<i64> {
    match method {
        "credit" => {
            let id: i64 = conn.query_row("SELECT ap_account_id FROM suppliers_local WHERE id=?1", params![supplier_id], |r| r.get(0))?;
            Ok(id)
        }
        "cash" => {
            let cb = cash_box_id.ok_or_else(|| anyhow!("اختر الخزينة"))?;
            let id: i64 = conn.query_row("SELECT account_id FROM cash_boxes_local WHERE id=?1", params![cb], |r| r.get(0))?;
            Ok(id)
        }
        "bank" => {
            let b = bank_id.ok_or_else(|| anyhow!("اختر البنك"))?;
            let id: i64 = conn.query_row("SELECT account_id FROM banks_local WHERE id=?1", params![b], |r| r.get(0))?;
            Ok(id)
        }
        _ => Err(anyhow!("طريقة دفع غير صالحة"))
    }
}

// ───────────────────────── Purchase Returns ──────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseReturn {
    pub id: i64,
    pub return_no: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub purchase_id: Option<i64>,
    pub return_date: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
    pub lines: Vec<PurchaseLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseReturnInput {
    pub supplier_id: i64,
    pub purchase_id: Option<i64>,
    pub return_date: String,
    pub notes: Option<String>,
    pub lines: Vec<PurchaseLine>,
}

fn next_pret_no(conn: &Connection) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COALESCE(MAX(id),0)+1 FROM purchase_returns_local", [], |r| r.get(0))?;
    Ok(format!("PRT-{:06}", n))
}

#[tauri::command]
pub fn purchase_returns_list(limit: Option<i64>) -> Result<Vec<PurchaseReturn>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT r.id,r.return_no,r.supplier_id,s.name_ar,r.purchase_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,r.je_id,r.notes
         FROM purchase_returns_local r JOIN suppliers_local s ON s.id=r.supplier_id
         ORDER BY r.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(PurchaseReturn {
        id: r.get(0)?, return_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        purchase_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
        grand_total: r.get(8)?, je_id: r.get(9)?, notes: r.get(10)?, lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn purchase_return_get(id: i64) -> Result<PurchaseReturn, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut p: PurchaseReturn = conn.query_row(
        "SELECT r.id,r.return_no,r.supplier_id,s.name_ar,r.purchase_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,r.je_id,r.notes
         FROM purchase_returns_local r JOIN suppliers_local s ON s.id=r.supplier_id WHERE r.id=?1",
        params![id], |r| Ok(PurchaseReturn {
            id: r.get(0)?, return_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            purchase_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
            grand_total: r.get(8)?, je_id: r.get(9)?, notes: r.get(10)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total
         FROM purchase_return_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.return_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { p.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(p)
}

#[tauri::command]
pub fn purchase_return_create(input: PurchaseReturnInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ مرتجع بدون أصناف".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in &input.lines {
        let line_sub = l.qty * l.unit_cost;
        let line_vat = line_sub * l.vat_rate / 100.0;
        subtotal += line_sub;
        vat_total += line_vat;
    }
    let grand_total = subtotal + vat_total;

    let return_no = next_pret_no(&tx).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO purchase_returns_local(return_no,supplier_id,purchase_id,return_date,subtotal,vat_total,grand_total,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![return_no, input.supplier_id, input.purchase_id, input.return_date, subtotal, vat_total, grand_total, input.notes],
    ).map_err(|e| e.to_string())?;
    let return_id = tx.last_insert_rowid();

    for l in &input.lines {
        let line_sub = l.qty * l.unit_cost;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO purchase_return_lines_local(return_id,item_id,qty,unit_cost,vat_rate,line_total) VALUES(?1,?2,?3,?4,?5,?6)",
            params![return_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt],
        ).map_err(|e| e.to_string())?;
    }

    // JE reverse: DR Supplier(grand) / CR Inventory(subtotal) + CR VAT-In(vat)
    let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
    let vat_in_acc = account_id_by_code(&tx, "1400").map_err(|e| e.to_string())?;
    let supp_acc: i64 = tx.query_row("SELECT ap_account_id FROM suppliers_local WHERE id=?1", params![input.supplier_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut lines = vec![
        JournalEntryLine { id: None, account_id: supp_acc, account_code: None, account_name: None, debit: grand_total, credit: 0.0, description: Some(format!("مرتجع شراء {return_no}")) },
        JournalEntryLine { id: None, account_id: inv_acc,  account_code: None, account_name: None, debit: 0.0, credit: subtotal, description: None },
    ];
    if vat_total > 0.0 {
        lines.push(JournalEntryLine { id: None, account_id: vat_in_acc, account_code: None, account_name: None, debit: 0.0, credit: vat_total, description: None });
    }
    let je_id = insert_journal_entry(&tx, &input.return_date, Some(&format!("مرتجع شراء {return_no}")), Some("purchase_return"), Some(return_id), &lines)
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE purchase_returns_local SET je_id=?1 WHERE id=?2", params![je_id, return_id]).map_err(|e| e.to_string())?;

    // Reduce supplier balance.
    tx.execute("UPDATE suppliers_local SET balance=balance-?1 WHERE id=?2", params![grand_total, input.supplier_id]).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(return_id)
}

// ───────────────────────── Financial Transactions ───────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinancialTx {
    pub id: i64,
    pub tx_no: String,
    pub tx_date: String,
    pub tx_type: String,
    pub party_type: Option<String>,
    pub party_id: Option<i64>,
    pub party_name: Option<String>,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub counter_account_id: Option<i64>,
    pub amount: f64,
    pub description: Option<String>,
    pub je_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialTxInput {
    pub tx_date: String,
    pub tx_type: String,
    pub party_type: Option<String>,
    pub party_id: Option<i64>,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub counter_account_id: Option<i64>,
    pub amount: f64,
    pub description: Option<String>,
}

fn next_fintx_no(conn: &Connection, tx_type: &str) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COALESCE(MAX(id),0)+1 FROM financial_transactions_local", [], |r| r.get(0))?;
    let prefix = if tx_type == "receipt" { "RCV" } else { "PAY" };
    Ok(format!("{prefix}-{:06}", n))
}

#[tauri::command]
pub fn financial_tx_list(limit: Option<i64>) -> Result<Vec<FinancialTx>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT f.id,f.tx_no,f.tx_date,f.tx_type,f.party_type,f.party_id,
                CASE f.party_type WHEN 'customer' THEN (SELECT name_ar FROM customers_local WHERE id=f.party_id)
                                  WHEN 'supplier' THEN (SELECT name_ar FROM suppliers_local WHERE id=f.party_id)
                                  ELSE NULL END,
                f.cash_box_id,f.bank_id,f.counter_account_id,f.amount,f.description,f.je_id
         FROM financial_transactions_local f ORDER BY f.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(FinancialTx {
        id: r.get(0)?, tx_no: r.get(1)?, tx_date: r.get(2)?, tx_type: r.get(3)?, party_type: r.get(4)?, party_id: r.get(5)?,
        party_name: r.get(6)?, cash_box_id: r.get(7)?, bank_id: r.get(8)?, counter_account_id: r.get(9)?,
        amount: r.get(10)?, description: r.get(11)?, je_id: r.get(12)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn financial_tx_create(input: FinancialTxInput) -> Result<i64, String> {
    if input.amount <= 0.0 { return Err("المبلغ يجب أن يكون أكبر من صفر".into()); }
    if !["receipt","payment"].contains(&input.tx_type.as_str()) { return Err("نوع المعاملة غير صالح".into()); }
    match (input.cash_box_id.is_some(), input.bank_id.is_some()) {
        (false, false) => return Err("اختر خزينة أو بنك".into()),
        (true,  true)  => return Err("اختر خزينة أو بنك — وليس كليهما".into()),
        _ => {}
    }

    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let tx_no = next_fintx_no(&tx, &input.tx_type).map_err(|e| e.to_string())?;

    // Resolve our cash/bank account (the side that moves the cash).
    let cash_account_id: i64 = if let Some(cb) = input.cash_box_id {
        tx.query_row("SELECT account_id FROM cash_boxes_local WHERE id=?1", params![cb], |r| r.get(0)).map_err(|e| e.to_string())?
    } else if let Some(b) = input.bank_id {
        tx.query_row("SELECT account_id FROM banks_local WHERE id=?1", params![b], |r| r.get(0)).map_err(|e| e.to_string())?
    } else { unreachable!() };

    // Resolve counter account: party AP/AR if party_type set, else explicit counter_account_id.
    let counter_acc: i64 = match input.party_type.as_deref() {
        Some("supplier") => {
            let pid = input.party_id.ok_or("اختر المورد")?;
            tx.query_row("SELECT ap_account_id FROM suppliers_local WHERE id=?1", params![pid], |r| r.get(0)).map_err(|e| e.to_string())?
        }
        Some("customer") => {
            // Use AR account 1500 for all customers (kept simple in standalone)
            account_id_by_code(&tx, "1500").map_err(|e| e.to_string())?
        }
        _ => input.counter_account_id.ok_or("اختر الحساب المقابل")?,
    };

    tx.execute(
        "INSERT INTO financial_transactions_local(tx_no,tx_date,tx_type,party_type,party_id,cash_box_id,bank_id,counter_account_id,amount,description)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![tx_no, input.tx_date, input.tx_type, input.party_type, input.party_id, input.cash_box_id, input.bank_id, counter_acc, input.amount, input.description],
    ).map_err(|e| e.to_string())?;
    let ftx_id = tx.last_insert_rowid();

    // JE:
    //   receipt → DR cash/bank, CR counter
    //   payment → DR counter, CR cash/bank
    let (dr_acc, cr_acc) = if input.tx_type == "receipt" {
        (cash_account_id, counter_acc)
    } else { (counter_acc, cash_account_id) };

    let lines = vec![
        JournalEntryLine { id: None, account_id: dr_acc, account_code: None, account_name: None, debit: input.amount, credit: 0.0, description: input.description.clone() },
        JournalEntryLine { id: None, account_id: cr_acc, account_code: None, account_name: None, debit: 0.0, credit: input.amount, description: None },
    ];
    let je_id = insert_journal_entry(
        &tx, &input.tx_date,
        Some(&format!("{} {tx_no}", if input.tx_type == "receipt" { "سند قبض" } else { "سند صرف" })),
        Some(if input.tx_type == "receipt" { "receipt" } else { "payment" }),
        Some(ftx_id), &lines,
    ).map_err(|e| e.to_string())?;
    tx.execute("UPDATE financial_transactions_local SET je_id=?1 WHERE id=?2", params![je_id, ftx_id]).map_err(|e| e.to_string())?;

    // Shadow balances
    let signed = if input.tx_type == "receipt" { input.amount } else { -input.amount };
    if let Some(cb) = input.cash_box_id {
        tx.execute("UPDATE cash_boxes_local SET balance=balance+?1 WHERE id=?2", params![signed, cb]).map_err(|e| e.to_string())?;
    }
    if let Some(b) = input.bank_id {
        tx.execute("UPDATE banks_local SET balance=balance+?1 WHERE id=?2", params![signed, b]).map_err(|e| e.to_string())?;
    }
    if input.party_type.as_deref() == Some("supplier") {
        // suppliers_local.balance follows AP normal-credit convention (positive = "we owe").
        // Mirrors the JE side exactly:
        //   • payment to supplier  → DR AP / CR cash → AP credit balance ↓  → -amount
        //   • receipt from supplier (refund/over-credit) → DR cash / CR AP → AP credit balance ↑ → +amount
        let supp_delta = if input.tx_type == "receipt" { input.amount } else { -input.amount };
        tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![supp_delta, input.party_id.unwrap()]).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    let _ = now_iso(); let _ = today_iso(); // keep helpers referenced
    Ok(ftx_id)
}
