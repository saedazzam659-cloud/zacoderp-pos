import { Router } from "express";
import { db } from "@workspace/db";
import {
  paymentVouchersTable,
  cashBoxesTable, bankAccountsTable,
  suppliersTable,
  purchaseInvoicesTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { assertWritableForDate } from "../lib/periodGuard.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("payment_vouchers"));
router.use(moduleAudit("payment_vouchers"));

// Build & insert a balanced journal entry for a payment voucher.
//
// JE pattern (per UX spec):
//   Dr  Supplier (payable)         amount
//       Cr  Cash / Bank account                 amount
//
// Account resolution priority:
//   • Supplier (DR) side: supplier.accountId, falling back to
//     `supplier_settlement.payable` mapping.
//   • Cash/Bank (CR) side: the picked cashbox/bank's `accountId`,
//     falling back to `supplier_settlement.cash` /
//     `supplier_settlement.bank` mapping.
//
// The legacy per-voucher `accountId` override is no longer exposed in
// the UI; it remains in the table as a still-honored escape hatch for
// older rows so existing data continues to post correctly.
async function buildPaymentJournal(cid: number, v: any): Promise<number> {
  const amount = parseFloat(v.amount || "0");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");

  const lookup = await loadMappings(cid, "supplier_settlement");

  // ─── CR side: cash/bank account that paid the money ─────────────
  let crAccountId: number | null = null;
  let crLabel = "";
  if (v.paymentType === "bank" && v.bankAccountId) {
    // Tenant-scoped lookup: never resolve a bank account that belongs
    // to another company even if the caller knows the ID.
    const [b] = await db.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.id, v.bankAccountId), eq(bankAccountsTable.companyId, cid)));
    if (!b) throw new Error("الحساب البنكي غير موجود في هذه الشركة");
    crAccountId = pickAccount(b.accountId ?? null, lookup("supplier_settlement", "bank"));
    crLabel = `بنك ${b.nameAr ?? ""}`.trim();
  } else if (v.cashBoxId) {
    const [c] = await db.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, v.cashBoxId), eq(cashBoxesTable.companyId, cid)));
    if (!c) throw new Error("الخزنة غير موجودة في هذه الشركة");
    crAccountId = pickAccount(c.accountId ?? null, lookup("supplier_settlement", "cash"));
    crLabel = `صندوق ${c.nameAr ?? ""}`.trim();
  }
  if (!crAccountId) {
    throw new Error("لا يوجد حساب محاسبي للخزنة/البنك — اربط الخزنة بحساب أو حدّد الحساب الافتراضي في «ربط القيود المحاسبية ← تسوية الموردين»");
  }

  // ─── DR side: supplier payable account ──────────────────────────
  // The form is now supplier-only; legacy rows that had customer/other
  // entityType still load (read-only) but cannot be posted from this UI.
  let drAccountId: number | null = v.accountId ?? null;   // legacy override
  let drLabel = "";
  if (!drAccountId) {
    if (v.entityId) {
      const [s] = await db.select().from(suppliersTable)
        .where(and(eq(suppliersTable.id, v.entityId), eq(suppliersTable.companyId, cid)));
      drAccountId = pickAccount(s?.accountId ?? null, lookup("supplier_settlement", "payable"));
      drLabel = `مورّد ${s?.nameAr ?? ""}`.trim();
    } else {
      drAccountId = lookup("supplier_settlement", "payable");
    }
  } else {
    drLabel = v.entityName || "حساب الطرف الآخر";
  }
  if (!drAccountId) {
    throw new Error("لا يوجد حساب محاسبي للمورد — اربط المورد بحساب أو حدّد الحساب الافتراضي في «ربط القيود المحاسبية ← تسوية الموردين»");
  }

  const desc = `سند صرف ${v.code}${v.description ? " - " + v.description : ""}`;
  // Period guard: prevent payment posting into a closed fiscal period.
  const writability = await assertWritableForDate(cid, v.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, branchId: v.branchId ?? null,
    docNumber: v.code, entryDate: v.date,
    currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
    description: desc, entryType: "payment", status: "posted",
    periodId: writability.period?.id ?? null,
  }).returning();
  // Header-level cost center propagates to BOTH JE lines so cost-center
  // reports pick up the payment activity.
  const cc = v.costCenter ? String(v.costCenter).trim() || null : null;
  await db.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: drAccountId, debit: amount.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0, costCenter: cc },
    { entryId: entry.id, accountId: crAccountId, debit: "0.00", credit: amount.toFixed(2), description: crLabel || desc, sortOrder: 1, costCenter: cc },
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
  // Multi-tenant guard — without this, callers from one tenant could
  // read another tenant's voucher metadata by guessing IDs.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [row] = await db.select().from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.id, parseInt(req.params.id)),
      eq(paymentVouchersTable.companyId, cid),
    ));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// Validate that a purchaseInvoiceId — when provided — actually belongs to the
