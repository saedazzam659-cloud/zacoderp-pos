import { db } from "@workspace/db";
import { sequencesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ─── Shared types ────────────────────────────────────────────────────────────
export type MaintenanceStatus = "ok" | "warn" | "critical";

export interface CheckResult {
  count: number;
  /** Tool-specific extras kept on the GET payload AND persisted to maintenance_runs.details */
  extras?: Record<string, any>;
  /** Inline rows for the on-demand UI; NOT persisted (kept out to avoid bloating the runs table). */
  items?: any[];
}

/** Per-call switches. The default JSON / scheduler path stays capped at the
 *  inline-UI sizes; CSV-export callers opt-in to the full result set. */
export interface CheckOptions {
  /** Drop SQL row caps so the caller (e.g. CSV export) sees every matching row. */
  unlimited?: boolean;
}

export const MAINTENANCE_TOOL_KEYS = [
  "journal-pending",
  "broken-refs",
  "unlinked-accounts",
  "sequence-gaps",
  "dormant-users",
  "orphan-stock",
  // Inventory category — added in the toolbox expansion (F).
  "negative-stock",
  "stock-balance-drift",
  // Accounting category — added in the toolbox expansion (F).
  "unbalanced-entries",
  // Logs / records category — added in the toolbox expansion (F).
  "old-audit-logs",
  "old-maintenance-runs",
] as const;
export type MaintenanceToolKey = typeof MAINTENANCE_TOOL_KEYS[number];

// Same thresholds the UI uses (see MaintenanceTool.tsx). Keeping them in code
// means the scheduler agrees with the user's view of "warn / critical".
export function statusForCount(count: number): MaintenanceStatus {
  if (count <= 0) return "ok";
  if (count >= 50) return "critical";
  return "warn";
}

// ─── Individual checkers (read-only) ─────────────────────────────────────────
// 1. القيود المعلقة — drafts older than `days` days.
export async function checkJournalPending(
  companyId: number, days = 30, opts: CheckOptions = {},
): Promise<CheckResult> {
  // Inline UI / scheduler stay capped (perf); CSV export passes `unlimited`.
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  const exec = await db.execute<any>(sql`
    SELECT je.id, je.doc_number AS "docNumber", je.entry_date AS "entryDate",
           je.description, je.created_at AS "createdAt",
           COALESCE(SUM(jel.debit),0)::text  AS "totalDebit",
           COALESCE(SUM(jel.credit),0)::text AS "totalCredit"
      FROM journal_entries je
      LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
     WHERE je.company_id = ${companyId}
       AND je.status = 'draft'
       AND je.created_at < NOW() - (${days}::int || ' days')::interval
     GROUP BY je.id, je.doc_number, je.entry_date, je.description, je.created_at
     ORDER BY je.created_at ASC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items, extras: { days } };
}

// 2. مرجعيات مكسورة — posted invoices with NULL or stale journal_entry_id.
export async function checkBrokenRefs(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  const sExec = await db.execute<any>(sql`
    SELECT si.id, si.doc_number AS "docNumber", si.invoice_date AS "invoiceDate",
           si.total_amount AS "totalAmount", si.journal_entry_id AS "journalEntryId",
           CASE WHEN si.journal_entry_id IS NULL THEN 'missing' ELSE 'stale' END AS reason
      FROM sales_invoices si
     WHERE si.company_id = ${companyId}
       AND si.status = 'posted'
       AND (si.journal_entry_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = si.journal_entry_id))
     ORDER BY si.id DESC ${limitClause}
  `);
  const pExec = await db.execute<any>(sql`
    SELECT pi.id, pi.doc_number AS "docNumber", pi.invoice_date AS "invoiceDate",
           pi.total_amount AS "totalAmount", pi.journal_entry_id AS "journalEntryId",
           CASE WHEN pi.journal_entry_id IS NULL THEN 'missing' ELSE 'stale' END AS reason
      FROM purchase_invoices pi
     WHERE pi.company_id = ${companyId}
       AND pi.status = 'posted'
       AND (pi.journal_entry_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = pi.journal_entry_id))
     ORDER BY pi.id DESC ${limitClause}
  `);
  const sales = ((sExec as any).rows ?? []).map((r: any) => ({ ...r, kind: "sales" }));
  const purchases = ((pExec as any).rows ?? []).map((r: any) => ({ ...r, kind: "purchase" }));
  const items = [...sales, ...purchases];
  return {
    count: items.length,
    items,
    extras: { salesCount: sales.length, purchaseCount: purchases.length },
  };
}

// 3. حسابات غير مربوطة — JE-line account_ids that aren't in this company's chart.
export async function checkUnlinkedAccounts(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 200`;
  const exec = await db.execute<any>(sql`
    SELECT jel.account_id AS "accountId",
           COUNT(*)::int  AS "lineCount",
           MIN(je.id)     AS "sampleEntryId",
           MIN(je.doc_number) AS "sampleDocNumber"
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
     WHERE je.company_id = ${companyId}
       AND jel.account_id IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM accounts a
             WHERE a.id = jel.account_id AND a.company_id = ${companyId}
       )
     GROUP BY jel.account_id
     ORDER BY "lineCount" DESC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items };
}

// 4. فجوات في المسلسلات — issued numbers in [start, current-1] missing from sequence_logs.
export async function checkSequenceGaps(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const seqs = await db.select({
    id: sequencesTable.id, code: sequencesTable.code, nameAr: sequencesTable.nameAr,
    prefix: sequencesTable.prefix, padLength: sequencesTable.padLength,
    startNumber: sequencesTable.startNumber, currentNumber: sequencesTable.currentNumber,
  }).from(sequencesTable).where(eq(sequencesTable.companyId, companyId));

  // Per-sequence row cap. Inline UI stays at 200 rows; CSV export drops the
  // cap so the operator sees every gap and the running `gapCount` reflects
  // the true total instead of being clipped at the limit.
  const gapLimitClause = opts.unlimited ? sql`` : sql`LIMIT 200`;
  // Sample slice for the inline UI panel; CSV export keeps the full list so
  // each gap can become its own CSV row in the route handler.
  const sampleCap = opts.unlimited ? Number.POSITIVE_INFINITY : 20;

  const items: any[] = [];
  for (const s of seqs) {
    const start = Number(s.startNumber);
    const next  = Number(s.currentNumber);
    if (next <= start) continue;
    const exec = await db.execute<{ n: number }>(sql`
      WITH issued AS (SELECT generate_series(${start}::int, ${next - 1}::int) AS n),
           present AS (
             SELECT DISTINCT NULLIF(regexp_replace(generated_number, '\D', '', 'g'), '')::bigint AS n
               FROM sequence_logs
              WHERE sequence_id = ${s.id} AND company_id = ${companyId}
           )
      SELECT i.n FROM issued i
        LEFT JOIN present p ON p.n = i.n
       WHERE p.n IS NULL
       ORDER BY i.n
       ${gapLimitClause}
    `);
    const gapRows = (exec as any).rows ?? [];
    if (gapRows.length === 0) continue;
    const pad = Math.max(0, Number(s.padLength ?? 0));
    const fmt = (n: number) => `${s.prefix ?? ""}${pad > 0 ? String(n).padStart(pad, "0") : String(n)}`;
    const sliced = sampleCap === Number.POSITIVE_INFINITY ? gapRows : gapRows.slice(0, sampleCap);
    items.push({
      sequenceId: s.id, code: s.code, nameAr: s.nameAr,
      gapCount: gapRows.length,
      sampleGaps: sliced.map((r: any) => ({ number: Number(r.n), formatted: fmt(Number(r.n)) })),
    });
  }
  const total = items.reduce((s, it) => s + it.gapCount, 0);
  return { count: total, items, extras: { sequencesAffected: items.length } };
}

// 5. مستخدمون خاملون — last login > N days ago or never logged in.
export async function checkDormantUsers(
  companyId: number, days = 90, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  const exec = await db.execute<any>(sql`
    SELECT id, username, email, name_ar AS "nameAr", role,
           last_login_at AS "lastLoginAt", is_active AS "isActive",
           created_at AS "createdAt"
      FROM users
     WHERE company_id = ${companyId}
       AND role <> 'superadmin'
       AND is_active = true
       AND (last_login_at IS NULL OR last_login_at < NOW() - (${days}::int || ' days')::interval)
     ORDER BY COALESCE(last_login_at, created_at) ASC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items, extras: { days } };
}

