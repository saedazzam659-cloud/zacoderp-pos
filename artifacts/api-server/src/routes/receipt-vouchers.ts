import { Router } from "express";
import { db } from "@workspace/db";
import {
  receiptVouchersTable,
  cashBoxesTable, bankAccountsTable,
  customersTable, suppliersTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("receipt_vouchers"));
router.use(moduleAudit("receipt_vouchers"));

// Build & insert a balanced journal entry for a receipt voucher
async function buildReceiptJournal(cid: number, v: any): Promise<number> {
  const amount = parseFloat(v.amount || "0");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");

  // DR side: cash/bank account that received the money
  let drAccountId: number | null = null;
  let drLabel = "";
  if (v.paymentType === "bank" && v.bankAccountId) {
    const [b] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, v.bankAccountId));
    drAccountId = b?.accountId ?? null;
    drLabel = `بنك ${b?.nameAr ?? ""}`.trim();
  } else if (v.cashBoxId) {
    const [c] = await db.select().from(cashBoxesTable).where(eq(cashBoxesTable.id, v.cashBoxId));
    drAccountId = c?.accountId ?? null;
    drLabel = `صندوق ${c?.nameAr ?? ""}`.trim();
  }
  if (!drAccountId) throw new Error("الصندوق/البنك لا يحتوي على حساب محاسبي مرتبط");

  // CR side: voucher.accountId override OR customer/supplier/employee account
  let crAccountId: number | null = v.accountId ?? null;
  let crLabel = "";
  if (!crAccountId) {
    if (v.entityType === "customer" && v.entityId) {
      const [c] = await db.select().from(customersTable).where(and(eq(customersTable.id, v.entityId), eq(customersTable.companyId, cid)));
      crAccountId = c?.accountId ?? null;
      crLabel = `عميل ${c?.nameAr ?? ""}`.trim();
    } else if (v.entityType === "supplier" && v.entityId) {
      const [s] = await db.select().from(suppliersTable).where(and(eq(suppliersTable.id, v.entityId), eq(suppliersTable.companyId, cid)));
      crAccountId = s?.accountId ?? null;
      crLabel = `مورّد ${s?.nameAr ?? ""}`.trim();
    }
  } else {
    crLabel = v.entityName || "حساب الطرف الآخر";
  }
  if (!crAccountId) throw new Error("لا يوجد حساب محاسبي للطرف الآخر — اختر حساباً أو اربط الطرف بحساب");

  const desc = `سند قبض ${v.code}${v.description ? " - " + v.description : ""}`;
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, branchId: v.branchId ?? null,
    docNumber: v.code, entryDate: v.date,
    currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
    description: desc, entryType: "receipt", status: "posted",
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
    ? await db.select().from(receiptVouchersTable)
        .where(eq(receiptVouchersTable.companyId, cid))
        .orderBy(desc(receiptVouchersTable.createdAt))
    : await db.select().from(receiptVouchersTable).orderBy(desc(receiptVouchersTable.createdAt));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(receiptVouchersTable)
    .where(eq(receiptVouchersTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  // Auto code — prefer the configured "receipt_voucher" sequence when no
  // explicit code was supplied. If no sequence is configured for this tenant
  // the helper returns null and we fall back to the legacy RV-#### scheme so
  // existing companies keep working with no setup required.
  let code: string;
  if (d.code) {
    code = String(d.code);
  } else {
    const seq = await nextSequenceNumber(cid, "receipt_voucher", {
      branchId: d.branchId ? parseInt(d.branchId) : null,
      userId:   (req as any).authUser?.id ?? null,
      refTable: "receipt_vouchers",
    });
    if (seq) {
      code = seq.number;
    } else {
      const existing = await db.select({ id: receiptVouchersTable.id })
        .from(receiptVouchersTable).where(eq(receiptVouchersTable.companyId, cid));
      code = `RV-${String(existing.length + 1).padStart(4, "0")}`;
    }
  }

  const [row] = await db.insert(receiptVouchersTable).values({
    companyId:     cid,
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    paymentType:   d.paymentType   || "cash",
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    entityType:    d.entityType    || "customer",
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
    // Manual session (admin-created) the user is currently working under,
    // resolved by extractAuth from the trusted x-session-id header.
    sessionId:     (req as any).manualSessionId ?? null,
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(receiptVouchersTable).where(eq(receiptVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل سند مرحّل" }); return; }

  const [row] = await db.update(receiptVouchersTable).set({
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
  }).where(eq(receiptVouchersTable.id, id)).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(receiptVouchersTable).where(eq(receiptVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  try {
    const journalId = await buildReceiptJournal(existing.companyId, existing);
    const [row] = await db.update(receiptVouchersTable)
      .set({ status: "posted", journalEntryId: journalId })
      .where(eq(receiptVouchersTable.id, id)).returning();
    res.json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "تعذّر إنشاء القيد المحاسبي" });
  }
});

router.post("/:id/unpost", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id as string);
  // Multi-tenant guard — admins from one tenant must not unpost another
  // tenant's voucher even if they happen to know the ID.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(receiptVouchersTable)
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status !== "posted") { res.status(400).json({ error: "السند ليس مرحّلاً" }); return; }
  if (existing.journalEntryId) {
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, existing.journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
  const [row] = await db.update(receiptVouchersTable)
    .set({ status: "draft", journalEntryId: null })
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid))).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const [existing] = await db.select().from(receiptVouchersTable)
    .where(eq(receiptVouchersTable.id, parseInt(req.params.id)));
  if (existing?.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مرحّل" }); return; }
  await db.delete(receiptVouchersTable).where(eq(receiptVouchersTable.id, parseInt(req.params.id)));
  res.status(204).send();
});

export default router;
