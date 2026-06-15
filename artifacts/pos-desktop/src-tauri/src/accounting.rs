// Standalone accounting & operations (Task #207).
//
// Tables live in db.rs. This module exposes the Tauri commands that the
// React screens call. All money-moving operations open a transaction,
// insert the row, post a balanced journal entry, and update affected
// account/party balances atomically.

use crate::db;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
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
    pub cost_center_id: Option<i64>,
    pub report_direction: Option<String>,
    pub level: i64,
    pub notes: Option<String>,
    pub is_active: bool,
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
        cost_center_id: r.get(8)?,
        report_direction: r.get(9)?,
        level: r.get(10)?,
        notes: r.get(11)?,
        is_active: r.get::<_, i64>(12)? != 0,
    })
}

#[tauri::command]
pub fn accounts_list() -> Result<Vec<Account>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,type,parent_id,is_leaf,balance,cost_center_id,report_direction,level,notes,is_active FROM accounts_local ORDER BY code"
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
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub report_direction: Option<String>,
    #[serde(default = "default_level")]
    pub level: i64,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

fn default_level() -> i64 { 1 }
fn default_true() -> bool { true }

/// Normalize an optional report_direction: only the two valid buckets are
/// stored; anything else (incl. empty string) collapses to NULL = derive-by-type.
fn norm_report_direction(d: &Option<String>) -> Option<String> {
    match d.as_deref() {
        Some("balance_sheet") => Some("balance_sheet".into()),
        Some("income_statement") => Some("income_statement".into()),
        _ => None,
    }
}

