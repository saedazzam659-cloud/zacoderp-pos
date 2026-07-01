import { Router } from "express";
import { db } from "@workspace/db";
import {
  paymentVouchersTable, paymentVoucherLinesTable,
  cashBoxesTable, bankAccountsTable,
  suppliersTable,
  purchaseInvoicesTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber, nextSequenceForPayment } from "../lib/sequences.js";
import { loadMappings, pickAccount, resolveVatInputAccountId } from "../lib/accountingMappings.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";

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
async function buildPaymentJournal(cid: number, v: any, req: any): Promise<number> {
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

  const desc = `سند صرف ${v.code}${v.description ? " - " + v.description : ""}`;
  const cc = v.costCenter ? String(v.costCenter).trim() || null : null;

  // Multi-allocation model: one treasury CR side + many DR allocation lines,
  // each optionally carrying its own input-VAT DR line. When no lines exist
  // (legacy single-`amount` voucher) we fall back to the classic two-line JE.
  const lines = await db.select().from(paymentVoucherLinesTable)
    .where(eq(paymentVoucherLinesTable.voucherId, v.id))
    .orderBy(asc(paymentVoucherLinesTable.sortOrder), asc(paymentVoucherLinesTable.id));

  const jeLines: {
    accountId: number; debit: string; credit: string;
    description: string; sortOrder: number; costCenter: string | null;
    supplierName?: string | null; supplierVatNumber?: string | null;
    supplierInvoiceNumber?: string | null; supplierInvoiceDate?: string | null;
  }[] = [];
  const acctIds = new Set<number>([crAccountId]);
  let total = 0;
  let so = 0;

  if (lines.length > 0) {
    // ─── DR side: per-line allocation (+ optional per-line input VAT) ──
    let vatInputId: number | null | undefined = undefined; // lazily resolved fallback
    for (const l of lines) {
      const lineAcct = l.accountId ?? null;
      if (!lineAcct) throw new Error("كل بند يجب أن يحتوي على حساب محاسبي");
      const net = parseFloat(l.amount || "0");
      const tax = parseFloat(l.taxAmount || "0");
      if (net <= 0) throw new Error("مبلغ البند يجب أن يكون أكبر من صفر");
      if (tax < 0) throw new Error("مبلغ الضريبة غير صالح");
      const lineCc = (l.costCenter ? String(l.costCenter).trim() || null : null) ?? cc;
      acctIds.add(lineAcct);
      jeLines.push({ accountId: lineAcct, debit: net.toFixed(2), credit: "0.00", description: l.description || desc, sortOrder: so++, costCenter: lineCc });
      total += net;
      if (tax > 0) {
        let taxAcc = l.taxAccountId ?? null;
        if (!taxAcc) {
          if (vatInputId === undefined) vatInputId = await resolveVatInputAccountId(cid);
          taxAcc = vatInputId ?? null;
        }
        if (!taxAcc) {
          throw new Error("لا يوجد حساب ضريبة المدخلات — حدّد حساب الضريبة في البند أو اربط «ضريبة المدخلات» في ربط القيود المحاسبية");
        }
        acctIds.add(taxAcc);
        jeLines.push({
          accountId: taxAcc, debit: tax.toFixed(2), credit: "0.00",
          description: `ضريبة مدخلات - ${l.description || v.code}`,
          sortOrder: so++, costCenter: lineCc,
          // Carry per-line supplier tax metadata onto the VAT-account JE line so
          // it surfaces in كشف حساب الضريبة (account-statement description suffix).
          supplierName:          l.supplierName ?? null,
          supplierVatNumber:     l.supplierVatNumber ?? null,
          supplierInvoiceNumber: l.supplierInvoiceNumber ?? null,
          supplierInvoiceDate:   l.supplierInvoiceDate ?? null,
        });
        total += tax;
      }
    }
    if (total <= 0) throw new Error("إجمالي السند يجب أن يكون أكبر من صفر");
    // ─── CR side: single treasury line for the grand total ────────────
    jeLines.push({ accountId: crAccountId, debit: "0.00", credit: total.toFixed(2), description: crLabel || desc, sortOrder: so++, costCenter: cc });
  } else {
    // ─── Legacy fallback: single supplier-payable DR / treasury CR ────
    if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
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
    acctIds.add(drAccountId);
    total = amount;
    jeLines.push({ accountId: drAccountId, debit: amount.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0, costCenter: cc });
    jeLines.push({ accountId: crAccountId, debit: "0.00", credit: amount.toFixed(2), description: crLabel || desc, sortOrder: 1, costCenter: cc });
  }

  // Guard against dangling account links: a supplier/cashbox/bank/line may
  // carry an accountId whose account row was later deleted. Without this the
  // JE header inserts and then the LINES insert fails on the account_id FK,
  // stranding an orphan zero-balance journal entry.
  const acctRows = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, [...acctIds])));
  const foundAccts = new Set(acctRows.map((a) => a.id));
  if (!foundAccts.has(crAccountId)) {
    throw new Error("حساب الخزنة/البنك المرتبط غير موجود في شجرة الحسابات — يرجى ربطه بحساب صحيح");
  }
  for (const id of acctIds) {
    if (!foundAccts.has(id)) {
      throw new Error("أحد الحسابات المرتبطة غير موجود في شجرة الحسابات — يرجى مراجعة حسابات البنود والموردين");
    }
  }

  // Period guard: prevent payment posting into a closed fiscal period.
  const writability = await assertWritableForDate(cid, v.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  // Pre-resolve so audit posted_* fields are stamped only when the
  // tenant's auto-post setting actually puts the JE in "posted" status.
  const jeStatus = await resolvePostingStatus(cid, "payment");
  // JE draws its own continuous "journal_entry" number; the voucher code
  // stays in the description + source link. Falls back to the voucher code.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: (req as any).authUser?.id ?? null, refTable: "journal_entries",
    branchId: v.branchId ?? null, docDate: v.date as any,
  })) ?? v.code;
  // Atomic: header + all lines commit together, so a mid-way failure never
  // strands an orphan (zero-balance) journal entry.
  const entryId = await db.transaction(async (tx) => {
    const [entry] = await tx.insert(journalEntriesTable).values({
      companyId: cid, branchId: v.branchId ?? null,
      docNumber: jeDocNumber, entryDate: v.date,
      currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
      description: desc, entryType: "payment",
      status: jeStatus,
      periodId: writability.period?.id ?? null,
      ...fullAuditFor(req, jeStatus),
    }).returning();
    await tx.insert(journalEntryLinesTable).values(
      jeLines.map((jl) => ({ entryId: entry.id, ...jl })),
    );
    return entry.id;
  });
  return entryId;
}

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  // Branch-Level Data Isolation: respect user scope and accept manager
  // multi-branch filter via ?branchIds=1,2,3 (or legacy ?branchId=).
  const branchScope = multiBranchScopeSpread(req, paymentVouchersTable.branchId, req.query.branchIds ?? req.query.branchId);
  const rows = cid
    ? await db.select().from(paymentVouchersTable)
        .where(and(eq(paymentVouchersTable.companyId, cid), ...branchScope))
        .orderBy(desc(paymentVouchersTable.createdAt))
    : await db.select().from(paymentVouchersTable)
        .where(branchScope.length ? and(...branchScope) : undefined)
        .orderBy(desc(paymentVouchersTable.createdAt));
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
  const lines = await db.select().from(paymentVoucherLinesTable)
    .where(eq(paymentVoucherLinesTable.voucherId, row.id))
    .orderBy(asc(paymentVoucherLinesTable.sortOrder), asc(paymentVoucherLinesTable.id));
  res.json({ ...row, lines });
});

