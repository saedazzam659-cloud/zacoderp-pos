/**
 * Integrations Marketplace — Phase A.
 *
 * Endpoints (all under /api/integrations):
 *   GET    /providers                      → catalog of all providers
 *   GET    /connections                    → list company's connections
 *   POST   /connections                    → create
 *   GET    /connections/:id                → detail
 *   PATCH  /connections/:id                → update (config, credentials, pull settings)
 *   DELETE /connections/:id                → remove
 *   POST   /connections/:id/test           → call adapter.testConnection
 *   POST   /connections/:id/sync           → manual pull
 *   GET    /connections/:id/runs           → recent sync runs
 *   POST   /inbound/:provider/:token       → push endpoint (no auth, token-gated)
 *
 * Auth: all routes except `/inbound/*` require an authenticated user;
 * connections are scoped by req.user.companyId.
 */
import { Router } from "express";
import { db, integrationConnectionsTable, integrationSyncRunsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { encryptSecret, decryptSecret } from "../lib/encryption.js";
import { PROVIDERS, findProvider } from "../lib/integrations/catalog.js";
import { getAdapter } from "../lib/integrations/adapters.js";
import type { GatewayCanonical } from "../lib/zatca-gateway-builder.js";

const router = Router();

// ─── Catalog (no auth needed beyond the global authMiddleware) ──────────
router.get("/providers", (_req, res) => {
  res.json({
    providers: PROVIDERS.map(p => ({
      id: p.id, nameAr: p.nameAr, nameEn: p.nameEn, category: p.category,
      taglineAr: p.taglineAr, status: p.status, capabilities: p.capabilities,
      accent: p.accent, logoSvg: p.logoSvg,
      credentialFields: p.credentialFields,
    })),
  });
});

// ─── Connections list / create ──────────────────────────────────────────
router.get("/connections", async (req, res) => {
  const companyId = (req as { user?: { companyId?: number } }).user?.companyId;
  if (!companyId) { res.status(401).json({ error: "غير مخوّل" }); return; }
  const rows = await db
    .select({
      id: integrationConnectionsTable.id,
      provider: integrationConnectionsTable.provider,
      displayName: integrationConnectionsTable.displayName,
      status: integrationConnectionsTable.status,
      baseUrl: integrationConnectionsTable.baseUrl,
      pullEnabled: integrationConnectionsTable.pullEnabled,
      pullIntervalMinutes: integrationConnectionsTable.pullIntervalMinutes,
      lastSyncAt: integrationConnectionsTable.lastSyncAt,
      lastSyncStatus: integrationConnectionsTable.lastSyncStatus,
      lastSyncError: integrationConnectionsTable.lastSyncError,
      totalSyncs: integrationConnectionsTable.totalSyncs,
      createdAt: integrationConnectionsTable.createdAt,
    })
    .from(integrationConnectionsTable)
    .where(eq(integrationConnectionsTable.companyId, companyId))
    .orderBy(desc(integrationConnectionsTable.createdAt));
  res.json({ connections: rows });
});

router.post("/connections", async (req, res) => {
  const companyId = (req as { user?: { companyId?: number; id?: number } }).user?.companyId;
  const userId    = (req as { user?: { id?: number } }).user?.id;
  if (!companyId) { res.status(401).json({ error: "غير مخوّل" }); return; }

  const provider = String(req.body?.provider ?? "");
  const info = findProvider(provider);
  if (!info)                       { res.status(400).json({ error: "مزوّد غير معروف" }); return; }
  if (info.status === "coming_soon") { res.status(400).json({ error: `${info.nameAr} متاح قريباً — لم يكتمل التطوير بعد` }); return; }

  const displayName = String(req.body?.displayName ?? info.nameAr).trim().slice(0, 120) || info.nameAr;
  const baseUrl     = req.body?.baseUrl ? String(req.body.baseUrl).trim() : null;
  const credentials = (req.body?.credentials ?? {}) as Record<string, string>;
  const config      = (req.body?.config ?? {}) as Record<string, unknown>;

  // Validate required credential fields per the catalog.
  for (const f of info.credentialFields) {
    if (f.required && !credentials[f.key]) {
      res.status(400).json({ error: `الحقل مطلوب: ${f.labelAr}` }); return;
    }
  }

  const inboundToken = randomBytes(24).toString("hex");
  const inboundTokenHash = createHash("sha256").update(inboundToken).digest("hex");

  const [row] = await db.insert(integrationConnectionsTable).values({
    companyId, provider, displayName,
    status: "disconnected",
    baseUrl,
    credentialsEnc: encryptSecret(JSON.stringify(credentials)),
    config,
    inboundTokenHash,
    createdBy: userId ?? null,
  }).returning({ id: integrationConnectionsTable.id });

  res.status(201).json({
    id: row.id,
    inboundToken,
    inboundUrl: `/api/integrations/inbound/${provider}/${inboundToken}`,
    hint: "احفظ inboundToken الآن — لن يُعرض مرة أخرى. استخدمه في رابط Push من نظامك.",
  });
});

router.get("/connections/:id", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  res.json({
    id: conn.id, provider: conn.provider, displayName: conn.displayName,
    status: conn.status, baseUrl: conn.baseUrl, config: conn.config,
    pullEnabled: conn.pullEnabled, pullIntervalMinutes: conn.pullIntervalMinutes,
    lastSyncAt: conn.lastSyncAt, lastSyncStatus: conn.lastSyncStatus,
    lastSyncError: conn.lastSyncError, totalSyncs: conn.totalSyncs,
    createdAt: conn.createdAt, updatedAt: conn.updatedAt,
    // credentials are NEVER returned — only their presence is indicated
    credentialKeysSet: conn.credentialsEnc
      ? Object.keys(safeParse(decryptSecret(conn.credentialsEnc) ?? "{}")) : [],
  });
});

