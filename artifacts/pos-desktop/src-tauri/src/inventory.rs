// Inventory & Warehouses — Task #208.
//
// Owns the multi-warehouse stock model: warehouses CRUD, stock-on-hand
// reads, the append-only ledger, plus stock adjustments / transfers /
// stocktakes. Every write that changes stock goes through
// `apply_ledger_delta` inside a single transaction so the ledger and the
// denormalised stock_on_hand table can never drift.
//
// Accounting integration:
//   • Adjustments → JE: positive delta = DR 1300 / CR 1310 (variance gain);
//                       negative delta = DR 5300 (variance loss) / CR 1300.
//   • Transfers   → no JE (same legal entity, no value change).
//   • Stocktakes  → on `post`, materialises a stock_adjustment row + lines
//                   for items whose counted_qty ≠ system_qty.

use crate::db;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

// ─── Shared helpers ─────────────────────────────────────────────────

fn today_iso() -> String {
    chrono::Local::now().date_naive().to_string()
}

fn account_id_by_code(conn: &Connection, code: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT id FROM accounts_local WHERE code=?1", params![code], |r| r.get(0))
}

/// Append a ledger row AND update the on-hand cache atomically.
/// Returns the new on-hand quantity after the delta is applied.
fn apply_ledger_delta(
    tx: &Transaction,
    item_id: i64,
    warehouse_id: i64,
    qty_delta: f64,
    unit_cost: f64,
    ref_type: &str,
    ref_id: Option<i64>,
    entry_date: &str,
    notes: Option<&str>,
) -> Result<f64, String> {
    // Distinguish "no row" (→ 0) from a real DB error (→ rollback). Using
    // `unwrap_or(0.0)` previously swallowed real failures and could write a
    // wrong `balance_after`, drifting ledger vs on-hand silently.
    let current_qty: f64 = tx.query_row(
        "SELECT COALESCE(qty,0) FROM stock_on_hand_local WHERE item_id=?1 AND warehouse_id=?2",
        params![item_id, warehouse_id],
        |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?.unwrap_or(0.0);
    let new_qty = current_qty + qty_delta;

    tx.execute(
        "INSERT INTO stock_ledger_local(item_id,warehouse_id,qty_delta,unit_cost,balance_after,ref_type,ref_id,entry_date,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![item_id, warehouse_id, qty_delta, unit_cost, new_qty, ref_type, ref_id, entry_date, notes],
    ).map_err(|e| e.to_string())?;

    // Upsert on-hand. Keep the most recent cost on positive deltas only.
    if qty_delta > 0.0 {
        tx.execute(
            "INSERT INTO stock_on_hand_local(item_id,warehouse_id,qty,last_cost,updated_at)
             VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(item_id,warehouse_id) DO UPDATE SET
                 qty=excluded.qty, last_cost=excluded.last_cost, updated_at=CURRENT_TIMESTAMP",
            params![item_id, warehouse_id, new_qty, unit_cost],
        ).map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "INSERT INTO stock_on_hand_local(item_id,warehouse_id,qty,updated_at)
             VALUES(?1,?2,?3,CURRENT_TIMESTAMP)
             ON CONFLICT(item_id,warehouse_id) DO UPDATE SET
                 qty=excluded.qty, updated_at=CURRENT_TIMESTAMP",
            params![item_id, warehouse_id, new_qty],
        ).map_err(|e| e.to_string())?;
    }
    Ok(new_qty)
}

/// Convenience: called by accounting.rs from purchases / returns.
/// Wraps `apply_ledger_delta` for a single line, ignoring the returned qty.
pub fn ledger_push_in_tx(
    tx: &Transaction,
    item_id: i64,
    warehouse_id: i64,
    qty_delta: f64,
    unit_cost: f64,
    ref_type: &str,
    ref_id: Option<i64>,
    entry_date: &str,
) -> Result<(), String> {
    apply_ledger_delta(tx, item_id, warehouse_id, qty_delta, unit_cost, ref_type, ref_id, entry_date, None)?;
    Ok(())
}