// Normalize a raw request `lines[]` payload into typed allocation rows,
// dropping fully-empty rows. Returns null when the caller didn't send a
// `lines` array at all (legacy single-`amount` callers keep working).
interface RawPvLine {
  accountId: number | null;
  description: string | null;
  amount: number;
  taxRate: number;
  taxAmount: number;
  taxAccountId: number | null;
  costCenter: string | null;
  branchId: number | null;
  purchaseInvoiceId: number | null;
  supplierName: string | null;
  supplierVatNumber: string | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
}

// Trim a free-text metadata field to null when blank.
function txtOrNull(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function normalizePaymentLines(raw: any): RawPvLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawPvLine[] = [];
  for (const l of raw) {
    const accountId = l?.accountId ? parseInt(l.accountId) : null;
    const amount = parseFloat(l?.amount ?? "0") || 0;
    const taxAmount = parseFloat(l?.taxAmount ?? "0") || 0;
    if (!accountId && amount === 0 && taxAmount === 0) continue; // skip blank row
    out.push({
      accountId,
      description: l?.description ?? null,
      amount,
      taxRate: parseFloat(l?.taxRate ?? "0") || 0,
      taxAmount,
      taxAccountId: l?.taxAccountId ? parseInt(l.taxAccountId) : null,
      costCenter: l?.costCenter ? String(l.costCenter).trim() || null : null,
      branchId: l?.branchId ? parseInt(l.branchId) : null,
      purchaseInvoiceId: l?.purchaseInvoiceId ? parseInt(l.purchaseInvoiceId) : null,
      supplierName: txtOrNull(l?.supplierName),
      supplierVatNumber: txtOrNull(l?.supplierVatNumber),
      supplierInvoiceNumber: txtOrNull(l?.supplierInvoiceNumber),
      supplierInvoiceDate: txtOrNull(l?.supplierInvoiceDate),
    });
  }
  return out;
}

