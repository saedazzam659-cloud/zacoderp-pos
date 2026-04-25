import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ─── Shared utilities ──────────────────────────────────────────────────────
// Tiny utility module that produces the CSVs sent by the scheduled report
// digest emails. Re-implements just the SELECTs that the corresponding
// /api/admin/reports/* endpoints use, so:
//   * the scheduler does not have to call its own HTTP server (auth issues),
//   * the same Arabic CSV format is preserved (Excel-compatible UTF-8 BOM).
//
// If the report endpoints in routes/admin.ts ever change their schema, update
// the SELECTs and headers below to match.

type SqlExecuteResult<T> = { rows?: T[] } | T[];
function rowsOf<T>(result: SqlExecuteResult<T>): T[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) return result.rows;
  return [];
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// Periods used by the digest. Weekly → trailing 7 days ending today; monthly
// → calendar month-to-date. Both are deterministic (no timezone surprises).
export function digestPeriod(frequency: "weekly" | "monthly"): { from: string; to: string } {
  const now = new Date();
  if (frequency === "monthly") {
    const Y = now.getUTCFullYear();
    const M = now.getUTCMonth();
    return { from: isoDate(new Date(Date.UTC(Y, M, 1))), to: isoDate(now) };
  }
  // weekly
  const from = new Date(now.getTime() - 6 * 86_400_000);
  return { from: isoDate(from), to: isoDate(now) };
}

// ─── Operational summary (mirrors GET /reports/operational-summary) ───────
// Row shapes use index signatures so they satisfy drizzle-orm's
// `Record<string, unknown>` constraint on db.execute<T>().
interface OperationalRow {
  [k: string]: unknown;
  company_id: number; customers: number; suppliers: number; items: number;
  open_pos_sessions: number; last_activity_at: string | null;
  audit_events_7d: number; denied_7d: number;
}
interface BackupOverviewRow {
  [k: string]: unknown;
  company_id: number; reason: string; created_at: string | null;
}

export interface DigestArtifact {
  filename: string;
  csv: string;
  rowCount: number;
}

