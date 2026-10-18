import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesRepsTable,
  salesRepVisitsTable,
  customersTable,
  salesInvoicesTable,
  receiptVouchersTable, // used by delete guard so we don't orphan collection-commission history
  usersTable,
  itemsTable,
  unitsTable,
  itemUnitPricesTable,
  salesInvoiceLinesTable,
  salesReturnsTable,
  salesReturnLinesTable,
  type SalesRepCommissionPlan,
  type SalesRepTargetPeriod,
} from "@workspace/db";
import { and, desc, eq, sql, inArray, ilike, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, hasDemoOperationalPrivilege } from "../middleware/permissions.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("sales_invoices"));
router.use(moduleAudit("sales_invoices"));
// Require an authenticated user for every sales-reps endpoint — these contain
// PII (phone/email/address) and commission terms; never serve to anonymous callers.
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

async function targetPlanWithPeriod(
  cid: number,
  current: SalesRepCommissionPlan | null | undefined,
  input: any,
  commissionPct: unknown,
): Promise<SalesRepCommissionPlan> {
  const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
  const periods = Array.isArray(current?.periods) ? [...current.periods] : [];
  if (!input || typeof input !== "object") return { periods };
  const from = String(input.from ?? "");
  const to = String(input.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw invalid("فترة التارجت غير صحيحة");
  }
  if (input.enabled === false) {
    const ix = periods.findIndex((p: SalesRepTargetPeriod) => p.from === from && p.to === to);
    if (ix >= 0 && periods[ix].status === "approved") throw invalid("الفترة معتمدة ولا يمكن تعديلها");
    const period: SalesRepTargetPeriod = {
      from, to, enabled: false, items: [], calculationMode: "excess",
      status: "open", commissionPct: String(commissionPct ?? 0),
    };
    if (ix >= 0) periods[ix] = period; else periods.push(period);
    return { periods: periods.sort((a, b) => a.from.localeCompare(b.from)) };
  }
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw invalid("أضف صنفًا واحدًا على الأقل للتارجت");
  const normalized = items.map((x: any) => {
    const itemId = Number(x.itemId);
    const unitId = Number(x.unitId);
    const targetQty = Number(x.targetQty);
    const conversionFactor = Number(x.conversionFactor);
    if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(unitId) || unitId < 1
      || !Number.isFinite(targetQty) || targetQty <= 0
      || !Number.isFinite(conversionFactor) || conversionFactor <= 0) {
      throw invalid("بيانات صنف التارجت أو وحدته غير صحيحة");
    }
    return {
      itemId,
      itemName: String(x.itemName ?? "").slice(0, 240),
      itemCode: x.itemCode == null ? null : String(x.itemCode).slice(0, 100),
      unitId,
      unitName: String(x.unitName ?? "").slice(0, 120),
      conversionFactor: String(conversionFactor),
      targetQty: String(targetQty),
    };
  });
  if (new Set(normalized.map((x: any) => x.itemId)).size !== normalized.length) {
    throw invalid("لا يمكن تكرار الصنف في الفترة نفسها");
  }
  const itemIds = normalized.map((x: any) => x.itemId as number);
  const unitIds = normalized.map((x: any) => x.unitId as number);
  const companyItems = await db.select({
    id: itemsTable.id, nameAr: itemsTable.nameAr, code: itemsTable.code, unitId: itemsTable.unitId,
  }).from(itemsTable).where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, itemIds)));
  const companyUnits = await db.select({ id: unitsTable.id, nameAr: unitsTable.nameAr })
    .from(unitsTable).where(and(eq(unitsTable.companyId, cid), inArray(unitsTable.id, unitIds)));
  const unitPrices = await db.select({
    itemId: itemUnitPricesTable.itemId, unitId: itemUnitPricesTable.unitId,
    factor: itemUnitPricesTable.conversionFactor,
  }).from(itemUnitPricesTable).where(and(
    eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.isActive, true),
    inArray(itemUnitPricesTable.itemId, itemIds), inArray(itemUnitPricesTable.unitId, unitIds),
  ));
  if (companyItems.length !== itemIds.length || companyUnits.length !== new Set(unitIds).size) {
    throw invalid("الصنف أو الوحدة غير متاحة في هذه الشركة");
  }
  const itemById = new Map(companyItems.map(x => [x.id, x]));
  const unitById = new Map(companyUnits.map(x => [x.id, x]));
  const priceByPair = new Map(unitPrices.map(x => [`${x.itemId}:${x.unitId}`, Number(x.factor)]));
  for (const target of normalized) {
    const item = itemById.get(target.itemId)!;
    const factor = priceByPair.get(`${target.itemId}:${target.unitId}`);
    if (factor == null && item.unitId !== target.unitId) {
      throw invalid("الوحدة المختارة ليست وحدة مسجلة لهذا الصنف");
    }
    target.itemName = item.nameAr;
    target.itemCode = item.code;
    target.unitName = unitById.get(target.unitId)!.nameAr;
    target.conversionFactor = String(factor ?? 1);
  }
  const existingIndex = periods.findIndex((p: SalesRepTargetPeriod) => p.from === from && p.to === to);
  if (existingIndex >= 0 && periods[existingIndex].status === "approved") {
    throw invalid("الفترة معتمدة ولا يمكن تعديل التارجت الخاص بها");
  }
  const overlap = periods.find((p: SalesRepTargetPeriod) => p.enabled
    && !(p.from === from && p.to === to)
    && p.from <= to && from <= p.to);
  if (overlap) throw invalid(`تتداخل هذه الفترة مع تارجت محفوظ من ${overlap.from} إلى ${overlap.to}`);
  const period: SalesRepTargetPeriod = {
    from, to, enabled: true, items: normalized,
    calculationMode: input.calculationMode === "all_after_hit" ? "all_after_hit" : "excess",
    status: "open",
    commissionPct: String(commissionPct ?? 0),
  };
  if (existingIndex >= 0) periods[existingIndex] = period;
  else periods.push(period);
  return { periods: periods.sort((a, b) => a.from.localeCompare(b.from)) };
}

async function originalReturnEligibilityRatio(
  cid: number,
  repId: number,
  plan: SalesRepCommissionPlan | null | undefined,
  invoiceDate: string,
  itemId: number | null,
): Promise<number> {
  if (!itemId) return 1;
  const period = [...(plan?.periods ?? [])]
    .filter(p => p.from <= invoiceDate && invoiceDate <= p.to)
    .sort((a, b) => b.from.localeCompare(a.from))[0];
  if (!period?.enabled) return 1;
  const target = period.items.find(item => item.itemId === itemId);
  if (!target) return 0;
  const saved = period.snapshot?.targetProgress.find((x: any) => Number(x.itemId) === itemId);
  if (saved) {
    const achieved = Number(saved.achievedQty) || 0;
    return achieved > 0 ? Math.min(1, (Number(saved.commissionableQty) || 0) / achieved) : 0;
  }
  const rows = await db.select({
    qty: salesInvoiceLinesTable.qty,
    factor: salesInvoiceLinesTable.conversionFactor,
  }).from(salesInvoiceLinesTable).innerJoin(
    salesInvoicesTable, eq(salesInvoicesTable.id, salesInvoiceLinesTable.invoiceId),
  ).where(and(
    eq(salesInvoicesTable.companyId, cid),
    eq(salesInvoicesTable.salesRepId, repId),
    eq(salesInvoicesTable.status, "posted"),
    eq(salesInvoiceLinesTable.itemId, itemId),
    sql`${salesInvoicesTable.invoiceDate} >= ${period.from}`,
    sql`${salesInvoicesTable.invoiceDate} <= ${period.to}`,
  ));
  const achieved = rows.reduce((sum, row) => sum
    + Number(row.qty ?? 0) * Number(row.factor ?? 1) / Number(target.conversionFactor || 1), 0);
  const goal = Number(target.targetQty) || 0;
  const eligible = period.calculationMode === "all_after_hit"
    ? (achieved >= goal ? achieved : 0)
    : Math.max(0, achieved - goal);
  return achieved > 0 ? Math.min(1, eligible / achieved) : 0;
}

