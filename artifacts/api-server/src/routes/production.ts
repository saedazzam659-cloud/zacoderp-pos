// Production / Manufacturing module — orders, items, resources, events, dashboard.
//
// Multi-tenant, branch-scoped. Status transitions enforced server-side.
// Every mutation writes a row into production_events for full auditability.
import { Router } from "express";
import { db } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { fullAuditFor } from "../lib/journalAudit.js";
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
  productionQualityChecksTable,
  productionQualityCheckTemplatesTable,
  productionQualityCheckTemplateItemsTable,
  productionShiftsTable,
  productionShiftHolidaysTable,
  productionForecastsTable,
  productionForecastLinesTable,
  PRODUCTION_FORECAST_STATUSES,
  productionDowntimeReasonsTable,
  productionDowntimeEventsTable,
  DOWNTIME_CATEGORIES,
  productionWasteRecordsTable,
  PRODUCTION_WASTE_TYPES,
  QC_CHECK_TYPES,
  QC_RESULTS,
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_STATUS_TRANSITIONS,
  PRODUCTION_STAGE_STATUSES,
  usersTable,
  type ProductionOrderStatus,
  type ProductionStageStatus,
} from "@workspace/db";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, ilike, sql, or, inArray } from "drizzle-orm";
import {
  extractAuth,
  resolveCompanyId,
  branchScopeFilter,
  intersectBranchRequest,
  effectiveBranchCondition,
} from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { upsertBalance, getBalance, addStockLedgerEntry, pickBatches, readBatchRemaining } from "../lib/stockHelpers.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";

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
  // Audit-trail fields injected by callers via `fullAuditFor(req)`.
  audit?: Record<string, unknown>;
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
  // Pre-resolve status so the helper drops posted_* when the tenant has
  // auto-post OFF — otherwise a draft JE would look "posted" in the audit
  // dialog. Callers may pass `audit: { req }` for live wiring or a pre-
  // baked object for legacy paths; both are honoured.
  const jeStatus = await resolvePostingStatus(opts.companyId, "production");
  const auditFields = opts.audit?.req
    ? fullAuditFor(opts.audit.req as any, jeStatus)
    : (opts.audit ?? {});
  // The journal entry draws its OWN continuous number from the "journal_entry"
  // sequence — independent of the source document's number. The source number
  // stays in the description + the source.jeId link, so traceability and
  // unposting are unaffected. Falls back to the source docNumber when no active
  // "journal_entry" sequence is configured (back-compat).
  const seqDocNumber = await nextSequenceNumber(opts.companyId, "journal_entry", {
    userId:   (opts.audit?.req as any)?.authUser?.id ?? null,
    refTable: "journal_entries",
    branchId: opts.branchId ?? null,
    docDate:  opts.date,
  });
  const jeDocNumber = seqDocNumber ?? (opts.docNumber ?? null);
  const [entry] = await db
    .insert(journalEntriesTable)
    .values({
      companyId: opts.companyId,
      branchId: opts.branchId ?? null,
      docNumber: jeDocNumber,
      entryDate: opts.date,
      currency: "SAR",
      exchangeRate: opts.exchangeRate ?? "1",
      description: opts.description,
      entryType: opts.entryType ?? "production",
      status: jeStatus,
      periodId: writability.period?.id ?? null,
      ...auditFields,
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
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        providers: ["gemini"],
    });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  
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

