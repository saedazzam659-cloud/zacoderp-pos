import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  extensionListingsTable,
  extensionPurchasesTable,
  companyExtensionsTable,
  platformPartnersTable,
  companiesTable,
  EXTENSION_PRICING_MODELS,
  EXTENSION_LISTING_STATUSES,
  type ExtensionListing,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { companyAllowsModule, writeAudit } from "../middleware/permissions.js";
import { getActiveExtensions } from "../extensions/registry.js";
import {
  getListingByExtensionId,
  listingIsPaid,
  listingIsPublished,
  resolveCommissionRate,
  hasActiveEntitlement,
} from "../lib/marketplace.js";
import { accrueMarketplaceCommission, computeCommission } from "../lib/partnerCommissions.js";

// ─────────────────────────────────────────────────────────────────────────
// Marketplace — Phase 4 (المتجر والماركت بليس). 100% ADDITIVE.
//
//   tenant router  (/api/marketplace)        — module-gated storefront where a
//                  company browses published apps, purchases paid ones (billed
//                  via the platform's EXISTING internal ledger), and installs /
//                  uninstalls them per tenant (gated, default OFF).
//
//   admin router   (/api/admin/marketplace)  — SuperAdmin Control Center: the
//                  developers' listings (pricing, commission, status) + a sales
//                  & commission breakdown.
//
// A paid app cannot be enabled without an active entitlement (enforced both
// here AND in the /api/ext enable path via lib/marketplace.ts).
// ─────────────────────────────────────────────────────────────────────────

const now = () => new Date();
const period = () => { const d = new Date(); return { m: d.getMonth() + 1, y: d.getFullYear() }; };

function normalizePricingModel(v: any): (typeof EXTENSION_PRICING_MODELS)[number] {
  return EXTENSION_PRICING_MODELS.includes(v) ? v : "free";
}
function normalizeListingStatus(v: any): (typeof EXTENSION_LISTING_STATUSES)[number] {
  return EXTENSION_LISTING_STATUSES.includes(v) ? v : "draft";
}

// ═══════════════════════════════════════════════════════════════════════════
// Tenant storefront router — /api/marketplace
// ═══════════════════════════════════════════════════════════════════════════
const tenantRouter = Router();
tenantRouter.use(extractAuth);

function requireAuthed(req: Request, res: Response): boolean {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return false; }
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
// The company module gate (`extensions_platform`, default OFF). SuperAdmin bypasses.
function requireModuleGate(req: Request, res: Response): boolean {
  if (!requireAuthed(req, res)) return false;
  if (req.authUser!.role === "superadmin") return true;
  if (!companyAllowsModule(req.authUser, "extensions")) {
    res.status(403).json({ error: "وحدة الإضافات غير مفعّلة لهذه الشركة" });
    return false;
  }
  return true;
}

