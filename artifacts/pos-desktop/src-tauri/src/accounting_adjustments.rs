use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{accounting, db};

fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountingAdjustment {
    pub id: i64,
    pub r#type: String,
    pub name: String,
    pub expense_account_id: i64,
    pub contra_account_id: i64,
    pub cost_center_id: Option<i64>,
    pub total_amount: f64,
    pub start_date: String,
    pub end_date: String,
    pub monthly_amount: f64,
    pub auto_generate: bool,
    pub carry_forward_enabled: bool,
    pub parent_adjustment_id: Option<i64>,
    pub status: String,
    pub notes: Option<String>,
    pub recognized_amount: f64,
    pub remaining_amount: f64,
    pub run_count: i64,
    pub last_generated_month: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountingAdjustmentInput {
    pub r#type: String,
    pub name: String,
    pub expense_account_id: i64,
    pub contra_account_id: i64,
    #[serde(default)]
    pub cost_center_id: Option<i64>,
    pub total_amount: f64,
    pub start_date: String,
    pub end_date: String,
    #[serde(default = "default_true")]
    pub auto_generate: bool,
    #[serde(default = "default_true")]
    pub carry_forward_enabled: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPeriod {
    pub period_month: String,
    pub entry_id: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPeriod {
    pub period_month: String,
    pub reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSummary {
    pub adjustment_id: i64,
    pub created: Vec<GeneratedPeriod>,
    pub skipped: Vec<SkippedPeriod>,
    pub total_months: usize,
    pub already_generated: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDueResult {
    pub total: usize,
    pub summary: Vec<GenerateSummary>,
}

struct AdjustmentRecord {
    id: i64,
    adj_type: String,
    name: String,
    expense_account_id: i64,
    contra_account_id: i64,
    cost_center_id: Option<i64>,
    total_amount: f64,
    start_date: String,
    end_date: String,
    monthly_amount: f64,
    auto_generate: bool,
    carry_forward_enabled: bool,
    parent_adjustment_id: Option<i64>,
    status: String,
    notes: Option<String>,
}

fn load_adjustment(conn: &Connection, id: i64) -> Result<AdjustmentRecord, String> {
    conn.query_row(
        "SELECT id,type,name,expense_account_id,contra_account_id,cost_center_id,total_amount,
                start_date,end_date,monthly_amount,auto_generate,carry_forward_enabled,
                parent_adjustment_id,status,notes
         FROM accounting_adjustments_local WHERE id=?1",
        params![id],
        |row| {
            Ok(AdjustmentRecord {
                id: row.get(0)?,
                adj_type: row.get(1)?,
                name: row.get(2)?,
                expense_account_id: row.get(3)?,
                contra_account_id: row.get(4)?,
                cost_center_id: row.get(5)?,
                total_amount: row.get(6)?,
                start_date: row.get(7)?,
                end_date: row.get(8)?,
                monthly_amount: row.get(9)?,
                auto_generate: row.get::<_, i64>(10)? != 0,
                carry_forward_enabled: row.get::<_, i64>(11)? != 0,
                parent_adjustment_id: row.get(12)?,
                status: row.get(13)?,
                notes: row.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "التسوية غير موجودة".to_string())
}

fn valid_iso_date(date: &str) -> bool {
    let parts: Vec<i32> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 || date.len() != 10 {
        return false;
    }
    let (year, month, day) = (parts[0], parts[1], parts[2]);
    if !(1..=12).contains(&month) || year < 1 {
        return false;
    }
    day >= 1 && day <= days_in_month(year, month)
}

fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn months_between(start: &str, end: &str) -> Vec<(String, String)> {
    let parse = |s: &str| -> (i32, i32, i32) {
        let mut p = s.split('-').map(|v| v.parse::<i32>().unwrap_or(0));
        (
            p.next().unwrap_or(0),
            p.next().unwrap_or(0),
            p.next().unwrap_or(0),
        )
    };
    let (sy, sm, sd) = parse(start);
    let (mut ey, mut em, ed) = parse(end);
    if ed < sd {
        em -= 1;
        if em < 1 {
            em = 12;
            ey -= 1;
        }
    }
    let count = ((ey - sy) * 12 + (em - sm) + 1).max(0);
    let mut schedule = Vec::with_capacity(count as usize);
    for k in 1..=count {
        let absolute_month = sm + k;
        let year = sy + (absolute_month - 1).div_euclid(12);
        let month = (absolute_month - 1).rem_euclid(12) + 1;
        let day = sd.min(days_in_month(year, month));
        let ym = format!("{year:04}-{month:02}");
        schedule.push((ym.clone(), format!("{ym}-{day:02}")));
    }
    schedule
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn validate_accounts(
    conn: &Connection,
    adj_type: &str,
    expense_id: i64,
    contra_id: i64,
) -> Result<(), String> {
    if !["prepaid", "accrued"].contains(&adj_type)
        || expense_id <= 0
        || contra_id <= 0
        || expense_id == contra_id
    {
        return Err("نوع التسوية أو الحسابات غير صالح".into());
    }
    let expense: Option<(String, bool, bool)> = conn
        .query_row(
            "SELECT type,is_leaf,is_active FROM accounts_local WHERE id=?1",
            params![expense_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let contra: Option<(String, bool, bool)> = conn
        .query_row(
            "SELECT type,is_leaf,is_active FROM accounts_local WHERE id=?1",
            params![contra_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let expense = expense.ok_or_else(|| "حساب المصروف غير موجود".to_string())?;
    let contra = contra.ok_or_else(|| "الحساب المقابل غير موجود".to_string())?;
    if expense.0 != "expense" || !expense.1 || !expense.2 {
        return Err("اختر حساب مصروف نشطًا وترحيليًا".into());
    }
    let expected_contra = if adj_type == "prepaid" {
        "asset"
    } else {
        "liability"
    };
    if contra.0 != expected_contra || !contra.1 || !contra.2 {
        return Err(if adj_type == "prepaid" {
            "اختر حساب أصل نشطًا وترحيليًا للمصروف المدفوع مقدمًا".into()
        } else {
            "اختر حساب التزام نشطًا وترحيليًا للمصروف المستحق".into()
        });
    }
    Ok(())
}

fn validate_cost_center(conn: &Connection, id: Option<i64>) -> Result<(), String> {
    let Some(id) = id else {
        return Ok(());
    };
    let valid: Option<i64> = conn
        .query_row(
            "SELECT id FROM cost_centers_local WHERE id=?1 AND is_active=1 AND is_posting=1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if valid.is_none() {
        return Err("مركز التكلفة غير موجود أو غير نشط/ترحيلي".into());
    }
    Ok(())
}

fn validate_input(conn: &Connection, input: &AccountingAdjustmentInput) -> Result<usize, String> {
    if !["prepaid", "accrued"].contains(&input.r#type.as_str()) {
        return Err("نوع التسوية غير صالح".into());
    }
    if input.name.trim().is_empty() {
        return Err("اسم التسوية مطلوب".into());
    }
    if !valid_iso_date(&input.start_date) || !valid_iso_date(&input.end_date) {
        return Err("تواريخ البداية والنهاية غير صالحة".into());
    }
    if input.end_date < input.start_date {
        return Err("تاريخ النهاية يجب ألا يسبق تاريخ البداية".into());
    }
    if !input.total_amount.is_finite() || input.total_amount <= 0.0 {
        return Err("المبلغ الإجمالي يجب أن يكون أكبر من صفر".into());
    }
    validate_accounts(
        conn,
        &input.r#type,
        input.expense_account_id,
        input.contra_account_id,
    )?;
    validate_cost_center(conn, input.cost_center_id)?;
    let months = months_between(&input.start_date, &input.end_date).len();
    if months == 0 {
        return Err("لا توجد أقساط شهرية ضمن الفترة المحددة".into());
    }
    Ok(months)
}

fn recognized_amount(conn: &Connection, id: i64) -> Result<(f64, i64, Option<String>), String> {
    conn.query_row(
        "SELECT COALESCE(SUM(amount),0),COUNT(*),MAX(period_month)
         FROM accounting_adjustment_runs_local WHERE adjustment_id=?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounting_adjustments_list() -> Result<Vec<AccountingAdjustment>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.id,a.type,a.name,a.expense_account_id,a.contra_account_id,a.cost_center_id,
                a.total_amount,a.start_date,a.end_date,a.monthly_amount,a.auto_generate,
                a.carry_forward_enabled,a.parent_adjustment_id,a.status,a.notes,
                COALESCE(SUM(r.amount),0),COUNT(r.id),MAX(r.period_month)
         FROM accounting_adjustments_local a
         LEFT JOIN accounting_adjustment_runs_local r ON r.adjustment_id=a.id
         GROUP BY a.id ORDER BY a.created_at DESC,a.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let total: f64 = row.get(6)?;
            let recognized: f64 = row.get(15)?;
            Ok(AccountingAdjustment {
                id: row.get(0)?,
                r#type: row.get(1)?,
                name: row.get(2)?,
                expense_account_id: row.get(3)?,
                contra_account_id: row.get(4)?,
                cost_center_id: row.get(5)?,
                total_amount: total,
                start_date: row.get(7)?,
                end_date: row.get(8)?,
                monthly_amount: row.get(9)?,
                auto_generate: row.get::<_, i64>(10)? != 0,
                carry_forward_enabled: row.get::<_, i64>(11)? != 0,
                parent_adjustment_id: row.get(12)?,
                status: row.get(13)?,
                notes: row.get(14)?,
                recognized_amount: recognized,
                remaining_amount: (total - recognized).max(0.0),
                run_count: row.get(16)?,
                last_generated_month: row.get(17)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
pub fn accounting_adjustment_create(input: AccountingAdjustmentInput) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let months = validate_input(&tx, &input)?;
    let total_amount = round2(input.total_amount);
    let monthly = round2(total_amount / months as f64);
    tx.execute(
        "INSERT INTO accounting_adjustments_local
         (type,name,expense_account_id,contra_account_id,cost_center_id,total_amount,start_date,end_date,
          monthly_amount,auto_generate,carry_forward_enabled,status,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'active',?12)",
        params![
            input.r#type, input.name.trim(), input.expense_account_id, input.contra_account_id,
            input.cost_center_id, total_amount, input.start_date, input.end_date,
            monthly, if input.auto_generate { 1 } else { 0 },
            if input.carry_forward_enabled { 1 } else { 0 }, input.notes,
        ],
    ).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn accounting_adjustment_update(
    id: i64,
    input: AccountingAdjustmentInput,
) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let current = load_adjustment(&tx, id)?;
    if !["active", "completed"].contains(&current.status.as_str()) {
        return Err(format!("لا يمكن تعديل تسوية بحالة {}", current.status));
    }
    let months = validate_input(&tx, &input)?;
    let (recognized, run_count, last_month) = recognized_amount(&tx, id)?;
    if run_count > 0 && input.r#type != current.adj_type {
        return Err("لا يمكن تغيير نوع التسوية بعد توليد أول قيد".into());
    }
    if run_count > 0 && input.start_date != current.start_date {
        return Err("لا يمكن تغيير تاريخ البداية بعد توليد أول قيد".into());
    }
    if run_count > 0
        && input.end_date.get(..7).unwrap_or(&input.end_date) < last_month.as_deref().unwrap_or("")
    {
        return Err("تاريخ النهاية الجديد يسبق آخر قسط مولّد".into());
    }
    let total_amount = round2(input.total_amount);
    if total_amount + 0.005 < recognized {
        return Err(format!(
            "المبلغ الجديد أقل من المبلغ المعترف به بالفعل ({recognized:.2})"
        ));
    }
    let remaining_installments = months.saturating_sub(run_count as usize);
    let remainder = round2(total_amount - recognized);
    if remaining_installments == 0 && remainder > 0.01 {
        return Err("لا توجد أشهر متبقية لتوزيع المبلغ الجديد — مدّد تاريخ النهاية".into());
    }
    let monthly = if remaining_installments > 0 {
        round2(remainder / remaining_installments as f64)
    } else {
        current.monthly_amount
    };
    let status = if current.status == "completed" && remainder > 0.01 {
        "active"
    } else {
        current.status.as_str()
    };
    tx.execute(
        "UPDATE accounting_adjustments_local
         SET type=?1,name=?2,expense_account_id=?3,contra_account_id=?4,cost_center_id=?5,
             total_amount=?6,start_date=?7,end_date=?8,monthly_amount=?9,auto_generate=?10,
             carry_forward_enabled=?11,notes=?12,status=?13,updated_at=CURRENT_TIMESTAMP
         WHERE id=?14",
        params![
            input.r#type,
            input.name.trim(),
            input.expense_account_id,
            input.contra_account_id,
            input.cost_center_id,
            total_amount,
            input.start_date,
            input.end_date,
            monthly,
            if input.auto_generate { 1 } else { 0 },
            if input.carry_forward_enabled { 1 } else { 0 },
            input.notes,
            status,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn accounting_adjustment_set_status(id: i64, status: String) -> Result<(), String> {
    if !["active", "cancelled"].contains(&status.as_str()) {
        return Err("الحالة المطلوبة غير مسموح بها".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE accounting_adjustments_local SET status=?1,updated_at=CURRENT_TIMESTAMP
         WHERE id=?2 AND status IN ('active','cancelled')",
            params![status, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("التسوية غير موجودة أو لا يمكن تغيير حالتها".into());
    }
    Ok(())
}

#[tauri::command]
pub fn accounting_adjustment_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let runs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM accounting_adjustment_runs_local WHERE adjustment_id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if runs > 0 {
        return Err(format!(
            "لا يمكن حذف تسوية لها {runs} قيد مولّد — ألغِها بدلاً من الحذف"
        ));
    }
    let changed = conn
        .execute(
            "DELETE FROM accounting_adjustments_local WHERE id=?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("التسوية غير موجودة".into());
    }
    Ok(())
}

fn generate_adjustment(
    id: i64,
    as_of_date: &str,
    require_auto: bool,
) -> Result<GenerateSummary, String> {
    if !valid_iso_date(as_of_date) {
        return Err("تاريخ التشغيل غير صالح".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let adjustment = load_adjustment(&tx, id)?;
    let mut result = GenerateSummary {
        adjustment_id: id,
        created: Vec::new(),
        skipped: Vec::new(),
        total_months: 0,
        already_generated: 0,
    };
    if adjustment.status != "active" {
        return Err(format!(
            "لا يمكن توليد أقساط لتسوية بحالة {}",
            adjustment.status
        ));
    }
    if require_auto && !adjustment.auto_generate {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let schedule = months_between(&adjustment.start_date, &adjustment.end_date);
    result.total_months = schedule.len();
    let mut stmt = tx.prepare(
        "SELECT period_month,amount FROM accounting_adjustment_runs_local WHERE adjustment_id=?1"
    ).map_err(|e| e.to_string())?;
    let run_rows = stmt
        .query_map(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut generated = std::collections::HashMap::<String, f64>::new();
    for row in run_rows {
        let (month, amount) = row.map_err(|e| e.to_string())?;
        generated.insert(month, amount);
    }
    drop(stmt);
    result.already_generated = generated.len();
    if generated.len() >= schedule.len() && !schedule.is_empty() {
        tx.execute(
            "UPDATE accounting_adjustments_local SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(result);
    }
    for (month, due_date) in schedule {
        if generated.len() >= result.total_months {
            break;
        }
        if due_date > as_of_date {
            break;
        }
        if generated.contains_key(&month) {
            continue;
        }
        if let Err(reason) = accounting::guard_period_open_for_date(&tx, &due_date) {
            result.skipped.push(SkippedPeriod {
                period_month: month,
                reason,
            });
            continue;
        }
        validate_accounts(
            &tx,
            &adjustment.adj_type,
            adjustment.expense_account_id,
            adjustment.contra_account_id,
        )?;
        validate_cost_center(&tx, adjustment.cost_center_id)?;
        let amount = round2(adjustment.monthly_amount);
        if amount <= 0.0 {
            return Err("قيمة القسط الشهري غير صالحة".into());
        }
        let description = format!(
            "{} — {} ({})",
            if adjustment.adj_type == "prepaid" {
                "تسوية مصروف مقدم"
            } else {
                "تسوية مصروف مستحق"
            },
            adjustment.name,
            month,
        );
        let lines = vec![
            accounting::ManualJeLine {
                id: None,
                account_id: adjustment.expense_account_id,
                account_code: None,
                account_name: None,
                debit: amount,
                credit: 0.0,
                description: Some(format!("قسط {month} لـ {}", adjustment.name)),
                cost_center_id: adjustment.cost_center_id,
            },
            accounting::ManualJeLine {
                id: None,
                account_id: adjustment.contra_account_id,
                account_code: None,
                account_name: None,
                debit: 0.0,
                credit: amount,
                description: Some(format!("قسط {month} لـ {}", adjustment.name)),
                cost_center_id: None,
            },
        ];
        let valid = accounting::valid_manual_lines(&lines);
        let (total_debit, total_credit) =
            accounting::validate_posted(&valid).map_err(|e| e.to_string())?;
        let post = accounting::resolve_auto_post(&tx, "adjustment");
        if post {
            accounting::guard_period_open_for_date(&tx, &due_date)?;
        }
        let entry_no = accounting::next_entry_no(&tx).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO journal_entries_local
             (entry_no,entry_date,description,total_debit,total_credit,source_type,source_id,entry_type,status)
             VALUES(?1,?2,?3,?4,?5,'manual',NULL,'adjustment',?6)",
            params![entry_no, due_date, description, total_debit, total_credit, if post { "posted" } else { "draft" }],
        ).map_err(|e| e.to_string())?;
        let entry_id = tx.last_insert_rowid();
        accounting::write_manual_lines(&tx, entry_id, &valid, None, post)
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO accounting_adjustment_runs_local(adjustment_id,period_month,journal_entry_id,amount)
             VALUES(?1,?2,?3,?4)",
            params![id, month, entry_id, amount],
        ).map_err(|e| e.to_string())?;
        generated.insert(month.clone(), amount);
        result.created.push(GeneratedPeriod {
            period_month: month,
            entry_id,
        });
    }
    if generated.len() >= result.total_months && result.total_months > 0 {
        tx.execute(
            "UPDATE accounting_adjustments_local SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn accounting_adjustment_generate(
    id: i64,
    as_of_date: String,
) -> Result<GenerateSummary, String> {
    generate_adjustment(id, &as_of_date, false)
}

#[tauri::command]
pub fn accounting_adjustments_run_due(as_of_date: String) -> Result<RunDueResult, String> {
    if !valid_iso_date(&as_of_date) {
        return Err("تاريخ التشغيل غير صالح".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id FROM accounting_adjustments_local WHERE status='active' AND auto_generate=1 ORDER BY id"
    ).map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);
    let mut result = RunDueResult {
        total: 0,
        summary: Vec::new(),
    };
    for id in ids {
        let summary = generate_adjustment(id, &as_of_date, true)?;
        result.total += summary.created.len();
        result.summary.push(summary);
    }
    Ok(result)
}

#[tauri::command]
pub fn accounting_adjustment_carry_forward(
    id: i64,
    new_start_date: String,
    new_end_date: String,
) -> Result<i64, String> {
    if !valid_iso_date(&new_start_date) || !valid_iso_date(&new_end_date) {
        return Err("تواريخ الترحيل غير صالحة".into());
    }
    if new_end_date < new_start_date {
        return Err("تاريخ النهاية يجب ألا يسبق البداية".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let parent = load_adjustment(&tx, id)?;
    if parent.status != "active" {
        return Err("يمكن ترحيل المتبقي من تسوية نشطة فقط".into());
    }
    if !parent.carry_forward_enabled {
        return Err("ترحيل المتبقي غير مفعّل لهذه التسوية".into());
    }
    if new_start_date <= parent.end_date {
        return Err("تاريخ بداية الترحيل يجب أن يأتي بعد نهاية التسوية الأصلية".into());
    }
    let (recognized, _, _) = recognized_amount(&tx, id)?;
    let remaining = round2(parent.total_amount - recognized);
    if remaining < 0.01 {
        return Err("لا يوجد مبلغ متبقٍ للترحيل".into());
    }
    validate_accounts(
        &tx,
        &parent.adj_type,
        parent.expense_account_id,
        parent.contra_account_id,
    )?;
    validate_cost_center(&tx, parent.cost_center_id)?;
    let months = months_between(&new_start_date, &new_end_date).len();
    if months == 0 {
        return Err("لا توجد أقساط شهرية ضمن الفترة الجديدة".into());
    }
    let monthly = round2(remaining / months as f64);
    let name = format!("{} — ترحيل {}", parent.name, &new_start_date[..4]);
    let notes = format!("مُرحَّل من التسوية رقم {} — رصيد متبقٍ {:.2}", id, remaining);
    tx.execute(
        "INSERT INTO accounting_adjustments_local
         (type,name,expense_account_id,contra_account_id,cost_center_id,total_amount,start_date,end_date,
          monthly_amount,auto_generate,carry_forward_enabled,parent_adjustment_id,status,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',?13)",
        params![
            parent.adj_type, name, parent.expense_account_id, parent.contra_account_id,
            parent.cost_center_id, remaining, new_start_date, new_end_date, monthly,
            if parent.auto_generate { 1 } else { 0 },
            if parent.carry_forward_enabled { 1 } else { 0 }, id, notes,
        ],
    ).map_err(|e| e.to_string())?;
    let child_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE accounting_adjustments_local SET status='carried_forward',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(child_id)
}
