import { Router } from "express";
import { db } from "@workspace/db";
import {
  receiptVouchersTable,
  cashBoxesTable, bankAccountsTable,
  customersTable,
  salesInvoicesTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("receipt_vouchers"));
router.use(moduleAudit("receipt_vouchers"));

// Build & insert a balanced journal entry for a receipt voucher.
//
// JE pattern (per UX spec):
//   Dr  Cash / Bank account        amount
//       Cr  Customer (receivable)              amount
//
// Account resolution priority:
//   • Cash/Bank side: the picked cashbox/bank's `accountId`, falling back
//     to `customer_settlement.cash` / `customer_settlement.bank` mapping.
//   • Customer side:  customer.accountId, falling back to
//     `customer_settlement.receivable` mapping.
//
// The legacy per-voucher `accountId` override is no longer exposed in the
// UI; it remains in the table as a still-honored escape hatch for older
// rows so existing data continues to post correctly.
async function buildReceiptJournal(cid: number, v: any, req: any): Promise<number> {
  const amount = parseFloat(v.amount || "0");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");

  const lookup = await loadMappings(cid, "customer_settlement");

  // ─── DR side: cash/bank account that received the money ─────────
  let drAccountId: number | null = null;
  let drLabel = "";
  if (v.paymentType === "bank" && v.bankAccountId) {
    // Tenant-scoped lookup: never resolve a bank account that belongs
    // to another company even if the caller knows the ID.
    const [b] = await db.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.id, v.bankAccountId), eq(bankAccountsTable.companyId, cid)));
    if (!b) throw new Error("الحساب البنكي غير موجود في هذه الشركة");
    drAccountId = pickAccount(b.accountId ?? null, lookup("customer_settlement", "bank"));
    drLabel = `بنك ${b.nameAr ?? ""}`.trim();
  } else if (v.cashBoxId) {
    const [c] = await db.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, v.cashBoxId), eq(cashBoxesTable.companyId, cid)));
    if (!c) throw new Error("الخزنة غير موجودة في هذه الشركة");
    drAccountId = pickAccount(c.accountId ?? null, lookup("customer_settlement", "cash"));
    drLabel = `صندوق ${c.nameAr ?? ""}`.trim();
  }
  if (!drAccountId) {
    throw new Error("لا يوجد حساب محاسبي للخزنة/البنك — اربط الخزنة بحساب أو حدّد الحساب الافتراضي في «ربط القيود المحاسبية ← تسوية العملاء»");
  }

  // ─── CR side: customer receivable account ───────────────────────
  // The form is now customer-only; legacy rows that had supplier/other
  // entityType still load (read-only) but cannot be posted from this UI.
  let crAccountId: number | null = v.accountId ?? null;   // legacy override
  let crLabel = "";
  if (!crAccountId) {
    if (v.entityId) {
      const [c] = await db.select().from(customersTable)
        .where(and(eq(customersTable.id, v.entityId), eq(customersTable.companyId, cid)));
      crAccountId = pickAccount(c?.accountId ?? null, lookup("customer_settlement", "receivable"));
      crLabel = `عميل ${c?.nameAr ?? ""}`.trim();
    } else {
      crAccountId = lookup("customer_settlement", "receivable");
    }
  } else {
    crLabel = v.entityName || "حساب الطرف الآخر";
  }
  if (!crAccountId) {
    throw new Error("لا يوجد حساب محاسبي للعميل — اربط العميل بحساب أو حدّد الحساب الافتراضي في «ربط القيود المحاسبية ← تسوية العملاء»");
  }

  const desc = `سند قبض ${v.code}${v.description ? " - " + v.description : ""}`;
  // Period guard: prevent receipt posting into a closed fiscal period.
  const writability = await assertWritableForDate(cid, v.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  // Pre-resolve so audit posted_* fields are stamped only when the
  // tenant's auto-post setting actually puts the JE in "posted" status.
  const jeStatus = await resolvePostingStatus(cid, "receipt");
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, branchId: v.branchId ?? null,
    docNumber: v.code, entryDate: v.date,
    currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
    description: desc, entryType: "receipt",
    status: jeStatus,
    periodId: writability.period?.id ?? null,
    ...fullAuditFor(req, jeStatus),
  }).returning();
  // Header-level cost center propagates to BOTH JE lines so cost-center
  // reports pick up the receipt activity.
  const cc = v.costCenter ? String(v.costCenter).trim() || null : null;
  await db.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: drAccountId, debit: amount.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0, costCenter: cc },
    { entryId: entry.id, accountId: crAccountId, debit: "0.00", credit: amount.toFixed(2), description: crLabel || desc, sortOrder: 1, costCenter: cc },
  ]);
  return entry.id;
}

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  // Branch-Level Data Isolation: respect user scope and accept manager
  // multi-branch filter via ?branchIds=1,2,3 (or legacy ?branchId=).
  const branchScope = multiBranchScopeSpread(req, receiptVouchersTable.branchId, req.query.branchIds ?? req.query.branchId);
  const rows = cid
    ? await db.select().from(receiptVouchersTable)
        .where(and(eq(receiptVouchersTable.companyId, cid), ...branchScope))
        .orderBy(desc(receiptVouchersTable.createdAt))
    : await db.select().from(receiptVouchersTable)
        .where(branchScope.length ? and(...branchScope) : undefined)
        .orderBy(desc(receiptVouchersTable.createdAt));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  // Multi-tenant guard — without this, callers from one tenant could
  // read another tenant's voucher metadata by guessing IDs.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [row] = await db.select().from(receiptVouchersTable)
    .where(and(
      eq(receiptVouchersTable.id, parseInt(req.params.id)),
      eq(receiptVouchersTable.companyId, cid),
    ));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// Validate that a salesInvoiceId — when provided — actually belongs to the
