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
import { db, companiesTable, integrationConnectionsTable, integrationSyncRunsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { encryptSecret, decryptSecret } from "../lib/encryption.js";
import { PROVIDERS, findProvider } from "../lib/integrations/catalog.js";
import { getAdapter } from "../lib/integrations/adapters.js";
import type { GatewayCanonical } from "../lib/zatca-gateway-builder.js";

const router = Router();

// Zid OAuth uses the same integration-connection storage as the existing
// marketplace, but never accepts merchant-pasted access tokens.
router.post("/zid/oauth/start", async (req, res) => {
  const user = (req as any).user;
  const companyId = Number(user?.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) {
    res.status(401).json({ error: "غير مخوّل" }); return;
  }
  if (user?.role !== "admin") {
    res.status(403).json({ error: "ربط Zid متاح لمدير الشركة فقط" }); return;
  }
  const clientId = process.env.ZID_CLIENT_ID;
  const clientSecret = process.env.ZID_CLIENT_SECRET;
  const redirectUri = process.env.ZID_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(503).json({ error: "إعداد تطبيق Zid غير مكتمل على الخادم" }); return;
  }

  const [company] = await db.select({
    id: companiesTable.id,
    menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  let permissions: Record<string, unknown> = {};
  try { permissions = JSON.parse(company?.menuPermissions ?? "{}"); } catch { /* fail closed */ }
  const erpSource = permissions.zid_invoice_source_erp === true;
  const zidSource = permissions.zid_invoice_source_zid === true;
  if (!company || permissions.zid_integration !== true || erpSource === zidSource) {
    res.status(403).json({ error: "فعّل وحدة Zid واختر مصدرًا واحدًا للفواتير من صلاحيات القوائم" }); return;
  }

  const state = randomBytes(32).toString("hex");
  const stateHash = createHash("sha256").update(state).digest("hex");
  await db.insert(integrationConnectionsTable).values({
    companyId,
    provider: "zid",
    displayName: "Zid",
    status: "pending",
    credentialsEnc: null,
    config: {
      oauthStateHash: stateHash,
      oauthExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      invoiceSource: erpSource ? "erp" : "zid",
    },
    createdBy: Number.isInteger(user?.id) ? user.id : null,
  });

  const authorize = new URL("https://oauth.zid.sa/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  res.json({ authorizationUrl: authorize.toString() });
});

router.get("/zid/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state || state.length > 256) {
    res.status(400).send("رابط OAuth غير مكتمل. أعد بدء الربط من داخل النظام."); return;
  }
  const clientId = process.env.ZID_CLIENT_ID;
  const clientSecret = process.env.ZID_CLIENT_SECRET;
  const redirectUri = process.env.ZID_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(503).send("إعداد تطبيق Zid غير مكتمل على الخادم."); return;
  }
  const stateHash = createHash("sha256").update(state).digest("hex");
  const [connection] = await db.select().from(integrationConnectionsTable).where(and(
    eq(integrationConnectionsTable.provider, "zid"),
    eq(integrationConnectionsTable.status, "pending"),
    sql`${integrationConnectionsTable.config}->>'oauthStateHash' = ${stateHash}`,
  )).limit(1);
  const config = connection?.config ?? {};
  const expiresAt = Date.parse(String(config.oauthExpiresAt ?? ""));
  if (!connection || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    res.status(400).send("انتهت صلاحية طلب الربط أو أنه غير صالح. أعد المحاولة."); return;
  }
  const [company] = await db.select({
    menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, connection.companyId)).limit(1);
  let permissions: Record<string, unknown> = {};
  try { permissions = JSON.parse(company?.menuPermissions ?? "{}"); } catch { /* fail closed */ }
  const erpSource = permissions.zid_invoice_source_erp === true;
  const zidSource = permissions.zid_invoice_source_zid === true;
  const currentSource = erpSource === zidSource ? null : (erpSource ? "erp" : "zid");
  if (permissions.zid_integration !== true || currentSource !== config.invoiceSource) {
    res.status(409).send("تغيّرت صلاحيات Zid أو مصدر الفاتورة. أعد ضبطهما وابدأ الربط من جديد."); return;
  }
  const [claimed] = await db.update(integrationConnectionsTable).set({
    status: "exchanging",
    config: { invoiceSource: config.invoiceSource },
    updatedAt: new Date(),
  }).where(and(
    eq(integrationConnectionsTable.id, connection.id),
    eq(integrationConnectionsTable.status, "pending"),
  )).returning({ id: integrationConnectionsTable.id });
  if (!claimed) {
    res.status(409).send("تم استخدام طلب الربط بالفعل. ابدأ محاولة جديدة من النظام."); return;
  }

  try {
    const tokenResponse = await fetch("https://oauth.zid.sa/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    const expiresIn = Number(tokens.expires_in);
    if (!tokenResponse.ok || typeof tokens.authorization !== "string" ||
        typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" ||
        !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("تعذر إكمال تفويض Zid");
    }

    const profileResponse = await fetch("https://api.zid.sa/v1/managers/account/store", {
      headers: {
        Authorization: `Bearer ${tokens.authorization}`,
        "X-Manager-Token": tokens.access_token,
        Accept: "application/json",
        "Accept-Language": "ar",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!profileResponse.ok) throw new Error("تعذر التحقق من المتجر المفوض لدى Zid");
    const profile = await profileResponse.json() as Record<string, any>;
    const store = profile.store ?? profile.data?.store ?? profile.data ?? {};
    const storeId = store.id ?? store.uuid ?? store.store_id;
    if (storeId == null) throw new Error("لم يُرجع Zid هوية متجر صالحة");

    const encrypted = encryptSecret(JSON.stringify({
      authorization: tokens.authorization,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    }));
    await db.update(integrationConnectionsTable).set({
      status: "connected",
      credentialsEnc: encrypted,
      config: {
        invoiceSource: config.invoiceSource === "erp" ? "erp" : "zid",
        storeId: String(storeId).slice(0, 120),
        storeName: String(store.name ?? store.title ?? "").slice(0, 160),
        connectedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, connection.id));
    res.status(200).type("html").send(
      "<!doctype html><meta charset=utf-8><title>Zid</title><p dir=rtl>تم ربط متجر Zid بنجاح. يمكنك العودة إلى النظام.</p>",
    );
  } catch (error) {
    req.log?.error?.({ error, connectionId: connection.id }, "Zid OAuth callback failed");
    await db.update(integrationConnectionsTable).set({
      status: "error",
      lastSyncError: "OAuth authorization failed",
      updatedAt: new Date(),
    }).where(eq(integrationConnectionsTable.id, connection.id));
    res.status(502).send("لم يكتمل الربط مع Zid. أعد بدء التفويض من النظام.");
  }
});

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

router.get("/zid/orders", async (req, res) => {
  const zid = await loadAuthorizedZid(req, res);
  if (!zid) return;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
  const perPage = Math.max(1, Math.min(100, Number.parseInt(String(req.query.per_page ?? "50"), 10) || 50));
  try {
    const url = new URL("https://api.zid.sa/v1/managers/store/orders");
    url.searchParams.set("payload_type", "default");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const status = typeof req.query.order_status === "string" ? req.query.order_status : "";
    if (["new", "preparing", "ready", "indelivery", "delivered", "canceled", "reversed"].includes(status)) {
      url.searchParams.set("order_status", status);
    }
    const response = await fetch(url, {
      headers: zid.headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      res.status(response.status === 401 || response.status === 403 ? 409 : 502).json({
        error: "تعذر جلب طلبات Zid. تحقق من صلاحية orders.read ثم أعد ربط المتجر.",
      });
      return;
    }
    const orders = extractZidCollection(body);
    res.json({ orders, pagination: body?.pagination ?? body?.data?.pagination ?? null, page, perPage });
  } catch (error) {
    req.log?.error?.({ error, connectionId: zid.connection.id }, "Zid order pull failed");
    res.status(502).json({ error: "تعذر الاتصال بخدمة طلبات Zid" });
  }
});

router.get("/zid/orders/:orderId/credit-notes", async (req, res) => {
  const zid = await loadAuthorizedZid(req, res);
  if (!zid) return;
  const orderId = String(req.params.orderId ?? "").trim();
  if (!orderId || orderId.length > 120 || !/^[\w-]+$/.test(orderId)) {
    res.status(400).json({ error: "معرّف طلب Zid غير صالح" }); return;
  }
  try {
    const response = await fetch(
      `https://api.zid.sa/v1/managers/store/orders/${encodeURIComponent(orderId)}/credit-notes`,
      { headers: zid.headers, redirect: "error", signal: AbortSignal.timeout(20_000) },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      res.status(response.status === 401 || response.status === 403 ? 409 : 502).json({
        error: "تعذر جلب إشعارات الطلب من Zid. تحقق من صلاحية orders.read.",
      });
      return;
    }
    res.json({ creditNotes: extractZidCollection(body) });
  } catch (error) {
    req.log?.error?.({ error, connectionId: zid.connection.id }, "Zid credit-note pull failed");
    res.status(502).json({ error: "تعذر الاتصال بخدمة إشعارات Zid" });
  }
});

router.get("/zid/orders/:orderId/erp-invoice", async (req, res) => {
  const zid = await loadAuthorizedZid(req, res);
  if (!zid) return;
  const orderId = String(req.params.orderId ?? "").trim();
  if (!orderId || orderId.length > 120 || !/^[\w-]+$/.test(orderId)) {
    res.status(400).json({ error: "معرّف طلب Zid غير صالح" }); return;
  }
  const clientRequestId = `zid-${zid.connection.id}-${orderId}`;
  const result: any = await db.execute(sql`
    SELECT invoice.id, invoice.doc_number AS "docNumber"
      FROM invoice_create_idempotency replay
      JOIN sales_invoices invoice
        ON invoice.id = replay.sales_invoice_id
       AND invoice.company_id = replay.company_id
     WHERE replay.company_id = ${zid.connection.companyId}
       AND replay.invoice_kind = 'sales_invoice'
       AND replay.client_request_id = ${clientRequestId}
     LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  if (!rows.length) {
    res.status(404).json({ error: "أنشئ مسودة فاتورة ERP لهذا الطلب أولاً قبل استيراد مرتجعه" });
    return;
  }
  res.json({ invoiceId: Number(rows[0].id), docNumber: rows[0].docNumber ?? null });
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

async function loadAuthorizedZid(req: any, res: any): Promise<{
  connection: ConnRow;
  headers: Record<string, string>;
} | null> {
  const user = req.user;
  const companyId = Number(user?.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) {
    res.status(401).json({ error: "غير مخوّل" }); return null;
  }
  if (user?.role !== "admin") {
    res.status(403).json({ error: "مزامنة Zid متاحة لمدير الشركة فقط" }); return null;
  }
  const [company] = await db.select({ menuPermissions: companiesTable.menuPermissions })
    .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  let permissions: Record<string, unknown> = {};
  try { permissions = JSON.parse(company?.menuPermissions ?? "{}"); } catch { /* fail closed */ }
  const erpSource = permissions.zid_invoice_source_erp === true;
  const zidSource = permissions.zid_invoice_source_zid === true;
  if (!company || permissions.zid_integration !== true || erpSource === zidSource) {
    res.status(403).json({ error: "فعّل وحدة Zid واختر مصدرًا واحدًا للفواتير من صلاحيات القوائم" }); return null;
  }
  const [connection] = await db.select().from(integrationConnectionsTable).where(and(
    eq(integrationConnectionsTable.companyId, companyId),
    eq(integrationConnectionsTable.provider, "zid"),
    eq(integrationConnectionsTable.status, "connected"),
  )).orderBy(desc(integrationConnectionsTable.updatedAt)).limit(1);
  if (!connection?.credentialsEnc) {
    res.status(409).json({ error: "اربط متجر Zid أولاً" }); return null;
  }
  const credentials = safeParse(decryptSecret(connection.credentialsEnc) ?? "{}");
  const expiresAt = Date.parse(String(credentials.expiresAt ?? ""));
  if (!credentials.authorization || !credentials.accessToken || !Number.isFinite(expiresAt)) {
    res.status(409).json({ error: "بيانات تفويض Zid غير مكتملة. أعد ربط المتجر." }); return null;
  }
  if (expiresAt <= Date.now() + 5 * 60_000) {
    const clientId = process.env.ZID_CLIENT_ID;
    const clientSecret = process.env.ZID_CLIENT_SECRET;
    const redirectUri = process.env.ZID_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri || !credentials.refreshToken) {
      res.status(409).json({ error: "انتهت صلاحية تفويض Zid. أعد ربط المتجر." }); return null;
    }
    try {
      const tokenResponse = await fetch("https://oauth.zid.sa/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          refresh_token: credentials.refreshToken,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const tokens = await tokenResponse.json() as Record<string, unknown>;
      const expiresIn = Number(tokens.expires_in);
      if (!tokenResponse.ok || typeof tokens.authorization !== "string" ||
          typeof tokens.access_token !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("Invalid Zid refresh response");
      }
      const refreshed = {
        authorization: tokens.authorization,
        accessToken: tokens.access_token,
        refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : credentials.refreshToken,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      await db.update(integrationConnectionsTable).set({
        credentialsEnc: encryptSecret(JSON.stringify(refreshed)),
        updatedAt: new Date(),
      }).where(eq(integrationConnectionsTable.id, connection.id));
      Object.assign(credentials, refreshed);
    } catch (error) {
      req.log?.error?.({ error, connectionId: connection.id }, "Zid token refresh failed");
      res.status(409).json({ error: "تعذر تجديد تفويض Zid. أعد ربط المتجر." }); return null;
    }
  }
  return {
    connection,
    headers: {
      Authorization: `Bearer ${credentials.authorization}`,
      "X-Manager-Token": credentials.accessToken,
      Accept: "application/json",
      "Accept-Language": "ar",
    },
  };
}

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

function extractZidCollection(body: any): any[] {
  const candidates = [
    body?.data?.orders,
    body?.data?.results,
    body?.orders,
    body?.results,
    body?.data,
  ];
  return candidates.find(Array.isArray) ?? [];
}

// Suppress unused-import warning until ZATCA forwarding is wired in Phase B.
export type _unused = GatewayCanonical;

export default router;