async function nextRepCode(cid: number): Promise<string> {
  const rows = await db.select({ code: salesRepsTable.code }).from(salesRepsTable)
    .where(eq(salesRepsTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^(?:SR|SREP|REP)?(\d+)$/.exec(String(r.code).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `SR${String(max + 1).padStart(4, "0")}`;
}

// ─── REPS LIST/CRUD ──────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(salesRepsTable)
      .where(eq(salesRepsTable.companyId, cid))
      .orderBy(desc(salesRepsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Resolve "the rep linked to the currently logged-in user" ───────────────
// Used by the frontend to (a) show a "هويتي كمندوب" badge on dashboards and
// (b) decide whether to make the salesRepId field on invoices read-only.
// Returns 404 (not 401) when no rep is linked so the UI can branch silently.
router.get("/me/current", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const uid = req.authUser?.id;
    if (!uid) { res.status(404).json({ error: "غير مرتبط" }); return; }
    // Company managers (admin) and superadmins keep FULL freedom: they must be
    // able to pick ANY rep on a document, even when their own user happens to be
    // linked to a sales rep. Returning "not linked" here unlocks the rep picker
    // in the UI for them (the create handler still lets them attribute to any rep
    // by passing salesRepId explicitly).
    const role = req.authUser?.role;
    if (role === "admin" || role === "superadmin" || hasDemoOperationalPrivilege(req.authUser, "sales_invoices", "create")) {
      res.status(404).json({ error: "مدير الشركة غير مقيّد بمندوب" }); return;
    }
    const [rep] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.companyId, cid), eq(salesRepsTable.userId, uid)));
    if (!rep) { res.status(404).json({ error: "لا يوجد مندوب مرتبط بهذا المستخدم" }); return; }
    res.json(rep);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/active", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.companyId, cid), eq(salesRepsTable.isActive, true)))
      .orderBy(salesRepsTable.nameAr);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/target-items", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const query = String(req.query.q ?? "").trim().slice(0, 128);
    const selectedIds = [...new Set(String(req.query.ids ?? "").split(",")
      .map(value => Number(value.trim()))
      .filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 50);
    const itemSelect = {
      id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn,
      baseUnitId: itemsTable.unitId, baseUnitName: unitsTable.nameAr,
    };
    const searchCondition = query
      ? and(eq(itemsTable.companyId, cid), or(
          ilike(itemsTable.code, `%${query}%`),
          ilike(itemsTable.barcode, `%${query}%`),
          ilike(itemsTable.nameAr, `%${query}%`),
          ilike(itemsTable.nameEn, `%${query}%`),
        )!)
      : eq(itemsTable.companyId, cid);
    const searchItems = await db.select(itemSelect).from(itemsTable)
      .leftJoin(unitsTable, eq(unitsTable.id, itemsTable.unitId))
      .where(searchCondition)
      .orderBy(itemsTable.nameAr)
      .limit(50);
    const selectedItems = selectedIds.length
      ? await db.select(itemSelect).from(itemsTable)
          .leftJoin(unitsTable, eq(unitsTable.id, itemsTable.unitId))
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, selectedIds)))
      : [];
    const items = [...new Map([...searchItems, ...selectedItems].map(item => [item.id, item])).values()];
    const itemIds = items.map(item => item.id);
    const prices = itemIds.length ? await db.select({
      itemId: itemUnitPricesTable.itemId, unitId: itemUnitPricesTable.unitId,
      unitName: unitsTable.nameAr, factor: itemUnitPricesTable.conversionFactor,
    }).from(itemUnitPricesTable)
      .innerJoin(unitsTable, eq(unitsTable.id, itemUnitPricesTable.unitId))
      .where(and(
        eq(itemUnitPricesTable.companyId, cid),
        eq(itemUnitPricesTable.isActive, true),
        inArray(itemUnitPricesTable.itemId, itemIds),
      )) : [];
    const byItem = new Map<number, Array<{ unitId: number; unitName: string; conversionFactor: number }>>();
    for (const p of prices) {
      const list = byItem.get(p.itemId) ?? [];
      list.push({ unitId: p.unitId, unitName: p.unitName, conversionFactor: Number(p.factor) || 1 });
      byItem.set(p.itemId, list);
    }
    res.json(items.map(item => {
      const options = byItem.get(item.id) ?? [];
      if (item.baseUnitId && !options.some(x => x.unitId === item.baseUnitId)) {
        options.unshift({ unitId: item.baseUnitId, unitName: item.baseUnitName ?? "الوحدة الأساسية", conversionFactor: 1 });
      }
      return { ...item, units: options };
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "المندوب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم المندوب مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextRepCode(cid);

    if (b.accountId) {
      try { await ensureLeafAccounts(cid, [b.accountId]); }
      catch (err: any) { res.status(400).json({ error: err?.message ?? "حساب غير صالح" }); return; }
    }

    const [row] = await db.insert(salesRepsTable).values({
      companyId:      cid,
      code,
      nameAr,
      nameEn:         b.nameEn || null,
      phone:          b.phone || null,
      email:          b.email || null,
      address:        b.address || null,
      branchId:       b.branchId ? Number(b.branchId) : null,
      region:         b.region || null,
      isActive:       b.isActive !== false,
      userId:         b.userId ? Number(b.userId) : null,
      commissionPct:  b.commissionPct != null ? String(b.commissionPct) : "0",
      commissionType: b.commissionType === "collection" ? "collection" : "invoice",
      monthlyTarget:  b.monthlyTarget != null ? String(b.monthlyTarget) : "0",
      commissionPlan: await targetPlanWithPeriod(cid, { periods: [] }, b.targetPeriod, b.commissionPct),
      accountId:      b.accountId ? Number(b.accountId) : null,
      notes:          b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("sales_reps_user_uniq"))
      return res.status(409).json({ error: "هذا المستخدم مرتبط بمندوب آخر بالفعل" });
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود المندوب مستخدم مسبقاً" });
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [current] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "المندوب غير موجود" }); return; }

    if (b.accountId) {
      try { await ensureLeafAccounts(cid, [b.accountId]); }
      catch (err: any) { res.status(400).json({ error: err?.message ?? "حساب غير صالح" }); return; }
    }

    const [row] = await db.update(salesRepsTable).set({
      code:           b.code != null ? String(b.code).trim() : undefined,
      nameAr:         b.nameAr != null ? String(b.nameAr).trim() : undefined,
      nameEn:         b.nameEn ?? null,
      phone:          b.phone ?? null,
      email:          b.email ?? null,
      address:        b.address ?? null,
      branchId:       b.branchId ? Number(b.branchId) : null,
      region:         b.region ?? null,
      isActive:       b.isActive !== undefined ? !!b.isActive : undefined,
      userId:         b.userId === null ? null : (b.userId ? Number(b.userId) : undefined),
      commissionPct:  b.commissionPct != null ? String(b.commissionPct) : undefined,
      commissionType: b.commissionType === "collection" ? "collection"
                      : b.commissionType === "invoice" ? "invoice" : undefined,
      monthlyTarget:  b.monthlyTarget != null ? String(b.monthlyTarget) : undefined,
      commissionPlan: b.targetPeriod !== undefined
        ? await targetPlanWithPeriod(cid, current.commissionPlan, b.targetPeriod, b.commissionPct ?? current.commissionPct)
        : undefined,
      accountId:      b.accountId ? Number(b.accountId) : null,
      notes:          b.notes ?? null,
      updatedAt:      new Date(),
    }).where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid))).returning();

    if (!row) { res.status(404).json({ error: "المندوب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Refuse delete when the rep is referenced from invoices, customers, or
    // receipt vouchers — the user should deactivate instead so historical
    // commission history (incl. collection-based commissions) stays intact.
    const [{ n: invN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.salesRepId, id)));
    const [{ n: custN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(and(eq(customersTable.companyId, cid), eq(customersTable.salesRepId, id)));
    const [{ n: rcvN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.salesRepId, id)));
    if (invN > 0 || custN > 0 || rcvN > 0) {
      res.status(409).json({
        error: `لا يمكن حذف المندوب — مرتبط بـ ${invN} فاتورة و ${custN} عميل و ${rcvN} سند قبض. يمكنك تعطيله بدلاً من ذلك.`,
      });
      return;
    }

    await db.delete(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ONE-CLICK REP ONBOARDING ────────────────────────────────────────────────
// Activates the customer-isolation scope on the rep's linked user AND grants
// the standard rep permission set. Without this, the admin had to (a) flip
// `scopeOwnCustomersOnly` on the user screen, (b) toggle ~10 permission
// checkboxes one-by-one, and (c) hope they didn't miss any — a frequent
// support pain point that was leaving reps either with no access at all
// (403 on save) or with their newly-created customers invisible to them.
//
// Behavior:
//   - Requires the rep to have `userId` linked (else 400)
//   - Sets users.scopeOwnCustomersOnly = true
//   - MERGES (not replaces) the standard rep permission set into
//     users.permissions, so any extra perms an admin granted manually are
//     preserved. Only adds — never removes.
//   - Idempotent: safe to click multiple times.
//   - Admin / superadmin only (RBAC layer above already enforces sales_invoices)
//
// Standard rep set (view+create+edit on customer-facing surfaces; view-only
// on the supporting reads they need to actually do their job):
const REP_BASE_PERMISSIONS: Record<string, Partial<Record<string, boolean>>> = {
  dashboard:                  { view: true },
  dashboard_recent_invoices:  { view: true },
  customers:                  { view: true, create: true, edit: true },
  sales_quotations:           { view: true, create: true, edit: true, post: true },
  sales_invoices:             { view: true, create: true, edit: true, post: true },
  sales_returns:              { view: true, create: true, edit: true, post: true },
  receipt_vouchers:           { view: true, create: true, edit: true },
  cash_boxes:                 { view: true },
  bank_accounts:              { view: true },
  // NOTE: items / warehouses are intentionally NOT granted here.
  // The sales-invoice form needs to read them, but giving the full
  // `items.view` / `warehouses.view` perm would also expose the inventory
  // dashboard (with cost totals!), item-groups, units, goods-receipt
  // screens — none of which a rep should see. Instead, see the lookup
  // bypass in artifacts/api-server/src/middleware/permissions.ts that
  // grants implicit read access to items+warehouses for any user with
  // sales_invoices.create or sales_quotations.create.
  //
  // sales_reports is also intentionally NOT granted: it shows aggregate
  // company-wide sales (all reps), which a rep must not see.
};

router.post("/:id/onboard-user", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const repId = Number(req.params.id);
    const [rep] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, repId), eq(salesRepsTable.companyId, cid)));
    if (!rep) { res.status(404).json({ error: "المندوب غير موجود" }); return; }
    if (!rep.userId) {
      res.status(400).json({ error: "هذا المندوب غير مربوط بأي مستخدم — اربطه بمستخدم أولاً ثم أعد المحاولة." });
      return;
    }
    // Merge with whatever the admin already had, so we never silently strip
    // extra perms (e.g. they granted purchase_invoices.view manually).
    const [u] = await db.select({ permissions: usersTable.permissions })
      .from(usersTable).where(eq(usersTable.id, rep.userId));
    const current = (u?.permissions as Record<string, Record<string, boolean>> | null) ?? {};
    const merged: Record<string, Record<string, boolean>> = { ...current };
    for (const [mod, actions] of Object.entries(REP_BASE_PERMISSIONS)) {
      merged[mod] = { ...(current[mod] ?? {}), ...(actions as Record<string, boolean>) };
    }

    await db.update(usersTable)
      .set({ scopeOwnCustomersOnly: true, permissions: merged as any })
      .where(eq(usersTable.id, rep.userId));

    req.log?.info({ repId, userId: rep.userId, cid }, "rep_onboard_user");
    res.json({ ok: true, userId: rep.userId, modules: Object.keys(REP_BASE_PERMISSIONS) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── VISITS ─────────────────────────────────────────────────────────────────
router.get("/:id/visits", async (req, res) => {
  try {
    const cid = requireCid(req, res);
    const repId = Number(req.params.id);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesRepVisitsTable)
      .where(and(eq(salesRepVisitsTable.companyId, cid), eq(salesRepVisitsTable.salesRepId, repId)))
      .orderBy(desc(salesRepVisitsTable.visitDate), desc(salesRepVisitsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/visits", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const repId = Number(req.params.id);
    const b = req.body ?? {};
    if (!b.visitDate) { res.status(400).json({ error: "تاريخ الزيارة مطلوب" }); return; }

    const [row] = await db.insert(salesRepVisitsTable).values({
      companyId:    cid,
      salesRepId:   repId,
      customerId:   b.customerId ? Number(b.customerId) : null,
      visitDate:    String(b.visitDate),
      status:       ["planned","completed","cancelled"].includes(b.status) ? b.status : "completed",
      outcome:      ["none","interested","quotation_sent","deal_closed","no_interest","follow_up"].includes(b.outcome) ? b.outcome : "none",
      notes:        b.notes || null,
      followUpDate: b.followUpDate || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/visits/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const vid = Number(req.params.vid);
    const b = req.body ?? {};
    const [row] = await db.update(salesRepVisitsTable).set({
      customerId:   b.customerId ? Number(b.customerId) : null,
      visitDate:    b.visitDate ? String(b.visitDate) : undefined,
      status:       ["planned","completed","cancelled"].includes(b.status) ? b.status : undefined,
      outcome:      ["none","interested","quotation_sent","deal_closed","no_interest","follow_up"].includes(b.outcome) ? b.outcome : undefined,
      notes:        b.notes ?? null,
      followUpDate: b.followUpDate ?? null,
      updatedAt:    new Date(),
    }).where(and(eq(salesRepVisitsTable.id, vid), eq(salesRepVisitsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الزيارة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/visits/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const vid = Number(req.params.vid);
    await db.delete(salesRepVisitsTable)
      .where(and(eq(salesRepVisitsTable.id, vid), eq(salesRepVisitsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── REPORTS ────────────────────────────────────────────────────────────────
// Sales + commissions per rep, optionally filtered by date range.
router.get("/reports/sales", async (req, res) => {
  try {
    const cid = requireCid(req, res);
    if (!cid) { res.json([]); return; }
    const from = req.query.from ? String(req.query.from) : null;
    const to   = req.query.to   ? String(req.query.to)   : null;

    const reps = await db.select().from(salesRepsTable)
      .where(eq(salesRepsTable.companyId, cid));

    // Sum posted invoices grouped by salesRepId in the given date range.
    const conds = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.status, "posted"),
    ];
    if (from) conds.push(sql`${salesInvoicesTable.invoiceDate} >= ${from}`);
    if (to)   conds.push(sql`${salesInvoicesTable.invoiceDate} <= ${to}`);

    const sums = await db
      .select({
        salesRepId:       salesInvoicesTable.salesRepId,
        invoiceCount:     sql<number>`count(*)::int`,
        totalSales:       sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
        totalCommission:  sql<string>`COALESCE(SUM(${salesInvoicesTable.commissionAmount}), 0)`,
      })
      .from(salesInvoicesTable)
      .where(and(...conds))
      .groupBy(salesInvoicesTable.salesRepId);

    // Posted receipts collected by each rep (only meaningful when commissionType=collection)
    const recvConds = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.status, "posted"),
    ];
    if (from) recvConds.push(sql`${receiptVouchersTable.date} >= ${from}`);
    if (to)   recvConds.push(sql`${receiptVouchersTable.date} <= ${to}`);
    const collections = await db
      .select({
        salesRepId: receiptVouchersTable.salesRepId,
        collected:  sql<string>`COALESCE(SUM(${receiptVouchersTable.amount}), 0)`,
      })
      .from(receiptVouchersTable)
      .where(and(...recvConds))
      .groupBy(receiptVouchersTable.salesRepId);

    const sumMap = new Map(sums.map(s => [s.salesRepId, s]));
    const colMap = new Map(collections.map(c => [c.salesRepId, c]));

    const out = reps.map(r => {
      const s = sumMap.get(r.id);
      const c = colMap.get(r.id);
      const totalSales      = Number(s?.totalSales      ?? 0);
      const totalCommission = Number(s?.totalCommission ?? 0);
      const collected       = Number(c?.collected       ?? 0);
      const target          = Number(r.monthlyTarget    ?? 0);
      // For collection-type reps, recompute commission from collections × pct
      const effectiveCommission = r.commissionType === "collection"
        ? collected * (Number(r.commissionPct) / 100)
        : totalCommission;
      return {
        salesRepId:       r.id,
        code:             r.code,
        nameAr:           r.nameAr,
        commissionPct:    Number(r.commissionPct),
        commissionType:   r.commissionType,
        monthlyTarget:    target,
        invoiceCount:     s?.invoiceCount ?? 0,
        totalSales,
        collected,
        commission:       effectiveCommission,
        targetAchievedPct: target > 0 ? Math.round((totalSales / target) * 100) : null,
      };
    });
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── COMMISSION DETAIL (per rep, with invoice breakdown) ────────────────────
// GET /api/sales-reps/:id/commission-detail?from=&to=&companyId=
// Returns: { rep, summary, invoices[], collections[] }
// summary uses commissionType to pick the correct base:
//   - invoice-based: commission = sum of invoice.commissionAmount snapshots
//   - collection-based: commission = sum(collected) × rep.commissionPct / 100
router.get("/:id/commission-detail", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const from = req.query.from ? String(req.query.from) : null;
    const to   = req.query.to   ? String(req.query.to)   : null;

    const [rep] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!rep) { res.status(404).json({ error: "المندوب غير موجود" }); return; }

    const invConds = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.salesRepId, id),
      eq(salesInvoicesTable.status, "posted"),
    ];
    if (from) invConds.push(sql`${salesInvoicesTable.invoiceDate} >= ${from}`);
    if (to)   invConds.push(sql`${salesInvoicesTable.invoiceDate} <= ${to}`);

    const invoices = await db.select({
      id:               salesInvoicesTable.id,
      invoiceNumber:    salesInvoicesTable.docNumber,
      invoiceDate:      salesInvoicesTable.invoiceDate,
      customerId:       salesInvoicesTable.customerId,
      totalAmount:      salesInvoicesTable.totalAmount,
      commissionPct:    salesInvoicesTable.commissionPct,
      commissionAmount: salesInvoicesTable.commissionAmount,
    })
      .from(salesInvoicesTable)
      .where(and(...invConds))
      .orderBy(desc(salesInvoicesTable.invoiceDate));

    // Customer names for the invoice list
    const custIds = Array.from(new Set(invoices.map(i => i.customerId).filter((x): x is number => x != null)));
    const customers = custIds.length
      ? await db.select({ id: customersTable.id, nameAr: customersTable.nameAr })
          .from(customersTable)
          .where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, custIds)))
      : [];
    const custMap = new Map(customers.map(c => [c.id, c.nameAr]));

    // Collections by this rep in the same window (used for collection-type)
    const colConds = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.salesRepId, id),
      eq(receiptVouchersTable.status, "posted"),
    ];
    if (from) colConds.push(sql`${receiptVouchersTable.date} >= ${from}`);
    if (to)   colConds.push(sql`${receiptVouchersTable.date} <= ${to}`);
    const collections = await db.select({
      id:     receiptVouchersTable.id,
      date:   receiptVouchersTable.date,
      amount: receiptVouchersTable.amount,
    })
      .from(receiptVouchersTable)
      .where(and(...colConds))
      .orderBy(desc(receiptVouchersTable.date));

    const totalSales      = invoices.reduce((s, i) => s + Number(i.totalAmount      ?? 0), 0);
    const totalCommission = invoices.reduce((s, i) => s + Number(i.commissionAmount ?? 0), 0);
    const totalCollected  = collections.reduce((s, r) => s + Number(r.amount        ?? 0), 0);
    const repPct = Number(rep.commissionPct ?? 0);
    const period = rep.commissionPlan?.periods?.find(p => p.from === from && p.to === to) ?? null;
    const targetActive = !!period?.enabled;
    const targetSalesLines = targetActive ? await db.select({
      invoiceId: salesInvoiceLinesTable.invoiceId,
      itemId: salesInvoiceLinesTable.itemId,
      itemName: salesInvoiceLinesTable.itemName,
      qty: salesInvoiceLinesTable.qty,
      factor: salesInvoiceLinesTable.conversionFactor,
      lineTotal: salesInvoiceLinesTable.lineTotal,
      invoiceTotal: salesInvoicesTable.totalAmount,
      commissionPct: salesInvoicesTable.commissionPct,
    }).from(salesInvoiceLinesTable)
      .innerJoin(salesInvoicesTable, eq(salesInvoicesTable.id, salesInvoiceLinesTable.invoiceId))
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.salesRepId, id),
        eq(salesInvoicesTable.status, "posted"),
        ...(from ? [sql`${salesInvoicesTable.invoiceDate} >= ${from}`] : []),
        ...(to ? [sql`${salesInvoicesTable.invoiceDate} <= ${to}`] : []),
      )) : [];
    const targetNetByInvoice = new Map<number, number>();
    for (const line of targetSalesLines) {
      targetNetByInvoice.set(line.invoiceId,
        (targetNetByInvoice.get(line.invoiceId) ?? 0) + Number(line.lineTotal ?? 0));
    }
    const commissionBaseForLine = (line: typeof targetSalesLines[number]) => {
      const netTotal = targetNetByInvoice.get(line.invoiceId) ?? 0;
      return netTotal > 0
        ? Number(line.invoiceTotal ?? 0) * Number(line.lineTotal ?? 0) / netTotal
        : Number(line.lineTotal ?? 0);
    };
    const targetProgress = (period?.enabled ? period.items : []).map(target => {
      const lines = targetSalesLines.filter(line => line.itemId === target.itemId);
      const soldQty = lines.reduce((sum, line) => sum
        + Number(line.qty ?? 0) * Number(line.factor ?? 1) / Number(target.conversionFactor || 1), 0);
      const goal = Number(target.targetQty) || 0;
      const eligibleQty = period?.calculationMode === "all_after_hit"
        ? (soldQty >= goal ? soldQty : 0)
        : Math.max(0, soldQty - goal);
      const ratio = soldQty > 0 ? Math.min(1, eligibleQty / soldQty) : 0;
      const eligibleSales = lines.reduce((sum, line) => sum + commissionBaseForLine(line) * ratio, 0);
      return {
        itemId: target.itemId, itemName: target.itemName, itemCode: target.itemCode,
        unitId: target.unitId, unitName: target.unitName,
        targetQty: goal, achievedQty: Number(soldQty.toFixed(4)),
        remainingQty: Number(Math.max(0, goal - soldQty).toFixed(4)),
        achievementPct: goal > 0 ? Number((soldQty / goal * 100).toFixed(1)) : 0,
        commissionableQty: Number(eligibleQty.toFixed(4)), eligibleSales,
      };
    });
    const targetMap = new Map(targetProgress.map(target => [target.itemId, target]));
    const targetHit = targetProgress.length > 0 && targetProgress.every(target => target.achievedQty >= target.targetQty);
    const invoiceCommissionById = new Map<number, number>();
    for (const line of targetSalesLines) {
      const target = targetMap.get(line.itemId ?? -1);
      if (!target) continue;
      const ratio = Number(line.qty) > 0
        ? Math.min(1, target.commissionableQty / Math.max(target.achievedQty, 0.000001))
        : 0;
      const commission = commissionBaseForLine(line) * ratio * Number(line.commissionPct ?? repPct) / 100;
      invoiceCommissionById.set(line.invoiceId, (invoiceCommissionById.get(line.invoiceId) ?? 0) + commission);
    }
    const invoiceTargetCommission = [...invoiceCommissionById.values()].reduce((sum, x) => sum + x, 0);
    const targetEligibleSales = targetProgress.reduce((sum, target) => sum + target.eligibleSales, 0);
    const targetTrackedSales = targetProgress.reduce((sum, target) => sum
      + targetSalesLines.filter(line => line.itemId === target.itemId)
        .reduce((lineSum, line) => lineSum + commissionBaseForLine(line), 0), 0);
    const collectionEligibility = period?.calculationMode === "all_after_hit"
      ? (targetHit ? 1 : 0)
      : (targetTrackedSales > 0 ? Math.min(1, targetEligibleSales / targetTrackedSales) : 0);
    const grossCommission = targetActive
      ? (rep.commissionType === "collection"
        ? totalCollected * (Number(period?.commissionPct ?? repPct) / 100) * collectionEligibility
        : invoiceTargetCommission)
      : (rep.commissionType === "collection" ? totalCollected * (repPct / 100) : totalCommission);
    const returnLines = targetActive ? await db.select({
      returnId: salesReturnsTable.id,
      returnNumber: salesReturnsTable.docNumber,
      returnDate: salesReturnsTable.returnDate,
      invoiceId: salesInvoicesTable.id,
      invoiceNumber: salesInvoicesTable.docNumber,
      invoiceDate: salesInvoicesTable.invoiceDate,
      itemId: salesReturnLinesTable.itemId,
      itemName: salesReturnLinesTable.itemName,
      qty: salesReturnLinesTable.qty,
      unit: salesReturnLinesTable.unit,
      lineTotal: salesReturnLinesTable.lineTotal,
      returnTotal: salesReturnsTable.totalAmount,
      invoicePct: salesInvoicesTable.commissionPct,
    }).from(salesReturnLinesTable)
      .innerJoin(salesReturnsTable, eq(salesReturnsTable.id, salesReturnLinesTable.returnId))
      .innerJoin(salesInvoicesTable, eq(salesInvoicesTable.id, salesReturnsTable.invoiceId))
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        eq(salesReturnsTable.status, "posted"),
        eq(salesInvoicesTable.salesRepId, id),
        ...(from ? [sql`${salesReturnsTable.returnDate} >= ${from}`] : []),
        ...(to ? [sql`${salesReturnsTable.returnDate} <= ${to}`] : []),
      )) : [];
    const returnNetById = new Map<number, number>();
    for (const line of returnLines) returnNetById.set(line.returnId,
      (returnNetById.get(line.returnId) ?? 0) + Number(line.lineTotal ?? 0));
    const returnAdjustments = await Promise.all(returnLines.map(async line => {
      const ratio = await originalReturnEligibilityRatio(cid, id, rep.commissionPlan, line.invoiceDate, line.itemId);
      const returnNet = returnNetById.get(line.returnId) ?? 0;
      const commissionBase = returnNet > 0
        ? Number(line.returnTotal ?? 0) * Number(line.lineTotal ?? 0) / returnNet
        : Number(line.lineTotal ?? 0);
      return {
        returnId: line.returnId, returnNumber: line.returnNumber, returnDate: line.returnDate,
        invoiceId: line.invoiceId, invoiceNumber: line.invoiceNumber,
        itemId: line.itemId, itemName: line.itemName, qty: Number(line.qty ?? 0), unit: line.unit,
        lineTotal: Number(commissionBase.toFixed(2)),
        commissionDeduction: Number((commissionBase * Number(line.invoicePct ?? repPct) / 100 * ratio).toFixed(2)),
      };
    }));
    const returnDeductions = returnAdjustments.reduce((sum, line) => sum + Number(line.commissionDeduction ?? 0), 0);
    let effectiveCommission = grossCommission - returnDeductions;
    let effectiveTargetProgress = targetProgress;
    if (period?.status === "approved" && period.snapshot) {
      effectiveCommission = period.snapshot.netCommission;
      effectiveTargetProgress = period.snapshot.targetProgress as typeof targetProgress;
    }
    const frozen = period?.status === "approved" ? period.snapshot : undefined;
    const summarySales = frozen?.totalSales ?? totalSales;
    const summaryCollected = frozen?.totalCollected ?? totalCollected;
    const summaryGross = frozen?.grossCommission ?? grossCommission;
    const summaryReturns = frozen?.returnDeductions ?? returnDeductions;
    const target = Number(rep.monthlyTarget ?? 0);

    res.json({
      rep: {
        id: rep.id,
        code: rep.code,
        nameAr: rep.nameAr,
        nameEn: rep.nameEn,
        region: rep.region,
        commissionPct: repPct,
        commissionType: rep.commissionType,
        monthlyTarget: target,
        isActive: rep.isActive,
      },
      window: { from, to },
      summary: {
        invoiceCount:        frozen?.invoiceCount ?? invoices.length,
        totalSales:          Number(summarySales.toFixed(2)),
        totalCommissionRaw:  Number((frozen?.totalCommissionRaw ?? (targetActive && rep.commissionType === "invoice" ? invoiceTargetCommission : totalCommission)).toFixed(2)),
        totalCollected:      Number(summaryCollected.toFixed(2)),
        grossCommission: Number(summaryGross.toFixed(2)),
        returnDeductions: Number(summaryReturns.toFixed(2)),
        effectiveCommission: Number(effectiveCommission.toFixed(2)),
        avgInvoiceValue:     frozen?.avgInvoiceValue ?? (invoices.length ? Number((summarySales / invoices.length).toFixed(2)) : 0),
        targetAchievedPct:   frozen?.targetAchievedPct ?? (target > 0 ? Math.round((summarySales / target) * 100) : null),
      },
      invoices: frozen?.invoices ?? invoices.map(i => ({
        id:               i.id,
        invoiceNumber:    i.invoiceNumber,
        invoiceDate:      i.invoiceDate,
        customerName:     i.customerId != null ? (custMap.get(i.customerId) ?? `#${i.customerId}`) : "—",
        totalAmount:      Number(i.totalAmount ?? 0),
        commissionPct:    Number(i.commissionPct ?? 0),
        commissionAmount: Number(targetActive && rep.commissionType === "invoice"
          ? (invoiceCommissionById.get(i.id) ?? 0)
          : (i.commissionAmount ?? 0)),
      })),
      collections: frozen?.collections ?? collections.map(c => ({
        id:     c.id,
        date:   c.date,
        amount: Number(c.amount ?? 0),
      })),
      targetPeriod: period ? { from: period.from, to: period.to, enabled: period.enabled, status: period.status, calculationMode: period.calculationMode } : null,
      targetProgress: effectiveTargetProgress,
      returnAdjustments: frozen?.returnAdjustments ?? returnAdjustments,
      returnDeductions: Number(summaryReturns.toFixed(2)),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/commission-period/approve", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const from = String(req.body?.from ?? "");
    const to = String(req.body?.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      res.status(400).json({ error: "حدد فترة صحيحة قبل الاعتماد" }); return;
    }
    const snapshot = await db.transaction(async tx => {
      const [rep] = await tx.select().from(salesRepsTable).where(and(
        eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid),
      )).for("update");
      if (!rep) throw Object.assign(new Error("المندوب غير موجود"), { status: 404 });
      const plan = rep.commissionPlan ?? { periods: [] };
      const ix = plan.periods.findIndex(p => p.from === from && p.to === to);
      if (ix < 0) throw Object.assign(new Error("لا توجد إعدادات تارجت لهذه الفترة"), { status: 400 });
      const period = plan.periods[ix];
      if (period.status === "approved") throw Object.assign(new Error("الفترة معتمدة بالفعل"), { status: 409 });

      const invoices = await tx.select({
        id: salesInvoicesTable.id,
        invoiceNumber: salesInvoicesTable.docNumber,
        invoiceDate: salesInvoicesTable.invoiceDate,
        customerId: salesInvoicesTable.customerId,
        totalAmount: salesInvoicesTable.totalAmount,
        commissionPct: salesInvoicesTable.commissionPct,
        commissionAmount: salesInvoicesTable.commissionAmount,
      }).from(salesInvoicesTable).where(and(
        eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.salesRepId, id),
        eq(salesInvoicesTable.status, "posted"),
        sql`${salesInvoicesTable.invoiceDate} >= ${from}`,
        sql`${salesInvoicesTable.invoiceDate} <= ${to}`,
      ));
      const totalSales = invoices.reduce((s, x) => s + Number(x.totalAmount ?? 0), 0);
      const invoiceCommission = invoices.reduce((s, x) => s + Number(x.commissionAmount ?? 0), 0);
      const collections = await tx.select({
        id: receiptVouchersTable.id, date: receiptVouchersTable.date, amount: receiptVouchersTable.amount,
      }).from(receiptVouchersTable).where(and(
        eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.salesRepId, id),
        eq(receiptVouchersTable.status, "posted"),
        sql`${receiptVouchersTable.date} >= ${from}`, sql`${receiptVouchersTable.date} <= ${to}`,
      ));
      const totalCollected = collections.reduce((s, x) => s + Number(x.amount ?? 0), 0);
      const lines = period.enabled ? await tx.select({
        invoiceId: salesInvoiceLinesTable.invoiceId,
        itemId: salesInvoiceLinesTable.itemId, qty: salesInvoiceLinesTable.qty,
        factor: salesInvoiceLinesTable.conversionFactor, lineTotal: salesInvoiceLinesTable.lineTotal,
        invoiceTotal: salesInvoicesTable.totalAmount,
        commissionPct: salesInvoicesTable.commissionPct,
      }).from(salesInvoiceLinesTable).innerJoin(
        salesInvoicesTable, eq(salesInvoicesTable.id, salesInvoiceLinesTable.invoiceId),
      ).where(and(
        eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.salesRepId, id),
        eq(salesInvoicesTable.status, "posted"),
        sql`${salesInvoicesTable.invoiceDate} >= ${from}`, sql`${salesInvoicesTable.invoiceDate} <= ${to}`,
      )) : [];
      const lineNetByInvoice = new Map<number, number>();
      for (const line of lines) lineNetByInvoice.set(line.invoiceId,
        (lineNetByInvoice.get(line.invoiceId) ?? 0) + Number(line.lineTotal ?? 0));
      const grossBaseForLine = (line: typeof lines[number]) => {
        const net = lineNetByInvoice.get(line.invoiceId) ?? 0;
        return net > 0 ? Number(line.invoiceTotal ?? 0) * Number(line.lineTotal ?? 0) / net
          : Number(line.lineTotal ?? 0);
      };
      const targetProgress = period.enabled ? period.items.map(target => {
        const targetLines = lines.filter(x => x.itemId === target.itemId);
        const achievedQty = targetLines.reduce((s, x) => s
          + Number(x.qty ?? 0) * Number(x.factor ?? 1) / Number(target.conversionFactor || 1), 0);
        const goal = Number(target.targetQty);
        const commissionableQty = period.calculationMode === "all_after_hit"
          ? (achievedQty >= goal ? achievedQty : 0) : Math.max(0, achievedQty - goal);
        const ratio = achievedQty > 0 ? Math.min(1, commissionableQty / achievedQty) : 0;
        return {
          itemId: target.itemId, itemName: target.itemName, unitName: target.unitName,
          targetQty: goal, achievedQty: Number(achievedQty.toFixed(4)),
          remainingQty: Number(Math.max(0, goal - achievedQty).toFixed(4)),
          achievementPct: goal ? Number((achievedQty / goal * 100).toFixed(1)) : 0,
          commissionableQty: Number(commissionableQty.toFixed(4)),
          eligibleSales: targetLines.reduce((s, x) => s + grossBaseForLine(x) * ratio, 0),
        };
      }) : [];
      const targetById = new Map(targetProgress.map(x => [x.itemId, x]));
      const targetSales = targetProgress.reduce((s, x) => s + x.eligibleSales, 0);
      const trackedSales = lines.filter(x => targetById.has(x.itemId ?? -1))
        .reduce((s, x) => s + grossBaseForLine(x), 0);
      const allHit = targetProgress.length > 0 && targetProgress.every(x => x.achievedQty >= x.targetQty);
      const eligibleRatio = period.calculationMode === "all_after_hit"
        ? (allHit ? 1 : 0) : (trackedSales ? Math.min(1, targetSales / trackedSales) : 0);
      const invoiceCommissionById = new Map<number, number>();
      for (const x of lines) {
        const target = targetById.get(x.itemId ?? -1);
        if (!target) continue;
        const ratio = target.achievedQty ? Math.min(1, target.commissionableQty / target.achievedQty) : 0;
        const commission = grossBaseForLine(x) * ratio * Number(x.commissionPct ?? period.commissionPct) / 100;
        invoiceCommissionById.set(x.invoiceId, (invoiceCommissionById.get(x.invoiceId) ?? 0) + commission);
      }
      const invoiceTargetCommission = [...invoiceCommissionById.values()].reduce((s, x) => s + x, 0);
      const grossCommission = period.enabled
        ? (rep.commissionType === "collection"
          ? totalCollected * Number(period.commissionPct) / 100 * eligibleRatio
          : invoiceTargetCommission)
        : (rep.commissionType === "collection"
          ? totalCollected * Number(period.commissionPct) / 100 : invoiceCommission);
      const returns = await tx.select({
        returnId: salesReturnsTable.id,
        returnNumber: salesReturnsTable.docNumber,
        returnDate: salesReturnsTable.returnDate,
        invoiceId: salesInvoicesTable.id,
        invoiceNumber: salesInvoicesTable.docNumber,
        invoiceDate: salesInvoicesTable.invoiceDate,
        itemId: salesReturnLinesTable.itemId, lineTotal: salesReturnLinesTable.lineTotal,
        returnTotal: salesReturnsTable.totalAmount,
        itemName: salesReturnLinesTable.itemName,
        qty: salesReturnLinesTable.qty, unit: salesReturnLinesTable.unit,
        invoicePct: salesInvoicesTable.commissionPct,
      }).from(salesReturnLinesTable).innerJoin(
        salesReturnsTable, eq(salesReturnsTable.id, salesReturnLinesTable.returnId),
      ).innerJoin(
        salesInvoicesTable, eq(salesInvoicesTable.id, salesReturnsTable.invoiceId),
      ).where(and(
        eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted"),
        eq(salesInvoicesTable.salesRepId, id),
        sql`${salesReturnsTable.returnDate} >= ${from}`, sql`${salesReturnsTable.returnDate} <= ${to}`,
      ));
      const returnNetById = new Map<number, number>();
      for (const line of returns) returnNetById.set(line.returnId,
        (returnNetById.get(line.returnId) ?? 0) + Number(line.lineTotal ?? 0));
      const returnAdjustments = period.enabled ? await Promise.all(returns.map(async x => {
        const ratio = await originalReturnEligibilityRatio(cid, id, rep.commissionPlan, x.invoiceDate, x.itemId);
        const returnNet = returnNetById.get(x.returnId) ?? 0;
        const commissionBase = returnNet > 0
          ? Number(x.returnTotal ?? 0) * Number(x.lineTotal ?? 0) / returnNet
          : Number(x.lineTotal ?? 0);
        return {
          returnId: x.returnId, returnNumber: x.returnNumber, returnDate: x.returnDate,
          invoiceId: x.invoiceId, invoiceNumber: x.invoiceNumber, itemId: x.itemId,
          itemName: x.itemName, qty: Number(x.qty ?? 0), unit: x.unit,
          lineTotal: Number(commissionBase.toFixed(2)),
          commissionDeduction: Number((commissionBase * Number(x.invoicePct ?? period.commissionPct) / 100 * ratio).toFixed(2)),
        };
      })) : [];
      const returnDeductions = returnAdjustments.reduce((s, x) => s + Number(x.commissionDeduction ?? 0), 0);
      const customerIds = Array.from(new Set(invoices.map(x => x.customerId).filter((x): x is number => x != null)));
      const customerRows = customerIds.length ? await tx.select({
        id: customersTable.id, nameAr: customersTable.nameAr,
      }).from(customersTable).where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, customerIds))) : [];
      const customerNames = new Map(customerRows.map(x => [x.id, x.nameAr]));
      const saved = {
        invoiceCount: invoices.length,
        totalSales,
        totalCommissionRaw: period.enabled && rep.commissionType === "invoice" ? invoiceTargetCommission : invoiceCommission,
        totalCollected,
        grossCommission,
        returnDeductions,
        netCommission: grossCommission - returnDeductions,
        avgInvoiceValue: invoices.length ? totalSales / invoices.length : 0,
        targetAchievedPct: Number(rep.monthlyTarget) > 0 ? Math.round(totalSales / Number(rep.monthlyTarget) * 100) : null,
        targetProgress,
        returnAdjustments,
        invoices: invoices.map(x => ({
          id: x.id, invoiceNumber: x.invoiceNumber, invoiceDate: x.invoiceDate,
          customerName: x.customerId != null ? (customerNames.get(x.customerId) ?? `#${x.customerId}`) : "—",
          totalAmount: Number(x.totalAmount ?? 0), commissionPct: Number(x.commissionPct ?? 0),
          commissionAmount: period.enabled && rep.commissionType === "invoice"
            ? (invoiceCommissionById.get(x.id) ?? 0) : Number(x.commissionAmount ?? 0),
        })),
        collections: collections.map(x => ({ id: x.id, date: x.date, amount: Number(x.amount ?? 0) })),
      };
      const periods = [...plan.periods];
      periods[ix] = {
        ...period, status: "approved", approvedAt: new Date().toISOString(),
        approvedBy: Number((req as any).authUser?.id ?? 0) || null,
        commissionPct: String(rep.commissionPct), snapshot: saved,
      };
      await tx.update(salesRepsTable).set({
        commissionPlan: { ...plan, periods } as SalesRepCommissionPlan,
        updatedAt: new Date(),
      }).where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
      return saved;
    });
    res.json({ ok: true, snapshot });
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// ─── AI COMMISSION ANALYSIS (international compensation standards) ───────────
// POST /api/sales-reps/:id/ai-commission?from=&to=&companyId=
router.post("/:id/ai-commission", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const from = req.query.from ? String(req.query.from) : null;
    const to   = req.query.to   ? String(req.query.to)   : null;

    const [rep] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!rep) { res.status(404).json({ error: "المندوب غير موجود" }); return; }

    const invConds = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.salesRepId, id),
      eq(salesInvoicesTable.status, "posted"),
    ];
    if (from) invConds.push(sql`${salesInvoicesTable.invoiceDate} >= ${from}`);
    if (to)   invConds.push(sql`${salesInvoicesTable.invoiceDate} <= ${to}`);
    const invs = await db.select({
      totalAmount:      salesInvoicesTable.totalAmount,
      commissionAmount: salesInvoicesTable.commissionAmount,
    }).from(salesInvoicesTable).where(and(...invConds));

    const colConds = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.salesRepId, id),
      eq(receiptVouchersTable.status, "posted"),
    ];
    if (from) colConds.push(sql`${receiptVouchersTable.date} >= ${from}`);
    if (to)   colConds.push(sql`${receiptVouchersTable.date} <= ${to}`);
    const cols = await db.select({ amount: receiptVouchersTable.amount })
      .from(receiptVouchersTable).where(and(...colConds));

    const totalSales      = invs.reduce((s, i) => s + Number(i.totalAmount ?? 0), 0);
    const totalCommission = invs.reduce((s, i) => s + Number(i.commissionAmount ?? 0), 0);
    const totalCollected  = cols.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const repPct = Number(rep.commissionPct ?? 0);
    const effective = rep.commissionType === "collection"
      ? totalCollected * (repPct / 100) : totalCommission;
    const target = Number(rep.monthlyTarget ?? 0);
    const collectionRate = totalSales > 0 ? Number(((totalCollected / totalSales) * 100).toFixed(1)) : null;
    const commToSalesRatio = totalSales > 0 ? Number(((effective / totalSales) * 100).toFixed(2)) : 0;

    const facts = {
      rep: {
        name: rep.nameAr, code: rep.code, region: rep.region,
        commissionPct: repPct, commissionType: rep.commissionType,
        monthlyTarget: target, isActive: rep.isActive,
      },
      window: { from, to },
      sales: {
        invoiceCount: invs.length,
        totalSales: Number(totalSales.toFixed(2)),
        avgInvoiceValue: invs.length ? Number((totalSales / invs.length).toFixed(2)) : 0,
        monthlyTarget: target,
        targetAchievedPct: target > 0 ? Math.round((totalSales / target) * 100) : null,
      },
      commission: {
        snapshotFromInvoices: Number(totalCommission.toFixed(2)),
        effective: Number(effective.toFixed(2)),
        commissionToSalesRatioPct: commToSalesRatio,
      },
      collections: {
        totalCollected: Number(totalCollected.toFixed(2)),
        collectionRatePct: collectionRate,
      },
    };

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيّأة على الخادم." });
      return;
    }

    const client = new Anthropic({
      apiKey:  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });

    const prompt = `أنت خبير تعويضات وعمولات مبيعات (Sales Compensation Consultant) معتمد على المعايير الدولية:
- WorldatWork Sales Compensation Principles
- Korn Ferry / Mercer / Radford benchmarks للأدوار البيعية
- مفاهيم OTE (On-Target Earnings)، Pay Mix، Quota Attainment، Accelerators، SPIF.

حلّل عمولة مندوب المبيعات التالي بناءً على البيانات الموضوعية فقط، ثم قارنها بالمعايير الدولية الشائعة، واكتب الردّ بالعربية الفصحى الواضحة وبتنسيق Markdown.

البيانات (JSON):
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

اكتب الردّ في الأقسام التالية فقط:
1. **ملخص العمولة** — العمولة الفعلية بالريال السعودي (ر.س)، نوع العمولة، نسبة العمولة إلى المبيعات (Comm/Sales %)، ونسبة تحقيق الهدف (Quota Attainment).
2. **مقارنة بالمعايير الدولية** — قارن نسبة العمولة، Pay Mix المتوقع (Base/Variable)، ومستوى تحقيق الهدف بأرقام معيارية شائعة في WorldatWork/Radford لقطاع المبيعات B2B (اذكر أنها مرجعية تقريبية وليست أرقام شركة بعينها).
3. **مؤشرات المخاطر** — مثل: ضعف معدل التحصيل، اعتماد كبير على عميل واحد (إن أمكن استنتاجه)، تحقيق هدف منخفض (<60%) أو مرتفع جداً (>120% قد يدل على هدف غير معاير).
4. **توصيات لهيكل العمولة** — 3-5 توصيات عملية: مثل إدخال Accelerators فوق 100% من الهدف، تحويل لنموذج Collection-Based عند ضعف التحصيل، مراجعة Pay Mix، أو إضافة SPIF لمنتجات معينة.

قواعد:
- لا تخترع أرقاماً غير موجودة في البيانات.
- استخدم القيم بالريال السعودي (ر.س).
- إذا كانت البيانات شحيحة (صفر فواتير) صرّح بذلك واقترح خطوات أولى.`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const block = message.content[0];
    const analysis = block && block.type === "text" ? block.text : "";

    res.json({ analysis, facts });
  } catch (e: any) {
    console.error("[sales-reps ai-commission]", e);
    res.status(500).json({ error: e?.message ?? "فشل تحليل العمولة" });
  }
});