router.patch("/connections/:id", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  const upd: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.displayName === "string") upd.displayName = req.body.displayName.trim().slice(0, 120);
  if (typeof req.body?.baseUrl === "string")     upd.baseUrl = req.body.baseUrl.trim() || null;
  if (typeof req.body?.pullEnabled === "boolean")        upd.pullEnabled = req.body.pullEnabled;
  if (Number.isFinite(req.body?.pullIntervalMinutes))    upd.pullIntervalMinutes = Math.max(5, Math.min(1440, Number(req.body.pullIntervalMinutes)));
  if (req.body?.config && typeof req.body.config === "object") upd.config = req.body.config;
  // Merge credentials — partial updates only overwrite the keys provided.
  if (req.body?.credentials && typeof req.body.credentials === "object") {
    const existing = conn.credentialsEnc ? safeParse(decryptSecret(conn.credentialsEnc) ?? "{}") : {};
    const merged = { ...existing, ...(req.body.credentials as Record<string, string>) };
    upd.credentialsEnc = encryptSecret(JSON.stringify(merged));
  }
  await db.update(integrationConnectionsTable).set(upd).where(eq(integrationConnectionsTable.id, conn.id));
  res.json({ ok: true });
});

router.delete("/connections/:id", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  await db.delete(integrationConnectionsTable).where(eq(integrationConnectionsTable.id, conn.id));
  res.json({ ok: true });
});

// ─── Test / sync / runs ─────────────────────────────────────────────────
router.post("/connections/:id/test", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  const adapter = getAdapter(conn.provider);
  if (!adapter) { res.status(400).json({ error: "لا يوجد محوّل لهذا المزوّد" }); return; }
  try {
    const credentials = conn.credentialsEnc ? safeParse(decryptSecret(conn.credentialsEnc) ?? "{}") : {};
    const r = await adapter.testConnection({ baseUrl: conn.baseUrl, credentials, config: conn.config, since: null });
    await db.update(integrationConnectionsTable).set({
      status: "connected", lastSyncError: null, updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, conn.id));
    res.json({ ok: true, info: r.info ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(integrationConnectionsTable).set({
      status: "error", lastSyncError: msg, updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, conn.id));
    res.status(400).json({ ok: false, error: msg });
  }
});

router.post("/connections/:id/sync", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  const result = await runSync(conn, "manual");
  res.status(result.status === "failed" ? 502 : 200).json(result);
});

router.get("/connections/:id/runs", async (req, res) => {
  const conn = await loadConn(req, res);
  if (!conn) return;
  const rows = await db
    .select()
    .from(integrationSyncRunsTable)
    .where(eq(integrationSyncRunsTable.connectionId, conn.id))
    .orderBy(desc(integrationSyncRunsTable.startedAt))
    .limit(50);
  res.json({ runs: rows });
});

