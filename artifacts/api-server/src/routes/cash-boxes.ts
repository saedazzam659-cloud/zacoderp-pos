import { Router } from "express";
import { db } from "@workspace/db";
import { cashBoxesTable, receiptVouchersTable, paymentVouchersTable, cashTransfersTable, usersTable } from "@workspace/db";
import { eq, and, sql, or, isNull, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, getAllowedBranchIds, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureCashBoxAccount } from "../lib/entityAccounts.js";
import { canUserUseCashBox } from "../lib/cashBoxAccess.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("cash_boxes"));
router.use(moduleAudit("cash_boxes"));

/**
 * Branch-scope filter for cash boxes / bank accounts (nullable branchId tables).
 * - admin / superadmin / viewAllBranches=true → no restriction (returns undefined)
 * - restricted user with allowed branches → rows whose branchId IS NULL (shared / HQ)
 *   OR branchId IN allowed
 * - restricted user with zero linked branches → no rows (sql`false`)
 */
function branchOrNullScope(req: any, branchCol: any): any {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return or(isNull(branchCol), inArray(branchCol, allowed));
}

function pickerBranchScope(req: any): any {
  if (req.query.onlyUserBranches !== "1" && req.query.onlyUserBranches !== "true") {
    return branchOrNullScope(req, cashBoxesTable.branchId);
  }
  const ids = req.authUser?.branchIds ?? [];
  return ids.length ? inArray(cashBoxesTable.branchId, ids) : sql`false`;
}

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const conds: any[] = [];
  if (cid) conds.push(eq(cashBoxesTable.companyId, cid));
  const pickerScope = req.query.onlyUserBranches === "1" || req.query.onlyUserBranches === "true";
  if (pickerScope) conds.push(pickerBranchScope(req));
  else conds.push(...multiBranchScopeSpread(req, cashBoxesTable.branchId, req.query.branchIds ?? req.query.branchId));
  const rows = conds.length
    ? await db.select().from(cashBoxesTable).where(and(...conds))
    : await db.select().from(cashBoxesTable);
  const visible = rows.filter(box => canUserUseCashBox(req.authUser, box));
  res.json(visible.map(box => req.authUser?.role === "admin" || req.authUser?.role === "superadmin"
    ? box
    : { ...box, accessUserIds: null }));
});

/* GET /cash-boxes/balances?companyId=X — رصيد كل خزنة (مفلترة بالفرع للمستخدم المقيد) */
router.get("/balances", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const branchCond = branchOrNullScope(req, cashBoxesTable.branchId);
  const visibleBoxes = (await db.select({
    id: cashBoxesTable.id,
    accessUserIds: cashBoxesTable.accessUserIds,
  }).from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.companyId, cid), branchCond ?? sql`true`)))
    .filter(box => canUserUseCashBox(req.authUser, box));

  const [recv, paid, transfersIn, transfersOut] = await Promise.all([
    db.select({
      cashBoxId: receiptVouchersTable.cashBoxId,
      total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}),0)`,
    }).from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.status, "posted")))
      .groupBy(receiptVouchersTable.cashBoxId),

    db.select({
      cashBoxId: paymentVouchersTable.cashBoxId,
      total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}),0)`,
    }).from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.status, "posted")))
      .groupBy(paymentVouchersTable.cashBoxId),

    db.select({
      cashBoxId: cashTransfersTable.toCashBoxId,
      total: sql<string>`coalesce(sum(${cashTransfersTable.amount}),0)`,
    }).from(cashTransfersTable)
      .where(and(eq(cashTransfersTable.companyId, cid), eq(cashTransfersTable.status, "posted")))
      .groupBy(cashTransfersTable.toCashBoxId),

    db.select({
      cashBoxId: cashTransfersTable.fromCashBoxId,
      total: sql<string>`coalesce(sum(${cashTransfersTable.amount}),0)`,
    }).from(cashTransfersTable)
      .where(and(eq(cashTransfersTable.companyId, cid), eq(cashTransfersTable.status, "posted")))
      .groupBy(cashTransfersTable.fromCashBoxId),
  ]);

  const recvMap = Object.fromEntries(recv.map(r => [r.cashBoxId!, parseFloat(r.total)]));
  const paidMap = Object.fromEntries(paid.map(r => [r.cashBoxId!, parseFloat(r.total)]));
  const transfersInMap = Object.fromEntries(transfersIn.filter(r => r.cashBoxId != null).map(r => [r.cashBoxId!, parseFloat(r.total)]));
  const transfersOutMap = Object.fromEntries(transfersOut.filter(r => r.cashBoxId != null).map(r => [r.cashBoxId!, parseFloat(r.total)]));

  res.json(visibleBoxes.map(b => ({
    cashBoxId: b.id,
    balance: (recvMap[b.id] ?? 0) - (paidMap[b.id] ?? 0) + (transfersInMap[b.id] ?? 0) - (transfersOutMap[b.id] ?? 0),
  })));
});