// Pending  — GET /api/production/orders/pending-approval
//   Lists draft orders for the current company, newest first. The
//   manufacturingSettings.approvalRequired and .approvalThreshold flags
//   are returned in a 'needsApproval' boolean per order so the queue
//   can highlight the ones that truly need a second pair of eyes.
//
// IMPORTANT: registered BEFORE `/orders/:id` because Express 5 /
// path-to-regexp 8 no longer supports inline regex constraints
// (`/:id(\d+)`) — registration order is the only thing that prevents
// `:id` from swallowing the literal `pending-approval` segment.
router.get("/orders/pending-approval", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const [settings] = await db
      .select({
        approvalRequired: manufacturingSettingsTable.approvalRequired,
        approvalThreshold: manufacturingSettingsTable.approvalThreshold,
      })
      .from(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, cid))
      .limit(1);

    const threshold = settings?.approvalThreshold
      ? Number(settings.approvalThreshold)
      : null;
    const required = settings?.approvalRequired === true;

    const rows = await db
      .select({
        id: productionOrdersTable.id,
        orderNumber: productionOrdersTable.orderNumber,
        title: productionOrdersTable.title,
        status: productionOrdersTable.status,
        plannedQty: productionOrdersTable.plannedQty,
        unitCode: productionOrdersTable.unitCode,
        estimatedCost: productionOrdersTable.estimatedCost,
        plannedStartDate: productionOrdersTable.plannedStartDate,
        plannedEndDate: productionOrdersTable.plannedEndDate,
        createdAt: productionOrdersTable.createdAt,
        createdBy: productionOrdersTable.createdBy,
        productItemId: productionOrdersTable.productItemId,
        productNameAr: itemsTable.nameAr,
        creatorName: sql<string>`coalesce(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
      })
      .from(productionOrdersTable)
      .leftJoin(
        itemsTable,
        and(
          eq(itemsTable.id, productionOrdersTable.productItemId),
          eq(itemsTable.companyId, cid),
        ),
      )
      .leftJoin(usersTable, eq(usersTable.id, productionOrdersTable.createdBy))
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "draft"),
        ),
      )
      .orderBy(desc(productionOrdersTable.createdAt))
      .limit(500);

    const items = rows.map((r) => {
      const cost = Number(r.estimatedCost) || 0;
      const overThreshold = threshold != null && cost >= threshold;
      return {
        ...r,
        needsApproval: required || overThreshold,
        overThreshold,
      };
    });

    res.json({
      settings: {
        approvalRequired: required,
        approvalThreshold: threshold,
      },
      items,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /orders/pending-approval failed");
    res.status(500).json({ error: e.message });
  }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "id غير صحيح" });
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
    // PHASE D — include scrap records so the UI can show them alongside.
    const wasteRecords = await db
      .select()
      .from(productionWasteRecordsTable)
      .where(
        and(
          eq(productionWasteRecordsTable.companyId, cid),
          eq(productionWasteRecordsTable.orderId, id),
        ),
      )
      .orderBy(desc(productionWasteRecordsTable.createdAt));
    res.json({ order, items, events, wasteRecords });
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
                expectedCost: s.expectedCost,
                expectedCostAccountId: s.expectedCostAccountId,
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
    // PHASE D — FG expiry date is user-tunable pre-completion (gets stamped
    // onto the production_receipt ledger row at completion → flows to the
    // batches panel). Editable while the receipt JE hasn't posted.
    if (b.fgExpiryDate !== undefined && !existingOrder.status?.toString().includes("completed"))
      updates.fgExpiryDate = b.fgExpiryDate || null;
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

    // ─── Round A — audit stamp on draft → approved via canonical endpoint ───
    // The dedicated POST /orders/:id/approve stamps these fields, but the
    // canonical status endpoint must do the same when the same transition is
    // performed here, otherwise we'd have an audit gap (approvedByUserId NULL
    // even though the order is 'approved'). Only stamp on the actual
    // draft → approved edge, not on any other transition that happens to land
    // on 'approved' (currently none exist, but defensive).
    if (
      target === "approved" &&
      order.status === "draft" &&
      !order.approvedAt
    ) {
      updates.approvedByUserId = (req as any).user?.id ?? null;
      updates.approvedAt = new Date();
    }

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

      // c) Decrement stock + ledger entries; track total raw cost.
      //
      // PHASE E — Per-item batch picking:
      //   * batch_tracking_mode='none'  → legacy single-row WAC issue
      //   * batch_tracking_mode='fifo'  → split into per-batch ledger rows,
      //                                    oldest received batch first
      //   * batch_tracking_mode='fefo'  → earliest expiry first (NULLS LAST)
      // The JE total stays identical (same total cost), only the ledger
      // OUT rows are split + stamped with batchNumber/expiryDate so
      // traceability (recall, FEFO compliance) works on the OUT side too.
      // Items' batch modes are fetched in one query to avoid N+1.
      const itemIds = issuableLines.map((l) => l.itemId!);
      const itemRows = itemIds.length
        ? await db
            .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.companyId, cid),
                inArray(itemsTable.id, itemIds),
              ),
            )
        : [];
      const modeById = new Map<number, "none" | "fifo" | "fefo">();
      for (const r of itemRows) {
        const m = (r.mode ?? "none") as string;
        modeById.set(
          r.id,
          m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none",
        );
      }
      let rawTotal = 0;
      for (const ln of issuableLines) {
        const qty = Number(ln.quantity);
        const mode = modeById.get(ln.itemId!) ?? "none";
        if (mode === "none") {
          // Legacy path — single WAC ledger row, no batch stamp on OUT.
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
        } else {
          // FIFO / FEFO path — derive per-batch picks then write N
          // ledger rows. stock_balance.qty still drops by the full qty
          // (we don't maintain per-batch balances); avgCost is preserved
          // because we pass the WAC cost into upsertBalance (negative
          // delta keeps avgCost unchanged anyway).
          const picks = await pickBatches(
            cid,
            ln.itemId!,
            order.rawWarehouseId,
            qty,
            mode,
          );
          const linecost = picks.reduce((s, p) => s + p.takeQty * p.costPrice, 0);
          // Update aggregated balance (single update for the whole line)
          const wac = qty > 0 ? linecost / qty : 0;
          await upsertBalance(cid, ln.itemId!, order.rawWarehouseId, -qty, wac);
          let runningBal = await getBalance(cid, ln.itemId!, order.rawWarehouseId);
          // We've already decremented runningBal once for the whole qty.
          // Each ledger row's `balance_qty` should reflect the post-row
          // running total, so walk back up from the final value.
          let cursor = runningBal + qty; // pre-issue total
          for (const p of picks) {
            cursor -= p.takeQty;
            await addStockLedgerEntry({
              companyId: cid,
              itemId: ln.itemId!,
              warehouseId: order.rawWarehouseId,
              txDate: todayIso,
              txType: "production_issue",
              qty: String(-p.takeQty),
              costPrice: String(p.costPrice.toFixed(4)),
              totalCost: String((-p.takeQty * p.costPrice).toFixed(2)),
              balanceQty: String(cursor.toFixed(4)),
              refId: id,
              refType: "production_order",
              batchNumber: p.batchNumber,
              expiryDate: p.expiryDate,
              notes: `صرف لأمر إنتاج ${order.orderNumber}${p.batchNumber ? ` — تشغيلة ${p.batchNumber}` : ""}`,
            });
          }
          rawTotal += linecost;
        }
      }

      const labor = Number(order.laborCost ?? 0);
      const overhead = Number(order.overheadCost ?? 0);
      const wipDr = rawTotal + labor + overhead;

      // d) Issue JE: DR WIP / CR Raw Inv (+ CR Labor / CR Overhead).
      const issueJournalId = await createJournalEntry({
        companyId: cid,
        audit: { req },
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

      // ─── PHASE D: generate batchNumber + qrToken when issuing ──────────────
      // Format: PRD-YYYYMMDD-{orderId} (zero-padded). Unique per company via
      // the partial index `prod_orders_company_batch_uniq`. Skipped if the
      // user already supplied a batchNumber via PATCH (manual override).
      if (!order.batchNumber) {
        const d = new Date();
        const dStr = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
        updates.batchNumber = `PRD-${dStr}-${String(id).padStart(5, "0")}`;
        updates.qrToken = `${updates.batchNumber}-${randomBytes(4).toString("hex").toUpperCase()}`;
      }
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
      // PHASE D — Honour fgExpiryDate sent in the completion body. The UI
      // posts it alongside producedQty/wasteQty so the operator can set the
      // shelf-life right before closing the order. We persist it via the
      // same `updates` map and re-read into `effectiveFgExpiry` so the
      // ledger row below stamps the value the user just typed (instead of
      // the stale order row loaded above).
      if (req.body?.fgExpiryDate !== undefined) {
        updates.fgExpiryDate = req.body.fgExpiryDate || null;
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
      // PHASE D: stamp the production batchNumber + expiry onto the ledger
      // row so the FG batch shows up in the item's "الدفعات" panel and is
      // discoverable by FEFO/expiry reports.
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
        batchNumber: order.batchNumber ?? null,
        // PHASE D — prefer the just-set value from the completion body over
        // the stale row loaded at the top of the handler.
        expiryDate:
          ((updates.fgExpiryDate as string | null | undefined) ?? order.fgExpiryDate) ?? null,
        notes: `إذن إضافة بضاعة تامة من أمر إنتاج ${order.orderNumber}${order.batchNumber ? ` — تشغيلة ${order.batchNumber}` : ""}`,
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
        audit: { req },
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
        audit: { req },
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
router.post("/manufacturing-settings/ai-suggest", requireAiFeature("manufacturing_ai"), async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY = "AI_PROXY";
    if (!isAIAvailable()) {
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
      // Tenant-validate each stage's GL account in parallel before
      // inserting (prevents cross-company id injection).
      const stageRows = await Promise.all(
        b.stages.map(async (s: any, i: number) => ({
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
          expectedCost: String(num(s.expectedCost)),
          expectedCostAccountId: await validateAccount(
            cid,
            s.expectedCostAccountId ? Number(s.expectedCostAccountId) : null,
          ),
          icon: s.icon || null,
          color: s.color || null,
          notes: s.notes || null,
        })),
      );
      await db.insert(productionRoutingStagesTable).values(stageRows);
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
      const stageRows = await Promise.all(
        stages.map(async (s: any, i: number) => ({
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
          expectedCost: String(num(s.expectedCost)),
          expectedCostAccountId: await validateAccount(
            cid,
            s.expectedCostAccountId ? Number(s.expectedCostAccountId) : null,
          ),
          icon: s.icon || null,
          color: s.color || null,
          notes: s.notes || null,
        })),
      );
      await db.insert(productionRoutingStagesTable).values(stageRows);
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
        // Routing-stage cost fields are tenant-validated already (only
        // company-scoped routings can be loaded above), so a direct copy
        // is safe here.
        expectedCost: s.expectedCost,
        expectedCostAccountId: s.expectedCostAccountId,
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
// PHASE C — Seed example: مثال توضيحي كامل (دورة 6 مراحل)
// ────────────────────────────────────────────────────────────────────────
router.post("/seed-maamoul-example", async (req, res) => {
  try {
    const role = req.authUser?.role;
    if (role !== "superadmin" && role !== "admin") {
      res.status(403).json({ error: "هذا المسار لمدير الشركة فقط (مثال توضيحي)" });
      return;
    }
    const cid = guard(req, res);
    if (!cid) return;

    // 1) صنف تجريبي — أنشئ إن لم يوجد
    let [maamoul] = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.companyId, cid),
          eq(itemsTable.code, "DEMO-PRODUCT"),
        ),
      )
      .limit(1);
    if (!maamoul) {
      const inserted = await db
        .insert(itemsTable)
        .values({
          companyId: cid,
          code: "DEMO-PRODUCT",
          nameAr: "منتج تجريبي (مثال خط الإنتاج)",
          nameEn: "Demo Product (Production Example)",
          unitCode: "KG",
          itemType: "stock" as const,
          isActive: true,
        } as any)
        .returning();
      maamoul = inserted[0];
    }

    // 2) قالب Routing — أنشئ أو حدّث
    const stagesSpec = [
      { code: "MIX",     nameAr: "العجن",                     nameEn: "Dough Mixing",      color: "#f59e0b", icon: "🥣", waste: "0.005", mins: 30 },
      { code: "FREEZE",  nameAr: "التجميد",                   nameEn: "Freezing",          color: "#0ea5e9", icon: "❄️", waste: "0.001", mins: 240 },
      { code: "THAW",    nameAr: "فك التجميد والتشكيل الأولي", nameEn: "Thaw & Pre-Shaping", color: "#8b5cf6", icon: "⚙️", waste: "0.010", mins: 60 },
      { code: "SHAPE",   nameAr: "التصبيع",                   nameEn: "Shaping",           color: "#ec4899", icon: "🤲", waste: "0.015", mins: 90 },
      { code: "OVEN",    nameAr: "الفرن",                     nameEn: "Baking",            color: "#ef4444", icon: "🔥", waste: "0.020", mins: 45 },
      { code: "PACK",    nameAr: "الفرز والتعبئة",            nameEn: "Sorting & Packing", color: "#10b981", icon: "📦", waste: "0.005", mins: 60 },
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
          nameAr: "خط إنتاج تجريبي كامل",
          nameEn: "Full Demo Production Line",
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
        title: "أمر إنتاج تجريبي — 100 كجم",
        status: "in_production" as const,
        plannedQty: "100",
        producedQty: "0",
        wasteQty: "0",
        productItemId: maamoul.id,
        unitCode: "KG",
        plannedStartDate: new Date().toISOString().slice(0, 10),
        notes: "مثال تلقائي يوضح كامل دورة مراحل خط الإنتاج.",
        meta: { isDemo: true, scenario: "demo-line" },
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

// ─────────────────────────────────────────────────────────────────────────
// Quality Control (مراقبة الجودة) — universal QC log
// ─────────────────────────────────────────────────────────────────────────
// One row per check performed on a production order or a specific stage.
// `checkType` is free-form (visual / weight / temperature / dimension /
// barcode / ai_camera / other) so factories can extend without schema
// changes. A failing check does NOT auto-revert the order/stage status —
// the UI surfaces it and the operator decides.
router.get("/quality-checks", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;
    const stageId = req.query.stageId ? Number(req.query.stageId) : null;
    const result = typeof req.query.result === "string" ? req.query.result : null;
    const conds = [eq(productionQualityChecksTable.companyId, cid)];
    if (orderId) conds.push(eq(productionQualityChecksTable.orderId, orderId));
    if (stageId) conds.push(eq(productionQualityChecksTable.stageId, stageId));
    if (result && (QC_RESULTS as readonly string[]).includes(result))
      conds.push(eq(productionQualityChecksTable.result, result));
    const rows = await db
      .select()
      .from(productionQualityChecksTable)
      .where(and(...conds))
      .orderBy(desc(productionQualityChecksTable.checkedAt))
      .limit(1000);
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "qc list failed");
    res.status(500).json({ error: e.message });
  }
});

router.get("/quality-checks/summary", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;
    const conds = [eq(productionQualityChecksTable.companyId, cid)];
    if (orderId) conds.push(eq(productionQualityChecksTable.orderId, orderId));
    const rows = await db
      .select({
        result: productionQualityChecksTable.result,
        count: sql<number>`count(*)::int`,
        defects: sql<number>`coalesce(sum(${productionQualityChecksTable.defectsFound}),0)::int`,
      })
      .from(productionQualityChecksTable)
      .where(and(...conds))
      .groupBy(productionQualityChecksTable.result);
    const summary = { pass: 0, fail: 0, conditional: 0, totalDefects: 0, total: 0 };
    for (const r of rows) {
      const c = Number(r.count) || 0;
      summary.total += c;
      summary.totalDefects += Number(r.defects) || 0;
      if (r.result === "pass") summary.pass = c;
      else if (r.result === "fail") summary.fail = c;
      else if (r.result === "conditional") summary.conditional = c;
    }
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Round 10 — Company-wide QC analytics. Returns pass / fail / conditional
// counts in the date range, plus per-checkType and top-failing-products
// breakdowns so a QC manager can spot the worst offenders fast. Branch-
// scoped via the standard `effectiveBranchCondition` so a restricted user
// only aggregates orders in their assigned branches.
router.get("/quality-checks/report", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const conditions = [eq(productionQualityChecksTable.companyId, cid)];
    if (from) conditions.push(sql`${productionQualityChecksTable.checkedAt} >= ${from}`);
    if (to) conditions.push(sql`${productionQualityChecksTable.checkedAt} < (${to}::date + interval '1 day')`);
    const branchScope = effectiveBranchCondition(req, productionOrdersTable.branchId, req.query.branchId);
    if (branchScope.deny) {
      res.json({ byResult: [], byCheckType: [], topFailingProducts: [], qcResults: QC_RESULTS });
      return;
    }
    if (branchScope.cond) conditions.push(branchScope.cond);

    const byResult = await db
      .select({
        result: productionQualityChecksTable.result,
        count: sql<number>`COUNT(*)::int`,
        defects: sql<number>`COALESCE(SUM(${productionQualityChecksTable.defectsFound}),0)::int`,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionQualityChecksTable.orderId, productionOrdersTable.id),
      )
      .where(and(...conditions))
      .groupBy(productionQualityChecksTable.result);

    const byCheckType = await db
      .select({
        checkType: productionQualityChecksTable.checkType,
        total: sql<number>`COUNT(*)::int`,
        fails: sql<number>`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'fail')::int`,
        conditionals: sql<number>`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'conditional')::int`,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionQualityChecksTable.orderId, productionOrdersTable.id),
      )
      .where(and(...conditions))
      .groupBy(productionQualityChecksTable.checkType)
      .orderBy(sql`COUNT(*) DESC`);

    const topFailingProducts = await db
      .select({
        productItemId: productionOrdersTable.productItemId,
        productNameAr: itemsTable.nameAr,
        total: sql<number>`COUNT(*)::int`,
        fails: sql<number>`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'fail')::int`,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionQualityChecksTable.orderId, productionOrdersTable.id),
      )
      .leftJoin(itemsTable, eq(productionOrdersTable.productItemId, itemsTable.id))
      .where(and(...conditions))
      .groupBy(productionOrdersTable.productItemId, itemsTable.nameAr)
      .orderBy(sql`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'fail') DESC`)
      .limit(15);

    res.json({ byResult, byCheckType, topFailingProducts, qcResults: QC_RESULTS });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Round 12 — Operator Performance Report. Aggregates per-operator stats from
// three existing data sources (no new tables): production_order_stages
// (throughput + duration), production_waste_records (scrap attribution), and
// production_quality_checks (QC fails on stages they ran). All sources are
// branch-scoped via the parent order. Read-only.
router.get("/operators/performance", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    // Validate date params at the edge — if the frontend ever sends a
    // malformed value (empty string, partial input mid-typing, locale
    // string, garbage), reject with 400 BEFORE binding it into the SQL.
    // Without this guard Postgres throws "invalid input syntax for type
    // date" inside the COALESCE/`::date` cast and the catch below turns
    // it into an HTTP 500 with the raw SQL leaked in the error body.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const rawFrom = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const rawTo = typeof req.query.to === "string" ? req.query.to.trim() : "";
    const isValidISODate = (s: string) => {
      if (!ISO_DATE.test(s)) return false;
      const d = new Date(`${s}T00:00:00Z`);
      // Round-trip check so JS's overflow normalisation (e.g. "2023-02-29"
      // → Mar 1) is rejected instead of silently shifted — matches the
      // validIsoDate helper pattern used in routes/reports.ts.
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    };
    if (rawFrom && !isValidISODate(rawFrom)) {
      res.status(400).json({ error: "تاريخ البداية غير صالح", field: "from" });
      return;
    }
    if (rawTo && !isValidISODate(rawTo)) {
      res.status(400).json({ error: "تاريخ النهاية غير صالح", field: "to" });
      return;
    }
    const from = rawFrom || null;
    const to = rawTo || null;
    const branchScope = effectiveBranchCondition(
      req,
      productionOrdersTable.branchId,
      req.query.branchId,
    );
    if (branchScope.deny) {
      res.json({ operators: [], totals: null, companyAvg: null });
      return;
    }
    // Round 13 — Optional per-operator filter. Non-admin/non-superadmin
    // users are clamped to their own user id so an operator can never use
    // ?operatorUserId=X to peek at a colleague's stats. Admins and
    // superadmins may pass any id or omit it to see everyone.
    const role = req.authUser?.role ?? "";
    const isPrivileged = role === "superadmin" || role === "admin";
    let operatorFilter: number | null = null;
    if (req.query.operatorUserId != null && req.query.operatorUserId !== "") {
      const n = Number(req.query.operatorUserId);
      if (Number.isInteger(n) && n > 0) operatorFilter = n;
    }
    if (!isPrivileged) {
      operatorFilter = req.authUser?.id ?? null;
      if (operatorFilter == null) {
        res.json({ operators: [], totals: null, companyAvg: null });
        return;
      }
    }
    const includeCompanyAvg = req.query.includeCompanyAvg === "true";

    // ── Stages: throughput, duration, stage-level waste, output ────────────
    // Anchor the date filter on the stage's completedAt (a finished stage is
    // the unit of "operator productivity"); fall back to startedAt for the
    // in-progress edge case so we don't lose recently started work.
    const stageConds = [eq(productionOrdersTable.companyId, cid)];
    if (from)
      stageConds.push(
        sql`COALESCE(${productionOrderStagesTable.completedAt}, ${productionOrderStagesTable.startedAt}) >= ${from}`,
      );
    if (to)
      stageConds.push(
        sql`COALESCE(${productionOrderStagesTable.completedAt}, ${productionOrderStagesTable.startedAt}) < (${to}::date + interval '1 day')`,
      );
    if (branchScope.cond) stageConds.push(branchScope.cond);
    stageConds.push(sql`${productionOrderStagesTable.operatorUserId} IS NOT NULL`);

    // Defensive startup-style assertion: in production we've seen Drizzle
    // throw "Cannot convert undefined or null to object" deep inside
    // orderSelectedFields, which only happens when one of the column refs
    // in the select object is undefined. That points to a stale / wrong
    // schema export sneaking into the bundle. Surface the actual missing
    // ref with a clear log line BEFORE Drizzle's generic crash.
    const _stagesCols: Record<string, unknown> = {
      operatorUserId: productionOrderStagesTable?.operatorUserId,
      status: productionOrderStagesTable?.status,
      completedAt: productionOrderStagesTable?.completedAt,
      startedAt: productionOrderStagesTable?.startedAt,
      outputQty: productionOrderStagesTable?.outputQty,
      wasteQty: productionOrderStagesTable?.wasteQty,
      orderId: productionOrderStagesTable?.orderId,
    };
    const _ordersCols: Record<string, unknown> = {
      id: productionOrdersTable?.id,
      companyId: productionOrdersTable?.companyId,
      branchId: productionOrdersTable?.branchId,
    };
    const _wasteCols: Record<string, unknown> = {
      operatorUserId: productionWasteRecordsTable?.operatorUserId,
      qty: productionWasteRecordsTable?.qty,
      costImpact: productionWasteRecordsTable?.costImpact,
      createdAt: productionWasteRecordsTable?.createdAt,
      orderId: productionWasteRecordsTable?.orderId,
    };
    const _qcCols: Record<string, unknown> = {
      result: productionQualityChecksTable?.result,
      checkedAt: productionQualityChecksTable?.checkedAt,
      orderId: productionQualityChecksTable?.orderId,
      stageId: productionQualityChecksTable?.stageId,
      companyId: productionQualityChecksTable?.companyId,
      id: productionQualityChecksTable?.id,
    };
    const _usersCols: Record<string, unknown> = {
      id: usersTable?.id,
      nameAr: usersTable?.nameAr,
      nameEn: usersTable?.nameEn,
      username: usersTable?.username,
    };
    const missingRefs: string[] = [];
    for (const [tbl, cols] of [
      ["production_order_stages", _stagesCols],
      ["production_orders", _ordersCols],
      ["production_waste_records", _wasteCols],
      ["production_quality_checks", _qcCols],
      ["users", _usersCols],
    ] as const) {
      for (const [k, v] of Object.entries(cols)) {
        if (v == null) missingRefs.push(`${tbl}.${k}`);
      }
    }
    if (missingRefs.length > 0) {
      req.log?.error?.(
        { missingRefs },
        "operators/performance: schema column refs are undefined — likely a stale bundle / circular import",
      );
      res.status(500).json({
        error: "تعذّر احتساب التقرير: مخطط البيانات غير مكتمل",
        missingRefs,
      });
      return;
    }

    const failedSources: string[] = [];
    let stageRows: Array<{
      operatorUserId: number | null;
      stagesTotal: number;
      stagesCompleted: number;
      avgDurationMins: number;
      stagesWithDuration: number;
      totalOutput: number;
      stageWasteQty: number;
    }> = [];
    try {
      stageRows = await db
        .select({
          operatorUserId: productionOrderStagesTable.operatorUserId,
          stagesTotal: sql<number>`COUNT(*)::int`,
          stagesCompleted: sql<number>`COUNT(*) FILTER (WHERE ${productionOrderStagesTable.status} = 'done')::int`,
          avgDurationMins: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${productionOrderStagesTable.completedAt} - ${productionOrderStagesTable.startedAt}))/60.0) FILTER (WHERE ${productionOrderStagesTable.completedAt} IS NOT NULL AND ${productionOrderStagesTable.startedAt} IS NOT NULL),0)::float`,
          // Round 13 fix — count of stages that actually have a duration sample,
          // used for pooled (weighted) avgDurationMins across operators and to
          // distinguish "operator has 0 duration data" from "operator has data
          // averaging 0" (so we don't bias the company mean either direction).
          stagesWithDuration: sql<number>`COUNT(*) FILTER (WHERE ${productionOrderStagesTable.completedAt} IS NOT NULL AND ${productionOrderStagesTable.startedAt} IS NOT NULL)::int`,
          totalOutput: sql<number>`COALESCE(SUM(${productionOrderStagesTable.outputQty}),0)::float`,
          stageWasteQty: sql<number>`COALESCE(SUM(${productionOrderStagesTable.wasteQty}),0)::float`,
        })
        .from(productionOrderStagesTable)
        .innerJoin(
          productionOrdersTable,
          eq(productionOrdersTable.id, productionOrderStagesTable.orderId),
        )
        .where(and(...stageConds))
        .groupBy(productionOrderStagesTable.operatorUserId);
    } catch (e: any) {
      // Don't fail the whole report when the stages source breaks —
      // a partial report (waste + qc only) is more useful than a 500.
      failedSources.push("stages");
      req.log?.error?.(
        { err: e, source: "stages" },
        "operators/performance: stages query failed, continuing with empty stage data",
      );
    }

    // ── Waste records: events, qty, cost — anchored on createdAt ───────────
    const wasteConds = [eq(productionOrdersTable.companyId, cid)];
    if (from)
      wasteConds.push(sql`${productionWasteRecordsTable.createdAt} >= ${from}`);
    if (to)
      wasteConds.push(
        sql`${productionWasteRecordsTable.createdAt} < (${to}::date + interval '1 day')`,
      );
    if (branchScope.cond) wasteConds.push(branchScope.cond);
    wasteConds.push(sql`${productionWasteRecordsTable.operatorUserId} IS NOT NULL`);

    let wasteRows: Array<{
      operatorUserId: number | null;
      wasteEvents: number;
      wasteQty: number;
      wasteCost: number;
    }> = [];
    try {
      wasteRows = await db
        .select({
          operatorUserId: productionWasteRecordsTable.operatorUserId,
          wasteEvents: sql<number>`COUNT(*)::int`,
          wasteQty: sql<number>`COALESCE(SUM(${productionWasteRecordsTable.qty}),0)::float`,
          wasteCost: sql<number>`COALESCE(SUM(${productionWasteRecordsTable.costImpact}),0)::float`,
        })
        .from(productionWasteRecordsTable)
        .innerJoin(
          productionOrdersTable,
          eq(productionOrdersTable.id, productionWasteRecordsTable.orderId),
        )
        .where(and(...wasteConds))
        .groupBy(productionWasteRecordsTable.operatorUserId);
    } catch (e: any) {
      failedSources.push("waste");
      req.log?.error?.(
        { err: e, source: "waste" },
        "operators/performance: waste query failed, continuing with empty waste data",
      );
    }

    // ── QC fails attributed to operator via stage.operatorUserId ───────────
    // We join QC → stage (the operator field lives on the stage, not on the
    // check), so checks without a stageId or without an operator are not
    // attributed to anyone — that's by design.
    const qcConds = [eq(productionQualityChecksTable.companyId, cid)];
    if (from)
      qcConds.push(sql`${productionQualityChecksTable.checkedAt} >= ${from}`);
    if (to)
      qcConds.push(
        sql`${productionQualityChecksTable.checkedAt} < (${to}::date + interval '1 day')`,
      );
    if (branchScope.cond) qcConds.push(branchScope.cond);
    qcConds.push(sql`${productionOrderStagesTable.operatorUserId} IS NOT NULL`);

    let qcRows: Array<{
      operatorUserId: number | null;
      qcChecks: number;
      qcFails: number;
      qcConditionals: number;
    }> = [];
    try {
      qcRows = await db
        .select({
          operatorUserId: productionOrderStagesTable.operatorUserId,
          qcChecks: sql<number>`COUNT(*)::int`,
          qcFails: sql<number>`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'fail')::int`,
          qcConditionals: sql<number>`COUNT(*) FILTER (WHERE ${productionQualityChecksTable.result} = 'conditional')::int`,
        })
        .from(productionQualityChecksTable)
        .innerJoin(
          productionOrderStagesTable,
          eq(productionOrderStagesTable.id, productionQualityChecksTable.stageId),
        )
        .innerJoin(
          productionOrdersTable,
          eq(productionOrdersTable.id, productionQualityChecksTable.orderId),
        )
        .where(and(...qcConds))
        .groupBy(productionOrderStagesTable.operatorUserId);
    } catch (e: any) {
      failedSources.push("qc");
      req.log?.error?.(
        { err: e, source: "qc" },
        "operators/performance: qc query failed, continuing with empty qc data",
      );
    }

    // ── Merge in JS keyed by operatorUserId ────────────────────────────────
    type Row = {
      operatorUserId: number;
      operatorName: string | null;
      stagesTotal: number;
      stagesCompleted: number;
      avgDurationMins: number;
      stagesWithDuration: number;
      totalOutput: number;
      stageWasteQty: number;
      wasteEvents: number;
      wasteQty: number;
      wasteCost: number;
      qcChecks: number;
      qcFails: number;
      qcConditionals: number;
      wasteRatePct: number;
      qcFailRatePct: number;
    };
    const map = new Map<number, Row>();
    const ensure = (uid: number | null): Row | null => {
      if (uid == null) return null;
      let r = map.get(uid);
      if (!r) {
        r = {
          operatorUserId: uid,
          operatorName: null,
          stagesTotal: 0,
          stagesCompleted: 0,
          avgDurationMins: 0,
          stagesWithDuration: 0,
          totalOutput: 0,
          stageWasteQty: 0,
          wasteEvents: 0,
          wasteQty: 0,
          wasteCost: 0,
          qcChecks: 0,
          qcFails: 0,
          qcConditionals: 0,
          wasteRatePct: 0,
          qcFailRatePct: 0,
        };
        map.set(uid, r);
      }
      return r;
    };
    for (const s of stageRows) {
      const r = ensure(s.operatorUserId);
      if (!r) continue;
      r.stagesTotal = Number(s.stagesTotal) || 0;
      r.stagesCompleted = Number(s.stagesCompleted) || 0;
      r.avgDurationMins = Number(s.avgDurationMins) || 0;
      r.stagesWithDuration = Number(s.stagesWithDuration) || 0;
      r.totalOutput = Number(s.totalOutput) || 0;
      r.stageWasteQty = Number(s.stageWasteQty) || 0;
    }
    for (const w of wasteRows) {
      const r = ensure(w.operatorUserId);
      if (!r) continue;
      r.wasteEvents = Number(w.wasteEvents) || 0;
      r.wasteQty = Number(w.wasteQty) || 0;
      r.wasteCost = Number(w.wasteCost) || 0;
    }
    for (const q of qcRows) {
      const r = ensure(q.operatorUserId);
      if (!r) continue;
      r.qcChecks = Number(q.qcChecks) || 0;
      r.qcFails = Number(q.qcFails) || 0;
      r.qcConditionals = Number(q.qcConditionals) || 0;
    }
    // Derived: waste rate uses the LARGER of stage-tracked vs record-tracked
    // waste so operators aren't under-attributed when one channel is empty.
    for (const r of map.values()) {
      const effectiveWaste = Math.max(r.stageWasteQty, r.wasteQty);
      const denom = r.totalOutput + effectiveWaste;
      r.wasteRatePct = denom > 0 ? (effectiveWaste / denom) * 100 : 0;
      r.qcFailRatePct =
        r.qcChecks > 0 ? (r.qcFails / r.qcChecks) * 100 : 0;
    }

    // ── Resolve operator names in one query ────────────────────────────────
    // NOTE: usersTable has NO `name` column — only `nameAr`, `nameEn`,
    // `username`. Selecting `usersTable.name` here makes the field value
    // `undefined`, which crashes Drizzle's orderSelectedFields with
    // `TypeError: Cannot convert undefined or null to object`. That was
    // the actual root cause of the prod-only 500 (local skipped this branch
    // because ids.length===0 with no operator data).
    const ids = [...map.keys()];
    if (ids.length > 0) {
      try {
        const users = await db
          .select({
            id: usersTable.id,
            operatorName: sql<
              string | null
            >`COALESCE(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
          })
          .from(usersTable)
          .where(inArray(usersTable.id, ids));
        for (const u of users) {
          const r = map.get(u.id);
          if (r) r.operatorName = u.operatorName ?? null;
        }
      } catch (e: any) {
        failedSources.push("users");
        req.log?.error?.(
          { err: e, source: "users", idsCount: ids.length },
          "operators/performance: user-name lookup failed, returning rows without names",
        );
      }
    }

    // Sort by stagesCompleted desc, then output desc (most productive first).
    const allOperators = [...map.values()].sort(
      (a, b) =>
        b.stagesCompleted - a.stagesCompleted ||
        b.totalOutput - a.totalOutput,
    );

    // Round 13 — Company-wide rollup MUST be computed from the unfiltered
    // set so the personal page can show a "you vs company avg" comparison
    // even when operatorUserId narrows the visible rows.
    const totals = allOperators.reduce(
      (acc, r) => ({
        operators: acc.operators + 1,
        stagesCompleted: acc.stagesCompleted + r.stagesCompleted,
        totalOutput: acc.totalOutput + r.totalOutput,
        totalWaste: acc.totalWaste + Math.max(r.stageWasteQty, r.wasteQty),
        totalWasteCost: acc.totalWasteCost + r.wasteCost,
        qcChecks: acc.qcChecks + r.qcChecks,
        qcFails: acc.qcFails + r.qcFails,
      }),
      {
        operators: 0,
        stagesCompleted: 0,
        totalOutput: 0,
        totalWaste: 0,
        totalWasteCost: 0,
        qcChecks: 0,
        qcFails: 0,
      },
    );

    // Round 13 fix (architect) — Privacy + math corrections.
    //
    // Privacy: when a non-privileged user is clamped to self, returning
    // `totals` + `companyAvg` lets them subtract their own row and infer
    // colleagues' KPIs (an aggregate side-channel). For non-privileged
    // callers we enforce a k-anonymity floor: company-wide aggregates are
    // only returned when at least K_ANON other operators exist in scope
    // (so subtracting self still leaves K_ANON−1 ≥ 4 unknowns).
    //
    // Math:
    //  - avgQcFailRatePct: POOLED (totalQcFails / totalQcChecks) so
    //    operators with many checks weight more — replaces the previous
    //    unweighted mean of per-operator rates.
    //  - avgDurationMins: weighted by stagesWithDuration (number of
    //    stage samples each operator contributed), so an operator with 1
    //    sample doesn't equal one with 100.
    //  - avgWasteRatePct kept as unweighted operator-mean (already
    //    reasonable for "per-operator typical waste").
    const K_ANON = 5;
    const includeAggregates =
      isPrivileged || allOperators.length >= K_ANON;

    let companyAvg: {
      avgStagesCompleted: number;
      avgOutput: number;
      avgWasteRatePct: number;
      avgQcFailRatePct: number;
      avgDurationMins: number;
      operatorCount: number;
    } | null = null;
    if (includeCompanyAvg && includeAggregates && allOperators.length > 0) {
      const n = allOperators.length;
      const sumWasteRate = allOperators.reduce(
        (s, r) => s + r.wasteRatePct,
        0,
      );
      const totalDurationSamples = allOperators.reduce(
        (s, r) => s + r.stagesWithDuration,
        0,
      );
      const weightedDurSum = allOperators.reduce(
        (s, r) => s + r.avgDurationMins * r.stagesWithDuration,
        0,
      );
      companyAvg = {
        avgStagesCompleted: totals.stagesCompleted / n,
        avgOutput: totals.totalOutput / n,
        avgWasteRatePct: sumWasteRate / n,
        avgQcFailRatePct:
          totals.qcChecks > 0 ? (totals.qcFails / totals.qcChecks) * 100 : 0,
        avgDurationMins:
          totalDurationSamples > 0 ? weightedDurSum / totalDurationSamples : 0,
        operatorCount: n,
      };
    }

    const operators =
      operatorFilter != null
        ? allOperators.filter((r) => r.operatorUserId === operatorFilter)
        : allOperators;

    res.json({
      operators,
      totals: includeAggregates ? totals : null,
      companyAvg,
      ...(failedSources.length > 0
        ? { partial: true, failedSources }
        : {}),
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "operators/performance failed");
    // Don't leak raw SQL / driver text to the client — the full error is
    // already in the server log via req.log.error above.
    res.status(500).json({ error: "تعذّر احتساب تقرير أداء المشغّلين" });
  }
});

router.post("/quality-checks", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const orderId = Number(b.orderId);
    if (!orderId) {
      res.status(400).json({ error: "أمر الإنتاج مطلوب" });
      return;
    }
    const checkType = typeof b.checkType === "string" ? b.checkType.trim() : "";
    if (!checkType) {
      res.status(400).json({ error: "نوع الفحص مطلوب" });
      return;
    }
    const result = typeof b.result === "string" ? b.result.trim() : "";
    if (!(QC_RESULTS as readonly string[]).includes(result)) {
      res.status(400).json({
        error: `نتيجة الفحص يجب أن تكون: ${QC_RESULTS.join(" / ")}`,
      });
      return;
    }
    // Verify the order belongs to this company AND falls in the user's
    // branch scope. Round 10 — without the rowInScope check, a branch-
    // restricted user could create QC failures / auto-waste rows on any
    // tenant order by guessing IDs, polluting both the QC report and the
    // Round-9 waste analytics. Mirrors the pattern used elsewhere in this
    // file (e.g. PATCH /orders, POST /orders/:id/waste-records).
    const [ord] = await db
      .select({ id: productionOrdersTable.id, branchId: productionOrdersTable.branchId })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, orderId),
          eq(productionOrdersTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!ord) {
      res.status(404).json({ error: "أمر الإنتاج غير موجود" });
      return;
    }
    if (!rowInScope(req, ord.branchId)) {
      res.status(403).json({ error: "أمر الإنتاج خارج نطاق الفرع المسموح" });
      return;
    }
    let stageId: number | null = null;
    if (b.stageId != null && b.stageId !== "") {
      const sid = Number(b.stageId);
      if (!Number.isInteger(sid) || sid <= 0) {
        res.status(400).json({ error: "معرّف المرحلة غير صحيح" });
        return;
      }
      const [st] = await db
        .select({ id: productionOrderStagesTable.id })
        .from(productionOrderStagesTable)
        .where(
          and(
            eq(productionOrderStagesTable.id, sid),
            eq(productionOrderStagesTable.orderId, orderId),
          ),
        )
        .limit(1);
      if (!st) {
        res.status(400).json({ error: "المرحلة غير تابعة لهذا الأمر" });
        return;
      }
      stageId = sid;
    }
    const defectsRaw = b.defectsFound == null || b.defectsFound === "" ? 0 : Number(b.defectsFound);
    if (!Number.isFinite(defectsRaw) || !Number.isInteger(defectsRaw) || defectsRaw < 0) {
      res.status(400).json({ error: "عدد العيوب يجب أن يكون عدداً صحيحاً ≥ 0" });
      return;
    }
    const defectsFound = defectsRaw;
    let sampleSize: number | null = null;
    if (b.sampleSize != null && b.sampleSize !== "") {
      const s = Number(b.sampleSize);
      if (!Number.isFinite(s) || !Number.isInteger(s) || s < 0) {
        res.status(400).json({ error: "حجم العينة يجب أن يكون عدداً صحيحاً ≥ 0" });
        return;
      }
      sampleSize = s;
    }
    // Round 10 — Optional QC-fail → waste-record bridge. When the operator
    // marks a check as `fail` (or `conditional`) and ticks "تسجيل كهالك", we
    // create a `production_waste_records` row in the same DB transaction so
    // the failure shows up in the Round-9 waste report immediately and is
    // attributed to the same stage. No accounting JE is posted here — the
    // financial impact of scrap is still booked at completion via the
    // existing `wasteAccountId` JE line. wasteType must validate against the
    // shared enum; bad values reject the WHOLE request (atomicity).
    let autoWaste: { qty: number; wasteType: string; reason: string | null; costImpact: number; unitCode: string } | null = null;
    if (b.createWasteRecord === true && result !== "pass") {
      const wq = Number(b.wasteQty ?? 0);
      if (!(wq > 0)) {
        res.status(400).json({ error: "كمية الهالك (wasteQty) مطلوبة وأكبر من صفر عند تسجيل كهالك" });
        return;
      }
      const wt = String(b.wasteType ?? "").trim();
      if (!(PRODUCTION_WASTE_TYPES as readonly string[]).includes(wt)) {
        res.status(400).json({
          error: `نوع الهالك غير صحيح. المسموح: ${PRODUCTION_WASTE_TYPES.join(", ")}`,
        });
        return;
      }
      const wc = Number(b.wasteCostImpact ?? 0);
      autoWaste = {
        qty: wq,
        wasteType: wt,
        reason:
          typeof b.wasteReason === "string" && b.wasteReason.trim()
            ? b.wasteReason.trim()
            : typeof b.notes === "string" && b.notes.trim()
              ? b.notes.trim()
              : null,
        costImpact: Number.isFinite(wc) && wc >= 0 ? wc : 0,
        unitCode: typeof b.wasteUnitCode === "string" && b.wasteUnitCode ? b.wasteUnitCode : "PCE",
      };
    }
    const { row, wasteRow } = await db.transaction(async (tx) => {
      const [qcRow] = await tx
        .insert(productionQualityChecksTable)
        .values({
          companyId: cid,
          orderId,
          stageId,
          checkType,
          result,
          measuredValue:
            typeof b.measuredValue === "string" && b.measuredValue.trim()
              ? b.measuredValue.trim()
              : null,
          expectedValue:
            typeof b.expectedValue === "string" && b.expectedValue.trim()
              ? b.expectedValue.trim()
              : null,
          sampleSize: sampleSize != null && sampleSize >= 0 ? sampleSize : null,
          defectsFound: defectsFound >= 0 ? defectsFound : 0,
          mediaUrl:
            typeof b.mediaUrl === "string" && b.mediaUrl.trim()
              ? b.mediaUrl.trim()
              : null,
          notes:
            typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
          checkedByUserId: req.authUser?.id ?? null,
        })
        .returning();
      let w: any = null;
      if (autoWaste) {
        const [inserted] = await tx
          .insert(productionWasteRecordsTable)
          .values({
            companyId: cid,
            orderId,
            stageId,
            wasteType: autoWaste.wasteType,
            reason: autoWaste.reason,
            qty: String(autoWaste.qty),
            unitCode: autoWaste.unitCode,
            costImpact: String(autoWaste.costImpact),
            notes: `تم إنشاؤه تلقائياً من فحص جودة #${qcRow.id}`,
            createdBy: req.authUser?.id ?? null,
          })
          .returning();
        w = inserted;
      }
      return { row: qcRow, wasteRow: w };
    });
    await writeEvent(
      cid,
      orderId,
      `qc.${result}`,
      { checkId: row.id, checkType, stageId, defectsFound, wasteRecordId: wasteRow?.id ?? null },
      req.authUser?.id ?? null,
    );
    res.status(201).json({
      ...row,
      wasteRecord: wasteRow,
      // Round 11 — Surface a hint to the UI when a failed check is bound
      // to a stage; the operator can then re-open that stage in one click
      // via POST /quality-checks/:id/reopen-stage. We do NOT auto-flip the
      // stage (manual adjudication is the documented QC policy).
      stageNeedsReopen: result === "fail" && stageId != null,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "qc create failed");
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.patch("/quality-checks/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    // Round 10 — Join to parent order so we can enforce branch scope on
    // updates. Without this, a branch-restricted user could mutate any QC
    // row by guessing IDs (same class of bypass as the POST path).
    const [existingRow] = await db
      .select({
        qc: productionQualityChecksTable,
        orderBranchId: productionOrdersTable.branchId,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionOrdersTable.id, productionQualityChecksTable.orderId),
      )
      .where(
        and(
          eq(productionQualityChecksTable.id, id),
          eq(productionQualityChecksTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existingRow) {
      res.status(404).json({ error: "الفحص غير موجود" });
      return;
    }
    if (!rowInScope(req, existingRow.orderBranchId)) {
      res.status(403).json({ error: "الفحص خارج نطاق الفرع المسموح" });
      return;
    }
    const existing = existingRow.qc;
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b.result === "string") {
      if (!(QC_RESULTS as readonly string[]).includes(b.result)) {
        res.status(400).json({ error: "نتيجة فحص غير صحيحة" });
        return;
      }
      patch.result = b.result;
    }
    if (typeof b.notes === "string") patch.notes = b.notes.trim() || null;
    if (typeof b.measuredValue === "string")
      patch.measuredValue = b.measuredValue.trim() || null;
    if (typeof b.expectedValue === "string")
      patch.expectedValue = b.expectedValue.trim() || null;
    if (b.defectsFound != null) {
      const d = Number(b.defectsFound);
      if (!Number.isFinite(d) || d < 0) {
        res.status(400).json({ error: "عدد العيوب غير صحيح" });
        return;
      }
      patch.defectsFound = d;
    }
    if (Object.keys(patch).length === 0) {
      res.json(existing);
      return;
    }
    const [row] = await db
      .update(productionQualityChecksTable)
      .set(patch)
      .where(
        and(
          eq(productionQualityChecksTable.id, id),
          eq(productionQualityChecksTable.companyId, cid),
        ),
      )
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete("/quality-checks/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    // Round 10 — Same branch-scope gate as PATCH. Resolve the parent order
    // first so we can 403 out-of-scope IDs instead of silently deleting.
    const [existingRow] = await db
      .select({
        qcId: productionQualityChecksTable.id,
        orderBranchId: productionOrdersTable.branchId,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionOrdersTable.id, productionQualityChecksTable.orderId),
      )
      .where(
        and(
          eq(productionQualityChecksTable.id, id),
          eq(productionQualityChecksTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existingRow) {
      res.status(404).json({ error: "الفحص غير موجود" });
      return;
    }
    if (!rowInScope(req, existingRow.orderBranchId)) {
      res.status(403).json({ error: "الفحص خارج نطاق الفرع المسموح" });
      return;
    }
    await db
      .delete(productionQualityChecksTable)
      .where(
        and(
          eq(productionQualityChecksTable.id, id),
          eq(productionQualityChecksTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Round 11 — Re-open the stage tied to a failed QC. Manual one-click action
// (no auto-flip on QC create). Only acts when QC.result === 'fail' and a
// stageId is bound; flips the stage from 'done' back to 'in_progress' and
// clears completedAt. Idempotent: if the stage is already 'in_progress' or
// 'pending', returns the current row without re-writing it.
router.post("/quality-checks/:id/reopen-stage", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db
      .select({
        qc: productionQualityChecksTable,
        orderBranchId: productionOrdersTable.branchId,
      })
      .from(productionQualityChecksTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionOrdersTable.id, productionQualityChecksTable.orderId),
      )
      .where(
        and(
          eq(productionQualityChecksTable.id, id),
          eq(productionQualityChecksTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "الفحص غير موجود" });
      return;
    }
    if (!rowInScope(req, row.orderBranchId)) {
      res.status(403).json({ error: "الفحص خارج نطاق الفرع المسموح" });
      return;
    }
    const qc = row.qc;
    if (qc.result !== "fail") {
      res
        .status(400)
        .json({ error: "إعادة فتح المرحلة متاحة فقط للفحوص الفاشلة" });
      return;
    }
    if (qc.stageId == null) {
      res.status(400).json({ error: "هذا الفحص غير مرتبط بأي مرحلة" });
      return;
    }
    const [stage] = await db
      .select()
      .from(productionOrderStagesTable)
      .where(
        and(
          eq(productionOrderStagesTable.id, qc.stageId),
          eq(productionOrderStagesTable.orderId, qc.orderId),
        ),
      )
      .limit(1);
    if (!stage) {
      res.status(404).json({ error: "المرحلة غير موجودة" });
      return;
    }
    if (stage.status === "in_progress" || stage.status === "pending") {
      // Already open — idempotent no-op.
      res.json({ ok: true, stage, alreadyOpen: true });
      return;
    }
    const [updated] = await db
      .update(productionOrderStagesTable)
      .set({ status: "in_progress", completedAt: null })
      .where(eq(productionOrderStagesTable.id, qc.stageId))
      .returning();
    await writeEvent(
      cid,
      qc.orderId,
      "stage.reopened_from_qc",
      {
        stageId: qc.stageId,
        qcId: qc.id,
        previousStatus: stage.status,
      },
      req.authUser?.id ?? null,
    );
    res.json({ ok: true, stage: updated, alreadyOpen: false });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "qc reopen-stage failed");
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE D — Waste Records (سجلّات التالف)
// ─────────────────────────────────────────────────────────────────────────
// Detailed scrap log per production order. See schema comment for design
// notes. CRUD only — no JE posting (the wasteAccount JE line at completion
// already books the financial impact).
async function assertOrderInScope(req: any, cid: number, orderId: number) {
  const [o] = await db
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
  if (!o) return { ok: false as const, error: "أمر الإنتاج غير موجود", status: 404 };
  if (!rowInScope(req, o.branchId))
    return { ok: false as const, error: "لا يمكنك العمل على هذا الفرع", status: 403 };
  return { ok: true as const };
}

router.get("/orders/:id/waste-records", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = Number(req.params.id);
    const scope = await assertOrderInScope(req, cid, orderId);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const rows = await db
      .select()
      .from(productionWasteRecordsTable)
      .where(
        and(
          eq(productionWasteRecordsTable.companyId, cid),
          eq(productionWasteRecordsTable.orderId, orderId),
        ),
      )
      .orderBy(desc(productionWasteRecordsTable.createdAt));
    // Group totals by type for the analytics tile.
    const byType: Record<string, { qty: number; cost: number; count: number }> = {};
    for (const r of rows) {
      const k = r.wasteType;
      const t = byType[k] ?? { qty: 0, cost: 0, count: 0 };
      t.qty += Number(r.qty);
      t.cost += Number(r.costImpact);
      t.count += 1;
      byType[k] = t;
    }
    res.json({ records: rows, summary: { byType, totalCount: rows.length } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders/:id/waste-records", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = Number(req.params.id);
    const scope = await assertOrderInScope(req, cid, orderId);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const b = req.body ?? {};
    const wasteType = String(b.wasteType ?? "").trim();
    if (!(PRODUCTION_WASTE_TYPES as readonly string[]).includes(wasteType)) {
      res.status(400).json({ error: `نوع التالف غير صحيح. القيم المسموحة: ${PRODUCTION_WASTE_TYPES.join(", ")}` });
      return;
    }
    const qty = Number(b.qty ?? 0);
    if (!(qty > 0)) {
      res.status(400).json({ error: "الكمية يجب أن تكون أكبر من صفر" });
      return;
    }
    // PHASE D — Validate FK ownership so a guessed/forged ID from another
    // tenant cannot be attached to this company's waste record.
    const stageId = b.stageId ? Number(b.stageId) : null;
    const resourceId = b.resourceId ? Number(b.resourceId) : null;
    const workCenterId = b.workCenterId ? Number(b.workCenterId) : null;
    if (stageId) {
      const [s] = await db
        .select({ id: productionOrderStagesTable.id })
        .from(productionOrderStagesTable)
        .where(and(eq(productionOrderStagesTable.id, stageId), eq(productionOrderStagesTable.orderId, orderId)))
        .limit(1);
      if (!s) { res.status(400).json({ error: "المرحلة المحددة لا تخص هذا الأمر" }); return; }
    }
    if (resourceId) {
      const [r] = await db
        .select({ id: productionResourcesTable.id })
        .from(productionResourcesTable)
        .where(and(eq(productionResourcesTable.id, resourceId), eq(productionResourcesTable.companyId, cid)))
        .limit(1);
      if (!r) { res.status(400).json({ error: "المورد المحدد لا يخص هذه الشركة" }); return; }
    }
    if (workCenterId) {
      const [w] = await db
        .select({ id: workCentersTable.id })
        .from(workCentersTable)
        .where(and(eq(workCentersTable.id, workCenterId), eq(workCentersTable.companyId, cid)))
        .limit(1);
      if (!w) { res.status(400).json({ error: "مركز العمل المحدد لا يخص هذه الشركة" }); return; }
    }
    const [row] = await db
      .insert(productionWasteRecordsTable)
      .values({
        companyId: cid,
        orderId,
        stageId: b.stageId ? Number(b.stageId) : null,
        wasteType,
        reason: typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null,
        qty: String(qty),
        unitCode: typeof b.unitCode === "string" && b.unitCode ? b.unitCode : "PCE",
        costImpact: String(Number(b.costImpact ?? 0)),
        resourceId: b.resourceId ? Number(b.resourceId) : null,
        workCenterId: b.workCenterId ? Number(b.workCenterId) : null,
        operatorUserId: b.operatorUserId ? Number(b.operatorUserId) : null,
        notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
        createdBy: (req as any).user?.id ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/orders/:orderId/waste-records/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const orderId = Number(req.params.orderId);
    const id = Number(req.params.id);
    const scope = await assertOrderInScope(req, cid, orderId);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const result = await db
      .delete(productionWasteRecordsTable)
      .where(
        and(
          eq(productionWasteRecordsTable.id, id),
          eq(productionWasteRecordsTable.companyId, cid),
          eq(productionWasteRecordsTable.orderId, orderId),
        ),
      )
      .returning({ id: productionWasteRecordsTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "السجل غير موجود" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PHASE E — Issue Preview ────────────────────────────────────────────────
// Returns the per-batch allocation that WOULD be made if the operator clicked
// "بدء التشغيل" right now. Pure read endpoint — does not mutate any state.
// Used by the production order detail UI to show a "سيتم سحب من التشغيلات
// التالية" preview before confirming the issue. Per-item modes:
//   * none → returns a single virtual pick representing the WAC issue (legacy)
//   * fifo/fefo → returns the actual ordered batches pickBatches() would use
router.get("/orders/:id/issue-preview", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const scope = await assertOrderInScope(req, cid, id);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const [order] = await db
      .select()
      .from(productionOrdersTable)
      .where(and(eq(productionOrdersTable.id, id), eq(productionOrdersTable.companyId, cid)));
    if (!order) { res.status(404).json({ error: "أمر الإنتاج غير موجود" }); return; }
    if (!order.rawWarehouseId) {
      res.status(400).json({ error: "حدّد مخزن الخامات قبل عرض المعاينة" });
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
    const issuable = rawLines.filter((l) => l.itemId && Number(l.quantity) > 0);
    const itemIds = issuable.map((l) => l.itemId!);
    const itemRows = itemIds.length
      ? await db
          .select({
            id: itemsTable.id,
            mode: itemsTable.batchTrackingMode,
            nameAr: itemsTable.nameAr,
            code: itemsTable.code,
          })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, itemIds)))
      : [];
    const meta = new Map<number, { mode: "none"|"fifo"|"fefo"; nameAr: string; code: string }>();
    for (const r of itemRows) {
      const m = (r.mode ?? "none") as string;
      meta.set(r.id, {
        mode: (m === "fifo" || m === "fefo" ? m : "none") as "none"|"fifo"|"fefo",
        nameAr: r.nameAr ?? "",
        code: r.code ?? "",
      });
    }
    const out: any[] = [];
    for (const ln of issuable) {
      const info = meta.get(ln.itemId!) ?? { mode: "none" as const, nameAr: "", code: "" };
      const qty = Number(ln.quantity);
      if (info.mode === "none") {
        const have = await getBalance(cid, ln.itemId!, order.rawWarehouseId);
        out.push({
          lineId: ln.id,
          itemId: ln.itemId,
          itemNameAr: info.nameAr || ln.description,
          itemCode: info.code,
          mode: "none",
          requestedQty: qty,
          available: have,
          shortfall: Math.max(0, qty - have),
          picks: [{ batchNumber: null, expiryDate: null, takeQty: qty, note: "WAC (بدون تتبّع تشغيلات)" }],
        });
        continue;
      }
      try {
        const picks = await pickBatches(cid, ln.itemId!, order.rawWarehouseId, qty, info.mode);
        out.push({
          lineId: ln.id,
          itemId: ln.itemId,
          itemNameAr: info.nameAr || ln.description,
          itemCode: info.code,
          mode: info.mode,
          requestedQty: qty,
          available: picks.reduce((s, p) => s + p.takeQty, 0),
          shortfall: 0,
          picks: picks.map((p) => ({
            batchNumber: p.batchNumber,
            expiryDate: p.expiryDate,
            takeQty: p.takeQty,
            costPrice: p.costPrice,
          })),
        });
      } catch (e: any) {
        // Not enough stock across batches — return partial info so the UI
        // can warn the operator without blocking the preview.
        const have = await getBalance(cid, ln.itemId!, order.rawWarehouseId);
        out.push({
          lineId: ln.id,
          itemId: ln.itemId,
          itemNameAr: info.nameAr || ln.description,
          itemCode: info.code,
          mode: info.mode,
          requestedQty: qty,
          available: have,
          shortfall: Math.max(0, qty - have),
          picks: [],
          error: e?.message || "تعذّر حساب التوزيع",
        });
      }
    }
    res.json({ lines: out });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Company-wide aggregated scrap report for the dashboard.
// Branch-scoped: joins to `production_orders` and reuses the same
// `effectiveBranchCondition` semantics as other tenant endpoints so a
// user restricted to branch X never sees waste tonnage from branch Y.
router.get("/waste-records/summary", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const conditions = [eq(productionWasteRecordsTable.companyId, cid)];
    if (from) conditions.push(sql`${productionWasteRecordsTable.createdAt} >= ${from}`);
    if (to) conditions.push(sql`${productionWasteRecordsTable.createdAt} < (${to}::date + interval '1 day')`);
    // Round 9 — optional `wasteType` (CSV) filter so users can isolate one
    // or more loss categories (e.g. only burn+break). Unknown values are
    // silently dropped to avoid leaking enum validation through the filter.
    const wasteTypeRaw = typeof req.query.wasteType === "string" ? req.query.wasteType : "";
    const wasteTypes = wasteTypeRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => (PRODUCTION_WASTE_TYPES as readonly string[]).includes(s));
    if (wasteTypes.length > 0) {
      conditions.push(inArray(productionWasteRecordsTable.wasteType, wasteTypes));
    }
    // Round 9 — optional free-text reason search (case-insensitive contains).
    // Matches against the operator-entered root cause text, not the type enum.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      conditions.push(sql`${productionWasteRecordsTable.reason} ILIKE ${"%" + q + "%"}`);
    }
    // Branch isolation — restricted users only aggregate orders in their
    // assigned branches. NULL-branch orders are shared/company-wide per
    // the project-wide `effectiveBranchCondition` convention.
    const branchScope = effectiveBranchCondition(req, productionOrdersTable.branchId, req.query.branchId);
    if (branchScope.deny) { res.json({ byType: [], wasteTypes: PRODUCTION_WASTE_TYPES }); return; }
    if (branchScope.cond) conditions.push(branchScope.cond);
    const rows = await db
      .select({
        wasteType: productionWasteRecordsTable.wasteType,
        totalQty: sql<string>`COALESCE(SUM(${productionWasteRecordsTable.qty}), 0)`,
        totalCost: sql<string>`COALESCE(SUM(${productionWasteRecordsTable.costImpact}), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(productionWasteRecordsTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionWasteRecordsTable.orderId, productionOrdersTable.id),
      )
      .where(and(...conditions))
      .groupBy(productionWasteRecordsTable.wasteType)
      .orderBy(sql`SUM(${productionWasteRecordsTable.costImpact}) DESC`);
    res.json({ byType: rows, wasteTypes: PRODUCTION_WASTE_TYPES });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Round 9 — top free-text reasons aggregator. Reasons are user-entered root
// causes (not the bounded `wasteType` enum). Trims + lowercases for grouping
// so "Bag tear" and "bag tear " collapse into one bucket. Filters and branch
// scope mirror /waste-records/summary so the two cards on the report page
// stay consistent.
router.get("/waste-records/by-reason", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const conditions = [
      eq(productionWasteRecordsTable.companyId, cid),
      sql`${productionWasteRecordsTable.reason} IS NOT NULL`,
      sql`length(trim(${productionWasteRecordsTable.reason})) > 0`,
    ];
    if (from) conditions.push(sql`${productionWasteRecordsTable.createdAt} >= ${from}`);
    if (to) conditions.push(sql`${productionWasteRecordsTable.createdAt} < (${to}::date + interval '1 day')`);
    const wasteTypeRaw = typeof req.query.wasteType === "string" ? req.query.wasteType : "";
    const wasteTypes = wasteTypeRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => (PRODUCTION_WASTE_TYPES as readonly string[]).includes(s));
    if (wasteTypes.length > 0) {
      conditions.push(inArray(productionWasteRecordsTable.wasteType, wasteTypes));
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      conditions.push(sql`${productionWasteRecordsTable.reason} ILIKE ${"%" + q + "%"}`);
    }
    const branchScope = effectiveBranchCondition(req, productionOrdersTable.branchId, req.query.branchId);
    if (branchScope.deny) { res.json([]); return; }
    if (branchScope.cond) conditions.push(branchScope.cond);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const rows = await db
      .select({
        reason: sql<string>`lower(trim(${productionWasteRecordsTable.reason}))`,
        totalQty: sql<string>`COALESCE(SUM(${productionWasteRecordsTable.qty}), 0)`,
        totalCost: sql<string>`COALESCE(SUM(${productionWasteRecordsTable.costImpact}), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(productionWasteRecordsTable)
      .innerJoin(
        productionOrdersTable,
        eq(productionWasteRecordsTable.orderId, productionOrdersTable.id),
      )
      .where(and(...conditions))
      .groupBy(sql`lower(trim(${productionWasteRecordsTable.reason}))`)
      .orderBy(sql`SUM(${productionWasteRecordsTable.costImpact}) DESC`)
      .limit(limit);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE F — Batch Traceability / Genealogy
//
// Two read-only endpoints that reconstruct the lot genealogy from
// `stock_ledger`. We don't materialise a separate genealogy table —
// every issue/receipt row already carries (batch_number, expiry_date,
// ref_id = production_order.id, ref_type = 'production_order'), so a
// few JOINs give an exact answer.
//
// Downstream (order → raws consumed):
//   GET /api/production/orders/:id/traceability
//
// Upstream / recall (raw batch → every FG it flowed into):
//   GET /api/production/trace-by-batch?batchNumber=&itemId=
//
// Both endpoints are guarded by company + branch scope; raw-batch
// recall is intentionally NOT restricted by item so an operator can
// search for a poisoned supplier batch even when they don't know
// which SKU it sits under (itemId is optional and narrows the search).
// ─────────────────────────────────────────────────────────────────────────
router.get("/orders/:id/traceability", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const scope = await assertOrderInScope(req, cid, id);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const [order] = await db
      .select()
      .from(productionOrdersTable)
      .where(and(eq(productionOrdersTable.id, id), eq(productionOrdersTable.companyId, cid)));
    if (!order) { res.status(404).json({ error: "أمر الإنتاج غير موجود" }); return; }

    // a) FG side — every production_receipt row for this order (one per
    //    completion; usually just one, but the schema doesn't forbid more).
    const fgRows = await db.execute(sql`
      SELECT
        sl.id, sl.tx_date AS "txDate", sl.qty, sl.cost_price AS "costPrice",
        sl.total_cost AS "totalCost", sl.batch_number AS "batchNumber",
        sl.expiry_date AS "expiryDate", sl.warehouse_id AS "warehouseId",
        sl.item_id AS "itemId",
        i.code AS "itemCode", i.name_ar AS "itemNameAr", i.name_en AS "itemNameEn",
        w.name_ar AS "warehouseName"
      FROM stock_ledger sl
      JOIN items i ON i.id = sl.item_id
      LEFT JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.company_id = ${cid}
        AND sl.ref_type   = 'production_order'
        AND sl.ref_id     = ${id}
        AND sl.tx_type    = 'production_receipt'
      ORDER BY sl.tx_date ASC, sl.id ASC
    `);

    // b) Raw side — every production_issue row consumed by this order,
    //    grouped by (item, batch, expiry) so two ledger rows from the same
    //    batch/expiry merge into one genealogy entry.
    const rawRows = await db.execute(sql`
      SELECT
        sl.item_id    AS "itemId",
        i.code        AS "itemCode",
        i.name_ar     AS "itemNameAr",
        i.name_en     AS "itemNameEn",
        sl.batch_number AS "batchNumber",
        sl.expiry_date  AS "expiryDate",
        SUM(-sl.qty)::numeric        AS "qty",
        SUM(-sl.total_cost)::numeric AS "totalCost",
        MIN(sl.tx_date)              AS "earliestTxDate"
      FROM stock_ledger sl
      JOIN items i ON i.id = sl.item_id
      WHERE sl.company_id = ${cid}
        AND sl.ref_type   = 'production_order'
        AND sl.ref_id     = ${id}
        AND sl.tx_type    = 'production_issue'
      GROUP BY sl.item_id, i.code, i.name_ar, i.name_en, sl.batch_number, sl.expiry_date
      ORDER BY i.name_ar ASC, sl.batch_number ASC NULLS LAST
    `);

    const fg = ((fgRows as any).rows ?? fgRows) as any[];
    const raws = ((rawRows as any).rows ?? rawRows) as any[];
    res.json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        title: order.title,
        status: order.status,
        batchNumber: order.batchNumber,
        qrToken: order.qrToken,
        fgExpiryDate: order.fgExpiryDate,
        productItemId: order.productItemId,
        plannedQty: order.plannedQty,
        producedQty: order.producedQty,
        wasteQty: order.wasteQty,
        rawMaterialsCost: order.rawMaterialsCost,
        laborCost: order.laborCost,
        overheadCost: order.overheadCost,
        actualCost: order.actualCost,
        issueJournalEntryId: order.issueJournalEntryId,
        receiptJournalEntryId: order.receiptJournalEntryId,
      },
      fg: fg.map((r) => ({
        ...r,
        qty: Number(r.qty),
        costPrice: Number(r.costPrice),
        totalCost: Number(r.totalCost),
      })),
      raws: raws.map((r) => ({
        ...r,
        qty: Number(r.qty),
        totalCost: Number(r.totalCost),
        avgCost: Number(r.qty) > 0 ? Number(r.totalCost) / Number(r.qty) : 0,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/trace-by-batch", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const batchNumber = typeof req.query.batchNumber === "string" ? req.query.batchNumber.trim() : "";
    if (!batchNumber) {
      res.status(400).json({ error: "حدّد رقم التشغيلة (batchNumber)" });
      return;
    }
    const itemIdRaw = req.query.itemId;
    const itemId = itemIdRaw != null && itemIdRaw !== "" ? Number(itemIdRaw) : null;

    // Branch isolation — honour `effectiveBranchCondition` against BOTH
    // production_orders.branch_id (for consumedBy) and warehouses.branch_id
    // (for movements), so a branch-restricted operator only sees rows from
    // their assigned branches. NULL-branch rows remain visible per the
    // project-wide convention (shared/company-wide stock).
    const consumedBranchScope = effectiveBranchCondition(
      req,
      productionOrdersTable.branchId,
      req.query.branchId,
    );
    const moveBranchScope = effectiveBranchCondition(
      req,
      warehousesTable.branchId,
      req.query.branchId,
    );
    if (consumedBranchScope.deny && moveBranchScope.deny) {
      res.json({ batchNumber, itemId, consumedBy: [], movements: [] });
      return;
    }

    const itemFilter = itemId && Number.isFinite(itemId)
      ? sql`AND sl.item_id = ${itemId}`
      : sql``;
    const consumedBranchFilter = consumedBranchScope.deny
      ? sql`AND FALSE`
      : consumedBranchScope.cond
        ? sql`AND ${consumedBranchScope.cond}`
        : sql``;
    const moveBranchFilter = moveBranchScope.deny
      ? sql`AND FALSE`
      : moveBranchScope.cond
        ? sql`AND ${moveBranchScope.cond}`
        : sql``;

    // Orders that CONSUMED this batch as raw input.
    const consumedRows = await db.execute(sql`
      SELECT
        po.id            AS "orderId",
        po.order_number  AS "orderNumber",
        po.title         AS "title",
        po.status        AS "status",
        po.batch_number  AS "fgBatch",
        po.fg_expiry_date AS "fgExpiryDate",
        po.product_item_id AS "fgItemId",
        fgi.name_ar      AS "fgItemNameAr",
        fgi.code         AS "fgItemCode",
        sl.item_id       AS "rawItemId",
        i.code           AS "rawItemCode",
        i.name_ar        AS "rawItemNameAr",
        SUM(-sl.qty)::numeric        AS "consumedQty",
        SUM(-sl.total_cost)::numeric AS "consumedCost",
        MIN(sl.tx_date)              AS "issuedOn"
      FROM stock_ledger sl
      JOIN production_orders po ON po.id = sl.ref_id AND po.company_id = sl.company_id
      JOIN items i              ON i.id = sl.item_id
      LEFT JOIN items fgi       ON fgi.id = po.product_item_id
      WHERE sl.company_id = ${cid}
        AND sl.ref_type   = 'production_order'
        AND sl.tx_type    = 'production_issue'
        AND sl.batch_number = ${batchNumber}
        ${itemFilter}
        ${consumedBranchFilter}
      GROUP BY po.id, po.order_number, po.title, po.status, po.batch_number,
               po.fg_expiry_date, po.product_item_id, fgi.name_ar, fgi.code,
               sl.item_id, i.code, i.name_ar
      ORDER BY MIN(sl.tx_date) ASC, po.order_number ASC
    `);

    // Also locate every stock movement of THIS exact batch (in case the
    // batch was directly received/transferred/sold without going through
    // a production order — useful for full forensic trail). Branch-scoped
    // via warehouses.branch_id so restricted operators only see movements
    // in their warehouses.
    const directMoves = await db.execute(sql`
      SELECT
        sl.tx_date AS "txDate", sl.tx_type AS "txType",
        sl.qty, sl.cost_price AS "costPrice", sl.total_cost AS "totalCost",
        sl.warehouse_id AS "warehouseId",
        sl.item_id AS "itemId",
        i.code AS "itemCode", i.name_ar AS "itemNameAr",
        w.name_ar AS "warehouseName",
        sl.ref_type AS "refType", sl.ref_id AS "refId",
        sl.notes
      FROM stock_ledger sl
      JOIN items i ON i.id = sl.item_id
      LEFT JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.company_id = ${cid}
        AND sl.batch_number = ${batchNumber}
        ${itemFilter}
        ${moveBranchFilter}
      ORDER BY sl.tx_date ASC, sl.id ASC
      LIMIT 500
    `);

    const consumed = ((consumedRows as any).rows ?? consumedRows) as any[];
    const moves = ((directMoves as any).rows ?? directMoves) as any[];
    res.json({
      batchNumber,
      itemId,
      consumedBy: consumed.map((r) => ({
        ...r,
        consumedQty: Number(r.consumedQty),
        consumedCost: Number(r.consumedCost),
      })),
      movements: moves.map((r) => ({
        ...r,
        qty: Number(r.qty),
        costPrice: Number(r.costPrice),
        totalCost: Number(r.totalCost),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Round 14 — QC Templates (قوالب فحص الجودة) ───────────────────────────
// Reusable checklists that pre-fill the QC form. Per-product templates are
// auto-suggested in the UI when a QC is being filed against an order that
// produces the matching item; generic templates (productItemId=NULL) are
// always selectable.
//
// Multi-tenant: every endpoint guards companyId. NOT branch-scoped on
// purpose — templates are catalog/master data and apply across branches.
// Items are managed inline via PUT /quality-templates/:id (full replace
// of the items array, simplest correctness model — the editor sends the
// whole list back).

router.get("/quality-templates", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const productItemId = req.query.productItemId
      ? Number(req.query.productItemId)
      : null;
    const activeOnly = req.query.activeOnly === "true";
    const conds = [eq(productionQualityCheckTemplatesTable.companyId, cid)];
    if (activeOnly)
      conds.push(eq(productionQualityCheckTemplatesTable.isActive, true));
    if (productItemId) {
      // Match templates tied to this product OR generic (NULL product).
      conds.push(
        or(
          eq(productionQualityCheckTemplatesTable.productItemId, productItemId),
          sql`${productionQualityCheckTemplatesTable.productItemId} IS NULL`,
        )!,
      );
    }
    const rows = await db
      .select()
      .from(productionQualityCheckTemplatesTable)
      .where(and(...conds))
      .orderBy(
        // Product-specific first (when filtering), then by name.
        sql`${productionQualityCheckTemplatesTable.productItemId} IS NULL`,
        asc(productionQualityCheckTemplatesTable.name),
      );
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /quality-templates failed");
    res.status(500).json({ error: e.message });
  }
});

router.get("/quality-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [tpl] = await db
      .select()
      .from(productionQualityCheckTemplatesTable)
      .where(
        and(
          eq(productionQualityCheckTemplatesTable.id, id),
          eq(productionQualityCheckTemplatesTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!tpl) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    const items = await db
      .select()
      .from(productionQualityCheckTemplateItemsTable)
      .where(eq(productionQualityCheckTemplateItemsTable.templateId, id))
      .orderBy(
        asc(productionQualityCheckTemplateItemsTable.sortOrder),
        asc(productionQualityCheckTemplateItemsTable.id),
      );
    res.json({ ...tpl, items });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /quality-templates/:id failed");
    res.status(500).json({ error: e.message });
  }
});

router.post("/quality-templates", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "اسم القالب مطلوب" });
      return;
    }
    const productItemId =
      b.productItemId != null && b.productItemId !== ""
        ? Number(b.productItemId)
        : null;
    const items = Array.isArray(b.items) ? b.items : [];
    // Validate items up-front before any insert so the transaction is atomic.
    const cleanItems: {
      label: string;
      checkType: string;
      expectedValue: string | null;
      sampleSize: number | null;
      sortOrder: number;
      isRequired: boolean;
    }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] ?? {};
      const label = typeof it.label === "string" ? it.label.trim() : "";
      const checkType = typeof it.checkType === "string" ? it.checkType.trim() : "";
      if (!label || !checkType) {
        res
          .status(400)
          .json({ error: `البند رقم ${i + 1}: التسمية ونوع الفحص مطلوبان` });
        return;
      }
      if (!(QC_CHECK_TYPES as readonly string[]).includes(checkType)) {
        res.status(400).json({
          error: `البند رقم ${i + 1}: نوع فحص غير معروف (${checkType})`,
        });
        return;
      }
      cleanItems.push({
        label,
        checkType,
        expectedValue:
          typeof it.expectedValue === "string" && it.expectedValue.trim()
            ? it.expectedValue.trim()
            : null,
        sampleSize:
          it.sampleSize != null && it.sampleSize !== ""
            ? Number(it.sampleSize)
            : null,
        sortOrder: Number.isFinite(Number(it.sortOrder))
          ? Number(it.sortOrder)
          : i,
        isRequired: it.isRequired !== false,
      });
    }
    const result = await db.transaction(async (tx) => {
      const [tpl] = await tx
        .insert(productionQualityCheckTemplatesTable)
        .values({
          companyId: cid,
          name,
          productItemId,
          notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
          isActive: b.isActive !== false,
          createdByUserId: req.authUser?.id ?? null,
        })
        .returning();
      if (cleanItems.length > 0) {
        await tx.insert(productionQualityCheckTemplateItemsTable).values(
          cleanItems.map((it) => ({ ...it, templateId: tpl.id })),
        );
      }
      return tpl;
    });
    res.status(201).json(result);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /quality-templates failed");
    res.status(500).json({ error: e.message });
  }
});

router.put("/quality-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    // Ensure template belongs to caller's company BEFORE any write.
    const [existing] = await db
      .select({ id: productionQualityCheckTemplatesTable.id })
      .from(productionQualityCheckTemplatesTable)
      .where(
        and(
          eq(productionQualityCheckTemplatesTable.id, id),
          eq(productionQualityCheckTemplatesTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (typeof b.name === "string") {
      const n = b.name.trim();
      if (!n) {
        res.status(400).json({ error: "اسم القالب مطلوب" });
        return;
      }
      updates.name = n;
    }
    if (b.productItemId !== undefined) {
      updates.productItemId =
        b.productItemId != null && b.productItemId !== ""
          ? Number(b.productItemId)
          : null;
    }
    if (b.notes !== undefined) {
      updates.notes =
        typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
    }
    if (b.isActive !== undefined) updates.isActive = !!b.isActive;
    updates.updatedAt = new Date();

    // Item replacement is OPTIONAL — only when client sends an `items` array
    // do we wipe + re-insert. PATCH-like field updates without `items` leave
    // existing items intact.
    let cleanItems: any[] | null = null;
    if (Array.isArray(b.items)) {
      cleanItems = [];
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i] ?? {};
        const label = typeof it.label === "string" ? it.label.trim() : "";
        const checkType =
          typeof it.checkType === "string" ? it.checkType.trim() : "";
        if (!label || !checkType) {
          res.status(400).json({
            error: `البند رقم ${i + 1}: التسمية ونوع الفحص مطلوبان`,
          });
          return;
        }
        if (!(QC_CHECK_TYPES as readonly string[]).includes(checkType)) {
          res.status(400).json({
            error: `البند رقم ${i + 1}: نوع فحص غير معروف (${checkType})`,
          });
          return;
        }
        cleanItems.push({
          label,
          checkType,
          expectedValue:
            typeof it.expectedValue === "string" && it.expectedValue.trim()
              ? it.expectedValue.trim()
              : null,
          sampleSize:
            it.sampleSize != null && it.sampleSize !== ""
              ? Number(it.sampleSize)
              : null,
          sortOrder: Number.isFinite(Number(it.sortOrder))
            ? Number(it.sortOrder)
            : i,
          isRequired: it.isRequired !== false,
          templateId: id,
        });
      }
    }
    await db.transaction(async (tx) => {
      await tx
        .update(productionQualityCheckTemplatesTable)
        .set(updates)
        .where(eq(productionQualityCheckTemplatesTable.id, id));
      if (cleanItems !== null) {
        await tx
          .delete(productionQualityCheckTemplateItemsTable)
          .where(eq(productionQualityCheckTemplateItemsTable.templateId, id));
        if (cleanItems.length > 0) {
          await tx
            .insert(productionQualityCheckTemplateItemsTable)
            .values(cleanItems);
        }
      }
    });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /quality-templates/:id failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/quality-templates/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const r = await db
      .delete(productionQualityCheckTemplatesTable)
      .where(
        and(
          eq(productionQualityCheckTemplatesTable.id, id),
          eq(productionQualityCheckTemplatesTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0) {
      res.status(404).json({ error: "القالب غير موجود" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /quality-templates/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round I — Shift Calendar (تقويم الورديات) ────────────────────────────
// Catalog data — NOT branch-scoped. Code is unique per company. Times are
// stored as "HH:MM" strings; daysOfWeek is an int array [0..6] (Sun=0).
//
// Holidays: when `shiftId` is NULL the holiday applies to ALL shifts that
// day; otherwise just that one shift. Used by the planning UI to grey
// out non-working days.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeDaysOfWeek(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  const out: number[] = [];
  for (const v of input) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    if (!out.includes(n)) out.push(n);
  }
  out.sort();
  return out;
}

router.get("/shifts", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const activeOnly = req.query.activeOnly === "true";
    const conds = [eq(productionShiftsTable.companyId, cid)];
    if (activeOnly) conds.push(eq(productionShiftsTable.isActive, true));
    const rows = await db
      .select()
      .from(productionShiftsTable)
      .where(and(...conds))
      .orderBy(asc(productionShiftsTable.startTime), asc(productionShiftsTable.name));
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /shifts failed");
    res.status(500).json({ error: e.message });
  }
});

router.post("/shifts", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const code = typeof b.code === "string" ? b.code.trim() : "";
    const startTime = typeof b.startTime === "string" ? b.startTime.trim() : "";
    const endTime = typeof b.endTime === "string" ? b.endTime.trim() : "";
    if (!name) return void res.status(400).json({ error: "اسم الوردية مطلوب" });
    if (!code) return void res.status(400).json({ error: "رمز الوردية مطلوب" });
    if (!TIME_RE.test(startTime))
      return void res.status(400).json({ error: "وقت البداية بصيغة HH:MM" });
    if (!TIME_RE.test(endTime))
      return void res.status(400).json({ error: "وقت النهاية بصيغة HH:MM" });
    if (startTime === endTime)
      return void res
        .status(400)
        .json({ error: "وقت البداية والنهاية لا يمكن أن يكونا متطابقين" });
    const dow = normalizeDaysOfWeek(b.daysOfWeek);
    if (!dow || dow.length === 0)
      return void res
        .status(400)
        .json({ error: "اختر يوماً واحداً على الأقل من أيام الأسبوع" });
    const color =
      typeof b.color === "string" && HEX_RE.test(b.color) ? b.color : "#3b82f6";
    const breakMinutes =
      b.breakMinutes != null && b.breakMinutes !== ""
        ? Math.max(0, Number(b.breakMinutes))
        : 0;
    if (!Number.isFinite(breakMinutes))
      return void res.status(400).json({ error: "مدة الراحة غير صالحة" });
    try {
      const [row] = await db
        .insert(productionShiftsTable)
        .values({
          companyId: cid,
          name,
          code,
          startTime,
          endTime,
          daysOfWeek: dow,
          breakMinutes,
          color,
          isActive: b.isActive !== false,
          notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
        })
        .returning();
      res.status(201).json(row);
    } catch (err: any) {
      // Unique violation on (company_id, code).
      if (err?.code === "23505") {
        res.status(409).json({ error: `رمز الوردية "${code}" مستخدم مسبقاً` });
        return;
      }
      throw err;
    }
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /shifts failed");
    res.status(500).json({ error: e.message });
  }
});

router.put("/shifts/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const [existing] = await db
      .select({ id: productionShiftsTable.id })
      .from(productionShiftsTable)
      .where(
        and(
          eq(productionShiftsTable.id, id),
          eq(productionShiftsTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existing) return void res.status(404).json({ error: "الوردية غير موجودة" });
    const b = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.name === "string") {
      const n = b.name.trim();
      if (!n) return void res.status(400).json({ error: "اسم الوردية مطلوب" });
      updates.name = n;
    }
    if (typeof b.code === "string") {
      const c = b.code.trim();
      if (!c) return void res.status(400).json({ error: "رمز الوردية مطلوب" });
      updates.code = c;
    }
    if (b.startTime !== undefined) {
      const t = String(b.startTime).trim();
      if (!TIME_RE.test(t))
        return void res.status(400).json({ error: "وقت البداية بصيغة HH:MM" });
      updates.startTime = t;
    }
    if (b.endTime !== undefined) {
      const t = String(b.endTime).trim();
      if (!TIME_RE.test(t))
        return void res.status(400).json({ error: "وقت النهاية بصيغة HH:MM" });
      updates.endTime = t;
    }
    if (b.daysOfWeek !== undefined) {
      const dow = normalizeDaysOfWeek(b.daysOfWeek);
      if (!dow || dow.length === 0)
        return void res
          .status(400)
          .json({ error: "اختر يوماً واحداً على الأقل من أيام الأسبوع" });
      updates.daysOfWeek = dow;
    }
    if (b.color !== undefined) {
      const c = String(b.color);
      if (!HEX_RE.test(c))
        return void res.status(400).json({ error: "اللون يجب أن يكون hex مثل #3b82f6" });
      updates.color = c;
    }
    if (b.breakMinutes !== undefined) {
      const n = Number(b.breakMinutes);
      if (!Number.isFinite(n) || n < 0)
        return void res.status(400).json({ error: "مدة الراحة غير صالحة" });
      updates.breakMinutes = n;
    }
    if (b.isActive !== undefined) updates.isActive = !!b.isActive;
    if (b.notes !== undefined) {
      updates.notes =
        typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
    }
    try {
      await db
        .update(productionShiftsTable)
        .set(updates)
        .where(eq(productionShiftsTable.id, id));
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "رمز الوردية مستخدم مسبقاً" });
        return;
      }
      throw err;
    }
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /shifts/:id failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/shifts/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const r = await db
      .delete(productionShiftsTable)
      .where(
        and(
          eq(productionShiftsTable.id, id),
          eq(productionShiftsTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0)
      return void res.status(404).json({ error: "الوردية غير موجودة" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /shifts/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Holidays ─────────────────────────────────────────────────────────────
router.get("/shift-holidays", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const from = typeof req.query.from === "string" && DATE_RE.test(req.query.from)
      ? req.query.from
      : null;
    const to = typeof req.query.to === "string" && DATE_RE.test(req.query.to)
      ? req.query.to
      : null;
    const conds = [eq(productionShiftHolidaysTable.companyId, cid)];
    if (from) conds.push(sql`${productionShiftHolidaysTable.date} >= ${from}`);
    if (to) conds.push(sql`${productionShiftHolidaysTable.date} <= ${to}`);
    const rows = await db
      .select()
      .from(productionShiftHolidaysTable)
      .where(and(...conds))
      .orderBy(asc(productionShiftHolidaysTable.date));
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /shift-holidays failed");
    res.status(500).json({ error: e.message });
  }
});

router.post("/shift-holidays", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const date = typeof b.date === "string" ? b.date.trim() : "";
    if (!name) return void res.status(400).json({ error: "اسم العطلة مطلوب" });
    if (!DATE_RE.test(date))
      return void res.status(400).json({ error: "التاريخ بصيغة YYYY-MM-DD" });
    const shiftId =
      b.shiftId != null && b.shiftId !== "" ? Number(b.shiftId) : null;
    // If a specific shift is named, make sure it belongs to the caller's company.
    if (shiftId) {
      const [s] = await db
        .select({ id: productionShiftsTable.id })
        .from(productionShiftsTable)
        .where(
          and(
            eq(productionShiftsTable.id, shiftId),
            eq(productionShiftsTable.companyId, cid),
          ),
        )
        .limit(1);
      if (!s) return void res.status(400).json({ error: "الوردية المحددة غير موجودة" });
    }
    const [row] = await db
      .insert(productionShiftHolidaysTable)
      .values({
        companyId: cid,
        shiftId,
        date,
        name,
        isFullDay: b.isFullDay !== false,
        notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /shift-holidays failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/shift-holidays/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const r = await db
      .delete(productionShiftHolidaysTable)
      .where(
        and(
          eq(productionShiftHolidaysTable.id, id),
          eq(productionShiftHolidaysTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0)
      return void res.status(404).json({ error: "العطلة غير موجودة" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /shift-holidays/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round F — Forecasting / MRP (تخطيط احتياجات المواد) ──────────────────
// Forecast CRUD + a live MRP run endpoint that explodes forecasts through
// BOM templates and computes net requirements. The MRP result is NOT
// persisted — every call recomputes from current stock + open orders so
// the output is always fresh.
//
// Multi-tenant: companyId guard on every endpoint, BOM/item joins all
// scoped by company. NOT branch-scoped.

router.get("/forecasts", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const conds = [eq(productionForecastsTable.companyId, cid)];
    if (status && (PRODUCTION_FORECAST_STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(productionForecastsTable.status, status));
    }
    const rows = await db
      .select({
        id: productionForecastsTable.id,
        name: productionForecastsTable.name,
        periodStart: productionForecastsTable.periodStart,
        periodEnd: productionForecastsTable.periodEnd,
        status: productionForecastsTable.status,
        notes: productionForecastsTable.notes,
        createdAt: productionForecastsTable.createdAt,
        updatedAt: productionForecastsTable.updatedAt,
        lineCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${productionForecastLinesTable}
          WHERE ${productionForecastLinesTable.forecastId} = ${productionForecastsTable.id}
        )`,
      })
      .from(productionForecastsTable)
      .where(and(...conds))
      .orderBy(desc(productionForecastsTable.periodStart), desc(productionForecastsTable.id));
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /forecasts failed");
    res.status(500).json({ error: e.message });
  }
});

router.get("/forecasts/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const [fc] = await db
      .select()
      .from(productionForecastsTable)
      .where(
        and(
          eq(productionForecastsTable.id, id),
          eq(productionForecastsTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!fc) return void res.status(404).json({ error: "التوقع غير موجود" });
    const lines = await db
      .select({
        id: productionForecastLinesTable.id,
        productItemId: productionForecastLinesTable.productItemId,
        forecastQty: productionForecastLinesTable.forecastQty,
        notes: productionForecastLinesTable.notes,
        productNameAr: itemsTable.nameAr,
        productNameEn: itemsTable.nameEn,
        productSku: itemsTable.code,
      })
      .from(productionForecastLinesTable)
      .leftJoin(itemsTable, eq(itemsTable.id, productionForecastLinesTable.productItemId))
      .where(eq(productionForecastLinesTable.forecastId, id))
      .orderBy(asc(productionForecastLinesTable.id));
    res.json({ ...fc, lines });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /forecasts/:id failed");
    res.status(500).json({ error: e.message });
  }
});

function validateForecastBody(b: any, res: any) {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const periodStart = typeof b.periodStart === "string" ? b.periodStart.trim() : "";
  const periodEnd = typeof b.periodEnd === "string" ? b.periodEnd.trim() : "";
  if (!name) { res.status(400).json({ error: "اسم التوقع مطلوب" }); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    res.status(400).json({ error: "تواريخ الفترة بصيغة YYYY-MM-DD" }); return null;
  }
  if (periodEnd < periodStart) {
    res.status(400).json({ error: "نهاية الفترة قبل بدايتها" }); return null;
  }
  const status = typeof b.status === "string" && (PRODUCTION_FORECAST_STATUSES as readonly string[]).includes(b.status)
    ? b.status : "draft";
  return { name, periodStart, periodEnd, status };
}

function validateForecastLines(b: any, res: any) {
  if (!Array.isArray(b.lines)) return [];
  const out: { productItemId: number; forecastQty: string; notes: string | null }[] = [];
  for (let i = 0; i < b.lines.length; i++) {
    const ln = b.lines[i] ?? {};
    const pid = Number(ln.productItemId);
    const qty = Number(ln.forecastQty);
    if (!Number.isInteger(pid) || pid <= 0) {
      res.status(400).json({ error: `السطر ${i + 1}: المنتج مطلوب` });
      return null;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      res.status(400).json({ error: `السطر ${i + 1}: الكمية يجب أن تكون موجبة` });
      return null;
    }
    out.push({
      productItemId: pid,
      forecastQty: String(qty),
      notes: typeof ln.notes === "string" && ln.notes.trim() ? ln.notes.trim() : null,
    });
  }
  return out;
}

router.post("/forecasts", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const head = validateForecastBody(b, res);
    if (!head) return;
    const lines = validateForecastLines(b, res);
    if (lines === null) return;
    const result = await db.transaction(async (tx) => {
      const [fc] = await tx
        .insert(productionForecastsTable)
        .values({
          companyId: cid,
          name: head.name,
          periodStart: head.periodStart,
          periodEnd: head.periodEnd,
          status: head.status,
          notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
          createdByUserId: req.authUser?.id ?? null,
        })
        .returning();
      if (lines.length > 0) {
        await tx.insert(productionForecastLinesTable).values(
          lines.map((l) => ({ ...l, forecastId: fc.id })),
        );
      }
      return fc;
    });
    res.status(201).json(result);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /forecasts failed");
    res.status(500).json({ error: e.message });
  }
});

router.put("/forecasts/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const [existing] = await db
      .select({ id: productionForecastsTable.id })
      .from(productionForecastsTable)
      .where(
        and(
          eq(productionForecastsTable.id, id),
          eq(productionForecastsTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!existing) return void res.status(404).json({ error: "التوقع غير موجود" });
    const b = req.body ?? {};
    const head = validateForecastBody(b, res);
    if (!head) return;
    const lines = validateForecastLines(b, res);
    if (lines === null) return;
    await db.transaction(async (tx) => {
      await tx
        .update(productionForecastsTable)
        .set({
          name: head.name,
          periodStart: head.periodStart,
          periodEnd: head.periodEnd,
          status: head.status,
          notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
          updatedAt: new Date(),
        })
        .where(eq(productionForecastsTable.id, id));
      if (Array.isArray(b.lines)) {
        // Full-replace pattern (same as QC templates).
        await tx
          .delete(productionForecastLinesTable)
          .where(eq(productionForecastLinesTable.forecastId, id));
        if (lines.length > 0) {
          await tx.insert(productionForecastLinesTable).values(
            lines.map((l) => ({ ...l, forecastId: id })),
          );
        }
      }
    });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /forecasts/:id failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/forecasts/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const r = await db
      .delete(productionForecastsTable)
      .where(
        and(
          eq(productionForecastsTable.id, id),
          eq(productionForecastsTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0)
      return void res.status(404).json({ error: "التوقع غير موجود" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /forecasts/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ── MRP Run ────────────────────────────────────────────────────────────────
// POST body: { forecastId?: number, lines?: [{ productItemId, forecastQty }] }
// Returns: {
//   demand: [...source FG lines exploded],
//   requirements: [
//     {
//       itemId, nameAr, sku, kind: 'fg'|'raw',
//       requiredQty, onHandQty, openProductionQty, netRequirement,
//       suggestedAction: 'produce'|'purchase'|'ok',
//       missingBomTemplate?: boolean  // FG only
//     }, ...
//   ]
// }
router.post("/mrp/run", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    let demandLines: { productItemId: number; forecastQty: number }[] = [];

    if (b.forecastId) {
      const fid = Number(b.forecastId);
      if (!Number.isInteger(fid) || fid <= 0)
        return void res.status(400).json({ error: "معرّف توقع غير صالح" });
      // Confirm forecast is in caller's company before reading lines.
      const [fc] = await db
        .select({ id: productionForecastsTable.id })
        .from(productionForecastsTable)
        .where(
          and(
            eq(productionForecastsTable.id, fid),
            eq(productionForecastsTable.companyId, cid),
          ),
        )
        .limit(1);
      if (!fc) return void res.status(404).json({ error: "التوقع غير موجود" });
      const rows = await db
        .select({
          productItemId: productionForecastLinesTable.productItemId,
          forecastQty: productionForecastLinesTable.forecastQty,
        })
        .from(productionForecastLinesTable)
        .where(eq(productionForecastLinesTable.forecastId, fid));
      demandLines = rows.map((r) => ({
        productItemId: r.productItemId,
        forecastQty: Number(r.forecastQty),
      }));
    } else if (Array.isArray(b.lines)) {
      const lines = validateForecastLines({ lines: b.lines }, res);
      if (lines === null) return;
      demandLines = lines.map((l) => ({
        productItemId: l.productItemId,
        forecastQty: Number(l.forecastQty),
      }));
    } else {
      return void res.status(400).json({ error: "أرسل forecastId أو lines" });
    }
    if (demandLines.length === 0)
      return void res.json({ demand: [], requirements: [] });

    // 1) Expand BOM. requiredQty[itemId] = { qty, kind }
    //    FG entries get kind='fg', raw entries kind='raw'.
    type Req = {
      qty: number;
      kind: "fg" | "raw";
      missingBomTemplate?: boolean;
    };
    const reqs = new Map<number, Req>();
    const bump = (id: number, qty: number, kind: "fg" | "raw") => {
      const cur = reqs.get(id);
      if (cur) {
        cur.qty += qty;
        // Promote raw→fg if any path needs it as FG (rare; keeps display sane).
        if (kind === "fg") cur.kind = "fg";
      } else {
        reqs.set(id, { qty, kind });
      }
    };

    for (const dl of demandLines) {
      bump(dl.productItemId, dl.forecastQty, "fg");
      // Find active BOM template for this FG within the company.
      const [tpl] = await db
        .select({
          id: bomTemplatesTable.id,
          outputQty: bomTemplatesTable.outputQty,
        })
        .from(bomTemplatesTable)
        .where(
          and(
            eq(bomTemplatesTable.companyId, cid),
            eq(bomTemplatesTable.productItemId, dl.productItemId),
            eq(bomTemplatesTable.isActive, true),
          ),
        )
        .orderBy(desc(bomTemplatesTable.updatedAt))
        .limit(1);
      if (!tpl) {
        // Mark FG as having no BOM so UI can surface it.
        const cur = reqs.get(dl.productItemId);
        if (cur) cur.missingBomTemplate = true;
        continue;
      }
      const outputQty = Number(tpl.outputQty) || 1;
      const scale = dl.forecastQty / outputQty;
      const rawLines = await db
        .select({
          itemId: bomTemplateLinesTable.itemId,
          quantity: bomTemplateLinesTable.quantity,
        })
        .from(bomTemplateLinesTable)
        .where(eq(bomTemplateLinesTable.templateId, tpl.id));
      for (const rl of rawLines) {
        if (!rl.itemId) continue; // free-text BOM line (no item linked)
        bump(rl.itemId, Number(rl.quantity) * scale, "raw");
      }
    }

    const allItemIds = Array.from(reqs.keys());
    if (allItemIds.length === 0)
      return void res.json({ demand: demandLines, requirements: [] });

    // 2) Pull item names + on-hand stock + open production qty in 3 parallel queries.
    const [itemRows, stockRows, prodRows] = await Promise.all([
      db
        .select({
          id: itemsTable.id,
          nameAr: itemsTable.nameAr,
          nameEn: itemsTable.nameEn,
          sku: itemsTable.code,
        })
        .from(itemsTable)
        .where(
          and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, allItemIds)),
        ),
      db
        .select({
          itemId: stockBalanceTable.itemId,
          totalQty: sql<string>`coalesce(sum(${stockBalanceTable.qty}), 0)::text`,
        })
        .from(stockBalanceTable)
        .where(
          and(
            eq(stockBalanceTable.companyId, cid),
            inArray(stockBalanceTable.itemId, allItemIds),
          ),
        )
        .groupBy(stockBalanceTable.itemId),
      // Open production orders for FG items only (raw items aren't directly
      // produced). Excludes completed + cancelled — those don't add supply.
      db
        .select({
          productItemId: productionOrdersTable.productItemId,
          openQty: sql<string>`coalesce(sum(${productionOrdersTable.plannedQty}), 0)::text`,
        })
        .from(productionOrdersTable)
        .where(
          and(
            eq(productionOrdersTable.companyId, cid),
            inArray(productionOrdersTable.productItemId, allItemIds),
            sql`${productionOrdersTable.status} NOT IN ('completed','cancelled')`,
          ),
        )
        .groupBy(productionOrdersTable.productItemId),
    ]);

    const itemMap = new Map(itemRows.map((r) => [r.id, r]));
    const stockMap = new Map(stockRows.map((r) => [r.itemId, Number(r.totalQty)]));
    const prodMap = new Map(
      prodRows.map((r) => [r.productItemId, Number(r.openQty)]),
    );

    const requirements = allItemIds.map((id) => {
      const r = reqs.get(id)!;
      const meta = itemMap.get(id);
      const onHand = stockMap.get(id) ?? 0;
      const openProd = r.kind === "fg" ? prodMap.get(id) ?? 0 : 0;
      const net = Math.max(0, r.qty - onHand - openProd);
      let action: "produce" | "purchase" | "ok" = "ok";
      if (net > 0) action = r.kind === "fg" ? "produce" : "purchase";
      return {
        itemId: id,
        nameAr: meta?.nameAr ?? null,
        nameEn: meta?.nameEn ?? null,
        sku: meta?.sku ?? null,
        kind: r.kind,
        requiredQty: Number(r.qty.toFixed(4)),
        onHandQty: Number(onHand.toFixed(4)),
        openProductionQty: Number(openProd.toFixed(4)),
        netRequirement: Number(net.toFixed(4)),
        suggestedAction: action,
        missingBomTemplate: r.missingBomTemplate ?? false,
      };
    });

    // Sort: shortages first, then by name.
    requirements.sort((a, b) => {
      if (a.netRequirement !== b.netRequirement)
        return b.netRequirement - a.netRequirement;
      return (a.nameAr ?? "").localeCompare(b.nameAr ?? "");
    });

    res.json({ demand: demandLines, requirements });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /mrp/run failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round D — Downtime Tracking + OEE (تتبع التوقفات) ───────────────────
// Two catalogs (reasons, events) + an OEE summary endpoint that combines
// downtime minutes, work-center capacity, and production-order qty stats.
// All endpoints companyId-guarded. workCenterId is verified in-company
// on every write to prevent cross-tenant injection via FK reference.

// ── Reasons catalog ────────────────────────────────────────────────────
router.get("/downtime-reasons", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const rows = await db
      .select()
      .from(productionDowntimeReasonsTable)
      .where(eq(productionDowntimeReasonsTable.companyId, cid))
      .orderBy(asc(productionDowntimeReasonsTable.code));
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /downtime-reasons failed");
    res.status(500).json({ error: e.message });
  }
});

function validateReasonBody(b: any, res: any) {
  const code = typeof b.code === "string" ? b.code.trim() : "";
  const nameAr = typeof b.nameAr === "string" ? b.nameAr.trim() : "";
  if (!code) { res.status(400).json({ error: "الرمز مطلوب" }); return null; }
  if (!nameAr) { res.status(400).json({ error: "الاسم العربي مطلوب" }); return null; }
  const category = typeof b.category === "string"
    && (DOWNTIME_CATEGORIES as readonly string[]).includes(b.category)
    ? b.category : "unplanned";
  return {
    code,
    nameAr,
    nameEn: typeof b.nameEn === "string" && b.nameEn.trim() ? b.nameEn.trim() : null,
    category,
    isActive: b.isActive !== false,
  };
}

router.post("/downtime-reasons", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const data = validateReasonBody(req.body ?? {}, res);
    if (!data) return;
    try {
      const [row] = await db
        .insert(productionDowntimeReasonsTable)
        .values({ ...data, companyId: cid })
        .returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e.code === "23505")
        return void res.status(409).json({ error: "الرمز مستخدم بالفعل" });
      throw e;
    }
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /downtime-reasons failed");
    res.status(500).json({ error: e.message });
  }
});

router.put("/downtime-reasons/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const data = validateReasonBody(req.body ?? {}, res);
    if (!data) return;
    try {
      const r = await db
        .update(productionDowntimeReasonsTable)
        .set(data)
        .where(
          and(
            eq(productionDowntimeReasonsTable.id, id),
            eq(productionDowntimeReasonsTable.companyId, cid),
          ),
        );
      if ((r as any).rowCount === 0)
        return void res.status(404).json({ error: "السبب غير موجود" });
      res.json({ ok: true });
    } catch (e: any) {
      if (e.code === "23505")
        return void res.status(409).json({ error: "الرمز مستخدم بالفعل" });
      throw e;
    }
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /downtime-reasons/:id failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/downtime-reasons/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const r = await db
      .delete(productionDowntimeReasonsTable)
      .where(
        and(
          eq(productionDowntimeReasonsTable.id, id),
          eq(productionDowntimeReasonsTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0)
      return void res.status(404).json({ error: "السبب غير موجود" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /downtime-reasons/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ── Events log ────────────────────────────────────────────────────────
// Filter params: workCenterId (int), from (date YYYY-MM-DD), to (date YYYY-MM-DD)
// "from/to" filter on startAt by [from 00:00, to+1day 00:00).
router.get("/downtime-events", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const conds = [eq(productionDowntimeEventsTable.companyId, cid)];
    if (req.query.workCenterId) {
      const wcid = Number(req.query.workCenterId);
      if (Number.isInteger(wcid) && wcid > 0)
        conds.push(eq(productionDowntimeEventsTable.workCenterId, wcid));
    }
    if (typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      conds.push(sql`${productionDowntimeEventsTable.startAt} >= ${req.query.from}::date`);
    }
    if (typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      conds.push(sql`${productionDowntimeEventsTable.startAt} < (${req.query.to}::date + INTERVAL '1 day')`);
    }
    const rows = await db
      .select({
        id: productionDowntimeEventsTable.id,
        workCenterId: productionDowntimeEventsTable.workCenterId,
        reasonId: productionDowntimeEventsTable.reasonId,
        productionOrderId: productionDowntimeEventsTable.productionOrderId,
        startAt: productionDowntimeEventsTable.startAt,
        endAt: productionDowntimeEventsTable.endAt,
        durationMinutes: productionDowntimeEventsTable.durationMinutes,
        notes: productionDowntimeEventsTable.notes,
        workCenterCode: workCentersTable.code,
        workCenterNameAr: workCentersTable.nameAr,
        reasonCode: productionDowntimeReasonsTable.code,
        reasonNameAr: productionDowntimeReasonsTable.nameAr,
        reasonCategory: productionDowntimeReasonsTable.category,
      })
      .from(productionDowntimeEventsTable)
      // Defense-in-depth: even though events.companyId is already filtered,
      // restrict joined rows to the same company so accidental schema bugs
      // can never bleed cross-tenant names into the response.
      .leftJoin(
        workCentersTable,
        and(
          eq(workCentersTable.id, productionDowntimeEventsTable.workCenterId),
          eq(workCentersTable.companyId, cid),
        ),
      )
      .leftJoin(
        productionDowntimeReasonsTable,
        and(
          eq(productionDowntimeReasonsTable.id, productionDowntimeEventsTable.reasonId),
          eq(productionDowntimeReasonsTable.companyId, cid),
        ),
      )
      .where(and(...conds))
      .orderBy(desc(productionDowntimeEventsTable.startAt))
      .limit(500);
    res.json(rows);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /downtime-events failed");
    res.status(500).json({ error: e.message });
  }
});

async function validateEventBody(cid: number, b: any, res: any) {
  const wcid = Number(b.workCenterId);
  if (!Number.isInteger(wcid) || wcid <= 0) {
    res.status(400).json({ error: "مركز العمل مطلوب" }); return null;
  }
  const startAt = b.startAt ? new Date(b.startAt) : null;
  const endAt = b.endAt ? new Date(b.endAt) : null;
  if (!startAt || isNaN(startAt.getTime())) {
    res.status(400).json({ error: "وقت البداية غير صالح" }); return null;
  }
  if (!endAt || isNaN(endAt.getTime())) {
    res.status(400).json({ error: "وقت النهاية غير صالح" }); return null;
  }
  if (endAt.getTime() <= startAt.getTime()) {
    res.status(400).json({ error: "وقت النهاية يجب أن يكون بعد البداية" }); return null;
  }
  // Verify workCenter belongs to company — prevents cross-tenant FK ref.
  const [wc] = await db
    .select({ id: workCentersTable.id })
    .from(workCentersTable)
    .where(and(eq(workCentersTable.id, wcid), eq(workCentersTable.companyId, cid)))
    .limit(1);
  if (!wc) {
    res.status(404).json({ error: "مركز العمل غير موجود" }); return null;
  }
  let reasonId: number | null = null;
  if (b.reasonId !== null && b.reasonId !== undefined && b.reasonId !== "") {
    const rid = Number(b.reasonId);
    if (!Number.isInteger(rid) || rid <= 0) {
      res.status(400).json({ error: "السبب غير صالح" }); return null;
    }
    const [rr] = await db
      .select({ id: productionDowntimeReasonsTable.id })
      .from(productionDowntimeReasonsTable)
      .where(and(
        eq(productionDowntimeReasonsTable.id, rid),
        eq(productionDowntimeReasonsTable.companyId, cid),
      ))
      .limit(1);
    if (!rr) {
      res.status(404).json({ error: "السبب غير موجود" }); return null;
    }
    reasonId = rid;
  }
  const durationMinutes = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
  return {
    workCenterId: wcid,
    reasonId,
    productionOrderId: b.productionOrderId ? Number(b.productionOrderId) : null,
    startAt,
    endAt,
    durationMinutes,
    notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
  };
}

router.post("/downtime-events", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const data = await validateEventBody(cid, req.body ?? {}, res);
    if (!data) return;
    const [row] = await db
      .insert(productionDowntimeEventsTable)
      .values({
        ...data,
        companyId: cid,
        loggedByUserId: req.authUser?.id ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /downtime-events failed");
    res.status(500).json({ error: e.message });
  }
});

router.delete("/downtime-events/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "معرّف غير صالح" });
    const r = await db
      .delete(productionDowntimeEventsTable)
      .where(
        and(
          eq(productionDowntimeEventsTable.id, id),
          eq(productionDowntimeEventsTable.companyId, cid),
        ),
      );
    if ((r as any).rowCount === 0)
      return void res.status(404).json({ error: "الحدث غير موجود" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /downtime-events/:id failed");
    res.status(500).json({ error: e.message });
  }
});

// ── OEE Summary ────────────────────────────────────────────────────────
// GET /api/production/oee?from=YYYY-MM-DD&to=YYYY-MM-DD[&workCenterId=N]
// Returns one row per work center with:
//   plannedMinutes      = capacityHoursPerDay * 60 * dayCount
//   downtimeMinutes     = sum(events.duration in range, split planned/unplanned)
//   availableMinutes    = plannedMinutes - downtimeMinutes (clamped >=0)
//   producedQty/wasteQty/goodQty = aggregated from production_orders
//                          where workCenterId matches AND status='completed'
//                          AND completedAt in [from, to+1day)
//   availability        = availableMinutes / plannedMinutes
//   quality             = goodQty / (goodQty + wasteQty)
//   oee                 = availability * quality
router.get("/oee", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return void res.status(400).json({ error: "from و to بصيغة YYYY-MM-DD" });
    if (to < from)
      return void res.status(400).json({ error: "to قبل from" });
    // Inclusive day count.
    const dayCount = Math.round(
      (new Date(to + "T00:00:00Z").getTime() - new Date(from + "T00:00:00Z").getTime())
        / 86400000,
    ) + 1;

    const wcConds = [
      eq(workCentersTable.companyId, cid),
      eq(workCentersTable.isActive, true),
    ];
    if (req.query.workCenterId) {
      const wcid = Number(req.query.workCenterId);
      if (Number.isInteger(wcid) && wcid > 0)
        wcConds.push(eq(workCentersTable.id, wcid));
    }
    const centers = await db
      .select({
        id: workCentersTable.id,
        code: workCentersTable.code,
        nameAr: workCentersTable.nameAr,
        capacityHoursPerDay: workCentersTable.capacityHoursPerDay,
      })
      .from(workCentersTable)
      .where(and(...wcConds))
      .orderBy(asc(workCentersTable.code));
    if (centers.length === 0)
      return void res.json({ from, to, dayCount, centers: [] });

    const centerIds = centers.map((c) => c.id);
    // Pull downtime + production aggregates in parallel.
    const [downtimeAgg, prodAgg] = await Promise.all([
      db
        .select({
          workCenterId: productionDowntimeEventsTable.workCenterId,
          category: productionDowntimeReasonsTable.category,
          totalMinutes: sql<string>`coalesce(sum(${productionDowntimeEventsTable.durationMinutes}), 0)::text`,
        })
        .from(productionDowntimeEventsTable)
        .leftJoin(
          productionDowntimeReasonsTable,
          eq(productionDowntimeReasonsTable.id, productionDowntimeEventsTable.reasonId),
        )
        .where(
          and(
            eq(productionDowntimeEventsTable.companyId, cid),
            inArray(productionDowntimeEventsTable.workCenterId, centerIds),
            sql`${productionDowntimeEventsTable.startAt} >= ${from}::date`,
            sql`${productionDowntimeEventsTable.startAt} < (${to}::date + INTERVAL '1 day')`,
          ),
        )
        .groupBy(
          productionDowntimeEventsTable.workCenterId,
          productionDowntimeReasonsTable.category,
        ),
      db
        .select({
          workCenterId: productionOrdersTable.workCenterId,
          produced: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}), 0)::text`,
          waste: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}), 0)::text`,
        })
        .from(productionOrdersTable)
        .where(
          and(
            eq(productionOrdersTable.companyId, cid),
            inArray(productionOrdersTable.workCenterId, centerIds),
            eq(productionOrdersTable.status, "completed"),
            sql`${productionOrdersTable.actualEndAt} >= ${from}::date`,
            sql`${productionOrdersTable.actualEndAt} < (${to}::date + INTERVAL '1 day')`,
          ),
        )
        .groupBy(productionOrdersTable.workCenterId),
    ]);

    // Build lookup maps. plannedMap[wcid] / unplannedMap[wcid] / nullCategoryMap[wcid]
    const dtMap = new Map<number, { planned: number; unplanned: number; uncategorized: number }>();
    for (const r of downtimeAgg) {
      if (r.workCenterId == null) continue;
      const cur = dtMap.get(r.workCenterId) ?? { planned: 0, unplanned: 0, uncategorized: 0 };
      const mins = Number(r.totalMinutes);
      if (r.category === "planned") cur.planned += mins;
      else if (r.category === "unplanned") cur.unplanned += mins;
      else cur.uncategorized += mins;
      dtMap.set(r.workCenterId, cur);
    }
    const prodMap = new Map<number, { produced: number; waste: number }>();
    for (const r of prodAgg) {
      if (r.workCenterId == null) continue;
      prodMap.set(r.workCenterId, {
        produced: Number(r.produced),
        waste: Number(r.waste),
      });
    }

    const result = centers.map((c) => {
      const plannedMinutes = Math.round(Number(c.capacityHoursPerDay) * 60 * dayCount);
      const dt = dtMap.get(c.id) ?? { planned: 0, unplanned: 0, uncategorized: 0 };
      const downtimeMinutes = dt.planned + dt.unplanned + dt.uncategorized;
      const availableMinutes = Math.max(0, plannedMinutes - downtimeMinutes);
      const prod = prodMap.get(c.id) ?? { produced: 0, waste: 0 };
      const totalUnits = prod.produced + prod.waste;
      // produced already excludes waste in this schema's accounting.
      const goodQty = prod.produced;
      const availability = plannedMinutes > 0 ? availableMinutes / plannedMinutes : 0;
      // If nothing was produced in the period we cannot evaluate quality.
      // Returning 1.0 here would falsely inflate OEE to 100% for an idle
      // machine, so we set quality=0 and let oee collapse to 0. The UI
      // can distinguish "no production" via totalUnits=0 if it wants to
      // show a separate "N/A" label.
      const quality = totalUnits > 0 ? goodQty / totalUnits : 0;
      const oee = availability * quality;
      return {
        workCenterId: c.id,
        code: c.code,
        nameAr: c.nameAr,
        capacityHoursPerDay: Number(c.capacityHoursPerDay),
        plannedMinutes,
        downtimePlanned: dt.planned,
        downtimeUnplanned: dt.unplanned,
        downtimeUncategorized: dt.uncategorized,
        downtimeMinutes,
        availableMinutes,
        producedQty: prod.produced,
        wasteQty: prod.waste,
        goodQty,
        availability: Number(availability.toFixed(4)),
        quality: Number(quality.toFixed(4)),
        oee: Number(oee.toFixed(4)),
      };
    });
    res.json({ from, to, dayCount, centers: result });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /oee failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round K — Manufacturing KPI Cockpit ────────────────────────────────
// Single endpoint that pulls all module aggregates needed for an executive
// "shop floor at a glance" screen. Designed to replace the need to open
// orders + downtime + MRP + approvals separately.
//
// GET /api/production/kpi-dashboard?days=30
//
// Returns:
//   period: { from, to, days }
//   orders: { byStatus[], totals: {planned, produced, waste} }
//   scrap: { rate, producedQty, wasteQty }
//   onTime: { completedCount, onTimeCount, lateCount, rate }  -- completed
//       orders whose actualEndAt date <= plannedEndDate are "on time".
//       Orders with no plannedEndDate are excluded from rate denominator.
//   approvals: { pendingDrafts, mandatory }   -- mandatory = drafts that
//       trigger the approval gate (approvalRequired OR over threshold).
//   downtime: { totalMinutes, plannedMinutes, unplannedMinutes,
//       topReasons[{ reasonCode, nameAr, category, minutes }] (top 5) }
//   oee: { avgAvailability, avgQuality, avgOee, workCenterCount }
//       (mean across active work centers; reuses the same formula as
//       /api/production/oee.)
//   mrp: { shortageCount, topShortages[{ itemId, nameAr, net, reorderPoint }] }
//       Shortages = items whose (stockOnHand + on-order) < reorder_point.
//
// All scoped by companyId. Date defaults: last 30 days.
router.get("/kpi-dashboard", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const fromIso = from.toISOString().slice(0, 10);
    const toIso = to.toISOString().slice(0, 10);

    // ── Orders by status (lifetime, not period — gives current state) ──
    const byStatusRows = await db
      .select({
        status: productionOrdersTable.status,
        count: sql<string>`count(*)::text`,
        plannedQty: sql<string>`coalesce(sum(${productionOrdersTable.plannedQty}),0)::text`,
        producedQty: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}),0)::text`,
        wasteQty: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}),0)::text`,
      })
      .from(productionOrdersTable)
      .where(eq(productionOrdersTable.companyId, cid))
      .groupBy(productionOrdersTable.status);

    const byStatus = byStatusRows.map((r) => ({
      status: r.status,
      count: Number(r.count),
      plannedQty: Number(r.plannedQty),
      producedQty: Number(r.producedQty),
      wasteQty: Number(r.wasteQty),
    }));
    const totals = byStatus.reduce(
      (acc, r) => {
        acc.planned += r.plannedQty;
        acc.produced += r.producedQty;
        acc.waste += r.wasteQty;
        return acc;
      },
      { planned: 0, produced: 0, waste: 0 },
    );

    // ── Scrap rate (period) ──
    const [scrapRow] = await db
      .select({
        produced: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}),0)::text`,
        waste: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}),0)::text`,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "completed"),
          sql`${productionOrdersTable.actualEndAt}::date >= ${fromIso}`,
          sql`${productionOrdersTable.actualEndAt}::date <= ${toIso}`,
        ),
      );
    const scrapProduced = Number(scrapRow?.produced ?? 0);
    const scrapWaste = Number(scrapRow?.waste ?? 0);
    const scrapDenom = scrapProduced + scrapWaste;
    const scrap = {
      producedQty: scrapProduced,
      wasteQty: scrapWaste,
      rate: scrapDenom > 0 ? scrapWaste / scrapDenom : 0,
    };

    // ── On-time delivery (period) ──
    const completedOrders = await db
      .select({
        plannedEndDate: productionOrdersTable.plannedEndDate,
        completedAt: productionOrdersTable.actualEndAt,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "completed"),
          sql`${productionOrdersTable.actualEndAt}::date >= ${fromIso}`,
          sql`${productionOrdersTable.actualEndAt}::date <= ${toIso}`,
        ),
      );
    let onTimeCount = 0;
    let lateCount = 0;
    let measurableCount = 0;
    for (const o of completedOrders) {
      if (!o.plannedEndDate || !o.completedAt) continue;
      measurableCount++;
      const completedDate = new Date(o.completedAt).toISOString().slice(0, 10);
      if (completedDate <= o.plannedEndDate) onTimeCount++;
      else lateCount++;
    }
    const onTime = {
      completedCount: completedOrders.length,
      measurableCount,
      onTimeCount,
      lateCount,
      rate: measurableCount > 0 ? onTimeCount / measurableCount : 0,
    };

    // ── Approvals queue ──
    const [settings] = await db
      .select({
        approvalRequired: manufacturingSettingsTable.approvalRequired,
        approvalThreshold: manufacturingSettingsTable.approvalThreshold,
      })
      .from(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, cid))
      .limit(1);
    const reqApproval = settings?.approvalRequired === true;
    const threshold = settings?.approvalThreshold
      ? Number(settings.approvalThreshold)
      : null;

    const draftOrders = await db
      .select({
        id: productionOrdersTable.id,
        estimatedCost: productionOrdersTable.estimatedCost,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "draft"),
        ),
      );
    let mandatory = 0;
    for (const d of draftOrders) {
      const cost = Number(d.estimatedCost) || 0;
      if (reqApproval || (threshold != null && cost >= threshold)) mandatory++;
    }
    const approvals = { pendingDrafts: draftOrders.length, mandatory };

    // ── Downtime (period) ──
    const dtRows = await db
      .select({
        category: productionDowntimeReasonsTable.category,
        minutes: sql<string>`coalesce(sum(${productionDowntimeEventsTable.durationMinutes}),0)::text`,
      })
      .from(productionDowntimeEventsTable)
      .leftJoin(
        productionDowntimeReasonsTable,
        and(
          eq(
            productionDowntimeReasonsTable.id,
            productionDowntimeEventsTable.reasonId,
          ),
          eq(productionDowntimeReasonsTable.companyId, cid),
        ),
      )
      .where(
        and(
          eq(productionDowntimeEventsTable.companyId, cid),
          sql`${productionDowntimeEventsTable.startAt}::date >= ${fromIso}`,
          sql`${productionDowntimeEventsTable.startAt}::date <= ${toIso}`,
        ),
      )
      .groupBy(productionDowntimeReasonsTable.category);
    let dtPlanned = 0;
    let dtUnplanned = 0;
    for (const r of dtRows) {
      const m = Number(r.minutes);
      if (r.category === "planned") dtPlanned += m;
      else if (r.category === "unplanned") dtUnplanned += m;
    }
    const topReasonsRows = await db
      .select({
        reasonId: productionDowntimeEventsTable.reasonId,
        code: productionDowntimeReasonsTable.code,
        nameAr: productionDowntimeReasonsTable.nameAr,
        category: productionDowntimeReasonsTable.category,
        minutes: sql<string>`coalesce(sum(${productionDowntimeEventsTable.durationMinutes}),0)::text`,
      })
      .from(productionDowntimeEventsTable)
      .leftJoin(
        productionDowntimeReasonsTable,
        and(
          eq(
            productionDowntimeReasonsTable.id,
            productionDowntimeEventsTable.reasonId,
          ),
          eq(productionDowntimeReasonsTable.companyId, cid),
        ),
      )
      .where(
        and(
          eq(productionDowntimeEventsTable.companyId, cid),
          sql`${productionDowntimeEventsTable.startAt}::date >= ${fromIso}`,
          sql`${productionDowntimeEventsTable.startAt}::date <= ${toIso}`,
        ),
      )
      .groupBy(
        productionDowntimeEventsTable.reasonId,
        productionDowntimeReasonsTable.code,
        productionDowntimeReasonsTable.nameAr,
        productionDowntimeReasonsTable.category,
      )
      .orderBy(
        sql`coalesce(sum(${productionDowntimeEventsTable.durationMinutes}),0) desc`,
      )
      .limit(5);
    const topReasons = topReasonsRows.map((r) => ({
      reasonId: r.reasonId,
      code: r.code,
      nameAr: r.nameAr,
      category: r.category,
      minutes: Number(r.minutes),
    }));
    const downtime = {
      totalMinutes: dtPlanned + dtUnplanned,
      plannedMinutes: dtPlanned,
      unplannedMinutes: dtUnplanned,
      topReasons,
    };

    // ── OEE summary (mean across active work centers) ──
    const dayCount = days;
    const workCenters = await db
      .select({
        id: workCentersTable.id,
        capacityHoursPerDay: workCentersTable.capacityHoursPerDay,
      })
      .from(workCentersTable)
      .where(
        and(
          eq(workCentersTable.companyId, cid),
          eq(workCentersTable.isActive, true),
        ),
      );

    // Per-WC downtime in period
    const wcDowntimeRows = await db
      .select({
        workCenterId: productionDowntimeEventsTable.workCenterId,
        minutes: sql<string>`coalesce(sum(${productionDowntimeEventsTable.durationMinutes}),0)::text`,
      })
      .from(productionDowntimeEventsTable)
      .where(
        and(
          eq(productionDowntimeEventsTable.companyId, cid),
          sql`${productionDowntimeEventsTable.startAt}::date >= ${fromIso}`,
          sql`${productionDowntimeEventsTable.startAt}::date <= ${toIso}`,
        ),
      )
      .groupBy(productionDowntimeEventsTable.workCenterId);
    const wcDtMap = new Map(
      wcDowntimeRows.map((r) => [r.workCenterId, Number(r.minutes)]),
    );

    // Per-WC production in period
    const wcProdRows = await db
      .select({
        workCenterId: productionOrdersTable.workCenterId,
        produced: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}),0)::text`,
        waste: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}),0)::text`,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "completed"),
          sql`${productionOrdersTable.actualEndAt}::date >= ${fromIso}`,
          sql`${productionOrdersTable.actualEndAt}::date <= ${toIso}`,
        ),
      )
      .groupBy(productionOrdersTable.workCenterId);
    const wcProdMap = new Map(
      wcProdRows.map((r) => [
        r.workCenterId,
        { produced: Number(r.produced), waste: Number(r.waste) },
      ]),
    );

    let availSum = 0;
    let qualSum = 0;
    let oeeSum = 0;
    let wcMeasured = 0;
    for (const wc of workCenters) {
      const planned = Number(wc.capacityHoursPerDay) * 60 * dayCount;
      if (planned <= 0) continue;
      const dt = wcDtMap.get(wc.id) ?? 0;
      const avail = Math.max(0, planned - dt) / planned;
      const p = wcProdMap.get(wc.id) ?? { produced: 0, waste: 0 };
      const total = p.produced + p.waste;
      // Same convention as /oee: quality=0 when no production (idle WCs
      // should not inflate the average to 100%).
      const qual = total > 0 ? p.produced / total : 0;
      availSum += avail;
      qualSum += qual;
      oeeSum += avail * qual;
      wcMeasured++;
    }
    const oee = {
      workCenterCount: wcMeasured,
      avgAvailability: wcMeasured > 0 ? availSum / wcMeasured : 0,
      avgQuality: wcMeasured > 0 ? qualSum / wcMeasured : 0,
      avgOee: wcMeasured > 0 ? oeeSum / wcMeasured : 0,
    };

    // ── MRP shortages (current snapshot, not period) ──
    // Items with reorder_point > 0 and on-hand below it. Cheap proxy for
    // the full MRP run (which already exists as its own endpoint).
    const shortageRows = await db
      .select({
        itemId: itemsTable.id,
        nameAr: itemsTable.nameAr,
        reorderLevel: itemsTable.reorderLevel,
        onHand: sql<string>`coalesce((
          select sum(${stockBalanceTable.qty})
            from ${stockBalanceTable}
           where ${stockBalanceTable.itemId} = ${itemsTable.id}
             and ${stockBalanceTable.companyId} = ${cid}
        ),0)::text`,
      })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.companyId, cid),
          sql`${itemsTable.reorderLevel} > 0`,
        ),
      )
      .limit(2000);
    const shortages = shortageRows
      .map((r) => ({
        itemId: r.itemId,
        nameAr: r.nameAr,
        reorderLevel: Number(r.reorderLevel),
        onHand: Number(r.onHand),
        net: Number(r.onHand) - Number(r.reorderLevel),
      }))
      .filter((r) => r.net < 0)
      .sort((a, b) => a.net - b.net);
    const mrp = {
      shortageCount: shortages.length,
      topShortages: shortages.slice(0, 8),
    };

    res.json({
      period: { from: fromIso, to: toIso, days },
      orders: { byStatus, totals },
      scrap,
      onTime,
      approvals,
      downtime,
      oee,
      mrp,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /kpi-dashboard failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round A — Production Order Approval Workflow ──────────────────────
// Optional explicit approval step before an order can leave draft.
// The canonical status transition (draft→approved) is still enforced by
// PATCH /:id/status; these endpoints add the audit stamp and a friendlier
// API for an approvals queue UI.
//
// Approve  — POST /api/production/orders/:id/approve
//   Order must currently be 'draft' AND not already approved.
//   Sets status='approved', approvedByUserId, approvedAt.
//
// Reject   — POST /api/production/orders/:id/reject  body { reason }
//   Order must currently be 'draft'. Sets status='cancelled',
//   rejectionReason. Reason ≥ 5 chars required (audit trail).
//
// Pending-approval handler is registered earlier (before /orders/:id) to
// avoid Express 5 / path-to-regexp 8 swallowing the literal segment as :id.

router.post("/orders/:id/approve", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "id غير صحيح" });

    const userId = (req as any).user?.id ?? null;

    const [order] = await db
      .select({
        id: productionOrdersTable.id,
        status: productionOrdersTable.status,
        approvedAt: productionOrdersTable.approvedAt,
      })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!order) return void res.status(404).json({ error: "الأمر غير موجود" });
    if (order.status !== "draft")
      return void res
        .status(409)
        .json({ error: `لا يمكن اعتماد أمر بالحالة "${order.status}"` });

    const [updated] = await db
      .update(productionOrdersTable)
      .set({
        status: "approved",
        approvedByUserId: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "draft"), // optimistic guard
        ),
      )
      .returning();

    if (!updated)
      return void res
        .status(409)
        .json({ error: "تغيّرت حالة الأمر — أعد التحميل" });

    await db.insert(productionEventsTable).values({
      companyId: cid,
      orderId: id,
      eventType: "order_approved",
      userId,
      payload: { from: "draft", to: "approved" },
    });

    res.json({ ok: true, order: updated });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /orders/:id/approve failed");
    res.status(500).json({ error: e.message });
  }
});

router.post("/orders/:id/reject", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return void res.status(400).json({ error: "id غير صحيح" });

    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 5)
      return void res
        .status(400)
        .json({ error: "سبب الرفض مطلوب (5 أحرف على الأقل)" });

    const userId = (req as any).user?.id ?? null;

    const [order] = await db
      .select({ status: productionOrdersTable.status })
      .from(productionOrdersTable)
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
        ),
      )
      .limit(1);
    if (!order) return void res.status(404).json({ error: "الأمر غير موجود" });
    if (order.status !== "draft")
      return void res
        .status(409)
        .json({ error: `لا يمكن رفض أمر بالحالة "${order.status}"` });

    const [updated] = await db
      .update(productionOrdersTable)
      .set({
        status: "cancelled",
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productionOrdersTable.id, id),
          eq(productionOrdersTable.companyId, cid),
          eq(productionOrdersTable.status, "draft"),
        ),
      )
      .returning();
    if (!updated)
      return void res
        .status(409)
        .json({ error: "تغيّرت حالة الأمر — أعد التحميل" });

    await db.insert(productionEventsTable).values({
      companyId: cid,
      orderId: id,
      eventType: "order_rejected",
      userId,
      payload: { from: "draft", to: "cancelled", reason },
    });

    res.json({ ok: true, order: updated });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /orders/:id/reject failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── Round C — Standard Cost Rollup (تكلفة المنتج المعيارية) ─────────────
// Live calculation (NOT persisted) of an FG product's standard cost based on:
//   * Materials  — from the active BOM template:
//       For each raw line, unitCost = weighted avg of stock_balance.avgCost
//         across all warehouses (sum(qty*avgCost)/sum(qty)).
//       lineCost = unitCost × scaledQty (scaled so the BOM produces 1 unit
//         of FG: scaledQty = templateLine.quantity / template.outputQty).
//   * Operating cost — from the active routing's stages:
//       If stage.expectedCost > 0, use it directly (manual override).
//       Else: hours = expectedDurationMinutes / 60;
//             stageCost = hours × (workCenter.laborRatePerHour
//                                 + workCenter.overheadRatePerHour)
//
// Returns per-unit cost (already divided by 1 since BOM is scaled to 1 unit).
// All queries scoped by companyId.
router.get("/cost-rollup", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const productItemId = Number(req.query.productItemId);
    if (!Number.isInteger(productItemId) || productItemId <= 0)
      return void res.status(400).json({ error: "productItemId مطلوب" });

    const [product] = await db
      .select({
        id: itemsTable.id,
        nameAr: itemsTable.nameAr,
        nameEn: itemsTable.nameEn,
        sku: itemsTable.code,
      })
      .from(itemsTable)
      .where(and(eq(itemsTable.id, productItemId), eq(itemsTable.companyId, cid)))
      .limit(1);
    if (!product) return void res.status(404).json({ error: "المنتج غير موجود" });

    // ── BOM (materials) ──────────────────────────────────────────────
    const [tpl] = await db
      .select({
        id: bomTemplatesTable.id,
        nameAr: bomTemplatesTable.nameAr,
        outputQty: bomTemplatesTable.outputQty,
      })
      .from(bomTemplatesTable)
      .where(
        and(
          eq(bomTemplatesTable.companyId, cid),
          eq(bomTemplatesTable.productItemId, productItemId),
          eq(bomTemplatesTable.isActive, true),
        ),
      )
      .orderBy(desc(bomTemplatesTable.updatedAt))
      .limit(1);

    let materials: Array<{
      itemId: number | null;
      nameAr: string | null;
      sku: string | null;
      qty: number;
      unitCost: number;
      totalCost: number;
    }> = [];
    let materialsCost = 0;

    if (tpl) {
      const tplOutput = Number(tpl.outputQty) || 1;
      const rawLines = await db
        .select({
          id: bomTemplateLinesTable.id,
          itemId: bomTemplateLinesTable.itemId,
          description: bomTemplateLinesTable.description,
          quantity: bomTemplateLinesTable.quantity,
          itemNameAr: itemsTable.nameAr,
          itemSku: itemsTable.code,
        })
        .from(bomTemplateLinesTable)
        .leftJoin(
          itemsTable,
          and(
            eq(itemsTable.id, bomTemplateLinesTable.itemId),
            eq(itemsTable.companyId, cid),
          ),
        )
        .where(eq(bomTemplateLinesTable.templateId, tpl.id));

      const rawItemIds = rawLines.map((l) => l.itemId).filter((x): x is number => x != null);
      let costMap = new Map<number, number>();
      if (rawItemIds.length > 0) {
        // Weighted avg cost per item across all warehouses for the company.
        const stockRows = await db
          .select({
            itemId: stockBalanceTable.itemId,
            // weighted_avg = sum(qty*avgCost) / NULLIF(sum(qty),0)
            weightedAvg: sql<string>`
              CASE WHEN sum(${stockBalanceTable.qty}) > 0
                THEN sum(${stockBalanceTable.qty} * ${stockBalanceTable.avgCost})
                     / sum(${stockBalanceTable.qty})
                ELSE 0
              END::text
            `,
          })
          .from(stockBalanceTable)
          .where(
            and(
              eq(stockBalanceTable.companyId, cid),
              inArray(stockBalanceTable.itemId, rawItemIds),
            ),
          )
          .groupBy(stockBalanceTable.itemId);
        costMap = new Map(stockRows.map((s) => [s.itemId, Number(s.weightedAvg)]));
      }

      for (const rl of rawLines) {
        const scaledQty = (Number(rl.quantity) || 0) / tplOutput;
        const unitCost = rl.itemId ? costMap.get(rl.itemId) ?? 0 : 0;
        const totalCost = scaledQty * unitCost;
        materialsCost += totalCost;
        materials.push({
          itemId: rl.itemId,
          nameAr: rl.itemNameAr ?? rl.description,
          sku: rl.itemSku ?? null,
          qty: Number(scaledQty.toFixed(4)),
          unitCost: Number(unitCost.toFixed(4)),
          totalCost: Number(totalCost.toFixed(4)),
        });
      }
    }

    // ── Routing (operating cost) ─────────────────────────────────────
    const [rt] = await db
      .select({
        id: productionRoutingsTable.id,
        nameAr: productionRoutingsTable.nameAr,
      })
      .from(productionRoutingsTable)
      .where(
        and(
          eq(productionRoutingsTable.companyId, cid),
          eq(productionRoutingsTable.productItemId, productItemId),
          eq(productionRoutingsTable.isActive, true),
        ),
      )
      .orderBy(desc(productionRoutingsTable.updatedAt))
      .limit(1);

    let stages: Array<{
      stageId: number;
      sequence: number;
      nameAr: string;
      workCenterId: number | null;
      workCenterNameAr: string | null;
      durationMinutes: number | null;
      laborCost: number;
      overheadCost: number;
      stageCost: number;
      source: "expectedCost" | "rates" | "none";
    }> = [];
    let laborCost = 0;
    let overheadCost = 0;
    let routingExplicitCost = 0; // when stage.expectedCost is used we can't split

    if (rt) {
      const rstages = await db
        .select({
          id: productionRoutingStagesTable.id,
          sequence: productionRoutingStagesTable.sequence,
          nameAr: productionRoutingStagesTable.nameAr,
          workCenterId: productionRoutingStagesTable.workCenterId,
          expectedDurationMinutes: productionRoutingStagesTable.expectedDurationMinutes,
          expectedCost: productionRoutingStagesTable.expectedCost,
          wcNameAr: workCentersTable.nameAr,
          wcLaborRate: workCentersTable.laborRatePerHour,
          wcOverheadRate: workCentersTable.overheadRatePerHour,
        })
        .from(productionRoutingStagesTable)
        .leftJoin(
          workCentersTable,
          and(
            eq(workCentersTable.id, productionRoutingStagesTable.workCenterId),
            eq(workCentersTable.companyId, cid),
          ),
        )
        .where(eq(productionRoutingStagesTable.routingId, rt.id))
        .orderBy(asc(productionRoutingStagesTable.sequence));

      for (const s of rstages) {
        const explicit = Number(s.expectedCost) || 0;
        let stLabor = 0;
        let stOverhead = 0;
        let stTotal = 0;
        let source: "expectedCost" | "rates" | "none" = "none";
        if (explicit > 0) {
          stTotal = explicit;
          routingExplicitCost += explicit;
          source = "expectedCost";
        } else if (s.expectedDurationMinutes && s.expectedDurationMinutes > 0) {
          const hours = s.expectedDurationMinutes / 60;
          stLabor = hours * (Number(s.wcLaborRate) || 0);
          stOverhead = hours * (Number(s.wcOverheadRate) || 0);
          stTotal = stLabor + stOverhead;
          laborCost += stLabor;
          overheadCost += stOverhead;
          source = "rates";
        }
        stages.push({
          stageId: s.id,
          sequence: s.sequence,
          nameAr: s.nameAr,
          workCenterId: s.workCenterId,
          workCenterNameAr: s.wcNameAr,
          durationMinutes: s.expectedDurationMinutes,
          laborCost: Number(stLabor.toFixed(4)),
          overheadCost: Number(stOverhead.toFixed(4)),
          stageCost: Number(stTotal.toFixed(4)),
          source,
        });
      }
    }

    const operatingCost = laborCost + overheadCost + routingExplicitCost;
    const totalCost = materialsCost + operatingCost;

    res.json({
      product,
      bom: tpl
        ? { templateId: tpl.id, nameAr: tpl.nameAr, outputQty: Number(tpl.outputQty) }
        : null,
      routing: rt ? { routingId: rt.id, nameAr: rt.nameAr } : null,
      materials,
      stages,
      totals: {
        materialsCost: Number(materialsCost.toFixed(4)),
        laborCost: Number(laborCost.toFixed(4)),
        overheadCost: Number(overheadCost.toFixed(4)),
        routingExplicitCost: Number(routingExplicitCost.toFixed(4)),
        operatingCost: Number(operatingCost.toFixed(4)),
        totalCost: Number(totalCost.toFixed(4)),
        // BOM is scaled to 1 unit of FG, so totalCost IS the unit cost.
        unitCost: Number(totalCost.toFixed(4)),
      },
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /cost-rollup failed");
    res.status(500).json({ error: e.message });
  }
});

export default router;
