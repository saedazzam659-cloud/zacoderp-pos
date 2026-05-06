// Production / Manufacturing module — orders, items, resources, events, dashboard.
//
// Multi-tenant, branch-scoped. Status transitions enforced server-side.
// Every mutation writes a row into production_events for full auditability.
import { Router } from "express";
import { db } from "@workspace/db";
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
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_STATUS_TRANSITIONS,
  type ProductionOrderStatus,
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
      status: "posted",
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
            rawWarehouseId: await validateWarehouse(cid, b.rawWarehouseId ? Number(b.rawWarehouseId) : null),
            finishedWarehouseId: await validateWarehouse(cid, b.finishedWarehouseId ? Number(b.finishedWarehouseId) : null),
            laborCost: String(num(b.laborCost)),
            overheadCost: String(num(b.overheadCost)),
            costCenter: typeof b.costCenter === "string" && b.costCenter.trim() ? b.costCenter.trim() : null,
            wipAccountId: await validateAccount(cid, b.wipAccountId ? Number(b.wipAccountId) : null),
            rawInventoryAccountId: await validateAccount(cid, b.rawInventoryAccountId ? Number(b.rawInventoryAccountId) : null),
            finishedGoodsAccountId: await validateAccount(cid, b.finishedGoodsAccountId ? Number(b.finishedGoodsAccountId) : null),
            laborAccountId: await validateAccount(cid, b.laborAccountId ? Number(b.laborAccountId) : null),
            overheadAccountId: await validateAccount(cid, b.overheadAccountId ? Number(b.overheadAccountId) : null),
            varianceAccountId: await validateAccount(cid, b.varianceAccountId ? Number(b.varianceAccountId) : null),
            wasteAccountId: await validateAccount(cid, b.wasteAccountId ? Number(b.wasteAccountId) : null),
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
    res.status(201).json(row);
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

export default router;
