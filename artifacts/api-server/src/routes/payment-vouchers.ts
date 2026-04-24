import { Router } from "express";
import { db } from "@workspace/db";
import {
  paymentVouchersTable,
  cashBoxesTable, bankAccountsTable,
  customersTable, suppliersTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("payment_vouchers"));
router.use(moduleAudit("payment_vouchers"));

// Build & insert a balanced journal entry for a payment voucher
async function buildPaymentJournal(cid: number, v: any): Promise<number> {
  const amount = parseFloat(v.amount || "0");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");

  // CR side: cash/bank account that paid the money
  let crAccountId: number | null = null;
  let crLabel = "";
  if (v.paymentType === "bank" && v.bankAccountId) {
    const [b] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, v.bankAccountId));
    crAccountId = b?.accountId ?? null;
    crLabel = `بنك ${b?.nameAr ?? ""}`.trim();
  } else if (v.cashBoxId) {
    const [c] = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.id, v.cashBoxId));
    crAccountId = c?.accountId ?? null;
    crLabel = `صندوق ${c?.nameAr ?? ""}`.trim();
  }
  if (!crAccountId) throw new Error("الصندوق/البنك لا يحتوي على حساب محاسبي مرتبط");

  // DR side: voucher.accountId override OR supplier/customer/employee account
  let drAccountId: number | null = v.accountId ?? null;
  let drLabel = "";
  if (!drAccountId) {
    if (v.entityType === "supplier" && v.entityId) {
      const [s] = await db.select().from(suppliersTable).where(and(eq(suppliersTable.id, v.entityId), eq(suppliersTable.companyId, cid)));
      drAccountId = s?.accountId ?? null;
      drLabel = `مورّد ${s?.nameAr ?? ""}`.trim();
    } else if (v.entityType === "customer" && v.entityId) {
      const [c] = await db.select().from(customersTable).where(and(eq(customersTable.id, v.entityId), eq(customersTable.companyId, cid)));
      drAccountId = c?.accountId ?? null;
      drLabel = `عميل ${c?.nameAr ?? ""}`.trim();
    }
  } else {
    drLabel = v.entityName || "حساب الطرف الآخر";
  }
  if (!drAccountId) throw new Error("لا يوجد حساب محاسبي للطرف الآخر — اختر حساباً أو اربط الطرف بحساب");

  const desc = `سند صرف ${v.code}${v.description ? " - " + v.description : ""}`;
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, branchId: v.branchId ?? null,
    docNumber: v.code, entryDate: v.date,
    currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
    description: desc, entryType: "payment", status: "posted",
  }).returning();
  await db.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: drAccountId, debit: amount.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0 },
    { entryId: entry.id, accountId: crAccountId, debit: "0.00", credit: amount.toFixed(2), description: crLabel || desc, sortOrder: 1 },
  ]);
  return entry.id;
}

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const rows = cid
    ? await db.select().from(paymentVouchersTable)
        .where(eq(paymentVouchersTable.companyId, cid))
        .orderBy(desc(paymentVouchersTable.createdAt))
    : await db.select().from(paymentVouchersTable).orderBy(desc(paymentVouchersTable.createdAt));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(paymentVouchersTable)
    .where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const existing = await db.select({ id: paymentVouchersTable.id })
    .from(paymentVouchersTable).where(eq(paymentVouchersTable.companyId, cid));
  const code = d.code || `PV-${String(existing.length + 1).padStart(4, "0")}`;

  const [row] = await db.insert(paymentVouchersTable).values({
    companyId:     cid,
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    paymentType:   d.paymentType   || "cash",
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    entityType:    d.entityType    || "supplier",
    entityId:      d.entityId      ? parseInt(d.entityId)      : null,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount        || "0",
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? null,
    refNumber:     d.refNumber     ?? null,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    status:        "draft",
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(paymentVouchersTable).where(eq(paymentVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل سند مرحّل" }); return; }

  const [row] = await db.update(paymentVouchersTable).set({
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    date:          d.date,
    paymentType:   d.paymentType,
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    entityType:    d.entityType,
    entityId:      d.entityId      ? parseInt(d.entityId)      : null,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? null,
    refNumber:     d.refNumber     ?? null,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
  }).where(eq(paymentVouchersTable.id, id)).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(paymentVouchersTable).where(eq(paymentVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  try {
    const journalId = await buildPaymentJournal(existing.companyId, existing);
    const [row] = await db.update(paymentVouchersTable)
      .set({ status: "posted", journalEntryId: journalId })
      .where(eq(paymentVouchersTable.id, id)).returning();
    res.json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "تعذّر إنشاء القيد المحاسبي" });
  }
});

router.post("/:id/unpost", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(paymentVouchersTable).where(eq(paymentVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status !== "posted") { res.status(400).json({ error: "السند ليس مرحّلاً" }); return; }
  if (existing.journalEntryId) {
    await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, existing.journalEntryId));
  }
  const [row] = await db.update(paymentVouchersTable)
    .set({ status: "draft", journalEntryId: null })
    .where(eq(paymentVouchersTable.id, id)).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  if (existing?.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مرحّل" }); return; }
  await db.delete(paymentVouchersTable).where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  res.status(204).send();
});

export default router;