// ─── AI PERFORMANCE ANALYSIS ─────────────────────────────────────────────────
// POST /api/sales-reps/:id/ai-analysis?companyId=X
// Aggregates last-90-days facts about the rep and asks Claude for an Arabic
// performance review with concrete recommendations. Returns markdown text.
router.post("/:id/ai-analysis", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [rep] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!rep) { res.status(404).json({ error: "المندوب غير موجود" }); return; }

    // Window: last 90 days (date strings YYYY-MM-DD).
    const today = new Date();
    const since = new Date(today.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
    const monthStart = `${today.toISOString().slice(0, 7)}-01`;

    // Posted invoices for this rep in the window.
    const invs = await db.select({
      id:               salesInvoicesTable.id,
      invoiceDate:      salesInvoicesTable.invoiceDate,
      customerId:       salesInvoicesTable.customerId,
      totalAmount:      salesInvoicesTable.totalAmount,
      commissionAmount: salesInvoicesTable.commissionAmount,
      status:           salesInvoicesTable.status,
    })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.salesRepId, id),
        eq(salesInvoicesTable.status, "posted"),
        sql`${salesInvoicesTable.invoiceDate} >= ${since}`,
      ));

    let totalSales = 0, totalCommission = 0, mtdSales = 0;
    const byCustomer = new Map<number, number>();
    for (const inv of invs) {
      const t = Number(inv.totalAmount ?? 0);
      totalSales += t;
      totalCommission += Number(inv.commissionAmount ?? 0);
      if (inv.invoiceDate >= monthStart) mtdSales += t;
      if (inv.customerId != null) {
        byCustomer.set(inv.customerId, (byCustomer.get(inv.customerId) ?? 0) + t);
      }
    }

    // Top 5 customers by sales value.
    const topCustIds = [...byCustomer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cidc]) => cidc);
    const custRows = topCustIds.length
      ? await db.select({ id: customersTable.id, nameAr: customersTable.nameAr })
          .from(customersTable)
          .where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, topCustIds)))
      : [];
    const topCustomers = topCustIds.map(cidc => ({
      name:  custRows.find(c => c.id === cidc)?.nameAr ?? `#${cidc}`,
      total: byCustomer.get(cidc) ?? 0,
    }));

    // Linked customers count (book size).
    const [{ n: bookSize }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(and(eq(customersTable.companyId, cid), eq(customersTable.salesRepId, id)));

    // Recent visits (last 30 days, up to 30 entries).
    const since30 = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
    const visits = await db.select()
      .from(salesRepVisitsTable)
      .where(and(
        eq(salesRepVisitsTable.companyId, cid),
        eq(salesRepVisitsTable.salesRepId, id),
        sql`${salesRepVisitsTable.visitDate} >= ${since30}`,
      ))
      .orderBy(desc(salesRepVisitsTable.visitDate))
      .limit(30);
    const visitsByOutcome = visits.reduce((acc, v) => {
      acc[v.outcome] = (acc[v.outcome] ?? 0) + 1; return acc;
    }, {} as Record<string, number>);

    const target = Number(rep.monthlyTarget ?? 0);
    const targetPct = target > 0 ? Math.round((mtdSales / target) * 100) : null;

    const facts = {
      rep: {
        name:           rep.nameAr,
        code:           rep.code,
        region:         rep.region,
        commissionPct:  Number(rep.commissionPct),
        commissionType: rep.commissionType,
        monthlyTarget:  target,
        isActive:       rep.isActive,
      },
      window: { since, today: today.toISOString().slice(0, 10), monthStart },
      sales: {
        invoiceCount90d:     invs.length,
        totalSales90d:       Number(totalSales.toFixed(2)),
        totalCommission90d:  Number(totalCommission.toFixed(2)),
        monthToDateSales:    Number(mtdSales.toFixed(2)),
        monthlyTarget:       target,
        targetAchievedPct:   targetPct,
        avgInvoiceValue:     invs.length ? Number((totalSales / invs.length).toFixed(2)) : 0,
      },
      bookSize,
      topCustomers,
      visits30d: {
        total:     visits.length,
        byOutcome: visitsByOutcome,
      },
    };

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيّأة على الخادم." });
      return;
    }

    const client = new Anthropic({
      apiKey:  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });

    const prompt = `أنت محلل مبيعات خبير في شركة سعودية تستخدم نظام محاسبة عربي.
حلّل أداء مندوب المبيعات التالي بناءً على البيانات الموضوعية فقط، واكتب الردّ بالعربية الفصحى الواضحة وبتنسيق Markdown.

البيانات (JSON):
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

اكتب الردّ في الأقسام التالية فقط:
1. **ملخص الأداء** — فقرة قصيرة (سطرين-ثلاثة) تذكر المبيعات والعمولة وتحقيق الهدف.
2. **نقاط القوة** — قائمة 2-4 نقاط مرتكزة على البيانات.
3. **نقاط للتحسين** — قائمة 2-4 نقاط محددة (مثلاً اعتماد على عميل واحد، نقص زيارات، تحقيق هدف منخفض).
4. **توصيات عملية** — قائمة 3-5 إجراءات قابلة للتنفيذ خلال 30 يوماً.

قواعد:
- لا تخترع أرقاماً غير موجودة في البيانات.
- إذا كانت البيانات شحيحة (صفر فواتير أو صفر زيارات) صرّح بذلك واقترح خطوات لجمع بيانات.
- استخدم القيم بالريال السعودي (ر.س).`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const block = message.content[0];
    const analysis = block && block.type === "text" ? block.text : "";

    res.json({ analysis, facts });
  } catch (e: any) {
    console.error("[sales-reps ai-analysis]", e);
    res.status(500).json({ error: e?.message ?? "فشل تحليل الأداء" });
  }
});

export default router;
