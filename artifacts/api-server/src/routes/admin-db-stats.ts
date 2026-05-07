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

export default router;