router.get("/:id", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const id  = parseInt(req.params.id);
  // Tenant isolation + branch isolation: never let any user fetch a cash box
  // outside their own company OR outside the branches they're allowed to see.
  const conds: any[] = [eq(cashBoxesTable.id, id)];
  if (cid) conds.push(eq(cashBoxesTable.companyId, cid));
  const branchCond = branchOrNullScope(req, cashBoxesTable.branchId);
  if (branchCond) conds.push(branchCond);
  const [row] = await db.select().from(cashBoxesTable).where(and(...conds));
  if (!row || !canUserUseCashBox(req.authUser, row)) { res.status(404).json({ error: "غير موجود" }); return; }
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") row.accessUserIds = null;
  res.json(row);
});

// helpers — turn "" / undefined into null, "" decimals into safe defaults
const toInt = (v: any) => (v === "" || v === null || v === undefined ? null : parseInt(v));
const toStr = (v: any) => (v === "" || v === null || v === undefined ? null : String(v));
const toDec = (v: any, def: string | null = null) =>
  v === "" || v === null || v === undefined || isNaN(Number(v)) ? def : String(v);

async function validateCashExpenseManager(value: unknown, companyId: number, req: any) {
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    return { ok: false as const, status: 403, error: "إسناد مسؤول مصروفات الخزنة متاح للمدير فقط" };
  }
  if (value === null || value === "") return { ok: true as const, value: null };
  const managerId = Number(value);
  if (!Number.isSafeInteger(managerId) || managerId <= 0) {
    return { ok: false as const, status: 400, error: "معرّف مسؤول مصروفات الخزنة غير صالح" };
  }
  const [manager] = await db.select({ id: usersTable.id }).from(usersTable).where(and(
    eq(usersTable.id, managerId),
    eq(usersTable.companyId, companyId),
    eq(usersTable.isActive, true),
  )).limit(1);
  if (!manager) return { ok: false as const, status: 400, error: "اختر مستخدماً نشطاً من الشركة نفسها" };
  return { ok: true as const, value: managerId };
}

async function validateCashBoxAccessUsers(value: unknown, companyId: number, req: any) {
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    return { ok: false as const, status: 403, error: "تقييد استخدام الخزنة متاح للمدير فقط" };
  }
  if (value == null) return { ok: true as const, value: null };
  if (!Array.isArray(value)) return { ok: false as const, status: 400, error: "قائمة مستخدمي الخزنة غير صالحة" };
  const ids = [...new Set(value.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return { ok: false as const, status: 400, error: "قائمة مستخدمي الخزنة غير صالحة" };
  }
  if (ids.length === 0) return { ok: true as const, value: [] as number[] };
  const activeUsers = await db.select({ id: usersTable.id }).from(usersTable).where(and(
    eq(usersTable.companyId, companyId),
    eq(usersTable.isActive, true),
    inArray(usersTable.id, ids),
  ));
  if (activeUsers.length !== ids.length) {
    return { ok: false as const, status: 400, error: "اختر مستخدمين نشطين من الشركة نفسها" };
  }
  return { ok: true as const, value: ids };
}