// ── Storefront: published listings + per-company owned/installed flags ──────
tenantRouter.get("/storefront", async (req, res) => {
  if (!requireModuleGate(req, res)) return;
  try {
    const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;

    const listings = await db
      .select()
      .from(extensionListingsTable)
      .where(eq(extensionListingsTable.status, "published"))
      .orderBy(desc(extensionListingsTable.featured), desc(extensionListingsTable.updatedAt));

    // Catalog metadata (name/version/vendor) — only active+verified extensions.
    const catalog = await getActiveExtensions();
    const catMap = new Map(catalog.map((e) => [e.extensionId, e]));

    // Per-company state.
    let enabledSet = new Set<string>();
    let ownedSet = new Set<string>();
    if (cid != null) {
      const ce = await db
        .select({ extensionId: companyExtensionsTable.extensionId, enabled: companyExtensionsTable.enabled })
        .from(companyExtensionsTable)
        .where(eq(companyExtensionsTable.companyId, cid));
      enabledSet = new Set(ce.filter((r) => r.enabled).map((r) => r.extensionId));
      const pur = await db
        .select({ extensionId: extensionPurchasesTable.extensionId })
        .from(extensionPurchasesTable)
        .where(and(eq(extensionPurchasesTable.companyId, cid), eq(extensionPurchasesTable.status, "active")));
      ownedSet = new Set(pur.map((r) => r.extensionId));
    }

    const items = listings
      .filter((l) => catMap.has(l.extensionId)) // hide listings without a loadable extension
      .map((l) => {
        const cat = catMap.get(l.extensionId)!;
        const paid = listingIsPaid(l);
        return {
          extensionId: l.extensionId,
          nameAr: cat.nameAr,
          nameEn: cat.nameEn,
          version: cat.version,
          vendor: cat.vendor,
          category: l.category,
          summaryAr: l.summaryAr,
          summaryEn: l.summaryEn,
          descriptionAr: l.descriptionAr,
          iconUrl: l.iconUrl,
          pricingModel: l.pricingModel,
          price: l.price,
          currency: l.currency,
          featured: l.featured,
          screens: cat.manifest.screens,
          permissions: cat.manifest.permissions,
          paid,
          owned: ownedSet.has(l.extensionId),
          installed: enabledSet.has(l.extensionId),
        };
      });

    res.json({ items });
  } catch (err) {
    req.log?.error?.({ err }, "marketplace: storefront failed");
    res.status(500).json({ error: "تعذّر تحميل المتجر" });
  }
});

// ── My purchases (entitlements) ────────────────────────────────────────────
tenantRouter.get("/my-purchases", async (req, res) => {
  if (!requireModuleGate(req, res)) return;
  try {
    const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
    if (cid == null) { res.json({ purchases: [] }); return; }
    const rows = await db
      .select()
      .from(extensionPurchasesTable)
      .where(eq(extensionPurchasesTable.companyId, cid))
      .orderBy(desc(extensionPurchasesTable.createdAt));
    res.json({ purchases: rows });
  } catch (err) {
    req.log?.error?.({ err }, "marketplace: my-purchases failed");
    res.status(500).json({ error: "تعذّر تحميل المشتريات" });
  }
});

// Enable / disable a company_extensions row (install state).
async function setInstalled(cid: number, extensionId: string, enabled: boolean): Promise<void> {
  await db
    .insert(companyExtensionsTable)
    .values({ companyId: cid, extensionId, enabled })
    .onConflictDoUpdate({
      target: [companyExtensionsTable.companyId, companyExtensionsTable.extensionId],
      set: { enabled, updatedAt: now() },
    });
}

// ── Purchase a paid app (creates entitlement + accrues commission + installs) ─
tenantRouter.post("/storefront/:extId/purchase", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireModuleGate(req, res)) return;
  const extensionId = String(req.params.extId);
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (cid == null) { res.status(400).json({ error: "لم يتم تحديد الشركة" }); return; }

  try {
    const listing = await getListingByExtensionId(extensionId);
    if (!listingIsPublished(listing)) {
      res.status(404).json({ error: "هذه الإضافة غير متاحة في المتجر" });
      return;
    }
    if (!listingIsPaid(listing)) {
      res.status(400).json({ error: "هذه الإضافة مجانية — استخدم التثبيت", code: "FREE_APP" });
      return;
    }
    if (await hasActiveEntitlement(cid, extensionId)) {
      res.status(409).json({ error: "الإضافة مُشتراة بالفعل", code: "ALREADY_OWNED" });
      return;
    }

    const l = listing as ExtensionListing;
    const baseAmount = Number(l.price ?? 0);
    const rate = await resolveCommissionRate(l);
    const commissionAmount = computeCommission(baseAmount, rate);
    const billingCycleEnd =
      l.pricingModel === "monthly" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

    // Record the purchase (the internal-ledger "billing" event).
    const [purchase] = await db.insert(extensionPurchasesTable).values({
      companyId: cid,
      extensionId,
      listingId: l.id,
      partnerId: l.partnerId ?? null,
      pricingModel: l.pricingModel,
      amount: baseAmount.toFixed(2),
      currency: l.currency,
      commissionRate: rate.toFixed(3),
      commissionAmount: commissionAmount.toFixed(2),
      status: "active",
      billingCycleEnd,
      purchasedBy: req.authUser?.id ?? null,
      purchasedByUsername: req.authUser?.username ?? null,
    }).returning();

    // Accrue Zacode's commission into the developer commission ledger.
    if (l.partnerId) {
      await accrueMarketplaceCommission({
        partnerId: l.partnerId,
        companyId: cid,
        extensionId,
        eventType: "app_sale",
        baseAmount,
        commissionRate: rate,
        commissionAmount,
        description: `بيع تطبيق من المتجر: ${extensionId}`,
      });
    }

    // Auto-install on purchase.
    await setInstalled(cid, extensionId, true);

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: req.authUser?.role ?? null,
      companyId: cid, module: "marketplace", action: "purchase",
      entityType: "extension", entityId: extensionId,
      metadata: { amount: baseAmount, commissionAmount, partnerId: l.partnerId ?? null },
    });

    res.status(201).json({ ok: true, purchase, installed: true });
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "marketplace: purchase failed");
    res.status(500).json({ error: "تعذّر إتمام عملية الشراء" });
  }
});

