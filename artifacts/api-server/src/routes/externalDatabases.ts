// SuperAdmin — External storage databases + module routing («قواعد البيانات
// الخارجية»). Mirrors the domains.ts SA-guard convention. Connection strings
// are write-only: stored encrypted, listed only as a redacted display form.

import { Router } from "express";
import { db, centralDb, createExternalDb, externalDatabasesTable, storageRoutingsTable, documentArchivesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import {
  ROUTABLE_MODULES, MODULE_DDL, ensureExternalDbTables,
  encryptConn, decryptConn, redactConn,
  invalidateRoutingCache, testConnection,
} from "../lib/externalDbRouting.js";

const router = Router();
router.use(async (_req, _res, next) => { try { await ensureExternalDbTables(); next(); } catch (e) { next(e); } });
router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" }); return;
  }
  next();
});

// GET / — list registered DBs (no credentials) + current routings + registry.
router.get("/", async (_req, res) => {
  const [dbs, routings] = await Promise.all([
    centralDb.select({
      id: externalDatabasesTable.id,
      name: externalDatabasesTable.name,
      connDisplay: externalDatabasesTable.connDisplay,
      status: externalDatabasesTable.status,
      lastCheckAt: externalDatabasesTable.lastCheckAt,
      lastCheckResult: externalDatabasesTable.lastCheckResult,
      notes: externalDatabasesTable.notes,
      createdAt: externalDatabasesTable.createdAt,
    }).from(externalDatabasesTable).orderBy(externalDatabasesTable.id),
    centralDb.select().from(storageRoutingsTable),
  ]);
  res.json({ databases: dbs, routings, modules: ROUTABLE_MODULES });
});

const createSchema = z.object({
  name: z.string().min(2).max(80),
  connectionString: z.string().min(10).max(2000)
    .refine(s => /^postgres(ql)?:\/\//.test(s.trim()), "يجب أن يبدأ الرابط بـ postgresql://"),
  notes: z.string().max(500).optional(),
});

// POST / — register a new external DB (tests the connection first).
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    res.status(400).json({ error: `بيانات غير صالحة: ${i?.path?.join(".") ?? ""} — ${i?.message ?? ""}` }); return;
  }
  const conn = parsed.data.connectionString.trim();
  const test = await testConnection(conn);
  if (!test.ok) { res.status(400).json({ error: `فشل الاتصال بالقاعدة: ${test.error}` }); return; }
  try {
    const [row] = await centralDb.insert(externalDatabasesTable).values({
      name: parsed.data.name.trim(),
      connEncrypted: encryptConn(conn),
      connDisplay: redactConn(conn),
      status: "ok",
      lastCheckAt: new Date(),
      lastCheckResult: test,
      notes: parsed.data.notes ?? null,
    }).returning();
    res.status(201).json({ id: row.id, name: row.name, connDisplay: row.connDisplay, status: row.status });
  } catch (e: any) {
    if (String(e?.code) === "23505") { res.status(409).json({ error: "يوجد قاعدة بنفس الاسم" }); return; }
    throw e;
  }
});

// POST /:id/test — re-test an existing DB.
router.post("/:id/test", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await centralDb.select().from(externalDatabasesTable).where(eq(externalDatabasesTable.id, id));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  const test = await testConnection(decryptConn(row.connEncrypted));
  await centralDb.update(externalDatabasesTable)
    .set({ status: test.ok ? "ok" : "error", lastCheckAt: new Date(), lastCheckResult: test, updatedAt: new Date() })
    .where(eq(externalDatabasesTable.id, id));
  res.json(test);
});

// DELETE /:id — refuse while any module is routed to it.
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const routed = await centralDb.select().from(storageRoutingsTable).where(eq(storageRoutingsTable.externalDbId, id));
  if (routed.length > 0) {
    res.status(409).json({ error: `لا يمكن الحذف: موديولات موجهة إليها (${routed.map(r => r.moduleKey).join("، ")}) — أعد توجيهها للمركزية أولًا` });
    return;
  }
  await centralDb.delete(externalDatabasesTable).where(eq(externalDatabasesTable.id, id));
  invalidateRoutingCache();
  res.json({ ok: true });
});

const routeSchema = z.object({
  moduleKey: z.string(),
  externalDbId: z.number().int().positive().nullable(),
});