// Auto-generate next available code like CB-0001 (scoped to company).
async function nextCashBoxCode(cid: number): Promise<string> {
  const rows = await db.select({ code: cashBoxesTable.code })
    .from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^CB-(\d+)$/i.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `CB-${String(max + 1).padStart(4, "0")}`;
}

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!d.nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  let cashExpenseManagerUserId: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "cashExpenseManagerUserId")) {
    const manager = await validateCashExpenseManager(d.cashExpenseManagerUserId, cid, req);
    if (!manager.ok) { res.status(manager.status).json({ error: manager.error }); return; }
    cashExpenseManagerUserId = manager.value;
  }
  let accessUserIds: number[] | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "accessUserIds")) {
    const access = await validateCashBoxAccessUsers(d.accessUserIds, cid, req);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    accessUserIds = access.value;
  }

  // Uniqueness checks scoped to the company
  const existing = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid));
  const code = (d.code && String(d.code).trim()) ? String(d.code).trim() : await nextCashBoxCode(cid);
  if (existing.some(b => b.code?.trim().toLowerCase() === code.toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لخزنة أخرى` });
    return;
  }
  if (d.accountId && existing.some(b => b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بخزنة أخرى — اختر حساباً آخر" });
    return;
  }

  // Auto-create a sub-account under the cash parent (from the Account
  // Mapping screen) when the user didn't explicitly pick one.
  let accountId: number | null = toInt(d.accountId);
  if (!accountId) {
    try {
      accountId = await ensureCashBoxAccount(cid, String(d.nameAr).trim());
    } catch (err) {
      req.log?.warn({ err }, "ensureCashBoxAccount failed");
      accountId = null;
    }
  }

  const [row] = await db.insert(cashBoxesTable).values({
    companyId:  cid,
    branchId:   toInt(d.branchId),
    code,
    nameAr:     String(d.nameAr).trim(),
    nameEn:     toStr(d.nameEn),
    currencyId: toInt(d.currencyId),
    accountId,
    ...(cashExpenseManagerUserId !== undefined ? { cashExpenseManagerUserId } : {}),
    ...(accessUserIds !== undefined ? { accessUserIds } : {}),
    minBalance: toDec(d.minBalance, "0")!,
    maxBalance: toDec(d.maxBalance, null),
    isActive:   d.isActive ?? true,
    notes:      toStr(d.notes),
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [current] = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.id, id));
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }

  const others = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, current.companyId));
  if (d.code && others.some(b => b.id !== id && b.code?.trim().toLowerCase() === String(d.code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${d.code}" مستخدم بالفعل لخزنة أخرى` });
    return;
  }
  if (d.accountId && others.some(b => b.id !== id && b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بخزنة أخرى — اختر حساباً آخر" });
    return;
  }
  let cashExpenseManagerUserId: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "cashExpenseManagerUserId")) {
    if (req.authUser?.role !== "superadmin" && Number(req.authUser?.companyId) !== current.companyId) {
      res.status(404).json({ error: "الخزنة غير موجودة" }); return;
    }
    const manager = await validateCashExpenseManager(d.cashExpenseManagerUserId, current.companyId, req);
    if (!manager.ok) { res.status(manager.status).json({ error: manager.error }); return; }
    cashExpenseManagerUserId = manager.value;
  }
  let accessUserIds: number[] | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "accessUserIds")) {
    if (req.authUser?.role !== "superadmin" && Number(req.authUser?.companyId) !== current.companyId) {
      res.status(404).json({ error: "الخزنة غير موجودة" }); return;
    }
    const access = await validateCashBoxAccessUsers(d.accessUserIds, current.companyId, req);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    accessUserIds = access.value;
  }

  const [row] = await db.update(cashBoxesTable).set({
    branchId:   toInt(d.branchId),
    code:       (d.code && String(d.code).trim()) ? String(d.code).trim() : current.code,
    nameAr:     String(d.nameAr ?? current.nameAr).trim(),
    nameEn:     toStr(d.nameEn),
    currencyId: toInt(d.currencyId),
    accountId:  toInt(d.accountId),
    ...(cashExpenseManagerUserId !== undefined ? { cashExpenseManagerUserId } : {}),
    ...(accessUserIds !== undefined ? { accessUserIds } : {}),
    minBalance: toDec(d.minBalance, "0")!,
    maxBalance: toDec(d.maxBalance, null),
    isActive:   d.isActive ?? true,
    notes:      toStr(d.notes),
  }).where(eq(cashBoxesTable.id, parseInt(req.params.id))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  // Block delete when the cashbox is referenced by vouchers
  const [{ recv }] = await db.select({
    recv: sql<number>`count(*)::int`,
  }).from(receiptVouchersTable).where(eq(receiptVouchersTable.cashBoxId, id));
  const [{ paid }] = await db.select({
    paid: sql<number>`count(*)::int`,
  }).from(paymentVouchersTable).where(eq(paymentVouchersTable.cashBoxId, id));
  if ((recv ?? 0) + (paid ?? 0) > 0) {
    res.status(409).json({
      error: `لا يمكن حذف الخزنة لوجود ${recv} سند قبض و ${paid} سند صرف مرتبطة بها — احذف السندات أو انقلها إلى خزنة أخرى أولاً.`,
    });
    return;
  }
  try {
    const result = await db.delete(cashBoxesTable).where(eq(cashBoxesTable.id, id)).returning({ id: cashBoxesTable.id });
    if (result.length === 0) { res.status(404).json({ error: "الخزنة غير موجودة" }); return; }
    res.status(204).send();
  } catch (e: any) {
    res.status(409).json({ error: "لا يمكن حذف الخزنة لارتباطها بسجلات أخرى في النظام" });
  }
});

export default router;