// ── Install (enable) — free apps directly; paid apps require entitlement ─────
tenantRouter.post("/storefront/:extId/install", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireModuleGate(req, res)) return;
  const extensionId = String(req.params.extId);
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (cid == null) { res.status(400).json({ error: "لم يتم تحديد الشركة" }); return; }

  try {
    const listing = await getListingByExtensionId(extensionId);
    if (!listingIsPublished(listing)) {
      res.status(404).json({ error: "هذه الإضافة غير متاحة في المتجر" });
      return;
    }
    if (listingIsPaid(listing) && !(await hasActiveEntitlement(cid, extensionId))) {
      res.status(402).json({ error: "هذه الإضافة مدفوعة — يجب شراؤها أولاً", code: "PURCHASE_REQUIRED" });
      return;
    }
    await setInstalled(cid, extensionId, true);
    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: req.authUser?.role ?? null,
      companyId: cid, module: "marketplace", action: "install",
      entityType: "extension", entityId: extensionId, metadata: {},
    });
    res.json({ ok: true, extensionId, installed: true });
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "marketplace: install failed");
    res.status(500).json({ error: "تعذّر تثبيت الإضافة" });
  }
});

// ── Uninstall (disable) — keeps the entitlement so re-install does not re-charge ─
tenantRouter.post("/storefront/:extId/uninstall", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireModuleGate(req, res)) return;
  const extensionId = String(req.params.extId);
  const cid = resolveCompanyId(req) ?? req.authUser!.companyId ?? null;
  if (cid == null) { res.status(400).json({ error: "لم يتم تحديد الشركة" }); return; }
  try {
    await setInstalled(cid, extensionId, false);
    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: req.authUser?.role ?? null,
      companyId: cid, module: "marketplace", action: "uninstall",
      entityType: "extension", entityId: extensionId, metadata: {},
    });
    res.json({ ok: true, extensionId, installed: false });
  } catch (err) {
    req.log?.error?.({ err, extensionId }, "marketplace: uninstall failed");
    res.status(500).json({ error: "تعذّر إلغاء تثبيت الإضافة" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SuperAdmin Control Center router — /api/admin/marketplace
// ═══════════════════════════════════════════════════════════════════════════
const adminRouter = Router();
adminRouter.use(extractAuth);
function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}
adminRouter.use(requireSuperAdmin);

// ── Listings + the extensions/partners needed to build a listing ────────────
adminRouter.get("/listings", async (_req, res) => {
  const listings = await db
    .select()
    .from(extensionListingsTable)
    .orderBy(desc(extensionListingsTable.updatedAt));
  const partners = await db
    .select({ id: platformPartnersTable.id, nameAr: platformPartnersTable.nameAr, partnerCode: platformPartnersTable.partnerCode, commissionRate: platformPartnersTable.commissionRate })
    .from(platformPartnersTable)
    .where(eq(platformPartnersTable.kind, "developer"));
  const partnerMap = new Map(partners.map((p) => [p.id, p]));
  const catalog = await getActiveExtensions();

  // Per-listing purchase counts (active entitlements).
  const counts = await db
    .select({ extensionId: extensionPurchasesTable.extensionId, n: sql<number>`count(*)::int` })
    .from(extensionPurchasesTable)
    .where(eq(extensionPurchasesTable.status, "active"))
    .groupBy(extensionPurchasesTable.extensionId);
  const countMap = new Map(counts.map((c) => [c.extensionId, c.n]));

  res.json({
    listings: listings.map((l) => ({
      ...l,
      partnerName: l.partnerId ? partnerMap.get(l.partnerId)?.nameAr ?? null : null,
      activeInstalls: countMap.get(l.extensionId) ?? 0,
    })),
    // Extensions in the catalog (for the "list a new extension" picker).
    extensions: catalog.map((e) => ({
      extensionId: e.extensionId, nameAr: e.nameAr, nameEn: e.nameEn, version: e.version, vendor: e.vendor,
    })),
    partners,
  });
});

// ── Create / upsert a listing (one per extension_id) ────────────────────────
adminRouter.post("/listings", async (req, res) => {
  const b = req.body ?? {};
  const extensionId = String(b.extensionId ?? "").trim();
  if (!extensionId) { res.status(400).json({ error: "معرّف الإضافة مطلوب" }); return; }

  // The extension must exist + verify in the catalog.
  const catalog = await getActiveExtensions();
  if (!catalog.some((e) => e.extensionId === extensionId)) {
    res.status(404).json({ error: "الإضافة غير موجودة أو غير موثّقة" });
    return;
  }

  const pricingModel = normalizePricingModel(b.pricingModel);
  const price = pricingModel === "free" ? 0 : Math.max(0, Number(b.price) || 0);
  const partnerId = Number.isInteger(Number(b.partnerId)) && Number(b.partnerId) > 0 ? Number(b.partnerId) : null;
  const commissionRate =
    b.commissionRate === "" || b.commissionRate == null ? null : Math.max(0, Number(b.commissionRate) || 0);

  const values = {
    extensionId,
    partnerId,
    category: b.category ? String(b.category).trim() : "other",
    summaryAr: b.summaryAr ? String(b.summaryAr).trim() : null,
    summaryEn: b.summaryEn ? String(b.summaryEn).trim() : null,
    descriptionAr: b.descriptionAr ? String(b.descriptionAr).trim() : null,
    iconUrl: b.iconUrl ? String(b.iconUrl).trim() : null,
    pricingModel,
    price: price.toFixed(2),
    currency: b.currency ? String(b.currency).trim() : "SAR",
    commissionRate: commissionRate == null ? null : commissionRate.toFixed(3),
    status: normalizeListingStatus(b.status),
    featured: b.featured === true,
  };

  const [row] = await db
    .insert(extensionListingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: extensionListingsTable.extensionId,
      set: { ...values, updatedAt: now() },
    })
    .returning();

  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "marketplace", action: "edit",
    entityType: "listing", entityId: extensionId, metadata: { pricingModel, price, status: values.status },
  });
  res.status(201).json({ ok: true, listing: row });
});

