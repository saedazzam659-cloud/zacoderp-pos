import { Router, type IRouter, type Request, type Response } from "express";
import { db, companyExtensionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { companyAllowsModule, writeAudit } from "../middleware/permissions.js";
import {
  ensureExtensionPlatform,
  getActiveExtensions,
  getExtension,
  getBuiltin,
  type ExtensionContext,
} from "./registry.js";
import {
  coreList,
  coreCreate,
  CoreApiError,
  type CoreAction,
} from "./coreDataApi.js";
import {
  dataList,
  dataGet,
  dataCreate,
  dataUpdate,
  dataRemove,
  DataStoreError,
} from "./dataStore.js";
import { EXTENSION_SDK_JS } from "./sdk.js";
import {
  getListingByExtensionId,
  listingIsPaid,
  hasActiveEntitlement,
} from "../lib/marketplace.js";

// ─────────────────────────────────────────────────────────────────────────
// Extension Platform router — mounted at /api/ext (ADDITIVE; one line in
// routes/index.ts). Everything here is an "outer shell": it never imports or
// mutates any core business module, and partner code reaches the system only
// through this permissioned, tenant-scoped surface.
//
// Two gating layers, both default OFF:
//   1. Company module gate `extensions_platform` (SuperAdmin → MenuPermissions)
//      — the whole platform is invisible/403 until a company is granted it.
//   2. Per-company per-extension enable flag (company_extensions.enabled)
//      — each extension stays OFF until an admin explicitly enables it.
// ─────────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

// Allow the sandboxed (origin-less) iframe to pass its bearer token via a
// query param — it cannot set an Authorization header on a plain navigation /
// fetch. Mirrors the document-archives download pattern. Runs BEFORE auth.
router.use((req, _res, next) => {
  const t = req.query.token;
  if (typeof t === "string" && t && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${t}`;
  }
  next();
});

// Public SDK source (for developer tooling/docs). The screen documents inline
// the SDK directly because of the strict CSP, so this endpoint is for partners
// building/testing against the SDK, not for runtime loading. No auth needed —
// it is static, non-sensitive code.
router.get("/sdk.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(EXTENSION_SDK_JS);
});

router.use(extractAuth);

function requireAuthed(req: Request, res: Response): boolean {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return false;
  }
  return true;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!requireAuthed(req, res)) return false;
  const role = req.authUser!.role;
  if (role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "هذه العملية تتطلب صلاحية المدير" });
    return false;
  }
  return true;
}

// The company module gate (`extensions_platform`, default OFF). SuperAdmin
// bypasses (they manage the platform for every tenant).
function requireModuleGate(req: Request, res: Response): boolean {
  if (!requireAuthed(req, res)) return false;
  if (req.authUser!.role === "superadmin") return true;
  if (!companyAllowsModule(req.authUser, "extensions")) {
    res.status(403).json({ error: "وحدة الإضافات غير مفعّلة لهذه الشركة" });
    return false;
  }
  return true;
}

function ctxFrom(req: Request): ExtensionContext {
  const u = req.authUser!;
  return {
    companyId: resolveCompanyId(req) ?? u.companyId ?? null,
    userId: u.id ?? null,
    role: u.role,
    token: typeof req.query.token === "string" ? req.query.token : null,
  };
}

async function isEnabledForCompany(companyId: number | null, extensionId: string): Promise<boolean> {
  if (companyId == null) return false;
  const rows = await db
    .select({ enabled: companyExtensionsTable.enabled })
    .from(companyExtensionsTable)
    .where(
      and(
        eq(companyExtensionsTable.companyId, companyId),
        eq(companyExtensionsTable.extensionId, extensionId),
      ),
    )
    .limit(1);
  return rows[0]?.enabled === true;
}

// ── Catalog (platform-wide) — SuperAdmin/admin only ───────────────────────
router.get("/catalog", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await ensureExtensionPlatform();
    const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
    const all = await getActiveExtensions();
    let enabledSet = new Set<string>();
    if (cid != null) {
      const rows = await db
        .select({ extensionId: companyExtensionsTable.extensionId, enabled: companyExtensionsTable.enabled })
        .from(companyExtensionsTable)
        .where(eq(companyExtensionsTable.companyId, cid));
      enabledSet = new Set(rows.filter((r) => r.enabled).map((r) => r.extensionId));
    }
    res.json(
      all.map((e) => ({
        extensionId: e.extensionId,
        nameAr: e.nameAr,
        nameEn: e.nameEn,
        version: e.version,
        vendor: e.vendor,
        screens: e.manifest.screens,
        tables: e.manifest.tables,
        permissions: e.manifest.permissions,
        publicKeyId: e.publicKeyId,
        verified: e.verified,
        hasHandler: e.hasHandler,
        enabled: enabledSet.has(e.extensionId),
      })),
    );
  } catch (err) {
    req.log?.error?.({ err }, "ext: catalog failed");
    res.status(500).json({ error: "تعذّر تحميل كتالوج الإضافات" });
  }
});

// ── Installed (tenant-scoped) — module gate ───────────────────────────────
router.get("/installed", async (req, res) => {
  if (!requireModuleGate(req, res)) return;
  try {
    const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
    if (cid == null) {
      res.json([]);
      return;
    }
    const all = await getActiveExtensions();
    const rows = await db
      .select({ extensionId: companyExtensionsTable.extensionId, enabled: companyExtensionsTable.enabled })
      .from(companyExtensionsTable)
      .where(eq(companyExtensionsTable.companyId, cid));
    const enabledSet = new Set(rows.filter((r) => r.enabled).map((r) => r.extensionId));
    res.json(
      all
        .filter((e) => enabledSet.has(e.extensionId))
        .map((e) => ({
          extensionId: e.extensionId,
          nameAr: e.nameAr,
          nameEn: e.nameEn,
          version: e.version,
          vendor: e.vendor,
          screens: e.manifest.screens,
          tables: e.manifest.tables,
          permissions: e.manifest.permissions,
        })),
    );
  } catch (err) {
    req.log?.error?.({ err }, "ext: installed failed");
    res.status(500).json({ error: "تعذّر تحميل الإضافات المثبّتة" });
  }
});

// ── Enable / disable per company — admin/superadmin + module gate ─────────
async function setEnabled(req: Request, res: Response, enabled: boolean): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!requireModuleGate(req, res)) return;
  const extensionId = String(req.params.extId);
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (cid == null) {
    res.status(400).json({ error: "لم يتم تحديد الشركة" });
    return;
  }
  const ext = await getExtension(extensionId);
  if (!ext) {
    res.status(404).json({ error: "الإضافة غير موجودة أو غير موثّقة" });
    return;
  }
  // Entitlement gate: a PAID marketplace listing can only be enabled for a
  // company that holds an active purchase. Free extensions enable directly.
  // (SuperAdmin manages on behalf of tenants and bypasses this check.)
  if (enabled && req.authUser!.role !== "superadmin") {
    const listing = await getListingByExtensionId(extensionId);
    if (listingIsPaid(listing) && !(await hasActiveEntitlement(cid, extensionId))) {
      res.status(402).json({
        error: "هذه الإضافة مدفوعة — يجب شراؤها من المتجر أولاً",
        code: "PURCHASE_REQUIRED",
      });
      return;
    }
  }
  try {
    await db
      .insert(companyExtensionsTable)
      .values({ companyId: cid, extensionId, enabled })
      .onConflictDoUpdate({
        target: [companyExtensionsTable.companyId, companyExtensionsTable.extensionId],
        set: { enabled, updatedAt: new Date() },
      });
    res.json({ ok: true, extensionId, enabled });
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "ext: setEnabled failed");
    res.status(500).json({ error: "تعذّر تحديث حالة الإضافة" });
  }
}
router.post("/:extId/enable", (req, res) => void setEnabled(req, res, true));
router.post("/:extId/disable", (req, res) => void setEnabled(req, res, false));

// ── Sandboxed screen HTML — module gate + per-company enable ───────────────
router.get("/:extId/screen", async (req, res) => {
  if (!requireModuleGate(req, res)) return;
  const extensionId = req.params.extId;
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (!(await isEnabledForCompany(cid, extensionId))) {
    res.status(403).send("الإضافة غير مفعّلة");
    return;
  }
  const ext = await getExtension(extensionId);
  const builtin = getBuiltin(extensionId);
  if (!ext || !builtin) {
    res.status(404).send("الإضافة غير موجودة");
    return;
  }
  const screenKey = typeof req.query.screenKey === "string" ? req.query.screenKey : "home";
  const known = ext.manifest.screens.some((s) => s.key === screenKey);
  if (!known) {
    res.status(404).send("الشاشة غير موجودة");
    return;
  }
  try {
    const html = builtin.renderScreen(screenKey, ctxFrom(req));
    // The iframe is sandboxed WITHOUT allow-same-origin, so its requests carry
    // an opaque (null) origin — permit it to read these gated, tenant-scoped
    // responses. Auth is via the bearer token, not cookies.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'",
    );
    res.send(html);
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "ext: screen render failed");
    res.status(500).send("تعذّر عرض الشاشة");
  }
});

// ── Extension API namespace — module gate + per-company enable ─────────────
// Mounted as middleware so `req.params.extId` is captured and `req.path` is the
// remainder (e.g. "/ping"). Dispatches to the builtin's own handler ONLY.
router.use("/:extId/api", async (req, res) => {
  if (!requireModuleGate(req, res)) return;
  const extensionId = req.params.extId;
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (!(await isEnabledForCompany(cid, extensionId))) {
    res.status(403).json({ error: "الإضافة غير مفعّلة" });
    return;
  }
  const ext = await getExtension(extensionId);
  const builtin = getBuiltin(extensionId);
  if (!ext || !builtin) {
    res.status(404).json({ error: "الإضافة غير موجودة" });
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const sub = req.path === "" ? "/" : req.path;
    await builtin.handleApi(sub, req, res, ctxFrom(req));
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "ext: api dispatch failed");
    if (!res.headersSent) res.status(500).json({ error: "خطأ في الإضافة" });
  }
});

// Common guard for the runtime data surfaces (core + data): module gate,
// per-company enable, and a verified extension. Returns the verified extension
// + tenant context, or null after having sent the appropriate error response.
async function resolveRuntime(
  req: Request,
  res: Response,
): Promise<{ ext: NonNullable<Awaited<ReturnType<typeof getExtension>>>; ctx: ExtensionContext } | null> {
  if (!requireModuleGate(req, res)) return null;
  const extensionId = String(req.params.extId);
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (!(await isEnabledForCompany(cid, extensionId))) {
    res.status(403).json({ error: "الإضافة غير مفعّلة" });
    return null;
  }
  const ext = await getExtension(extensionId);
  if (!ext) {
    res.status(404).json({ error: "الإضافة غير موجودة" });
    return null;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  return { ext, ctx: ctxFrom(req) };
}

async function auditExt(
  req: Request,
  ctx: ExtensionContext,
  action: string,
  entityType: string,
  statusCode: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      role: req.authUser?.role ?? null,
      companyId: ctx.companyId,
      module: "extensions",
      action,
      method: req.method,
      path: req.originalUrl,
      entityType,
      statusCode,
      metadata: { extensionId: req.params.extId, ...metadata },
    });
  } catch {
    // Audit must never break the request path.
  }
}

function sendRuntimeError(res: Response, err: unknown): void {
  if (err instanceof CoreApiError || err instanceof DataStoreError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

// ── Gated CORE Data API — the ONLY path from an extension to core tables ────
// Every call is permission-checked against the SIGNED manifest, tenant-scoped,
// and audited. GET /<resource> → list; POST /<resource> → create.
router.use("/:extId/core", async (req, res) => {
  const rt = await resolveRuntime(req, res);
  if (!rt) return;
  const { ext, ctx } = rt;
  const resource = req.path.split("/").filter(Boolean)[0] ?? "";
  if (!resource) {
    res.status(400).json({ error: "EXT_CORE_RESOURCE_REQUIRED", code: "EXT_CORE_RESOURCE_REQUIRED" });
    return;
  }
  const action: CoreAction = req.method === "GET" ? "read" : "write";
  try {
    if (req.method === "GET") {
      const search = typeof req.query.search === "string" ? req.query.search : null;
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      const rows = await coreList(ext.manifest, ctx, resource, { search, limit });
      await auditExt(req, ctx, "core.read", `core:${resource}`, 200, { count: rows.length });
      res.json(rows);
      return;
    }
    if (req.method === "POST") {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const row = await coreCreate(ext.manifest, ctx, resource, body);
      await auditExt(req, ctx, "core.write", `core:${resource}`, 200, {});
      res.json(row);
      return;
    }
    res.status(405).json({ error: "EXT_METHOD_NOT_ALLOWED", code: "EXT_METHOD_NOT_ALLOWED" });
  } catch (err) {
    const status = err instanceof CoreApiError || err instanceof DataStoreError ? err.status : 500;
    const code = err instanceof CoreApiError || err instanceof DataStoreError ? err.code : undefined;
    await auditExt(req, ctx, `core.${action}.error`, `core:${resource}`, status, { code });
    req.log?.error?.({ err, extensionId: req.params.extId, resource }, "ext: core api failed");
    try {
      sendRuntimeError(res, err);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "خطأ في واجهة بيانات النواة" });
    }
  }
});

// ── Extension OWN data tables (ext_records collections) ─────────────────────
// list/get/create/update/remove, hard-scoped to (company, extension, collection)
// and limited to collections the SIGNED manifest declares.
router.use("/:extId/data", async (req, res) => {
  const rt = await resolveRuntime(req, res);
  if (!rt) return;
  const { ext, ctx } = rt;
  const extensionId = String(req.params.extId);
  const parts = req.path.split("/").filter(Boolean);
  const collection = parts[0] ?? "";
  const recordId = parts[1] ?? "";
  if (!collection) {
    res.status(400).json({ error: "EXT_COLLECTION_REQUIRED", code: "EXT_COLLECTION_REQUIRED" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    if (req.method === "GET" && !recordId) {
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      res.json(await dataList(ext.manifest, ctx, extensionId, collection, { limit }));
      return;
    }
    if (req.method === "GET") {
      res.json(await dataGet(ext.manifest, ctx, extensionId, collection, recordId));
      return;
    }
    if (req.method === "POST" && !recordId) {
      const row = await dataCreate(ext.manifest, ctx, extensionId, collection, body.data);
      await auditExt(req, ctx, "data.create", `data:${collection}`, 200, { id: row.id });
      res.json(row);
      return;
    }
    if ((req.method === "PUT" || req.method === "PATCH") && recordId) {
      const row = await dataUpdate(ext.manifest, ctx, extensionId, collection, recordId, body.data);
      await auditExt(req, ctx, "data.update", `data:${collection}`, 200, { id: recordId });
      res.json(row);
      return;
    }
    if (req.method === "DELETE" && recordId) {
      const out = await dataRemove(ext.manifest, ctx, extensionId, collection, recordId);
      await auditExt(req, ctx, "data.delete", `data:${collection}`, 200, { id: recordId });
      res.json(out);
      return;
    }
    res.status(405).json({ error: "EXT_METHOD_NOT_ALLOWED", code: "EXT_METHOD_NOT_ALLOWED" });
  } catch (err) {
    const status = err instanceof CoreApiError || err instanceof DataStoreError ? err.status : 500;
    const code = err instanceof CoreApiError || err instanceof DataStoreError ? err.code : undefined;
    await auditExt(req, ctx, "data.error", `data:${collection}`, status, { code });
    req.log?.error?.({ err, extensionId, collection }, "ext: data api failed");
    try {
      sendRuntimeError(res, err);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "خطأ في تخزين بيانات الإضافة" });
    }
  }
});

export default router;