// same tenant AND to the customer being settled. We tolerate the customer
// not being supplied (legacy callers) but never allow cross-tenant linking.
async function validateSalesInvoiceLink(cid: number, salesInvoiceId: number, customerId: number | null): Promise<void> {
  const [inv] = await db.select({
    id: salesInvoicesTable.id,
    companyId: salesInvoicesTable.companyId,
    customerId: salesInvoicesTable.customerId,
  }).from(salesInvoicesTable).where(eq(salesInvoicesTable.id, salesInvoiceId));
  if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
  if (inv.companyId !== cid) throw new Error("لا يمكن الربط بفاتورة من شركة أخرى");
  if (customerId && inv.customerId && inv.customerId !== customerId) {
    throw new Error("الفاتورة المرتبطة تخص عميلاً آخر");
  }
}

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const entityId = d.entityId ? parseInt(d.entityId) : null;
  const salesInvoiceId = d.salesInvoiceId ? parseInt(d.salesInvoiceId) : null;
  if (salesInvoiceId) {
    try { await validateSalesInvoiceLink(cid, salesInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }

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
      code = seq;
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
    // Receipt vouchers are customer-only by design; we still write the
    // column so legacy queries that filter by entityType keep working.
    entityType:    "customer",
    entityId,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount        || "0",
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (salesInvoiceId ? "sales_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    salesInvoiceId,
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
  const [existing] = await db.select().from(receiptVouchersTable)
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل سند مرحّل" }); return; }

  const entityId = d.entityId ? parseInt(d.entityId) : null;
  const salesInvoiceId = d.salesInvoiceId ? parseInt(d.salesInvoiceId) : null;
  if (salesInvoiceId) {
    try { await validateSalesInvoiceLink(existing.companyId, salesInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }

  const [row] = await db.update(receiptVouchersTable).set({
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    date:          d.date,
    paymentType:   d.paymentType,
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    // Re-affirm customer-only on every PUT, even for legacy rows that
    // were originally created as supplier/other.
    entityType:    "customer",
    entityId,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (salesInvoiceId ? "sales_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    salesInvoiceId,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    costCenter:    d.costCenter ? String(d.costCenter).trim() || null : null,
  }).where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid))).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  // Multi-tenant guard — must own the voucher to post it.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(receiptVouchersTable)
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  try {
    const journalId = await buildReceiptJournal(existing.companyId, existing, req);
    const [row] = await db.update(receiptVouchersTable)
      .set({ status: "posted", journalEntryId: journalId })
      .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid))).returning();
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
  const id = parseInt(req.params.id);
  // Multi-tenant guard — admins from another tenant must not delete
  // this tenant's voucher even if they happen to know the ID.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(receiptVouchersTable)
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مرحّل" }); return; }
  await db.delete(receiptVouchersTable)
    .where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid)));
  res.status(204).send();
});

export default router;