// Validate normalized lines: every line needs an account + positive amount,
// all account/tax-account ids must belong to the tenant, and any per-line
// invoice link must resolve to the same tenant/supplier.
async function validatePaymentLines(cid: number, lines: RawPvLine[], supplierId: number | null): Promise<void> {
  if (lines.length === 0) throw new Error("يجب إضافة بند واحد على الأقل");
  const acctIds = new Set<number>();
  for (const l of lines) {
    if (!l.accountId) throw new Error("كل بند يجب أن يحتوي على حساب محاسبي");
    if (l.amount <= 0) throw new Error("مبلغ البند يجب أن يكون أكبر من صفر");
    if (l.taxAmount < 0) throw new Error("مبلغ الضريبة غير صالح");
    acctIds.add(l.accountId);
    if (l.taxAccountId) acctIds.add(l.taxAccountId);
  }
  if (acctIds.size) {
    const found = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, [...acctIds])));
    const fs = new Set(found.map((a) => a.id));
    for (const id of acctIds) {
      if (!fs.has(id)) throw new Error("أحد الحسابات المحددة في البنود غير موجود في هذه الشركة");
    }
  }
  for (const l of lines) {
    if (l.purchaseInvoiceId) await validatePurchaseInvoiceLink(cid, l.purchaseInvoiceId, supplierId);
  }
}

// Sum a voucher's grand total from its allocation lines (net + input VAT).
function paymentLinesTotal(lines: RawPvLine[]): number {
  return lines.reduce((s, l) => s + l.amount + l.taxAmount, 0);
}