// 6. حركات مخزون يتيمة — stock_ledger rows pointing at deleted invoices.
// Mirrors the logic in admin.ts `getOrphanLedgerRows` (one SQL pass instead
// of the JS-side filter, since we only need the count for the scheduler/UI badge).
export async function checkOrphanStock(companyId: number): Promise<CheckResult> {
  const exec = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n
      FROM stock_ledger sl
     WHERE sl.company_id = ${companyId}
       AND sl.ref_type IN ('sales_invoice','sales_return','purchase_invoice','purchase_return')
       AND sl.ref_id IS NOT NULL
       AND (
            (sl.ref_type = 'sales_invoice'
              AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.id = sl.ref_id))
         OR (sl.ref_type = 'purchase_invoice'
              AND NOT EXISTS (SELECT 1 FROM purchase_invoices pi WHERE pi.id = sl.ref_id))
         OR (sl.ref_type = 'sales_return'
              AND NOT EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.id = sl.ref_id))
         OR (sl.ref_type = 'purchase_return'
              AND NOT EXISTS (SELECT 1 FROM purchase_returns pr WHERE pr.id = sl.ref_id))
       )
  `);
  const n = Number(((exec as any).rows ?? [{}])[0]?.n ?? 0);
  return { count: n };
}

// 7. أرصدة مخزون سالبة — items whose stock_balance.qty is below zero. Almost
// always indicates an out-of-order operation (sale before purchase) or a stale
// transfer-out, both of which require operator review.
export async function checkNegativeStock(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  const exec = await db.execute<any>(sql`
    SELECT sb.id,
           sb.item_id      AS "itemId",
           sb.warehouse_id AS "warehouseId",
           sb.qty::text    AS qty,
           sb.avg_cost::text AS "avgCost",
           sb.updated_at   AS "updatedAt",
           i.code          AS "itemCode",
           COALESCE(i.name_ar, i.name_en)      AS "itemName",
           COALESCE(w.name_ar, w.name_en)      AS "warehouseName"
      FROM stock_balance sb
      JOIN items      i ON i.id = sb.item_id
      JOIN warehouses w ON w.id = sb.warehouse_id
     WHERE sb.company_id = ${companyId}
       AND sb.qty < 0
     ORDER BY sb.qty ASC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items };
}

