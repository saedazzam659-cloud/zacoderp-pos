// Production / Manufacturing module — orders, items, resources, events, dashboard.
//
// Multi-tenant, branch-scoped. Status transitions enforced server-side.
// Every mutation writes a row into production_events for full auditability.
import { Router } from "express";
import { db } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import {
  productionOrdersTable,
  productionOrderItemsTable,
  productionResourcesTable,
  productionEventsTable,
  warehousesTable,
  itemsTable,
  stockBalanceTable,
  accountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  bomTemplatesTable,
  bomTemplateLinesTable,
  manufacturingSettingsTable,
  workCentersTable,
  costCentersTable,
  productionRoutingsTable,
  productionRoutingStagesTable,
  productionOrderStagesTable,
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_STATUS_TRANSITIONS,
  PRODUCTION_STAGE_STATUSES,
  type ProductionOrderStatus,
  type ProductionStageStatus,
} from "@workspace/db";
import { and, asc, desc, eq, ilike, sql, or } from "drizzle-orm";
import {
  extractAuth,
  resolveCompanyId,
  branchScopeFilter,
  intersectBranchRequest,
} from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { assertWritableForDate } from "../lib/periodGuard.js";

// ─── Journal entry helper (mirrors sales.ts / purchasing.ts) ─────────────────
// Keeps production posting consistent with how invoices/vouchers post:
// header-level cost-center propagates to lines unless the line overrides it.
type JLine = {
  accountId: number | null;
  debit?: number;
  credit?: number;
  description?: string | null;
  costCenter?: string | null;
};
async function createJournalEntry(opts: {
  companyId: number;
  branchId?: number | null;
  date: string;
  description: string;
  docNumber?: string | null;
  entryType?: string;
  exchangeRate?: string | null;
  costCenter?: string | null;
  lines: JLine[];
}): Promise<number> {
  const cleanLines = opts.lines.filter(
    (l) => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0),
  );
  if (cleanLines.length < 2) {
    const rejected = opts.lines
      .map((l, i) => {
        const reasons: string[] = [];
        if (!l.accountId) reasons.push("حساب غير محدد");
        const dr = l.debit ?? 0;
        const cr = l.credit ?? 0;
        if (!(dr > 0 || cr > 0))
          reasons.push(dr < 0 || cr < 0 ? "مبلغ غير موجب" : "مبلغ صفر");
        if (!reasons.length) return null;
        const label = l.description?.trim() || `سطر ${i + 1}`;
        return `«${label}» (${reasons.join("، ")})`;
      })
      .filter(Boolean)
      .join("؛ ");
    throw new Error(
      `القيد المحاسبي يحتاج إلى طرفين على الأقل (المقبول: ${cleanLines.length}/${opts.lines.length}). ` +
        `الأسطر المرفوضة: ${rejected || "—"}. ` +
        `السبب الشائع: حسابات الإنتاج (WIP / مخزون خامات / بضاعة تامة) غير مضبوطة على أمر الإنتاج.`,
    );
  }
  const totalDebit = cleanLines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`,
    );
  }
  const writability = await assertWritableForDate(opts.companyId, opts.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  const [entry] = await db
    .insert(journalEntriesTable)
    .values({
      companyId: opts.companyId,
      branchId: opts.branchId ?? null,
      docNumber: opts.docNumber ?? null,
      entryDate: opts.date,
      currency: "SAR",
      exchangeRate: opts.exchangeRate ?? "1",
      description: opts.description,
      entryType: opts.entryType ?? "production",
      status: await resolvePostingStatus(opts.companyId, "production"),
      periodId: writability.period?.id ?? null,
    })
    .returning();
  await db.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId: entry.id,
      accountId: l.accountId!,
      debit: String((l.debit ?? 0).toFixed(2)),
      credit: String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description,
      sortOrder: i,
      costCenter: l.costCenter ?? opts.costCenter ?? null,
    })),
  );
  return entry.id;
}

// Reads the current avg cost (WAC) for an item in a warehouse. Falls back to
// the BOM line's unit cost when the item has no opening balance there yet.
async function readAvgCost(
  cid: number,
  itemId: number,
  warehouseId: number,
  fallback: number,
): Promise<number> {
  const [bal] = await db
    .select({ avgCost: stockBalanceTable.avgCost, qty: stockBalanceTable.qty })
    .from(stockBalanceTable)
    .where(
      and(
        eq(stockBalanceTable.companyId, cid),
        eq(stockBalanceTable.itemId, itemId),
        eq(stockBalanceTable.warehouseId, warehouseId),
      ),
    );
  if (!bal) return fallback;
  const c = Number(bal.avgCost);
  return c > 0 ? c : fallback;
}

// Validates that a referenced warehouse / account belongs to this tenant.
async function validateWarehouse(cid: number, id: number | null | undefined) {
  if (!id) return null;
  const [w] = await db
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(and(eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid)));
  return w ? id : null;
}

// Per-tenant account validation. Without this, a malicious payload could
// reference an accountId from a different company and post a JE against it
// (cross-tenant data leak / corruption). Mirrors validateWarehouse.
async function validateAccount(cid: number, id: number | null | undefined) {
  if (!id) return null;
  const [a] = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, id), eq(accountsTable.companyId, cid)));
  if (!a) {
    const err: any = new Error(`الحساب رقم ${id} لا ينتمي إلى هذه الشركة`);
    err.status = 400;
    throw err;
  }
  return id;
}

// PHASE B — per-tenant work-center validation. Returns the full row so
// callers can read its rates / default accounts in one round-trip.
async function loadWorkCenter(cid: number, id: number | null | undefined) {
  if (!id) return null;
  const [wc] = await db
    .select()
    .from(workCentersTable)
    .where(and(eq(workCentersTable.id, id), eq(workCentersTable.companyId, cid)));
  if (!wc) {
    const err: any = new Error(`مركز العمل رقم ${id} لا ينتمي إلى هذه الشركة`);
    err.status = 400;
    throw err;
  }
  return wc;
}

// PHASE A — per-tenant item validation for BOM lines / FG products. Same
// rationale as validateAccount: prevents storing/exposing cross-tenant
// item IDs through bom_template_lines.
async function validateItem(cid: number, id: number | null | undefined) {
  if (!id) return null;
  const [it] = await db
    .select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!it) {
    const err: any = new Error(`الصنف رقم ${id} لا ينتمي إلى هذه الشركة`);
    err.status = 400;
    throw err;
  }
  return id;
}

const router = Router();
router.use(extractAuth);
// HIGH-severity fix #1 — module-level RBAC gate so users without the
// "production" permission cannot bypass the UI by hitting these endpoints
// directly. Pairs with the PermRoute `module="production"` gate on the FE.
router.use(requireModulePermission("production"));
router.use(moduleAudit("production"));

// Helper: validates that a branch row belongs to the user's allowed scope.
// Returns true when the row's branchId is permitted, false otherwise.
// Used on every detail/mutation handler so a branch-restricted user cannot
// load or mutate rows belonging to another branch by guessing IDs.
function rowInScope(req: any, branchId: number | null | undefined): boolean {
  if (branchId == null) return true;
  const r = intersectBranchRequest(req, branchId);
  return r !== "deny";
}

function guard(req: any, res: any): number | null {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  const cid = resolveCompanyId(req, req.authUser.companyId ?? undefined);
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return cid;
}

async function writeEvent(
  cid: number,
  orderId: number | null,
  eventType: string,
  payload: Record<string, unknown>,
  userId: number | null,
  byAi = false,
) {
  await db.insert(productionEventsTable).values({
    companyId: cid,
    orderId: orderId ?? null,
    eventType,
    payload,
    userId,
    byAi,
  });
}

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ────────────────────────────────────────────────────────────────────────
// RESOURCES (machines / lines / stations)
// ────────────────────────────────────────────────────────────────────────
router.get("/resources", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchCond = branchScopeFilter(req, productionResourcesTable.branchId);
    const where = branchCond
      ? and(eq(productionResourcesTable.companyId, cid), branchCond)
      : eq(productionResourcesTable.companyId, cid);
    const rows = await db
      .select()
      .from(productionResourcesTable)
      .where(where)
      .orderBy(asc(productionResourcesTable.name));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/resources", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const { name, type, status, capacityPerHour, branchId, notes, meta } =
      req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "اسم المورد مطلوب" });
      return;
    }
    const bid = intersectBranchRequest(req, branchId ?? null);
    if (bid === "deny") {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const [row] = await db
      .insert(productionResourcesTable)
      .values({
        companyId: cid,
        branchId: typeof bid === "number" ? bid : null,
        name: name.trim(),
        type: type || "machine",
        status: status || "available",
        capacityPerHour: String(num(capacityPerHour)),
        notes: notes || null,
        meta: meta && typeof meta === "object" ? meta : {},
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/resources/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    // HIGH fix #2 — branch scope: load existing row + verify scope before mutating
    const [existing] = await db
      .select({ branchId: productionResourcesTable.branchId })
      .from(productionResourcesTable)
      .where(
        and(
          eq(productionResourcesTable.id, id),
          eq(productionResourcesTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "المورد غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const b = req.body ?? {};
    if (typeof b.name === "string") updates.name = b.name.trim();
    if (typeof b.type === "string") updates.type = b.type;
    if (typeof b.status === "string") updates.status = b.status;
    if (b.capacityPerHour !== undefined)
      updates.capacityPerHour = String(num(b.capacityPerHour));
    if (b.notes !== undefined) updates.notes = b.notes || null;
    if (b.meta !== undefined && typeof b.meta === "object")
      updates.meta = b.meta;
    const [row] = await db
      .update(productionResourcesTable)
      .set(updates)
      .where(
        and(
          eq(productionResourcesTable.id, id),
          eq(productionResourcesTable.companyId, cid),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "المورد غير موجود" });
      return;
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/resources/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    // HIGH fix #2 — branch scope verification before delete
    const [existing] = await db
      .select({ branchId: productionResourcesTable.branchId })
      .from(productionResourcesTable)
      .where(
        and(
          eq(productionResourcesTable.id, id),
          eq(productionResourcesTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "المورد غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    // Block delete if any active order is using this resource
    const [used] = await db
      .select({ id: productionOrdersTable.id })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.resourceId, id),
        ),
      )
      .limit(1);
    if (used) {
      res
        .status(400)
        .json({ error: "لا يمكن حذف مورد مرتبط بأوامر إنتاج قائمة" });
      return;
    }
    await db
      .delete(productionResourcesTable)
      .where(
        and(
          eq(productionResourcesTable.id, id),
          eq(productionResourcesTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// ORDERS
// ────────────────────────────────────────────────────────────────────────
router.get("/orders", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const branchId = req.query.branchId ? Number(req.query.branchId) : undefined;

    const conds: any[] = [eq(productionOrdersTable.companyId, cid)];
    if (status && (PRODUCTION_ORDER_STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(productionOrdersTable.status, status));
    }
    if (search) {
      conds.push(
        or(
          ilike(productionOrdersTable.orderNumber, `%${search}%`),
          ilike(productionOrdersTable.title, `%${search}%`),
        ),
      );
    }
    if (branchId) {
      const bid = intersectBranchRequest(req, branchId);
      if (bid === "deny") {
        res.json([]);
        return;
      }
      if (typeof bid === "number") conds.push(eq(productionOrdersTable.branchId, bid));
    } else {
      const branchCond = branchScopeFilter(req, productionOrdersTable.branchId);
      if (branchCond) conds.push(branchCond);
    }

    const rows = await db
      .select()
      .from(productionOrdersTable)
      .where(and(...conds))
      .orderBy(desc(productionOrdersTable.createdAt))
      .limit(500);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [order] = await db
      .select()
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      );
    if (!order) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    // HIGH fix #2 — branch scope check on detail load
    if (!rowInScope(req, order.branchId)) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    const items = await db
      .select()
      .from(productionOrderItemsTable)
      .where(eq(productionOrderItemsTable.orderId, id))
      .orderBy(asc(productionOrderItemsTable.id));
    const events = await db
      .select()
      .from(productionEventsTable)
      .where(
        and(
          eq(productionEventsTable.companyId, cid),
          eq(productionEventsTable.orderId, id),
        ),
      )
      .orderBy(desc(productionEventsTable.createdAt))
      .limit(50);
    res.json({ order, items, events });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== "string") {
      res.status(400).json({ error: "عنوان أمر الإنتاج مطلوب" });
      return;
    }
    const bid = intersectBranchRequest(req, b.branchId ?? null);
    if (bid === "deny") {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const branchIdNum = typeof bid === "number" ? bid : null;

    // HIGH fix #3 — validate that resourceId (if provided) belongs to this
    // tenant + scope. Otherwise a tenant could attach a foreign resource and
    // leak its name through the AI assist snapshot.
    let resourceIdNum: number | null = null;
    if (b.resourceId) {
      resourceIdNum = Number(b.resourceId);
      const [r] = await db
        .select({ id: productionResourcesTable.id, branchId: productionResourcesTable.branchId })
        .from(productionResourcesTable)
        .where(
          and(
            eq(productionResourcesTable.id, resourceIdNum),
            eq(productionResourcesTable.companyId, cid),
          ),
        );
      if (!r || !rowInScope(req, r.branchId)) {
        res.status(400).json({ error: "المورد غير موجود أو خارج نطاقك" });
        return;
      }
    }

    const explicitOrderNumber = typeof b.orderNumber === "string" && b.orderNumber.trim();

    // ─── PHASE A: Pull manufacturing settings defaults for this company ──
    // المعظم سيستخدم نفس المخازن/الحسابات بكل أمر، فنطبّقها تلقائياً عند
    // عدم تمريرها في body. تُمرَّر `mfg` للأسطر التي تبني insert لاحقاً.
    const [mfg] = await db
      .select()
      .from(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, cid))
      .limit(1);

    // ─── PHASE B: Optional work center auto-fill ────────────────────────
    // إذا اختار المستخدم مركز عمل + مرّر ساعات مخططة، نحسب الأجور والـOH
    // تلقائياً من معدلات المركز ونملأ حسابات الأجور/التكاليف ومركز التكلفة
    // الافتراضية للمركز عند عدم تمريرها صراحةً.
    const wc = b.workCenterId ? await loadWorkCenter(cid, Number(b.workCenterId)) : null;
    const plannedHoursNum = num(b.plannedHours);
    const wcLaborCost =
      wc && plannedHoursNum > 0 ? plannedHoursNum * Number(wc.laborRatePerHour) : null;
    const wcOverheadCost =
      wc && plannedHoursNum > 0 ? plannedHoursNum * Number(wc.overheadRatePerHour) : null;

    // MEDIUM fix #4 — retry on unique violation (companyId + orderNumber)
    // for the time-based fallback path so concurrent inserts don't 500.
    let row: any = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      let orderNumber: string;
      if (explicitOrderNumber) {
        orderNumber = explicitOrderNumber;
      } else {
        const seq = await nextSequenceNumber(cid, "production_order", {
          branchId: branchIdNum,
        }).catch(() => null);
        orderNumber =
          seq ??
          `PRD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      }
      try {
        const inserted = await db
          .insert(productionOrdersTable)
          .values({
            companyId: cid,
            branchId: branchIdNum,
            orderNumber,
            title: b.title.trim(),
            status: "draft",
            plannedQty: String(num(b.plannedQty)),
            producedQty: "0",
            wasteQty: "0",
            plannedStartDate: b.plannedStartDate || null,
            plannedEndDate: b.plannedEndDate || null,
            resourceId: resourceIdNum,
            productItemId: b.productItemId ? Number(b.productItemId) : null,
            unitCode: b.unitCode || "PCE",
            estimatedCost: String(num(b.estimatedCost)),
            actualCost: "0",
            // ─── SAP-style WIP fields (optional at create; user can fill on detail) ──
            rawWarehouseId: await validateWarehouse(cid, b.rawWarehouseId ? Number(b.rawWarehouseId) : (mfg?.defaultRawWarehouseId ?? null)),
            finishedWarehouseId: await validateWarehouse(cid, b.finishedWarehouseId ? Number(b.finishedWarehouseId) : (mfg?.defaultFinishedWarehouseId ?? null)),
            laborCost: String(
              b.laborCost !== undefined && b.laborCost !== null && b.laborCost !== ""
                ? num(b.laborCost)
                : (wcLaborCost ?? 0),
            ),
            overheadCost: String(
              b.overheadCost !== undefined && b.overheadCost !== null && b.overheadCost !== ""
                ? num(b.overheadCost)
                : (wcOverheadCost ?? 0),
            ),
            workCenterId: wc?.id ?? null,
            plannedHours: String(plannedHoursNum),
            actualHours: "0",
            costCenter:
              typeof b.costCenter === "string" && b.costCenter.trim()
                ? b.costCenter.trim()
                : (wc?.costCenterCode ?? mfg?.defaultCostCenter ?? null),
            wipAccountId: await validateAccount(cid, b.wipAccountId ? Number(b.wipAccountId) : (mfg?.defaultWipAccountId ?? null)),
            rawInventoryAccountId: await validateAccount(cid, b.rawInventoryAccountId ? Number(b.rawInventoryAccountId) : (mfg?.defaultRawInventoryAccountId ?? null)),
            finishedGoodsAccountId: await validateAccount(cid, b.finishedGoodsAccountId ? Number(b.finishedGoodsAccountId) : (mfg?.defaultFinishedGoodsAccountId ?? null)),
            laborAccountId: await validateAccount(cid, b.laborAccountId ? Number(b.laborAccountId) : (wc?.defaultLaborAccountId ?? mfg?.defaultLaborAccountId ?? null)),
            overheadAccountId: await validateAccount(cid, b.overheadAccountId ? Number(b.overheadAccountId) : (wc?.defaultOverheadAccountId ?? mfg?.defaultOverheadAccountId ?? null)),
            varianceAccountId: await validateAccount(cid, b.varianceAccountId ? Number(b.varianceAccountId) : (mfg?.defaultVarianceAccountId ?? null)),
            wasteAccountId: await validateAccount(cid, b.wasteAccountId ? Number(b.wasteAccountId) : (mfg?.defaultWasteAccountId ?? null)),
            notes: b.notes || null,
            meta: b.meta && typeof b.meta === "object" ? b.meta : {},
            createdBy: req.authUser!.id,
          })
          .returning();
        row = inserted[0];
        break;
      } catch (insertErr: any) {
        lastErr = insertErr;
        const code = insertErr?.code || insertErr?.cause?.code;
        // 23505 = unique_violation. Only retry when caller did NOT supply an
        // explicit orderNumber — otherwise the explicit value is bad and we
        // should bubble the conflict up.
        if (code !== "23505" || explicitOrderNumber) throw insertErr;
      }
    }
    if (!row) throw lastErr ?? new Error("فشل إنشاء أمر الإنتاج");

    await writeEvent(
      cid,
      row.id,
      "created",
      { orderNumber: row.orderNumber, title: row.title },
      req.authUser!.id,
    );

    // ─── PHASE A: Auto-load BOM template lines (if a template exists) ──
    // إذا كان هناك قالب BOM نشط للمنتج النهائي، ننسخ سطوره مباشرة إلى
    // أمر الإنتاج مع تكبير الكميات بنسبة (الكمية المطلوبة / مخرجات القالب).
    // Wrapped in try/catch so a transient BOM-copy failure does NOT roll
    // back the already-created order (user can re-add lines manually).
    let bomLoaded = 0;
    try {
    if (row.productItemId) {
      // Deterministic pick: most recently updated active template wins
      // when multiple are active for the same product.
      const [tmpl] = await db
        .select()
        .from(bomTemplatesTable)
        .where(
          and(
            eq(bomTemplatesTable.companyId, cid),
            eq(bomTemplatesTable.productItemId, row.productItemId),
            eq(bomTemplatesTable.isActive, true),
          ),
        )
        .orderBy(desc(bomTemplatesTable.updatedAt))
        .limit(1);
      if (tmpl) {
        const lines = await db
          .select()
          .from(bomTemplateLinesTable)
          .where(eq(bomTemplateLinesTable.templateId, tmpl.id));
        if (lines.length > 0) {
          const planned = Number(row.plannedQty) || 0;
          const output = Number(tmpl.outputQty) || 1;
          const scale = output > 0 ? planned / output : 1;
          const inserts = await Promise.all(
            lines.map(async (l) => {
              // Pull current avg cost from any warehouse for the item to
              // estimate unit cost. Fallback to 0 — accurate cost will be
              // computed on issuance from FIFO/avg of the chosen warehouse.
              let unitCost = 0;
              if (l.itemId) {
                const [bal] = await db
                  .select({ avgCost: stockBalanceTable.avgCost })
                  .from(stockBalanceTable)
                  .where(
                    and(
                      eq(stockBalanceTable.companyId, cid),
                      eq(stockBalanceTable.itemId, l.itemId),
                    ),
                  )
                  .limit(1);
                if (bal) unitCost = Number(bal.avgCost) || 0;
              }
              const qty = Number(l.quantity) * scale;
              return {
                orderId: row.id,
                kind: "raw" as const,
                itemId: l.itemId,
                description: l.description,
                quantity: String(qty),
                unitCode: l.unitCode,
                unitCost: String(unitCost),
                totalCost: String((qty * unitCost).toFixed(2)),
                meta: { fromBomTemplateId: tmpl.id } as Record<string, unknown>,
              };
            }),
          );
          await db.insert(productionOrderItemsTable).values(inserts);
          bomLoaded = inserts.length;
          await writeEvent(
            cid,
            row.id,
            "bom_loaded",
            { templateId: tmpl.id, lines: bomLoaded, scale },
            req.authUser!.id,
          );
        }
      }
    }
    } catch (bomErr: any) {
      req.log?.warn?.({ err: bomErr, orderId: row.id }, "BOM auto-load failed");
      await writeEvent(
        cid,
        row.id,
        "bom_load_failed",
        { error: bomErr?.message ?? String(bomErr) },
        req.authUser!.id,
      ).catch(() => {});
    }

    // ─── PHASE C: Auto-copy active production routing (stages) ─────
    // قالب المراحل التشغيلي. ينُسخ بكامله إلى أمر الإنتاج. أول مرحلة
    // تأخذ inputQty = plannedQty تلقائياً لتكون نقطة البداية البصرية.
    let routingLoaded = 0;
    try {
      if (row.productItemId) {
        const [routing] = await db
          .select()
          .from(productionRoutingsTable)
          .where(
            and(
              eq(productionRoutingsTable.companyId, cid),
              eq(productionRoutingsTable.productItemId, row.productItemId),
              eq(productionRoutingsTable.isActive, true),
            ),
          )
          .orderBy(desc(productionRoutingsTable.updatedAt))
          .limit(1);
        if (routing) {
          const rs = await db
            .select()
            .from(productionRoutingStagesTable)
            .where(eq(productionRoutingStagesTable.routingId, routing.id))
            .orderBy(asc(productionRoutingStagesTable.sequence));
          if (rs.length > 0) {
            await db.insert(productionOrderStagesTable).values(
              rs.map((s, idx) => ({
                orderId: row.id,
                sequence: s.sequence,
                code: s.code,
                nameAr: s.nameAr,
                nameEn: s.nameEn,
                workCenterId: s.workCenterId,
                expectedWasteRatio: s.expectedWasteRatio,
                expectedDurationMinutes: s.expectedDurationMinutes,
                icon: s.icon,
                color: s.color,
                status: "pending" as const,
                inputQty: idx === 0 ? String(num(row.plannedQty)) : "0",
                outputQty: "0",
                wasteQty: "0",
                fromRoutingId: routing.id,
              })),
            );
            routingLoaded = rs.length;
            await writeEvent(
              cid,
              row.id,
              "routing_loaded",
              { routingId: routing.id, stages: rs.length },
              req.authUser!.id,
            );
          }
        }
      }
    } catch (rErr: any) {
      req.log?.warn?.({ err: rErr, orderId: row.id }, "routing auto-copy failed");
    }

    res.status(201).json({ ...row, bomLoaded, routingLoaded });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    // HIGH fix #2 — branch scope check on PATCH
    const [existingOrder] = await db
      .select({
        branchId: productionOrdersTable.branchId,
        status: productionOrdersTable.status,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      );
    if (!existingOrder) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    if (!rowInScope(req, existingOrder.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    // HIGH fix #3 — validate resourceId ownership on update too
    if (b.resourceId !== undefined && b.resourceId !== null && b.resourceId !== "") {
      const ridNum = Number(b.resourceId);
      const [r] = await db
        .select({ id: productionResourcesTable.id, branchId: productionResourcesTable.branchId })
        .from(productionResourcesTable)
        .where(
          and(
            eq(productionResourcesTable.id, ridNum),
            eq(productionResourcesTable.companyId, cid),
          ),
        );
      if (!r || !rowInScope(req, r.branchId)) {
        res.status(400).json({ error: "المورد غير موجود أو خارج نطاقك" });
        return;
      }
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.title === "string") updates.title = b.title.trim();
    if (b.plannedQty !== undefined)
      updates.plannedQty = String(num(b.plannedQty));
    if (b.producedQty !== undefined)
      updates.producedQty = String(num(b.producedQty));
    if (b.wasteQty !== undefined) updates.wasteQty = String(num(b.wasteQty));
    if (b.plannedStartDate !== undefined)
      updates.plannedStartDate = b.plannedStartDate || null;
    if (b.plannedEndDate !== undefined)
      updates.plannedEndDate = b.plannedEndDate || null;
    if (b.resourceId !== undefined)
      updates.resourceId = b.resourceId ? Number(b.resourceId) : null;
    if (b.productItemId !== undefined)
      updates.productItemId = b.productItemId ? Number(b.productItemId) : null;
    if (typeof b.unitCode === "string") updates.unitCode = b.unitCode;
    if (b.estimatedCost !== undefined)
      updates.estimatedCost = String(num(b.estimatedCost));
    if (b.actualCost !== undefined)
      updates.actualCost = String(num(b.actualCost));
    // ─── SAP-style WIP fields (only writable while order is still pre-issue) ──
    // Once we've moved to in_production these become locked because the JE
    // accounts are already used by the issue posting; changing them would
    // make the receipt JE post against a different WIP account than the issue
    // JE — silently corrupting the WIP balance. To change them after issue,
    // user must cancel (which auto-reverses the issue) and re-do the cycle.
    const lockedAfterIssue =
      existingOrder &&
      ["in_production", "quality_check", "completed"].includes(
        (existingOrder as any).status ?? "",
      );
    if (b.rawWarehouseId !== undefined && !lockedAfterIssue)
      updates.rawWarehouseId = b.rawWarehouseId
        ? await validateWarehouse(cid, Number(b.rawWarehouseId))
        : null;
    if (b.finishedWarehouseId !== undefined && !lockedAfterIssue)
      updates.finishedWarehouseId = b.finishedWarehouseId
        ? await validateWarehouse(cid, Number(b.finishedWarehouseId))
        : null;
    if (b.laborCost !== undefined && !lockedAfterIssue)
      updates.laborCost = String(num(b.laborCost));
    if (b.overheadCost !== undefined && !lockedAfterIssue)
      updates.overheadCost = String(num(b.overheadCost));
    // costCenter is also locked after issue — the issue JE has already been
    // posted with the original costCenter; changing it now would make the
    // receipt JE post to a different cost center than the issue.
    if (b.costCenter !== undefined && !lockedAfterIssue)
      updates.costCenter =
        typeof b.costCenter === "string" && b.costCenter.trim()
          ? b.costCenter.trim()
          : null;
    if (b.wipAccountId !== undefined && !lockedAfterIssue)
      updates.wipAccountId = await validateAccount(cid, b.wipAccountId ? Number(b.wipAccountId) : null);
    if (b.rawInventoryAccountId !== undefined && !lockedAfterIssue)
      updates.rawInventoryAccountId = await validateAccount(cid, b.rawInventoryAccountId ? Number(b.rawInventoryAccountId) : null);
    if (b.finishedGoodsAccountId !== undefined)
      updates.finishedGoodsAccountId = await validateAccount(cid, b.finishedGoodsAccountId ? Number(b.finishedGoodsAccountId) : null);
    if (b.laborAccountId !== undefined && !lockedAfterIssue)
      updates.laborAccountId = await validateAccount(cid, b.laborAccountId ? Number(b.laborAccountId) : null);
    if (b.overheadAccountId !== undefined && !lockedAfterIssue)
      updates.overheadAccountId = await validateAccount(cid, b.overheadAccountId ? Number(b.overheadAccountId) : null);
    if (b.varianceAccountId !== undefined)
      updates.varianceAccountId = await validateAccount(cid, b.varianceAccountId ? Number(b.varianceAccountId) : null);
    if (b.wasteAccountId !== undefined)
      updates.wasteAccountId = await validateAccount(cid, b.wasteAccountId ? Number(b.wasteAccountId) : null);
    if (b.notes !== undefined) updates.notes = b.notes || null;
    if (b.meta !== undefined && typeof b.meta === "object") updates.meta = b.meta;

    // ─── PHASE B — work center + hours (locked after issue) ─────────────
    // عند تغيير مركز العمل أو الساعات، نعيد حساب laborCost / overheadCost
    // تلقائياً من معدلات المركز — إلا إذا مرّر المستخدم القيمة صراحةً في
    // نفس الطلب (يدوي يتفوّق على المحسوب). actualHours غير مقفلة (تُحدَّث
    // عند الإكمال) — أما workCenterId و plannedHours فمقفلتان بعد الإصدار.
    let recomputeWc: any = null;
    let recomputeHours: number | null = null;
    if (b.workCenterId !== undefined && !lockedAfterIssue) {
      const newWcId = b.workCenterId ? Number(b.workCenterId) : null;
      updates.workCenterId = newWcId;
      recomputeWc = newWcId ? await loadWorkCenter(cid, newWcId) : null;
    }
    if (b.plannedHours !== undefined && !lockedAfterIssue) {
      recomputeHours = num(b.plannedHours);
      updates.plannedHours = String(recomputeHours);
    }
    if (b.actualHours !== undefined)
      updates.actualHours = String(num(b.actualHours));
    // Auto-recompute labor/overhead when the user changed wc OR hours.
    // Each cost field is recomputed independently — a user manual override
    // on laborCost does NOT freeze overheadCost (and vice versa). When
    // plannedHours becomes 0 (or wc cleared), recomputed values are 0.
    if (
      !lockedAfterIssue &&
      (recomputeWc !== null || recomputeHours !== null)
    ) {
      // Need the *resulting* wcId + hours after this PATCH applies. Pull
      // from updates (just set above) or fall back to existing order row.
      const finalWcId =
        updates.workCenterId !== undefined
          ? (updates.workCenterId as number | null)
          : (existing.workCenterId as number | null);
      const finalHours =
        updates.plannedHours !== undefined
          ? Number(updates.plannedHours)
          : Number(existing.plannedHours ?? 0);
      const wc = finalWcId
        ? (recomputeWc?.id === finalWcId ? recomputeWc : await loadWorkCenter(cid, finalWcId))
        : null;
      const computedLabor = wc && finalHours > 0 ? finalHours * Number(wc.laborRatePerHour) : 0;
      const computedOverhead = wc && finalHours > 0 ? finalHours * Number(wc.overheadRatePerHour) : 0;
      if (b.laborCost === undefined) updates.laborCost = String(computedLabor);
      if (b.overheadCost === undefined) updates.overheadCost = String(computedOverhead);
    }

    const [row] = await db
      .update(productionOrdersTable)
      .set(updates)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    await writeEvent(cid, id, "updated", { changed: Object.keys(updates) }, req.authUser!.id);
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// SAP-style WIP status transition.
//   in_production → ISSUE: decrement raw materials from rawWarehouseId at
//     their current weighted-avg cost; post DR WIP / CR Raw Inventory
//     (+ CR Labor Accrual + CR Overhead Applied if those costs are entered).
//   completed     → RECEIPT: add producedQty to finishedWarehouseId at the
//     unit cost = WIP-balance ÷ producedQty (waste shares its proportional
//     cost which is debited to the variance/waste account); post DR Finished
//     Goods (+ DR Variance/Waste) / CR WIP for the full WIP balance.
//   cancelled (from in_production / quality_check) → REVERSE the issue:
//     restore raw materials, post a reversing JE (DR Raw / CR WIP …).
// All postings reuse the shared createJournalEntry helper so they obey the
// same period guard, cost-center propagation and balance check as invoices.
// ──────────────────────────────────────────────────────────────────────────
router.post("/orders/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const target = String(req.body?.status ?? "") as ProductionOrderStatus;
    if (!(PRODUCTION_ORDER_STATUSES as readonly string[]).includes(target)) {
      res.status(400).json({ error: "حالة غير صحيحة" });
      return;
    }
    const [order] = await db
      .select()
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      );
    if (!order) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    if (!rowInScope(req, order.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const allowed =
      PRODUCTION_STATUS_TRANSITIONS[order.status as ProductionOrderStatus] ?? [];
    if (!allowed.includes(target)) {
      res.status(400).json({
        error: `لا يمكن نقل الأمر من "${order.status}" إلى "${target}"`,
      });
      return;
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const updates: Record<string, unknown> = {
      status: target,
      updatedAt: new Date(),
    };

    // ─── 1) ISSUE — entering "in_production" ────────────────────────────────
    if (target === "in_production" && order.status !== "in_production") {
      // GUARD: idempotency — if an issue JE was already posted (e.g. concurrent
      // requests both passed the status check), refuse to post again.
      // Without this, a double-click could decrement stock + post JE twice.
      if (order.issueJournalEntryId) {
        res.status(409).json({
          error: `إذن صرف الخامات سبق ترحيله (قيد رقم ${order.issueJournalEntryId}). أعد تحميل الصفحة.`,
        });
        return;
      }
      // a) Required setup
      if (!order.rawWarehouseId) {
        res
          .status(400)
          .json({ error: "حدّد مخزن الخامات قبل بدء الإنتاج (إذن صرف الخامات)" });
        return;
      }
      if (!order.wipAccountId || !order.rawInventoryAccountId) {
        res.status(400).json({
          error:
            "حدّد حساب «إنتاج تحت التشغيل WIP» وحساب «مخزون الخامات» قبل بدء الإنتاج",
        });
        return;
      }
      const rawLines = await db
        .select()
        .from(productionOrderItemsTable)
        .where(
          and(
            eq(productionOrderItemsTable.orderId, id),
            eq(productionOrderItemsTable.kind, "raw"),
          ),
        );
      const issuableLines = rawLines.filter(
        (l) => l.itemId && Number(l.quantity) > 0,
      );
      if (issuableLines.length === 0) {
        res.status(400).json({
          error: "أمر الإنتاج لا يحتوي على سطور خامات قابلة للصرف (يجب ربطها بأصناف من المخزون)",
        });
        return;
      }

      // b) Validate stock availability up-front so we don't decrement
      //    half the lines then fail.
      for (const ln of issuableLines) {
        const have = await getBalance(cid, ln.itemId!, order.rawWarehouseId);
        const need = Number(ln.quantity);
        if (have + 1e-6 < need) {
          res.status(400).json({
            error: `الكمية المتاحة غير كافية للصنف «${ln.description}» (متاح: ${have}، مطلوب: ${need})`,
          });
          return;
        }
      }

      // c) Decrement stock + ledger entries; track total raw cost from WAC.
      let rawTotal = 0;
      for (const ln of issuableLines) {
        const qty = Number(ln.quantity);
        const cost = await readAvgCost(
          cid,
          ln.itemId!,
          order.rawWarehouseId,
          Number(ln.unitCost),
        );
        await upsertBalance(cid, ln.itemId!, order.rawWarehouseId, -qty, cost);
        const newBal = await getBalance(cid, ln.itemId!, order.rawWarehouseId);
        await addStockLedgerEntry({
          companyId: cid,
          itemId: ln.itemId!,
          warehouseId: order.rawWarehouseId,
          txDate: todayIso,
          txType: "production_issue",
          qty: String(-qty),
          costPrice: String(cost.toFixed(4)),
          totalCost: String((-qty * cost).toFixed(2)),
          balanceQty: String(newBal),
          refId: id,
          refType: "production_order",
          notes: `صرف لأمر إنتاج ${order.orderNumber}`,
        });
        rawTotal += qty * cost;
      }

      const labor = Number(order.laborCost ?? 0);
      const overhead = Number(order.overheadCost ?? 0);
      const wipDr = rawTotal + labor + overhead;

      // d) Issue JE: DR WIP / CR Raw Inv (+ CR Labor / CR Overhead).
      const issueJournalId = await createJournalEntry({
        companyId: cid,
        branchId: order.branchId,
        date: todayIso,
        docNumber: order.orderNumber,
        entryType: "production_issue",
        costCenter: order.costCenter ?? null,
        description: `إذن صرف خامات لأمر إنتاج ${order.orderNumber} — ${order.title}`,
        lines: [
          {
            accountId: order.wipAccountId,
            debit: wipDr,
            description: "إنتاج تحت التشغيل (WIP)",
          },
          {
            accountId: order.rawInventoryAccountId,
            credit: rawTotal,
            description: "مخزون خامات",
          },
          ...(labor > 0 && order.laborAccountId
            ? [
                {
                  accountId: order.laborAccountId,
                  credit: labor,
                  description: "أجور إنتاج مستحقة",
                } satisfies JLine,
              ]
            : []),
          ...(overhead > 0 && order.overheadAccountId
            ? [
                {
                  accountId: order.overheadAccountId,
                  credit: overhead,
                  description: "تكاليف صناعية غير مباشرة",
                } satisfies JLine,
              ]
            : []),
        ],
      });

      updates.rawMaterialsCost = String(rawTotal.toFixed(2));
      updates.actualCost = String(wipDr.toFixed(2));
      updates.issueJournalEntryId = issueJournalId;
      if (!order.actualStartAt) updates.actualStartAt = new Date();
    }

    // ─── 2) RECEIPT — moving to "completed" ─────────────────────────────────
    if (target === "completed" && order.status !== "completed") {
      // GUARD: idempotency — refuse if a receipt JE was already posted.
      if (order.receiptJournalEntryId) {
        res.status(409).json({
          error: `إذن إضافة البضاعة التامة سبق ترحيله (قيد رقم ${order.receiptJournalEntryId}). أعد تحميل الصفحة.`,
        });
        return;
      }
      if (!order.finishedWarehouseId) {
        res.status(400).json({ error: "حدّد مخزن البضاعة التامة قبل الإقفال" });
        return;
      }
      if (!order.productItemId) {
        res
          .status(400)
          .json({ error: "حدّد صنف المنتج النهائي على رأس أمر الإنتاج" });
        return;
      }
      if (!order.finishedGoodsAccountId) {
        res
          .status(400)
          .json({ error: "حدّد حساب «البضاعة التامة» قبل الإقفال" });
        return;
      }
      // Validate the FG item belongs to this tenant.
      const [fgItem] = await db
        .select({ id: itemsTable.id })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.id, order.productItemId),
            eq(itemsTable.companyId, cid),
          ),
        );
      if (!fgItem) {
        res
          .status(400)
          .json({ error: "صنف المنتج النهائي غير موجود في هذه الشركة" });
        return;
      }
      // Allow client to send produced/waste qty along with the transition;
      // otherwise fall back to whatever's already stored.
      const producedQty =
        req.body?.producedQty !== undefined
          ? num(req.body.producedQty)
          : Number(order.producedQty);
      const wasteQty =
        req.body?.wasteQty !== undefined
          ? num(req.body.wasteQty)
          : Number(order.wasteQty);
      if (!(producedQty > 0)) {
        res
          .status(400)
          .json({ error: "كمية المنتج المنتَج (producedQty) يجب أن تكون أكبر من صفر" });
        return;
      }
      if (!(wasteQty >= 0)) {
        res
          .status(400)
          .json({ error: "كمية الهالك (wasteQty) لا يمكن أن تكون سالبة" });
        return;
      }
      if (!(producedQty + wasteQty > 0)) {
        // Defensive — would imply a divide-by-zero in the cost allocation below.
        res.status(400).json({ error: "إجمالي مخرجات الإنتاج صفر — تحقق من الكميات" });
        return;
      }
      const wipBalance = Number(order.actualCost ?? 0);
      if (!(wipBalance > 0)) {
        res.status(400).json({
          error:
            "رصيد WIP صفر — يبدو أن إذن الصرف لم يُنفذ. أعد بدء الإنتاج لتسجيل الصرف.",
        });
        return;
      }
      // Allocate WIP cost between good output (FG) and waste pro-rata by qty.
      const totalOut = producedQty + wasteQty;
      const fgCost = wipBalance * (producedQty / totalOut);
      const wasteCost = wipBalance - fgCost;
      const fgUnitCost = fgCost / producedQty;

      // a) Increment FG stock + ledger
      await upsertBalance(
        cid,
        order.productItemId,
        order.finishedWarehouseId,
        producedQty,
        fgUnitCost,
      );
      const newBal = await getBalance(
        cid,
        order.productItemId,
        order.finishedWarehouseId,
      );
      await addStockLedgerEntry({
        companyId: cid,
        itemId: order.productItemId,
        warehouseId: order.finishedWarehouseId,
        txDate: todayIso,
        txType: "production_receipt",
        qty: String(producedQty),
        costPrice: String(fgUnitCost.toFixed(4)),
        totalCost: String(fgCost.toFixed(2)),
        balanceQty: String(newBal),
        refId: id,
        refType: "production_order",
        notes: `إذن إضافة بضاعة تامة من أمر إنتاج ${order.orderNumber}`,
      });

      // b) Receipt JE: DR FG (+ DR Waste/Variance) / CR WIP
      const wasteAcct =
        order.wasteAccountId ?? order.varianceAccountId ?? null;
      if (wasteCost > 0.005 && !wasteAcct) {
        res.status(400).json({
          error:
            "يوجد كمية هالك بدون حساب مخصص لها (Waste/Variance). حدّد الحساب أو اضبط wasteQty=0.",
        });
        return;
      }
      const receiptJournalId = await createJournalEntry({
        companyId: cid,
        branchId: order.branchId,
        date: todayIso,
        docNumber: order.orderNumber,
        entryType: "production_receipt",
        costCenter: order.costCenter ?? null,
        description: `إذن إضافة بضاعة تامة من أمر إنتاج ${order.orderNumber} — ${order.title}`,
        lines: [
          {
            accountId: order.finishedGoodsAccountId,
            debit: fgCost,
            description: "بضاعة تامة الصنع",
          },
          ...(wasteCost > 0.005
            ? [
                {
                  accountId: wasteAcct!,
                  debit: wasteCost,
                  description: "هالك / فروق إنتاج",
                } satisfies JLine,
              ]
            : []),
          {
            accountId: order.wipAccountId!,
            credit: wipBalance,
            description: "إقفال WIP",
          },
        ],
      });

      updates.producedQty = String(producedQty);
      updates.wasteQty = String(wasteQty);
      updates.receiptJournalEntryId = receiptJournalId;
      if (!order.actualEndAt) updates.actualEndAt = new Date();
    }

    // ─── 3) CANCELLATION — auto-reverse the issue if already posted ────────
    // Only reverses when there's an issue JE but NO receipt JE. If a receipt
    // already posted, cancellation is a no-op for accounting (the user would
    // need a separate manual reversing entry — completed orders can't be
    // cancelled per the transition map anyway).
    if (
      target === "cancelled" &&
      order.issueJournalEntryId &&
      !order.receiptJournalEntryId
    ) {
      // Restore raw materials we previously consumed.
      const rawLines = await db
        .select()
        .from(productionOrderItemsTable)
        .where(
          and(
            eq(productionOrderItemsTable.orderId, id),
            eq(productionOrderItemsTable.kind, "raw"),
          ),
        );
      const issuable = rawLines.filter(
        (l) => l.itemId && Number(l.quantity) > 0,
      );
      const rawTotal = Number(order.rawMaterialsCost ?? 0);
      const labor = Number(order.laborCost ?? 0);
      const overhead = Number(order.overheadCost ?? 0);
      const wipBalance = rawTotal + labor + overhead;
      for (const ln of issuable) {
        const qty = Number(ln.quantity);
        const cost = await readAvgCost(
          cid,
          ln.itemId!,
          order.rawWarehouseId!,
          Number(ln.unitCost),
        );
        await upsertBalance(cid, ln.itemId!, order.rawWarehouseId!, qty, cost);
        const newBal = await getBalance(cid, ln.itemId!, order.rawWarehouseId!);
        await addStockLedgerEntry({
          companyId: cid,
          itemId: ln.itemId!,
          warehouseId: order.rawWarehouseId!,
          txDate: todayIso,
          txType: "production_receipt", // reuses enum slot for restore-into-warehouse
          qty: String(qty),
          costPrice: String(cost.toFixed(4)),
          totalCost: String((qty * cost).toFixed(2)),
          balanceQty: String(newBal),
          refId: id,
          refType: "production_order_cancel",
          notes: `إعادة خامات بعد إلغاء أمر إنتاج ${order.orderNumber}`,
        });
      }
      // Reversing JE: DR Raw / DR Labor / DR Overhead, CR WIP — flips the issue.
      await createJournalEntry({
        companyId: cid,
        branchId: order.branchId,
        date: todayIso,
        docNumber: `${order.orderNumber}-REV`,
        entryType: "production_issue_reversal",
        costCenter: order.costCenter ?? null,
        description: `عكس إذن صرف خامات لأمر إنتاج ملغى ${order.orderNumber}`,
        lines: [
          {
            accountId: order.rawInventoryAccountId!,
            debit: rawTotal,
            description: "إعادة مخزون خامات",
          },
          ...(labor > 0 && order.laborAccountId
            ? [
                {
                  accountId: order.laborAccountId,
                  debit: labor,
                  description: "إلغاء أجور إنتاج مستحقة",
                } satisfies JLine,
              ]
            : []),
          ...(overhead > 0 && order.overheadAccountId
            ? [
                {
                  accountId: order.overheadAccountId,
                  debit: overhead,
                  description: "إلغاء تكاليف صناعية غير مباشرة",
                } satisfies JLine,
              ]
            : []),
          {
            accountId: order.wipAccountId!,
            credit: wipBalance,
            description: "إلغاء رصيد WIP",
          },
        ],
      });
      updates.rawMaterialsCost = "0";
      updates.actualCost = "0";
      updates.issueJournalEntryId = null;
    }

    const [row] = await db
      .update(productionOrdersTable)
      .set(updates)
      .where(eq(productionOrdersTable.id, id))
      .returning();
    await writeEvent(
      cid,
      id,
      target,
      {
        from: order.status,
        to: target,
        issueJournalEntryId: updates.issueJournalEntryId ?? null,
        receiptJournalEntryId: updates.receiptJournalEntryId ?? null,
        note: req.body?.note ?? null,
      },
      req.authUser!.id,
    );
    res.json(row);
  } catch (e: any) {
    const status = e?.status === 423 ? 423 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// ORDER ITEMS (raw materials / products / by-products)
// ────────────────────────────────────────────────────────────────────────
router.post("/orders/:id/items", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = Number(req.params.id);
    const [order] = await db
      .select({
        id: productionOrdersTable.id,
        branchId: productionOrdersTable.branchId,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, orderId),
          eq(productionOrdersTable.companyId, cid),
        ),
      );
    if (!order) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    // HIGH fix #2 — branch scope check before adding line
    if (!rowInScope(req, order.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const b = req.body ?? {};
    if (!b.description || typeof b.description !== "string") {
      res.status(400).json({ error: "وصف العنصر مطلوب" });
      return;
    }
    const qty = num(b.quantity);
    const unitCost = num(b.unitCost);
    const totalCost = qty * unitCost;
    const [row] = await db
      .insert(productionOrderItemsTable)
      .values({
        orderId,
        kind: b.kind || "raw",
        itemId: b.itemId ? Number(b.itemId) : null,
        description: b.description.trim(),
        quantity: String(qty),
        unitCode: b.unitCode || "PCE",
        unitCost: String(unitCost),
        totalCost: String(totalCost),
        meta: b.meta && typeof b.meta === "object" ? b.meta : {},
      })
      .returning();
    await writeEvent(
      cid,
      orderId,
      "item_added",
      { kind: row.kind, description: row.description, quantity: qty },
      req.authUser!.id,
    );
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/orders/:id/items/:lineId", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = Number(req.params.id);
    const lineId = Number(req.params.lineId);
    // Verify the line belongs to an order owned by this tenant
    // HIGH fix #2 — also pull branchId for scope check
    const [line] = await db
      .select({
        id: productionOrderItemsTable.id,
        orderId: productionOrderItemsTable.orderId,
        branchId: productionOrdersTable.branchId,
      })
      .from(productionOrderItemsTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionOrderItemsTable.orderId, productionOrdersTable.id),
      )
      .where(
        and(
          eq(productionOrderItemsTable.id, lineId),
          eq(productionOrdersTable.id, orderId),
          eq(productionOrdersTable.companyId, cid),
        ),
      );
    if (!line) {
      res.status(404).json({ error: "العنصر غير موجود" });
      return;
    }
    if (!rowInScope(req, line.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    await db
      .delete(productionOrderItemsTable)
      .where(eq(productionOrderItemsTable.id, lineId));
    await writeEvent(
      cid,
      orderId,
      "item_removed",
      { lineId },
      req.authUser!.id,
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// DASHBOARD KPIs
// ────────────────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchCond = branchScopeFilter(req, productionOrdersTable.branchId);
    const baseWhere = branchCond
      ? and(eq(productionOrdersTable.companyId, cid), branchCond)
      : eq(productionOrdersTable.companyId, cid);

    const counts = await db
      .select({
        status: productionOrdersTable.status,
        count: sql<number>`count(*)::int`,
        plannedSum: sql<string>`coalesce(sum(${productionOrdersTable.plannedQty}), 0)::text`,
        producedSum: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}), 0)::text`,
        wasteSum: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}), 0)::text`,
        costSum: sql<string>`coalesce(sum(${productionOrdersTable.actualCost}), 0)::text`,
      })
      .from(productionOrdersTable)
      .where(baseWhere)
      .groupBy(productionOrdersTable.status);

    const byStatus: Record<string, number> = {};
    let totalOrders = 0;
    let totalPlanned = 0;
    let totalProduced = 0;
    let totalWaste = 0;
    let totalCost = 0;
    for (const r of counts) {
      byStatus[r.status] = r.count;
      totalOrders += r.count;
      totalPlanned += Number(r.plannedSum);
      totalProduced += Number(r.producedSum);
      totalWaste += Number(r.wasteSum);
      totalCost += Number(r.costSum);
    }
    const completionRate =
      totalPlanned > 0 ? (totalProduced / totalPlanned) * 100 : 0;
    const wasteRate =
      totalProduced + totalWaste > 0
        ? (totalWaste / (totalProduced + totalWaste)) * 100
        : 0;

    // Resources util
    const resCond = branchScopeFilter(req, productionResourcesTable.branchId);
    const resWhere = resCond
      ? and(eq(productionResourcesTable.companyId, cid), resCond)
      : eq(productionResourcesTable.companyId, cid);
    const resRows = await db
      .select({
        status: productionResourcesTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(productionResourcesTable)
      .where(resWhere)
      .groupBy(productionResourcesTable.status);
    const resourcesByStatus: Record<string, number> = {};
    let totalResources = 0;
    for (const r of resRows) {
      resourcesByStatus[r.status] = r.count;
      totalResources += r.count;
    }
    const machineUtilization =
      totalResources > 0
        ? ((resourcesByStatus["busy"] ?? 0) / totalResources) * 100
        : 0;

    res.json({
      totalOrders,
      byStatus,
      totalPlanned,
      totalProduced,
      totalWaste,
      totalCost,
      completionRate: Number(completionRate.toFixed(2)),
      wasteRate: Number(wasteRate.toFixed(2)),
      totalResources,
      resourcesByStatus,
      machineUtilization: Number(machineUtilization.toFixed(2)),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE A — Manufacturing Settings (per-company defaults)
// ═══════════════════════════════════════════════════════════════════════════

// AI helper — given the company's chart of accounts, suggests the best
// matching account for each of the 7 manufacturing GL roles. Returns IDs
// (no auto-save: the UI applies them, user reviews & saves).
router.post("/manufacturing-settings/ai-suggest", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير متاحة" });
      return;
    }
    // Pull only postable, active accounts + active warehouses + posting cost centers; cap to keep prompt small.
    const [accounts, warehousesRows, costCentersRows] = await Promise.all([
      db.select({
        id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
        accountType: accountsTable.accountType, isPosting: accountsTable.isPosting, isActive: accountsTable.isActive,
      }).from(accountsTable).where(eq(accountsTable.companyId, cid)).orderBy(asc(accountsTable.code)),
      db.select({
        id: warehousesTable.id, code: warehousesTable.code, nameAr: warehousesTable.nameAr,
        nameEn: warehousesTable.nameEn, isActive: warehousesTable.isActive,
      }).from(warehousesTable).where(eq(warehousesTable.companyId, cid)).orderBy(asc(warehousesTable.code)),
      db.select({
        id: costCentersTable.id, code: costCentersTable.code, nameAr: costCentersTable.nameAr,
        nameEn: costCentersTable.nameEn, isActive: costCentersTable.isActive, isPosting: costCentersTable.isPosting,
      }).from(costCentersTable).where(eq(costCentersTable.companyId, cid)).orderBy(asc(costCentersTable.code)),
    ]);
    const candidates = accounts.filter((a) => a.isActive && a.isPosting).slice(0, 400);
    if (candidates.length === 0) {
      res.status(400).json({ error: "لا توجد حسابات قابلة للترحيل" });
      return;
    }
    const whCandidates = warehousesRows.filter((w) => w.isActive).slice(0, 100);
    const ccCandidates = costCentersRows.filter((c) => c.isActive && c.isPosting).slice(0, 100);
    const fmtName = (ar: string, en: string | null) => en ? ar + " / " + en : ar;
    const list = candidates.map((a) => a.id + "|" + a.code + "|" + a.accountType + "|" + fmtName(a.nameAr, a.nameEn)).join("\n");
    const whList = whCandidates.length
      ? whCandidates.map((w) => w.id + "|" + w.code + "|" + fmtName(w.nameAr, w.nameEn)).join("\n")
      : "(لا توجد مخازن)";
    const ccList = ccCandidates.length
      ? ccCandidates.map((c) => c.code + "|" + fmtName(c.nameAr, c.nameEn)).join("\n")
      : "(لا توجد مراكز تكلفة)";

    const ROLES: Array<{ key: string; label: string; hint: string }> = [
      { key: "defaultWipAccountId",            label: "WIP — Work In Process",  hint: "أصل: إنتاج تحت التشغيل / بضاعة قيد الصنع" },
      { key: "defaultRawInventoryAccountId",   label: "Raw Materials Inventory", hint: "أصل: مخزون خامات / مواد أولية" },
      { key: "defaultFinishedGoodsAccountId",  label: "Finished Goods Inventory",hint: "أصل: مخزون البضاعة التامة / المنتجات الجاهزة" },
      { key: "defaultLaborAccountId",          label: "Direct Labor",            hint: "مصروف: أجور إنتاج مباشرة" },
      { key: "defaultOverheadAccountId",       label: "Manufacturing Overhead",  hint: "مصروف: تكاليف صناعية غير مباشرة" },
      { key: "defaultVarianceAccountId",       label: "Production Variance",     hint: "مصروف/إيراد: فروق تكلفة الإنتاج" },
      { key: "defaultWasteAccountId",          label: "Production Waste / Scrap",hint: "مصروف: هالك / فاقد إنتاج" },
    ];

    const systemPrompt = `أنت مستشار محاسبي خبير في ERP صناعي بالسعودية. ستحصل على دليل حسابات الشركة وقائمة بسبعة أدوار محاسبية للإنتاج. اختر أنسب حساب id من القائمة لكل دور. قواعد:
- يجب أن يكون الـid من القائمة الفعلية المُعطاة (لا تخترع).
- WIP/خامات/تامة يجب أن تكون نوع asset.
- الأجور/الصناعية غير المباشرة/الفروق/الهالك يجب أن تكون نوع expense.
- إن لم يوجد حساب مناسب لدور ما، أعد null لذلك الدور.
- يمكن أن يتكرر نفس الـid في أكثر من دور إن كان مناسباً (نادر).
- بالإضافة للحسابات، اختر أيضاً: مخزن الخامات (id من قائمة المخازن)، مخزن البضاعة التامة (id من قائمة المخازن)، ومركز التكلفة الافتراضي (code نصي من قائمة مراكز التكلفة) — اختر ما يدل على الإنتاج/التصنيع/المصنع، وأعد null إن لم يوجد مرشح ملائم.
ردّ بصيغة JSON فقط بهذا الشكل:
{
  "defaultWipAccountId":            { "id": <number|null>, "reason": "<سبب قصير بالعربية>" },
  "defaultRawInventoryAccountId":   { "id": <number|null>, "reason": "..." },
  "defaultFinishedGoodsAccountId":  { "id": <number|null>, "reason": "..." },
  "defaultLaborAccountId":          { "id": <number|null>, "reason": "..." },
  "defaultOverheadAccountId":       { "id": <number|null>, "reason": "..." },
  "defaultVarianceAccountId":       { "id": <number|null>, "reason": "..." },
  "defaultWasteAccountId":          { "id": <number|null>, "reason": "..." },
  "defaultRawWarehouseId":          { "id": <number|null>, "reason": "..." },
  "defaultFinishedWarehouseId":     { "id": <number|null>, "reason": "..." },
  "defaultCostCenter":              { "code": <string|null>, "reason": "..." }
}`;

    const userMsg =
      "الأدوار المحاسبية المطلوبة:\n" +
      ROLES.map((r) => "- " + r.key + " → " + r.label + " (" + r.hint + ")").join("\n") +
      "\n\nدليل الحسابات (id|code|type|name):\n" + list +
      "\n\nالمخازن (id|code|name):\n" + whList +
      "\n\nمراكز التكلفة (code|name):\n" + ccList;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res
        .status(502)
        .json({ error: `فشل الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data: any = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      /* ignore */
    }
    // Validate every suggested id is actually one of our candidates (security
    // + safety). Drop any hallucinated id.
    const validIds = new Set(candidates.map((c) => c.id));
    const validWhIds = new Set(whCandidates.map((w) => w.id));
    const validCcCodes = new Set(ccCandidates.map((c) => c.code));
    const out: Record<string, { id: number | null; code?: string | null; reason: string; account?: any; warehouse?: any; costCenter?: any }> = {};
    for (const role of ROLES) {
      const v = parsed?.[role.key] ?? {};
      const id = Number.isFinite(Number(v?.id)) ? Number(v.id) : null;
      const okId = id && validIds.has(id) ? id : null;
      const acc = okId ? candidates.find((c) => c.id === okId) : undefined;
      out[role.key] = {
        id: okId,
        reason: String(v?.reason ?? ""),
        account: acc
          ? { id: acc.id, code: acc.code, nameAr: acc.nameAr, accountType: acc.accountType }
          : undefined,
      };
    }
    // Warehouses
    for (const whKey of ["defaultRawWarehouseId", "defaultFinishedWarehouseId"] as const) {
      const v = parsed?.[whKey] ?? {};
      const id = Number.isFinite(Number(v?.id)) ? Number(v.id) : null;
      const okId = id && validWhIds.has(id) ? id : null;
      const wh = okId ? whCandidates.find((w) => w.id === okId) : undefined;
      out[whKey] = {
        id: okId,
        reason: String(v?.reason ?? ""),
        warehouse: wh ? { id: wh.id, code: wh.code, nameAr: wh.nameAr } : undefined,
      };
    }
    // Cost center (by code)
    {
      const v = parsed?.defaultCostCenter ?? {};
      const code = typeof v?.code === "string" && v.code.trim() ? v.code.trim() : null;
      const okCode = code && validCcCodes.has(code) ? code : null;
      const cc = okCode ? ccCandidates.find((c) => c.code === okCode) : undefined;
      out.defaultCostCenter = {
        id: null,
        code: okCode,
        reason: String(v?.reason ?? ""),
        costCenter: cc ? { code: cc.code, nameAr: cc.nameAr } : undefined,
      };
    }
    res.json({ suggestions: out, source: "ai" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/manufacturing-settings", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const [row] = await db
      .select()
      .from(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, cid))
      .limit(1);
    res.json(row ?? null);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/manufacturing-settings", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const numOrNull = (v: any) =>
      v === null || v === undefined || v === "" ? null : Number(v);
    const payload = {
      companyId: cid,
      defaultRawWarehouseId: await validateWarehouse(cid, numOrNull(b.defaultRawWarehouseId)),
      defaultFinishedWarehouseId: await validateWarehouse(cid, numOrNull(b.defaultFinishedWarehouseId)),
      defaultCostCenter:
        typeof b.defaultCostCenter === "string" && b.defaultCostCenter.trim()
          ? b.defaultCostCenter.trim()
          : null,
      defaultWipAccountId: await validateAccount(cid, numOrNull(b.defaultWipAccountId)),
      defaultRawInventoryAccountId: await validateAccount(cid, numOrNull(b.defaultRawInventoryAccountId)),
      defaultFinishedGoodsAccountId: await validateAccount(cid, numOrNull(b.defaultFinishedGoodsAccountId)),
      defaultLaborAccountId: await validateAccount(cid, numOrNull(b.defaultLaborAccountId)),
      defaultOverheadAccountId: await validateAccount(cid, numOrNull(b.defaultOverheadAccountId)),
      defaultVarianceAccountId: await validateAccount(cid, numOrNull(b.defaultVarianceAccountId)),
      defaultWasteAccountId: await validateAccount(cid, numOrNull(b.defaultWasteAccountId)),
      updatedAt: new Date(),
    };
    // True upsert keyed on the unique companyId index, so concurrent first
    // writes from two requests cannot collide on mfg_settings_company_uniq.
    const { companyId: _omit, ...updateSet } = payload;
    const [row] = await db
      .insert(manufacturingSettingsTable)
      .values(payload)
      .onConflictDoUpdate({
        target: manufacturingSettingsTable.companyId,
        set: updateSet,
      })
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE B — Work Centers (مراكز العمل)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/work-centers", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const q = (req.query.q as string | undefined)?.trim();
    const onlyActive = req.query.activeOnly === "1";
    const conds = [eq(workCentersTable.companyId, cid)];
    if (q)
      conds.push(
        or(
          ilike(workCentersTable.code, `%${q}%`),
          ilike(workCentersTable.nameAr, `%${q}%`),
          ilike(workCentersTable.nameEn, `%${q}%`),
        )!,
      );
    if (onlyActive) conds.push(eq(workCentersTable.isActive, true));
    const rows = await db
      .select()
      .from(workCentersTable)
      .where(and(...conds))
      .orderBy(asc(workCentersTable.code))
      .limit(500);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/work-centers/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const wc = await loadWorkCenter(cid, id);
    if (!wc) {
      res.status(404).json({ error: "مركز العمل غير موجود" });
      return;
    }
    res.json(wc);
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post("/work-centers", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const code = typeof b.code === "string" ? b.code.trim() : "";
    const nameAr = typeof b.nameAr === "string" ? b.nameAr.trim() : "";
    if (!code) {
      res.status(400).json({ error: "كود مركز العمل مطلوب" });
      return;
    }
    if (!nameAr) {
      res.status(400).json({ error: "اسم مركز العمل بالعربية مطلوب" });
      return;
    }
    const laborRate = num(b.laborRatePerHour);
    const overheadRate = num(b.overheadRatePerHour);
    const capHours = num(b.capacityHoursPerDay, 8);
    if (laborRate < 0 || overheadRate < 0 || capHours <= 0) {
      res.status(400).json({
        error: "المعدلات يجب أن تكون ≥ 0 وطاقة العمل اليومية > 0",
      });
      return;
    }
    try {
      const [row] = await db
        .insert(workCentersTable)
        .values({
          companyId: cid,
          code,
          nameAr,
          nameEn: typeof b.nameEn === "string" && b.nameEn.trim() ? b.nameEn.trim() : null,
          costCenterCode:
            typeof b.costCenterCode === "string" && b.costCenterCode.trim()
              ? b.costCenterCode.trim()
              : null,
          laborRatePerHour: String(laborRate),
          overheadRatePerHour: String(overheadRate),
          capacityHoursPerDay: String(capHours),
          defaultLaborAccountId: await validateAccount(
            cid,
            b.defaultLaborAccountId ? Number(b.defaultLaborAccountId) : null,
          ),
          defaultOverheadAccountId: await validateAccount(
            cid,
            b.defaultOverheadAccountId ? Number(b.defaultOverheadAccountId) : null,
          ),
          isActive: b.isActive === false ? false : true,
          notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
        })
        .returning();
      res.status(201).json(row);
    } catch (insertErr: any) {
      const code2 = insertErr?.code || insertErr?.cause?.code;
      if (code2 === "23505") {
        res.status(409).json({ error: `كود مركز العمل "${code}" مستخدم مسبقاً` });
        return;
      }
      throw insertErr;
    }
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.patch("/work-centers/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const existing = await loadWorkCenter(cid, id);
    if (!existing) {
      res.status(404).json({ error: "مركز العمل غير موجود" });
      return;
    }
    const b = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.code === "string" && b.code.trim()) updates.code = b.code.trim();
    if (typeof b.nameAr === "string" && b.nameAr.trim()) updates.nameAr = b.nameAr.trim();
    if (b.nameEn !== undefined)
      updates.nameEn = typeof b.nameEn === "string" && b.nameEn.trim() ? b.nameEn.trim() : null;
    if (b.costCenterCode !== undefined)
      updates.costCenterCode =
        typeof b.costCenterCode === "string" && b.costCenterCode.trim()
          ? b.costCenterCode.trim()
          : null;
    if (b.laborRatePerHour !== undefined) {
      const v = num(b.laborRatePerHour);
      if (v < 0) {
        res.status(400).json({ error: "معدل الأجور يجب أن يكون ≥ 0" });
        return;
      }
      updates.laborRatePerHour = String(v);
    }
    if (b.overheadRatePerHour !== undefined) {
      const v = num(b.overheadRatePerHour);
      if (v < 0) {
        res.status(400).json({ error: "معدل التكاليف غير المباشرة يجب أن يكون ≥ 0" });
        return;
      }
      updates.overheadRatePerHour = String(v);
    }
    if (b.capacityHoursPerDay !== undefined) {
      const v = num(b.capacityHoursPerDay);
      if (v <= 0) {
        res.status(400).json({ error: "طاقة العمل اليومية يجب أن تكون > 0" });
        return;
      }
      updates.capacityHoursPerDay = String(v);
    }
    if (b.defaultLaborAccountId !== undefined)
      updates.defaultLaborAccountId = await validateAccount(
        cid,
        b.defaultLaborAccountId ? Number(b.defaultLaborAccountId) : null,
      );
    if (b.defaultOverheadAccountId !== undefined)
      updates.defaultOverheadAccountId = await validateAccount(
        cid,
        b.defaultOverheadAccountId ? Number(b.defaultOverheadAccountId) : null,
      );
    if (b.isActive !== undefined) updates.isActive = !!b.isActive;
    if (b.notes !== undefined)
      updates.notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
    try {
      const [row] = await db
        .update(workCentersTable)
        .set(updates)
        .where(and(eq(workCentersTable.id, id), eq(workCentersTable.companyId, cid)))
        .returning();
      res.json(row);
    } catch (updateErr: any) {
      const code2 = updateErr?.code || updateErr?.cause?.code;
      if (code2 === "23505") {
        res.status(409).json({ error: "كود مركز العمل مستخدم مسبقاً" });
        return;
      }
      throw updateErr;
    }
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete("/work-centers/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const existing = await loadWorkCenter(cid, id);
    if (!existing) {
      res.status(404).json({ error: "مركز العمل غير موجود" });
      return;
    }
    // Refuse delete if any production order references it (preserve history).
    // The user can deactivate instead via PATCH { isActive: false }.
    const [used] = await db
      .select({ id: productionOrdersTable.id })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.workCenterId, id),
        ),
      )
      .limit(1);
    if (used) {
      res.status(409).json({
        error:
          "لا يمكن حذف مركز عمل مرتبط بأوامر إنتاج سابقة. عطّله بدلاً من الحذف.",
      });
      return;
    }
    await db
      .delete(workCentersTable)
      .where(and(eq(workCentersTable.id, id), eq(workCentersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE A — BOM Templates
// ═══════════════════════════════════════════════════════════════════════════

router.get("/bom-templates", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const q = (req.query.q as string | undefined)?.trim();
    const where = q
      ? and(
          eq(bomTemplatesTable.companyId, cid),
          or(
            ilike(bomTemplatesTable.nameAr, `%${q}%`),
            ilike(bomTemplatesTable.nameEn, `%${q}%`),
          ),
        )
      : eq(bomTemplatesTable.companyId, cid);
    const rows = await db
      .select({
        id: bomTemplatesTable.id,
        productItemId: bomTemplatesTable.productItemId,
        nameAr: bomTemplatesTable.nameAr,
        nameEn: bomTemplatesTable.nameEn,
        outputQty: bomTemplatesTable.outputQty,
        outputUnitCode: bomTemplatesTable.outputUnitCode,
        isActive: bomTemplatesTable.isActive,
        notes: bomTemplatesTable.notes,
        updatedAt: bomTemplatesTable.updatedAt,
        productNameAr: itemsTable.nameAr,
        productNameEn: itemsTable.nameEn,
        linesCount: sql<number>`(SELECT COUNT(*)::int FROM ${bomTemplateLinesTable} WHERE ${bomTemplateLinesTable.templateId} = ${bomTemplatesTable.id})`,
      })
      .from(bomTemplatesTable)
      .leftJoin(itemsTable, eq(itemsTable.id, bomTemplatesTable.productItemId))
      .where(where)
      .orderBy(desc(bomTemplatesTable.updatedAt));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/bom-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [tmpl] = await db
      .select()
      .from(bomTemplatesTable)
      .where(
        and(
          eq(bomTemplatesTable.id, id),
          eq(bomTemplatesTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!tmpl) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    // SECURITY: join items with companyId predicate so a stale/cross-tenant
    // item_id (defense in depth) cannot leak nameAr/nameEn from another
    // company. New writes are blocked by validateItem; this protects reads.
    const lines = await db
      .select({
        id: bomTemplateLinesTable.id,
        itemId: bomTemplateLinesTable.itemId,
        description: bomTemplateLinesTable.description,
        quantity: bomTemplateLinesTable.quantity,
        unitCode: bomTemplateLinesTable.unitCode,
        notes: bomTemplateLinesTable.notes,
        itemNameAr: itemsTable.nameAr,
        itemNameEn: itemsTable.nameEn,
      })
      .from(bomTemplateLinesTable)
      .leftJoin(
        itemsTable,
        and(
          eq(itemsTable.id, bomTemplateLinesTable.itemId),
          eq(itemsTable.companyId, cid),
        ),
      )
      .where(eq(bomTemplateLinesTable.templateId, id));
    res.json({ ...tmpl, lines });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.post("/bom-templates", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    if (!b.productItemId) {
      res.status(400).json({ error: "المنتج النهائي مطلوب" });
      return;
    }
    if (!b.nameAr || typeof b.nameAr !== "string") {
      res.status(400).json({ error: "اسم القالب مطلوب" });
      return;
    }
    const outputQty = Number(b.outputQty) || 1;
    if (outputQty <= 0) {
      res.status(400).json({ error: "الكمية الناتجة يجب أن تكون أكبر من صفر" });
      return;
    }
    // Validate product belongs to tenant (throws 400 if not)
    await validateItem(cid, Number(b.productItemId));
    // Pre-validate every line.itemId against this tenant BEFORE any insert,
    // so a foreign id cannot land in bom_template_lines (security).
    const rawLines = Array.isArray(b.lines)
      ? b.lines.filter((l: any) => l && l.description)
      : [];
    const lineInserts: any[] = [];
    for (const l of rawLines) {
      const qty = Number(l.quantity) || 0;
      if (qty <= 0) {
        res.status(400).json({ error: "كمية كل مكوّن يجب أن تكون أكبر من صفر" });
        return;
      }
      const itemId = l.itemId ? Number(l.itemId) : null;
      if (itemId) await validateItem(cid, itemId);
      lineInserts.push({
        itemId,
        description: String(l.description).trim(),
        quantity: String(qty),
        unitCode: l.unitCode || "PCE",
        notes:
          typeof l.notes === "string" && l.notes.trim() ? l.notes.trim() : null,
      });
    }
    // Single transaction: header + lines so a partial create is impossible.
    const tmpl = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(bomTemplatesTable)
        .values({
          companyId: cid,
          productItemId: Number(b.productItemId),
          nameAr: b.nameAr.trim(),
          nameEn:
            typeof b.nameEn === "string" && b.nameEn.trim() ? b.nameEn.trim() : null,
          outputQty: String(outputQty),
          outputUnitCode: b.outputUnitCode || "PCE",
          isActive: b.isActive !== false,
          notes:
            typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
        })
        .returning();
      if (lineInserts.length > 0) {
        await tx
          .insert(bomTemplateLinesTable)
          .values(lineInserts.map((li) => ({ ...li, templateId: t.id })));
      }
      return t;
    });
    res.status(201).json(tmpl);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.patch("/bom-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [existing] = await db
      .select({ id: bomTemplatesTable.id })
      .from(bomTemplatesTable)
      .where(
        and(
          eq(bomTemplatesTable.id, id),
          eq(bomTemplatesTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    const patch: any = { updatedAt: new Date() };
    if (typeof b.nameAr === "string" && b.nameAr.trim()) patch.nameAr = b.nameAr.trim();
    if (b.nameEn !== undefined) patch.nameEn = b.nameEn || null;
    if (b.outputQty !== undefined) {
      const oq = Number(b.outputQty) || 1;
      if (oq <= 0) {
        res.status(400).json({ error: "الكمية الناتجة يجب أن تكون أكبر من صفر" });
        return;
      }
      patch.outputQty = String(oq);
    }
    if (b.outputUnitCode !== undefined) patch.outputUnitCode = b.outputUnitCode || "PCE";
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    if (b.notes !== undefined) patch.notes = b.notes || null;
    const [row] = await db
      .update(bomTemplatesTable)
      .set(patch)
      .where(eq(bomTemplatesTable.id, id))
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/bom-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const result = await db
      .delete(bomTemplatesTable)
      .where(
        and(
          eq(bomTemplatesTable.id, id),
          eq(bomTemplatesTable.companyId, cid),
        ),
      )
      .returning({ id: bomTemplatesTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Replace all lines (simpler than partial line CRUD for the UI). All
// itemIds are pre-validated against this tenant, then delete + insert run
// inside a single transaction so a failure cannot leave the template empty.
router.put("/bom-templates/:id/lines", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (!Array.isArray(b.lines)) {
      res.status(400).json({ error: "lines يجب أن يكون مصفوفة" });
      return;
    }
    const [existing] = await db
      .select({ id: bomTemplatesTable.id })
      .from(bomTemplatesTable)
      .where(
        and(
          eq(bomTemplatesTable.id, id),
          eq(bomTemplatesTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    const inserts: any[] = [];
    for (const l of b.lines) {
      if (!l || !l.description) continue;
      const qty = Number(l.quantity) || 0;
      if (qty <= 0) {
        res.status(400).json({ error: "كمية كل مكوّن يجب أن تكون أكبر من صفر" });
        return;
      }
      const itemId = l.itemId ? Number(l.itemId) : null;
      if (itemId) await validateItem(cid, itemId);
      inserts.push({
        templateId: id,
        itemId,
        description: String(l.description).trim(),
        quantity: String(qty),
        unitCode: l.unitCode || "PCE",
        notes:
          typeof l.notes === "string" && l.notes.trim() ? l.notes.trim() : null,
      });
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(bomTemplateLinesTable)
        .where(eq(bomTemplateLinesTable.templateId, id));
      if (inserts.length > 0) {
        await tx.insert(bomTemplateLinesTable).values(inserts);
      }
      await tx
        .update(bomTemplatesTable)
        .set({ updatedAt: new Date() })
        .where(eq(bomTemplatesTable.id, id));
    });
    res.json({ ok: true, count: inserts.length });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// PHASE C — Production Routings (قوالب مراحل الإنتاج)
// ────────────────────────────────────────────────────────────────────────

router.get("/routings", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const q = String(req.query.q ?? "").trim();
    const where = q
      ? and(
          eq(productionRoutingsTable.companyId, cid),
          or(
            ilike(productionRoutingsTable.nameAr, `%${q}%`),
            ilike(productionRoutingsTable.nameEn, `%${q}%`),
          ),
        )
      : eq(productionRoutingsTable.companyId, cid);
    const rows = await db
      .select({
        id: productionRoutingsTable.id,
        productItemId: productionRoutingsTable.productItemId,
        productNameAr: itemsTable.nameAr,
        productNameEn: itemsTable.nameEn,
        nameAr: productionRoutingsTable.nameAr,
        nameEn: productionRoutingsTable.nameEn,
        isActive: productionRoutingsTable.isActive,
        notes: productionRoutingsTable.notes,
        updatedAt: productionRoutingsTable.updatedAt,
        stagesCount: sql<number>`(SELECT COUNT(*)::int FROM ${productionRoutingStagesTable} WHERE ${productionRoutingStagesTable.routingId} = ${productionRoutingsTable.id})`,
      })
      .from(productionRoutingsTable)
      .leftJoin(itemsTable, eq(itemsTable.id, productionRoutingsTable.productItemId))
      .where(where)
      .orderBy(desc(productionRoutingsTable.updatedAt));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/routings/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [r] = await db
      .select()
      .from(productionRoutingsTable)
      .where(
        and(
          eq(productionRoutingsTable.id, id),
          eq(productionRoutingsTable.companyId, cid),
        ),
      );
    if (!r) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    const stages = await db
      .select()
      .from(productionRoutingStagesTable)
      .where(eq(productionRoutingStagesTable.routingId, id))
      .orderBy(asc(productionRoutingStagesTable.sequence));
    res.json({ ...r, stages });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/routings", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    if (!b.nameAr || typeof b.nameAr !== "string") {
      res.status(400).json({ error: "اسم القالب مطلوب" });
      return;
    }
    if (!b.productItemId) {
      res.status(400).json({ error: "اختر المنتج النهائي" });
      return;
    }
    await validateItem(cid, Number(b.productItemId));
    if (Array.isArray(b.stages)) {
      for (const s of b.stages) {
        if (s.workCenterId) await loadWorkCenter(cid, Number(s.workCenterId));
      }
    }
    const [r] = await db
      .insert(productionRoutingsTable)
      .values({
        companyId: cid,
        productItemId: Number(b.productItemId),
        nameAr: b.nameAr.trim(),
        nameEn: b.nameEn?.trim() || null,
        isActive: b.isActive !== false,
        notes: b.notes || null,
      })
      .returning();
    if (Array.isArray(b.stages) && b.stages.length > 0) {
      await db.insert(productionRoutingStagesTable).values(
        b.stages.map((s: any, i: number) => ({
          routingId: r.id,
          sequence: Number(s.sequence ?? i + 1),
          code: String(s.code ?? `S${i + 1}`).toUpperCase(),
          nameAr: String(s.nameAr ?? `مرحلة ${i + 1}`),
          nameEn: s.nameEn || null,
          workCenterId: s.workCenterId ? Number(s.workCenterId) : null,
          expectedWasteRatio: String(num(s.expectedWasteRatio)),
          expectedDurationMinutes: s.expectedDurationMinutes
            ? Number(s.expectedDurationMinutes)
            : null,
          icon: s.icon || null,
          color: s.color || null,
          notes: s.notes || null,
        })),
      );
    }
    res.status(201).json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/routings/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.nameAr === "string") updates.nameAr = b.nameAr.trim();
    if ("nameEn" in b) updates.nameEn = b.nameEn?.trim() || null;
    if ("notes" in b) updates.notes = b.notes || null;
    if (typeof b.isActive === "boolean") updates.isActive = b.isActive;
    if (b.productItemId) {
      await validateItem(cid, Number(b.productItemId));
      updates.productItemId = Number(b.productItemId);
    }
    const [r] = await db
      .update(productionRoutingsTable)
      .set(updates)
      .where(
        and(
          eq(productionRoutingsTable.id, id),
          eq(productionRoutingsTable.companyId, cid),
        ),
      )
      .returning();
    if (!r) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/routings/:id/stages", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [r] = await db
      .select()
      .from(productionRoutingsTable)
      .where(
        and(
          eq(productionRoutingsTable.id, id),
          eq(productionRoutingsTable.companyId, cid),
        ),
      );
    if (!r) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    const stages = Array.isArray(req.body?.stages) ? req.body.stages : [];
    for (const s of stages) {
      if (s.workCenterId) await loadWorkCenter(cid, Number(s.workCenterId));
    }
    await db
      .delete(productionRoutingStagesTable)
      .where(eq(productionRoutingStagesTable.routingId, id));
    if (stages.length > 0) {
      await db.insert(productionRoutingStagesTable).values(
        stages.map((s: any, i: number) => ({
          routingId: id,
          sequence: Number(s.sequence ?? i + 1),
          code: String(s.code ?? `S${i + 1}`).toUpperCase(),
          nameAr: String(s.nameAr ?? `مرحلة ${i + 1}`),
          nameEn: s.nameEn || null,
          workCenterId: s.workCenterId ? Number(s.workCenterId) : null,
          expectedWasteRatio: String(num(s.expectedWasteRatio)),
          expectedDurationMinutes: s.expectedDurationMinutes
            ? Number(s.expectedDurationMinutes)
            : null,
          icon: s.icon || null,
          color: s.color || null,
          notes: s.notes || null,
        })),
      );
    }
    await db
      .update(productionRoutingsTable)
      .set({ updatedAt: new Date() })
      .where(eq(productionRoutingsTable.id, id));
    res.json({ ok: true, stages: stages.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/routings/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const r = await db
      .delete(productionRoutingsTable)
      .where(
        and(
          eq(productionRoutingsTable.id, id),
          eq(productionRoutingsTable.companyId, cid),
        ),
      )
      .returning();
    if (r.length === 0) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// PHASE C — Order stages (تتبّع تنفيذ المراحل لكل أمر)
// ────────────────────────────────────────────────────────────────────────

async function loadOrderForStages(req: any, res: any) {
  const cid = guard(req, res);
  if (!cid) return null;
  const id = Number(req.params.id);
  const [order] = await db
    .select()
    .from(productionOrdersTable)
    .where(
      and(
        eq(productionOrdersTable.id, id),
        eq(productionOrdersTable.companyId, cid),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "أمر الإنتاج غير موجود" });
    return null;
  }
  if (!rowInScope(req, order.branchId)) {
    res.status(403).json({ error: "خارج نطاق الفرع" });
    return null;
  }
  return { cid, order };
}

router.get("/orders/:id/stages", async (req, res) => {
  try {
    const ctx = await loadOrderForStages(req, res);
    if (!ctx) return;
    const stages = await db
      .select()
      .from(productionOrderStagesTable)
      .where(eq(productionOrderStagesTable.orderId, ctx.order.id))
      .orderBy(asc(productionOrderStagesTable.sequence));
    res.json(stages);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders/:id/stages/seed", async (req, res) => {
  try {
    const ctx = await loadOrderForStages(req, res);
    if (!ctx) return;
    const { cid, order } = ctx;
    const existing = await db
      .select({ id: productionOrderStagesTable.id })
      .from(productionOrderStagesTable)
      .where(eq(productionOrderStagesTable.orderId, order.id))
      .limit(1);
    if (existing.length > 0 && !req.body?.replace) {
      res.status(400).json({
        error: "هذا الأمر له مراحل بالفعل. مرّر replace=true للاستبدال.",
      });
      return;
    }
    const routingId = req.body?.routingId
      ? Number(req.body.routingId)
      : order.productItemId
        ? null
        : null;
    let routing: any = null;
    if (routingId) {
      [routing] = await db
        .select()
        .from(productionRoutingsTable)
        .where(
          and(
            eq(productionRoutingsTable.id, routingId),
            eq(productionRoutingsTable.companyId, cid),
          ),
        );
    } else if (order.productItemId) {
      [routing] = await db
        .select()
        .from(productionRoutingsTable)
        .where(
          and(
            eq(productionRoutingsTable.companyId, cid),
            eq(productionRoutingsTable.productItemId, order.productItemId),
            eq(productionRoutingsTable.isActive, true),
          ),
        )
        .orderBy(desc(productionRoutingsTable.updatedAt))
        .limit(1);
    }
    if (!routing) {
      res
        .status(400)
        .json({ error: "لا يوجد قالب مراحل نشط لهذا المنتج" });
      return;
    }
    const rs = await db
      .select()
      .from(productionRoutingStagesTable)
      .where(eq(productionRoutingStagesTable.routingId, routing.id))
      .orderBy(asc(productionRoutingStagesTable.sequence));
    if (rs.length === 0) {
      res.status(400).json({ error: "القالب لا يحتوي على مراحل" });
      return;
    }
    if (existing.length > 0) {
      await db
        .delete(productionOrderStagesTable)
        .where(eq(productionOrderStagesTable.orderId, order.id));
    }
    await db.insert(productionOrderStagesTable).values(
      rs.map((s, idx) => ({
        orderId: order.id,
        sequence: s.sequence,
        code: s.code,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        workCenterId: s.workCenterId,
        expectedWasteRatio: s.expectedWasteRatio,
        expectedDurationMinutes: s.expectedDurationMinutes,
        icon: s.icon,
        color: s.color,
        status: "pending" as const,
        inputQty: idx === 0 ? String(num(order.plannedQty)) : "0",
        outputQty: "0",
        wasteQty: "0",
        fromRoutingId: routing.id,
      })),
    );
    await writeEvent(
      cid,
      order.id,
      "routing_loaded",
      { routingId: routing.id, stages: rs.length, manual: true },
      req.authUser!.id,
    );
    res.json({ ok: true, stages: rs.length, routingId: routing.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders/:id/stages/:stageId/start", async (req, res) => {
  try {
    const ctx = await loadOrderForStages(req, res);
    if (!ctx) return;
    const stageId = Number(req.params.stageId);
    const [stage] = await db
      .select()
      .from(productionOrderStagesTable)
      .where(
        and(
          eq(productionOrderStagesTable.id, stageId),
          eq(productionOrderStagesTable.orderId, ctx.order.id),
        ),
      );
    if (!stage) {
      res.status(404).json({ error: "المرحلة غير موجودة" });
      return;
    }
    if (stage.status === "done") {
      res.status(400).json({ error: "المرحلة مكتملة بالفعل" });
      return;
    }
    if (stage.status === "skipped") {
      res.status(400).json({ error: "المرحلة متخطّاة — لا يمكن بدؤها" });
      return;
    }
    // Enforce sequence: previous stage must be done or skipped
    const prevStages = await db
      .select({ id: productionOrderStagesTable.id, status: productionOrderStagesTable.status, sequence: productionOrderStagesTable.sequence })
      .from(productionOrderStagesTable)
      .where(eq(productionOrderStagesTable.orderId, ctx.order.id))
      .orderBy(asc(productionOrderStagesTable.sequence));
    const prev = prevStages.filter((s) => s.sequence < stage.sequence);
    const blocking = prev.find((s) => s.status !== "done" && s.status !== "skipped");
    if (blocking) {
      res.status(400).json({ error: "أكمل المراحل السابقة أولاً" });
      return;
    }
    const inputQty =
      req.body?.inputQty !== undefined && req.body?.inputQty !== ""
        ? String(num(req.body.inputQty))
        : Number(stage.inputQty) > 0
          ? stage.inputQty
          : String(num(ctx.order.plannedQty));
    const [updated] = await db
      .update(productionOrderStagesTable)
      .set({
        status: "in_progress" as const,
        startedAt: stage.startedAt ?? new Date(),
        inputQty,
        operatorUserId: req.body?.operatorUserId
          ? Number(req.body.operatorUserId)
          : (stage.operatorUserId ?? req.authUser!.id),
      })
      .where(eq(productionOrderStagesTable.id, stageId))
      .returning();
    await writeEvent(
      ctx.cid,
      ctx.order.id,
      "stage_started",
      { stageId, code: stage.code, inputQty },
      req.authUser!.id,
    );
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders/:id/stages/:stageId/complete", async (req, res) => {
  try {
    const ctx = await loadOrderForStages(req, res);
    if (!ctx) return;
    const stageId = Number(req.params.stageId);
    const b = req.body ?? {};
    const [stage] = await db
      .select()
      .from(productionOrderStagesTable)
      .where(
        and(
          eq(productionOrderStagesTable.id, stageId),
          eq(productionOrderStagesTable.orderId, ctx.order.id),
        ),
      );
    if (!stage) {
      res.status(404).json({ error: "المرحلة غير موجودة" });
      return;
    }
    if (stage.status === "done") {
      res.status(400).json({ error: "المرحلة مكتملة بالفعل" });
      return;
    }
    if (stage.status === "pending") {
      res.status(400).json({ error: "ابدأ المرحلة أولاً قبل إكمالها" });
      return;
    }
    const outputQty = num(b.outputQty);
    const wasteQty = num(b.wasteQty);
    if (outputQty < 0 || wasteQty < 0) {
      res.status(400).json({ error: "الكميات يجب أن تكون موجبة" });
      return;
    }
    const [updated] = await db
      .update(productionOrderStagesTable)
      .set({
        status: "done" as const,
        outputQty: String(outputQty),
        wasteQty: String(wasteQty),
        completedAt: new Date(),
        startedAt: stage.startedAt ?? new Date(),
        notes: b.notes ?? stage.notes,
        operatorUserId: b.operatorUserId
          ? Number(b.operatorUserId)
          : (stage.operatorUserId ?? req.authUser!.id),
      })
      .where(eq(productionOrderStagesTable.id, stageId))
      .returning();

    // تمرير الكمية للمرحلة التالية تلقائياً (إلا إذا حُدّدت يدوياً)
    const allStages = await db
      .select()
      .from(productionOrderStagesTable)
      .where(eq(productionOrderStagesTable.orderId, ctx.order.id))
      .orderBy(asc(productionOrderStagesTable.sequence));
    const idx = allStages.findIndex((s) => s.id === stageId);
    const next = idx >= 0 ? allStages[idx + 1] : undefined;
    if (next && next.status === "pending" && Number(next.inputQty) === 0) {
      await db
        .update(productionOrderStagesTable)
        .set({ inputQty: String(outputQty) })
        .where(eq(productionOrderStagesTable.id, next.id));
    }

    await writeEvent(
      ctx.cid,
      ctx.order.id,
      "stage_completed",
      { stageId, code: stage.code, outputQty, wasteQty },
      req.authUser!.id,
    );
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/orders/:id/stages/:stageId", async (req, res) => {
  try {
    const ctx = await loadOrderForStages(req, res);
    if (!ctx) return;
    const stageId = Number(req.params.stageId);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if ("inputQty" in b) updates.inputQty = String(num(b.inputQty));
    if ("outputQty" in b) updates.outputQty = String(num(b.outputQty));
    if ("wasteQty" in b) updates.wasteQty = String(num(b.wasteQty));
    if ("notes" in b) updates.notes = b.notes || null;
    if ("operatorUserId" in b)
      updates.operatorUserId = b.operatorUserId
        ? Number(b.operatorUserId)
        : null;
    if (
      typeof b.status === "string" &&
      (PRODUCTION_STAGE_STATUSES as readonly string[]).includes(b.status)
    ) {
      updates.status = b.status;
      if (b.status === "in_progress") updates.startedAt = new Date();
      if (b.status === "done") updates.completedAt = new Date();
      if (b.status === "pending") {
        updates.startedAt = null;
        updates.completedAt = null;
      }
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "لا يوجد تحديث" });
      return;
    }
    const [updated] = await db
      .update(productionOrderStagesTable)
      .set(updates)
      .where(
        and(
          eq(productionOrderStagesTable.id, stageId),
          eq(productionOrderStagesTable.orderId, ctx.order.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "المرحلة غير موجودة" });
      return;
    }
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// PHASE C — Visual board (لوحة خط الإنتاج البصرية)
// ────────────────────────────────────────────────────────────────────────
router.get("/board", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchScope = branchScopeFilter(req, productionOrdersTable.branchId);
    const orders = await db
      .select({
        id: productionOrdersTable.id,
        orderNumber: productionOrdersTable.orderNumber,
        title: productionOrdersTable.title,
        status: productionOrdersTable.status,
        plannedQty: productionOrdersTable.plannedQty,
        producedQty: productionOrdersTable.producedQty,
        wasteQty: productionOrdersTable.wasteQty,
        productItemId: productionOrdersTable.productItemId,
        productNameAr: itemsTable.nameAr,
        productNameEn: itemsTable.nameEn,
        plannedStartDate: productionOrdersTable.plannedStartDate,
        plannedEndDate: productionOrdersTable.plannedEndDate,
      })
      .from(productionOrdersTable)
      .leftJoin(itemsTable, eq(itemsTable.id, productionOrdersTable.productItemId))
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          sql`${productionOrdersTable.status} NOT IN ('completed','cancelled')`,
          ...(branchScope ? [branchScope] : []),
        ),
      )
      .orderBy(desc(productionOrdersTable.id))
      .limit(200);
    if (orders.length === 0) {
      res.json({ orders: [], stages: {} });
      return;
    }
    const ids = orders.map((o) => o.id);
    const stages = await db
      .select()
      .from(productionOrderStagesTable)
      .where(sql`${productionOrderStagesTable.orderId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
      .orderBy(asc(productionOrderStagesTable.sequence));
    const grouped: Record<number, typeof stages> = {};
    for (const s of stages) {
      (grouped[s.orderId] ??= [] as any).push(s);
    }
    res.json({ orders, stages: grouped });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// PHASE C — Seed example: المعمول (دورة كاملة 6 مراحل)
// ────────────────────────────────────────────────────────────────────────
router.post("/seed-maamoul-example", async (req, res) => {
  try {
    if (req.authUser?.role !== "superadmin") {
      res.status(403).json({ error: "هذا المسار للمشرف العام فقط (مثال توضيحي)" });
      return;
    }
    const cid = guard(req, res);
    if (!cid) return;

    // 1) صنف "معمول" — أنشئ إن لم يوجد
    let [maamoul] = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.companyId, cid),
          eq(itemsTable.code, "MAAMOUL-DEMO"),
        ),
      )
      .limit(1);
    if (!maamoul) {
      const inserted = await db
        .insert(itemsTable)
        .values({
          companyId: cid,
          code: "MAAMOUL-DEMO",
          nameAr: "معمول (مثال خط الإنتاج)",
          nameEn: "Maamoul (Production Demo)",
          unitCode: "KG",
          itemType: "stock" as const,
          isActive: true,
        } as any)
        .returning();
      maamoul = inserted[0];
    }

    // 2) قالب Routing — أنشئ أو حدّث
    const stagesSpec = [
      { code: "MIX",     nameAr: "العجن",           nameEn: "Dough Mixing",    color: "#f59e0b", icon: "🥣", waste: "0.005", mins: 30 },
      { code: "FREEZE",  nameAr: "التجميد",          nameEn: "Freezing",        color: "#0ea5e9", icon: "❄️", waste: "0.001", mins: 240 },
      { code: "THAW",    nameAr: "فك التجميد + ماكينة المعمول", nameEn: "Thaw & Maamoul Machine", color: "#8b5cf6", icon: "⚙️", waste: "0.010", mins: 60 },
      { code: "SHAPE",   nameAr: "التصبيع",          nameEn: "Shaping",         color: "#ec4899", icon: "🤲", waste: "0.015", mins: 90 },
      { code: "OVEN",    nameAr: "الفرن",            nameEn: "Baking",          color: "#ef4444", icon: "🔥", waste: "0.020", mins: 45 },
      { code: "PACK",    nameAr: "الفرز والتعبئة",   nameEn: "Sorting & Packing", color: "#10b981", icon: "📦", waste: "0.005", mins: 60 },
    ];

    let [routing] = await db
      .select()
      .from(productionRoutingsTable)
      .where(
        and(
          eq(productionRoutingsTable.companyId, cid),
          eq(productionRoutingsTable.productItemId, maamoul.id),
        ),
      )
      .limit(1);
    if (!routing) {
      const inserted = await db
        .insert(productionRoutingsTable)
        .values({
          companyId: cid,
          productItemId: maamoul.id,
          nameAr: "خط إنتاج المعمول الكامل",
          nameEn: "Full Maamoul Production Line",
          isActive: true,
          notes: "مثال توضيحي تلقائي — 6 مراحل من العجن إلى التعبئة.",
        })
        .returning();
      routing = inserted[0];
    } else {
      await db
        .update(productionRoutingsTable)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(productionRoutingsTable.id, routing.id));
    }

    // استبدال المراحل (idempotent)
    await db
      .delete(productionRoutingStagesTable)
      .where(eq(productionRoutingStagesTable.routingId, routing.id));
    await db.insert(productionRoutingStagesTable).values(
      stagesSpec.map((s, i) => ({
        routingId: routing!.id,
        sequence: i + 1,
        code: s.code,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        workCenterId: null,
        expectedWasteRatio: s.waste,
        expectedDurationMinutes: s.mins,
        icon: s.icon,
        color: s.color,
        notes: null,
      })),
    );

    // 3) أنشئ أمر إنتاج تجريبي (100 كجم) وسطورُه التشغيلية
    const seq = await nextSequenceNumber(cid, "production_order").catch(
      () => null,
    );
    const orderNumber = seq ?? `PRD-DEMO-${Date.now().toString(36)}`;
    const [order] = await db
      .insert(productionOrdersTable)
      .values({
        companyId: cid,
        branchId: null,
        orderNumber,
        title: "أمر إنتاج تجريبي — معمول 100 كجم",
        status: "in_production" as const,
        plannedQty: "100",
        producedQty: "0",
        wasteQty: "0",
        productItemId: maamoul.id,
        unitCode: "KG",
        plannedStartDate: new Date().toISOString().slice(0, 10),
        notes: "مثال تلقائي يوضح كامل دورة المراحل لخط معمول.",
        meta: { isDemo: true, scenario: "maamoul-line" },
        createdBy: req.authUser!.id,
      } as any)
      .returning();

    await db.insert(productionOrderStagesTable).values(
      stagesSpec.map((s, i) => ({
        orderId: order.id,
        sequence: i + 1,
        code: s.code,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        workCenterId: null,
        expectedWasteRatio: s.waste,
        expectedDurationMinutes: s.mins,
        icon: s.icon,
        color: s.color,
        // 3 مراحل أولى مكتملة، الرابعة جارية، الباقي pending
        status:
          i < 3
            ? ("done" as const)
            : i === 3
              ? ("in_progress" as const)
              : ("pending" as const),
        inputQty:
          i === 0
            ? "100.000"
            : i === 1
              ? "99.500"
              : i === 2
                ? "99.400"
                : i === 3
                  ? "98.400"
                  : "0",
        outputQty:
          i === 0 ? "99.500" : i === 1 ? "99.400" : i === 2 ? "98.400" : "0",
        wasteQty:
          i === 0 ? "0.500" : i === 1 ? "0.100" : i === 2 ? "1.000" : "0",
        startedAt:
          i <= 3
            ? new Date(Date.now() - (4 - i) * 60 * 60 * 1000)
            : null,
        completedAt:
          i < 3 ? new Date(Date.now() - (3 - i) * 60 * 60 * 1000) : null,
        operatorUserId: req.authUser!.id,
        fromRoutingId: routing!.id,
      })),
    );

    await writeEvent(
      cid,
      order.id,
      "demo_seeded",
      { routingId: routing.id, productId: maamoul.id, orderNumber },
      req.authUser!.id,
    );

    res.json({
      ok: true,
      product: { id: maamoul.id, nameAr: maamoul.nameAr },
      routing: { id: routing.id, nameAr: routing.nameAr },
      order: { id: order.id, orderNumber: order.orderNumber },
      stagesCount: stagesSpec.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