// ── Update a listing by id ──────────────────────────────────────────────────
adminRouter.put("/listings/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(extensionListingsTable).where(eq(extensionListingsTable.id, id));
  if (!existing) { res.status(404).json({ error: "القائمة غير موجودة" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };

  if (b.partnerId !== undefined)
    patch.partnerId = Number.isInteger(Number(b.partnerId)) && Number(b.partnerId) > 0 ? Number(b.partnerId) : null;
  if (b.category !== undefined) patch.category = b.category ? String(b.category).trim() : "other";
  if (b.summaryAr !== undefined) patch.summaryAr = b.summaryAr ? String(b.summaryAr).trim() : null;
  if (b.summaryEn !== undefined) patch.summaryEn = b.summaryEn ? String(b.summaryEn).trim() : null;
  if (b.descriptionAr !== undefined) patch.descriptionAr = b.descriptionAr ? String(b.descriptionAr).trim() : null;
  if (b.iconUrl !== undefined) patch.iconUrl = b.iconUrl ? String(b.iconUrl).trim() : null;
  if (b.currency !== undefined) patch.currency = b.currency ? String(b.currency).trim() : "SAR";
  if (b.status !== undefined) patch.status = normalizeListingStatus(b.status);
  if (b.featured !== undefined) patch.featured = b.featured === true;
  if (b.pricingModel !== undefined) patch.pricingModel = normalizePricingModel(b.pricingModel);
  if (b.price !== undefined || b.pricingModel !== undefined) {
    const model = patch.pricingModel ?? existing.pricingModel;
    const price = model === "free" ? 0 : Math.max(0, Number(b.price ?? existing.price) || 0);
    patch.price = price.toFixed(2);
  }
  if (b.commissionRate !== undefined) {
    patch.commissionRate =
      b.commissionRate === "" || b.commissionRate == null ? null : Math.max(0, Number(b.commissionRate) || 0).toFixed(3);
  }

  const [row] = await db.update(extensionListingsTable).set(patch).where(eq(extensionListingsTable.id, id)).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "marketplace", action: "edit",
    entityType: "listing", entityId: existing.extensionId, metadata: { fields: Object.keys(patch) },
  });
  res.json({ ok: true, listing: row });
});