// 8. انحراف رصيد المخزون — stock_balance.qty diverges from SUM(stock_ledger.qty)
// per (item, warehouse). The ledger stores signed quantities (see inventory.ts:
// `transfer_out` writes negative qty), so the running sum should match the
// stored balance. Drift means a posting bug or a manual DB edit.
export async function checkStockBalanceDrift(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  // The "stored ⊳ ledger" join uses FULL OUTER so we also catch the two edge
  // cases: balance row exists with no ledger movements, and ledger movements
  // exist with no balance row. Both indicate drift.
  const exec = await db.execute<any>(sql`
    WITH bal AS (
      SELECT item_id, warehouse_id, qty
        FROM stock_balance
       WHERE company_id = ${companyId}
    ),
    led AS (
      SELECT item_id, warehouse_id, COALESCE(SUM(qty), 0) AS qty
        FROM stock_ledger
       WHERE company_id = ${companyId}
       GROUP BY item_id, warehouse_id
    )
    SELECT COALESCE(b.item_id, l.item_id)           AS "itemId",
           COALESCE(b.warehouse_id, l.warehouse_id) AS "warehouseId",
           COALESCE(b.qty, 0)::text                 AS "storedQty",
           COALESCE(l.qty, 0)::text                 AS "ledgerQty",
           (COALESCE(b.qty, 0) - COALESCE(l.qty, 0))::text AS "drift",
           i.code  AS "itemCode",
           COALESCE(i.name_ar, i.name_en) AS "itemName",
           COALESCE(w.name_ar, w.name_en) AS "warehouseName"
      FROM bal b
      FULL OUTER JOIN led l
        ON l.item_id = b.item_id AND l.warehouse_id = b.warehouse_id
      LEFT JOIN items      i ON i.id = COALESCE(b.item_id, l.item_id)
      LEFT JOIN warehouses w ON w.id = COALESCE(b.warehouse_id, l.warehouse_id)
     WHERE ROUND(COALESCE(b.qty, 0) - COALESCE(l.qty, 0), 4) <> 0
     ORDER BY ABS(COALESCE(b.qty, 0) - COALESCE(l.qty, 0)) DESC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items };
}

// 9. قيود غير متوازنة — posted journal entries where SUM(debit) ≠ SUM(credit).
// A posted entry MUST be balanced; a row here means the integrity rule was
// bypassed (legacy import, partial rollback, manual SQL). Read-only by design:
// auto-fixing requires choosing which side is wrong.
export async function checkUnbalancedEntries(
  companyId: number, opts: CheckOptions = {},
): Promise<CheckResult> {
  const limitClause = opts.unlimited ? sql`` : sql`LIMIT 500`;
  const exec = await db.execute<any>(sql`
    SELECT je.id,
           je.doc_number AS "docNumber",
           je.entry_date AS "entryDate",
           je.description,
           je.status,
           COALESCE(SUM(jel.debit),  0)::text AS "totalDebit",
           COALESCE(SUM(jel.credit), 0)::text AS "totalCredit",
           ROUND(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0), 2)::text AS "diff",
           COUNT(jel.id)::int AS "lineCount"
      FROM journal_entries je
      LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
     WHERE je.company_id = ${companyId}
       AND je.status = 'posted'
     GROUP BY je.id, je.doc_number, je.entry_date, je.description, je.status
    HAVING ROUND(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0), 2) <> 0
     ORDER BY ABS(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0)) DESC
     ${limitClause}
  `);
  const items = (exec as any).rows ?? [];
  return { count: items.length, items };
}

// 10. سجلات تدقيق قديمة — count of audit_log rows older than `days`. Operators
// keep ~12 months on hand; the fix action prunes anything older to keep the
// table from outgrowing the dashboard.
export async function checkOldAuditLogs(
  companyId: number, days = 365, opts: CheckOptions = {},
): Promise<CheckResult> {
  // Audit rows are tenant-scoped via companyId (snapshot, no FK).
  const exec = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n,
           MIN(created_at)            AS "oldest",
           MAX(created_at)            AS "newest"
      FROM audit_log
     WHERE company_id = ${companyId}
       AND created_at < NOW() - (${days}::int || ' days')::interval
  `);
  const row = ((exec as any).rows ?? [{}])[0] ?? {};
  const n = Number(row.n ?? 0);
  // For the inline UI / CSV we surface a tiny preview — listing every audit
  // row is wasteful; the operator only needs counts to decide whether to prune.
  const previewLimit = opts.unlimited ? sql`LIMIT 5000` : sql`LIMIT 50`;
  let items: any[] = [];
  if (n > 0) {
    const exec2 = await db.execute<any>(sql`
      SELECT id, user_id AS "userId", username, role, module, action,
             method, path, status_code AS "statusCode", ip,
             created_at AS "createdAt"
        FROM audit_log
       WHERE company_id = ${companyId}
         AND created_at < NOW() - (${days}::int || ' days')::interval
       ORDER BY created_at ASC
       ${previewLimit}
    `);
    items = (exec2 as any).rows ?? [];
  }
  return {
    count: n,
    items,
    extras: { days, oldest: row.oldest ?? null, newest: row.newest ?? null },
  };
}