// PUT /routings — point a module at an external DB (or back to central with
// null). Requires the module to be wired, the DB reachable, and its DDL
// applied. NOTE: this switches where NEW reads/writes go — use /migrate first
// to move existing rows, or old rows become invisible to the module.
router.put("/routings", async (req, res) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const mod = ROUTABLE_MODULES.find(m => m.key === parsed.data.moduleKey);
  if (!mod) { res.status(400).json({ error: "موديول غير معروف" }); return; }
  if (!mod.wired && parsed.data.externalDbId != null) {
    res.status(400).json({ error: "هذا الموديول غير مفعّل للتوجيه بعد (قريبًا)" }); return;
  }
  // External→external rerouting is not supported (data would be stranded on
  // the old DB): go back to central first, migrate, then re-route.
  const [currentRouting] = await centralDb.select().from(storageRoutingsTable)
    .where(eq(storageRoutingsTable.moduleKey, mod.key)).limit(1);
  if (
    currentRouting?.externalDbId != null &&
    parsed.data.externalDbId != null &&
    currentRouting.externalDbId !== parsed.data.externalDbId
  ) {
    res.status(400).json({ error: "لا يمكن النقل مباشرة بين قاعدتين خارجيتين — أعد التوجيه للمركزية أولًا" });
    return;
  }
  if (parsed.data.externalDbId != null) {
    const [row] = await centralDb.select().from(externalDatabasesTable).where(eq(externalDatabasesTable.id, parsed.data.externalDbId));
    if (!row) { res.status(404).json({ error: "القاعدة غير موجودة" }); return; }
    // Ensure reachability + module DDL before flipping any routing.
    const conn = decryptConn(row.connEncrypted);
    const test = await testConnection(conn);
    if (!test.ok) { res.status(400).json({ error: `القاعدة غير متاحة: ${test.error}` }); return; }
    const ctx = createExternalDb(conn);
    try {
      for (const ddl of MODULE_DDL[mod.key] ?? []) await ctx.pool.query(ddl);
    } finally { try { void ctx.pool.end(); } catch { /* noop */ } }
  }
  await centralDb.insert(storageRoutingsTable)
    .values({ moduleKey: mod.key, externalDbId: parsed.data.externalDbId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: storageRoutingsTable.moduleKey,
      set: { externalDbId: parsed.data.externalDbId, updatedAt: new Date() },
    });
  invalidateRoutingCache();
  res.json({ ok: true });
});

// POST /migrate — copy existing document_archive rows central → external,
// verify counts, then flip the routing. Batched; id-ordered; upsert-safe on
// retry (ON CONFLICT (id) DO NOTHING).
router.post("/migrate", async (req, res) => {
  const { moduleKey, externalDbId } = req.body ?? {};
  const mod = ROUTABLE_MODULES.find(m => m.key === moduleKey);
  if (!mod || !mod.wired) { res.status(400).json({ error: "موديول غير قابل للنقل" }); return; }
  const [target] = await centralDb.select().from(externalDatabasesTable).where(eq(externalDatabasesTable.id, Number(externalDbId)));
  if (!target) { res.status(404).json({ error: "القاعدة غير موجودة" }); return; }

  const conn = decryptConn(target.connEncrypted);
  const test = await testConnection(conn);
  if (!test.ok) { res.status(400).json({ error: `القاعدة غير متاحة: ${test.error}` }); return; }

  const ctx = createExternalDb(conn);
  try {
    for (const ddl of MODULE_DDL[mod.key] ?? []) await ctx.pool.query(ddl);

    // Batched copy (central → external). Two passes: full copy, then a
    // delta pass right before the flip to pick up rows written during the
    // first pass (upserts are ON CONFLICT DO NOTHING so re-copying is safe).
    const copyFrom = async (startId: number): Promise<{ copied: number; lastId: number }> => {
    let lastId = startId, copied = 0;
    for (;;) {
      const batch = await centralDb.select().from(documentArchivesTable)
        .where(sql`${documentArchivesTable.id} > ${lastId}`)
        .orderBy(documentArchivesTable.id).limit(500);
      if (batch.length === 0) break;
      const values: any[] = [];
      const params: any[] = [];
      for (const r of batch) {
        const base = params.length;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`);
        params.push(r.id, r.companyId, r.screenKey, r.docKey, r.filename, r.objectPath, r.contentType, r.bytes, r.pages, r.uploadedBy, r.uploadedByName, r.createdAt);
      }
      await ctx.pool.query(
        `INSERT INTO document_archives (id, company_id, screen_key, doc_key, filename, object_path, content_type, bytes, pages, uploaded_by, uploaded_by_name, created_at)
         VALUES ${values.join(",")} ON CONFLICT (id) DO NOTHING`, params);
      lastId = batch[batch.length - 1].id;
      copied += batch.length;
    }
    return { copied, lastId };
    };
    const pass1 = await copyFrom(0);
    // Delta pass: catch rows inserted while pass 1 ran.
    const pass2 = await copyFrom(Math.max(0, pass1.lastId - 1));
    const copied = pass1.copied + pass2.copied;
    // Keep the external sequence ahead of copied ids.
    await ctx.pool.query(`SELECT setval(pg_get_serial_sequence('document_archives','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM document_archives), 1))`);

    // Verify counts before flipping.
    const [{ count: centralCount }] = (await centralDb.execute(sql`SELECT COUNT(*)::int AS count FROM document_archives`)).rows as any[];
    const extCount = Number((await ctx.pool.query(`SELECT COUNT(*)::int AS count FROM document_archives`)).rows[0].count);
    if (extCount < Number(centralCount)) {
      res.status(500).json({ error: `فشل التحقق: المركزية ${centralCount} صف مقابل ${extCount} في الخارجية — لم يتم التحويل` });
      return;
    }

    await centralDb.insert(storageRoutingsTable)
      .values({ moduleKey: mod.key, externalDbId: target.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: storageRoutingsTable.moduleKey, set: { externalDbId: target.id, updatedAt: new Date() } });
    invalidateRoutingCache();
    res.json({ ok: true, copied, centralCount: Number(centralCount), externalCount: extCount });
  } finally {
    try { void ctx.pool.end(); } catch { /* noop */ }
  }
});

export default router;
