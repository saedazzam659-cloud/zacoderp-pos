import { Router } from "express";
import { db } from "@workspace/db";
import { cashBoxesTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

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

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!d.nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  if (!d.code)   { res.status(400).json({ error: "الكود مطلوب" }); return; }

  // Uniqueness checks scoped to the company
  const existing = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid));
  if (existing.some(b => b.code?.trim().toLowerCase() === String(d.code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${d.code}" مستخدم بالفعل لخزنة أخرى` });
    return;
  }
  if (d.accountId && existing.some(b => b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بخزنة أخرى — اختر حساباً آخر" });
    return;
  }

  const [row] = await db.insert(cashBoxesTable).values({
    companyId:  cid,
    branchId:   d.branchId   ? parseInt(d.branchId)   : null,
    code:       d.code,
    nameAr:     d.nameAr,
    nameEn:     d.nameEn     ?? null,
    currencyId: d.currencyId ? parseInt(d.currencyId) : null,
    accountId:  d.accountId  ? parseInt(d.accountId)  : null,
    minBalance: d.minBalance ?? "0",
    maxBalance: d.maxBalance ?? null,
    isActive:   d.isActive   ?? true,
    notes:      d.notes      ?? null,
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
    branchId:   d.branchId   ? parseInt(d.branchId)   : null,
    code:       d.code,
    nameAr:     d.nameAr,
    nameEn:     d.nameEn     ?? null,
    currencyId: d.currencyId ? parseInt(d.currencyId) : null,
    accountId:  d.accountId  ? parseInt(d.accountId)  : null,
    minBalance: d.minBalance ?? "0",
    maxBalance: d.maxBalance ?? null,
    isActive:   d.isActive   ?? true,
    notes:      d.notes      ?? null,
  }).where(eq(cashBoxesTable.id, parseInt(req.params.id))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  await db.delete(cashBoxesTable).where(eq(cashBoxesTable.id, parseInt(req.params.id)));
  res.status(204).send();
});

export default router;
