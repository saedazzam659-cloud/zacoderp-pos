// SuperAdmin-only endpoint that reports the live PostgreSQL database size,
// the size of the largest tables, and quick row-counts for the headline
// business entities. Used by the "إحصاءات قاعدة البيانات" page so the
// SuperAdmin can see how much storage the system actually uses without
// running SQL by hand — useful for capacity planning before upgrading
// the Replit/Neon plan.

import { Router, type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";

const router = Router();

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved && resolved.origin === "superadmin") {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }
  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" });
    return;
  }
  next();
}

// GET /api/admin/db-stats
router.get("/", requireSuperAdmin, async (_req, res) => {
  try {
    // Total database size (compressed on-disk size including indexes/toast).
    const sizeRow = await db.execute<{ db_name: string; size_bytes: string; size_pretty: string }>(sql`
      SELECT current_database()                      AS db_name,
             pg_database_size(current_database())    AS size_bytes,
             pg_size_pretty(pg_database_size(current_database())) AS size_pretty
    `);
    const sizeInfo = sizeRow.rows[0] ?? { db_name: "", size_bytes: "0", size_pretty: "0 bytes" };

    // Top 15 tables by total size (data + indexes + toast).
    const topTables = await db.execute<{
      table_name: string;
      total_bytes: string;
      total_pretty: string;
      table_pretty: string;
      index_pretty: string;
      row_estimate: string;
    }>(sql`
      SELECT relname                                              AS table_name,
             pg_total_relation_size(c.oid)                        AS total_bytes,
             pg_size_pretty(pg_total_relation_size(c.oid))        AS total_pretty,
             pg_size_pretty(pg_relation_size(c.oid))              AS table_pretty,
             pg_size_pretty(pg_indexes_size(c.oid))               AS index_pretty,
             reltuples::bigint                                    AS row_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname = 'public'
       ORDER BY pg_total_relation_size(c.oid) DESC
       LIMIT 15
    `);

    // Headline business-entity counts. Wrapped in try/catch each so a
    // missing table on a partially-migrated environment doesn't fail
    // the whole call.
    const safeCount = async (table: string): Promise<number | null> => {
      try {
        const r = await db.execute<{ count: string }>(sql.raw(`SELECT COUNT(*)::text AS count FROM ${table}`));
        return Number(r.rows[0]?.count ?? 0);
      } catch {
        return null;
      }
    };
    const counts: Record<string, number | null> = {
      companies:           await safeCount("companies"),
      users:               await safeCount("users"),
      customers:           await safeCount("customers"),
      suppliers:           await safeCount("suppliers"),
      items:               await safeCount("items"),
      sales_invoices:      await safeCount("sales_invoices"),
      purchase_invoices:   await safeCount("purchase_invoices"),
      journal_entries:     await safeCount("journal_entries"),
      stock_ledger:        await safeCount("stock_ledger"),
      audit_log:           await safeCount("audit_log"),
    };

    res.json({
      database: {
        name:        sizeInfo.db_name,
        sizeBytes:   Number(sizeInfo.size_bytes),
        sizePretty:  sizeInfo.size_pretty,
      },
      topTables: topTables.rows.map((r) => ({
        name:         r.table_name,
        totalBytes:   Number(r.total_bytes),
        totalPretty:  r.total_pretty,
        tablePretty:  r.table_pretty,
        indexPretty:  r.index_pretty,
        rowEstimate:  Number(r.row_estimate),
      })),
      counts,
      capturedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب إحصاءات قاعدة البيانات" });
  }
});

// GET /api/admin/db-stats/by-company
// Returns per-company storage usage estimates by aggregating row counts
// across every public table that has a `company_id` column. Bytes are
// estimated as (table_total_size / table_row_count) * company_row_count
// — this is approximate but good enough for a SuperAdmin dashboard that
// shows who is consuming the most database space.
router.get("/by-company", requireSuperAdmin, async (_req, res) => {
  try {
    // 1) Discover every public table that has a company_id column.
    const tablesRes = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name  = 'company_id'
       ORDER BY table_name
    `);
    const tables = tablesRes.rows.map((r) => r.table_name);

    // 2) Get per-table total size + total row count (live count via reltuples).
    const sizesRes = await db.execute<{
      table_name: string;
      total_bytes: string;
      total_rows: string;
    }>(sql`
      SELECT relname                        AS table_name,
             pg_total_relation_size(c.oid)  AS total_bytes,
             reltuples::bigint              AS total_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname = 'public'
         AND relname = ANY(${tables})
    `);
    const sizeByTable = new Map<string, { bytes: number; rows: number }>();
    for (const r of sizesRes.rows) {
      sizeByTable.set(r.table_name, {
        bytes: Number(r.total_bytes) || 0,
        rows:  Number(r.total_rows)  || 0,
      });
    }

    // 3) Companies map (id → name). Soft-deleted included so we can still
    // attribute orphan rows; the UI flags them.
    const companiesRes = await db.execute<{
      id: string; name_ar: string; name_en: string | null; deleted_at: string | null;
    }>(sql`SELECT id, name_ar, name_en, deleted_at FROM companies`);
    const companies = new Map<number, { id: number; nameAr: string; nameEn: string | null; isDeleted: boolean }>();
    for (const c of companiesRes.rows) {
      const cid = Number(c.id);
      companies.set(cid, {
        id: cid, nameAr: c.name_ar ?? `#${cid}`, nameEn: c.name_en, isDeleted: !!c.deleted_at,
      });
    }

    // 4) For each table, run "SELECT company_id, COUNT(*) FROM t GROUP BY 1"
    // in parallel. Wrap each in try/catch so one bad table doesn't kill it.
    type CompanyAgg = {
      companyId: number;
      companyName: string;
      isDeleted: boolean;
      totalRows: number;
      estimatedBytes: number;
      byTable: Record<string, { rows: number; bytes: number }>;
    };
    const aggByCompany = new Map<number, CompanyAgg>();
    const ensureAgg = (cid: number): CompanyAgg => {
      const existing = aggByCompany.get(cid);
      if (existing) return existing;
      const meta = companies.get(cid);
      const fresh: CompanyAgg = {
        companyId: cid,
        companyName: meta?.nameAr ?? `#${cid} (محذوفة)`,
        isDeleted: meta?.isDeleted ?? !meta,
        totalRows: 0,
        estimatedBytes: 0,
        byTable: {},
      };
      aggByCompany.set(cid, fresh);
      return fresh;
    };

    await Promise.all(tables.map(async (t) => {
      try {
        const counts = await db.execute<{ company_id: string; rows: string }>(
          sql.raw(`SELECT company_id::text AS company_id, COUNT(*)::text AS rows FROM "${t}" WHERE company_id IS NOT NULL GROUP BY company_id`),
        );
        const tSize = sizeByTable.get(t) ?? { bytes: 0, rows: 0 };
        const bytesPerRow = tSize.rows > 0 ? tSize.bytes / tSize.rows : 0;
        for (const row of counts.rows) {
          const cid = Number(row.company_id);
          if (!Number.isFinite(cid)) continue;
          const rowCount = Number(row.rows) || 0;
          const bytesEst = Math.round(rowCount * bytesPerRow);
          const agg = ensureAgg(cid);
          agg.byTable[t] = { rows: rowCount, bytes: bytesEst };
          agg.totalRows      += rowCount;
          agg.estimatedBytes += bytesEst;
        }
      } catch {
        /* skip unreadable tables (e.g. permissions / migration races) */
      }
    }));

    const list = Array.from(aggByCompany.values())
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes);

    // Aggregate stats for dashboard widgets.
    const totalCompanies = list.length;
    const totalBytes = list.reduce((s, c) => s + c.estimatedBytes, 0);
    const totalRows  = list.reduce((s, c) => s + c.totalRows,      0);
    const avgBytes   = totalCompanies > 0 ? Math.round(totalBytes / totalCompanies) : 0;
    const avgRows    = totalCompanies > 0 ? Math.round(totalRows  / totalCompanies) : 0;
    const top        = list[0] ?? null;
    const bottom     = list[list.length - 1] ?? null;

    res.json({
      tables,
      companies: list,
      summary: {
        totalCompanies,
        totalBytes,
        totalRows,
        avgBytes,
        avgRows,
        topCompany:    top    ? { id: top.companyId, name: top.companyName, bytes: top.estimatedBytes, rows: top.totalRows } : null,
        bottomCompany: bottom ? { id: bottom.companyId, name: bottom.companyName, bytes: bottom.estimatedBytes, rows: bottom.totalRows } : null,
      },
      capturedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب استهلاك الشركات" });
  }
});

export default router;
