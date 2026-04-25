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
    ["journal-pending",    () => checkJournalPending(companyId)],
    ["broken-refs",        () => checkBrokenRefs(companyId)],
    ["unlinked-accounts",  () => checkUnlinkedAccounts(companyId)],
    ["sequence-gaps",      () => checkSequenceGaps(companyId)],
    ["dormant-users",      () => checkDormantUsers(companyId)],
    ["orphan-stock",       () => checkOrphanStock(companyId)],
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