// 11. سجلات صيانة قديمة — count of maintenance_runs older than `days`. Default
// 90 days keeps roughly a quarter of trend data on hand for the dashboard.
export async function checkOldMaintenanceRuns(
  companyId: number, days = 90, opts: CheckOptions = {},
): Promise<CheckResult> {
  const exec = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n,
           MIN(run_at)               AS "oldest",
           MAX(run_at)               AS "newest"
      FROM maintenance_runs
     WHERE company_id = ${companyId}
       AND run_at < NOW() - (${days}::int || ' days')::interval
  `);
  const row = ((exec as any).rows ?? [{}])[0] ?? {};
  const n = Number(row.n ?? 0);
  const previewLimit = opts.unlimited ? sql`LIMIT 5000` : sql`LIMIT 50`;
  let items: any[] = [];
  if (n > 0) {
    const exec2 = await db.execute<any>(sql`
      SELECT id, tool_key AS "toolKey", status, count, trigger,
             run_at AS "runAt", duration_ms AS "durationMs", error
        FROM maintenance_runs
       WHERE company_id = ${companyId}
         AND run_at < NOW() - (${days}::int || ' days')::interval
       ORDER BY run_at ASC
       ${previewLimit}
    `);
    items = (exec2 as any).rows ?? [];
  }
  return {
    count: n,
    items,
    extras: { days, oldest: row.oldest ?? null, newest: row.newest ?? null },
  };
}

// 12. سجلات بريد الصيانة القديمة — count of maintenance_email_runs older than
// `days`. The table is append-only and global (no company_id) — every sweep
// adds a row plus extra rows for manual/test sends, so without a retention
// window the audit panel slows down and storage grows forever. Default 90
// days mirrors the old-maintenance-runs window so SuperAdmins keep roughly a
// quarter of digest history on hand. The companyId arg is accepted to match
// the per-tool check signature (callers always pass it) but the table is
// global, so it does not narrow the SELECT.
export async function checkOldMaintenanceEmailRuns(
  _companyId: number, days = 90, opts: CheckOptions = {},
): Promise<CheckResult> {
  const exec = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n,
           MIN(ran_at)               AS "oldest",
           MAX(ran_at)               AS "newest"
      FROM maintenance_email_runs
     WHERE ran_at < NOW() - (${days}::int || ' days')::interval
  `);
  const row = ((exec as any).rows ?? [{}])[0] ?? {};
  const n = Number(row.n ?? 0);
  const previewLimit = opts.unlimited ? sql`LIMIT 5000` : sql`LIMIT 50`;
  let items: any[] = [];
  if (n > 0) {
    const exec2 = await db.execute<any>(sql`
      SELECT id, ran_at AS "ranAt", trigger, status, recipients,
             critical_count AS "criticalCount", error, reason,
             critical_signature AS "criticalSignature"
        FROM maintenance_email_runs
       WHERE ran_at < NOW() - (${days}::int || ' days')::interval
       ORDER BY ran_at ASC
       ${previewLimit}
    `);
    items = (exec2 as any).rows ?? [];
  }
  return {
    count: n,
    items,
    extras: { days, oldest: row.oldest ?? null, newest: row.newest ?? null },
  };
}