// ── Delete a listing ────────────────────────────────────────────────────────
adminRouter.delete("/listings/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(extensionListingsTable).where(eq(extensionListingsTable.id, id));
  if (!existing) { res.status(404).json({ error: "القائمة غير موجودة" }); return; }
  await db.delete(extensionListingsTable).where(eq(extensionListingsTable.id, id));
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "marketplace", action: "delete",
    entityType: "listing", entityId: existing.extensionId, metadata: {},
  });
  res.json({ ok: true });
});

// ── Sales & commission breakdown (Control Center) ───────────────────────────
adminRouter.get("/sales", async (_req, res) => {
  const purchases = await db
    .select({
      id: extensionPurchasesTable.id,
      companyId: extensionPurchasesTable.companyId,
      companyName: companiesTable.nameAr,
      extensionId: extensionPurchasesTable.extensionId,
      partnerId: extensionPurchasesTable.partnerId,
      partnerName: platformPartnersTable.nameAr,
      pricingModel: extensionPurchasesTable.pricingModel,
      amount: extensionPurchasesTable.amount,
      currency: extensionPurchasesTable.currency,
      commissionRate: extensionPurchasesTable.commissionRate,
      commissionAmount: extensionPurchasesTable.commissionAmount,
      status: extensionPurchasesTable.status,
      createdAt: extensionPurchasesTable.createdAt,
    })
    .from(extensionPurchasesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, extensionPurchasesTable.companyId))
    .leftJoin(platformPartnersTable, eq(platformPartnersTable.id, extensionPurchasesTable.partnerId))
    .orderBy(desc(extensionPurchasesTable.createdAt));

  // Per-extension roll-up.
  const byExt = new Map<string, { extensionId: string; sales: number; gross: number; commission: number }>();
  let gross = 0, commission = 0;
  for (const p of purchases) {
    const amt = Number(p.amount) || 0;
    const comm = Number(p.commissionAmount) || 0;
    gross += amt; commission += comm;
    const cur = byExt.get(p.extensionId) ?? { extensionId: p.extensionId, sales: 0, gross: 0, commission: 0 };
    cur.sales += 1; cur.gross += amt; cur.commission += comm;
    byExt.set(p.extensionId, cur);
  }

  res.json({
    purchases,
    byExtension: Array.from(byExt.values()).map((r) => ({
      ...r,
      gross: r.gross.toFixed(2),
      commission: r.commission.toFixed(2),
      developerNet: (r.gross - r.commission).toFixed(2),
    })),
    totals: {
      sales: purchases.length,
      gross: gross.toFixed(2),
      commission: commission.toFixed(2),
      developerNet: (gross - commission).toFixed(2),
    },
  });
});

export { tenantRouter as marketplaceRouter, adminRouter as marketplaceAdminRouter };
