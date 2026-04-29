import { Router } from "express";
import { db } from "@workspace/db";
import { cashBoxesTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureCashBoxAccount } from "../lib/entityAccounts.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("cash_boxes"));
router.use(moduleAudit("cash_boxes"));

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const rows = cid
    ? await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid))
    : await db.select().from(cashBoxesTable);
  res.json(rows);
});

/* GET /cash-boxes/balances?companyId=X — رصيد كل خزنة */
router.get("/balances", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const boxes = await db.select({ id: cashBoxesTable.id })
    .from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid));

  const [recv, paid] = await Promise.all([
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
  ]);

  const recvMap = Object.fromEntries(recv.map(r => [r.cashBoxId!, parseFloat(r.total)]));
  const paidMap = Object.fromEntries(paid.map(r => [r.cashBoxId!, parseFloat(r.total)]));

  res.json(boxes.map(b => ({
    cashBoxId: b.id,
    balance: (recvMap[b.id] ?? 0) - (paidMap[b.id] ?? 0),
  })));
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// helpers — turn "" / undefined into null, "" decimals into safe defaults
const toInt = (v: any) => (v === "" || v === null || v === undefined ? null : parseInt(v));
const toStr = (v: any) => (v === "" || v === null || v === undefined ? null : String(v));
const toDec = (v: any, def: string | null = null) =>
  v === "" || v === null || v === undefined || isNaN(Number(v)) ? def : String(v);

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

  const [row] = await db.update(cashBoxesTable).set({
    branchId:   toInt(d.branchId),
    code:       (d.code && String(d.code).trim()) ? String(d.code).trim() : current.code,
    nameAr:     String(d.nameAr ?? current.nameAr).trim(),
    nameEn:     toStr(d.nameEn),
    currencyId: toInt(d.currencyId),
    accountId:  toInt(d.accountId),
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
