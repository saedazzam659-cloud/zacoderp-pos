import { Router } from "express";
import { db } from "@workspace/db";
import { bankAccountsTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const rows = cid
    ? await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid))
    : await db.select().from(bankAccountsTable);
  res.json(rows);
});

router.get("/balances", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const banks = await db.select({ id: bankAccountsTable.id })
    .from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid));

  const [recv, paid] = await Promise.all([
    db.select({
      bankAccountId: receiptVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}),0)`,
    }).from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.status, "posted")))
      .groupBy(receiptVouchersTable.bankAccountId),

    db.select({
      bankAccountId: paymentVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}),0)`,
    }).from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.status, "posted")))
      .groupBy(paymentVouchersTable.bankAccountId),
  ]);

  const recvMap = Object.fromEntries(recv.map(r => [r.bankAccountId!, parseFloat(r.total)]));
  const paidMap = Object.fromEntries(paid.map(r => [r.bankAccountId!, parseFloat(r.total)]));

  res.json(banks.map(b => ({
    bankAccountId: b.id,
    balance: (recvMap[b.id] ?? 0) - (paidMap[b.id] ?? 0),
  })));
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// helpers — turn "" / undefined into null so optional fields don't crash pg
const toInt = (v: any) => (v === "" || v === null || v === undefined ? null : parseInt(v));
const toStr = (v: any) => (v === "" || v === null || v === undefined ? null : String(v).trim() || null);

async function nextBankAccountCode(cid: number): Promise<string> {
  const rows = await db.select({ code: bankAccountsTable.code })
    .from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^BA-(\d+)$/i.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `BA-${String(max + 1).padStart(4, "0")}`;
}

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid)   { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!d.nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }

  const existing = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid));
  const code = (d.code && String(d.code).trim()) ? String(d.code).trim() : await nextBankAccountCode(cid);
  if (existing.some(b => b.code?.trim().toLowerCase() === code.toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لحساب بنكي آخر` });
    return;
  }
  if (d.iban && existing.some(b => b.iban?.trim() === String(d.iban).trim())) {
    res.status(409).json({ error: "رقم IBAN مستخدم لحساب آخر" });
    return;
  }
  if (d.accountId && existing.some(b => b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بحساب بنكي آخر — اختر حساباً آخر" });
    return;
  }

  const [row] = await db.insert(bankAccountsTable).values({
    companyId:     cid,
    branchId:      toInt(d.branchId),
    code,
    nameAr:        String(d.nameAr).trim(),
    nameEn:        toStr(d.nameEn),
    bankName:      toStr(d.bankName),
    bankNameEn:    toStr(d.bankNameEn),
    accountNumber: toStr(d.accountNumber),
    iban:          toStr(d.iban),
    swiftCode:     toStr(d.swiftCode),
    currencyId:    toInt(d.currencyId),
    accountId:     toInt(d.accountId),
    isActive:      d.isActive ?? true,
    notes:         toStr(d.notes),
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [current] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, id));
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }

  const others = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, current.companyId));
  if (d.code && others.some(b => b.id !== id && b.code?.trim().toLowerCase() === String(d.code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${d.code}" مستخدم بالفعل لحساب بنكي آخر` });
    return;
  }
  if (d.iban && others.some(b => b.id !== id && b.iban?.trim() === String(d.iban).trim())) {
    res.status(409).json({ error: "رقم IBAN مستخدم لحساب آخر" });
    return;
  }
  if (d.accountId && others.some(b => b.id !== id && b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بحساب بنكي آخر — اختر حساباً آخر" });
    return;
  }

  const [row] = await db.update(bankAccountsTable).set({
    branchId:      toInt(d.branchId),
    code:          (d.code && String(d.code).trim()) ? String(d.code).trim() : current.code,
    nameAr:        String(d.nameAr ?? current.nameAr).trim(),
    nameEn:        toStr(d.nameEn),
    bankName:      toStr(d.bankName),
    bankNameEn:    toStr(d.bankNameEn),
    accountNumber: toStr(d.accountNumber),
    iban:          toStr(d.iban),
    swiftCode:     toStr(d.swiftCode),
    currencyId:    toInt(d.currencyId),
    accountId:     toInt(d.accountId),
    isActive:      d.isActive ?? true,
    notes:         toStr(d.notes),
  }).where(eq(bankAccountsTable.id, parseInt(req.params.id))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [{ recv }] = await db.select({
    recv: sql<number>`count(*)::int`,
  }).from(receiptVouchersTable).where(eq(receiptVouchersTable.bankAccountId, id));
  const [{ paid }] = await db.select({
    paid: sql<number>`count(*)::int`,
  }).from(paymentVouchersTable).where(eq(paymentVouchersTable.bankAccountId, id));
  if ((recv ?? 0) + (paid ?? 0) > 0) {
    res.status(409).json({
      error: `لا يمكن حذف الحساب البنكي لوجود ${recv} سند قبض و ${paid} سند صرف مرتبطة به — احذف السندات أو انقلها إلى حساب آخر أولاً.`,
    });
    return;
  }
  try {
    const result = await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, id)).returning({ id: bankAccountsTable.id });
    if (result.length === 0) { res.status(404).json({ error: "الحساب البنكي غير موجود" }); return; }
    res.status(204).send();
  } catch (e: any) {
    res.status(409).json({ error: "لا يمكن حذف الحساب البنكي لارتباطه بسجلات أخرى في النظام" });
  }
});

export default router;
