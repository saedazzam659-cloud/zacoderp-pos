// ───────── Fiscal years + periods (الفترات المحاسبية) ─────────
// Mirrors the web app's fiscal-period model and IFRS-aligned closing wizard for
// the offline desktop app. A fiscal year owns a list of (usually monthly)
// periods; each period has an `open → closed (soft) → permanently_closed (hard)`
// lifecycle. Posting into a `closed` / `permanently_closed` period is rejected
// by `accounting::guard_period_open_for_*`.
//
// Closing cycle per period (run while the period is still OPEN):
//   1. validate        — surface drafts / unbalanced / open P&L accounts
//   2. close-pl        — Dr revenues / Cr expenses → P&L summary (equity)
//   3. transfer-profit — P&L summary → retained earnings
//   4. soft-close      — open → closed (reversible; `force` overrides blockers)
//   5. hard-close      — closed → permanently_closed (irreversible; verifies the
//                        closing entries exist unless the period had zero P&L)
//   +  force-reopen    — last-resort unlock (requires a reason ≥ 10 chars)

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::accounting::{insert_closing_entry, JournalEntryLine};
use crate::db;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FiscalYear {
    pub id: i64,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FiscalPeriod {
    pub id: i64,
    pub fiscal_year_id: i64,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub status: String,
}

struct PeriodRow {
    id: i64,
    fiscal_year_id: i64,
    name: String,
    start_date: String,
    end_date: String,
    status: String,
}

fn fetch_period(tx: &Transaction, id: i64) -> Result<PeriodRow, String> {
    tx.query_row(
        "SELECT id, fiscal_year_id, name, start_date, end_date, status FROM fiscal_periods_local WHERE id=?1",
        params![id],
        |r| {
            Ok(PeriodRow {
                id: r.get(0)?,
                fiscal_year_id: r.get(1)?,
                name: r.get(2)?,
                start_date: r.get(3)?,
                end_date: r.get(4)?,
                status: r.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "الفترة غير موجودة".to_string())
}

// (account_id, balance) for posted lines on accounts of `acct_type` within the
// period date range. `balance` is the natural-sign balance for that account
// type: revenue = credit − debit, expense = debit − credit.
fn balances_by_type(
    tx: &Transaction,
    start: &str,
    end: &str,
    acct_type: &str,
) -> Result<Vec<(i64, f64)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT l.account_id, COALESCE(SUM(l.debit),0), COALESCE(SUM(l.credit),0) \
             FROM journal_entry_lines_local l \
             JOIN journal_entries_local e ON e.id = l.entry_id \
             JOIN accounts_local a ON a.id = l.account_id \
             WHERE e.status='posted' AND a.type=?1 \
               AND substr(e.entry_date,1,10) >= ?2 AND substr(e.entry_date,1,10) <= ?3 \
             GROUP BY l.account_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![acct_type, start, end], |r| {
            let acc: i64 = r.get(0)?;
            let debit: f64 = r.get(1)?;
            let credit: f64 = r.get(2)?;
            let balance = if acct_type == "revenue" { credit - debit } else { debit - credit };
            Ok((acc, balance, debit, credit))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    // Return (account_id, signed_balance). Keep raw debit/credit available via
    // the closure but we only need the signed balance + magnitude here.
    Ok(rows.into_iter().map(|(a, b, _d, _c)| (a, b)).collect())
}

fn require_equity_account(tx: &Transaction, id: i64, label: &str) -> Result<(), String> {
    let typ: Option<String> = tx
        .query_row("SELECT type FROM accounts_local WHERE id=?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match typ.as_deref() {
        Some("equity") => Ok(()),
        Some(_) => Err(format!("{label} يجب أن يكون من نوع حقوق ملكية")),
        None => Err(format!("{label} غير موجود في شجرة الحسابات")),
    }
}

// ───────── Years ─────────

#[tauri::command]
pub fn fiscal_years_list() -> Result<Vec<FiscalYear>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, start_date, end_date, status FROM fiscal_years_local ORDER BY start_date DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FiscalYear {
                id: r.get(0)?,
                name: r.get(1)?,
                start_date: r.get(2)?,
                end_date: r.get(3)?,
                status: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Creates a fiscal year and, when `generate_monthly` is true, one period per
/// calendar month spanning [start_date, end_date]. Dates are `YYYY-MM-DD`.
#[tauri::command]
pub fn fiscal_year_create(
    name: String,
    start_date: String,
    end_date: String,
    generate_monthly: bool,
) -> Result<i64, String> {
    let start = parse_date(&start_date)?;
    let end = parse_date(&end_date)?;
    if end < start {
        return Err("تاريخ النهاية يجب أن يكون بعد تاريخ البداية".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO fiscal_years_local(name,start_date,end_date,status) VALUES(?1,?2,?3,'open')",
        params![name.trim(), start_date, end_date],
    )
    .map_err(|e| e.to_string())?;
    let year_id = tx.last_insert_rowid();
    if generate_monthly {
        for (pname, pstart, pend) in month_periods(&start, &end) {
            tx.execute(
                "INSERT INTO fiscal_periods_local(fiscal_year_id,name,start_date,end_date,status) VALUES(?1,?2,?3,?4,'open')",
                params![year_id, pname, pstart, pend],
            )
            .map_err(|e| e.to_string())?;
        }
    } else {
        // Single period covering the whole year.
        tx.execute(
            "INSERT INTO fiscal_periods_local(fiscal_year_id,name,start_date,end_date,status) VALUES(?1,?2,?3,?4,'open')",
            params![year_id, name.trim(), start_date, end_date],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(year_id)
}

/// Deletes a fiscal year (cascades to its periods). Refuses if any period is
/// permanently closed — the audit trail of a hard-closed period is final.
#[tauri::command]
pub fn fiscal_year_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let locked: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM fiscal_periods_local WHERE fiscal_year_id=?1 AND status='permanently_closed'",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if locked > 0 {
        return Err("لا يمكن حذف سنة مالية تحتوي على فترات مقفلة نهائياً".into());
    }
    conn.execute("DELETE FROM fiscal_years_local WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn fiscal_year_set_status(id: i64, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "open" | "closed" | "permanently_closed") {
        return Err("حالة غير صالحة".into());
    }
    let conn = db::open().map_err(|e| e.to_string())?;
    let cur: Option<String> = conn
        .query_row("SELECT status FROM fiscal_years_local WHERE id=?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let cur = cur.ok_or_else(|| "السنة المالية غير موجودة".to_string())?;
    if cur == "permanently_closed" && status != "permanently_closed" {
        return Err("السنة المالية مقفلة نهائياً — استخدم فك القفل من فترة بداخلها".into());
    }
    conn.execute("UPDATE fiscal_years_local SET status=?1 WHERE id=?2", params![status, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ───────── Periods ─────────

#[tauri::command]
pub fn fiscal_periods_list(year_id: Option<i64>) -> Result<Vec<FiscalPeriod>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let (sql, has_filter) = match year_id {
        Some(_) => (
            "SELECT id, fiscal_year_id, name, start_date, end_date, status FROM fiscal_periods_local WHERE fiscal_year_id=?1 ORDER BY start_date",
            true,
        ),
        None => (
            "SELECT id, fiscal_year_id, name, start_date, end_date, status FROM fiscal_periods_local ORDER BY start_date",
            false,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| {
        Ok(FiscalPeriod {
            id: r.get(0)?,
            fiscal_year_id: r.get(1)?,
            name: r.get(2)?,
            start_date: r.get(3)?,
            end_date: r.get(4)?,
            status: r.get(5)?,
        })
    };
    let rows = if has_filter {
        stmt.query_map(params![year_id.unwrap()], map)
    } else {
        stmt.query_map([], map)
    }
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResult {
    pub ok: bool,
    pub drafts: i64,
    pub unbalanced: i64,
    pub open_revenue_accounts: i64,
    pub open_expense_accounts: i64,
    pub requires_pl_close: bool,
    pub issues: Vec<String>,
}

fn count_drafts(tx: &Transaction, start: &str, end: &str) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM journal_entries_local WHERE status='draft' \
         AND substr(entry_date,1,10) >= ?1 AND substr(entry_date,1,10) <= ?2",
        params![start, end],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn count_unbalanced(tx: &Transaction, start: &str, end: &str) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM ( \
            SELECT l.entry_id, ABS(COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0)) AS diff \
            FROM journal_entry_lines_local l \
            JOIN journal_entries_local e ON e.id = l.entry_id \
            WHERE e.status='posted' \
              AND substr(e.entry_date,1,10) >= ?1 AND substr(e.entry_date,1,10) <= ?2 \
            GROUP BY l.entry_id HAVING diff > 0.01 \
         )",
        params![start, end],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn validate_core(tx: &Transaction, p: &PeriodRow) -> Result<ValidateResult, String> {
    let drafts = count_drafts(tx, &p.start_date, &p.end_date)?;
    let unbalanced = count_unbalanced(tx, &p.start_date, &p.end_date)?;
    let rev = balances_by_type(tx, &p.start_date, &p.end_date, "revenue")?;
    let exp = balances_by_type(tx, &p.start_date, &p.end_date, "expense")?;
    let open_rev = rev.iter().filter(|(_, b)| b.abs() > 0.005).count() as i64;
    let open_exp = exp.iter().filter(|(_, b)| b.abs() > 0.005).count() as i64;
    let requires_pl_close = open_rev > 0 || open_exp > 0;
    let mut issues = Vec::new();
    if drafts > 0 {
        issues.push(format!("يوجد {drafts} قيد غير مرحّل"));
    }
    if unbalanced > 0 {
        issues.push(format!("يوجد {unbalanced} قيد غير متوازن"));
    }
    if requires_pl_close {
        issues.push(format!(
            "حسابات الإيرادات والمصروفات لم تُقفل بعد ({open_rev} إيراد، {open_exp} مصروف برصيد غير صفري)"
        ));
    }
    Ok(ValidateResult {
        ok: issues.is_empty(),
        drafts,
        unbalanced,
        open_revenue_accounts: open_rev,
        open_expense_accounts: open_exp,
        requires_pl_close,
        issues,
    })
}

#[tauri::command]
pub fn fiscal_period_validate(id: i64) -> Result<ValidateResult, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    let res = validate_core(&tx, &p)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(res)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosePlResult {
    pub revenue_entry_id: Option<i64>,
    pub expense_entry_id: Option<i64>,
    pub total_revenue: f64,
    pub total_expense: f64,
    pub net_income: f64,
}

/// Step 2 — zero out revenue & expense accounts into the P&L summary (equity).
#[tauri::command]
pub fn fiscal_period_close_pl(id: i64, pl_summary_account_id: i64) -> Result<ClosePlResult, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    if p.status != "open" {
        return Err("الفترة ليست مفتوحة".into());
    }
    require_equity_account(&tx, pl_summary_account_id, "حساب الأرباح والخسائر")?;

    let rev = balances_by_type(&tx, &p.start_date, &p.end_date, "revenue")?;
    let exp = balances_by_type(&tx, &p.start_date, &p.end_date, "expense")?;
    let rev_lines: Vec<(i64, f64)> = rev.into_iter().filter(|(_, b)| b.abs() > 0.005).collect();
    let exp_lines: Vec<(i64, f64)> = exp.into_iter().filter(|(_, b)| b.abs() > 0.005).collect();
    if rev_lines.is_empty() && exp_lines.is_empty() {
        return Err("لا توجد إيرادات أو مصروفات لإقفالها في هذه الفترة".into());
    }

    let mk = |account_id: i64, debit: f64, credit: f64, desc: &str| JournalEntryLine {
        id: None,
        account_id,
        account_code: None,
        account_name: None,
        debit,
        credit,
        description: Some(desc.to_string()),
    };

    let mut revenue_entry_id = None;
    let mut expense_entry_id = None;
    let mut total_rev = 0.0;
    let mut total_exp = 0.0;

    // (a) Close revenues — Dr each revenue by its credit-balance, Cr P&L summary
    if !rev_lines.is_empty() {
        total_rev = rev_lines.iter().map(|(_, b)| *b).sum();
        let mut lines: Vec<JournalEntryLine> = rev_lines
            .iter()
            .map(|(acc, bal)| mk(*acc, *bal, 0.0, "إقفال رصيد إيرادات"))
            .collect();
        lines.push(mk(pl_summary_account_id, 0.0, total_rev, "إجمالي الإيرادات → الأرباح والخسائر"));
        let eid = insert_closing_entry(
            &tx,
            &p.end_date,
            &format!("قيد إقفال الإيرادات — {}", p.name),
            "closing_revenue",
            p.id,
            &lines,
        )?;
        revenue_entry_id = Some(eid);
    }

    // (b) Close expenses — Dr P&L summary, Cr each expense by its debit-balance
    if !exp_lines.is_empty() {
        total_exp = exp_lines.iter().map(|(_, b)| *b).sum();
        let mut lines: Vec<JournalEntryLine> =
            vec![mk(pl_summary_account_id, total_exp, 0.0, "الأرباح والخسائر → إجمالي المصروفات")];
        for (acc, bal) in &exp_lines {
            lines.push(mk(*acc, 0.0, *bal, "إقفال رصيد مصروفات"));
        }
        let eid = insert_closing_entry(
            &tx,
            &p.end_date,
            &format!("قيد إقفال المصروفات — {}", p.name),
            "closing_expense",
            p.id,
            &lines,
        )?;
        expense_entry_id = Some(eid);
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ClosePlResult {
        revenue_entry_id,
        expense_entry_id,
        total_revenue: total_rev,
        total_expense: total_exp,
        net_income: total_rev - total_exp,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProfitResult {
    pub entry_id: i64,
    pub is_profit: bool,
    pub amount: f64,
}

/// Step 3 — move the P&L summary balance to retained earnings.
#[tauri::command]
pub fn fiscal_period_transfer_profit(
    id: i64,
    pl_summary_account_id: i64,
    retained_earnings_account_id: i64,
) -> Result<TransferProfitResult, String> {
    if pl_summary_account_id == retained_earnings_account_id {
        return Err("حساب الأرباح والخسائر وحساب الأرباح المحتجزة يجب أن يكونا مختلفين".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    if p.status != "open" {
        return Err("الفترة ليست مفتوحة".into());
    }
    require_equity_account(&tx, pl_summary_account_id, "حساب الأرباح والخسائر")?;
    require_equity_account(&tx, retained_earnings_account_id, "حساب الأرباح المحتجزة")?;

    // Current P&L summary balance over the period (after close-pl ran):
    // credit − debit → positive = profit.
    let (debit, credit): (f64, f64) = tx
        .query_row(
            "SELECT COALESCE(SUM(l.debit),0), COALESCE(SUM(l.credit),0) \
             FROM journal_entry_lines_local l \
             JOIN journal_entries_local e ON e.id = l.entry_id \
             WHERE e.status='posted' AND l.account_id=?1 \
               AND substr(e.entry_date,1,10) >= ?2 AND substr(e.entry_date,1,10) <= ?3",
            params![pl_summary_account_id, p.start_date, p.end_date],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let net = credit - debit;
    if net.abs() < 0.005 {
        return Err("رصيد الأرباح والخسائر صفر — لا يوجد ما يُرحّل".into());
    }
    let is_profit = net > 0.0;
    let amount = net.abs();

    let mk = |account_id: i64, debit: f64, credit: f64, desc: &str| JournalEntryLine {
        id: None,
        account_id,
        account_code: None,
        account_name: None,
        debit,
        credit,
        description: Some(desc.to_string()),
    };

    // Profit: Dr P&L summary, Cr Retained earnings
    // Loss:   Dr Retained earnings, Cr P&L summary
    let lines = if is_profit {
        vec![
            mk(pl_summary_account_id, amount, 0.0, "إقفال رصيد الأرباح والخسائر"),
            mk(retained_earnings_account_id, 0.0, amount, "إضافة صافي الربح للأرباح المحتجزة"),
        ]
    } else {
        vec![
            mk(retained_earnings_account_id, amount, 0.0, "تخفيض الأرباح المحتجزة بصافي الخسارة"),
            mk(pl_summary_account_id, 0.0, amount, "إقفال رصيد الأرباح والخسائر"),
        ]
    };
    let entry_id = insert_closing_entry(
        &tx,
        &p.end_date,
        &format!("ترحيل {} الفترة — {}", if is_profit { "أرباح" } else { "خسائر" }, p.name),
        if is_profit { "closing_transfer_profit" } else { "closing_transfer_loss" },
        p.id,
        &lines,
    )?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(TransferProfitResult { entry_id, is_profit, amount })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftCloseResult {
    pub ok: bool,
    pub forced: bool,
    pub pl_closed: bool,
}

/// Step 4 — open → closed (soft). Refuses on blockers unless `force` is true.
#[tauri::command]
pub fn fiscal_period_soft_close(id: i64, force: bool) -> Result<SoftCloseResult, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    if p.status != "open" {
        return Err("الفترة ليست مفتوحة".into());
    }
    let v = validate_core(&tx, &p)?;
    if !force && !v.ok {
        return Err(format!(
            "لا يمكن إقفال الفترة — {}. فعّل خيار التجاوز للإقفال رغم ذلك",
            v.issues.join("؛ ")
        ));
    }
    tx.execute("UPDATE fiscal_periods_local SET status='closed' WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SoftCloseResult { ok: true, forced: force, pl_closed: !v.requires_pl_close })
}

/// Step 5 — closed → permanently_closed (hard). No force override; verifies the
/// closing entries exist unless the period had zero P&L activity.
#[tauri::command]
pub fn fiscal_period_hard_close(id: i64) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    if p.status == "permanently_closed" {
        return Ok(());
    }
    if p.status != "closed" {
        return Err("يجب إجراء الإقفال الناعم أولاً قبل الإقفال النهائي".into());
    }

    // Only POSTED closing entries count — Posting Center can unpost any JE
    // (including closing JEs) back to draft, and a draft closing entry has no
    // GL effect. Allowing hard-close against unposted closing drafts would
    // permanently lock the period with an incomplete close.
    let has_pl_close: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM journal_entries_local WHERE period_id=?1 \
             AND status='posted' \
             AND entry_type IN ('closing_revenue','closing_expense')",
            params![p.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let has_transfer: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM journal_entries_local WHERE period_id=?1 \
             AND status='posted' \
             AND entry_type IN ('closing_transfer_profit','closing_transfer_loss')",
            params![p.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let rev = balances_by_type(&tx, &p.start_date, &p.end_date, "revenue")?;
    let exp = balances_by_type(&tx, &p.start_date, &p.end_date, "expense")?;
    let had_pl_activity = rev.iter().any(|(_, b)| b.abs() > 0.005)
        || exp.iter().any(|(_, b)| b.abs() > 0.005)
        || has_pl_close > 0;

    if had_pl_activity && (has_pl_close == 0 || has_transfer == 0) {
        let mut missing = Vec::new();
        if has_pl_close == 0 {
            missing.push("قيد إقفال الإيرادات/المصروفات");
        }
        if has_transfer == 0 {
            missing.push("قيد ترحيل صافي الربح أو الخسارة");
        }
        return Err(format!(
            "لا يمكن الإقفال النهائي — قيود الإقفال المحاسبية لم تُولَّد لهذه الفترة. المفقود: {}",
            missing.join("، ")
        ));
    }

    tx.execute("UPDATE fiscal_periods_local SET status='permanently_closed' WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Escape hatch — reopen a closed / permanently-closed period. Requires a
/// reason (≥ 10 chars) and cascades to the parent year if it was locked.
#[tauri::command]
pub fn fiscal_period_force_reopen(id: i64, reason: String) -> Result<(), String> {
    if reason.trim().chars().count() < 10 {
        return Err("سبب فك القفل مطلوب (10 أحرف على الأقل)".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = fetch_period(&tx, id)?;
    if p.status == "open" {
        return Ok(());
    }
    tx.execute("UPDATE fiscal_periods_local SET status='open' WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE fiscal_years_local SET status='open' WHERE id=?1 AND status<>'open'",
        params![p.fiscal_year_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ───────── Date helpers ─────────

fn parse_date(s: &str) -> Result<chrono::NaiveDate, String> {
    chrono::NaiveDate::parse_from_str(s.get(0..10).unwrap_or(s), "%Y-%m-%d")
        .map_err(|_| format!("تاريخ غير صالح: {s}"))
}

// One (name, start, end) tuple per calendar month overlapping [start, end].
fn month_periods(start: &chrono::NaiveDate, end: &chrono::NaiveDate) -> Vec<(String, String, String)> {
    use chrono::Datelike;
    let mut out = Vec::new();
    let mut y = start.year();
    let mut m = start.month();
    loop {
        let first = match chrono::NaiveDate::from_ymd_opt(y, m, 1) {
            Some(d) => d,
            None => break,
        };
        if first > *end {
            break;
        }
        let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        let next_first = chrono::NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
        let last = next_first.pred_opt().unwrap();
        let p_start = if first < *start { *start } else { first };
        let p_end = if last > *end { *end } else { last };
        out.push((
            format!("{y:04}-{m:02}"),
            p_start.format("%Y-%m-%d").to_string(),
            p_end.format("%Y-%m-%d").to_string(),
        ));
        y = ny;
        m = nm;
    }
    out
}