/// Returns the id of the default warehouse, creating one if none exists.
pub fn default_warehouse_id_in_tx(tx: &Transaction) -> Result<i64, String> {
    if let Ok(id) = tx.query_row::<i64, _, _>(
        "SELECT id FROM warehouses_local WHERE is_default=1 LIMIT 1", [], |r| r.get(0),
    ) { return Ok(id); }
    if let Ok(id) = tx.query_row::<i64, _, _>(
        "SELECT id FROM warehouses_local ORDER BY id LIMIT 1", [], |r| r.get(0),
    ) { return Ok(id); }
    tx.execute(
        "INSERT INTO warehouses_local(code,name,is_default,is_active) VALUES('WH-01','المخزن الرئيسي',1,1)",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(tx.last_insert_rowid())
}

// ─── Warehouses CRUD ────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct Warehouse {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub address: Option<String>,
    pub is_default: bool,
    pub is_active: bool,
}
#[derive(Deserialize)]
pub struct WarehouseInput {
    pub code: String,
    pub name: String,
    pub address: Option<String>,
    pub is_default: Option<bool>,
    pub is_active: Option<bool>,
}

#[tauri::command]
pub fn warehouses_list() -> Result<Vec<Warehouse>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,code,name,address,is_default,is_active FROM warehouses_local ORDER BY is_default DESC, name",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Warehouse {
        id: r.get(0)?, code: r.get(1)?, name: r.get(2)?, address: r.get(3)?,
        is_default: r.get::<_, i64>(4)? != 0, is_active: r.get::<_, i64>(5)? != 0,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn warehouses_create(input: WarehouseInput) -> Result<i64, String> {
    if input.code.trim().is_empty() || input.name.trim().is_empty() {
        return Err("الكود والاسم مطلوبان".into());
    }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let is_default = input.is_default.unwrap_or(false);
    if is_default {
        tx.execute("UPDATE warehouses_local SET is_default=0", []).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO warehouses_local(code,name,address,is_default,is_active) VALUES(?1,?2,?3,?4,?5)",
        params![input.code.trim(), input.name.trim(), input.address,
            if is_default { 1 } else { 0 },
            if input.is_active.unwrap_or(true) { 1 } else { 0 }],
    ).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn warehouses_update(id: i64, input: WarehouseInput) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let is_default = input.is_default.unwrap_or(false);
    if is_default {
        tx.execute("UPDATE warehouses_local SET is_default=0 WHERE id!=?1", params![id]).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE warehouses_local SET code=?1, name=?2, address=?3, is_default=?4, is_active=?5 WHERE id=?6",
        params![input.code.trim(), input.name.trim(), input.address,
            if is_default { 1 } else { 0 },
            if input.is_active.unwrap_or(true) { 1 } else { 0 },
            id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn warehouses_delete(id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM stock_ledger_local WHERE warehouse_id=?1", params![id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if used > 0 { return Err("لا يمكن حذف مخزن عليه حركات".into()); }
    conn.execute("DELETE FROM warehouses_local WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Stock on-hand ──────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StockOnHand {
    pub item_id: i64,
    pub item_name: String,
    pub item_code: Option<String>,
    pub warehouse_id: i64,
    pub warehouse_name: String,
    pub qty: f64,
    pub last_cost: f64,
}

#[tauri::command]
pub fn stock_on_hand_list(warehouse_id: Option<i64>) -> Result<Vec<StockOnHand>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let sql = "SELECT s.item_id, i.name_ar, i.code, s.warehouse_id, w.name, s.qty, s.last_cost
               FROM stock_on_hand_local s
               JOIN items_local i ON i.id=s.item_id
               JOIN warehouses_local w ON w.id=s.warehouse_id
               WHERE (?1 IS NULL OR s.warehouse_id=?1)
               ORDER BY i.name_ar";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![warehouse_id], |r| Ok(StockOnHand {
        item_id: r.get(0)?, item_name: r.get(1)?, item_code: r.get(2)?,
        warehouse_id: r.get(3)?, warehouse_name: r.get(4)?, qty: r.get(5)?, last_cost: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

// ─── Stock movements (ledger read) ──────────────────────────────────

#[derive(Serialize)]
pub struct StockMovement {
    pub id: i64,
    pub item_id: i64,
    pub item_name: String,
    pub warehouse_id: i64,
    pub warehouse_name: String,
    pub qty_delta: f64,
    pub unit_cost: f64,
    pub balance_after: f64,
    pub ref_type: String,
    pub ref_id: Option<i64>,
    pub entry_date: String,
    pub created_at: String,
}

#[tauri::command]
pub fn stock_movements_list(
    warehouse_id: Option<i64>,
    item_id: Option<i64>,
    date_from: Option<String>,
    date_to: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<StockMovement>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(500).min(5000);
    let sql = "SELECT l.id, l.item_id, i.name_ar, l.warehouse_id, w.name,
                      l.qty_delta, l.unit_cost, l.balance_after,
                      l.ref_type, l.ref_id, l.entry_date, l.created_at
               FROM stock_ledger_local l
               JOIN items_local i ON i.id=l.item_id
               JOIN warehouses_local w ON w.id=l.warehouse_id
               WHERE (?1 IS NULL OR l.warehouse_id=?1)
                 AND (?2 IS NULL OR l.item_id=?2)
                 AND (?3 IS NULL OR l.entry_date>=?3)
                 AND (?4 IS NULL OR l.entry_date<=?4)
               ORDER BY l.id DESC
               LIMIT ?5";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![warehouse_id, item_id, date_from, date_to, lim], |r| Ok(StockMovement {
        id: r.get(0)?, item_id: r.get(1)?, item_name: r.get(2)?,
        warehouse_id: r.get(3)?, warehouse_name: r.get(4)?,
        qty_delta: r.get(5)?, unit_cost: r.get(6)?, balance_after: r.get(7)?,
        ref_type: r.get(8)?, ref_id: r.get(9)?, entry_date: r.get(10)?, created_at: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

// ─── Stock Adjustments ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AdjustmentLineInput {
    pub item_id: i64,
    pub qty_diff: f64,
    pub unit_cost: f64,
}
#[derive(Deserialize)]
pub struct AdjustmentInput {
    pub adj_date: String,
    pub warehouse_id: i64,
    pub reason: Option<String>,
    pub lines: Vec<AdjustmentLineInput>,
}

#[derive(Serialize)]
pub struct AdjustmentSummary {
    pub id: i64, pub adj_no: String, pub adj_date: String,
    pub warehouse_id: i64, pub warehouse_name: String,
    pub reason: Option<String>, pub je_id: Option<i64>,
    pub lines_count: i64, pub total_value: f64,
}

fn next_adj_no(tx: &Transaction) -> Result<String, String> {
    let n: i64 = tx.query_row("SELECT COALESCE(MAX(id),0)+1 FROM stock_adjustments_local", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(format!("ADJ-{:06}", n))
}

#[tauri::command]
pub fn stock_adjustments_list() -> Result<Vec<AdjustmentSummary>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.adj_no, a.adj_date, a.warehouse_id, w.name, a.reason, a.je_id,
                (SELECT COUNT(*) FROM stock_adjustment_lines_local l WHERE l.adj_id=a.id),
                COALESCE((SELECT SUM(line_total) FROM stock_adjustment_lines_local l WHERE l.adj_id=a.id),0)
         FROM stock_adjustments_local a
         JOIN warehouses_local w ON w.id=a.warehouse_id
         ORDER BY a.id DESC LIMIT 500",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(AdjustmentSummary {
        id: r.get(0)?, adj_no: r.get(1)?, adj_date: r.get(2)?,
        warehouse_id: r.get(3)?, warehouse_name: r.get(4)?,
        reason: r.get(5)?, je_id: r.get(6)?,
        lines_count: r.get(7)?, total_value: r.get(8)?,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn stock_adjustment_create(input: AdjustmentInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا توجد بنود في التسوية".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let adj_no = next_adj_no(&tx)?;

    tx.execute(
        "INSERT INTO stock_adjustments_local(adj_no,adj_date,warehouse_id,reason) VALUES(?1,?2,?3,?4)",
        params![adj_no, input.adj_date, input.warehouse_id, input.reason],
    ).map_err(|e| e.to_string())?;
    let adj_id = tx.last_insert_rowid();

    let mut total_gain = 0.0_f64;
    let mut total_loss = 0.0_f64;

    for l in &input.lines {
        if l.qty_diff == 0.0 { continue; }
        let line_total = l.qty_diff.abs() * l.unit_cost;
        tx.execute(
            "INSERT INTO stock_adjustment_lines_local(adj_id,item_id,qty_diff,unit_cost,line_total)
             VALUES(?1,?2,?3,?4,?5)",
            params![adj_id, l.item_id, l.qty_diff, l.unit_cost, line_total],
        ).map_err(|e| e.to_string())?;

        apply_ledger_delta(&tx, l.item_id, input.warehouse_id, l.qty_diff, l.unit_cost,
            "adjustment", Some(adj_id), &input.adj_date, None)?;

        if l.qty_diff > 0.0 { total_gain += line_total; } else { total_loss += line_total; }
    }

    // Build the JE — net DR/CR against inventory.
    let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
    let gain_acc = account_id_by_code(&tx, "1310").map_err(|e| e.to_string())?;
    let loss_acc = account_id_by_code(&tx, "5300").map_err(|e| e.to_string())?;

    let mut lines: Vec<(i64, f64, f64)> = vec![]; // (account_id, debit, credit)
    if total_gain > 0.0 {
        lines.push((inv_acc, total_gain, 0.0));
        lines.push((gain_acc, 0.0, total_gain));
    }
    if total_loss > 0.0 {
        lines.push((loss_acc, total_loss, 0.0));
        lines.push((inv_acc, 0.0, total_loss));
    }

    let je_id_opt: Option<i64> = if !lines.is_empty() {
        let total: f64 = lines.iter().map(|(_, d, _)| d).sum();
        let entry_no: i64 = tx.query_row("SELECT COALESCE(MAX(id),0)+1 FROM journal_entries_local", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        let entry_no_s = format!("JE-{:06}", entry_no);
        tx.execute(
            "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,source_id)
             VALUES(?1,?2,?3,?4,?4,'stock_adjustment',?5)",
            params![entry_no_s, input.adj_date, format!("تسوية مخزون {adj_no}"), total, adj_id],
        ).map_err(|e| e.to_string())?;
        let je_id = tx.last_insert_rowid();
        for (acc, dr, cr) in &lines {
            tx.execute(
                "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit) VALUES(?1,?2,?3,?4)",
                params![je_id, acc, dr, cr],
            ).map_err(|e| e.to_string())?;
            let signed = dr - cr;
            tx.execute("UPDATE accounts_local SET balance=balance+?1 WHERE id=?2", params![signed, acc]).map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE stock_adjustments_local SET je_id=?1 WHERE id=?2", params![je_id, adj_id]).map_err(|e| e.to_string())?;
        Some(je_id)
    } else { None };
    let _ = je_id_opt;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(adj_id)
}

// ─── Stock Transfers ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TransferLineInput {
    pub item_id: i64,
    pub qty: f64,
    pub unit_cost: f64,
}
#[derive(Deserialize)]
pub struct TransferInput {
    pub transfer_date: String,
    pub from_warehouse_id: i64,
    pub to_warehouse_id: i64,
    pub notes: Option<String>,
    pub lines: Vec<TransferLineInput>,
}

#[derive(Serialize)]
pub struct TransferSummary {
    pub id: i64, pub transfer_no: String, pub transfer_date: String,
    pub from_warehouse_id: i64, pub from_warehouse_name: String,
    pub to_warehouse_id: i64, pub to_warehouse_name: String,
    pub lines_count: i64, pub total_qty: f64,
}

fn next_transfer_no(tx: &Transaction) -> Result<String, String> {
    let n: i64 = tx.query_row("SELECT COALESCE(MAX(id),0)+1 FROM stock_transfers_local", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(format!("TRF-{:06}", n))
}

#[tauri::command]
pub fn stock_transfers_list() -> Result<Vec<TransferSummary>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.transfer_no, t.transfer_date,
                t.from_warehouse_id, wf.name, t.to_warehouse_id, wt.name,
                (SELECT COUNT(*) FROM stock_transfer_lines_local l WHERE l.transfer_id=t.id),
                COALESCE((SELECT SUM(qty) FROM stock_transfer_lines_local l WHERE l.transfer_id=t.id),0)
         FROM stock_transfers_local t
         JOIN warehouses_local wf ON wf.id=t.from_warehouse_id
         JOIN warehouses_local wt ON wt.id=t.to_warehouse_id
         ORDER BY t.id DESC LIMIT 500",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(TransferSummary {
        id: r.get(0)?, transfer_no: r.get(1)?, transfer_date: r.get(2)?,
        from_warehouse_id: r.get(3)?, from_warehouse_name: r.get(4)?,
        to_warehouse_id: r.get(5)?, to_warehouse_name: r.get(6)?,
        lines_count: r.get(7)?, total_qty: r.get(8)?,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn stock_transfer_create(input: TransferInput) -> Result<i64, String> {
    if input.from_warehouse_id == input.to_warehouse_id {
        return Err("لا يمكن التحويل لنفس المخزن".into());
    }
    if input.lines.is_empty() { return Err("لا توجد بنود في التحويل".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let transfer_no = next_transfer_no(&tx)?;

    tx.execute(
        "INSERT INTO stock_transfers_local(transfer_no,transfer_date,from_warehouse_id,to_warehouse_id,notes)
         VALUES(?1,?2,?3,?4,?5)",
        params![transfer_no, input.transfer_date, input.from_warehouse_id, input.to_warehouse_id, input.notes],
    ).map_err(|e| e.to_string())?;
    let tid = tx.last_insert_rowid();

    for l in &input.lines {
        if l.qty <= 0.0 { return Err("الكمية يجب أن تكون أكبر من صفر".into()); }
        tx.execute(
            "INSERT INTO stock_transfer_lines_local(transfer_id,item_id,qty,unit_cost) VALUES(?1,?2,?3,?4)",
            params![tid, l.item_id, l.qty, l.unit_cost],
        ).map_err(|e| e.to_string())?;
        // Out of source (negative).
        apply_ledger_delta(&tx, l.item_id, input.from_warehouse_id, -l.qty, l.unit_cost,
            "transfer_out", Some(tid), &input.transfer_date, None)?;
        // Into destination (positive).
        apply_ledger_delta(&tx, l.item_id, input.to_warehouse_id, l.qty, l.unit_cost,
            "transfer_in", Some(tid), &input.transfer_date, None)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(tid)
}

// ─── Stocktakes (الجرد) ─────────────────────────────────────────────
// Workflow:
//   1. create draft stocktake with counted_qty per item (system_qty
//      captured from stock_on_hand at creation time).
//   2. `post` → materialise a stock_adjustment for the qty diffs and
//      flip status to 'posted'.

#[derive(Deserialize)]
pub struct StocktakeLineInput {
    pub item_id: i64,
    pub counted_qty: f64,
    pub unit_cost: f64,
}
#[derive(Deserialize)]
pub struct StocktakeInput {
    pub stocktake_date: String,
    pub warehouse_id: i64,
    pub notes: Option<String>,
    pub lines: Vec<StocktakeLineInput>,
}

#[derive(Serialize)]
pub struct StocktakeSummary {
    pub id: i64, pub stocktake_no: String, pub stocktake_date: String,
    pub warehouse_id: i64, pub warehouse_name: String,
    pub status: String, pub adjustment_id: Option<i64>,
    pub lines_count: i64,
}

fn next_stocktake_no(tx: &Transaction) -> Result<String, String> {
    let n: i64 = tx.query_row("SELECT COALESCE(MAX(id),0)+1 FROM stocktakes_local", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(format!("ST-{:06}", n))
}

#[tauri::command]
pub fn stocktakes_list() -> Result<Vec<StocktakeSummary>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.stocktake_no, s.stocktake_date, s.warehouse_id, w.name, s.status, s.adjustment_id,
                (SELECT COUNT(*) FROM stocktake_lines_local l WHERE l.stocktake_id=s.id)
         FROM stocktakes_local s
         JOIN warehouses_local w ON w.id=s.warehouse_id
         ORDER BY s.id DESC LIMIT 500",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(StocktakeSummary {
        id: r.get(0)?, stocktake_no: r.get(1)?, stocktake_date: r.get(2)?,
        warehouse_id: r.get(3)?, warehouse_name: r.get(4)?,
        status: r.get(5)?, adjustment_id: r.get(6)?,
        lines_count: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    let mut out = vec![]; for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn stocktake_create(input: StocktakeInput) -> Result<i64, String> {
    if input.lines.is_empty() { return Err("لا توجد بنود في الجرد".into()); }
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let no = next_stocktake_no(&tx)?;
    tx.execute(
        "INSERT INTO stocktakes_local(stocktake_no,stocktake_date,warehouse_id,notes,status)
         VALUES(?1,?2,?3,?4,'draft')",
        params![no, input.stocktake_date, input.warehouse_id, input.notes],
    ).map_err(|e| e.to_string())?;
    let sid = tx.last_insert_rowid();
    for l in &input.lines {
        let sys_qty: f64 = tx.query_row(
            "SELECT COALESCE(qty,0) FROM stock_on_hand_local WHERE item_id=?1 AND warehouse_id=?2",
            params![l.item_id, input.warehouse_id], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?.unwrap_or(0.0);
        tx.execute(
            "INSERT INTO stocktake_lines_local(stocktake_id,item_id,system_qty,counted_qty,unit_cost) VALUES(?1,?2,?3,?4,?5)",
            params![sid, l.item_id, sys_qty, l.counted_qty, l.unit_cost],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(sid)
}

#[tauri::command]
pub fn stocktake_post(id: i64) -> Result<i64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, warehouse_id, st_date, st_no, prior_adj): (String, i64, String, String, Option<i64>) = tx.query_row(
        "SELECT status, warehouse_id, stocktake_date, stocktake_no, adjustment_id FROM stocktakes_local WHERE id=?1",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).map_err(|e| e.to_string())?;
    // Idempotent: if already posted, return the existing adjustment_id (or 0)
    // instead of erroring. Re-posting an already-posted stocktake must NOT
    // create duplicate ledger rows or JEs.
    if status == "posted" {
        return Ok(prior_adj.unwrap_or(0));
    }
    if status != "draft" { return Err(format!("حالة غير معروفة: {status}")); }

    // Collect lines with non-zero diff into an AdjustmentInput.
    let mut stmt = tx.prepare(
        "SELECT item_id, system_qty, counted_qty, unit_cost FROM stocktake_lines_local WHERE stocktake_id=?1",
    ).map_err(|e| e.to_string())?;
    let lines: Vec<(i64, f64, f64, f64)> = stmt.query_map(params![id], |r| Ok((
        r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?,
    ))).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    drop(stmt);

    let diffs: Vec<(i64, f64, f64)> = lines.into_iter()
        .map(|(item_id, sys, cnt, cost)| (item_id, cnt - sys, cost))
        .filter(|(_, d, _)| d.abs() > 1e-6)
        .collect();

    let adj_id_opt: Option<i64> = if diffs.is_empty() { None } else {
        let adj_no = next_adj_no(&tx)?;
        tx.execute(
            "INSERT INTO stock_adjustments_local(adj_no,adj_date,warehouse_id,reason) VALUES(?1,?2,?3,?4)",
            params![adj_no, st_date, warehouse_id, format!("جرد {st_no}")],
        ).map_err(|e| e.to_string())?;
        let adj_id = tx.last_insert_rowid();

        let mut total_gain = 0.0_f64; let mut total_loss = 0.0_f64;
        for (item_id, qty_diff, unit_cost) in &diffs {
            let line_total = qty_diff.abs() * unit_cost;
            tx.execute(
                "INSERT INTO stock_adjustment_lines_local(adj_id,item_id,qty_diff,unit_cost,line_total) VALUES(?1,?2,?3,?4,?5)",
                params![adj_id, item_id, qty_diff, unit_cost, line_total],
            ).map_err(|e| e.to_string())?;
            apply_ledger_delta(&tx, *item_id, warehouse_id, *qty_diff, *unit_cost,
                "stocktake", Some(adj_id), &st_date, None)?;
            if *qty_diff > 0.0 { total_gain += line_total; } else { total_loss += line_total; }
        }

        // Post the offsetting JE (same logic as stock_adjustment_create).
        let inv_acc = account_id_by_code(&tx, "1300").map_err(|e| e.to_string())?;
        let gain_acc = account_id_by_code(&tx, "1310").map_err(|e| e.to_string())?;
        let loss_acc = account_id_by_code(&tx, "5300").map_err(|e| e.to_string())?;
        let mut je_lines: Vec<(i64, f64, f64)> = vec![];
        if total_gain > 0.0 { je_lines.push((inv_acc, total_gain, 0.0)); je_lines.push((gain_acc, 0.0, total_gain)); }
        if total_loss > 0.0 { je_lines.push((loss_acc, total_loss, 0.0)); je_lines.push((inv_acc, 0.0, total_loss)); }
        if !je_lines.is_empty() {
            let total: f64 = je_lines.iter().map(|(_, d, _)| d).sum();
            let entry_no: i64 = tx.query_row("SELECT COALESCE(MAX(id),0)+1 FROM journal_entries_local", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            let entry_no_s = format!("JE-{:06}", entry_no);
            tx.execute(
                "INSERT INTO journal_entries_local(entry_no,entry_date,description,total_debit,total_credit,source_type,source_id)
                 VALUES(?1,?2,?3,?4,?4,'stocktake',?5)",
                params![entry_no_s, st_date, format!("جرد {st_no} → {adj_no}"), total, adj_id],
            ).map_err(|e| e.to_string())?;
            let je_id = tx.last_insert_rowid();
            for (acc, dr, cr) in &je_lines {
                tx.execute(
                    "INSERT INTO journal_entry_lines_local(entry_id,account_id,debit,credit) VALUES(?1,?2,?3,?4)",
                    params![je_id, acc, dr, cr],
                ).map_err(|e| e.to_string())?;
                let signed = dr - cr;
                tx.execute("UPDATE accounts_local SET balance=balance+?1 WHERE id=?2", params![signed, acc]).map_err(|e| e.to_string())?;
            }
            tx.execute("UPDATE stock_adjustments_local SET je_id=?1 WHERE id=?2", params![je_id, adj_id]).map_err(|e| e.to_string())?;
        }
        Some(adj_id)
    };

    tx.execute(
        "UPDATE stocktakes_local SET status='posted', adjustment_id=?1 WHERE id=?2",
        params![adj_id_opt, id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(adj_id_opt.unwrap_or(0))
}