export async function produceOperationalSummaryCsv(): Promise<DigestArtifact> {
  const [opsResult, backupsResult, companiesList] = await Promise.all([
    db.execute<OperationalRow>(sql`
      WITH c   AS (SELECT company_id, COUNT(*)::int n FROM customers GROUP BY company_id),
           s   AS (SELECT company_id, COUNT(*)::int n FROM suppliers GROUP BY company_id),
           i   AS (SELECT company_id, COUNT(*)::int n FROM items     GROUP BY company_id),
           pos AS (SELECT company_id, COUNT(*)::int n FROM pos_sessions WHERE status = 'open' GROUP BY company_id),
           la  AS (
             SELECT company_id, MAX(ts) AS last_activity_at FROM (
               SELECT company_id, invoice_date::timestamp AS ts
                 FROM sales_invoices WHERE status = 'posted'
               UNION ALL
               SELECT company_id, created_at AS ts FROM audit_log
             ) u
             GROUP BY company_id
           ),
           ae  AS (
             SELECT company_id, COUNT(*)::int n FROM audit_log
              WHERE created_at >= now() - interval '7 days'
              GROUP BY company_id
           ),
           de  AS (
             SELECT company_id, COUNT(*)::int n FROM audit_log
              WHERE action = 'denied'
                AND created_at >= now() - interval '7 days'
              GROUP BY company_id
           )
      SELECT co.id                       AS company_id,
             COALESCE(c.n,   0)          AS customers,
             COALESCE(s.n,   0)          AS suppliers,
             COALESCE(i.n,   0)          AS items,
             COALESCE(pos.n, 0)          AS open_pos_sessions,
             la.last_activity_at::text   AS last_activity_at,
             COALESCE(ae.n,  0)          AS audit_events_7d,
             COALESCE(de.n,  0)          AS denied_7d
        FROM companies co
        LEFT JOIN c   ON c.company_id   = co.id
        LEFT JOIN s   ON s.company_id   = co.id
        LEFT JOIN i   ON i.company_id   = co.id
        LEFT JOIN pos ON pos.company_id = co.id
        LEFT JOIN la  ON la.company_id  = co.id
        LEFT JOIN ae  ON ae.company_id  = co.id
        LEFT JOIN de  ON de.company_id  = co.id
    `),
    db.execute<BackupOverviewRow>(sql`
      SELECT DISTINCT ON (company_id) company_id, reason, created_at::text
        FROM auto_backups
       ORDER BY company_id, created_at DESC, id DESC
    `),
    db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, status: companiesTable.status })
      .from(companiesTable),
  ]);

  const backups = new Map<number, BackupOverviewRow>();
  for (const b of rowsOf<BackupOverviewRow>(backupsResult as SqlExecuteResult<BackupOverviewRow>)) {
    backups.set(Number(b.company_id), b);
  }
  const companyMap = new Map(companiesList.map(c => [c.id, c]));
  const inactiveCutoffMs = Date.now() - 30 * 86_400_000;

  const rows = rowsOf<OperationalRow>(opsResult as SqlExecuteResult<OperationalRow>).map(r => {
    const cid = Number(r.company_id);
    const company = companyMap.get(cid);
    const lastActivityAt = r.last_activity_at ?? null;
    const inactive = !lastActivityAt || new Date(lastActivityAt).getTime() < inactiveCutoffMs;
    const backup = backups.get(cid);
    return [
      company?.nameAr ?? "—",
      company?.status ?? "unknown",
      r.customers, r.suppliers, r.items,
      r.open_pos_sessions,
      lastActivityAt ?? "—",
      r.audit_events_7d,
      r.denied_7d,
      backup?.created_at ?? "—",
      backup?.reason ?? "—",
      inactive ? "نعم" : "لا",
    ];
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ar"));

  const csv = buildCsv(
    ["الشركة", "الحالة", "العملاء", "الموردون", "الأصناف", "جلسات نقاط البيع المفتوحة", "آخر نشاط", "أحداث التدقيق (7 أيام)", "محاولات مرفوضة (7 أيام)", "آخر نسخة احتياطية", "نوع النسخة", "راكدة (>30 يوم)"],
    rows,
  );
  return { filename: "operational-summary.csv", csv, rowCount: rows.length };
}

// ─── Revenue by plan (mirrors GET /reports/revenue-by-plan) ────────────────
interface RevenueByPlanRow {
  [k: string]: unknown;
  plan: string; billing_cycle: string; subscription_count: number; total_billed: string;
}

export async function produceRevenueByPlanCsv(period: { from: string; to: string }): Promise<DigestArtifact> {
  const result = await db.execute<RevenueByPlanRow>(sql`
    WITH active_sub AS (
      SELECT DISTINCT ON (company_id)
             company_id,
             plan,
             CASE WHEN billing_cycle = 'annual' THEN 'yearly' ELSE billing_cycle END AS billing_cycle
        FROM subscriptions
       WHERE is_active = true
         AND end_date >= ${todayISO()}
       ORDER BY company_id, end_date DESC, id DESC
    ),
    rev AS (
      SELECT si.company_id,
             COALESCE(SUM(si.total_amount::numeric), 0) AS revenue
        FROM sales_invoices si
        JOIN active_sub a ON a.company_id = si.company_id
       WHERE si.status = 'posted'
         AND si.invoice_date BETWEEN ${period.from} AND ${period.to}
       GROUP BY si.company_id
    )
    SELECT a.plan,
           a.billing_cycle                              AS billing_cycle,
           COUNT(DISTINCT a.company_id)::int            AS subscription_count,
           COALESCE(SUM(r.revenue), 0)::text            AS total_billed
      FROM active_sub a
      LEFT JOIN rev r ON r.company_id = a.company_id
     GROUP BY a.plan, a.billing_cycle
     ORDER BY a.plan, a.billing_cycle
  `);
  const aggregated = rowsOf<RevenueByPlanRow>(result as SqlExecuteResult<RevenueByPlanRow>).map(r => ({
    plan: r.plan,
    billingCycle: r.billing_cycle,
    subscriptionCount: Number(r.subscription_count),
    totalBilled: Number(r.total_billed),
  }));
  const total = aggregated.reduce((s, r) => s + r.totalBilled, 0);
  const csv = buildCsv(
    ["الباقة", "الدورة", "عدد الشركات", "إجمالي الإيرادات", "الحصة %"],
    aggregated.map(r => [
      r.plan, r.billingCycle, r.subscriptionCount, r.totalBilled.toFixed(2),
      total > 0 ? ((r.totalBilled / total) * 100).toFixed(2) : "0.00",
    ]),
  );
  return {
    filename: `revenue-by-plan-${period.from}_${period.to}.csv`,
    csv,
    rowCount: aggregated.length,
  };
}

// ─── Available report registry ─────────────────────────────────────────────
// The UI surfaces these labels; the scheduler reads keys to know which CSVs
// to attach. Adding a new report only requires adding an entry here plus a
// case in `produceDigestArtifacts`.
export const AVAILABLE_REPORTS = [
  { key: "operational-summary", labelAr: "الملخص التشغيلي" },
  { key: "revenue-by-plan",     labelAr: "الإيرادات حسب الباقة" },
] as const;
export type ReportKey = typeof AVAILABLE_REPORTS[number]["key"];
export const REPORT_KEYS: readonly string[] = AVAILABLE_REPORTS.map(r => r.key);

export async function produceDigestArtifacts(
  reports: string[],
  frequency: "weekly" | "monthly",
): Promise<DigestArtifact[]> {
  const period = digestPeriod(frequency);
  const out: DigestArtifact[] = [];
  for (const key of reports) {
    if (key === "operational-summary") out.push(await produceOperationalSummaryCsv());
    else if (key === "revenue-by-plan") out.push(await produceRevenueByPlanCsv(period));
    // Unknown keys silently skipped — defensive against stale config rows.
  }
  return out;
}