// same tenant AND to the supplier being settled. We tolerate the supplier
// not being supplied (legacy callers) but never allow cross-tenant linking.
async function validatePurchaseInvoiceLink(cid: number, purchaseInvoiceId: number, supplierId: number | null): Promise<void> {
  const [inv] = await db.select({
    id: purchaseInvoicesTable.id,
    companyId: purchaseInvoicesTable.companyId,
    supplierId: purchaseInvoicesTable.supplierId,
  }).from(purchaseInvoicesTable).where(eq(purchaseInvoicesTable.id, purchaseInvoiceId));
  if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
  if (inv.companyId !== cid) throw new Error("لا يمكن الربط بفاتورة من شركة أخرى");
  if (supplierId && inv.supplierId && inv.supplierId !== supplierId) {
    throw new Error("الفاتورة المرتبطة تخص مورّداً آخر");
  }
}

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const entityId = d.entityId ? parseInt(d.entityId) : null;
  const purchaseInvoiceId = d.purchaseInvoiceId ? parseInt(d.purchaseInvoiceId) : null;
  if (purchaseInvoiceId) {
    try { await validatePurchaseInvoiceLink(cid, purchaseInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }

  // Auto code — prefer the configured "payment_voucher" sequence when no
  // explicit code was supplied. Falls back to the legacy PV-#### scheme so
  // tenants without a configured sequence keep working untouched.
  let code: string;
  if (d.code) {
    code = String(d.code);
  } else {
    const seq = await nextSequenceNumber(cid, "payment_voucher", {
      branchId: d.branchId ? parseInt(d.branchId) : null,
      userId:   (req as any).authUser?.id ?? null,
      refTable: "payment_vouchers",
    });
    if (seq) {
      code = seq;
    } else {
      const existing = await db.select({ id: paymentVouchersTable.id })
        .from(paymentVouchersTable).where(eq(paymentVouchersTable.companyId, cid));
      code = `PV-${String(existing.length + 1).padStart(4, "0")}`;
    }
  }

  const [row] = await db.insert(paymentVouchersTable).values({
    companyId:     cid,
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    paymentType:   d.paymentType   || "cash",
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    // Payment vouchers are supplier-only by design; we still write the
    // column so legacy queries that filter by entityType keep working.
    entityType:    "supplier",
    entityId,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount        || "0",
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (purchaseInvoiceId ? "purchase_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    purchaseInvoiceId,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    costCenter:    d.costCenter ? String(d.costCenter).trim() || null : null,
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
  // Multi-tenant guard — fetch by (id, cid) so cross-tenant updates 404.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل سند مرحّل" }); return; }

  const entityId = d.entityId ? parseInt(d.entityId) : null;
  const purchaseInvoiceId = d.purchaseInvoiceId ? parseInt(d.purchaseInvoiceId) : null;
  if (purchaseInvoiceId) {
    try { await validatePurchaseInvoiceLink(existing.companyId, purchaseInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }

  const [row] = await db.update(paymentVouchersTable).set({
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    date:          d.date,
    paymentType:   d.paymentType,
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    // Re-affirm supplier-only on every PUT, even for legacy rows that
    // were originally created as customer/other.
    entityType:    "supplier",
    entityId,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (purchaseInvoiceId ? "purchase_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    purchaseInvoiceId,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    costCenter:    d.costCenter ? String(d.costCenter).trim() || null : null,
  }).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid))).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  // Multi-tenant guard — must own the voucher to post it.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  try {
    const journalId = await buildPaymentJournal(existing.companyId, existing);
    const [row] = await db.update(paymentVouchersTable)
      .set({ status: "posted", journalEntryId: journalId })
      .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) {
    res.status(e?.status ?? 400).json({ error: e?.message || "تعذّر إنشاء القيد المحاسبي" });
  }
});

router.post("/:id/unpost", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id as string);
  // Multi-tenant guard — admins from one tenant must not unpost another
  // tenant's voucher even if they happen to know the ID.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status !== "posted") { res.status(400).json({ error: "السند ليس مرحّلاً" }); return; }
  if (existing.journalEntryId) {
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, existing.journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
  const [row] = await db.update(paymentVouchersTable)
    .set({ status: "draft", journalEntryId: null })
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid))).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  // Multi-tenant guard — admins from another tenant must not delete
  // this tenant's voucher even if they happen to know the ID.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مرحّل" }); return; }
  await db.delete(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  res.status(204).send();
});

export default router;