// ─── Inbound push (NO auth — gated by per-connection token) ─────────────
// Mounted separately in routes/index.ts as /api/integrations/inbound/:provider/:token
// because we want to skip the global auth middleware for this single sub-tree.
export const inboundRouter = Router();
inboundRouter.post("/:provider/:token", async (req, res) => {
  const provider = String(req.params.provider);
  const token    = String(req.params.token);
  if (!/^[a-f0-9]{48}$/.test(token)) { res.status(400).json({ error: "token غير صالح" }); return; }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [conn] = await db
    .select()
    .from(integrationConnectionsTable)
    .where(and(eq(integrationConnectionsTable.provider, provider),
               eq(integrationConnectionsTable.inboundTokenHash, tokenHash)))
    .limit(1);
  if (!conn) { res.status(404).json({ error: "اتصال غير معروف" }); return; }
  const adapter = getAdapter(provider);
  if (!adapter) { res.status(400).json({ error: "لا يوجد محوّل" }); return; }

  const [run] = await db.insert(integrationSyncRunsTable).values({
    connectionId: conn.id, trigger: "push", status: "running",
  }).returning({ id: integrationSyncRunsTable.id });

  try {
    const canonical = adapter.translatePush(req.body);
    // For Phase A we just persist the run + canonical sample. Forwarding
    // to ZATCA is a later step (re-uses the existing gateway pipeline).
    await db.update(integrationSyncRunsTable).set({
      status: "success", finishedAt: new Date(),
      invoicesIngested: 1, rawResponse: canonical as unknown as Record<string, unknown>,
    }).where(eq(integrationSyncRunsTable.id, run.id));
    await bumpConnectionSuccess(conn.id, 1);
    res.status(202).json({ ok: true, runId: run.id, queued: 1 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(integrationSyncRunsTable).set({
      status: "failed", finishedAt: new Date(),
      errors: [{ ref: "(push)", reason: msg }],
    }).where(eq(integrationSyncRunsTable.id, run.id));
    res.status(400).json({ ok: false, error: msg });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────
type ConnRow = typeof integrationConnectionsTable.$inferSelect;

async function loadConn(req: { params: { id: string }; user?: { companyId?: number } }, res: { status: (n: number) => { json: (o: unknown) => void }; json: (o: unknown) => void }): Promise<ConnRow | null> {
  const companyId = req.user?.companyId;
  const id = Number(req.params.id);
  if (!companyId)               { res.status(401).json({ error: "غير مخوّل" }); return null; }
  if (!Number.isFinite(id))     { res.status(400).json({ error: "معرف غير صالح" }); return null; }
  const [row] = await db.select().from(integrationConnectionsTable)
    .where(and(eq(integrationConnectionsTable.id, id), eq(integrationConnectionsTable.companyId, companyId)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "اتصال غير موجود" }); return null; }
  return row;
}

async function runSync(conn: ConnRow, trigger: "manual" | "scheduled" | "push"): Promise<{ runId: number; status: string; ingested: number; errors: number; error?: string }> {
  const adapter = getAdapter(conn.provider);
  if (!adapter) return { runId: 0, status: "failed", ingested: 0, errors: 0, error: "لا يوجد محوّل" };

  const [run] = await db.insert(integrationSyncRunsTable).values({
    connectionId: conn.id, trigger, status: "running",
  }).returning({ id: integrationSyncRunsTable.id });

  try {
    const credentials = conn.credentialsEnc ? safeParse(decryptSecret(conn.credentialsEnc) ?? "{}") : {};
    const since = conn.lastSyncAt ? conn.lastSyncAt.toISOString() : null;
    const r = await adapter.pull({ baseUrl: conn.baseUrl, credentials, config: conn.config, since });
    const status = r.errors.length === 0 ? "success" : (r.invoices.length > 0 ? "partial" : "failed");
    await db.update(integrationSyncRunsTable).set({
      status, finishedAt: new Date(),
      invoicesIngested: r.invoices.length,
      errors: r.errors,
      rawResponse: { sample: r.rawSample } as Record<string, unknown>,
    }).where(eq(integrationSyncRunsTable.id, run.id));
    await db.update(integrationConnectionsTable).set({
      status: status === "failed" ? "error" : "connected",
      lastSyncAt: new Date(),
      lastSyncStatus: status,
      lastSyncError: r.errors[0]?.reason ?? null,
      totalSyncs: (conn.totalSyncs ?? 0) + 1,
      updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, conn.id));
    return { runId: run.id, status, ingested: r.invoices.length, errors: r.errors.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(integrationSyncRunsTable).set({
      status: "failed", finishedAt: new Date(),
      errors: [{ ref: "(adapter)", reason: msg }],
    }).where(eq(integrationSyncRunsTable.id, run.id));
    await db.update(integrationConnectionsTable).set({
      status: "error", lastSyncStatus: "failed", lastSyncError: msg, updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, conn.id));
    return { runId: run.id, status: "failed", ingested: 0, errors: 1, error: msg };
  }
}

async function bumpConnectionSuccess(connectionId: number, ingested: number): Promise<void> {
  const [c] = await db.select().from(integrationConnectionsTable)
    .where(eq(integrationConnectionsTable.id, connectionId)).limit(1);
  if (!c) return;
  await db.update(integrationConnectionsTable).set({
    status: "connected", lastSyncAt: new Date(), lastSyncStatus: "success",
    lastSyncError: null, totalSyncs: (c.totalSyncs ?? 0) + 1, updatedAt: new Date(),
  }).where(eq(integrationConnectionsTable.id, connectionId));
}

function safeParse(s: string): Record<string, string> {
  try { const j = JSON.parse(s); return j && typeof j === "object" ? j : {}; }
  catch { return {}; }
}

// Suppress unused-import warning until ZATCA forwarding is wired in Phase B.
export type _unused = GatewayCanonical;

export default router;