// 13. سجلات بريد التقارير القديمة — count of report_email_schedule_runs older
// than `days`. Mirrors `checkOldMaintenanceEmailRuns`: the table is the
// parallel append-only history for the cross-company "Reports Hub" scheduler
// — every weekly/monthly auto-send and every "Send Now" appends a row, so
// without retention the audit panel slows down and storage grows forever.
// Default 90 days mirrors the maintenance-email-runs window. Like that table
// it is global (no company_id), but the companyId arg is accepted to match
// the per-tool check signature and keep audit-log attribution correct.
export async function checkOldReportEmailRuns(
  _companyId: number, days = 90, opts: CheckOptions = {},
): Promise<CheckResult> {
  const exec = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n,
           MIN(ran_at)               AS "oldest",
           MAX(ran_at)               AS "newest"
      FROM report_email_schedule_runs
     WHERE ran_at < NOW() - (${days}::int || ' days')::interval
  `);
  const row = ((exec as any).rows ?? [{}])[0] ?? {};
  const n = Number(row.n ?? 0);
  const previewLimit = opts.unlimited ? sql`LIMIT 5000` : sql`LIMIT 50`;
  let items: any[] = [];
  if (n > 0) {
    const exec2 = await db.execute<any>(sql`
      SELECT id, ran_at AS "ranAt", trigger, status, reports,
             recipients, message
        FROM report_email_schedule_runs
       WHERE ran_at < NOW() - (${days}::int || ' days')::interval
       ORDER BY ran_at ASC
       ${previewLimit}
    `);
    items = (exec2 as any).rows ?? [];
  }
  return {
    count: n,
    items,
    extras: { days, oldest: row.oldest ?? null, newest: row.newest ?? null },
  };
}

// ─── Aggregator used by the scheduler + the run-now endpoint ─────────────────
export interface ToolRunOutcome {
  toolKey: MaintenanceToolKey;
  status: MaintenanceStatus | "error";
  count: number;
  durationMs: number;
  extras?: Record<string, any>;
  error?: string;
}

export async function runAllChecks(companyId: number): Promise<ToolRunOutcome[]> {
  const runners: Array<[MaintenanceToolKey, () => Promise<CheckResult>]> = [
    ["journal-pending",      () => checkJournalPending(companyId)],
    ["broken-refs",          () => checkBrokenRefs(companyId)],
    ["unlinked-accounts",    () => checkUnlinkedAccounts(companyId)],
    ["sequence-gaps",        () => checkSequenceGaps(companyId)],
    ["dormant-users",        () => checkDormantUsers(companyId)],
    ["orphan-stock",         () => checkOrphanStock(companyId)],
    // Toolbox expansion (F): inventory / accounting / logs categories.
    ["negative-stock",       () => checkNegativeStock(companyId)],
    ["stock-balance-drift",  () => checkStockBalanceDrift(companyId)],
    ["unbalanced-entries",   () => checkUnbalancedEntries(companyId)],
    ["old-audit-logs",       () => checkOldAuditLogs(companyId)],
    ["old-maintenance-runs", () => checkOldMaintenanceRuns(companyId)],
  ];
  const results: ToolRunOutcome[] = [];
  for (const [toolKey, run] of runners) {
    const t0 = Date.now();
    try {
      const r = await run();
      results.push({
        toolKey,
        status: statusForCount(r.count),
        count: r.count,
        durationMs: Date.now() - t0,
        extras: r.extras,
      });
    } catch (e: any) {
      results.push({
        toolKey,
        status: "error",
        count: 0,
        durationMs: Date.now() - t0,
        error: e?.message ?? String(e),
      });
    }
  }
  return results;
}