// Persist allocation lines for a voucher, replacing any existing rows.
async function replacePaymentLines(voucherId: number, lines: RawPvLine[]): Promise<void> {
  await db.delete(paymentVoucherLinesTable).where(eq(paymentVoucherLinesTable.voucherId, voucherId));
  if (lines.length === 0) return;
  await db.insert(paymentVoucherLinesTable).values(lines.map((l, i) => ({
    voucherId,
    accountId: l.accountId,
    description: l.description,
    amount: l.amount.toFixed(2),
    taxRate: l.taxRate.toFixed(2),
    taxAmount: l.taxAmount.toFixed(2),
    taxAccountId: l.taxAccountId,
    costCenter: l.costCenter,
    branchId: l.branchId,
    purchaseInvoiceId: l.purchaseInvoiceId,
    supplierName: l.supplierName,
    supplierVatNumber: l.supplierVatNumber,
    supplierInvoiceNumber: l.supplierInvoiceNumber,
    supplierInvoiceDate: l.supplierInvoiceDate,
    sortOrder: i,
  })));
}

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
  // Multi-allocation lines (optional). When present they drive the header
  // amount + invoice link; legacy single-`amount` callers send no `lines`.
  const lines = normalizePaymentLines(d.lines);
  if (lines) {
    try { await validatePaymentLines(cid, lines, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "بنود غير صالحة" }); return; }
  }
  const headerPurchaseInvoiceId = d.purchaseInvoiceId ? parseInt(d.purchaseInvoiceId) : null;
  // Prefer an explicit header link; else adopt the first line's invoice so
  // the list view keeps showing a linked-invoice badge.
  const purchaseInvoiceId = headerPurchaseInvoiceId
    ?? (lines?.find((l) => l.purchaseInvoiceId)?.purchaseInvoiceId ?? null);
  if (headerPurchaseInvoiceId) {
    try { await validatePurchaseInvoiceLink(cid, headerPurchaseInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }
  const headerAmount = lines ? paymentLinesTotal(lines).toFixed(2) : (d.amount || "0");

  // Auto code — prefer the configured "payment_voucher" sequence when no
  // explicit code was supplied. Falls back to the legacy PV-#### scheme so
  // tenants without a configured sequence keep working untouched.
  let code: string;
  if (d.code) {
    code = String(d.code);
  } else {
    const seq = await nextSequenceForPayment(cid, "payment_voucher", d.paymentType || "cash", {
      branchId: d.branchId ? parseInt(d.branchId) : null,
      userId:   (req as any).authUser?.id ?? null,
      refTable: "payment_vouchers",
      docDate:  d.date ?? null,
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
    // Multi-line vouchers keep the header override null (lines carry the
    // allocation accounts); legacy single-account callers still honor it.
    accountId:     lines ? null : (d.accountId ? parseInt(d.accountId) : null),
    amount:        headerAmount,
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
  if (lines) await replacePaymentLines(row.id, lines);
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
  const lines = normalizePaymentLines(d.lines);
  if (lines) {
    try { await validatePaymentLines(cid, lines, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "بنود غير صالحة" }); return; }
  }
  const headerPurchaseInvoiceId = d.purchaseInvoiceId ? parseInt(d.purchaseInvoiceId) : null;
  const purchaseInvoiceId = headerPurchaseInvoiceId
    ?? (lines?.find((l) => l.purchaseInvoiceId)?.purchaseInvoiceId ?? null);
  if (headerPurchaseInvoiceId) {
    try { await validatePurchaseInvoiceLink(existing.companyId, headerPurchaseInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }
  // When `lines` is present, header amount is derived from them; a legacy
  // caller (no `lines`) keeps sending its own `amount`.
  const headerAmount = lines ? paymentLinesTotal(lines).toFixed(2) : d.amount;

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
    accountId:     lines ? null : (d.accountId ? parseInt(d.accountId) : null),
    amount:        headerAmount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (purchaseInvoiceId ? "purchase_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    purchaseInvoiceId,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    costCenter:    d.costCenter ? String(d.costCenter).trim() || null : null,
  }).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid))).returning();
  // Replace lines only when the caller sent a `lines` array (undefined =
  // legacy update that shouldn't wipe existing allocations).
  if (lines) await replacePaymentLines(row.id, lines);
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
    const journalId = await buildPaymentJournal(existing.companyId, existing, req);
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