#[tauri::command]
pub fn accounts_create(input: AccountInput) -> Result<i64, String> {
    if !["asset","liability","equity","revenue","expense"].contains(&input.r#type.as_str()) {
        return Err("نوع الحساب غير صالح".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let rd = norm_report_direction(&input.report_direction);
    let level = if input.level < 1 { 1 } else { input.level };
    conn.execute(
        "INSERT INTO accounts_local(code,name_ar,name_en,type,parent_id,is_leaf,cost_center_id,report_direction,level,notes,is_active) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![input.code, input.name_ar, input.name_en, input.r#type, input.parent_id, if input.is_leaf {1} else {0}, input.cost_center_id, rd, level, input.notes, if input.is_active {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود الحساب موجود".to_string() } else { e.to_string() })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn accounts_update(id: i64, input: AccountInput) -> Result<(), String> {
    if !["asset","liability","equity","revenue","expense"].contains(&input.r#type.as_str()) {
        return Err("نوع الحساب غير صالح".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let rd = norm_report_direction(&input.report_direction);
    let level = if input.level < 1 { 1 } else { input.level };
    conn.execute(
        "UPDATE accounts_local SET code=?1,name_ar=?2,name_en=?3,type=?4,parent_id=?5,is_leaf=?6,cost_center_id=?7,report_direction=?8,level=?9,notes=?10,is_active=?11 WHERE id=?12",
        params![input.code, input.name_ar, input.name_en, input.r#type, input.parent_id, if input.is_leaf {1} else {0}, input.cost_center_id, rd, level, input.notes, if input.is_active {1} else {0}, id],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود الحساب موجود".to_string() } else { e.to_string() })?;
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

// ── Document numbering ──
// All document numbers flow through `next_doc_no`, which reads the operator-
// configured series (prefix / next_number / padding) from number_series_local,
// formats the label, then atomically increments next_number INSIDE the caller's
// transaction. Because the read+increment share the tx, two concurrent creates
// can never be handed the same number. The series is seeded in db::migrate, so a
// missing row is a hard error rather than a silent fallback.
fn next_doc_no(conn: &Connection, doc_type: &str) -> Result<String> {
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT prefix, next_number, padding FROM number_series_local WHERE doc_type=?1",
            params![doc_type],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (prefix, next_number, padding) =
        row.ok_or_else(|| anyhow!("سلسلة ترقيم غير معرّفة: {}", doc_type))?;
    let width = if padding < 1 { 1 } else { padding as usize };
    let no = format!("{}{:0width$}", prefix, next_number, width = width);
    conn.execute(
        "UPDATE number_series_local SET next_number = next_number + 1 WHERE doc_type=?1",
        params![doc_type],
    )?;
    Ok(no)
}

fn next_entry_no(conn: &Connection) -> Result<String> {
    next_doc_no(conn, "journal_entry")
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NumberSeries {
    pub doc_type: String,
    pub prefix: String,
    pub next_number: i64,
    pub padding: i64,
}

const NUMBER_SERIES_DOC_TYPES: &[&str] = &[
    "journal_entry",
    "purchase",
    "purchase_return",
    "sales_invoice",
    "sales_return",
    "quotation",
    "sales_order",
    "supplier_settlement",
    "letter_of_credit",
];

#[tauri::command]
pub fn number_series_list() -> Result<Vec<NumberSeries>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    // Return in a stable, meaningful order rather than alphabetical doc_type.
    for dt in NUMBER_SERIES_DOC_TYPES {
        let row = conn
            .query_row(
                "SELECT doc_type, prefix, next_number, padding FROM number_series_local WHERE doc_type=?1",
                params![dt],
                |r| Ok(NumberSeries { doc_type: r.get(0)?, prefix: r.get(1)?, next_number: r.get(2)?, padding: r.get(3)? }),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(r) = row {
            out.push(r);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn number_series_update(doc_type: String, prefix: String, next_number: i64, padding: i64) -> Result<(), String> {
    if !NUMBER_SERIES_DOC_TYPES.contains(&doc_type.as_str()) {
        return Err("نوع مستند غير معروف".into());
    }
    if next_number < 1 {
        return Err("الرقم التالي يجب أن يكون 1 أو أكبر".into());
    }
    if !(1..=12).contains(&padding) {
        return Err("عدد الخانات يجب أن يكون بين 1 و 12".into());
    }
    if prefix.chars().count() > 16 {
        return Err("البادئة طويلة جداً (16 حرفاً كحد أقصى)".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let affected = conn
        .execute(
            "UPDATE number_series_local SET prefix=?1, next_number=?2, padding=?3 WHERE doc_type=?4",
            params![prefix, next_number, padding, doc_type],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("سلسلة الترقيم غير موجودة".into());
    }
    Ok(())
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
    pub entry_type: String,
    pub status: String,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
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

// ── Manual journal-entry CRUD (web-parity) ──
// The manual form carries richer data than the shared `insert_journal_entry`
// path used by system documents: an entry type, a draft/posted status, an
// optional manual document number, and a per-line cost center. To avoid
// touching the ~24 system call-sites that construct `JournalEntryLine`, the
// manual form uses its own dedicated structs + insert path.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManualJeLine {
    #[serde(default)]
    pub id: Option<i64>,
    pub account_id: i64,
    #[serde(default)]
    pub account_code: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    pub debit: f64,
    pub credit: f64,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManualJeDetail {
    pub id: i64,
    pub entry_no: String,
    pub entry_date: String,
    pub description: Option<String>,
    pub entry_type: String,
    pub status: String,
    pub source_type: Option<String>,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
    pub total_debit: f64,
    pub total_credit: f64,
    pub lines: Vec<ManualJeLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualJeInput {
    pub entry_date: String,
    pub description: Option<String>,
    #[serde(default)]
    pub entry_type: Option<String>,
    /// Manual document-number override. When None/empty the next sequence
    /// number is consumed; when set it is used verbatim (must be unique).
    #[serde(default)]
    pub doc_number: Option<String>,
    /// "draft" | "posted". None defaults to "posted".
    #[serde(default)]
    pub status: Option<String>,
    /// Optional analytic dimensions (الفرع / مركز التكلفة). None = untagged.
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    pub lines: Vec<ManualJeLine>,
}

const VALID_ENTRY_TYPES: &[&str] = &["general", "opening", "closing", "adjustment", "depreciation"];

fn norm_entry_type(v: Option<&str>) -> String {
    match v {
        Some(s) if VALID_ENTRY_TYPES.contains(&s) => s.to_string(),
        _ => "general".to_string(),
    }
}

/// Keeps only lines that reference a real account AND carry a non-zero amount.
fn valid_manual_lines(lines: &[ManualJeLine]) -> Vec<&ManualJeLine> {
    lines.iter().filter(|l| l.account_id > 0 && (l.debit.abs() > 1e-9 || l.credit.abs() > 1e-9)).collect()
}

/// Validates a manual entry that is about to be POSTED. Draft entries skip this.
fn validate_posted(valid: &[&ManualJeLine]) -> Result<(f64, f64), String> {
    if valid.len() < 2 { return Err("القيد المرحَّل يحتاج سطرين صالحين على الأقل".into()); }
    let total_debit: f64 = valid.iter().map(|l| l.debit).sum();
    let total_credit: f64 = valid.iter().map(|l| l.credit).sum();
    if total_debit <= 1e-9 { return Err("إجمالي القيد يجب أن يكون أكبر من صفر".into()); }
    if (total_debit - total_credit).abs() > 0.001 {
        return Err(format!("القيد غير متوازن: مدين={total_debit:.2} دائن={total_credit:.2}"));
    }
    Ok((total_debit, total_credit))
}

/// Inserts the manual-entry lines for `je_id`, propagating the header cost
/// center to any line that has none. Applies the balance impact only when the
/// entry is being posted (drafts have zero balance effect).
fn write_manual_lines(
    tx: &Transaction,
    je_id: i64,
    valid: &[&ManualJeLine],
    header_cc: Option<i64>,
    post: bool,
) -> Result<()> {
    for l in valid {
        let line_cc = l.cost_center_id.or(header_cc);
        tx.execute(
            "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit,description,cost_center_id) VALUES(?1,?2,?3,?4,?5,?6)",
            params![je_id, l.account_id, l.debit, l.credit, l.description, line_cc],
        )?;
        if post {
            apply_balance(tx, l.account_id, l.debit, l.credit)?;
        }
    }
    Ok(())
}

/// Reverses the balance impact of every posted line of `je_id` (debit/credit
/// swapped). Used before re-saving an edit or unposting/deleting.
fn reverse_je_balance(tx: &Transaction, je_id: i64) -> Result<()> {
    let mut stmt = tx.prepare("SELECT account_id, debit, credit FROM journal_entry_lines_local WHERE entry_id=?1")?;
    let rows: Vec<(i64, f64, f64)> = stmt
        .query_map(params![je_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (acc, debit, credit) in rows {
        // Swap debit/credit to undo the original apply_balance.
        apply_balance(tx, acc, credit, debit)?;
    }
    Ok(())
}

/// Loads (source_type, status) for a manual-CRUD guard, erroring when the
/// entry is system-generated (only NULL or 'manual' may be edited/deleted).
fn load_manual_guard(conn: &Connection, id: i64) -> Result<(Option<String>, String), String> {
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT source_type, status FROM journal_entries_local WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (source_type, status) = row.ok_or_else(|| "القيد غير موجود".to_string())?;
    if let Some(s) = &source_type {
        if s != "manual" {
            return Err("هذا القيد مُولّد تلقائياً من مستند آخر — افتح المستند الأصلي لفك ترحيله بدلاً من تعديله مباشرة".into());
        }
    }
    Ok((source_type, status))
}

/// Raw value of an `app_settings` key within the current transaction
/// (`None` when the row is absent). Reading inside the doc-create tx avoids a
/// second SQLite handle and keeps the read consistent with the write.
fn setting_raw_tx(tx: &Transaction, key: &str) -> Option<String> {
    tx.query_row("SELECT value FROM app_settings WHERE key=?1", params![key], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

fn truthy(v: &str) -> bool { v == "1" || v.eq_ignore_ascii_case("true") }

/// Decides whether a freshly-created document of `doc_type` posts its journal
/// entry to the general ledger immediately (auto) or leaves it as a DRAFT for
/// مركز الترحيل (manual). A per-type override `auto_post_<doc_type>` wins;
/// otherwise the master `auto_posting_enabled` flag decides. Default is MANUAL
/// (draft) — the master flag is absent/"0" until the user opts in via
/// التحكم العام. Regardless of this flag, the sub-ledger (party + cash/bank
/// shadow balances and the document-driven party statement) updates on save;
/// only the GL impact is deferred until posting.
fn resolve_auto_post(tx: &Transaction, doc_type: &str) -> bool {
    if let Some(per) = setting_raw_tx(tx, &format!("auto_post_{doc_type}")) {
        return truthy(&per);
    }
    setting_raw_tx(tx, "auto_posting_enabled").map(|v| truthy(&v)).unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn insert_journal_entry(
    tx: &Transaction,
    entry_date: &str,
    description: Option<&str>,
    source_type: Option<&str>,
    source_id: Option<i64>,
    branch_id: Option<i64>,
    cost_center_id: Option<i64>,
    lines: &[JournalEntryLine],
    post: bool,
) -> Result<i64> {
    let total_debit: f64 = lines.iter().map(|l| l.debit).sum();
    let total_credit: f64 = lines.iter().map(|l| l.credit).sum();
    if (total_debit - total_credit).abs() > 0.001 {
        return Err(anyhow!(format!("القيد غير متوازن: مدين={total_debit:.2} دائن={total_credit:.2}")));
    }
    if lines.len() < 2 { return Err(anyhow!("القيد يحتاج سطرين على الأقل")); }
    // Period-lock: an auto-posted document landing in a closed fiscal period is
    // rejected (same guard the manual/Posting-Center path enforces). Draft docs
    // are unaffected — their GL impact is deferred until they are posted, and
    // that posting path is guarded too.
    if post {
        guard_period_open_for_date(tx, entry_date).map_err(|e| anyhow!(e))?;
    }
    // When `post` is false the entry is stored as a DRAFT: it has NO general-
    // ledger impact (apply_balance is skipped) until it is posted from مركز
    // الترحيل. The caller still updates party/cash/bank shadow balances
    // unconditionally, so the sub-ledger reflects the document immediately.
    let status = if post { "posted" } else { "draft" };
    let entry_no = next_entry_no(tx)?;
    tx.execute(
        "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,source_id,branch_id,cost_center_id,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![entry_no, entry_date, description, total_debit, total_credit, source_type, source_id, branch_id, cost_center_id, status],
    )?;
    let je_id = tx.last_insert_rowid();
    for l in lines {
        // Propagate the header cost center to every line so line-level report
        // queries can filter without a header join.
        tx.execute(
            "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit,description,cost_center_id) VALUES(?1,?2,?3,?4,?5,?6)",
            params![je_id, l.account_id, l.debit, l.credit, l.description, cost_center_id],
        )?;
        if post {
            apply_balance(tx, l.account_id, l.debit, l.credit)?;
        }
    }
    Ok(je_id)
}

// ───────────────────── Posting policy (التحكم العام) ──────────────────
// Master + per-doc-type toggles deciding whether new documents post their JE
// straight to the GL (auto) or stay as a draft for مركز الترحيل (manual).
// `None` on a per-type field means "follow the master flag".
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PostingSettings {
    pub auto_posting_enabled: bool,
    pub sale: Option<bool>,
    pub purchase: Option<bool>,
    pub sale_return: Option<bool>,
    pub purchase_return: Option<bool>,
    pub voucher: Option<bool>,
    pub treasury_transfer: Option<bool>,
}

fn setting_raw_conn(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", params![key], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

fn setting_opt_bool(conn: &Connection, key: &str) -> Option<bool> {
    setting_raw_conn(conn, key).map(|v| truthy(&v))
}

#[tauri::command]
pub fn posting_settings_get() -> Result<PostingSettings, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    Ok(PostingSettings {
        auto_posting_enabled: setting_opt_bool(&conn, "auto_posting_enabled").unwrap_or(false),
        sale: setting_opt_bool(&conn, "auto_post_sale"),
        purchase: setting_opt_bool(&conn, "auto_post_purchase"),
        sale_return: setting_opt_bool(&conn, "auto_post_sale_return"),
        purchase_return: setting_opt_bool(&conn, "auto_post_purchase_return"),
        voucher: setting_opt_bool(&conn, "auto_post_voucher"),
        treasury_transfer: setting_opt_bool(&conn, "auto_post_treasury_transfer"),
    })
}

#[tauri::command]
pub fn posting_settings_set(input: PostingSettings) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    // Master flag always persisted as an explicit "1"/"0".
    conn.execute(
        "INSERT INTO app_settings(key,value) VALUES('auto_posting_enabled',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![if input.auto_posting_enabled { "1" } else { "0" }],
    ).map_err(|e| e.to_string())?;
    // Per-type overrides: Some(b) writes "1"/"0"; None removes the row so the
    // type falls back to the master flag.
    let per: [(&str, Option<bool>); 6] = [
        ("auto_post_sale", input.sale),
        ("auto_post_purchase", input.purchase),
        ("auto_post_sale_return", input.sale_return),
        ("auto_post_purchase_return", input.purchase_return),
        ("auto_post_voucher", input.voucher),
        ("auto_post_treasury_transfer", input.treasury_transfer),
    ];
    for (key, val) in per {
        match val {
            Some(b) => {
                conn.execute(
                    "INSERT INTO app_settings(key,value) VALUES(?1,?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, if b { "1" } else { "0" }],
                ).map_err(|e| e.to_string())?;
            }
            None => {
                conn.execute("DELETE FROM app_settings WHERE key=?1", params![key])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn journal_entries_list(limit: Option<i64>) -> Result<Vec<JournalEntry>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT id,entry_no,entry_date,description,total_debit,total_credit,source_type,source_id,entry_type,status,branch_id,cost_center_id
         FROM journal_entries_local ORDER BY id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(JournalEntry {
        id: r.get(0)?, entry_no: r.get(1)?, entry_date: r.get(2)?, description: r.get(3)?,
        total_debit: r.get(4)?, total_credit: r.get(5)?, source_type: r.get(6)?, source_id: r.get(7)?,
        entry_type: r.get(8)?, status: r.get(9)?, branch_id: r.get(10)?, cost_center_id: r.get(11)?,
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
        "SELECT id,entry_no,entry_date,description,total_debit,total_credit,source_type,source_id,entry_type,status,branch_id,cost_center_id FROM journal_entries_local WHERE id=?1",
        params![id], |r| Ok(JournalEntry {
            id: r.get(0)?, entry_no: r.get(1)?, entry_date: r.get(2)?, description: r.get(3)?,
            total_debit: r.get(4)?, total_credit: r.get(5)?, source_type: r.get(6)?, source_id: r.get(7)?,
            entry_type: r.get(8)?, status: r.get(9)?, branch_id: r.get(10)?, cost_center_id: r.get(11)?,
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

/// Read-only peek of the next manual JE number WITHOUT consuming the sequence
/// (mirrors the web "الرقم المقترح" badge). The number is only actually
/// reserved inside `journal_entry_create` when the form is saved.
#[tauri::command]
pub fn journal_entry_peek_number() -> Result<String, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT prefix, next_number, padding FROM number_series_local WHERE doc_type='journal_entry'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (prefix, next_number, padding) = row.ok_or_else(|| "سلسلة ترقيم القيود غير معرّفة".to_string())?;
    let width = if padding < 1 { 1 } else { padding as usize };
    Ok(format!("{}{:0width$}", prefix, next_number, width = width))
}

/// Resolves the entry number for a new manual JE: a non-empty manual override
/// is used verbatim (and the sequence is left untouched); otherwise the next
/// sequence number is atomically consumed.
fn resolve_manual_entry_no(tx: &Transaction, doc_number: Option<&str>) -> Result<String> {
    match doc_number.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(manual) => Ok(manual.to_string()),
        None => next_entry_no(tx),
    }
}

fn map_entry_no_conflict(e: rusqlite::Error) -> String {
    let msg = e.to_string();
    if msg.contains("UNIQUE") {
        "رقم القيد مستخدَم بالفعل — اختر رقماً آخر".into()
    } else {
        msg
    }
}

#[tauri::command]
pub fn journal_entry_create(input: ManualJeInput) -> Result<i64, String> {
    let status = match input.status.as_deref() { Some("draft") => "draft", _ => "posted" };
    let entry_type = norm_entry_type(input.entry_type.as_deref());
    let valid = valid_manual_lines(&input.lines);
    let post = status == "posted";
    let (total_debit, total_credit) = if post {
        validate_posted(&valid)?
    } else {
        if valid.is_empty() { return Err("أضف سطراً واحداً صالحاً على الأقل".into()); }
        (valid.iter().map(|l| l.debit).sum(), valid.iter().map(|l| l.credit).sum())
    };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Period-lock: a manual entry created directly as `posted` applies GL
    // balances, so it must respect a closed fiscal period just like the
    // Posting Center path. Drafts touch no GL and are always allowed.
    if post { guard_period_open_for_date(&tx, &input.entry_date)?; }
    let entry_no = resolve_manual_entry_no(&tx, input.doc_number.as_deref()).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,source_id,branch_id,cost_center_id,entry_type,status) \
         VALUES(?1,?2,?3,?4,?5,'manual',NULL,?6,?7,?8,?9)",
        params![entry_no, input.entry_date, input.description, total_debit, total_credit, input.branch_id, input.cost_center_id, entry_type, status],
    ).map_err(map_entry_no_conflict)?;
    let je_id = tx.last_insert_rowid();
    write_manual_lines(&tx, je_id, &valid, input.cost_center_id, post).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(je_id)
}

/// Full detail (incl. per-line cost center) for the manual edit form.
#[tauri::command]
pub fn journal_entry_detail(id: i64) -> Result<ManualJeDetail, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut entry: ManualJeDetail = conn.query_row(
        "SELECT id,entry_no,entry_date,description,entry_type,status,source_type,branch_id,cost_center_id,total_debit,total_credit FROM journal_entries_local WHERE id=?1",
        params![id], |r| Ok(ManualJeDetail {
            id: r.get(0)?, entry_no: r.get(1)?, entry_date: r.get(2)?, description: r.get(3)?,
            entry_type: r.get(4)?, status: r.get(5)?, source_type: r.get(6)?,
            branch_id: r.get(7)?, cost_center_id: r.get(8)?, total_debit: r.get(9)?, total_credit: r.get(10)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT l.id,l.account_id,a.code,a.name_ar,l.debit,l.credit,l.description,l.cost_center_id
         FROM journal_entry_lines_local l
         JOIN accounts_local a ON a.id=l.account_id
         WHERE l.entry_id=?1 ORDER BY l.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(ManualJeLine {
        id: r.get(0)?, account_id: r.get(1)?, account_code: r.get(2)?, account_name: r.get(3)?,
        debit: r.get(4)?, credit: r.get(5)?, description: r.get(6)?, cost_center_id: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { entry.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(entry)
}

/// Rewrites a manual JE in place. System-generated entries are rejected. The
/// document number is immutable on edit (only set at creation). When the entry
/// was posted its old balance impact is reversed first; the new status decides
/// whether the rewritten lines re-apply to balances.
#[tauri::command]
pub fn journal_entry_update(id: i64, input: ManualJeInput) -> Result<(), String> {
    let new_status = match input.status.as_deref() { Some("draft") => "draft", _ => "posted" };
    let entry_type = norm_entry_type(input.entry_type.as_deref());
    let valid = valid_manual_lines(&input.lines);
    let post = new_status == "posted";
    let (total_debit, total_credit) = if post {
        validate_posted(&valid)?
    } else {
        if valid.is_empty() { return Err("أضف سطراً واحداً صالحاً على الأقل".into()); }
        (valid.iter().map(|l| l.debit).sum(), valid.iter().map(|l| l.credit).sum())
    };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let (_src, old_status) = load_manual_guard(&conn, id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Period-lock: reversing an already-posted entry, or (re)posting the
    // rewritten lines, both move GL balances — reject if either the existing
    // entry's period or the new entry date falls in a closed period.
    if old_status == "posted" { guard_period_open_for_entry(&tx, id)?; }
    if post { guard_period_open_for_date(&tx, &input.entry_date)?; }
    if old_status == "posted" {
        reverse_je_balance(&tx, id).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE journal_entries_local SET entry_date=?1,description=?2,total_debit=?3,total_credit=?4,branch_id=?5,cost_center_id=?6,entry_type=?7,status=?8 WHERE id=?9",
        params![input.entry_date, input.description, total_debit, total_credit, input.branch_id, input.cost_center_id, entry_type, new_status, id],
    ).map_err(|e| e.to_string())?;
    write_manual_lines(&tx, id, &valid, input.cost_center_id, post).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Posts a manual draft: validates balance, applies the balance impact, flips
/// status to 'posted'.
#[tauri::command]
pub fn journal_entry_post(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let (_src, status) = load_manual_guard(&conn, id)?;
    if status != "draft" { return Err("هذا القيد ليس مسودة".into()); }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    post_je_core(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Unposts a manual posted entry back to draft, reversing its balance impact.
#[tauri::command]
pub fn journal_entry_unpost(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let (_src, status) = load_manual_guard(&conn, id)?;
    if status != "posted" { return Err("هذا القيد ليس مرحَّلاً".into()); }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    unpost_je_core(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ───────── Fiscal-period lock guard ─────────
// Rejects posting / unposting a journal entry whose date falls inside a fiscal
// period that has been soft-closed (`closed`) or hard-closed
// (`permanently_closed`). Entries whose date is outside any defined period are
// always allowed — fiscal-period setup is optional, so a company that never
// created periods is never blocked. The date is normalised to its YYYY-MM-DD
// prefix so timestamps (if any) still match a period's day range.
pub(crate) fn guard_period_open_for_date(tx: &Transaction, date: &str) -> Result<(), String> {
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM fiscal_periods_local \
             WHERE substr(?1,1,10) >= start_date AND substr(?1,1,10) <= end_date \
             ORDER BY start_date DESC LIMIT 1",
            params![date],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match status.as_deref() {
        Some("closed") => Err(
            "لا يمكن الترحيل — الفترة المحاسبية لهذا التاريخ مقفلة (إقفال ناعم). افتح الفترة من شاشة الفترات المحاسبية أولاً".into(),
        ),
        Some("permanently_closed") => Err(
            "لا يمكن الترحيل — الفترة المحاسبية لهذا التاريخ مقفلة نهائياً".into(),
        ),
        _ => Ok(()),
    }
}

pub(crate) fn guard_period_open_for_entry(tx: &Transaction, id: i64) -> Result<(), String> {
    let entry_date: Option<String> = tx
        .query_row("SELECT entry_date FROM journal_entries_local WHERE id=?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match entry_date {
        Some(d) => guard_period_open_for_date(tx, &d),
        None => Ok(()),
    }
}

/// Inserts a fully-balanced CLOSING journal entry (posted immediately) used by
/// the fiscal-period closing wizard. Tagged with `entry_type` + `period_id` so
/// the hard-close step can verify the closing cycle actually ran. Always posts
/// (bypasses the auto/manual toggle) and is marked `source_type='closing'` so
/// the manual JE editor refuses to touch it. Reuses `next_entry_no` +
/// `apply_balance` so numbering and GL impact match every other posted entry.
pub(crate) fn insert_closing_entry(
    tx: &Transaction,
    entry_date: &str,
    description: &str,
    entry_type: &str,
    period_id: i64,
    lines: &[JournalEntryLine],
) -> Result<i64, String> {
    let total_debit: f64 = lines.iter().map(|l| l.debit).sum();
    let total_credit: f64 = lines.iter().map(|l| l.credit).sum();
    if (total_debit - total_credit).abs() > 0.001 {
        return Err(format!("قيد الإقفال غير متوازن: مدين={total_debit:.2} دائن={total_credit:.2}"));
    }
    if lines.len() < 2 {
        return Err("قيد الإقفال يحتاج سطرين على الأقل".into());
    }
    let entry_no = next_entry_no(tx).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,entry_type,status,period_id) \
         VALUES(?1,?2,?3,?4,?5,'closing',?6,'posted',?7)",
        params![entry_no, entry_date, description, total_debit, total_credit, entry_type, period_id],
    )
    .map_err(|e| e.to_string())?;
    let je_id = tx.last_insert_rowid();
    for l in lines {
        tx.execute(
            "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit,description) VALUES(?1,?2,?3,?4,?5)",
            params![je_id, l.account_id, l.debit, l.credit, l.description],
        )
        .map_err(|e| e.to_string())?;
        apply_balance(tx, l.account_id, l.debit, l.credit).map_err(|e| e.to_string())?;
    }
    Ok(je_id)
}

// ───────── Shared post / unpost core (used by both the manual JE editor and
//           the Posting Center). The CALLER decides whether a source-doc JE may
//           be touched: the manual editor guards manual-only, the Posting Center
//           posts ANY draft. These never re-touch shadow balances — those were
//           applied unconditionally at document-create time. ────────────────
fn post_je_core(tx: &Transaction, id: i64) -> Result<(), String> {
    // Reject posting into a closed fiscal period (period-lock guard).
    guard_period_open_for_entry(tx, id)?;
    let mut stmt = tx.prepare("SELECT account_id,debit,credit FROM journal_entry_lines_local WHERE entry_id=?1").map_err(|e| e.to_string())?;
    let lines: Vec<(i64, f64, f64)> = stmt
        .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    if lines.len() < 2 { return Err("القيد المرحَّل يحتاج سطرين على الأقل".into()); }
    let td: f64 = lines.iter().map(|l| l.1).sum();
    let tc: f64 = lines.iter().map(|l| l.2).sum();
    if td <= 1e-9 { return Err("إجمالي القيد يجب أن يكون أكبر من صفر".into()); }
    if (td - tc).abs() > 0.001 { return Err(format!("القيد غير متوازن: مدين={td:.2} دائن={tc:.2}")); }
    for (acc, debit, credit) in &lines { apply_balance(tx, *acc, *debit, *credit).map_err(|e| e.to_string())?; }
    tx.execute("UPDATE journal_entries_local SET status='posted' WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn unpost_je_core(tx: &Transaction, id: i64) -> Result<(), String> {
    guard_period_open_for_entry(tx, id)?;
    reverse_je_balance(tx, id).map_err(|e| e.to_string())?;
    tx.execute("UPDATE journal_entries_local SET status='draft' WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// مركز الترحيل — bulk-post the given draft entries (ANY source, incl. document
/// auto-generated drafts). Skips ids that are not currently drafts. Runs in ONE
/// transaction: if any entry fails (unbalanced / closed period) the whole batch
/// rolls back and the error is returned.
#[tauri::command]
pub fn posting_center_post(ids: Vec<i64>) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut done = 0i64;
    for id in ids {
        let status: Option<String> = tx
            .query_row("SELECT status FROM journal_entries_local WHERE id=?1", params![id], |r| r.get(0))
            .optional().map_err(|e| e.to_string())?;
        match status.as_deref() {
            Some("draft") => { post_je_core(&tx, id)?; done += 1; }
            _ => {} // already posted or missing → skip
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(done)
}

/// مركز الترحيل — bulk-unpost the given posted entries back to draft, reversing
/// their GL impact. Allowed for ANY source here (the Posting Center is the
/// authoritative posting console); skips ids that are not currently posted.
#[tauri::command]
pub fn posting_center_unpost(ids: Vec<i64>) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut done = 0i64;
    for id in ids {
        let status: Option<String> = tx
            .query_row("SELECT status FROM journal_entries_local WHERE id=?1", params![id], |r| r.get(0))
            .optional().map_err(|e| e.to_string())?;
        match status.as_deref() {
            Some("posted") => { unpost_je_core(&tx, id)?; done += 1; }
            _ => {}
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(done)
}

/// Deletes a manual entry (drafts or posted). A posted entry's balance impact
/// is reversed first. System-generated entries are rejected.
#[tauri::command]
pub fn journal_entry_delete(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let (_src, status) = load_manual_guard(&conn, id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if status == "posted" {
        reverse_je_balance(&tx, id).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM journal_entries_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
    pub currency_code: String,
    pub email: Option<String>,
    pub cr_number: Option<String>,
    pub city: Option<String>,
    pub district: Option<String>,
    pub street: Option<String>,
    pub building_number: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub national_address_short: Option<String>,
    pub include_in_statements: bool,
    pub ap_account_id: Option<i64>,
    pub group_id: Option<i64>,
}

fn row_to_supplier(r: &rusqlite::Row<'_>) -> rusqlite::Result<Supplier> {
    Ok(Supplier {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        phone: r.get(4)?, vat_number: r.get(5)?, balance: r.get(6)?, notes: r.get(7)?,
        currency_code: r.get::<_, Option<String>>(8)?.unwrap_or_else(|| "SAR".to_string()),
        email: r.get(9)?, cr_number: r.get(10)?, city: r.get(11)?, district: r.get(12)?,
        street: r.get(13)?, building_number: r.get(14)?, postal_code: r.get(15)?,
        country: r.get(16)?, national_address_short: r.get(17)?,
        include_in_statements: r.get::<_, i64>(18)? != 0, ap_account_id: r.get(19)?,
        group_id: r.get(20)?,
    })
}

#[tauri::command]
pub fn suppliers_list() -> Result<Vec<Supplier>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,phone,vat_number,balance,notes,currency_code,\
                email,cr_number,city,district,street,building_number,postal_code,country,national_address_short,include_in_statements,ap_account_id,group_id \
         FROM suppliers_local ORDER BY name_ar"
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
    #[serde(default)]
    pub currency_code: Option<String>,
    // Opening balance (applied on create only; ignored on update).
    #[serde(default)]
    pub opening_balance: Option<f64>,
    #[serde(default)]
    pub opening_nature: Option<String>, // "debit" | "credit"
    #[serde(default)]
    pub opening_date: Option<String>,
    // ── Profile parity with web (Phase W2) ──
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub cr_number: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub district: Option<String>,
    #[serde(default)]
    pub street: Option<String>,
    #[serde(default)]
    pub building_number: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub national_address_short: Option<String>,
    #[serde(default)]
    pub include_in_statements: Option<bool>,
    /// Editable payables control account; falls back to 2100 when absent.
    #[serde(default)]
    pub ap_account_id: Option<i64>,
    /// Optional supplier-group classification (soft ref to supplier_groups_local).
    #[serde(default)]
    pub group_id: Option<i64>,
}

#[tauri::command]
pub fn suppliers_create(input: SupplierInput) -> Result<i64, String> {
    if input.name_ar.trim().is_empty() { return Err("اسم المورد مطلوب".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Explicit payables pick wins, else the default payables control (2100).
    let ap = match input.ap_account_id {
        Some(a) if a > 0 => a,
        _ => account_id_by_code(&tx, "2100").map_err(|e| e.to_string())?,
    };
    let cur = input.currency_code.clone().unwrap_or_else(|| "SAR".to_string());
    let include = if input.include_in_statements.unwrap_or(true) { 1 } else { 0 };
    let country = input.country.clone().or_else(|| Some("SA".to_string()));
    tx.execute(
        "INSERT INTO suppliers_local(code,name_ar,name_en,phone,vat_number,notes,ap_account_id,currency_code,\
                email,cr_number,city,district,street,building_number,postal_code,country,national_address_short,include_in_statements,group_id) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![input.code, input.name_ar, input.name_en, input.phone, input.vat_number, input.notes, ap, cur,
                input.email, input.cr_number, input.city, input.district, input.street, input.building_number,
                input.postal_code, country, input.national_address_short, include, input.group_id.filter(|g| *g > 0)],
    ).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    let ob = input.opening_balance.unwrap_or(0.0).abs();
    if ob > 1e-9 {
        let nature = input.opening_nature.as_deref().unwrap_or("credit");
        let date = resolve_opening_date(&tx, input.opening_date.as_deref()).map_err(|e| e.to_string())?;
        post_party_opening_balance(&tx, "supplier", id, &cur, ob, nature, &date).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

fn resolve_opening_date(conn: &Connection, given: Option<&str>) -> Result<String> {
    match given {
        Some(d) if !d.trim().is_empty() => Ok(d.to_string()),
        _ => Ok(conn.query_row("SELECT date('now','localtime')", [], |r| r.get(0))?),
    }
}

/// Posts a balanced opening-balance JE for a customer/supplier against equity
/// (3000) and updates the party shadow balance. `amount` is native (>0) and is
/// converted to base via the current FX rate. Runs inside the caller's tx so
/// the party row + JE + balance all commit atomically.
pub(crate) fn post_party_opening_balance(
    tx: &Transaction,
    party_type: &str,
    party_id: i64,
    currency_code: &str,
    amount: f64,
    nature: &str,
    date: &str,
) -> Result<i64> {
    if nature != "debit" && nature != "credit" {
        return Err(anyhow!("نوع الرصيد يجب أن يكون مدين أو دائن"));
    }
    let rate = current_rate_to_base(tx, currency_code)?;
    let amount_base = amount * rate;
    let equity = account_id_by_code(tx, "3000")?;
    let party_acc = match party_type {
        "supplier" => tx
            .query_row("SELECT ap_account_id FROM suppliers_local WHERE id=?1", params![party_id], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .map(Ok)
            .unwrap_or_else(|| account_id_by_code(tx, "2100"))?,
        "customer" => account_id_by_code(tx, "1500")?,
        _ => return Err(anyhow!("نوع طرف غير معروف")),
    };
    let desc = "رصيد افتتاحي".to_string();
    let debit_party = nature == "debit";
    let lines = vec![
        JournalEntryLine {
            id: None, account_id: party_acc, account_code: None, account_name: None,
            debit: if debit_party { amount_base } else { 0.0 },
            credit: if debit_party { 0.0 } else { amount_base },
            description: Some(desc.clone()),
        },
        JournalEntryLine {
            id: None, account_id: equity, account_code: None, account_name: None,
            debit: if debit_party { 0.0 } else { amount_base },
            credit: if debit_party { amount_base } else { 0.0 },
            description: Some(desc.clone()),
        },
    ];
    // Opening balances are a setup action — always posted to the GL.
    let je_id = insert_journal_entry(tx, date, Some(&desc), Some("opening_balance"), Some(party_id), None, None, &lines, true)?;
    match party_type {
        // supplier balance: positive = we owe (credit nature)
        "supplier" => {
            let delta = if nature == "credit" { amount_base } else { -amount_base };
            tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![delta, party_id])?;
        }
        // customer balance: positive = they owe us (debit nature)
        "customer" => {
            let delta = if nature == "debit" { amount_base } else { -amount_base };
            tx.execute("UPDATE customers_local SET balance=balance+?1 WHERE id=?2", params![delta, party_id])?;
        }
        _ => {}
    }
    Ok(je_id)
}

#[tauri::command]
pub fn suppliers_update(id: i64, input: SupplierInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    let include = if input.include_in_statements.unwrap_or(true) { 1 } else { 0 };
    // ap_account_id is only overwritten when a positive id is supplied; an
    // omitted/zero value preserves the existing payables control account.
    conn.execute(
        "UPDATE suppliers_local SET code=?1,name_ar=?2,name_en=?3,phone=?4,vat_number=?5,notes=?6,currency_code=?7,\
                email=?8,cr_number=?9,city=?10,district=?11,street=?12,building_number=?13,postal_code=?14,country=?15,\
                national_address_short=?16,include_in_statements=?17,ap_account_id=COALESCE(?18, ap_account_id),group_id=?19 \
         WHERE id=?20",
        params![input.code, input.name_ar, input.name_en, input.phone, input.vat_number, input.notes, cur,
                input.email, input.cr_number, input.city, input.district, input.street, input.building_number,
                input.postal_code, input.country, input.national_address_short, include,
                input.ap_account_id.filter(|a| *a > 0), input.group_id.filter(|g| *g > 0), id],
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
    pub currency_code: String,
}

#[tauri::command]
pub fn cash_boxes_list() -> Result<Vec<CashBox>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,name,balance,account_id,currency_code FROM cash_boxes_local ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(CashBox {
        id: r.get(0)?, name: r.get(1)?, balance: r.get(2)?, account_id: r.get(3)?,
        currency_code: r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "SAR".to_string()),
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
    #[serde(default)]
    pub currency_code: Option<String>,
}

#[tauri::command]
pub fn cash_boxes_create(input: CashBoxInput) -> Result<i64, String> {
    if input.name.trim().is_empty() { return Err("اسم الخزينة مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    // Auto-create child account under 1100 if not provided.
    let acc_id = match input.account_id {
        Some(a) => a,
        None => {
            let parent = account_id_by_code(&conn, "1100").map_err(|e| e.to_string())?;
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM cash_boxes_local", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let code = format!("11{:02}", n + 2);
            let label = if cur == "SAR" { format!("خزينة - {}", input.name) } else { format!("خزينة - {} ({cur})", input.name) };
            conn.execute(
                "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,'asset',?3,1)",
                params![code, label, parent],
            ).map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };
    conn.execute("INSERT INTO cash_boxes_local(name,account_id,currency_code) VALUES(?1,?2,?3)",
        params![input.name, acc_id, cur]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn cash_boxes_update(id: i64, input: CashBoxInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    // Lock currency once balance is non-zero (changing it after deposits would corrupt FX).
    let (cur_now, bal): (String, f64) = conn.query_row(
        "SELECT currency_code,balance FROM cash_boxes_local WHERE id=?1", params![id],
        |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "SAR".to_string()), r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let cur = input.currency_code.clone().unwrap_or_else(|| cur_now.clone());
    if cur != cur_now && bal.abs() > 0.001 {
        return Err("لا يمكن تغيير عملة خزينة لديها رصيد. أصدر تحويل خزينة لتفريغها أولاً.".into());
    }
    conn.execute("UPDATE cash_boxes_local SET name=?1,currency_code=?2 WHERE id=?3",
        params![input.name, cur, id]).map_err(|e| e.to_string())?;
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
    pub currency_code: String,
}

#[tauri::command]
pub fn banks_list() -> Result<Vec<Bank>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,name,account_no,balance,account_id,currency_code FROM banks_local ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Bank {
        id: r.get(0)?, name: r.get(1)?, account_no: r.get(2)?, balance: r.get(3)?, account_id: r.get(4)?,
        currency_code: r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "SAR".to_string()),
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
    #[serde(default)]
    pub currency_code: Option<String>,
}

#[tauri::command]
pub fn banks_create(input: BankInput) -> Result<i64, String> {
    if input.name.trim().is_empty() { return Err("اسم البنك مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    let parent = account_id_by_code(&conn, "1200").map_err(|e| e.to_string())?;
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM banks_local", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let code = format!("12{:02}", n + 1);
    let label = if cur == "SAR" { format!("بنك - {}", input.name) } else { format!("بنك - {} ({cur})", input.name) };
    conn.execute(
        "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES(?1,?2,'asset',?3,1)",
        params![code, label, parent],
    ).map_err(|e| e.to_string())?;
    let acc_id = conn.last_insert_rowid();
    conn.execute("INSERT INTO banks_local(name,account_no,account_id,currency_code) VALUES(?1,?2,?3,?4)",
        params![input.name, input.account_no, acc_id, cur]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn banks_update(id: i64, input: BankInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let (cur_now, bal): (String, f64) = conn.query_row(
        "SELECT currency_code,balance FROM banks_local WHERE id=?1", params![id],
        |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "SAR".to_string()), r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let cur = input.currency_code.clone().unwrap_or_else(|| cur_now.clone());
    if cur != cur_now && bal.abs() > 0.001 {
        return Err("لا يمكن تغيير عملة بنك لديه رصيد. أصدر تحويل خزينة لتفريغه أولاً.".into());
    }
    conn.execute("UPDATE banks_local SET name=?1,account_no=?2,currency_code=?3 WHERE id=?4",
        params![input.name, input.account_no, cur, id]).map_err(|e| e.to_string())?;
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

fn default_conversion_factor() -> f64 { 1.0 }

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
    #[serde(default)]
    pub uom_id: Option<i64>,
    #[serde(default)]
    pub uom_name: Option<String>,
    #[serde(default = "default_conversion_factor")]
    pub conversion_factor: f64,
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
    pub supplier_invoice_no: Option<String>,
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub lc_id: Option<i64>,
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
    /// The supplier's OWN invoice number (free-text reference).
    #[serde(default)]
    pub supplier_invoice_no: Option<String>,
    /// Header warehouse the lines move stock into. None → company default.
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    /// Optional letter-of-credit link. When set, the goods portion (subtotal)
    /// is credited to the LC's settlement account instead of the supplier/cash/
    /// bank, and the LC's used_amount is drawn down. VAT (if any) still credits
    /// the chosen payment account.
    #[serde(default)]
    pub lc_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

fn next_purchase_no(conn: &Connection) -> Result<String> {
    next_doc_no(conn, "purchase")
}

#[tauri::command]
pub fn purchases_list(limit: Option<i64>) -> Result<Vec<Purchase>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT p.id,p.invoice_no,p.supplier_id,s.name_ar,p.invoice_date,p.subtotal,p.vat_total,p.grand_total,
                p.payment_method,p.cash_box_id,p.bank_id,p.je_id,p.notes,p.supplier_invoice_no,p.warehouse_id,p.lc_id
         FROM purchases_local p JOIN suppliers_local s ON s.id=p.supplier_id
         ORDER BY p.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(Purchase {
        id: r.get(0)?, invoice_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
        payment_method: r.get(8)?, cash_box_id: r.get(9)?, bank_id: r.get(10)?, je_id: r.get(11)?,
        notes: r.get(12)?, supplier_invoice_no: r.get(13)?, warehouse_id: r.get(14)?, lc_id: r.get(15)?, lines: Vec::new(),
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
                p.payment_method,p.cash_box_id,p.bank_id,p.je_id,p.notes,p.supplier_invoice_no,p.warehouse_id,p.lc_id
         FROM purchases_local p JOIN suppliers_local s ON s.id=p.supplier_id
         WHERE p.id=?1",
        params![id], |r| Ok(Purchase {
            id: r.get(0)?, invoice_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
            payment_method: r.get(8)?, cash_box_id: r.get(9)?, bank_id: r.get(10)?, je_id: r.get(11)?,
            notes: r.get(12)?, supplier_invoice_no: r.get(13)?, warehouse_id: r.get(14)?, lc_id: r.get(15)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total,pl.uom_id,pl.uom_name,pl.conversion_factor
         FROM purchase_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.purchase_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { p.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(p)
}

#[tauri::command]
pub fn purchase_create(input: PurchaseInput) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let purchase_id = purchase_create_in_tx(&tx, &input)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(purchase_id)
}

/// Header insert + full stock/GL impact for a NEW purchase invoice, inside the
/// caller's transaction. Shared by `purchase_create` (own tx) and the
/// purchase-order → invoice conversion (which wraps it in its own tx so the
/// order-status flip and the invoice creation commit atomically).
fn purchase_create_in_tx(tx: &Transaction, input: &PurchaseInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ فاتورة بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&input.lines);
    let invoice_no = next_purchase_no(tx).map_err(|e| e.to_string())?;
    // Resolve default warehouse for stock ledger inserts (Task #208).
    let default_wh = match input.warehouse_id { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(tx)? };
    tx.execute(
        "INSERT INTO purchases_local(invoice_no,supplier_id,invoice_date,subtotal,vat_total,grand_total,payment_method,cash_box_id,bank_id,notes,branch_id,cost_center_id,supplier_invoice_no,warehouse_id,lc_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![invoice_no, input.supplier_id, input.invoice_date, subtotal, vat_total, grand_total,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes, input.branch_id, input.cost_center_id,
                input.supplier_invoice_no, default_wh, input.lc_id],
    ).map_err(|e| e.to_string())?;
    let purchase_id = tx.last_insert_rowid();

    apply_purchase_impact(tx, purchase_id, &invoice_no, input, subtotal, vat_total, grand_total, default_wh)?;
    Ok(purchase_id)
}

/// Sum the line subtotal / VAT / grand total for a purchase document.
/// `unit_cost` is per selected unit; financial totals are qty × unit_cost.
fn purchase_doc_totals(lines: &[PurchaseLine]) -> (f64, f64, f64) {
    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in lines {
        let line_sub = l.qty * l.unit_cost;
        subtotal += line_sub;
        vat_total += line_sub * l.vat_rate / 100.0;
    }
    (subtotal, vat_total, subtotal + vat_total)
}

/// Inserts the purchase lines + stock-IN ledger + the posted JE + party/treasury
/// shadow bumps for an ALREADY-INSERTED purchase header. Shared by create AND
/// update (update reverses first, then re-applies) so both paths stay identical.
#[allow(clippy::too_many_arguments)]
fn apply_purchase_impact(
    tx: &Transaction,
    purchase_id: i64,
    invoice_no: &str,
    input: &PurchaseInput,
    subtotal: f64,
    vat_total: f64,
    grand_total: f64,
    default_wh: i64,
) -> Result<(), String> {
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_cost;
        let line_vat = line_sub * l.vat_rate / 100.0;
        let lt = line_sub + line_vat;
        tx.execute(
            "INSERT INTO purchase_lines_local(purchase_id,item_id,qty,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor,warehouse_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![purchase_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor, default_wh],
        ).map_err(|e| e.to_string())?;
        // Stock IN: qty converted to BASE units (qty × factor) at cost-per-base
        // (unit_cost ÷ factor) so total cost = qty × unit_cost is preserved.
        crate::inventory::ledger_push_in_tx(
            tx, l.item_id, default_wh, l.qty * factor, l.unit_cost / factor,
            "purchase", Some(purchase_id), &input.invoice_date,
        )?;
    }

    // Build & post JE: DR Inventory(subtotal) + DR VAT-In(vat) / CR (supplier|cash|bank)(grand)
    let inv_acc = account_id_by_code(tx, "1300").map_err(|e| e.to_string())?;
    let vat_in_acc = account_id_by_code(tx, "1400").map_err(|e| e.to_string())?;

    // LC-linked purchase: the goods portion (subtotal) is credited to the LC
    // settlement account, and only the VAT (if any) lands on the chosen payment
    // account. A non-LC purchase credits the whole grand_total to the payment
    // account as before.
    let lc_active = input.lc_id.filter(|x| *x > 0);
    // Resolve the supplier/cash/bank payment account only when something will
    // actually be credited to it (non-LC, or LC with a VAT portion). This avoids
    // demanding a cash box / bank on a VAT-free LC purchase that doesn't use one.
    let need_payment_acc = lc_active.is_none() || vat_total > 0.0;
    let cr_account_id = if need_payment_acc {
        Some(resolve_payment_credit_account(tx, &input.payment_method, input.supplier_id, input.cash_box_id, input.bank_id)
            .map_err(|e| e.to_string())?)
    } else { None };

    let mut lines = vec![
        JournalEntryLine { id: None, account_id: inv_acc, account_code: None, account_name: None, debit: subtotal, credit: 0.0, description: Some(format!("شراء {invoice_no}")) },
    ];
    if vat_total > 0.0 {
        lines.push(JournalEntryLine { id: None, account_id: vat_in_acc, account_code: None, account_name: None, debit: vat_total, credit: 0.0, description: None });
    }
    if let Some(lc_id) = lc_active {
        let (settle_acc, lc_status, lc_supplier): (Option<i64>, String, i64) = tx.query_row(
            "SELECT settlement_account_id, status, supplier_id FROM letters_of_credit_local WHERE id=?1",
            params![lc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|_| "الاعتماد المستندي غير موجود".to_string())?;
        if lc_status == "closed" { return Err("لا يمكن ربط فاتورة باعتماد مقفل".into()); }
        if lc_supplier != input.supplier_id { return Err("الاعتماد المستندي يخص مورّداً آخر".into()); }
        let settle_acc = settle_acc.ok_or_else(|| "حدد حساب تسوية الاعتماد المستندي أولاً".to_string())?;
        lines.push(JournalEntryLine { id: None, account_id: settle_acc, account_code: None, account_name: None, debit: 0.0, credit: subtotal, description: Some(format!("اعتماد مستندي #{lc_id}")) });
        if vat_total > 0.0 {
            lines.push(JournalEntryLine { id: None, account_id: cr_account_id.unwrap(), account_code: None, account_name: None, debit: 0.0, credit: vat_total, description: None });
        }
    } else {
        lines.push(JournalEntryLine { id: None, account_id: cr_account_id.unwrap(), account_code: None, account_name: None, debit: 0.0, credit: grand_total, description: None });
    }

    let je_id = insert_journal_entry(tx, &input.invoice_date, Some(&format!("فاتورة شراء {invoice_no}")), Some("purchase"), Some(purchase_id), input.branch_id, input.cost_center_id, &lines, resolve_auto_post(tx, "purchase"))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE purchases_local SET je_id=?1 WHERE id=?2", params![je_id, purchase_id]).map_err(|e| e.to_string())?;

    // Update party/treasury balance shadow. With an LC link, only the VAT
    // portion moved on the payment account (the goods are funded by the LC).
    let shadow_amt = if lc_active.is_some() { vat_total } else { grand_total };
    if shadow_amt > 0.0 {
        match input.payment_method.as_str() {
            "credit" => { tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![shadow_amt, input.supplier_id]).map_err(|e| e.to_string())?; }
            "cash" => { if let Some(cb) = input.cash_box_id { tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![shadow_amt, cb]).map_err(|e| e.to_string())?; } }
            "bank" => { if let Some(b) = input.bank_id { tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![shadow_amt, b]).map_err(|e| e.to_string())?; } }
            _ => {}
        }
    }

    // Draw down the LC by the goods value and refresh its open/partial status.
    if let Some(lc_id) = lc_active {
        tx.execute("UPDATE letters_of_credit_local SET used_amount=used_amount+?1 WHERE id=?2", params![subtotal, lc_id]).map_err(|e| e.to_string())?;
        lc_recompute_status_in_tx(tx, lc_id)?;
    }
    Ok(())
}

/// Full inverse of `apply_purchase_impact`: reverses+deletes the purchase JE,
/// pushes the received stock back OUT at the SAME per-base cost it entered at,
/// unwinds the party/treasury shadow, and DELETES the purchase lines. The header
/// row is left intact for the caller (update re-applies, delete drops it).
fn reverse_purchase_impact(tx: &Transaction, purchase_id: i64) -> Result<(), String> {
    let (pm, sup, cb, bank, grand, date, gr_src, lc_id, subtotal, vat_total): (String, i64, Option<i64>, Option<i64>, f64, String, Option<i64>, Option<i64>, f64, f64) = tx
        .query_row(
            "SELECT payment_method,supplier_id,cash_box_id,bank_id,grand_total,invoice_date,source_goods_receipt_id,lc_id,subtotal,vat_total FROM purchases_local WHERE id=?1",
            params![purchase_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        )
        .map_err(|e| e.to_string())?;

    // 1) Reverse (only POSTED entries touched the GL) then delete the JE.
    let je_rows: Vec<(i64, String)> = {
        let mut stmt = tx
            .prepare("SELECT id,status FROM journal_entries_local WHERE source_id=?1 AND source_type='purchase'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![purchase_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows { v.push(r.map_err(|e| e.to_string())?); }
        v
    };
    for (je_id, status) in &je_rows {
        if status == "posted" {
            reverse_je_balance(tx, *je_id).map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![je_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM journal_entries_local WHERE id=?1", params![je_id]).map_err(|e| e.to_string())?;
    }

    // 2) Remove the stock that came IN: push the BASE units back OUT at the SAME
    //    per-base cost (stored unit_cost ÷ factor) so the running balance unwinds
    //    to exactly its pre-purchase state.
    let default_wh = crate::inventory::default_warehouse_id_in_tx(tx)?;
    let restore: Vec<(i64, f64, f64, f64, Option<i64>)> = {
        let mut stmt = tx
            .prepare("SELECT item_id,qty,unit_cost,conversion_factor,warehouse_id FROM purchase_lines_local WHERE purchase_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![purchase_id], |r| Ok((
                r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?, r.get::<_, Option<i64>>(4)?,
            )))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows { v.push(r.map_err(|e| e.to_string())?); }
        v
    };
    // GR-sourced invoices NEVER added stock (the goods receipt already did),
    // so they must NOT push any stock back out on reverse — only the GL clears.
    if gr_src.is_none() {
        for (item_id, qty, unit_cost, cf, wh) in &restore {
            let factor = if *cf > 0.0 { *cf } else { 1.0 };
            let line_wh = match wh { Some(w) if *w > 0 => *w, _ => default_wh };
            crate::inventory::ledger_push_in_tx(
                tx, *item_id, line_wh, -(*qty * factor), *unit_cost / factor,
                "purchase_void", Some(purchase_id), &date,
            )?;
        }
    }

    // 3) Unwind the party/treasury shadow (mirror of the create-time bump). With
    //    an LC link only the VAT portion moved on the payment account.
    let lc_active = lc_id.filter(|x| *x > 0);
    let shadow_amt = if lc_active.is_some() { vat_total } else { grand };
    if shadow_amt > 0.0 {
        match pm.as_str() {
            "credit" => { tx.execute("UPDATE suppliers_local SET balance=balance-?1 WHERE id=?2", params![shadow_amt, sup]).map_err(|e| e.to_string())?; }
            "cash" => { if let Some(c) = cb { tx.execute("UPDATE cash_boxes_local SET balance=balance+?1 WHERE id=?2", params![shadow_amt, c]).map_err(|e| e.to_string())?; } }
            "bank" => { if let Some(b) = bank { tx.execute("UPDATE banks_local SET balance=balance+?1 WHERE id=?2", params![shadow_amt, b]).map_err(|e| e.to_string())?; } }
            _ => {}
        }
    }

    // 3b) Return the drawn-down goods value to the LC and refresh its status.
    if let Some(lc) = lc_active {
        let _ = subtotal; // goods value drawn at create time
        tx.execute("UPDATE letters_of_credit_local SET used_amount=MAX(0, used_amount-?1) WHERE id=?2", params![subtotal, lc]).map_err(|e| e.to_string())?;
        lc_recompute_status_in_tx(tx, lc)?;
    }

    // 4) Drop the line rows (header is the caller's responsibility).
    tx.execute("DELETE FROM purchase_lines_local WHERE purchase_id=?1", params![purchase_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn purchase_update(id: i64, input: PurchaseInput) -> Result<(), String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ فاتورة بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (invoice_no, old_date, gr_src): (String, String, Option<i64>) = tx.query_row(
        "SELECT invoice_no, invoice_date, source_goods_receipt_id FROM purchases_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).map_err(|e| e.to_string())?;
    if gr_src.is_some() {
        return Err("هذه الفاتورة ناتجة عن سند استلام — عدّلها من شاشة سندات الاستلام".into());
    }
    // Both the original and the new posting dates must fall in open periods.
    guard_period_open_for_date(&tx, &old_date).map_err(|e| e.to_string())?;
    guard_period_open_for_date(&tx, &input.invoice_date).map_err(|e| e.to_string())?;

    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&input.lines);
    reverse_purchase_impact(&tx, id)?;
    let default_wh = match input.warehouse_id { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };
    tx.execute(
        "UPDATE purchases_local SET supplier_id=?1,invoice_date=?2,subtotal=?3,vat_total=?4,grand_total=?5,payment_method=?6,cash_box_id=?7,bank_id=?8,notes=?9,branch_id=?10,cost_center_id=?11,supplier_invoice_no=?12,warehouse_id=?13,lc_id=?14,je_id=NULL WHERE id=?15",
        params![input.supplier_id, input.invoice_date, subtotal, vat_total, grand_total,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes, input.branch_id, input.cost_center_id,
                input.supplier_invoice_no, default_wh, input.lc_id, id],
    ).map_err(|e| e.to_string())?;
    // Invoice number is immutable across an edit (preserve the original).
    apply_purchase_impact(&tx, id, &invoice_no, &input, subtotal, vat_total, grand_total, default_wh)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn purchase_delete(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (date, gr_src): (String, Option<i64>) = tx.query_row(
        "SELECT invoice_date, source_goods_receipt_id FROM purchases_local WHERE id=?1", params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    guard_period_open_for_date(&tx, &date).map_err(|e| e.to_string())?;
    // Block delete when a return still references this purchase (FK integrity).
    let ret_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM purchase_returns_local WHERE purchase_id=?1", params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if ret_count > 0 { return Err("لا يمكن حذف فاتورة لها مرتجعات — احذف المرتجع أولاً".into()); }
    reverse_purchase_impact(&tx, id)?;
    tx.execute("DELETE FROM purchases_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    // A GR-sourced invoice deletion releases the goods receipt back to 'posted'
    // so it can be re-converted (its stock/clearing posting stays intact).
    if let Some(gr_id) = gr_src {
        tx.execute(
            "UPDATE goods_receipts_local SET status='posted', converted_invoice_id=NULL WHERE id=?1 AND converted_invoice_id=?2",
            params![gr_id, id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
    pub reason: Option<String>,
    pub lines: Vec<PurchaseLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseReturnInput {
    pub supplier_id: i64,
    pub purchase_id: Option<i64>,
    pub return_date: String,
    pub notes: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// Header warehouse the lines move stock out of. None → company default.
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

fn next_pret_no(conn: &Connection) -> Result<String> {
    next_doc_no(conn, "purchase_return")
}

#[tauri::command]
pub fn purchase_returns_list(limit: Option<i64>) -> Result<Vec<PurchaseReturn>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT r.id,r.return_no,r.supplier_id,s.name_ar,r.purchase_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,r.je_id,r.notes,r.reason
         FROM purchase_returns_local r JOIN suppliers_local s ON s.id=r.supplier_id
         ORDER BY r.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(PurchaseReturn {
        id: r.get(0)?, return_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        purchase_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
        grand_total: r.get(8)?, je_id: r.get(9)?, notes: r.get(10)?, reason: r.get(11)?, lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn purchase_return_get(id: i64) -> Result<PurchaseReturn, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut p: PurchaseReturn = conn.query_row(
        "SELECT r.id,r.return_no,r.supplier_id,s.name_ar,r.purchase_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,r.je_id,r.notes,r.reason
         FROM purchase_returns_local r JOIN suppliers_local s ON s.id=r.supplier_id WHERE r.id=?1",
        params![id], |r| Ok(PurchaseReturn {
            id: r.get(0)?, return_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            purchase_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
            grand_total: r.get(8)?, je_id: r.get(9)?, notes: r.get(10)?, reason: r.get(11)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total,pl.uom_id,pl.uom_name,pl.conversion_factor
         FROM purchase_return_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.return_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
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
        "INSERT INTO purchase_returns_local(return_no,supplier_id,purchase_id,return_date,subtotal,vat_total,grand_total,notes,branch_id,cost_center_id,reason)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![return_no, input.supplier_id, input.purchase_id, input.return_date, subtotal, vat_total, grand_total, input.notes, input.branch_id, input.cost_center_id, input.reason],
    ).map_err(|e| e.to_string())?;
    let return_id = tx.last_insert_rowid();

    // Default warehouse for outbound stock ledger entries.
    let default_wh = match input.warehouse_id { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_cost;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO purchase_return_lines_local(return_id,item_id,qty,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![return_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor],
        ).map_err(|e| e.to_string())?;
        // Stock OUT: BASE units (qty × factor) at cost-per-base (unit_cost ÷ factor).
        crate::inventory::ledger_push_in_tx(
            &tx, l.item_id, default_wh, -l.qty * factor, l.unit_cost / factor,
            "purchase_return", Some(return_id), &input.return_date,
        )?;
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
    let je_id = insert_journal_entry(&tx, &input.return_date, Some(&format!("مرتجع شراء {return_no}")), Some("purchase_return"), Some(return_id), input.branch_id, input.cost_center_id, &lines, resolve_auto_post(&tx, "purchase_return"))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE purchase_returns_local SET je_id=?1 WHERE id=?2", params![je_id, return_id]).map_err(|e| e.to_string())?;

    // Reduce supplier balance.
    tx.execute("UPDATE suppliers_local SET balance=balance-?1 WHERE id=?2", params![grand_total, input.supplier_id]).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(return_id)
}

// ───────────────────────── Purchase Orders ───────────────────────────
// A purchase order (أمر شراء) is a NON-financial document: it never touches
// stock or the GL. It only records the intended purchase. Converting it to an
// invoice runs the standard purchase pipeline (`purchase_create_in_tx`) and
// stamps the order `converted`. Lifecycle: draft → confirmed → converted /
// cancelled.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrder {
    pub id: i64,
    pub order_no: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub order_date: String,
    pub expected_date: Option<String>,
    pub payment_method: String,
    pub status: String,
    pub converted_invoice_id: Option<i64>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub notes: Option<String>,
    pub supplier_invoice_no: Option<String>,
    pub warehouse_id: Option<i64>,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderInput {
    pub supplier_id: i64,
    pub order_date: String,
    #[serde(default)]
    pub expected_date: Option<String>,
    #[serde(default = "default_po_payment_method")]
    pub payment_method: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub supplier_invoice_no: Option<String>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub cash_box_id: Option<i64>,
    #[serde(default)]
    pub bank_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

fn default_po_payment_method() -> String { "credit".into() }

fn po_lines_load(conn: &Connection, order_id: i64) -> Result<Vec<PurchaseLine>, String> {
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total,pl.uom_id,pl.uom_name,pl.conversion_factor
         FROM purchase_order_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.order_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([order_id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn purchase_orders_list(limit: Option<i64>) -> Result<Vec<PurchaseOrder>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT o.id,o.order_no,o.supplier_id,s.name_ar,o.order_date,o.expected_date,o.payment_method,o.status,
                o.converted_invoice_id,o.subtotal,o.vat_total,o.grand_total,o.notes,o.supplier_invoice_no,o.warehouse_id,o.cash_box_id,o.bank_id,o.branch_id,o.cost_center_id
         FROM purchase_orders_local o JOIN suppliers_local s ON s.id=o.supplier_id
         ORDER BY o.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(PurchaseOrder {
        id: r.get(0)?, order_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        order_date: r.get(4)?, expected_date: r.get(5)?, payment_method: r.get(6)?, status: r.get(7)?,
        converted_invoice_id: r.get(8)?, subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
        notes: r.get(12)?, supplier_invoice_no: r.get(13)?, warehouse_id: r.get(14)?, cash_box_id: r.get(15)?, bank_id: r.get(16)?,
        branch_id: r.get(17)?, cost_center_id: r.get(18)?,
        lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn purchase_order_get(id: i64) -> Result<PurchaseOrder, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut o: PurchaseOrder = conn.query_row(
        "SELECT o.id,o.order_no,o.supplier_id,s.name_ar,o.order_date,o.expected_date,o.payment_method,o.status,
                o.converted_invoice_id,o.subtotal,o.vat_total,o.grand_total,o.notes,o.supplier_invoice_no,o.warehouse_id,o.cash_box_id,o.bank_id,o.branch_id,o.cost_center_id
         FROM purchase_orders_local o JOIN suppliers_local s ON s.id=o.supplier_id WHERE o.id=?1",
        params![id], |r| Ok(PurchaseOrder {
            id: r.get(0)?, order_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            order_date: r.get(4)?, expected_date: r.get(5)?, payment_method: r.get(6)?, status: r.get(7)?,
            converted_invoice_id: r.get(8)?, subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
            notes: r.get(12)?, supplier_invoice_no: r.get(13)?, warehouse_id: r.get(14)?, cash_box_id: r.get(15)?, bank_id: r.get(16)?,
            branch_id: r.get(17)?, cost_center_id: r.get(18)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    o.lines = po_lines_load(&conn, id)?;
    Ok(o)
}

/// Insert the order's lines (no stock, no GL). Shared by create + update.
fn po_apply_lines(tx: &Transaction, order_id: i64, input: &PurchaseOrderInput) -> Result<(), String> {
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_cost;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO purchase_order_lines_local(order_id,item_id,qty,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor,warehouse_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![order_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor, input.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn purchase_order_create(input: PurchaseOrderInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ أمر شراء بدون أصناف".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&input.lines);
    let order_no = next_doc_no(&tx, "purchase_order").map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO purchase_orders_local(order_no,supplier_id,order_date,expected_date,payment_method,status,subtotal,vat_total,grand_total,notes,branch_id,cost_center_id,warehouse_id,cash_box_id,bank_id,supplier_invoice_no)
         VALUES(?1,?2,?3,?4,?5,'draft',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![order_no, input.supplier_id, input.order_date, input.expected_date, input.payment_method,
                subtotal, vat_total, grand_total, input.notes, input.branch_id, input.cost_center_id,
                input.warehouse_id, input.cash_box_id, input.bank_id, input.supplier_invoice_no],
    ).map_err(|e| e.to_string())?;
    let order_id = tx.last_insert_rowid();
    po_apply_lines(&tx, order_id, &input)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

#[tauri::command]
pub fn purchase_order_update(id: i64, input: PurchaseOrderInput) -> Result<(), String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ أمر شراء بدون أصناف".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let status: String = tx.query_row("SELECT status FROM purchase_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if status == "converted" { return Err("لا يمكن تعديل أمر شراء تم تحويله لفاتورة".into()); }
    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&input.lines);
    tx.execute(
        "UPDATE purchase_orders_local SET supplier_id=?1,order_date=?2,expected_date=?3,payment_method=?4,subtotal=?5,vat_total=?6,grand_total=?7,notes=?8,branch_id=?9,cost_center_id=?10,warehouse_id=?11,cash_box_id=?12,bank_id=?13,supplier_invoice_no=?14 WHERE id=?15",
        params![input.supplier_id, input.order_date, input.expected_date, input.payment_method, subtotal, vat_total, grand_total,
                input.notes, input.branch_id, input.cost_center_id, input.warehouse_id, input.cash_box_id, input.bank_id, input.supplier_invoice_no, id],
    ).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM purchase_order_lines_local WHERE order_id=?1", params![id]).map_err(|e| e.to_string())?;
    po_apply_lines(&tx, id, &input)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn purchase_order_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let status: String = conn.query_row("SELECT status FROM purchase_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if status == "converted" { return Err("لا يمكن حذف أمر شراء تم تحويله لفاتورة".into()); }
    conn.execute("DELETE FROM purchase_orders_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// draft ↔ confirmed ↔ cancelled. `converted` is reached only via convert.
#[tauri::command]
pub fn purchase_order_set_status(id: i64, status: String) -> Result<(), String> {
    if !["draft","confirmed","cancelled"].contains(&status.as_str()) {
        return Err("حالة غير صالحة".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur: String = conn.query_row("SELECT status FROM purchase_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if cur == "converted" { return Err("أمر الشراء محوّل لفاتورة بالفعل".into()); }
    conn.execute("UPDATE purchase_orders_local SET status=?1 WHERE id=?2", params![status, id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert a purchase order into a real purchase invoice, atomically. Reuses the
/// shared `purchase_create_in_tx` so the resulting invoice is identical to one
/// keyed by hand (stock IN + DR 1300/VAT / CR supplier|cash|bank). The order is
/// stamped `converted` + linked to the new invoice id in the SAME transaction.
#[tauri::command]
pub fn purchase_order_convert(id: i64) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let order: PurchaseOrder = tx.query_row(
        "SELECT o.id,o.order_no,o.supplier_id,'',o.order_date,o.expected_date,o.payment_method,o.status,
                o.converted_invoice_id,o.subtotal,o.vat_total,o.grand_total,o.notes,o.supplier_invoice_no,o.warehouse_id,o.cash_box_id,o.bank_id,o.branch_id,o.cost_center_id
         FROM purchase_orders_local o WHERE o.id=?1",
        params![id], |r| Ok(PurchaseOrder {
            id: r.get(0)?, order_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            order_date: r.get(4)?, expected_date: r.get(5)?, payment_method: r.get(6)?, status: r.get(7)?,
            converted_invoice_id: r.get(8)?, subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
            notes: r.get(12)?, supplier_invoice_no: r.get(13)?, warehouse_id: r.get(14)?, cash_box_id: r.get(15)?, bank_id: r.get(16)?,
            branch_id: r.get(17)?, cost_center_id: r.get(18)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    if order.status == "converted" { return Err("أمر الشراء محوّل لفاتورة بالفعل".into()); }
    if order.status == "cancelled" { return Err("لا يمكن تحويل أمر شراء ملغي".into()); }
    let lines = po_lines_load(&tx, id)?;
    if lines.is_empty() { return Err("أمر الشراء لا يحتوي أصناف".into()); }

    let invoice_input = PurchaseInput {
        supplier_id: order.supplier_id,
        invoice_date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        payment_method: order.payment_method.clone(),
        cash_box_id: order.cash_box_id,
        bank_id: order.bank_id,
        notes: order.notes.clone(),
        supplier_invoice_no: order.supplier_invoice_no.clone(),
        warehouse_id: order.warehouse_id,
        branch_id: order.branch_id,
        cost_center_id: order.cost_center_id,
        lc_id: None,
        lines,
    };
    let invoice_id = purchase_create_in_tx(&tx, &invoice_input)?;
    let updated = tx.execute(
        "UPDATE purchase_orders_local SET status='converted', converted_invoice_id=?1 WHERE id=?2 AND status IN ('draft','confirmed')",
        params![invoice_id, id],
    ).map_err(|e| e.to_string())?;
    if updated == 0 { return Err("تعذّر تحويل أمر الشراء (الحالة تغيّرت)".into()); }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(invoice_id)
}

// ───────────────────────── Goods Receipts ────────────────────────────
// A goods receipt (سند استلام بضاعة) receives stock BEFORE the supplier invoice
// arrives. Posting pushes stock IN and books DR Inventory(1300) / CR Receiving-
// Clearing(11091) at goods cost EX-VAT (no VAT yet, no payable yet). Converting
// to an invoice clears 11091, claims input VAT, and raises the supplier payable
// WITHOUT moving stock again — the resulting `purchases_local` row carries
// `source_goods_receipt_id` so its reverse skips the stock leg.

/// Lazily create the receiving-clearing account (11091) on databases that were
/// seeded before it existed (`seed_default_accounts` only runs on empty trees).
fn ensure_receiving_clearing_account(tx: &Transaction) -> Result<i64, String> {
    if let Ok(id) = account_id_by_code(tx, "11091") { return Ok(id); }
    let parent_id: Option<i64> = tx
        .query_row("SELECT id FROM accounts_local WHERE code='1000'", [], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO accounts_local(code,name_ar,type,parent_id,is_leaf) VALUES('11091','وسيط استلام البضاعة','asset',?1,1)",
        params![parent_id],
    ).map_err(|e| e.to_string())?;
    Ok(tx.last_insert_rowid())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoodsReceipt {
    pub id: i64,
    pub receipt_no: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub receipt_date: String,
    pub supplier_invoice_no: Option<String>,
    pub status: String,
    pub je_id: Option<i64>,
    pub converted_invoice_id: Option<i64>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub notes: Option<String>,
    pub warehouse_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoodsReceiptInput {
    pub supplier_id: i64,
    pub receipt_date: String,
    #[serde(default)]
    pub supplier_invoice_no: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    pub lines: Vec<PurchaseLine>,
}

/// Conversion params: the supplier invoice arriving for a posted goods receipt.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoodsReceiptConvertInput {
    pub invoice_date: String,
    #[serde(default = "default_po_payment_method")]
    pub payment_method: String,
    #[serde(default)]
    pub cash_box_id: Option<i64>,
    #[serde(default)]
    pub bank_id: Option<i64>,
    #[serde(default)]
    pub supplier_invoice_no: Option<String>,
}

fn gr_lines_load(conn: &Connection, receipt_id: i64) -> Result<Vec<PurchaseLine>, String> {
    let mut stmt = conn.prepare(
        "SELECT pl.id,pl.item_id,i.name_ar,pl.qty,pl.unit_cost,pl.vat_rate,pl.line_total,pl.uom_id,pl.uom_name,pl.conversion_factor
         FROM goods_receipt_lines_local pl JOIN items_local i ON i.id=pl.item_id
         WHERE pl.receipt_id=?1 ORDER BY pl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([receipt_id], |r| Ok(PurchaseLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_cost: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn goods_receipts_list(limit: Option<i64>) -> Result<Vec<GoodsReceipt>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT g.id,g.receipt_no,g.supplier_id,s.name_ar,g.receipt_date,g.supplier_invoice_no,g.status,g.je_id,
                g.converted_invoice_id,g.subtotal,g.vat_total,g.grand_total,g.notes,g.warehouse_id
         FROM goods_receipts_local g JOIN suppliers_local s ON s.id=g.supplier_id
         ORDER BY g.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(GoodsReceipt {
        id: r.get(0)?, receipt_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
        receipt_date: r.get(4)?, supplier_invoice_no: r.get(5)?, status: r.get(6)?, je_id: r.get(7)?,
        converted_invoice_id: r.get(8)?, subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
        notes: r.get(12)?, warehouse_id: r.get(13)?, lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn goods_receipt_get(id: i64) -> Result<GoodsReceipt, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut g: GoodsReceipt = conn.query_row(
        "SELECT g.id,g.receipt_no,g.supplier_id,s.name_ar,g.receipt_date,g.supplier_invoice_no,g.status,g.je_id,
                g.converted_invoice_id,g.subtotal,g.vat_total,g.grand_total,g.notes,g.warehouse_id
         FROM goods_receipts_local g JOIN suppliers_local s ON s.id=g.supplier_id WHERE g.id=?1",
        params![id], |r| Ok(GoodsReceipt {
            id: r.get(0)?, receipt_no: r.get(1)?, supplier_id: r.get(2)?, supplier_name: r.get(3)?,
            receipt_date: r.get(4)?, supplier_invoice_no: r.get(5)?, status: r.get(6)?, je_id: r.get(7)?,
            converted_invoice_id: r.get(8)?, subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
            notes: r.get(12)?, warehouse_id: r.get(13)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    g.lines = gr_lines_load(&conn, id)?;
    Ok(g)
}

/// Insert a goods receipt as a DRAFT (no stock, no GL). Posting is a separate
/// explicit step so the operator can review before it hits inventory.
#[tauri::command]
pub fn goods_receipt_create(input: GoodsReceiptInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ سند استلام بدون أصناف".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&input.lines);
    let receipt_no = next_doc_no(&tx, "goods_receipt").map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO goods_receipts_local(receipt_no,supplier_id,receipt_date,supplier_invoice_no,status,subtotal,vat_total,grand_total,notes,branch_id,cost_center_id,warehouse_id)
         VALUES(?1,?2,?3,?4,'draft',?5,?6,?7,?8,?9,?10,?11)",
        params![receipt_no, input.supplier_id, input.receipt_date, input.supplier_invoice_no, subtotal, vat_total, grand_total,
                input.notes, input.branch_id, input.cost_center_id, input.warehouse_id],
    ).map_err(|e| e.to_string())?;
    let receipt_id = tx.last_insert_rowid();
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_cost;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO goods_receipt_lines_local(receipt_id,item_id,qty,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor,warehouse_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![receipt_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor, input.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(receipt_id)
}

/// Post a draft goods receipt: stock IN + DR Inventory(1300) / CR Receiving-
/// Clearing(11091) at EX-VAT goods cost. No VAT, no supplier payable yet.
#[tauri::command]
pub fn goods_receipt_post(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, date, branch_id, cost_center_id, wh): (String, String, Option<i64>, Option<i64>, Option<i64>) = tx.query_row(
        "SELECT status,receipt_date,branch_id,cost_center_id,warehouse_id FROM goods_receipts_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).map_err(|e| e.to_string())?;
    if status != "draft" { return Err("سند الاستلام ليس في حالة مسودة".into()); }
    let receipt_no: String = tx.query_row("SELECT receipt_no FROM goods_receipts_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let lines = gr_lines_load(&tx, id)?;
    if lines.is_empty() { return Err("سند الاستلام لا يحتوي أصناف".into()); }
    let default_wh = match wh { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };

    let mut subtotal = 0.0_f64;
    for l in &lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        subtotal += l.qty * l.unit_cost;
        crate::inventory::ledger_push_in_tx(
            &tx, l.item_id, default_wh, l.qty * factor, l.unit_cost / factor,
            "goods_receipt", Some(id), &date,
        )?;
    }

    let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
    let clearing_acc = ensure_receiving_clearing_account(&tx)?;
    let je_lines = vec![
        JournalEntryLine { id: None, account_id: inv_acc,      account_code: None, account_name: None, debit: subtotal, credit: 0.0, description: Some(format!("استلام بضاعة {receipt_no}")) },
        JournalEntryLine { id: None, account_id: clearing_acc, account_code: None, account_name: None, debit: 0.0, credit: subtotal, description: None },
    ];
    let je_id = insert_journal_entry(&tx, &date, Some(&format!("سند استلام {receipt_no}")), Some("goods_receipt"), Some(id), branch_id, cost_center_id, &je_lines, resolve_auto_post(&tx, "goods_receipt"))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE goods_receipts_local SET status='posted', je_id=?1 WHERE id=?2", params![je_id, id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a goods receipt. A draft drops directly. A posted receipt first
/// reverses its JE + pushes the received stock back OUT. A converted receipt is
/// blocked (delete its invoice first, which releases it back to `posted`).
#[tauri::command]
pub fn goods_receipt_delete(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, date, wh): (String, String, Option<i64>) = tx.query_row(
        "SELECT status,receipt_date,warehouse_id FROM goods_receipts_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).map_err(|e| e.to_string())?;
    if status == "converted" { return Err("سند الاستلام محوّل لفاتورة — احذف الفاتورة أولاً".into()); }
    if status == "posted" {
        guard_period_open_for_date(&tx, &date).map_err(|e| e.to_string())?;
        // Reverse + delete the receipt JE.
        let je_rows: Vec<(i64, String)> = {
            let mut stmt = tx.prepare("SELECT id,status FROM journal_entries_local WHERE source_id=?1 AND source_type='goods_receipt'")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut v = Vec::new();
            for r in rows { v.push(r.map_err(|e| e.to_string())?); }
            v
        };
        for (je_id, st) in &je_rows {
            if st == "posted" { reverse_je_balance(&tx, *je_id).map_err(|e| e.to_string())?; }
            tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![je_id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM journal_entries_local WHERE id=?1", params![je_id]).map_err(|e| e.to_string())?;
        }
        // Push the received stock back OUT at the SAME per-base cost it entered.
        let default_wh = match wh { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };
        let lines = gr_lines_load(&tx, id)?;
        for l in &lines {
            let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
            crate::inventory::ledger_push_in_tx(
                &tx, l.item_id, default_wh, -(l.qty * factor), l.unit_cost / factor,
                "goods_receipt_void", Some(id), &date,
            )?;
        }
    }
    tx.execute("DELETE FROM goods_receipts_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert a POSTED goods receipt into a purchase invoice. The invoice clears
/// the receiving-clearing balance (DR 11091), claims input VAT (DR 1400), and
/// raises the supplier payable / treasury outflow (CR) — with NO stock movement
/// (already received). The new `purchases_local` row carries the
/// `source_goods_receipt_id` link so its reverse skips the stock leg.
#[tauri::command]
pub fn goods_receipt_convert_to_invoice(id: i64, input: GoodsReceiptConvertInput) -> Result<i64, String> {
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, supplier_id, branch_id, cost_center_id, wh, gr_inv_no, notes): (String, i64, Option<i64>, Option<i64>, Option<i64>, Option<String>, Option<String>) = tx.query_row(
        "SELECT status,supplier_id,branch_id,cost_center_id,warehouse_id,supplier_invoice_no,notes FROM goods_receipts_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).map_err(|e| e.to_string())?;
    if status != "posted" { return Err("لا يمكن تحويل سند استلام غير مُرحّل".into()); }
    guard_period_open_for_date(&tx, &input.invoice_date).map_err(|e| e.to_string())?;
    let lines = gr_lines_load(&tx, id)?;
    if lines.is_empty() { return Err("سند الاستلام لا يحتوي أصناف".into()); }
    let (subtotal, vat_total, grand_total) = purchase_doc_totals(&lines);

    let default_wh = match wh { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };
    let invoice_no = next_purchase_no(&tx).map_err(|e| e.to_string())?;
    let supplier_invoice_no = input.supplier_invoice_no.clone().or(gr_inv_no);
    tx.execute(
        "INSERT INTO purchases_local(invoice_no,supplier_id,invoice_date,subtotal,vat_total,grand_total,payment_method,cash_box_id,bank_id,notes,branch_id,cost_center_id,supplier_invoice_no,warehouse_id,source_goods_receipt_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![invoice_no, supplier_id, input.invoice_date, subtotal, vat_total, grand_total,
                input.payment_method, input.cash_box_id, input.bank_id, notes, branch_id, cost_center_id,
                supplier_invoice_no, default_wh, id],
    ).map_err(|e| e.to_string())?;
    let invoice_id = tx.last_insert_rowid();

    // Lines WITHOUT a stock ledger push (stock already entered via the receipt).
    for l in &lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_cost;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO purchase_lines_local(purchase_id,item_id,qty,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor,warehouse_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![invoice_id, l.item_id, l.qty, l.unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor, default_wh],
        ).map_err(|e| e.to_string())?;
    }

    // JE: DR Receiving-Clearing(subtotal) + DR VAT-In(vat) / CR supplier|cash|bank(grand).
    let clearing_acc = ensure_receiving_clearing_account(&tx)?;
    let vat_in_acc = account_id_by_code(&tx, "1400").map_err(|e| e.to_string())?;
    let cr_account_id = resolve_payment_credit_account(&tx, &input.payment_method, supplier_id, input.cash_box_id, input.bank_id)
        .map_err(|e| e.to_string())?;
    let mut je_lines = vec![
        JournalEntryLine { id: None, account_id: clearing_acc, account_code: None, account_name: None, debit: subtotal, credit: 0.0, description: Some(format!("فاتورة شراء {invoice_no} (من سند استلام)")) },
    ];
    if vat_total > 0.0 {
        je_lines.push(JournalEntryLine { id: None, account_id: vat_in_acc, account_code: None, account_name: None, debit: vat_total, credit: 0.0, description: None });
    }
    je_lines.push(JournalEntryLine { id: None, account_id: cr_account_id, account_code: None, account_name: None, debit: 0.0, credit: grand_total, description: None });
    let je_id = insert_journal_entry(&tx, &input.invoice_date, Some(&format!("فاتورة شراء {invoice_no}")), Some("purchase"), Some(invoice_id), branch_id, cost_center_id, &je_lines, resolve_auto_post(&tx, "purchase"))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE purchases_local SET je_id=?1 WHERE id=?2", params![je_id, invoice_id]).map_err(|e| e.to_string())?;

    // Raise the supplier payable / treasury outflow shadow (the invoice's bill).
    match input.payment_method.as_str() {
        "credit" => { tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![grand_total, supplier_id]).map_err(|e| e.to_string())?; }
        "cash" => { if let Some(cb) = input.cash_box_id { tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![grand_total, cb]).map_err(|e| e.to_string())?; } }
        "bank" => { if let Some(b) = input.bank_id { tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![grand_total, b]).map_err(|e| e.to_string())?; } }
        _ => {}
    }

    tx.execute("UPDATE goods_receipts_local SET status='converted', converted_invoice_id=?1 WHERE id=?2", params![invoice_id, id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(invoice_id)
}

// ───────────────────────── Sales Invoices ────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesLine {
    pub id: Option<i64>,
    pub item_id: i64,
    pub item_name: Option<String>,
    pub qty: f64,
    pub unit_price: f64,
    pub vat_rate: f64,
    pub line_total: f64,
    #[serde(default)]
    pub uom_id: Option<i64>,
    #[serde(default)]
    pub uom_name: Option<String>,
    #[serde(default = "default_conversion_factor")]
    pub conversion_factor: f64,
    /// Free / bonus units given with this line. They generate NO revenue and
    /// NO VAT, but DO consume stock and add to COGS (qty + free_qty) × factor.
    #[serde(default)]
    pub free_qty: f64,
    /// Optional per-line note.
    #[serde(default)]
    pub note: Option<String>,
    /// Per-line warehouse override. None → header/default warehouse.
    #[serde(default)]
    pub warehouse_id: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoice {
    pub id: i64,
    pub invoice_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub invoice_date: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub cogs_total: f64,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
    /// Salesperson / rep attribution + commission % snapshot (back-office only).
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_name: Option<String>,
    #[serde(default)]
    pub commission_pct: f64,
    /// Dimension snapshot — returned so an edit can round-trip them without loss
    /// (clearing them on update would corrupt cost-center / branch reports).
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    /// ZATCA document type: "standard" (B2B) or "simplified" (B2C).
    #[serde(default)]
    pub invoice_type: Option<String>,
    /// Frozen buyer snapshot (filled at save from the customer, editable).
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
    /// Cached ZATCA TLV QR (base64). Loaded by `sales_invoice_get`; left None
    /// in the list query to avoid shipping multi-hundred-byte blobs per row.
    pub zatca_qr_base64: Option<String>,
    /// Sync status of the linked offline_invoices row (pending|synced|...),
    /// or None when this invoice was never bridged (e.g. non-SA).
    pub zatca_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoiceInput {
    pub customer_id: Option<i64>,
    pub invoice_date: String,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub notes: Option<String>,
    /// Header warehouse the lines move stock out of. None → company default.
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub commission_pct: Option<f64>,
    #[serde(default)]
    pub invoice_type: Option<String>,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
}

fn next_sales_no(conn: &Connection) -> Result<String> {
    next_doc_no(conn, "sales_invoice")
}

/// Current moving cost of an item in a warehouse (0 when never stocked).
fn item_cost_in_tx(tx: &Transaction, item_id: i64, warehouse_id: i64) -> f64 {
    tx.query_row(
        "SELECT last_cost FROM stock_on_hand_local WHERE item_id=?1 AND warehouse_id=?2",
        params![item_id, warehouse_id], |r| r.get::<_, f64>(0),
    ).optional().ok().flatten().unwrap_or(0.0)
}

/// Whole days between two YYYY-MM-DD dates (to - from); 0 if either unparsable.
fn days_between(from: &str, to: &str) -> i64 {
    use chrono::NaiveDate;
    let f = NaiveDate::parse_from_str(from.get(..10).unwrap_or(from), "%Y-%m-%d");
    let t = NaiveDate::parse_from_str(to.get(..10).unwrap_or(to), "%Y-%m-%d");
    match (f, t) {
        (Ok(f), Ok(t)) => (t - f).num_days(),
        _ => 0,
    }
}

/// Debit side of the revenue JE: AR control (credit), or cash/bank (paid).
fn resolve_sales_debit_account(
    conn: &Connection,
    method: &str,
    cash_box_id: Option<i64>,
    bank_id: Option<i64>,
) -> Result<i64> {
    match method {
        // All customers share the AR control account 1500 (mirrors
        // resolve_party_account's "customer" branch).
        "credit" => account_id_by_code(conn, "1500"),
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
        _ => Err(anyhow!("طريقة دفع غير صالحة")),
    }
}

#[tauri::command]
pub fn sales_invoices_list(limit: Option<i64>) -> Result<Vec<SalesInvoice>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT s.id,s.invoice_no,s.customer_id,c.name_ar,s.invoice_date,s.subtotal,s.vat_total,s.grand_total,
                s.cogs_total,s.payment_method,s.cash_box_id,s.bank_id,s.je_id,s.notes,
                s.sales_rep_id,sp.name_ar,s.commission_pct,s.invoice_type,s.buyer_name,s.buyer_vat,s.buyer_address,
                oi.sync_status,s.branch_id,s.cost_center_id
         FROM sales_invoices_local s
         LEFT JOIN customers_local c ON c.id=s.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=s.sales_rep_id
         LEFT JOIN offline_invoices oi ON oi.local_uuid=s.zatca_offline_uuid
         ORDER BY s.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(SalesInvoice {
        id: r.get(0)?, invoice_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
        invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
        cogs_total: r.get(8)?, payment_method: r.get(9)?, cash_box_id: r.get(10)?, bank_id: r.get(11)?,
        je_id: r.get(12)?, notes: r.get(13)?,
        sales_rep_id: r.get(14)?, sales_rep_name: r.get(15)?, commission_pct: r.get(16)?,
        invoice_type: r.get(17)?, buyer_name: r.get(18)?, buyer_vat: r.get(19)?, buyer_address: r.get(20)?,
        lines: Vec::new(),
        zatca_qr_base64: None, zatca_status: r.get(21)?,
        branch_id: r.get(22)?, cost_center_id: r.get(23)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn sales_invoice_get(id: i64) -> Result<SalesInvoice, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut s: SalesInvoice = conn.query_row(
        "SELECT s.id,s.invoice_no,s.customer_id,c.name_ar,s.invoice_date,s.subtotal,s.vat_total,s.grand_total,
                s.cogs_total,s.payment_method,s.cash_box_id,s.bank_id,s.je_id,s.notes,
                s.sales_rep_id,sp.name_ar,s.commission_pct,s.invoice_type,s.buyer_name,s.buyer_vat,s.buyer_address,
                s.zatca_qr_base64,oi.sync_status,s.branch_id,s.cost_center_id
         FROM sales_invoices_local s
         LEFT JOIN customers_local c ON c.id=s.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=s.sales_rep_id
         LEFT JOIN offline_invoices oi ON oi.local_uuid=s.zatca_offline_uuid
         WHERE s.id=?1",
        params![id], |r| Ok(SalesInvoice {
            id: r.get(0)?, invoice_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
            invoice_date: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
            cogs_total: r.get(8)?, payment_method: r.get(9)?, cash_box_id: r.get(10)?, bank_id: r.get(11)?,
            je_id: r.get(12)?, notes: r.get(13)?,
            sales_rep_id: r.get(14)?, sales_rep_name: r.get(15)?, commission_pct: r.get(16)?,
            invoice_type: r.get(17)?, buyer_name: r.get(18)?, buyer_vat: r.get(19)?, buyer_address: r.get(20)?,
            lines: Vec::new(),
            zatca_qr_base64: r.get(21)?, zatca_status: r.get(22)?,
            branch_id: r.get(23)?, cost_center_id: r.get(24)?,
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT sl.id,sl.item_id,i.name_ar,sl.qty,sl.unit_price,sl.vat_rate,sl.line_total,sl.uom_id,sl.uom_name,sl.conversion_factor,sl.free_qty,sl.note,sl.warehouse_id
         FROM sales_invoice_lines_local sl JOIN items_local i ON i.id=sl.item_id
         WHERE sl.invoice_id=?1 ORDER BY sl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(SalesLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_price: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
        free_qty: r.get(10)?, note: r.get(11)?, warehouse_id: r.get(12)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { s.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(s)
}

/// Persist the ZATCA bridge link back onto a sales invoice after the TS layer
/// has generated the QR and enqueued the offline_invoices row. Idempotent: the
/// TS side reuses a stable `local_uuid` (`sinv-<id>`) so re-running overwrites
/// the same values rather than creating duplicates.
#[tauri::command]
pub fn sales_invoice_set_zatca(
    id: i64,
    qr_base64: Option<String>,
    offline_uuid: Option<String>,
) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sales_invoices_local SET zatca_qr_base64=?1, zatca_offline_uuid=?2 WHERE id=?3",
        params![qr_base64, offline_uuid, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Refuses edit/delete of a sales invoice that was bridged to ZATCA. Such an
/// invoice is legally immutable — the only compliant way to undo it is a credit
/// note (إرجاع). Errors when the invoice doesn't exist.
fn guard_sales_invoice_not_bridged(tx: &Transaction, invoice_id: i64) -> Result<(), String> {
    let row: Option<Option<String>> = tx
        .query_row(
            "SELECT zatca_offline_uuid FROM sales_invoices_local WHERE id=?1",
            params![invoice_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Err("الفاتورة غير موجودة".into()),
        Some(uuid) => {
            if uuid.is_some() {
                Err("لا يمكن تعديل أو حذف فاتورة مبيعات مرتبطة بـ ZATCA — استخدم إشعار إرجاع (مرتجع) لعكسها".into())
            } else {
                Ok(())
            }
        }
    }
}

/// Applies the FULL impact of a sales invoice whose header row already exists:
/// per-line stock OUT + COGS accrual, the revenue JE, the COGS JE, and the
/// payment-side shadow balance. Shared by `sales_invoice_create` and
/// `sales_invoice_update` so the two can never drift. `subtotal/vat_total/
/// grand_total` are passed pre-computed by the caller (they also drive the
/// header row).
fn apply_sales_invoice_impact(
    tx: &Transaction,
    invoice_id: i64,
    invoice_no: &str,
    input: &SalesInvoiceInput,
    subtotal: f64,
    vat_total: f64,
    grand_total: f64,
) -> Result<(), String> {
    let default_wh = match input.warehouse_id { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(tx)? };
    let mut cogs_total = 0.0_f64;
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        // Per-line warehouse override → fall back to the header/default one.
        let line_wh = match l.warehouse_id { Some(w) if w > 0 => w, _ => default_wh };
        // Free (bonus) units: no revenue/VAT, but consume stock + add COGS.
        let free_qty = if l.free_qty > 0.0 { l.free_qty } else { 0.0 };
        let total_base_qty = (l.qty + free_qty) * factor;
        // unit_cost is the moving cost PER BASE UNIT (from the LINE warehouse).
        let unit_cost = item_cost_in_tx(tx, l.item_id, line_wh);
        cogs_total += unit_cost * total_base_qty;
        tx.execute(
            "INSERT INTO sales_invoice_lines_local(invoice_id,item_id,qty,unit_price,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor,free_qty,note,warehouse_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![invoice_id, l.item_id, l.qty, l.unit_price, unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor, free_qty, l.note, line_wh],
        ).map_err(|e| e.to_string())?;
        // Stock OUT: BASE units ((qty + free_qty) × factor) at per-base cost,
        // from the line's resolved warehouse.
        crate::inventory::ledger_push_in_tx(
            tx, l.item_id, line_wh, -total_base_qty, unit_cost,
            "sale", Some(invoice_id), &input.invoice_date,
        )?;
    }
    tx.execute("UPDATE sales_invoices_local SET cogs_total=?1 WHERE id=?2", params![cogs_total, invoice_id]).map_err(|e| e.to_string())?;

    // Revenue JE: DR (AR|cash|bank)(grand) / CR Revenue(subtotal) + CR VAT-out(vat)
    let rev_acc = account_id_by_code(tx, "4100").map_err(|e| e.to_string())?;
    let vat_out_acc = account_id_by_code(tx, "2200").map_err(|e| e.to_string())?;
    let dr_account_id = resolve_sales_debit_account(tx, &input.payment_method, input.cash_box_id, input.bank_id)
        .map_err(|e| e.to_string())?;

    let mut lines = vec![
        JournalEntryLine { id: None, account_id: dr_account_id, account_code: None, account_name: None, debit: grand_total, credit: 0.0, description: Some(format!("مبيعات {invoice_no}")) },
        JournalEntryLine { id: None, account_id: rev_acc, account_code: None, account_name: None, debit: 0.0, credit: subtotal, description: None },
    ];
    if vat_total > 0.0 {
        lines.push(JournalEntryLine { id: None, account_id: vat_out_acc, account_code: None, account_name: None, debit: 0.0, credit: vat_total, description: None });
    }
    // The COGS JE must share the invoice's posting status so the two never
    // diverge (e.g. a posted revenue JE paired with a draft cost JE).
    let post_sale = resolve_auto_post(tx, "sale");
    let je_id = insert_journal_entry(tx, &input.invoice_date, Some(&format!("فاتورة مبيعات {invoice_no}")), Some("sale"), Some(invoice_id), input.branch_id, input.cost_center_id, &lines, post_sale)
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE sales_invoices_local SET je_id=?1 WHERE id=?2", params![je_id, invoice_id]).map_err(|e| e.to_string())?;

    // COGS JE: DR COGS / CR Inventory (at cost).
    if cogs_total > 0.0 {
        let cogs_acc = account_id_by_code(tx, "5100").map_err(|e| e.to_string())?;
        let inv_acc = account_id_by_code(tx, "1300").map_err(|e| e.to_string())?;
        let cogs_lines = vec![
            JournalEntryLine { id: None, account_id: cogs_acc, account_code: None, account_name: None, debit: cogs_total, credit: 0.0, description: Some(format!("تكلفة مبيعات {invoice_no}")) },
            JournalEntryLine { id: None, account_id: inv_acc, account_code: None, account_name: None, debit: 0.0, credit: cogs_total, description: None },
        ];
        insert_journal_entry(tx, &input.invoice_date, Some(&format!("تكلفة بضاعة مباعة {invoice_no}")), Some("sale_cogs"), Some(invoice_id), input.branch_id, input.cost_center_id, &cogs_lines, post_sale)
            .map_err(|e| e.to_string())?;
    }

    // Balance shadows. Credit → customer owes more; cash/bank → treasury up.
    if input.payment_method == "credit" {
        if let Some(cid) = input.customer_id {
            tx.execute("UPDATE customers_local SET balance=balance+?1 WHERE id=?2", params![grand_total, cid]).map_err(|e| e.to_string())?;
        }
    } else if input.payment_method == "cash" {
        if let Some(cb) = input.cash_box_id {
            tx.execute("UPDATE cash_boxes_local SET balance=balance+?1 WHERE id=?2", params![grand_total, cb]).map_err(|e| e.to_string())?;
        }
    } else if input.payment_method == "bank" {
        if let Some(b) = input.bank_id {
            tx.execute("UPDATE banks_local SET balance=balance+?1 WHERE id=?2", params![grand_total, b]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Fully reverses the GL + stock + shadow-balance impact of a sales invoice and
/// removes its line rows + the two source JEs (revenue + COGS). The invoice
/// HEADER row is left intact so the caller can either delete it
/// (`sales_invoice_delete`) or re-apply fresh impact (`sales_invoice_update`).
fn reverse_sales_invoice_impact(tx: &Transaction, invoice_id: i64) -> Result<(), String> {
    // Header snapshot for the shadow-balance unwind + stock-restore date.
    let (pm, cust, cb, bank, grand, date): (String, Option<i64>, Option<i64>, Option<i64>, f64, String) = tx
        .query_row(
            "SELECT payment_method,customer_id,cash_box_id,bank_id,grand_total,invoice_date FROM sales_invoices_local WHERE id=?1",
            params![invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| e.to_string())?;

    // 1) Reverse + delete the revenue & COGS journal entries tied to this
    //    invoice. Only POSTED entries touched GL balances, so guard per-row.
    let je_rows: Vec<(i64, String)> = {
        let mut stmt = tx
            .prepare("SELECT id,status FROM journal_entries_local WHERE source_id=?1 AND source_type IN ('sale','sale_cogs')")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![invoice_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows { v.push(r.map_err(|e| e.to_string())?); }
        v
    };
    for (je_id, status) in &je_rows {
        if status == "posted" {
            reverse_je_balance(tx, *je_id).map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![je_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM journal_entries_local WHERE id=?1", params![je_id]).map_err(|e| e.to_string())?;
    }

    // 2) Restore stock: push the BASE units back IN at the SAME cost they left
    //    at (stored per line), reversing the original sale OUT.
    let default_wh = crate::inventory::default_warehouse_id_in_tx(tx)?;
    let restore: Vec<(i64, f64, f64, f64, f64, Option<i64>)> = {
        let mut stmt = tx
            .prepare("SELECT item_id,qty,unit_cost,conversion_factor,free_qty,warehouse_id FROM sales_invoice_lines_local WHERE invoice_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![invoice_id], |r| Ok((
                r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?, r.get::<_, f64>(4)?, r.get::<_, Option<i64>>(5)?,
            )))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows { v.push(r.map_err(|e| e.to_string())?); }
        v
    };
    for (item_id, qty, unit_cost, cf, fq, wh) in &restore {
        let factor = if *cf > 0.0 { *cf } else { 1.0 };
        let free = if *fq > 0.0 { *fq } else { 0.0 };
        let total_base_qty = (*qty + free) * factor;
        let line_wh = match wh { Some(w) if *w > 0 => *w, _ => default_wh };
        crate::inventory::ledger_push_in_tx(
            tx, *item_id, line_wh, total_base_qty, *unit_cost,
            "sale_void", Some(invoice_id), &date,
        )?;
    }

    // 3) Unwind shadow balances (mirror of the create-time bump).
    match pm.as_str() {
        "credit" => { if let Some(cid) = cust { tx.execute("UPDATE customers_local SET balance=balance-?1 WHERE id=?2", params![grand, cid]).map_err(|e| e.to_string())?; } }
        "cash" => { if let Some(c) = cb { tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![grand, c]).map_err(|e| e.to_string())?; } }
        "bank" => { if let Some(b) = bank { tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![grand, b]).map_err(|e| e.to_string())?; } }
        _ => {}
    }

    // 4) Drop the line rows (header kept for the caller to decide).
    tx.execute("DELETE FROM sales_invoice_lines_local WHERE invoice_id=?1", params![invoice_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sales_invoice_create(input: SalesInvoiceInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ فاتورة بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    if input.payment_method == "credit" && input.customer_id.is_none() {
        return Err("اختر العميل للبيع الآجل".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in &input.lines {
        let line_sub = l.qty * l.unit_price;
        subtotal += line_sub;
        vat_total += line_sub * l.vat_rate / 100.0;
    }
    let grand_total = subtotal + vat_total;

    // ── Credit control (credit sales to a known customer only) ──
    if input.payment_method == "credit" {
        if let Some(cid) = input.customer_id {
            let (bal, limit, enforce, terms): (f64, f64, i64, i64) = tx.query_row(
                "SELECT balance, credit_limit, enforce_credit_limit, payment_terms_days FROM customers_local WHERE id=?1",
                params![cid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).map_err(|e| e.to_string())?;
            // Credit-limit cap — only when enforcement is explicitly enabled.
            if enforce != 0 && limit > 0.0 && bal + grand_total > limit + 0.001 {
                return Err(format!(
                    "تجاوز حد الائتمان: الرصيد الحالي {:.2} + الفاتورة {:.2} = {:.2} يتجاوز الحد المسموح {:.2}",
                    bal, grand_total, bal + grand_total, limit
                ));
            }
            // Overdue check — applies whenever payment terms are configured and
            // the customer still carries an outstanding balance, INDEPENDENT of
            // the credit-limit toggle. We FIFO-settle the customer's credit
            // invoices oldest-first with whatever has already been paid (or
            // credited back via returns) and test the age of the OLDEST invoice
            // that is still not fully covered — never a long-since-settled one.
            if terms > 0 && bal > 0.001 {
                let total_invoiced: f64 = tx.query_row(
                    "SELECT COALESCE(SUM(grand_total),0) FROM sales_invoices_local WHERE customer_id=?1 AND payment_method='credit'",
                    params![cid], |r| r.get(0),
                ).map_err(|e| e.to_string())?;
                // Amount applied against credit invoices so far (receipts +
                // credit returns). Clamp at 0 so an opening balance that is not
                // tied to any invoice can never make us skip real exposure.
                let mut remaining_settled = (total_invoiced - bal).max(0.0);
                let mut oldest_unpaid: Option<String> = None;
                {
                    let mut stmt = tx.prepare(
                        "SELECT invoice_date, grand_total FROM sales_invoices_local
                         WHERE customer_id=?1 AND payment_method='credit'
                         ORDER BY invoice_date ASC, id ASC"
                    ).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map(params![cid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
                        .map_err(|e| e.to_string())?;
                    for row in rows {
                        let (d, gt) = row.map_err(|e| e.to_string())?;
                        if remaining_settled + 0.001 >= gt {
                            remaining_settled -= gt; // this invoice is fully paid
                        } else {
                            oldest_unpaid = Some(d); // first not-fully-covered invoice
                            break;
                        }
                    }
                }
                if let Some(d) = oldest_unpaid {
                    let days = days_between(&d, &input.invoice_date);
                    if days > terms {
                        return Err(format!(
                            "العميل متأخر في السداد: أقدم فاتورة آجلة غير مسددة عمرها {} يوم وتتجاوز مدة الاستحقاق {} يوم — يلزم تحصيل المستحقات أولاً",
                            days, terms
                        ));
                    }
                }
            }
        }
    }

    let invoice_no = next_sales_no(&tx).map_err(|e| e.to_string())?;
    // ZATCA doc type: default simplified (B2C); only "standard" is the other
    // accepted value. commission_pct clamps to a sane 0..=100 range.
    let invoice_type = match input.invoice_type.as_deref() {
        Some("standard") => "standard",
        _ => "simplified",
    };
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    tx.execute(
        "INSERT INTO sales_invoices_local(invoice_no,customer_id,invoice_date,subtotal,vat_total,grand_total,cogs_total,payment_method,cash_box_id,bank_id,notes,branch_id,cost_center_id,sales_rep_id,commission_pct,invoice_type,buyer_name,buyer_vat,buyer_address)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![invoice_no, input.customer_id, input.invoice_date, subtotal, vat_total, grand_total, 0.0,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address],
    ).map_err(|e| e.to_string())?;
    let invoice_id = tx.last_insert_rowid();

    apply_sales_invoice_impact(&tx, invoice_id, &invoice_no, &input, subtotal, vat_total, grand_total)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(invoice_id)
}

#[tauri::command]
pub fn sales_invoice_delete(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // ZATCA-bridged invoices are legally immutable → must be reversed via إرجاع.
    guard_sales_invoice_not_bridged(&tx, id)?;
    // Period lock: the invoice's own date must sit in an open fiscal period.
    let date: String = tx.query_row(
        "SELECT invoice_date FROM sales_invoices_local WHERE id=?1", params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    guard_period_open_for_date(&tx, &date).map_err(|e| e.to_string())?;
    reverse_sales_invoice_impact(&tx, id)?;
    tx.execute("DELETE FROM sales_invoices_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sales_invoice_update(id: i64, input: SalesInvoiceInput) -> Result<(), String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ فاتورة بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    if input.payment_method == "credit" && input.customer_id.is_none() {
        return Err("اختر العميل للبيع الآجل".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Bridged invoices are immutable → block edit too.
    guard_sales_invoice_not_bridged(&tx, id)?;
    // Preserve the existing number; period-lock BOTH the old & new dates so an
    // edit can never move impact into (or out of) a closed period.
    let (invoice_no, old_date): (String, String) = tx.query_row(
        "SELECT invoice_no, invoice_date FROM sales_invoices_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    guard_period_open_for_date(&tx, &old_date).map_err(|e| e.to_string())?;
    guard_period_open_for_date(&tx, &input.invoice_date).map_err(|e| e.to_string())?;

    let (subtotal, vat_total, grand_total) = sales_doc_totals(&input.lines);

    // Reverse the OLD impact, rewrite the header in place (keeping id +
    // invoice_no), then re-apply the fresh impact from the new lines. Credit-
    // control is intentionally NOT re-run: this is an edit of existing exposure,
    // not new exposure.
    reverse_sales_invoice_impact(&tx, id)?;
    let invoice_type = match input.invoice_type.as_deref() { Some("standard") => "standard", _ => "simplified" };
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    tx.execute(
        "UPDATE sales_invoices_local SET customer_id=?1,invoice_date=?2,subtotal=?3,vat_total=?4,grand_total=?5,cogs_total=0,payment_method=?6,cash_box_id=?7,bank_id=?8,notes=?9,branch_id=?10,cost_center_id=?11,sales_rep_id=?12,commission_pct=?13,invoice_type=?14,buyer_name=?15,buyer_vat=?16,buyer_address=?17 WHERE id=?18",
        params![input.customer_id, input.invoice_date, subtotal, vat_total, grand_total,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address, id],
    ).map_err(|e| e.to_string())?;
    apply_sales_invoice_impact(&tx, id, &invoice_no, &input, subtotal, vat_total, grand_total)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────── Quotations & Sales Orders ───────────────────────
//
// Both are PURELY non-financial documents (web parity): creating them posts
// NO journal entry and moves NO stock. The financial impact happens only on
// CONVERSION, which builds a `SalesInvoiceInput` from the document and calls
// `sales_invoice_create` (the single source of truth for the sales JE + COGS
// + stock). Lines reuse the `SalesLine` struct. Totals are computed the same
// way as a sales invoice: subtotal = Σ qty×unit_price, vat = Σ line_sub×rate.

/// Recompute (subtotal, vat_total, grand_total) from a slice of sale lines.
fn sales_doc_totals(lines: &[SalesLine]) -> (f64, f64, f64) {
    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in lines {
        let line_sub = l.qty * l.unit_price;
        subtotal += line_sub;
        vat_total += line_sub * l.vat_rate / 100.0;
    }
    (subtotal, vat_total, subtotal + vat_total)
}

/// Today's date as YYYY-MM-DD (local) — the conversion date for invoices.
fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Quotation {
    pub id: i64,
    pub doc_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub quotation_date: String,
    pub valid_until: Option<String>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub notes: Option<String>,
    pub status: String,
    pub converted_invoice_id: Option<i64>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_name: Option<String>,
    #[serde(default)]
    pub commission_pct: f64,
    #[serde(default)]
    pub invoice_type: Option<String>,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotationInput {
    pub customer_id: Option<i64>,
    pub quotation_date: String,
    #[serde(default)]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub commission_pct: Option<f64>,
    #[serde(default)]
    pub invoice_type: Option<String>,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesOrder {
    pub id: i64,
    pub doc_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub order_date: String,
    pub expected_delivery: Option<String>,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub notes: Option<String>,
    pub status: String,
    pub converted_invoice_id: Option<i64>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_name: Option<String>,
    #[serde(default)]
    pub commission_pct: f64,
    #[serde(default)]
    pub invoice_type: Option<String>,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesOrderInput {
    pub customer_id: Option<i64>,
    pub order_date: String,
    #[serde(default)]
    pub expected_delivery: Option<String>,
    pub payment_method: String,
    #[serde(default)]
    pub cash_box_id: Option<i64>,
    #[serde(default)]
    pub bank_id: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    #[serde(default)]
    pub sales_rep_id: Option<i64>,
    #[serde(default)]
    pub commission_pct: Option<f64>,
    #[serde(default)]
    pub invoice_type: Option<String>,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub buyer_vat: Option<String>,
    #[serde(default)]
    pub buyer_address: Option<String>,
    pub lines: Vec<SalesLine>,
}

fn norm_invoice_type(t: Option<&str>) -> &'static str {
    match t {
        Some("standard") => "standard",
        _ => "simplified",
    }
}

// ── Quotations ──

#[tauri::command]
pub fn quotations_list(limit: Option<i64>) -> Result<Vec<Quotation>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT q.id,q.doc_no,q.customer_id,c.name_ar,q.quotation_date,q.valid_until,
                q.subtotal,q.vat_total,q.grand_total,q.notes,q.status,q.converted_invoice_id,
                q.warehouse_id,q.branch_id,q.cost_center_id,q.sales_rep_id,sp.name_ar,q.commission_pct,
                q.invoice_type,q.buyer_name,q.buyer_vat,q.buyer_address
         FROM quotations_local q
         LEFT JOIN customers_local c ON c.id=q.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=q.sales_rep_id
         ORDER BY q.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(Quotation {
        id: r.get(0)?, doc_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
        quotation_date: r.get(4)?, valid_until: r.get(5)?,
        subtotal: r.get(6)?, vat_total: r.get(7)?, grand_total: r.get(8)?,
        notes: r.get(9)?, status: r.get(10)?, converted_invoice_id: r.get(11)?,
        warehouse_id: r.get(12)?, branch_id: r.get(13)?, cost_center_id: r.get(14)?,
        sales_rep_id: r.get(15)?, sales_rep_name: r.get(16)?, commission_pct: r.get(17)?,
        invoice_type: r.get(18)?, buyer_name: r.get(19)?, buyer_vat: r.get(20)?, buyer_address: r.get(21)?,
        lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn quotation_get(id: i64) -> Result<Quotation, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut q: Quotation = conn.query_row(
        "SELECT q.id,q.doc_no,q.customer_id,c.name_ar,q.quotation_date,q.valid_until,
                q.subtotal,q.vat_total,q.grand_total,q.notes,q.status,q.converted_invoice_id,
                q.warehouse_id,q.branch_id,q.cost_center_id,q.sales_rep_id,sp.name_ar,q.commission_pct,
                q.invoice_type,q.buyer_name,q.buyer_vat,q.buyer_address
         FROM quotations_local q
         LEFT JOIN customers_local c ON c.id=q.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=q.sales_rep_id
         WHERE q.id=?1",
        params![id], |r| Ok(Quotation {
            id: r.get(0)?, doc_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
            quotation_date: r.get(4)?, valid_until: r.get(5)?,
            subtotal: r.get(6)?, vat_total: r.get(7)?, grand_total: r.get(8)?,
            notes: r.get(9)?, status: r.get(10)?, converted_invoice_id: r.get(11)?,
            warehouse_id: r.get(12)?, branch_id: r.get(13)?, cost_center_id: r.get(14)?,
            sales_rep_id: r.get(15)?, sales_rep_name: r.get(16)?, commission_pct: r.get(17)?,
            invoice_type: r.get(18)?, buyer_name: r.get(19)?, buyer_vat: r.get(20)?, buyer_address: r.get(21)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT ql.id,ql.item_id,i.name_ar,ql.qty,ql.unit_price,ql.vat_rate,ql.line_total,ql.uom_id,ql.uom_name,ql.conversion_factor,ql.free_qty,ql.note,ql.warehouse_id
         FROM quotation_lines_local ql JOIN items_local i ON i.id=ql.item_id
         WHERE ql.quotation_id=?1 ORDER BY ql.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(SalesLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_price: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
        free_qty: r.get(10)?, note: r.get(11)?, warehouse_id: r.get(12)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { q.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(q)
}

#[tauri::command]
pub fn quotation_create(input: QuotationInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ عرض سعر بدون أصناف".into()); }
    let (subtotal, vat_total, grand_total) = sales_doc_totals(&input.lines);
    let invoice_type = norm_invoice_type(input.invoice_type.as_deref());
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let doc_no = next_doc_no(&tx, "quotation").map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO quotations_local(doc_no,customer_id,quotation_date,valid_until,subtotal,vat_total,grand_total,notes,status,warehouse_id,branch_id,cost_center_id,sales_rep_id,commission_pct,invoice_type,buyer_name,buyer_vat,buyer_address)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![doc_no, input.customer_id, input.quotation_date, input.valid_until, subtotal, vat_total, grand_total,
                input.notes, input.warehouse_id, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address],
    ).map_err(|e| e.to_string())?;
    let doc_id = tx.last_insert_rowid();
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO quotation_lines_local(quotation_id,item_id,qty,unit_price,vat_rate,line_total,uom_id,uom_name,conversion_factor,free_qty,note,warehouse_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![doc_id, l.item_id, l.qty, l.unit_price, l.vat_rate, lt, l.uom_id, l.uom_name, factor, l.free_qty, l.note, l.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(doc_id)
}

#[tauri::command]
pub fn quotation_set_status(id: i64, status: String) -> Result<(), String> {
    if !["draft","sent","accepted","rejected"].contains(&status.as_str()) {
        return Err("حالة غير صالحة".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur: String = conn.query_row("SELECT status FROM quotations_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if cur == "converted" { return Err("لا يمكن تغيير حالة عرض سعر تم تحويله إلى فاتورة".into()); }
    conn.execute("UPDATE quotations_local SET status=?1 WHERE id=?2", params![status, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn quotation_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let status: Option<String> = conn
        .query_row("SELECT status FROM quotations_local WHERE id=?1", params![id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let status = status.ok_or_else(|| "عرض السعر غير موجود".to_string())?;
    if status == "converted" {
        return Err("لا يمكن حذف عرض سعر تم تحويله إلى فاتورة".into());
    }
    // Non-financial: no JE / stock to reverse. Lines drop via ON DELETE CASCADE,
    // but we delete them explicitly in case FK enforcement is off.
    conn.execute("DELETE FROM quotation_lines_local WHERE quotation_id=?1", params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM quotations_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn quotation_update(id: i64, input: QuotationInput) -> Result<(), String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ عرض سعر بدون أصناف".into()); }
    let (subtotal, vat_total, grand_total) = sales_doc_totals(&input.lines);
    let invoice_type = norm_invoice_type(input.invoice_type.as_deref());
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let status: Option<String> = tx
        .query_row("SELECT status FROM quotations_local WHERE id=?1", params![id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let status = status.ok_or_else(|| "عرض السعر غير موجود".to_string())?;
    if status == "converted" {
        return Err("لا يمكن تعديل عرض سعر تم تحويله إلى فاتورة".into());
    }
    tx.execute(
        "UPDATE quotations_local SET customer_id=?1,quotation_date=?2,valid_until=?3,subtotal=?4,vat_total=?5,grand_total=?6,notes=?7,warehouse_id=?8,branch_id=?9,cost_center_id=?10,sales_rep_id=?11,commission_pct=?12,invoice_type=?13,buyer_name=?14,buyer_vat=?15,buyer_address=?16 WHERE id=?17",
        params![input.customer_id, input.quotation_date, input.valid_until, subtotal, vat_total, grand_total,
                input.notes, input.warehouse_id, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address, id],
    ).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM quotation_lines_local WHERE quotation_id=?1", params![id]).map_err(|e| e.to_string())?;
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO quotation_lines_local(quotation_id,item_id,qty,unit_price,vat_rate,line_total,uom_id,uom_name,conversion_factor,free_qty,note,warehouse_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, l.item_id, l.qty, l.unit_price, l.vat_rate, lt, l.uom_id, l.uom_name, factor, l.free_qty, l.note, l.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert a quotation into a (posted) sales invoice. The quotation has no
/// payment method, so we issue a CREDIT invoice on the customer's account —
/// which requires a customer. Idempotent at the document level: a quotation
/// already 'converted' is rejected so it can never spawn two invoices.
#[tauri::command]
pub fn quotation_convert_to_invoice(id: i64) -> Result<i64, String> {
    let q = quotation_get(id)?;
    if q.status == "converted" {
        return Err("تم تحويل عرض السعر هذا إلى فاتورة من قبل".into());
    }
    let customer_id = q.customer_id.ok_or_else(|| "اختر العميل في عرض السعر قبل التحويل إلى فاتورة آجلة".to_string())?;
    // Atomically CLAIM the quotation before creating the invoice: the compare-
    // and-set on the gating `status` column means two concurrent converters
    // can't both pass — only the one whose UPDATE affects a row proceeds, so we
    // never mint two invoices for the same quotation. On any failure below we
    // revert the claim so the document can be retried.
    let conn = db::open().map_err(|e| e.to_string())?;
    let claimed = conn.execute(
        "UPDATE quotations_local SET status='converted' WHERE id=?1 AND status<>'converted'",
        params![id],
    ).map_err(|e| e.to_string())?;
    if claimed == 0 {
        return Err("تم تحويل عرض السعر هذا إلى فاتورة من قبل".into());
    }
    let input = SalesInvoiceInput {
        customer_id: Some(customer_id),
        invoice_date: today_str(),
        payment_method: "credit".into(),
        cash_box_id: None,
        bank_id: None,
        notes: q.notes.clone(),
        warehouse_id: q.warehouse_id,
        branch_id: q.branch_id,
        cost_center_id: q.cost_center_id,
        sales_rep_id: q.sales_rep_id,
        commission_pct: Some(q.commission_pct),
        invoice_type: q.invoice_type.clone(),
        buyer_name: q.buyer_name.clone(),
        buyer_vat: q.buyer_vat.clone(),
        buyer_address: q.buyer_address.clone(),
        lines: q.lines.clone(),
    };
    match sales_invoice_create(input) {
        Ok(invoice_id) => {
            conn.execute(
                "UPDATE quotations_local SET converted_invoice_id=?1 WHERE id=?2",
                params![invoice_id, id],
            ).map_err(|e| e.to_string())?;
            Ok(invoice_id)
        }
        Err(e) => {
            // Revert the claim so the quotation is convertible again.
            let _ = conn.execute(
                "UPDATE quotations_local SET status=?1 WHERE id=?2",
                params![q.status, id],
            );
            Err(e)
        }
    }
}

// ── Sales Orders ──

#[tauri::command]
pub fn sales_orders_list(limit: Option<i64>) -> Result<Vec<SalesOrder>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT o.id,o.doc_no,o.customer_id,c.name_ar,o.order_date,o.expected_delivery,
                o.payment_method,o.cash_box_id,o.bank_id,o.subtotal,o.vat_total,o.grand_total,
                o.notes,o.status,o.converted_invoice_id,o.warehouse_id,o.branch_id,o.cost_center_id,
                o.sales_rep_id,sp.name_ar,o.commission_pct,o.invoice_type,o.buyer_name,o.buyer_vat,o.buyer_address
         FROM sales_orders_local o
         LEFT JOIN customers_local c ON c.id=o.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=o.sales_rep_id
         ORDER BY o.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(SalesOrder {
        id: r.get(0)?, doc_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
        order_date: r.get(4)?, expected_delivery: r.get(5)?,
        payment_method: r.get(6)?, cash_box_id: r.get(7)?, bank_id: r.get(8)?,
        subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
        notes: r.get(12)?, status: r.get(13)?, converted_invoice_id: r.get(14)?,
        warehouse_id: r.get(15)?, branch_id: r.get(16)?, cost_center_id: r.get(17)?,
        sales_rep_id: r.get(18)?, sales_rep_name: r.get(19)?, commission_pct: r.get(20)?,
        invoice_type: r.get(21)?, buyer_name: r.get(22)?, buyer_vat: r.get(23)?, buyer_address: r.get(24)?,
        lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn sales_order_get(id: i64) -> Result<SalesOrder, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut o: SalesOrder = conn.query_row(
        "SELECT o.id,o.doc_no,o.customer_id,c.name_ar,o.order_date,o.expected_delivery,
                o.payment_method,o.cash_box_id,o.bank_id,o.subtotal,o.vat_total,o.grand_total,
                o.notes,o.status,o.converted_invoice_id,o.warehouse_id,o.branch_id,o.cost_center_id,
                o.sales_rep_id,sp.name_ar,o.commission_pct,o.invoice_type,o.buyer_name,o.buyer_vat,o.buyer_address
         FROM sales_orders_local o
         LEFT JOIN customers_local c ON c.id=o.customer_id
         LEFT JOIN salespersons_local sp ON sp.id=o.sales_rep_id
         WHERE o.id=?1",
        params![id], |r| Ok(SalesOrder {
            id: r.get(0)?, doc_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
            order_date: r.get(4)?, expected_delivery: r.get(5)?,
            payment_method: r.get(6)?, cash_box_id: r.get(7)?, bank_id: r.get(8)?,
            subtotal: r.get(9)?, vat_total: r.get(10)?, grand_total: r.get(11)?,
            notes: r.get(12)?, status: r.get(13)?, converted_invoice_id: r.get(14)?,
            warehouse_id: r.get(15)?, branch_id: r.get(16)?, cost_center_id: r.get(17)?,
            sales_rep_id: r.get(18)?, sales_rep_name: r.get(19)?, commission_pct: r.get(20)?,
            invoice_type: r.get(21)?, buyer_name: r.get(22)?, buyer_vat: r.get(23)?, buyer_address: r.get(24)?,
            lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT ol.id,ol.item_id,i.name_ar,ol.qty,ol.unit_price,ol.vat_rate,ol.line_total,ol.uom_id,ol.uom_name,ol.conversion_factor,ol.free_qty,ol.note,ol.warehouse_id
         FROM sales_order_lines_local ol JOIN items_local i ON i.id=ol.item_id
         WHERE ol.order_id=?1 ORDER BY ol.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(SalesLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_price: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
        free_qty: r.get(10)?, note: r.get(11)?, warehouse_id: r.get(12)?,
    })).map_err(|e| e.to_string())?;
    for r in rows { o.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(o)
}

#[tauri::command]
pub fn sales_order_create(input: SalesOrderInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ أمر بيع بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    if input.payment_method == "credit" && input.customer_id.is_none() {
        return Err("اختر العميل للبيع الآجل".into());
    }
    // Validate the cash/bank target now so a 'confirmed' order can never strand
    // the conversion later (sales_invoice_create needs the debit account).
    if input.payment_method == "cash" && input.cash_box_id.is_none() {
        return Err("اختر الخزينة للدفع النقدي".into());
    }
    if input.payment_method == "bank" && input.bank_id.is_none() {
        return Err("اختر البنك للدفع البنكي".into());
    }
    let (subtotal, vat_total, grand_total) = sales_doc_totals(&input.lines);
    let invoice_type = norm_invoice_type(input.invoice_type.as_deref());
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let doc_no = next_doc_no(&tx, "sales_order").map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sales_orders_local(doc_no,customer_id,order_date,expected_delivery,payment_method,cash_box_id,bank_id,subtotal,vat_total,grand_total,notes,status,warehouse_id,branch_id,cost_center_id,sales_rep_id,commission_pct,invoice_type,buyer_name,buyer_vat,buyer_address)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'draft',?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![doc_no, input.customer_id, input.order_date, input.expected_delivery, input.payment_method,
                input.cash_box_id, input.bank_id, subtotal, vat_total, grand_total, input.notes,
                input.warehouse_id, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address],
    ).map_err(|e| e.to_string())?;
    let doc_id = tx.last_insert_rowid();
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO sales_order_lines_local(order_id,item_id,qty,unit_price,vat_rate,line_total,uom_id,uom_name,conversion_factor,free_qty,note,warehouse_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![doc_id, l.item_id, l.qty, l.unit_price, l.vat_rate, lt, l.uom_id, l.uom_name, factor, l.free_qty, l.note, l.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(doc_id)
}

#[tauri::command]
pub fn sales_order_set_status(id: i64, status: String) -> Result<(), String> {
    if !["draft","confirmed","cancelled"].contains(&status.as_str()) {
        return Err("حالة غير صالحة".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur: String = conn.query_row("SELECT status FROM sales_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if cur == "converted" { return Err("لا يمكن تغيير حالة أمر بيع تم تحويله إلى فاتورة".into()); }
    conn.execute("UPDATE sales_orders_local SET status=?1 WHERE id=?2", params![status, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sales_order_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let status: Option<String> = conn
        .query_row("SELECT status FROM sales_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let status = status.ok_or_else(|| "أمر البيع غير موجود".to_string())?;
    if status == "converted" {
        return Err("لا يمكن حذف أمر بيع تم تحويله إلى فاتورة".into());
    }
    // Non-financial: no JE / stock to reverse.
    conn.execute("DELETE FROM sales_order_lines_local WHERE order_id=?1", params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sales_orders_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sales_order_update(id: i64, input: SalesOrderInput) -> Result<(), String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ أمر بيع بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    if input.payment_method == "credit" && input.customer_id.is_none() {
        return Err("اختر العميل للبيع الآجل".into());
    }
    if input.payment_method == "cash" && input.cash_box_id.is_none() {
        return Err("اختر الخزينة للدفع النقدي".into());
    }
    if input.payment_method == "bank" && input.bank_id.is_none() {
        return Err("اختر البنك للدفع البنكي".into());
    }
    let (subtotal, vat_total, grand_total) = sales_doc_totals(&input.lines);
    let invoice_type = norm_invoice_type(input.invoice_type.as_deref());
    let commission_pct = input.commission_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let sales_rep_id = match input.sales_rep_id { Some(r) if r > 0 => Some(r), _ => None };
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let status: Option<String> = tx
        .query_row("SELECT status FROM sales_orders_local WHERE id=?1", params![id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let status = status.ok_or_else(|| "أمر البيع غير موجود".to_string())?;
    if status == "converted" {
        return Err("لا يمكن تعديل أمر بيع تم تحويله إلى فاتورة".into());
    }
    tx.execute(
        "UPDATE sales_orders_local SET customer_id=?1,order_date=?2,expected_delivery=?3,payment_method=?4,cash_box_id=?5,bank_id=?6,subtotal=?7,vat_total=?8,grand_total=?9,notes=?10,warehouse_id=?11,branch_id=?12,cost_center_id=?13,sales_rep_id=?14,commission_pct=?15,invoice_type=?16,buyer_name=?17,buyer_vat=?18,buyer_address=?19 WHERE id=?20",
        params![input.customer_id, input.order_date, input.expected_delivery, input.payment_method,
                input.cash_box_id, input.bank_id, subtotal, vat_total, grand_total, input.notes,
                input.warehouse_id, input.branch_id, input.cost_center_id,
                sales_rep_id, commission_pct, invoice_type, input.buyer_name, input.buyer_vat, input.buyer_address, id],
    ).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sales_order_lines_local WHERE order_id=?1", params![id]).map_err(|e| e.to_string())?;
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        tx.execute(
            "INSERT INTO sales_order_lines_local(order_id,item_id,qty,unit_price,vat_rate,line_total,uom_id,uom_name,conversion_factor,free_qty,note,warehouse_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, l.item_id, l.qty, l.unit_price, l.vat_rate, lt, l.uom_id, l.uom_name, factor, l.free_qty, l.note, l.warehouse_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert a CONFIRMED sales order into a (posted) sales invoice, carrying the
/// order's own payment method (cash/bank/credit). Rejected unless the order is
/// 'confirmed' and not already 'converted'.
#[tauri::command]
pub fn sales_order_convert_to_invoice(id: i64) -> Result<i64, String> {
    let o = sales_order_get(id)?;
    if o.status == "converted" {
        return Err("تم تحويل أمر البيع هذا إلى فاتورة من قبل".into());
    }
    if o.status != "confirmed" {
        return Err("يلزم تأكيد أمر البيع (confirmed) قبل التحويل إلى فاتورة".into());
    }
    // Atomically CLAIM the order before creating the invoice: the compare-and-set
    // on the gating `status='confirmed'` column means two concurrent converters
    // can't both pass, so we never mint two invoices. On any failure below we
    // restore status='confirmed' so the order can be retried.
    let conn = db::open().map_err(|e| e.to_string())?;
    let claimed = conn.execute(
        "UPDATE sales_orders_local SET status='converted' WHERE id=?1 AND status='confirmed'",
        params![id],
    ).map_err(|e| e.to_string())?;
    if claimed == 0 {
        return Err("تم تحويل أمر البيع هذا إلى فاتورة من قبل".into());
    }
    let input = SalesInvoiceInput {
        customer_id: o.customer_id,
        invoice_date: today_str(),
        payment_method: o.payment_method.clone(),
        cash_box_id: o.cash_box_id,
        bank_id: o.bank_id,
        notes: o.notes.clone(),
        warehouse_id: o.warehouse_id,
        branch_id: o.branch_id,
        cost_center_id: o.cost_center_id,
        sales_rep_id: o.sales_rep_id,
        commission_pct: Some(o.commission_pct),
        invoice_type: o.invoice_type.clone(),
        buyer_name: o.buyer_name.clone(),
        buyer_vat: o.buyer_vat.clone(),
        buyer_address: o.buyer_address.clone(),
        lines: o.lines.clone(),
    };
    match sales_invoice_create(input) {
        Ok(invoice_id) => {
            conn.execute(
                "UPDATE sales_orders_local SET converted_invoice_id=?1 WHERE id=?2",
                params![invoice_id, id],
            ).map_err(|e| e.to_string())?;
            Ok(invoice_id)
        }
        Err(e) => {
            // Revert the claim so the order is convertible again.
            let _ = conn.execute(
                "UPDATE sales_orders_local SET status='confirmed' WHERE id=?1",
                params![id],
            );
            Err(e)
        }
    }
}

// ───────────────────────── Sales Returns ─────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesReturn {
    pub id: i64,
    pub return_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub invoice_id: Option<i64>,
    pub return_date: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub cogs_total: f64,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
    pub lines: Vec<SalesLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesReturnInput {
    pub customer_id: Option<i64>,
    pub invoice_id: Option<i64>,
    pub return_date: String,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub notes: Option<String>,
    /// Header warehouse the lines move stock back into. None → company default.
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    pub lines: Vec<SalesLine>,
}

fn next_sret_no(conn: &Connection) -> Result<String> {
    next_doc_no(conn, "sales_return")
}

#[tauri::command]
pub fn sales_returns_list(limit: Option<i64>) -> Result<Vec<SalesReturn>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT r.id,r.return_no,r.customer_id,c.name_ar,r.invoice_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,
                r.cogs_total,r.payment_method,r.cash_box_id,r.bank_id,r.je_id,r.notes
         FROM sales_returns_local r LEFT JOIN customers_local c ON c.id=r.customer_id
         ORDER BY r.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(SalesReturn {
        id: r.get(0)?, return_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
        invoice_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
        grand_total: r.get(8)?, cogs_total: r.get(9)?, payment_method: r.get(10)?, cash_box_id: r.get(11)?,
        bank_id: r.get(12)?, je_id: r.get(13)?, notes: r.get(14)?, lines: Vec::new(),
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn sales_return_get(id: i64) -> Result<SalesReturn, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut p: SalesReturn = conn.query_row(
        "SELECT r.id,r.return_no,r.customer_id,c.name_ar,r.invoice_id,r.return_date,r.subtotal,r.vat_total,r.grand_total,
                r.cogs_total,r.payment_method,r.cash_box_id,r.bank_id,r.je_id,r.notes
         FROM sales_returns_local r LEFT JOIN customers_local c ON c.id=r.customer_id WHERE r.id=?1",
        params![id], |r| Ok(SalesReturn {
            id: r.get(0)?, return_no: r.get(1)?, customer_id: r.get(2)?, customer_name: r.get(3)?,
            invoice_id: r.get(4)?, return_date: r.get(5)?, subtotal: r.get(6)?, vat_total: r.get(7)?,
            grand_total: r.get(8)?, cogs_total: r.get(9)?, payment_method: r.get(10)?, cash_box_id: r.get(11)?,
            bank_id: r.get(12)?, je_id: r.get(13)?, notes: r.get(14)?, lines: Vec::new(),
        })
    ).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT sl.id,sl.item_id,i.name_ar,sl.qty,sl.unit_price,sl.vat_rate,sl.line_total,sl.uom_id,sl.uom_name,sl.conversion_factor
         FROM sales_return_lines_local sl JOIN items_local i ON i.id=sl.item_id
         WHERE sl.return_id=?1 ORDER BY sl.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok(SalesLine {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?, qty: r.get(3)?,
        unit_price: r.get(4)?, vat_rate: r.get(5)?, line_total: r.get(6)?,
        uom_id: r.get(7)?, uom_name: r.get(8)?, conversion_factor: r.get(9)?,
        free_qty: 0.0, note: None, warehouse_id: None,
    })).map_err(|e| e.to_string())?;
    for r in rows { p.lines.push(r.map_err(|e| e.to_string())?); }
    Ok(p)
}

#[tauri::command]
pub fn sales_return_create(input: SalesReturnInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا يمكن حفظ مرتجع بدون أصناف".into()); }
    if !["credit","cash","bank"].contains(&input.payment_method.as_str()) {
        return Err("طريقة دفع غير صالحة".into());
    }
    if input.payment_method == "credit" && input.customer_id.is_none() {
        return Err("اختر العميل لمرتجع آجل".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut subtotal = 0.0_f64;
    let mut vat_total = 0.0_f64;
    for l in &input.lines {
        let line_sub = l.qty * l.unit_price;
        subtotal += line_sub;
        vat_total += line_sub * l.vat_rate / 100.0;
    }
    let grand_total = subtotal + vat_total;

    let return_no = next_sret_no(&tx).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sales_returns_local(return_no,customer_id,invoice_id,return_date,subtotal,vat_total,grand_total,cogs_total,payment_method,cash_box_id,bank_id,notes,branch_id,cost_center_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![return_no, input.customer_id, input.invoice_id, input.return_date, subtotal, vat_total, grand_total, 0.0,
                input.payment_method, input.cash_box_id, input.bank_id, input.notes, input.branch_id, input.cost_center_id],
    ).map_err(|e| e.to_string())?;
    let return_id = tx.last_insert_rowid();

    let default_wh = match input.warehouse_id { Some(w) if w > 0 => w, _ => crate::inventory::default_warehouse_id_in_tx(&tx)? };
    let mut cogs_total = 0.0_f64;
    for l in &input.lines {
        let factor = if l.conversion_factor > 0.0 { l.conversion_factor } else { 1.0 };
        let line_sub = l.qty * l.unit_price;
        let lt = line_sub + line_sub * l.vat_rate / 100.0;
        // unit_cost is the moving cost PER BASE UNIT; base qty returned = qty × factor.
        let unit_cost = item_cost_in_tx(&tx, l.item_id, default_wh);
        cogs_total += unit_cost * l.qty * factor;
        tx.execute(
            "INSERT INTO sales_return_lines_local(return_id,item_id,qty,unit_price,unit_cost,vat_rate,line_total,uom_id,uom_name,conversion_factor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![return_id, l.item_id, l.qty, l.unit_price, unit_cost, l.vat_rate, lt, l.uom_id, l.uom_name, factor],
        ).map_err(|e| e.to_string())?;
        // Stock IN: BASE units (qty × factor) at the per-base moving cost.
        crate::inventory::ledger_push_in_tx(
            &tx, l.item_id, default_wh, l.qty * factor, unit_cost,
            "sale_return", Some(return_id), &input.return_date,
        )?;
    }
    tx.execute("UPDATE sales_returns_local SET cogs_total=?1 WHERE id=?2", params![cogs_total, return_id]).map_err(|e| e.to_string())?;

    // Reverse revenue JE: DR Revenue(subtotal) + DR VAT-out(vat) / CR (AR|cash|bank)(grand)
    let rev_acc = account_id_by_code(&tx, "4100").map_err(|e| e.to_string())?;
    let vat_out_acc = account_id_by_code(&tx, "2200").map_err(|e| e.to_string())?;
    let cr_account_id = resolve_sales_debit_account(&tx, &input.payment_method, input.cash_box_id, input.bank_id)
        .map_err(|e| e.to_string())?;

    let mut lines = vec![
        JournalEntryLine { id: None, account_id: rev_acc, account_code: None, account_name: None, debit: subtotal, credit: 0.0, description: Some(format!("مرتجع مبيعات {return_no}")) },
    ];
    if vat_total > 0.0 {
        lines.push(JournalEntryLine { id: None, account_id: vat_out_acc, account_code: None, account_name: None, debit: vat_total, credit: 0.0, description: None });
    }
    lines.push(JournalEntryLine { id: None, account_id: cr_account_id, account_code: None, account_name: None, debit: 0.0, credit: grand_total, description: None });

    // COGS-reversal JE shares the return's posting status (see sales_invoice).
    let post_ret = resolve_auto_post(&tx, "sale_return");
    let je_id = insert_journal_entry(&tx, &input.return_date, Some(&format!("مرتجع مبيعات {return_no}")), Some("sale_return"), Some(return_id), input.branch_id, input.cost_center_id, &lines, post_ret)
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE sales_returns_local SET je_id=?1 WHERE id=?2", params![je_id, return_id]).map_err(|e| e.to_string())?;

    // Reverse COGS JE: DR Inventory / CR COGS (at cost).
    if cogs_total > 0.0 {
        let cogs_acc = account_id_by_code(&tx, "5100").map_err(|e| e.to_string())?;
        let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
        let cogs_lines = vec![
            JournalEntryLine { id: None, account_id: inv_acc, account_code: None, account_name: None, debit: cogs_total, credit: 0.0, description: Some(format!("ارتجاع تكلفة {return_no}")) },
            JournalEntryLine { id: None, account_id: cogs_acc, account_code: None, account_name: None, debit: 0.0, credit: cogs_total, description: None },
        ];
        insert_journal_entry(&tx, &input.return_date, Some(&format!("عكس تكلفة بضاعة {return_no}")), Some("sale_return_cogs"), Some(return_id), input.branch_id, input.cost_center_id, &cogs_lines, post_ret)
            .map_err(|e| e.to_string())?;
    }

    // Balance shadows. Credit → reduce customer AR; cash/bank → treasury down (refund).
    if input.payment_method == "credit" {
        if let Some(cid) = input.customer_id {
            tx.execute("UPDATE customers_local SET balance=balance-?1 WHERE id=?2", params![grand_total, cid]).map_err(|e| e.to_string())?;
        }
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
    #[serde(default)]
    pub branch_id: Option<i64>,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
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

    // Resolve our cash/bank account + its native currency. Receipts/payments
    // accept `amount` in the endpoint's native currency; the JE is always
    // posted in base currency using the current rate-to-base. (Task #209.)
    let (cash_account_id, endpoint_currency): (i64, String) = if let Some(cb) = input.cash_box_id {
        tx.query_row(
            "SELECT account_id, COALESCE(currency_code,'SAR') FROM cash_boxes_local WHERE id=?1",
            params![cb], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        ).map_err(|e| e.to_string())?
    } else if let Some(b) = input.bank_id {
        tx.query_row(
            "SELECT account_id, COALESCE(currency_code,'SAR') FROM banks_local WHERE id=?1",
            params![b], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        ).map_err(|e| e.to_string())?
    } else { unreachable!() };
    let rate_to_base = current_rate_to_base(&tx, &endpoint_currency).map_err(|e| e.to_string())?;
    let amount_base = input.amount * rate_to_base;

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
        "INSERT INTO financial_transactions_local(tx_no,tx_date,tx_type,party_type,party_id,cash_box_id,bank_id,counter_account_id,amount,description,branch_id,cost_center_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![tx_no, input.tx_date, input.tx_type, input.party_type, input.party_id, input.cash_box_id, input.bank_id, counter_acc, input.amount, input.description, input.branch_id, input.cost_center_id],
    ).map_err(|e| e.to_string())?;
    let ftx_id = tx.last_insert_rowid();

    // JE:
    //   receipt → DR cash/bank, CR counter
    //   payment → DR counter, CR cash/bank
    let (dr_acc, cr_acc) = if input.tx_type == "receipt" {
        (cash_account_id, counter_acc)
    } else { (counter_acc, cash_account_id) };

    let lines = vec![
        JournalEntryLine { id: None, account_id: dr_acc, account_code: None, account_name: None, debit: amount_base, credit: 0.0, description: input.description.clone() },
        JournalEntryLine { id: None, account_id: cr_acc, account_code: None, account_name: None, debit: 0.0, credit: amount_base, description: None },
    ];
    let je_id = insert_journal_entry(
        &tx, &input.tx_date,
        Some(&format!("{} {tx_no}", if input.tx_type == "receipt" { "سند قبض" } else { "سند صرف" })),
        Some(if input.tx_type == "receipt" { "receipt" } else { "payment" }),
        Some(ftx_id), input.branch_id, input.cost_center_id, &lines,
        resolve_auto_post(&tx, "voucher"),
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
        // Mirrors the JE side exactly (in base currency, matching how
        // purchases post the AP credit on supplier balance):
        //   • payment to supplier  → DR AP / CR cash → AP credit balance ↓  → -amount_base
        //   • receipt from supplier (refund/over-credit) → DR cash / CR AP → AP credit balance ↑ → +amount_base
        let supp_delta = if input.tx_type == "receipt" { amount_base } else { -amount_base };
        tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![supp_delta, input.party_id.unwrap()]).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    let _ = now_iso(); let _ = today_iso(); // keep helpers referenced
    Ok(ftx_id)
}

// ═════════════════════════════════════════════════════════════════════
// Multi-currency (Task #209)
// ═════════════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Currency {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub symbol: Option<String>,
    pub decimals: i64,
    pub is_base: bool,
    pub is_active: bool,
    pub current_rate: Option<f64>,
    pub rate_as_of: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyInput {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<i64>,
    pub is_active: Option<bool>,
}

#[tauri::command]
pub fn currencies_list(active_only: Option<bool>) -> Result<Vec<Currency>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let where_clause = if active_only.unwrap_or(false) { " WHERE c.is_active=1" } else { "" };
    let sql = format!(
        "SELECT c.code,c.name_ar,c.name_en,c.symbol,c.decimals,c.is_base,c.is_active,
                (SELECT rate_to_base FROM currency_rates_local r WHERE r.currency_code=c.code ORDER BY r.as_of_date DESC LIMIT 1),
                (SELECT as_of_date FROM currency_rates_local r WHERE r.currency_code=c.code ORDER BY r.as_of_date DESC LIMIT 1)
         FROM currencies_local c{where_clause} ORDER BY c.is_base DESC, c.code");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Currency {
        code: r.get(0)?, name_ar: r.get(1)?, name_en: r.get(2)?, symbol: r.get(3)?,
        decimals: r.get(4)?,
        is_base: r.get::<_, i64>(5)? != 0,
        is_active: r.get::<_, i64>(6)? != 0,
        current_rate: r.get(7)?, rate_as_of: r.get(8)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn currency_create(input: CurrencyInput) -> Result<(), String> {
    let code = input.code.trim().to_uppercase();
    if code.is_empty() || code.len() > 5 { return Err("رمز العملة مطلوب (≤5 أحرف)".into()); }
    if input.name_ar.trim().is_empty() { return Err("اسم العملة مطلوب".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO currencies_local(code,name_ar,name_en,symbol,decimals,is_base,is_active) VALUES(?1,?2,?3,?4,?5,0,?6)",
        params![code, input.name_ar, input.name_en, input.symbol,
                input.decimals.unwrap_or(2),
                if input.is_active.unwrap_or(true) {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "العملة موجودة بالفعل".to_string() } else { e.to_string() })?;
    Ok(())
}

#[tauri::command]
pub fn currency_update(code: String, input: CurrencyInput) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE currencies_local SET name_ar=?1,name_en=?2,symbol=?3,decimals=?4,is_active=?5 WHERE code=?6",
        params![input.name_ar, input.name_en, input.symbol,
                input.decimals.unwrap_or(2),
                if input.is_active.unwrap_or(true) {1} else {0}, code],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn currency_delete(code: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let is_base: i64 = conn.query_row("SELECT is_base FROM currencies_local WHERE code=?1", params![code], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if is_base != 0 { return Err("لا يمكن حذف العملة الأساسية".into()); }
    // Refuse if any cash box / bank / etc. references it.
    let used: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM cash_boxes_local WHERE currency_code=?1)
              + (SELECT COUNT(*) FROM banks_local WHERE currency_code=?1)
              + (SELECT COUNT(*) FROM suppliers_local WHERE currency_code=?1)
              + (SELECT COUNT(*) FROM customers_local WHERE currency_code=?1)",
        params![code], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف عملة مستخدمة في خزن/بنوك/عملاء/موردين".into()); }
    conn.execute("DELETE FROM currency_rates_local WHERE currency_code=?1", params![code])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM currencies_local WHERE code=?1", params![code])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────────────── Exchange Rates ────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyRate {
    pub id: i64,
    pub currency_code: String,
    pub rate_to_base: f64,
    pub as_of_date: String,
    pub notes: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyRateInput {
    pub currency_code: String,
    pub rate_to_base: f64,
    pub as_of_date: String,
    pub notes: Option<String>,
}

#[tauri::command]
pub fn currency_rates_list(currency_code: Option<String>, limit: Option<i64>) -> Result<Vec<CurrencyRate>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(500);
    let (sql, has_filter) = if currency_code.is_some() {
        ("SELECT id,currency_code,rate_to_base,as_of_date,notes,created_at FROM currency_rates_local WHERE currency_code=?1 ORDER BY as_of_date DESC, id DESC LIMIT ?2", true)
    } else {
        ("SELECT id,currency_code,rate_to_base,as_of_date,notes,created_at FROM currency_rates_local ORDER BY as_of_date DESC, id DESC LIMIT ?1", false)
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mapper = |r: &rusqlite::Row<'_>| Ok(CurrencyRate {
        id: r.get(0)?, currency_code: r.get(1)?, rate_to_base: r.get(2)?,
        as_of_date: r.get(3)?, notes: r.get(4)?, created_at: r.get(5)?,
    });
    let mut out = Vec::new();
    if has_filter {
        let code = currency_code.unwrap();
        let rows = stmt.query_map(params![code, lim], mapper).map_err(|e| e.to_string())?;
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    } else {
        let rows = stmt.query_map(params![lim], mapper).map_err(|e| e.to_string())?;
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    }
    Ok(out)
}

#[tauri::command]
pub fn currency_rate_upsert(input: CurrencyRateInput) -> Result<i64, String> {
    if input.rate_to_base <= 0.0 { return Err("سعر الصرف يجب أن يكون أكبر من صفر".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let is_base: i64 = conn.query_row(
        "SELECT is_base FROM currencies_local WHERE code=?1", params![input.currency_code],
        |r| r.get(0),
    ).map_err(|_| "العملة غير موجودة".to_string())?;
    if is_base != 0 && (input.rate_to_base - 1.0).abs() > 0.0001 {
        return Err("العملة الأساسية يجب أن يكون سعرها = 1.0".into());
    }
    conn.execute(
        "INSERT INTO currency_rates_local(currency_code,rate_to_base,as_of_date,notes) VALUES(?1,?2,?3,?4)
         ON CONFLICT(currency_code,as_of_date) DO UPDATE SET rate_to_base=excluded.rate_to_base, notes=excluded.notes",
        params![input.currency_code, input.rate_to_base, input.as_of_date, input.notes],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn currency_rate_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM currency_rates_local WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Helper: get the current (most-recent) rate-to-base for a currency.
/// Returns 1.0 for the base currency. Errors if no rate is on file.
fn current_rate_to_base(conn: &Connection, code: &str) -> Result<f64> {
    let is_base: i64 = conn.query_row("SELECT is_base FROM currencies_local WHERE code=?1", params![code], |r| r.get(0))
        .map_err(|_| anyhow!(format!("العملة {code} غير موجودة")))?;
    if is_base != 0 { return Ok(1.0); }
    let rate: f64 = conn.query_row(
        "SELECT rate_to_base FROM currency_rates_local WHERE currency_code=?1 ORDER BY as_of_date DESC, id DESC LIMIT 1",
        params![code], |r| r.get(0),
    ).map_err(|_| anyhow!(format!("لا يوجد سعر صرف مسجّل للعملة {code}. أدخل سعر الصرف الحالي أولاً.")))?;
    Ok(rate)
}

// ───────────────────────── Treasury Transfers ────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryTransfer {
    pub id: i64,
    pub transfer_no: String,
    pub transfer_date: String,
    pub from_kind: String,
    pub from_id: i64,
    pub from_name: Option<String>,
    pub from_currency: String,
    pub to_kind: String,
    pub to_id: i64,
    pub to_name: Option<String>,
    pub to_currency: String,
    pub amount_from: f64,
    pub amount_to: f64,
    pub exchange_rate: f64,
    pub fx_diff: f64,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryTransferInput {
    pub transfer_date: String,
    pub from_kind: String,
    pub from_id: i64,
    pub to_kind: String,
    pub to_id: i64,
    pub amount_from: f64,
    pub amount_to: f64,
    pub notes: Option<String>,
}

fn next_transfer_no(conn: &Connection) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COALESCE(MAX(id),0)+1 FROM treasury_transfers_local", [], |r| r.get(0))?;
    Ok(format!("TT-{:06}", n))
}

fn treasury_endpoint(conn: &Connection, kind: &str, id: i64) -> Result<(i64, String, String, f64)> {
    // Returns (account_id, currency_code, name, balance) for a cash box or bank.
    match kind {
        "cash" => {
            let row = conn.query_row(
                "SELECT account_id, currency_code, name, balance FROM cash_boxes_local WHERE id=?1",
                params![id],
                |r| Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "SAR".to_string()),
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                )),
            ).map_err(|_| anyhow!(format!("الخزينة #{id} غير موجودة")))?;
            let acc = row.0.ok_or_else(|| anyhow!("الخزينة بدون حساب مرتبط"))?;
            Ok((acc, row.1, row.2, row.3))
        }
        "bank" => {
            let row = conn.query_row(
                "SELECT account_id, currency_code, name, balance FROM banks_local WHERE id=?1",
                params![id],
                |r| Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "SAR".to_string()),
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                )),
            ).map_err(|_| anyhow!(format!("البنك #{id} غير موجود")))?;
            let acc = row.0.ok_or_else(|| anyhow!("البنك بدون حساب مرتبط"))?;
            Ok((acc, row.1, row.2, row.3))
        }
        _ => Err(anyhow!("نوع غير صالح (cash|bank)")),
    }
}

#[tauri::command]
pub fn treasury_transfers_list(limit: Option<i64>) -> Result<Vec<TreasuryTransfer>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn.prepare(
        "SELECT t.id,t.transfer_no,t.transfer_date,t.from_kind,t.from_id,
                CASE t.from_kind WHEN 'cash' THEN (SELECT name FROM cash_boxes_local WHERE id=t.from_id)
                                 WHEN 'bank' THEN (SELECT name FROM banks_local WHERE id=t.from_id) END,
                t.from_currency,t.to_kind,t.to_id,
                CASE t.to_kind WHEN 'cash' THEN (SELECT name FROM cash_boxes_local WHERE id=t.to_id)
                               WHEN 'bank' THEN (SELECT name FROM banks_local WHERE id=t.to_id) END,
                t.to_currency,t.amount_from,t.amount_to,t.exchange_rate,t.fx_diff,t.je_id,t.notes
         FROM treasury_transfers_local t ORDER BY t.id DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], |r| Ok(TreasuryTransfer {
        id: r.get(0)?, transfer_no: r.get(1)?, transfer_date: r.get(2)?,
        from_kind: r.get(3)?, from_id: r.get(4)?, from_name: r.get(5)?, from_currency: r.get(6)?,
        to_kind: r.get(7)?, to_id: r.get(8)?, to_name: r.get(9)?, to_currency: r.get(10)?,
        amount_from: r.get(11)?, amount_to: r.get(12)?, exchange_rate: r.get(13)?,
        fx_diff: r.get(14)?, je_id: r.get(15)?, notes: r.get(16)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn treasury_transfer_create(input: TreasuryTransferInput) -> Result<i64, String> {
    if input.amount_from <= 0.0 || input.amount_to <= 0.0 {
        return Err("المبالغ يجب أن تكون أكبر من صفر".into());
    }
    if input.from_kind == input.to_kind && input.from_id == input.to_id {
        return Err("لا يمكن التحويل لنفس الجهة".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Look up both endpoints + balances.
    let (from_acc, from_cur, _from_name, from_bal) = treasury_endpoint(&tx, &input.from_kind, input.from_id)
        .map_err(|e| e.to_string())?;
    let (to_acc, to_cur, _to_name, _to_bal) = treasury_endpoint(&tx, &input.to_kind, input.to_id)
        .map_err(|e| e.to_string())?;

    if from_bal + 0.001 < input.amount_from {
        return Err(format!("رصيد الجهة المُحوَّل منها غير كافٍ (المتاح: {from_bal:.2} {from_cur})"));
    }
    // Same-currency sanity: amounts MUST match exactly (any drift would
    // silently leak into the fx_gain/fx_loss account).
    if from_cur == to_cur {
        let decimals: i64 = tx.query_row(
            "SELECT decimals FROM currencies_local WHERE code=?1",
            params![from_cur], |r| r.get(0),
        ).unwrap_or(2);
        let eps = 10f64.powi(-((decimals as i32) + 1)); // one decimal tighter than the currency's precision
        if (input.amount_from - input.amount_to).abs() > eps {
            return Err("التحويل بنفس العملة يجب أن يكون بنفس المبلغ".into());
        }
    }

    // Convert both to base currency to build a balanced JE.
    let from_rate = current_rate_to_base(&tx, &from_cur).map_err(|e| e.to_string())?;
    let to_rate = current_rate_to_base(&tx, &to_cur).map_err(|e| e.to_string())?;
    let amount_from_base = input.amount_from * from_rate;
    let amount_to_base = input.amount_to * to_rate;
    let fx_diff = amount_to_base - amount_from_base; // +ve = gain, -ve = loss
    let exchange_rate = if input.amount_from > 0.0 { input.amount_to / input.amount_from } else { 1.0 };

    // Build JE lines.
    let mut lines: Vec<JournalEntryLine> = Vec::new();
    let desc = Some(format!("تحويل خزينة: {} {} → {} {}", input.amount_from, from_cur, input.amount_to, to_cur));
    lines.push(JournalEntryLine { id: None, account_id: to_acc, account_code: None, account_name: None,
        debit: amount_to_base, credit: 0.0, description: desc.clone() });
    lines.push(JournalEntryLine { id: None, account_id: from_acc, account_code: None, account_name: None,
        debit: 0.0, credit: amount_from_base, description: desc.clone() });
    if fx_diff.abs() > 0.001 {
        if fx_diff > 0.0 {
            // Gain — credit fx_gain to balance the extra DR.
            let gain_acc = account_id_by_code(&tx, "4900").map_err(|e| e.to_string())?;
            lines.push(JournalEntryLine { id: None, account_id: gain_acc, account_code: None, account_name: None,
                debit: 0.0, credit: fx_diff, description: Some("ربح فروقات عملة".into()) });
        } else {
            let loss_acc = account_id_by_code(&tx, "5900").map_err(|e| e.to_string())?;
            lines.push(JournalEntryLine { id: None, account_id: loss_acc, account_code: None, account_name: None,
                debit: -fx_diff, credit: 0.0, description: Some("خسارة فروقات عملة".into()) });
        }
    }

    let transfer_no = next_transfer_no(&tx).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO treasury_transfers_local(transfer_no,transfer_date,from_kind,from_id,from_currency,to_kind,to_id,to_currency,amount_from,amount_to,exchange_rate,fx_diff,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![transfer_no, input.transfer_date, input.from_kind, input.from_id, from_cur,
                input.to_kind, input.to_id, to_cur, input.amount_from, input.amount_to,
                exchange_rate, fx_diff, input.notes],
    ).map_err(|e| e.to_string())?;
    let transfer_id = tx.last_insert_rowid();

    let je_id = insert_journal_entry(&tx, &input.transfer_date,
        Some(&format!("تحويل خزينة {transfer_no}")),
        Some("treasury_transfer"), Some(transfer_id), None, None, &lines,
        resolve_auto_post(&tx, "treasury_transfer"),
    ).map_err(|e| e.to_string())?;
    tx.execute("UPDATE treasury_transfers_local SET je_id=?1 WHERE id=?2", params![je_id, transfer_id])
        .map_err(|e| e.to_string())?;

    // Update native-currency shadow balances.
    let from_tbl = if input.from_kind == "cash" { "cash_boxes_local" } else { "banks_local" };
    let to_tbl = if input.to_kind == "cash" { "cash_boxes_local" } else { "banks_local" };
    tx.execute(&format!("UPDATE {from_tbl} SET balance=balance-?1 WHERE id=?2"),
        params![input.amount_from, input.from_id]).map_err(|e| e.to_string())?;
    tx.execute(&format!("UPDATE {to_tbl} SET balance=balance+?1 WHERE id=?2"),
        params![input.amount_to, input.to_id]).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(transfer_id)
}

// ═════════════════════════════════════════════════════════════════════
// Accounting dimensions: Branches & Cost Centers + Financial reports
//
// Branches (الفروع) and cost centers (مراكز التكلفة) are optional analytic
// tags attached to journal entries (and the documents that generate them).
// The financial report command below reads posted JE lines and the React
// pages compute the trial balance / income statement / balance sheet /
// account statement from them — mirroring the web app's report set.
// ═════════════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub id: i64,
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub is_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInput {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

#[tauri::command]
pub fn branches_list() -> Result<Vec<Branch>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,is_active FROM branches_local ORDER BY code"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Branch {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        is_active: r.get::<_, i64>(4)? != 0,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn branch_create(input: BranchInput) -> Result<i64, String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO branches_local(code,name_ar,name_en,is_active) VALUES(?1,?2,?3,?4)",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, if input.is_active {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود الفرع مستخدم من قبل".to_string() } else { e.to_string() })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn branch_update(id: i64, input: BranchInput) -> Result<(), String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE branches_local SET code=?1,name_ar=?2,name_en=?3,is_active=?4 WHERE id=?5",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, if input.is_active {1} else {0}, id],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود الفرع مستخدم من قبل".to_string() } else { e.to_string() })?;
    if n == 0 { return Err("الفرع غير موجود".into()); }
    Ok(())
}

#[tauri::command]
pub fn branch_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM journal_entries_local WHERE branch_id=?1", params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف فرع مستخدم في قيود محاسبية".into()); }
    conn.execute("DELETE FROM branches_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CostCenter {
    pub id: i64,
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub parent_id: Option<i64>,
    pub is_posting: bool,
    pub is_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostCenterInput {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default = "default_true")]
    pub is_posting: bool,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

#[tauri::command]
pub fn cost_centers_list() -> Result<Vec<CostCenter>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,parent_id,is_posting,is_active FROM cost_centers_local ORDER BY code"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(CostCenter {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        parent_id: r.get(4)?, is_posting: r.get::<_, i64>(5)? != 0, is_active: r.get::<_, i64>(6)? != 0,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn cost_center_create(input: CostCenterInput) -> Result<i64, String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO cost_centers_local(code,name_ar,name_en,parent_id,is_posting,is_active) VALUES(?1,?2,?3,?4,?5,?6)",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, input.parent_id,
                if input.is_posting {1} else {0}, if input.is_active {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود مركز التكلفة مستخدم من قبل".to_string() } else { e.to_string() })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn cost_center_update(id: i64, input: CostCenterInput) -> Result<(), String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    if input.parent_id == Some(id) { return Err("لا يمكن أن يكون المركز أباً لنفسه".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE cost_centers_local SET code=?1,name_ar=?2,name_en=?3,parent_id=?4,is_posting=?5,is_active=?6 WHERE id=?7",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, input.parent_id,
                if input.is_posting {1} else {0}, if input.is_active {1} else {0}, id],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود مركز التكلفة مستخدم من قبل".to_string() } else { e.to_string() })?;
    if n == 0 { return Err("مركز التكلفة غير موجود".into()); }
    Ok(())
}

#[tauri::command]
pub fn cost_center_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let kids: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cost_centers_local WHERE parent_id=?1", params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if kids > 0 { return Err("لا يمكن حذف مركز له مراكز فرعية".into()); }
    let used: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM journal_entries_local WHERE cost_center_id=?1)
              + (SELECT COUNT(*) FROM journal_entry_lines_local WHERE cost_center_id=?1)",
        params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف مركز مستخدم في قيود محاسبية".into()); }
    conn.execute("DELETE FROM cost_centers_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// A single posted journal-entry line joined with its account + entry header.
/// The React report pages bucket these by date (opening vs period) and group
/// by account type to build all four financial reports.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LedgerLine {
    pub account_id: i64,
    pub account_code: String,
    pub account_name: String,
    pub account_type: String,
    pub debit: f64,
    pub credit: f64,
    pub entry_date: String,
    pub entry_no: String,
    pub description: Option<String>,
    pub source_type: Option<String>,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
}

/// Returns every journal-entry line up to `to_date` (inclusive), optionally
/// filtered by branch, cost center, and/or account. All four financial
/// reports are derived from this single dataset on the client.
#[tauri::command]
pub fn report_ledger_lines(
    to_date: Option<String>,
    branch_id: Option<i64>,
    cost_center_id: Option<i64>,
    account_id: Option<i64>,
) -> Result<Vec<LedgerLine>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT l.account_id, a.code, a.name_ar, a.type, l.debit, l.credit, \
         e.entry_date, e.entry_no, COALESCE(l.description, e.description), e.source_type, e.branch_id, l.cost_center_id \
         FROM journal_entry_lines_local l \
         JOIN journal_entries_local e ON e.id = l.entry_id \
         JOIN accounts_local a ON a.id = l.account_id WHERE e.status = 'posted'"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &to_date { sql.push_str(" AND e.entry_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND e.branch_id = ?"); args.push(Box::new(b)); }
    if let Some(c) = cost_center_id { sql.push_str(" AND l.cost_center_id = ?"); args.push(Box::new(c)); }
    if let Some(ac) = account_id { sql.push_str(" AND l.account_id = ?"); args.push(Box::new(ac)); }
    sql.push_str(" ORDER BY e.entry_date, e.id, l.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(LedgerLine {
        account_id: r.get(0)?, account_code: r.get(1)?, account_name: r.get(2)?, account_type: r.get(3)?,
        debit: r.get(4)?, credit: r.get(5)?, entry_date: r.get(6)?, entry_no: r.get(7)?,
        description: r.get(8)?, source_type: r.get(9)?, branch_id: r.get(10)?, cost_center_id: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

// ───────────────────── Sales reports (تقارير المبيعات) ──────────────────
// Raw, offline-first datasets for the back-office sales analytics screens.
// The Rust side only fetches filtered rows; all grouping (by period / item /
// customer) is done in the React pages so the SQL stays trivial and the heavy
// aggregation logic is easy to verify without a Rust recompile.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesInvoiceReportRow {
    pub id: i64,
    pub invoice_no: String,
    pub invoice_date: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub payment_method: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub line_count: i64,
}

/// Back-office sales invoices in a date range, optionally scoped by branch /
/// customer (local rows have no status column — every saved invoice counts).
/// Powers the Daily Sales, Sales-by-Period and Sales-by-Customer screens
/// (which group these rows client-side).
#[tauri::command]
pub fn report_sales_invoices(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
    customer_id: Option<i64>,
) -> Result<Vec<SalesInvoiceReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT s.id, s.invoice_no, s.invoice_date, s.customer_id, c.name_ar, \
         s.payment_method, s.subtotal, s.vat_total, s.grand_total, \
         (SELECT COUNT(*) FROM sales_invoice_lines_local l WHERE l.invoice_id = s.id) \
         FROM sales_invoices_local s \
         LEFT JOIN customers_local c ON c.id = s.customer_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND s.invoice_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND s.invoice_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND s.branch_id = ?"); args.push(Box::new(b)); }
    if let Some(cu) = customer_id { sql.push_str(" AND s.customer_id = ?"); args.push(Box::new(cu)); }
    sql.push_str(" ORDER BY s.invoice_date, s.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(SalesInvoiceReportRow {
        id: r.get(0)?, invoice_no: r.get(1)?, invoice_date: r.get(2)?, customer_id: r.get(3)?,
        customer_name: r.get(4)?, payment_method: r.get(5)?, subtotal: r.get(6)?,
        vat_total: r.get(7)?, grand_total: r.get(8)?, line_count: r.get(9)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesLineReportRow {
    pub invoice_id: i64,
    pub invoice_no: String,
    pub invoice_date: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub item_id: i64,
    pub item_code: Option<String>,
    pub item_name: String,
    pub qty: f64,
    pub unit_price: f64,
    pub line_total: f64,
    pub vat_rate: f64,
}

/// Line-level sales rows in a date range (one row per invoice line), joined to
/// item + customer master data. Powers the Sales-by-Item screen.
#[tauri::command]
pub fn report_sales_invoice_lines(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
) -> Result<Vec<SalesLineReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT l.invoice_id, s.invoice_no, s.invoice_date, s.customer_id, c.name_ar, \
         l.item_id, i.code, i.name_ar, l.qty, l.unit_price, l.line_total, l.vat_rate \
         FROM sales_invoice_lines_local l \
         JOIN sales_invoices_local s ON s.id = l.invoice_id \
         LEFT JOIN customers_local c ON c.id = s.customer_id \
         LEFT JOIN items_local i ON i.id = l.item_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND s.invoice_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND s.invoice_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND s.branch_id = ?"); args.push(Box::new(b)); }
    sql.push_str(" ORDER BY s.invoice_date, l.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(SalesLineReportRow {
        invoice_id: r.get(0)?, invoice_no: r.get(1)?, invoice_date: r.get(2)?, customer_id: r.get(3)?,
        customer_name: r.get(4)?, item_id: r.get(5)?, item_code: r.get(6)?, item_name: r.get(7)?,
        qty: r.get(8)?, unit_price: r.get(9)?, line_total: r.get(10)?, vat_rate: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalesReturnReportRow {
    pub id: i64,
    pub return_no: String,
    pub return_date: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
}

/// Sales returns (credit notes) in a date range, optionally scoped by branch /
/// customer. Feeds the net-sales column on Sales-by-Customer and the dedicated
/// Sales Returns report in a later wave.
#[tauri::command]
pub fn report_sales_returns(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
    customer_id: Option<i64>,
) -> Result<Vec<SalesReturnReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT r.id, r.return_no, r.return_date, r.customer_id, c.name_ar, \
         r.subtotal, r.vat_total, r.grand_total \
         FROM sales_returns_local r \
         LEFT JOIN customers_local c ON c.id = r.customer_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND r.return_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND r.return_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND r.branch_id = ?"); args.push(Box::new(b)); }
    if let Some(cu) = customer_id { sql.push_str(" AND r.customer_id = ?"); args.push(Box::new(cu)); }
    sql.push_str(" ORDER BY r.return_date, r.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(SalesReturnReportRow {
        id: r.get(0)?, return_no: r.get(1)?, return_date: r.get(2)?, customer_id: r.get(3)?,
        customer_name: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

// ──────────────────── Purchasing reports (تقارير المشتريات) ────────────────
// Mirror of the sales-report datasets above: Rust only fetches filtered rows;
// all grouping (by supplier / item / period) + supplier-statement aggregation
// is done in the React pages (purchaseReports.ts consumers) so the SQL stays
// trivial and the heavy logic is verifiable without a Rust recompile.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInvoiceReportRow {
    pub id: i64,
    pub invoice_no: String,
    pub invoice_date: String,
    pub supplier_id: Option<i64>,
    pub supplier_name: Option<String>,
    pub payment_method: String,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
    pub line_count: i64,
}

/// Back-office purchase invoices in a date range, optionally scoped by branch /
/// supplier (local rows have no status column — every saved invoice counts).
/// Powers the Purchases-by-Period, Purchases-by-Supplier and Top-Suppliers
/// screens (which group these rows client-side).
#[tauri::command]
pub fn report_purchase_invoices(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
    supplier_id: Option<i64>,
) -> Result<Vec<PurchaseInvoiceReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT p.id, p.invoice_no, p.invoice_date, p.supplier_id, s.name_ar, \
         p.payment_method, p.subtotal, p.vat_total, p.grand_total, \
         (SELECT COUNT(*) FROM purchase_lines_local l WHERE l.purchase_id = p.id) \
         FROM purchases_local p \
         LEFT JOIN suppliers_local s ON s.id = p.supplier_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND p.invoice_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND p.invoice_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND p.branch_id = ?"); args.push(Box::new(b)); }
    if let Some(su) = supplier_id { sql.push_str(" AND p.supplier_id = ?"); args.push(Box::new(su)); }
    sql.push_str(" ORDER BY p.invoice_date, p.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(PurchaseInvoiceReportRow {
        id: r.get(0)?, invoice_no: r.get(1)?, invoice_date: r.get(2)?, supplier_id: r.get(3)?,
        supplier_name: r.get(4)?, payment_method: r.get(5)?, subtotal: r.get(6)?,
        vat_total: r.get(7)?, grand_total: r.get(8)?, line_count: r.get(9)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLineReportRow {
    pub purchase_id: i64,
    pub invoice_no: String,
    pub invoice_date: String,
    pub supplier_id: Option<i64>,
    pub supplier_name: Option<String>,
    pub item_id: i64,
    pub item_code: Option<String>,
    pub item_name: String,
    pub qty: f64,
    pub unit_cost: f64,
    pub line_total: f64,
    pub vat_rate: f64,
}

/// Line-level purchase rows in a date range (one row per invoice line), joined
/// to item + supplier master data. Powers the Purchases-by-Item screen.
#[tauri::command]
pub fn report_purchase_invoice_lines(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
) -> Result<Vec<PurchaseLineReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT l.purchase_id, p.invoice_no, p.invoice_date, p.supplier_id, s.name_ar, \
         l.item_id, i.code, i.name_ar, l.qty, l.unit_cost, l.line_total, l.vat_rate \
         FROM purchase_lines_local l \
         JOIN purchases_local p ON p.id = l.purchase_id \
         LEFT JOIN suppliers_local s ON s.id = p.supplier_id \
         LEFT JOIN items_local i ON i.id = l.item_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND p.invoice_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND p.invoice_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND p.branch_id = ?"); args.push(Box::new(b)); }
    sql.push_str(" ORDER BY p.invoice_date, l.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(PurchaseLineReportRow {
        purchase_id: r.get(0)?, invoice_no: r.get(1)?, invoice_date: r.get(2)?, supplier_id: r.get(3)?,
        supplier_name: r.get(4)?, item_id: r.get(5)?, item_code: r.get(6)?, item_name: r.get(7)?,
        qty: r.get(8)?, unit_cost: r.get(9)?, line_total: r.get(10)?, vat_rate: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseReturnReportRow {
    pub id: i64,
    pub return_no: String,
    pub return_date: String,
    pub supplier_id: Option<i64>,
    pub supplier_name: Option<String>,
    pub subtotal: f64,
    pub vat_total: f64,
    pub grand_total: f64,
}

/// Purchase returns (debit notes) in a date range, optionally scoped by branch /
/// supplier. Feeds the net-purchases column on Purchases-by-Supplier and the
/// dedicated Purchase Returns report.
#[tauri::command]
pub fn report_purchase_returns(
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<i64>,
    supplier_id: Option<i64>,
) -> Result<Vec<PurchaseReturnReportRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT r.id, r.return_no, r.return_date, r.supplier_id, s.name_ar, \
         r.subtotal, r.vat_total, r.grand_total \
         FROM purchase_returns_local r \
         LEFT JOIN suppliers_local s ON s.id = r.supplier_id WHERE 1=1"
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = &from_date { sql.push_str(" AND r.return_date >= ?"); args.push(Box::new(d.clone())); }
    if let Some(d) = &to_date { sql.push_str(" AND r.return_date <= ?"); args.push(Box::new(d.clone())); }
    if let Some(b) = branch_id { sql.push_str(" AND r.branch_id = ?"); args.push(Box::new(b)); }
    if let Some(su) = supplier_id { sql.push_str(" AND r.supplier_id = ?"); args.push(Box::new(su)); }
    sql.push_str(" ORDER BY r.return_date, r.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_ref), |r| Ok(PurchaseReturnReportRow {
        id: r.get(0)?, return_no: r.get(1)?, return_date: r.get(2)?, supplier_id: r.get(3)?,
        supplier_name: r.get(4)?, subtotal: r.get(5)?, vat_total: r.get(6)?, grand_total: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

// ─────────────────────────── Taxes (الضرائب) ───────────────────────────
// Dynamic master list of taxes. Each tax owns one GL account + a rate, and
// declares per-direction availability + debit/credit nature. Exactly one row
// may carry is_default=1 (enforced in a transaction on create/update/set).

fn default_rate_type() -> String { "percent".into() }
fn default_credit() -> String { "credit".into() }
fn default_debit() -> String { "debit".into() }

fn norm_rate_type(s: &str) -> String {
    if s.trim().eq_ignore_ascii_case("value") { "value".into() } else { "percent".into() }
}
fn norm_nature(s: &str, fallback: &str) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "debit" => "debit".into(),
        "credit" => "credit".into(),
        _ => fallback.into(),
    }
}
fn uniq_tax(e: rusqlite::Error) -> String {
    if e.to_string().contains("UNIQUE") { "كود الضريبة مستخدم من قبل".to_string() } else { e.to_string() }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tax {
    pub id: i64,
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub currency_code: Option<String>,
    pub branch_id: Option<i64>,
    pub rate_type: String,
    pub rate_value: f64,
    pub account_id: Option<i64>,
    pub sales_enabled: bool,
    pub sales_nature: String,
    pub sales_return_enabled: bool,
    pub sales_return_nature: String,
    pub purchase_enabled: bool,
    pub purchase_nature: String,
    pub purchase_return_enabled: bool,
    pub purchase_return_nature: String,
    pub is_default: bool,
    pub is_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxInput {
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub currency_code: Option<String>,
    pub branch_id: Option<i64>,
    #[serde(default = "default_rate_type")]
    pub rate_type: String,
    #[serde(default)]
    pub rate_value: f64,
    pub account_id: Option<i64>,
    #[serde(default = "default_true")]
    pub sales_enabled: bool,
    #[serde(default = "default_credit")]
    pub sales_nature: String,
    #[serde(default = "default_true")]
    pub sales_return_enabled: bool,
    #[serde(default = "default_debit")]
    pub sales_return_nature: String,
    #[serde(default = "default_true")]
    pub purchase_enabled: bool,
    #[serde(default = "default_debit")]
    pub purchase_nature: String,
    #[serde(default = "default_true")]
    pub purchase_return_enabled: bool,
    #[serde(default = "default_credit")]
    pub purchase_return_nature: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

fn row_to_tax(r: &rusqlite::Row) -> rusqlite::Result<Tax> {
    Ok(Tax {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        currency_code: r.get(4)?, branch_id: r.get(5)?,
        rate_type: r.get(6)?, rate_value: r.get(7)?, account_id: r.get(8)?,
        sales_enabled: r.get::<_, i64>(9)? != 0, sales_nature: r.get(10)?,
        sales_return_enabled: r.get::<_, i64>(11)? != 0, sales_return_nature: r.get(12)?,
        purchase_enabled: r.get::<_, i64>(13)? != 0, purchase_nature: r.get(14)?,
        purchase_return_enabled: r.get::<_, i64>(15)? != 0, purchase_return_nature: r.get(16)?,
        is_default: r.get::<_, i64>(17)? != 0, is_active: r.get::<_, i64>(18)? != 0,
    })
}

const TAX_COLS: &str = "id,code,name_ar,name_en,currency_code,branch_id,rate_type,rate_value,account_id,\
    sales_enabled,sales_nature,sales_return_enabled,sales_return_nature,\
    purchase_enabled,purchase_nature,purchase_return_enabled,purchase_return_nature,\
    is_default,is_active";

#[tauri::command]
pub fn taxes_list() -> Result<Vec<Tax>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM taxes_local ORDER BY code", TAX_COLS))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_tax).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn tax_create(input: TaxInput) -> Result<i64, String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let rate_type = norm_rate_type(&input.rate_type);
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if input.is_default {
        tx.execute("UPDATE taxes_local SET is_default=0", []).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO taxes_local(code,name_ar,name_en,currency_code,branch_id,rate_type,rate_value,account_id,\
         sales_enabled,sales_nature,sales_return_enabled,sales_return_nature,\
         purchase_enabled,purchase_nature,purchase_return_enabled,purchase_return_nature,\
         is_default,is_active) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![
            input.code.trim(), input.name_ar.trim(), input.name_en, input.currency_code,
            input.branch_id, rate_type, input.rate_value, input.account_id,
            input.sales_enabled as i64, norm_nature(&input.sales_nature, "credit"),
            input.sales_return_enabled as i64, norm_nature(&input.sales_return_nature, "debit"),
            input.purchase_enabled as i64, norm_nature(&input.purchase_nature, "debit"),
            input.purchase_return_enabled as i64, norm_nature(&input.purchase_return_nature, "credit"),
            input.is_default as i64, input.is_active as i64,
        ],
    ).map_err(uniq_tax)?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn tax_update(id: i64, input: TaxInput) -> Result<(), String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let rate_type = norm_rate_type(&input.rate_type);
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if input.is_default {
        tx.execute("UPDATE taxes_local SET is_default=0", []).map_err(|e| e.to_string())?;
    }
    let n = tx.execute(
        "UPDATE taxes_local SET code=?1,name_ar=?2,name_en=?3,currency_code=?4,branch_id=?5,\
         rate_type=?6,rate_value=?7,account_id=?8,\
         sales_enabled=?9,sales_nature=?10,sales_return_enabled=?11,sales_return_nature=?12,\
         purchase_enabled=?13,purchase_nature=?14,purchase_return_enabled=?15,purchase_return_nature=?16,\
         is_default=?17,is_active=?18 WHERE id=?19",
        params![
            input.code.trim(), input.name_ar.trim(), input.name_en, input.currency_code,
            input.branch_id, rate_type, input.rate_value, input.account_id,
            input.sales_enabled as i64, norm_nature(&input.sales_nature, "credit"),
            input.sales_return_enabled as i64, norm_nature(&input.sales_return_nature, "debit"),
            input.purchase_enabled as i64, norm_nature(&input.purchase_nature, "debit"),
            input.purchase_return_enabled as i64, norm_nature(&input.purchase_return_nature, "credit"),
            input.is_default as i64, input.is_active as i64, id,
        ],
    ).map_err(uniq_tax)?;
    if n == 0 { return Err("الضريبة غير موجودة".into()); }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tax_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM taxes_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tax_set_default(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE taxes_local SET is_default=0", []).map_err(|e| e.to_string())?;
    let n = tx.execute(
        "UPDATE taxes_local SET is_default=1, is_active=1 WHERE id=?1", params![id],
    ).map_err(|e| e.to_string())?;
    if n == 0 { return Err("الضريبة غير موجودة".into()); }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// W4 — Supplier Groups, Supplier Settlement, Letters of Credit + Expenses
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────── Supplier Groups ──────────────────────────
// Classification + a default discount % for suppliers. A supplier carries an
// optional group_id (suppliers_local.group_id). Pure master-data — no GL impact.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupplierGroup {
    pub id: i64,
    pub code: String,
    pub name_ar: String,
    pub name_en: Option<String>,
    pub discount_percent: f64,
    pub notes: Option<String>,
    pub is_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierGroupInput {
    pub code: String,
    pub name_ar: String,
    #[serde(default)] pub name_en: Option<String>,
    #[serde(default)] pub discount_percent: f64,
    #[serde(default)] pub notes: Option<String>,
    #[serde(default = "default_true")] pub is_active: bool,
}

fn row_to_supplier_group(r: &rusqlite::Row<'_>) -> rusqlite::Result<SupplierGroup> {
    Ok(SupplierGroup {
        id: r.get(0)?, code: r.get(1)?, name_ar: r.get(2)?, name_en: r.get(3)?,
        discount_percent: r.get(4)?, notes: r.get(5)?, is_active: r.get::<_, i64>(6)? != 0,
    })
}

#[tauri::command]
pub fn supplier_groups_list() -> Result<Vec<SupplierGroup>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name_ar,name_en,discount_percent,notes,is_active FROM supplier_groups_local ORDER BY code"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_supplier_group).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn supplier_group_get(id: i64) -> Result<SupplierGroup, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,code,name_ar,name_en,discount_percent,notes,is_active FROM supplier_groups_local WHERE id=?1",
        params![id], row_to_supplier_group,
    ).map_err(|_| "المجموعة غير موجودة".to_string())
}

#[tauri::command]
pub fn supplier_group_create(input: SupplierGroupInput) -> Result<i64, String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO supplier_groups_local(code,name_ar,name_en,discount_percent,notes,is_active) VALUES(?1,?2,?3,?4,?5,?6)",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, input.discount_percent, input.notes, if input.is_active {1} else {0}],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود المجموعة مستخدم من قبل".to_string() } else { e.to_string() })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn supplier_group_update(id: i64, input: SupplierGroupInput) -> Result<(), String> {
    if input.code.trim().is_empty() || input.name_ar.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE supplier_groups_local SET code=?1,name_ar=?2,name_en=?3,discount_percent=?4,notes=?5,is_active=?6 WHERE id=?7",
        params![input.code.trim(), input.name_ar.trim(), input.name_en, input.discount_percent, input.notes, if input.is_active {1} else {0}, id],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "كود المجموعة مستخدم من قبل".to_string() } else { e.to_string() })?;
    if n == 0 { return Err("المجموعة غير موجودة".into()); }
    Ok(())
}

#[tauri::command]
pub fn supplier_group_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let used: i64 = conn.query_row("SELECT COUNT(*) FROM suppliers_local WHERE group_id=?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف مجموعة مرتبطة بموردين".into()); }
    conn.execute("DELETE FROM supplier_groups_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────── Shared cash/bank settlement helpers ───────────────

/// AP control account for a supplier (its own ap_account_id, else default 2100).
fn supplier_ap_account(conn: &Connection, supplier_id: i64) -> Result<i64, String> {
    let ap: Option<i64> = conn
        .query_row("SELECT ap_account_id FROM suppliers_local WHERE id=?1", params![supplier_id], |r| r.get(0))
        .map_err(|_| "المورد غير موجود".to_string())?;
    match ap { Some(a) if a > 0 => Ok(a), _ => account_id_by_code(conn, "2100").map_err(|e| e.to_string()) }
}

/// Validates a cash|bank payment selection (settlements / LC funding never use
/// the supplier-credit method — these are real cash outflows).
fn validate_cash_bank_payment(method: &str, cash_box_id: Option<i64>, bank_id: Option<i64>) -> Result<(), String> {
    match method {
        "cash" => { if cash_box_id.is_none() { return Err("اختر الخزينة".into()); } }
        "bank" => { if bank_id.is_none() { return Err("اختر البنك".into()); } }
        _ => return Err("طريقة دفع غير صالحة".into()),
    }
    Ok(())
}

/// Native currency of the selected cash box / bank (defaults to SAR).
fn cash_bank_currency(conn: &Connection, method: &str, cash_box_id: Option<i64>, bank_id: Option<i64>) -> Result<String, String> {
    match method {
        "cash" => {
            let c = cash_box_id.ok_or("اختر الخزينة")?;
            conn.query_row("SELECT COALESCE(currency_code,'SAR') FROM cash_boxes_local WHERE id=?1", params![c], |r| r.get(0)).map_err(|e| e.to_string())
        }
        "bank" => {
            let b = bank_id.ok_or("اختر البنك")?;
            conn.query_row("SELECT COALESCE(currency_code,'SAR') FROM banks_local WHERE id=?1", params![b], |r| r.get(0)).map_err(|e| e.to_string())
        }
        _ => Err("طريقة دفع غير صالحة".into()),
    }
}

// ─────────────────────── Supplier Settlement ────────────────────────
// Outgoing payment against a supplier's payable. Lifecycle draft → posted.
// Posting books DR supplier-payable / CR cash|bank in BASE currency; the cash/
// bank shadow moves in the treasury's native currency (mirrors financial_tx).

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupplierSettlement {
    pub id: i64,
    pub doc_no: String,
    pub settlement_date: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub payment_method: String,
    pub cash_box_id: Option<i64>,
    pub bank_id: Option<i64>,
    pub amount: f64,
    pub currency_code: String,
    pub exchange_rate: f64,
    pub status: String,
    pub je_id: Option<i64>,
    pub notes: Option<String>,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierSettlementInput {
    pub settlement_date: String,
    pub supplier_id: i64,
    pub payment_method: String,
    #[serde(default)] pub cash_box_id: Option<i64>,
    #[serde(default)] pub bank_id: Option<i64>,
    pub amount: f64,
    #[serde(default)] pub notes: Option<String>,
    #[serde(default)] pub branch_id: Option<i64>,
    #[serde(default)] pub cost_center_id: Option<i64>,
}

fn row_to_settlement(r: &rusqlite::Row<'_>) -> rusqlite::Result<SupplierSettlement> {
    Ok(SupplierSettlement {
        id: r.get(0)?, doc_no: r.get(1)?, settlement_date: r.get(2)?, supplier_id: r.get(3)?,
        supplier_name: r.get(4)?, payment_method: r.get(5)?, cash_box_id: r.get(6)?, bank_id: r.get(7)?,
        amount: r.get(8)?, currency_code: r.get(9)?, exchange_rate: r.get(10)?, status: r.get(11)?,
        je_id: r.get(12)?, notes: r.get(13)?, branch_id: r.get(14)?, cost_center_id: r.get(15)?,
    })
}

const SETTLEMENT_SELECT: &str =
    "SELECT s.id,s.doc_no,s.settlement_date,s.supplier_id,sup.name_ar,s.payment_method,s.cash_box_id,s.bank_id,\
            s.amount,s.currency_code,s.exchange_rate,s.status,s.je_id,s.notes,s.branch_id,s.cost_center_id \
     FROM supplier_settlements_local s JOIN suppliers_local sup ON sup.id=s.supplier_id";

#[tauri::command]
pub fn supplier_settlements_list(limit: Option<i64>) -> Result<Vec<SupplierSettlement>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let sql = format!("{SETTLEMENT_SELECT} ORDER BY s.id DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], row_to_settlement).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn supplier_settlement_get(id: i64) -> Result<SupplierSettlement, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let sql = format!("{SETTLEMENT_SELECT} WHERE s.id=?1");
    conn.query_row(&sql, params![id], row_to_settlement).map_err(|_| "سند التسوية غير موجود".to_string())
}

#[tauri::command]
pub fn supplier_settlement_create(input: SupplierSettlementInput) -> Result<i64, String> {
    if input.amount <= 0.0 { return Err("المبلغ يجب أن يكون أكبر من صفر".into()); }
    validate_cash_bank_payment(&input.payment_method, input.cash_box_id, input.bank_id)?;
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let doc_no = next_doc_no(&tx, "supplier_settlement").map_err(|e| e.to_string())?;
    let cur = cash_bank_currency(&tx, &input.payment_method, input.cash_box_id, input.bank_id)?;
    let rate = current_rate_to_base(&tx, &cur).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO supplier_settlements_local(doc_no,settlement_date,supplier_id,payment_method,cash_box_id,bank_id,amount,currency_code,exchange_rate,status,notes,branch_id,cost_center_id) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?11,?12)",
        params![doc_no, input.settlement_date, input.supplier_id, input.payment_method, input.cash_box_id, input.bank_id, input.amount, cur, rate, input.notes, input.branch_id, input.cost_center_id],
    ).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn supplier_settlement_update(id: i64, input: SupplierSettlementInput) -> Result<(), String> {
    if input.amount <= 0.0 { return Err("المبلغ يجب أن يكون أكبر من صفر".into()); }
    validate_cash_bank_payment(&input.payment_method, input.cash_box_id, input.bank_id)?;
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let status: String = tx.query_row("SELECT status FROM supplier_settlements_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|_| "سند التسوية غير موجود".to_string())?;
    if status != "draft" { return Err("لا يمكن تعديل سند مرحّل — ألغِ الترحيل أولاً".into()); }
    let cur = cash_bank_currency(&tx, &input.payment_method, input.cash_box_id, input.bank_id)?;
    let rate = current_rate_to_base(&tx, &cur).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE supplier_settlements_local SET settlement_date=?1,supplier_id=?2,payment_method=?3,cash_box_id=?4,bank_id=?5,amount=?6,currency_code=?7,exchange_rate=?8,notes=?9,branch_id=?10,cost_center_id=?11,updated_at=CURRENT_TIMESTAMP WHERE id=?12",
        params![input.settlement_date, input.supplier_id, input.payment_method, input.cash_box_id, input.bank_id, input.amount, cur, rate, input.notes, input.branch_id, input.cost_center_id, id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn supplier_settlement_post(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, supplier_id, method, cb, bank, amount, date, branch, cc, notes, doc_no): (String, i64, String, Option<i64>, Option<i64>, f64, String, Option<i64>, Option<i64>, Option<String>, String) =
        tx.query_row(
            "SELECT status,supplier_id,payment_method,cash_box_id,bank_id,amount,settlement_date,branch_id,cost_center_id,notes,doc_no FROM supplier_settlements_local WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
        ).map_err(|_| "سند التسوية غير موجود".to_string())?;
    if status != "draft" { return Err("السند مرحّل بالفعل".into()); }
    if amount <= 0.0 { return Err("المبلغ يجب أن يكون أكبر من صفر".into()); }
    // Refresh the FX rate at post time (it may have moved since the draft).
    let cur = cash_bank_currency(&tx, &method, cb, bank)?;
    let rate = current_rate_to_base(&tx, &cur).map_err(|e| e.to_string())?;
    let amount_base = amount * rate;
    let ap = supplier_ap_account(&tx, supplier_id)?;
    let credit_acc = resolve_payment_credit_account(&tx, &method, supplier_id, cb, bank).map_err(|e| e.to_string())?;
    let desc = format!("تسوية مورد {doc_no}");
    let lines = vec![
        JournalEntryLine { id: None, account_id: ap, account_code: None, account_name: None, debit: amount_base, credit: 0.0, description: notes.clone().or_else(|| Some(desc.clone())) },
        JournalEntryLine { id: None, account_id: credit_acc, account_code: None, account_name: None, debit: 0.0, credit: amount_base, description: None },
    ];
    let je_id = insert_journal_entry(&tx, &date, Some(&desc), Some("supplier_settlement"), Some(id), branch, cc, &lines, true).map_err(|e| e.to_string())?;
    tx.execute("UPDATE supplier_settlements_local SET status='posted', je_id=?1, currency_code=?2, exchange_rate=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4", params![je_id, cur, rate, id]).map_err(|e| e.to_string())?;
    // Shadow: supplier payable (base) ↓ ; treasury (native) ↓.
    tx.execute("UPDATE suppliers_local SET balance=balance-?1 WHERE id=?2", params![amount_base, supplier_id]).map_err(|e| e.to_string())?;
    match method.as_str() {
        "cash" => { if let Some(c) = cb { tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![amount, c]).map_err(|e| e.to_string())?; } }
        "bank" => { if let Some(b) = bank { tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![amount, b]).map_err(|e| e.to_string())?; } }
        _ => {}
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn supplier_settlement_unpost(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, je_id, supplier_id, method, cb, bank, amount, rate): (String, Option<i64>, i64, String, Option<i64>, Option<i64>, f64, f64) =
        tx.query_row(
            "SELECT status,je_id,supplier_id,payment_method,cash_box_id,bank_id,amount,exchange_rate FROM supplier_settlements_local WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        ).map_err(|_| "سند التسوية غير موجود".to_string())?;
    if status != "posted" { return Err("السند غير مرحّل".into()); }
    let amount_base = amount * rate;
    if let Some(je) = je_id {
        reverse_je_balance(&tx, je).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM journal_entry_lines_local WHERE entry_id=?1", params![je]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM journal_entries_local WHERE id=?1", params![je]).map_err(|e| e.to_string())?;
    }
    tx.execute("UPDATE supplier_settlements_local SET status='draft', je_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE suppliers_local SET balance=balance+?1 WHERE id=?2", params![amount_base, supplier_id]).map_err(|e| e.to_string())?;
    match method.as_str() {
        "cash" => { if let Some(c) = cb { tx.execute("UPDATE cash_boxes_local SET balance=balance+?1 WHERE id=?2", params![amount, c]).map_err(|e| e.to_string())?; } }
        "bank" => { if let Some(b) = bank { tx.execute("UPDATE banks_local SET balance=balance+?1 WHERE id=?2", params![amount, b]).map_err(|e| e.to_string())?; } }
        _ => {}
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn supplier_settlement_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let status: String = conn.query_row("SELECT status FROM supplier_settlements_local WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|_| "سند التسوية غير موجود".to_string())?;
    if status == "posted" { return Err("لا يمكن حذف سند مرحّل — ألغِ الترحيل أولاً".into()); }
    conn.execute("DELETE FROM supplier_settlements_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────── Letters of Credit ─────────────────────────
// A bank-issued purchasing facility. total_amount is the face value in the LC
// currency; used_amount accumulates the BASE-currency goods value drawn down by
// linked purchase invoices (maintained by apply/reverse_purchase_impact).
// settlement_account_id is the clearing account a linked purchase credits for
// its goods portion. Status open → partial is auto; closed is a manual action.

/// Refreshes an LC's open/partial status from its used amount. Never overrides a
/// manual 'closed' and never auto-closes — a fully drawn LC stays 'partial'
/// until the operator closes it explicitly.
fn lc_recompute_status_in_tx(tx: &Transaction, lc_id: i64) -> Result<(), String> {
    let (used, status): (f64, String) = tx.query_row(
        "SELECT used_amount, status FROM letters_of_credit_local WHERE id=?1",
        params![lc_id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    if status == "closed" { return Ok(()); }
    let new_status = if used <= 0.0001 { "open" } else { "partial" };
    if new_status != status {
        tx.execute("UPDATE letters_of_credit_local SET status=?1 WHERE id=?2", params![new_status, lc_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LetterOfCredit {
    pub id: i64,
    pub lc_number: String,
    pub lc_date: String,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub bank_name: Option<String>,
    pub currency_code: String,
    pub exchange_rate: f64,
    pub total_amount: f64,
    pub used_amount: f64,
    pub settlement_account_id: Option<i64>,
    pub status: String,
    pub notes: Option<String>,
    pub branch_id: Option<i64>,
    pub cost_center_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LetterOfCreditInput {
    #[serde(default)] pub lc_number: Option<String>,
    pub lc_date: String,
    pub supplier_id: i64,
    #[serde(default)] pub bank_name: Option<String>,
    #[serde(default)] pub currency_code: Option<String>,
    #[serde(default)] pub exchange_rate: Option<f64>,
    #[serde(default)] pub total_amount: f64,
    #[serde(default)] pub settlement_account_id: Option<i64>,
    #[serde(default)] pub notes: Option<String>,
    #[serde(default)] pub branch_id: Option<i64>,
    #[serde(default)] pub cost_center_id: Option<i64>,
}

fn row_to_lc(r: &rusqlite::Row<'_>) -> rusqlite::Result<LetterOfCredit> {
    Ok(LetterOfCredit {
        id: r.get(0)?, lc_number: r.get(1)?, lc_date: r.get(2)?, supplier_id: r.get(3)?,
        supplier_name: r.get(4)?, bank_name: r.get(5)?, currency_code: r.get(6)?, exchange_rate: r.get(7)?,
        total_amount: r.get(8)?, used_amount: r.get(9)?, settlement_account_id: r.get(10)?,
        status: r.get(11)?, notes: r.get(12)?, branch_id: r.get(13)?, cost_center_id: r.get(14)?,
    })
}

const LC_SELECT: &str =
    "SELECT lc.id,lc.lc_number,lc.lc_date,lc.supplier_id,sup.name_ar,lc.bank_name,lc.currency_code,lc.exchange_rate,\
            lc.total_amount,lc.used_amount,lc.settlement_account_id,lc.status,lc.notes,lc.branch_id,lc.cost_center_id \
     FROM letters_of_credit_local lc JOIN suppliers_local sup ON sup.id=lc.supplier_id";

#[tauri::command]
pub fn lc_list(limit: Option<i64>) -> Result<Vec<LetterOfCredit>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let sql = format!("{LC_SELECT} ORDER BY lc.id DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lim], row_to_lc).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn lc_get(id: i64) -> Result<LetterOfCredit, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let sql = format!("{LC_SELECT} WHERE lc.id=?1");
    conn.query_row(&sql, params![id], row_to_lc).map_err(|_| "الاعتماد المستندي غير موجود".to_string())
}

#[tauri::command]
pub fn lc_create(input: LetterOfCreditInput) -> Result<i64, String> {
    if input.total_amount < 0.0 { return Err("قيمة الاعتماد غير صالحة".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let lc_number = match input.lc_number.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => next_doc_no(&tx, "letter_of_credit").map_err(|e| e.to_string())?,
    };
    let cur = input.currency_code.clone().unwrap_or_else(|| "SAR".to_string());
    let rate = input.exchange_rate.filter(|r| *r > 0.0).unwrap_or(1.0);
    tx.execute(
        "INSERT INTO letters_of_credit_local(lc_number,lc_date,supplier_id,bank_name,currency_code,exchange_rate,total_amount,used_amount,settlement_account_id,status,notes,branch_id,cost_center_id) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,'open',?9,?10,?11)",
        params![lc_number, input.lc_date, input.supplier_id, input.bank_name, cur, rate, input.total_amount,
                input.settlement_account_id.filter(|a| *a > 0), input.notes, input.branch_id, input.cost_center_id],
    ).map_err(|e| if e.to_string().contains("UNIQUE") { "رقم الاعتماد مستخدم من قبل".to_string() } else { e.to_string() })?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn lc_update(id: i64, input: LetterOfCreditInput) -> Result<(), String> {
    if input.total_amount < 0.0 { return Err("قيمة الاعتماد غير صالحة".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, used): (String, f64) = tx.query_row(
        "SELECT status, used_amount FROM letters_of_credit_local WHERE id=?1", params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| "الاعتماد المستندي غير موجود".to_string())?;
    if status == "closed" { return Err("الاعتماد مقفل — أعد فتحه أولاً".into()); }
    if input.total_amount + 0.0001 < used { return Err("لا يمكن أن تقل قيمة الاعتماد عن المبلغ المستخدم".into()); }
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    let rate = input.exchange_rate.filter(|r| *r > 0.0).unwrap_or(1.0);
    // lc_number is left immutable on edit (preserve the original reference).
    let n = tx.execute(
        "UPDATE letters_of_credit_local SET lc_date=?1,supplier_id=?2,bank_name=?3,currency_code=?4,exchange_rate=?5,total_amount=?6,settlement_account_id=?7,notes=?8,branch_id=?9,cost_center_id=?10 WHERE id=?11",
        params![input.lc_date, input.supplier_id, input.bank_name, cur, rate, input.total_amount,
                input.settlement_account_id.filter(|a| *a > 0), input.notes, input.branch_id, input.cost_center_id, id],
    ).map_err(|e| e.to_string())?;
    if n == 0 { return Err("الاعتماد المستندي غير موجود".into()); }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn lc_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let linked: i64 = conn.query_row("SELECT COUNT(*) FROM purchases_local WHERE lc_id=?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if linked > 0 { return Err("لا يمكن حذف اعتماد مرتبط بفواتير شراء".into()); }
    // lc_expenses cascade-delete via the FK ON DELETE CASCADE.
    conn.execute("DELETE FROM letters_of_credit_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn lc_close(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn.execute("UPDATE letters_of_credit_local SET status='closed' WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    if n == 0 { return Err("الاعتماد المستندي غير موجود".into()); }
    Ok(())
}

#[tauri::command]
pub fn lc_reopen(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = tx.execute("UPDATE letters_of_credit_local SET status='open' WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    if n == 0 { return Err("الاعتماد المستندي غير موجود".into()); }
    lc_recompute_status_in_tx(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Rebuilds used_amount from the SUM(subtotal) of all linked purchases and
/// refreshes the open/partial status. A repair tool if the running figure ever
/// drifts from the source documents.
#[tauri::command]
pub fn lc_recompute_usage(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let used: f64 = tx.query_row("SELECT COALESCE(SUM(subtotal),0) FROM purchases_local WHERE lc_id=?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let n = tx.execute("UPDATE letters_of_credit_local SET used_amount=?1 WHERE id=?2", params![used, id]).map_err(|e| e.to_string())?;
    if n == 0 { return Err("الاعتماد المستندي غير موجود".into()); }
    lc_recompute_status_in_tx(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcFundingInput {
    pub lc_id: i64,
    pub funding_date: String,
    pub amount: f64,
    pub payment_method: String,
    #[serde(default)] pub cash_box_id: Option<i64>,
    #[serde(default)] pub bank_id: Option<i64>,
    #[serde(default)] pub notes: Option<String>,
    #[serde(default)] pub branch_id: Option<i64>,
    #[serde(default)] pub cost_center_id: Option<i64>,
}

/// Funds the LC settlement/clearing account from cash|bank: DR settlement / CR
/// cash|bank, posted to the GL. (Offline replacement for the web AI-journal —
/// the operator picks the funding source explicitly.)
#[tauri::command]
pub fn lc_post_funding(input: LcFundingInput) -> Result<i64, String> {
    if input.amount <= 0.0 { return Err("المبلغ يجب أن يكون أكبر من صفر".into()); }
    validate_cash_bank_payment(&input.payment_method, input.cash_box_id, input.bank_id)?;
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (settle_acc, lc_number): (Option<i64>, String) = tx.query_row(
        "SELECT settlement_account_id, lc_number FROM letters_of_credit_local WHERE id=?1",
        params![input.lc_id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| "الاعتماد المستندي غير موجود".to_string())?;
    let settle_acc = settle_acc.ok_or_else(|| "حدد حساب تسوية الاعتماد أولاً".to_string())?;
    let cur = cash_bank_currency(&tx, &input.payment_method, input.cash_box_id, input.bank_id)?;
    let rate = current_rate_to_base(&tx, &cur).map_err(|e| e.to_string())?;
    let amount_base = input.amount * rate;
    let credit_acc = resolve_payment_credit_account(&tx, &input.payment_method, 0, input.cash_box_id, input.bank_id).map_err(|e| e.to_string())?;
    let desc = format!("تمويل اعتماد مستندي {lc_number}");
    let lines = vec![
        JournalEntryLine { id: None, account_id: settle_acc, account_code: None, account_name: None, debit: amount_base, credit: 0.0, description: input.notes.clone().or_else(|| Some(desc.clone())) },
        JournalEntryLine { id: None, account_id: credit_acc, account_code: None, account_name: None, debit: 0.0, credit: amount_base, description: None },
    ];
    let je_id = insert_journal_entry(&tx, &input.funding_date, Some(&desc), Some("lc_funding"), Some(input.lc_id), input.branch_id, input.cost_center_id, &lines, true).map_err(|e| e.to_string())?;
    // Shadow treasury in its native currency.
    match input.payment_method.as_str() {
        "cash" => { if let Some(c) = input.cash_box_id { tx.execute("UPDATE cash_boxes_local SET balance=balance-?1 WHERE id=?2", params![input.amount, c]).map_err(|e| e.to_string())?; } }
        "bank" => { if let Some(b) = input.bank_id { tx.execute("UPDATE banks_local SET balance=balance-?1 WHERE id=?2", params![input.amount, b]).map_err(|e| e.to_string())?; } }
        _ => {}
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(je_id)
}

// ──────────────────────────── LC Expenses ───────────────────────────
// Documents costs (freight, customs, bank fees …) booked against an LC. Pure
// record-keeping in the offline app — no GL impact (the cash outflow itself is
// recorded via the funding JE / settlements).

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LcExpense {
    pub id: i64,
    pub lc_id: i64,
    pub expense_type: String,
    pub account_id: Option<i64>,
    pub amount: f64,
    pub currency_code: String,
    pub exchange_rate: f64,
    pub notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcExpenseInput {
    pub lc_id: i64,
    pub expense_type: String,
    #[serde(default)] pub account_id: Option<i64>,
    #[serde(default)] pub amount: f64,
    #[serde(default)] pub currency_code: Option<String>,
    #[serde(default)] pub exchange_rate: Option<f64>,
    #[serde(default)] pub notes: Option<String>,
}

fn row_to_lc_expense(r: &rusqlite::Row<'_>) -> rusqlite::Result<LcExpense> {
    Ok(LcExpense {
        id: r.get(0)?, lc_id: r.get(1)?, expense_type: r.get(2)?, account_id: r.get(3)?,
        amount: r.get(4)?, currency_code: r.get(5)?, exchange_rate: r.get(6)?, notes: r.get(7)?,
    })
}

#[tauri::command]
pub fn lc_expenses_list(lc_id: i64) -> Result<Vec<LcExpense>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,lc_id,expense_type,account_id,amount,currency_code,exchange_rate,notes FROM lc_expenses_local WHERE lc_id=?1 ORDER BY id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([lc_id], row_to_lc_expense).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn lc_expense_create(input: LcExpenseInput) -> Result<i64, String> {
    if input.expense_type.trim().is_empty() { return Err("نوع المصروف مطلوب".into()); }
    if input.amount < 0.0 { return Err("قيمة المصروف غير صالحة".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    let rate = input.exchange_rate.filter(|r| *r > 0.0).unwrap_or(1.0);
    conn.execute(
        "INSERT INTO lc_expenses_local(lc_id,expense_type,account_id,amount,currency_code,exchange_rate,notes) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![input.lc_id, input.expense_type.trim(), input.account_id.filter(|a| *a > 0), input.amount, cur, rate, input.notes],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn lc_expense_update(id: i64, input: LcExpenseInput) -> Result<(), String> {
    if input.expense_type.trim().is_empty() { return Err("نوع المصروف مطلوب".into()); }
    if input.amount < 0.0 { return Err("قيمة المصروف غير صالحة".into()); }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur = input.currency_code.unwrap_or_else(|| "SAR".to_string());
    let rate = input.exchange_rate.filter(|r| *r > 0.0).unwrap_or(1.0);
    let n = conn.execute(
        "UPDATE lc_expenses_local SET expense_type=?1,account_id=?2,amount=?3,currency_code=?4,exchange_rate=?5,notes=?6 WHERE id=?7",
        params![input.expense_type.trim(), input.account_id.filter(|a| *a > 0), input.amount, cur, rate, input.notes, id],
    ).map_err(|e| e.to_string())?;
    if n == 0 { return Err("المصروف غير موجود".into()); }
    Ok(())
}

#[tauri::command]
pub fn lc_expense_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM lc_expenses_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}
