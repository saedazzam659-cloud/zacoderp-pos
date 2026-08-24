import { Router } from "express";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import {
  paymentVouchersTable, paymentVoucherLinesTable,
  cashBoxesTable, bankAccountsTable,
  suppliersTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable,
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
  costCentersTable,
  employeesTable, employeeLoansTable, employeeCustodiesTable,
  fixedAssetsTable, faDepreciationRunsTable,
} from "@workspace/db";
import { resolveHrAccounts } from "../lib/hr-journals.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { eq, and, or, desc, inArray, asc, sql } from "drizzle-orm";
import { normalizePeriodicity, parseCcSplit, installmentsBetween, runDueAdjustmentsForCompany } from "../lib/adjustmentPosting.js";
import { extractAuth, resolveCompanyId, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber, nextSequenceForPayment, resolveJeNumber, reserveJeNumberFromEntry } from "../lib/sequences.js";
import { loadMappings, pickAccount, resolveVatInputAccountId } from "../lib/accountingMappings.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { sumSettlementJEs, acquireSettlementLock, acquireSourceLock, sumVouchersForInvoice, sumConsumedFromSource, sumPartialLinksForInvoice, invoiceNetDueBase } from "../lib/invoiceSettlement.js";
import {
  paymentVoucherAccountingTotal,
  paymentVoucherLineAccounting,
} from "../lib/paymentVoucherLineAccounting.js";
import { settlementLinksTable } from "@workspace/db";

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
      const sides = paymentVoucherLineAccounting({
        amount: net,
        taxAmount: tax,
        opType: l.opType,
        purchaseInvoiceId: l.purchaseInvoiceId,
      });
      const lineCc = (l.costCenter ? String(l.costCenter).trim() || null : null) ?? cc;
      acctIds.add(lineAcct);
      jeLines.push({
        accountId: lineAcct,
        debit: sides.debit.toFixed(2),
        credit: sides.credit.toFixed(2),
        description: l.description || desc,
        sortOrder: so++,
        costCenter: lineCc,
      });
      total += sides.total;
      if (sides.taxDebit > 0) {
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
          accountId: taxAcc, debit: sides.taxDebit.toFixed(2), credit: "0.00",
          description: `ضريبة مدخلات - ${l.description || v.code}`,
          // VAT lines are booked WITHOUT a cost center by design — the tax is
          // not an operating cost of any cost center (user request 2026-07).
          sortOrder: so++, costCenter: null,
          // Carry per-line supplier tax metadata onto the VAT-account JE line so
          // it surfaces in كشف حساب الضريبة (account-statement description suffix).
          supplierName:          l.supplierName ?? null,
          supplierVatNumber:     l.supplierVatNumber ?? null,
          supplierInvoiceNumber: l.supplierInvoiceNumber ?? null,
          supplierInvoiceDate:   l.supplierInvoiceDate ?? null,
        });
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
  // Atomic: header + all lines commit together, so a mid-way failure never
  // strands an orphan (zero-balance) journal entry.
  const entryId = await db.transaction(async (tx) => {
    // JE number: reuse the number reserved at unpost time (edit→repost keeps
    // the SAME journal-entry number, e.g. 1727 stays 1727), else draw the next
    // continuous "journal_entry" number. Falls back to the voucher code.
    // Resolved INSIDE the tx (dx: tx) so a rollback restores the reservation.
    const jeDocNumber = (await resolveJeNumber({
      companyId: cid, sourceType: "payment_voucher", sourceId: v.id,
      userId: (req as any).authUser?.id ?? null,
      branchId: v.branchId ?? null, docDate: v.date as any,
      dx: tx,
    })) ?? v.code;
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
  // Optional ?purchaseInvoiceId= filter (additive): return only vouchers linked
  // to that invoice — either via the header `purchaseInvoiceId` OR any of the
  // voucher's allocation lines. Used by the purchase-invoice «السداد» tab.
  // When the param is absent the query is unchanged. Mirrors the
  // ?salesInvoiceId= filter on receipt-vouchers.
  const rawPiId = req.query.purchaseInvoiceId ? parseInt(req.query.purchaseInvoiceId as string) : NaN;
  const piFilter: any[] = [];
  // Per-invoice applied amounts (سداد جزئي): lines + partial links carry their
  // own amount; a bare header link counts the FULL voucher amount.
  const appliedByVoucher = new Map<number, number>();
  if (Number.isInteger(rawPiId) && rawPiId > 0) {
    const lineRows = await db
      .select({ voucherId: paymentVoucherLinesTable.voucherId, amount: paymentVoucherLinesTable.amount })
      .from(paymentVoucherLinesTable)
      .where(eq(paymentVoucherLinesTable.purchaseInvoiceId, rawPiId));
    const linkRows = await db
      .select({ voucherId: settlementLinksTable.sourceId, amount: settlementLinksTable.amount })
      .from(settlementLinksTable)
      .where(and(
        eq(settlementLinksTable.sourceType, "payment_voucher"),
        eq(settlementLinksTable.purchaseInvoiceId, rawPiId),
      ));
    for (const r of [...lineRows, ...linkRows]) {
      const k = Number(r.voucherId);
      if (!k) continue;
      appliedByVoucher.set(k, (appliedByVoucher.get(k) ?? 0) + (parseFloat(String(r.amount)) || 0));
    }
    const vIds = [...appliedByVoucher.keys()];
    const linkOr = vIds.length
      ? or(eq(paymentVouchersTable.purchaseInvoiceId, rawPiId), inArray(paymentVouchersTable.id, vIds))
      : eq(paymentVouchersTable.purchaseInvoiceId, rawPiId);
    piFilter.push(linkOr);
  }
  const rows = cid
    ? await db.select().from(paymentVouchersTable)
        .where(and(eq(paymentVouchersTable.companyId, cid), ...branchScope, ...piFilter))
        .orderBy(desc(paymentVouchersTable.createdAt))
    : await db.select().from(paymentVouchersTable)
        .where((branchScope.length || piFilter.length) ? and(...branchScope, ...piFilter) : undefined)
        .orderBy(desc(paymentVouchersTable.createdAt));

  // A voucher is MULTI iff it actually has allocation LINES — the header
  // accountId is NOT a reliable discriminator (simple party-mode vouchers
  // also store accountId = null). Expose canonical `isMulti` to the lists.
  const rowIds = rows.map((r) => r.id);
  const multiIds = new Set<number>();
  if (rowIds.length) {
    const lineOwners = await db.select({ voucherId: paymentVoucherLinesTable.voucherId })
      .from(paymentVoucherLinesTable)
      .where(inArray(paymentVoucherLinesTable.voucherId, rowIds));
    for (const lo of lineOwners) if (lo.voucherId != null) multiIds.add(lo.voucherId);
  }
  // Multi-line vouchers often carry their البيان on the allocation LINES only
  // — surface it by falling back to the lines' descriptions when empty.
  const emptyDescMultiIds = rows
    .filter((r) => multiIds.has(r.id) && !(r.description ?? "").trim())
    .map((r) => r.id);
  const lineDescByVoucher = new Map<number, string>();
  if (emptyDescMultiIds.length) {
    const lineRows = await db.select({
        voucherId: paymentVoucherLinesTable.voucherId,
        description: paymentVoucherLinesTable.description,
      }).from(paymentVoucherLinesTable)
      .where(inArray(paymentVoucherLinesTable.voucherId, emptyDescMultiIds))
      .orderBy(asc(paymentVoucherLinesTable.sortOrder), asc(paymentVoucherLinesTable.id));
    for (const lr of lineRows) {
      const d = (lr.description ?? "").trim();
      if (!d || lr.voucherId == null) continue;
      const prev = lineDescByVoucher.get(lr.voucherId);
      if (!prev) lineDescByVoucher.set(lr.voucherId, d);
      else if (!prev.includes(d) && prev.length < 120) lineDescByVoucher.set(lr.voucherId, `${prev} / ${d}`);
    }
  }
  res.json(rows.map((r) => ({
    ...r,
    isMulti: multiIds.has(r.id),
    description: (r.description ?? "").trim() || lineDescByVoucher.get(r.id) || r.description,
    // With an invoice filter: the amount actually applied to THAT invoice —
    // partial links/lines carry their own amount; a bare header link means
    // the full voucher amount (legacy behaviour).
    ...(Number.isInteger(rawPiId) && rawPiId > 0 ? {
      appliedForInvoice: (appliedByVoucher.get(r.id) ?? (Number(r.purchaseInvoiceId) === rawPiId ? (parseFloat(String(r.amount)) || 0) : 0)).toFixed(2),
    } : {}),
  })));
});

// ─── Settlement candidates (سندات صرف غير مرتبطة بأي فاتورة) ───────────────
// Payment vouchers paid to the INVOICE'S SUPPLIER that are not linked to any
// invoice (neither header nor allocation lines). Surfaced on the purchase
// invoice «السداد» tab with an «إضافة» button — mirrors the manual-JE
// settlement-candidates flow. Literal sub-segment BEFORE /:id (Express 5).
router.get("/settlement-candidates", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const invId = Number(req.query.purchaseInvoiceId);
    if (!Number.isInteger(invId) || invId <= 0) { res.status(400).json({ error: "purchaseInvoiceId مطلوب" }); return; }
    const [inv] = await db.select({ supplierId: purchaseInvoicesTable.supplierId })
      .from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, invId), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.supplierId == null) { res.json([]); return; }
    const branchScope = multiBranchScopeSpread(req, paymentVouchersTable.branchId, req.query.branchIds ?? req.query.branchId);
    // السندات المتعددة قد لا تحمل جهة في الرأس (entity_id NULL) — المورد يظهر
    // على سطر التوزيع عبر حسابه. نطابق عندها بحساب المورد، بشرط ألا يكون
    // الحساب مشتركاً بين أكثر من مورد (قاعدة «مورد عام»).
    let supAcct: number | null = null;
    {
      const [supRow] = await db.select({ accountId: suppliersTable.accountId })
        .from(suppliersTable)
        .where(and(eq(suppliersTable.id, inv.supplierId), eq(suppliersTable.companyId, cid)));
      supAcct = supRow?.accountId ?? null;
      if (supAcct != null) {
        const [shared] = await db.select({ n: sql<string>`COUNT(*)` }).from(suppliersTable)
          .where(and(eq(suppliersTable.companyId, cid), eq(suppliersTable.accountId, supAcct)));
        if ((parseInt(String(shared?.n)) || 0) > 1) supAcct = null;
      }
    }
    const entityMatch = supAcct != null
      ? or(
          eq(paymentVouchersTable.entityId, inv.supplierId),
          and(
            sql`${paymentVouchersTable.entityId} IS NULL`,
            sql`EXISTS (SELECT 1 FROM payment_voucher_lines pl WHERE pl.voucher_id = ${paymentVouchersTable.id} AND pl.account_id = ${supAcct})`,
          ),
        )
      : eq(paymentVouchersTable.entityId, inv.supplierId);
    const rows = await db.select().from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.companyId, cid),
        entityMatch,
        sql`${paymentVouchersTable.purchaseInvoiceId} IS NULL`,
        ...branchScope,
      ))
      .orderBy(desc(paymentVouchersTable.id))
      .limit(100);
    if (!rows.length) { res.json([]); return; }
    // سداد جزئي: available = header amount − invoice-linked allocation lines
    // − partial settlement links. Candidates keep showing while any residual
    // remains; `amount` returned is the REMAINING available amount.
    const ids = rows.map((r) => r.id);
    const lineRows = await db.select({
      voucherId: paymentVoucherLinesTable.voucherId,
      // Payment lines allocate net + VAT (header amount = net + tax).
      sum: sql<string>`SUM(${paymentVoucherLinesTable.amount} + ${paymentVoucherLinesTable.taxAmount})`,
    }).from(paymentVoucherLinesTable)
      .where(and(
        inArray(paymentVoucherLinesTable.voucherId, ids),
        sql`${paymentVoucherLinesTable.purchaseInvoiceId} IS NOT NULL`,
      ))
      .groupBy(paymentVoucherLinesTable.voucherId);
    const linkRows = await db.select({
      sourceId: settlementLinksTable.sourceId,
      sum: sql<string>`SUM(${settlementLinksTable.amount})`,
    }).from(settlementLinksTable)
      .where(and(
        eq(settlementLinksTable.companyId, cid),
        eq(settlementLinksTable.sourceType, "payment_voucher"),
        inArray(settlementLinksTable.sourceId, ids),
      ))
      .groupBy(settlementLinksTable.sourceId);
    const consumed = new Map<number, number>();
    for (const r of lineRows) consumed.set(Number(r.voucherId), (consumed.get(Number(r.voucherId)) ?? 0) + (parseFloat(String(r.sum)) || 0));
    for (const r of linkRows) consumed.set(Number(r.sourceId), (consumed.get(Number(r.sourceId)) ?? 0) + (parseFloat(String(r.sum)) || 0));
    // multi = يملك سطور توزيع (كان يُشار هنا لمتغير خارج النطاق → 500 دائم).
    const candMultiIds = new Set<number>();
    const anyLineOwners = await db.select({ voucherId: paymentVoucherLinesTable.voucherId })
      .from(paymentVoucherLinesTable)
      .where(inArray(paymentVoucherLinesTable.voucherId, ids));
    for (const lo of anyLineOwners) if (lo.voucherId != null) candMultiIds.add(lo.voucherId);
    // للسندات بلا جهة في الرأس: الأساس = مجموع سطور حساب المورد فقط (صافي+ضريبة)،
    // والمستهلَك من السطور يقتصر على سطور المورد المرتبطة بفواتير.
    const partyBase = new Map<number, { total: number; linked: number }>();
    const nullEntityIds = rows.filter((r) => r.entityId == null).map((r) => r.id);
    if (supAcct != null && nullEntityIds.length) {
      const plRows = await db.select({
        voucherId: paymentVoucherLinesTable.voucherId,
        total: sql<string>`SUM(${paymentVoucherLinesTable.amount} + ${paymentVoucherLinesTable.taxAmount})`,
        linked: sql<string>`SUM(CASE WHEN ${paymentVoucherLinesTable.purchaseInvoiceId} IS NOT NULL THEN ${paymentVoucherLinesTable.amount} + ${paymentVoucherLinesTable.taxAmount} ELSE 0 END)`,
      }).from(paymentVoucherLinesTable)
        .where(and(
          inArray(paymentVoucherLinesTable.voucherId, nullEntityIds),
          eq(paymentVoucherLinesTable.accountId, supAcct),
        ))
        .groupBy(paymentVoucherLinesTable.voucherId);
      for (const r of plRows) if (r.voucherId != null) partyBase.set(Number(r.voucherId), {
        total: parseFloat(String(r.total)) || 0,
        linked: parseFloat(String(r.linked)) || 0,
      });
    }
    const linksOnly = new Map<number, number>();
    for (const r of linkRows) linksOnly.set(Number(r.sourceId), parseFloat(String(r.sum)) || 0);
    res.json(rows.map((r) => {
      const pb = r.entityId == null ? partyBase.get(r.id) : undefined;
      const total = pb ? pb.total : (parseFloat(String(r.amount)) || 0);
      const available = pb
        ? pb.total - pb.linked - (linksOnly.get(r.id) ?? 0)
        : total - (consumed.get(r.id) ?? 0);
      return {
        id: r.id, code: r.code, date: r.date,
        amount: available.toFixed(2), totalAmount: total.toFixed(2),
        exchangeRate: r.exchangeRate, paymentType: r.paymentType,
        status: r.status, description: r.description,
        isMulti: candMultiIds.has(r.id),
      };
    }).filter((r) => parseFloat(r.amount) > 0.005));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Apply an EXISTING unlinked voucher as invoice settlement ────────────────
// Sets the header purchaseInvoiceId. A header-linked voucher counts its FULL
// amount toward the invoice (sumVouchersForInvoice rule), so — unlike the JE
// flow — the amount cannot be clamped: it must fit within the remaining due.
// Race-safe: advisory lock + re-check inside the tx (invoice-settlement cap).
router.post("/:id/apply-settlement", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? parseInt(String(req.body.companyId)) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const vid = Number(req.params.id);
    const invId = Number(req.body?.purchaseInvoiceId);
    if (!Number.isInteger(vid) || vid <= 0) { res.status(400).json({ error: "معرّف السند غير صحيح" }); return; }
    if (!Number.isInteger(invId) || invId <= 0) { res.status(400).json({ error: "purchaseInvoiceId مطلوب" }); return; }

    // Branch scope — restricted-branch users must not link vouchers/invoices
    // outside their allowed branches (NULL-branch rows remain shared).
    const vBranchScope = multiBranchScopeSpread(req, paymentVouchersTable.branchId, undefined);
    const iBranchScope = multiBranchScopeSpread(req, purchaseInvoicesTable.branchId, undefined);

    const out = await db.transaction(async (tx) => {
      await acquireSettlementLock(tx, cid, "purchase", invId);
      await acquireSourceLock(tx, cid, "payment_voucher", vid);

      const [v] = await tx.select().from(paymentVouchersTable)
        .where(and(eq(paymentVouchersTable.id, vid), eq(paymentVouchersTable.companyId, cid), ...vBranchScope));
      if (!v) throw Object.assign(new Error("السند غير موجود"), { httpStatus: 404 });
      if (v.purchaseInvoiceId != null) {
        throw Object.assign(new Error("هذا السند مرتبط بفاتورة من رأس السند بالفعل"), { httpStatus: 409 });
      }
      // Allocation LINES linked to invoices consume part of the voucher —
      // they no longer block; their amounts are subtracted from المتاح below.
      const invLineRows = await tx.select({
        amount: paymentVoucherLinesTable.amount,
        taxAmount: paymentVoucherLinesTable.taxAmount,
      }).from(paymentVoucherLinesTable)
        .where(and(
          eq(paymentVoucherLinesTable.voucherId, vid),
          sql`${paymentVoucherLinesTable.purchaseInvoiceId} IS NOT NULL`,
        ));
      // Payment lines allocate net + VAT (header amount = net + tax).
      const lineConsumedDoc = invLineRows.reduce((s, r) =>
        s + (parseFloat(String(r.amount)) || 0) + (parseFloat(String(r.taxAmount)) || 0), 0);

      const [inv] = await tx.select({ supplierId: purchaseInvoicesTable.supplierId })
        .from(purchaseInvoicesTable)
        .where(and(eq(purchaseInvoicesTable.id, invId), eq(purchaseInvoicesTable.companyId, cid), ...iBranchScope));
      if (!inv) throw Object.assign(new Error("الفاتورة غير موجودة"), { httpStatus: 404 });
      // سند بلا جهة في الرأس (متعدد): يُقبل إذا كانت سطوره تضرب حساب المورد
      // غير المشترك — الأساس المتاح حينها = مجموع سطور المورد فقط.
      let partyLinesTotalDoc: number | null = null;
      let partyLinesLinkedDoc = 0;
      if (v.entityId == null) {
        if (inv.supplierId == null) throw Object.assign(new Error("السند ليس على مورد هذه الفاتورة"), { httpStatus: 400 });
        const [supRow] = await tx.select({ accountId: suppliersTable.accountId })
          .from(suppliersTable)
          .where(and(eq(suppliersTable.id, inv.supplierId), eq(suppliersTable.companyId, cid)));
        let supAcct = supRow?.accountId ?? null;
        if (supAcct != null) {
          const [shared] = await tx.select({ n: sql<string>`COUNT(*)` }).from(suppliersTable)
            .where(and(eq(suppliersTable.companyId, cid), eq(suppliersTable.accountId, supAcct)));
          if ((parseInt(String(shared?.n)) || 0) > 1) supAcct = null;
        }
        if (supAcct == null) throw Object.assign(new Error("السند ليس على مورد هذه الفاتورة"), { httpStatus: 400 });
        const [pl] = await tx.select({
          total: sql<string>`COALESCE(SUM(${paymentVoucherLinesTable.amount} + ${paymentVoucherLinesTable.taxAmount}), 0)`,
          linked: sql<string>`COALESCE(SUM(CASE WHEN ${paymentVoucherLinesTable.purchaseInvoiceId} IS NOT NULL THEN ${paymentVoucherLinesTable.amount} + ${paymentVoucherLinesTable.taxAmount} ELSE 0 END), 0)`,
        }).from(paymentVoucherLinesTable)
          .where(and(eq(paymentVoucherLinesTable.voucherId, vid), eq(paymentVoucherLinesTable.accountId, supAcct)));
        partyLinesTotalDoc = parseFloat(String(pl?.total)) || 0;
        partyLinesLinkedDoc = parseFloat(String(pl?.linked)) || 0;
        if (partyLinesTotalDoc <= 0.005) {
          throw Object.assign(new Error("السند ليس على مورد هذه الفاتورة"), { httpStatus: 400 });
        }
      } else if (inv.supplierId == null || Number(v.entityId) !== Number(inv.supplierId)) {
        throw Object.assign(new Error("السند ليس على مورد هذه الفاتورة"), { httpStatus: 400 });
      }

      const { netDue, paymentType } = await invoiceNetDueBase(cid, "purchase", invId);
      if (paymentType !== "credit") {
        throw Object.assign(new Error("لا يمكن سداد إلا فاتورة آجلة — الفواتير النقدية/البنكية تُسدَّد تلقائياً عند الترحيل"), { httpStatus: 400 });
      }
      const vouchers = await sumVouchersForInvoice(cid, "purchase", invId);
      const jes = await sumSettlementJEs(cid, "purchase", invId);
      const remainingBase = netDue - vouchers - jes;
      if (remainingBase <= 0.005) {
        throw Object.assign(new Error("الفاتورة مسدَّدة بالكامل — لا يوجد متبقٍّ"), { httpStatus: 409 });
      }
      const vRate = parseFloat(String(v.exchangeRate)) || 1;
      const vAmountDoc = parseFloat(String(v.amount)) || 0;
      if (vAmountDoc <= 0.005) {
        throw Object.assign(new Error("مبلغ السند يجب أن يكون أكبر من صفر"), { httpStatus: 400 });
      }

      // سداد جزئي: available = voucher amount − invoice-linked allocation
      // lines − partial links already consumed (any invoice). للسند بلا جهة:
      // الأساس سطور حساب المورد فقط، والمستهلَك من السطور سطور المورد المرتبطة.
      const linksConsumedDoc = await sumConsumedFromSource(cid, "payment_voucher", vid, tx);
      const availableDoc = partyLinesTotalDoc != null
        ? partyLinesTotalDoc - partyLinesLinkedDoc - linksConsumedDoc
        : vAmountDoc - lineConsumedDoc - linksConsumedDoc;
      if (availableDoc <= 0.005) {
        throw Object.assign(new Error("استُهلك مبلغ هذا السند بالكامل في سدادات سابقة — لا يوجد متبقٍّ متاح"), { httpStatus: 409 });
      }
      const availableBase = availableDoc * vRate;

      // Clamp to the remaining due — الباقي من السند يبقى متاحاً لفواتير أخرى.
      const appliedBase = Math.min(availableBase, remainingBase);
      const appliedDoc = vRate > 0 ? appliedBase / vRate : appliedBase;

      await tx.insert(settlementLinksTable).values({
        companyId: cid,
        sourceType: "payment_voucher",
        sourceId: vid,
        purchaseInvoiceId: invId,
        amount: appliedDoc.toFixed(2),
        createdBy: (req as any).authUser?.id ?? null,
      });

      const remainingAfter = Math.max(0, remainingBase - appliedBase);
      return {
        applied: Number(appliedDoc.toFixed(2)),
        remainingAfter: Number(remainingAfter.toFixed(2)),
        sourceRemaining: Number(Math.max(0, availableDoc - appliedDoc).toFixed(2)),
        partial: remainingAfter > 0.005,
      };
    });
    res.json(out);
  } catch (e: any) {
    res.status(e?.httpStatus ?? 500).json({ error: e.message });
  }
});

// ─── Unlink a header-linked voucher from its invoice ─────────────────────────
// Clears ONLY the header link (line-level allocations are managed from the
// voucher form itself). The JE stays untouched — bookkeeping link only.
router.post("/:id/unlink-settlement", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? parseInt(String(req.body.companyId)) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const vid = Number(req.params.id);
    if (!Number.isInteger(vid) || vid <= 0) { res.status(400).json({ error: "معرّف السند غير صحيح" }); return; }
    const vBranchScope = multiBranchScopeSpread(req, paymentVouchersTable.branchId, undefined);
    const [v] = await db.select({ id: paymentVouchersTable.id, pid: paymentVouchersTable.purchaseInvoiceId })
      .from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.id, vid), eq(paymentVouchersTable.companyId, cid), ...vBranchScope));
    if (!v) { res.status(404).json({ error: "السند غير موجود" }); return; }

    // Partial-link unlink: an explicit linkId removes ONE settlement link row.
    const linkId = req.body?.linkId != null ? Number(req.body.linkId) : null;
    if (linkId != null) {
      if (!Number.isInteger(linkId) || linkId <= 0) { res.status(400).json({ error: "linkId غير صحيح" }); return; }
      const deleted = await db.delete(settlementLinksTable)
        .where(and(
          eq(settlementLinksTable.id, linkId),
          eq(settlementLinksTable.companyId, cid),
          eq(settlementLinksTable.sourceType, "payment_voucher"),
          eq(settlementLinksTable.sourceId, vid),
        )).returning({ id: settlementLinksTable.id });
      if (!deleted.length) { res.status(404).json({ error: "رابط السداد غير موجود" }); return; }
      res.json({ ok: true });
      return;
    }

    // Fallback: no linkId but an invoice id given → remove ALL partial links
    // between this voucher and that invoice (the UI lists vouchers, not links).
    const invId = req.body?.purchaseInvoiceId != null ? Number(req.body.purchaseInvoiceId) : null;
    if (v.pid == null && invId != null && Number.isInteger(invId) && invId > 0) {
      const deleted = await db.delete(settlementLinksTable)
        .where(and(
          eq(settlementLinksTable.companyId, cid),
          eq(settlementLinksTable.sourceType, "payment_voucher"),
          eq(settlementLinksTable.sourceId, vid),
          eq(settlementLinksTable.purchaseInvoiceId, invId),
        )).returning({ id: settlementLinksTable.id });
      if (deleted.length) { res.json({ ok: true }); return; }
    }

    if (v.pid == null) { res.status(409).json({ error: "السند غير مرتبط بفاتورة من رأس السند — البنود المرتبطة تُدار من شاشة السند نفسه" }); return; }
    await db.update(paymentVouchersTable)
      .set({ purchaseInvoiceId: null })
      .where(eq(paymentVouchersTable.id, vid));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  // نوع العملية — ADDITIVE: legacy callers that don't send opType keep the
  // direct behavior untouched.
  opType: PvOpType;
  // Prepaid amortization plan (only when opType === "prepaid"):
  deferredExpenseAccountId: number | null;
  deferredStartDate: string | null;   // ISO YYYY-MM-DD
  deferredEndDate: string | null;     // ISO YYYY-MM-DD
  deferredPeriodicity: string | null;
  deferredCostCenters: { costCenterId: number; pct: number }[] | null;
  // Phase-2 op-type payloads:
  opSupplierId: number | null;        // supplier_advance / supplier_settlement
  opEmployeeId: number | null;        // employee_loan / employee_custody
  assetName: string | null;           // fixed_asset
  faMethod: string | null;            // straight_line | declining_balance
  faLifeYears: number | null;
  faStart: string | null;             // ISO YYYY-MM-DD
  loanInstallments: number | null;    // employee_loan
}

const PV_OP_TYPES = ["direct", "prepaid", "fixed_asset", "supplier_advance", "supplier_settlement", "employee_loan", "employee_custody"] as const;
type PvOpType = (typeof PV_OP_TYPES)[number];

const PV_ISO = /^\d{4}-\d{2}-\d{2}$/;

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
      opType: (PV_OP_TYPES as readonly string[]).includes(l?.opType) ? l.opType : "direct",
      deferredExpenseAccountId: l?.deferredExpenseAccountId ? parseInt(l.deferredExpenseAccountId) : null,
      deferredStartDate: PV_ISO.test(String(l?.deferredStartDate ?? "")) ? String(l.deferredStartDate) : null,
      deferredEndDate:   PV_ISO.test(String(l?.deferredEndDate   ?? "")) ? String(l.deferredEndDate)   : null,
      deferredPeriodicity: l?.opType === "prepaid" ? normalizePeriodicity(l?.deferredPeriodicity) : null,
      deferredCostCenters: Array.isArray(l?.deferredCostCenters) && l.deferredCostCenters.length
        ? l.deferredCostCenters : null,
      opSupplierId: l?.opSupplierId ? parseInt(l.opSupplierId) : null,
      opEmployeeId: l?.opEmployeeId ? parseInt(l.opEmployeeId) : null,
      assetName: txtOrNull(l?.assetName),
      faMethod: l?.faMethod === "declining_balance" ? "declining_balance" : "straight_line",
      faLifeYears: parseFloat(l?.faLifeYears ?? "0") || null,
      faStart: PV_ISO.test(String(l?.faStart ?? "")) ? String(l.faStart) : null,
      loanInstallments: l?.loanInstallments ? Math.max(1, parseInt(l.loanInstallments) || 1) : null,
    });
  }
  return out;
}

// Validate normalized lines: every line needs an account + positive amount,
// all account/tax-account ids must belong to the tenant, and any per-line
// invoice link must resolve to the same tenant/supplier.
async function validatePaymentLines(cid: number, lines: RawPvLine[], supplierId: number | null): Promise<void> {
  if (lines.length === 0) throw new Error("يجب إضافة بند واحد على الأقل");
  const voucherTotal = paymentVoucherAccountingTotal(lines);
  if (voucherTotal <= 0) throw new Error("يجب أن يكون صافي إجمالي سند الصرف أكبر من صفر");
  const acctIds = new Set<number>();
  const ccIdsNeeded = new Set<number>();
  // ── Phase-2 op types: resolve the DEBIT account SERVER-SIDE for supplier
  // and HR ops (never trust a client-picked account for a party sub-ledger).
  const supOps = lines.filter((l) => l.opType === "supplier_advance" || l.opType === "supplier_settlement");
  if (supOps.length) {
    const ids = [...new Set(supOps.map((l) => l.opSupplierId).filter((x): x is number => !!x))];
    if (ids.length !== new Set(supOps.map((l) => l.opSupplierId ?? -1)).size || supOps.some((l) => !l.opSupplierId)) {
      throw new Error("بند مورد: يجب اختيار المورد");
    }
    const sups = await db.select({ id: suppliersTable.id, accountId: suppliersTable.accountId })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.companyId, cid), inArray(suppliersTable.id, ids)));
    const byId = new Map(sups.map((s) => [s.id, s]));
    let apFallback: number | null | undefined; // lazy — mapping lookup only when needed
    for (const l of supOps) {
      const s = byId.get(l.opSupplierId!);
      if (!s) throw new Error("بند مورد: المورد غير موجود في هذه الشركة");
      let acct = s.accountId ?? null;
      if (!acct) {
        if (apFallback === undefined) apFallback = (await loadMappings(cid, "supplier_settlement"))("supplier_settlement", "payable");
        acct = apFallback ?? null;
      }
      if (!acct) throw new Error("بند مورد: لا يوجد حساب دائن للمورد — اربط المورد بحساب أو حدّد «تسوية الموردين» في ربط القيود");
      l.accountId = acct; // server-resolved supplier AP
      if (l.opType === "supplier_settlement") {
        if (!l.purchaseInvoiceId) throw new Error("بند تسوية دفعة مورد: يجب اختيار فاتورة المورد");
        await validatePurchaseInvoiceLink(cid, l.purchaseInvoiceId, l.opSupplierId!);
      }
    }
  }
  const hrOps = lines.filter((l) => l.opType === "employee_loan" || l.opType === "employee_custody");
  if (hrOps.length) {
    if (hrOps.some((l) => !l.opEmployeeId)) throw new Error("بند سلفة/عهدة: يجب اختيار الموظف");
    const ids = [...new Set(hrOps.map((l) => l.opEmployeeId!))];
    const emps = await db.select({ id: employeesTable.id }).from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), inArray(employeesTable.id, ids)));
    const found = new Set(emps.map((e) => e.id));
    for (const l of hrOps) {
      if (!found.has(l.opEmployeeId!)) throw new Error("بند سلفة/عهدة: الموظف غير موجود في هذه الشركة");
    }
    const hr = await resolveHrAccounts(cid);
    for (const l of hrOps) {
      const acct = l.opType === "employee_loan" ? hr.employeeLoans : hr.employeeCustody;
      if (!acct) {
        throw new Error(l.opType === "employee_loan"
          ? "لا يوجد حساب سلف الموظفين (11081) — أضِفه في شجرة الحسابات أو اربطه في إعدادات الرواتب"
          : "لا يوجد حساب عهد الموظفين (11082) — أضِفه في شجرة الحسابات أو اربطه في إعدادات الرواتب");
      }
      l.accountId = acct; // server-resolved HR control account
      if (l.opType === "employee_loan" && !l.loanInstallments) l.loanInstallments = 1;
    }
  }
  for (const l of lines) {
    if (!l.accountId) throw new Error("كل بند يجب أن يحتوي على حساب محاسبي");
    paymentVoucherLineAccounting(l);
    acctIds.add(l.accountId);
    if (l.taxAccountId) acctIds.add(l.taxAccountId);
    if (l.opType === "prepaid") {
      // مصروف مقدم: line accountId = حساب المصروف المقدم (asset), plan
      // requires the expense account + a valid recognition window.
      if (!l.deferredExpenseAccountId) throw new Error("بند مصروف مقدم: حساب المصروف مطلوب");
      acctIds.add(l.deferredExpenseAccountId);
      if (!l.deferredStartDate || !l.deferredEndDate || l.deferredEndDate < l.deferredStartDate) {
        throw new Error("بند مصروف مقدم: فترة الاستهلاك (من/إلى) مطلوبة وبتواريخ صحيحة");
      }
      if (installmentsBetween(l.deferredStartDate, l.deferredEndDate, "monthly").length <= 0) {
        throw new Error("بند مصروف مقدم: لا توجد أشهر صالحة بين تاريخي الاستهلاك");
      }
      // Optional multi-CC split: canonical {costCenterId,pct}; a
      // present-but-invalid split blocks saving explicitly (never silent).
      if (l.deferredCostCenters) {
        const parsed = parseCcSplit(l.deferredCostCenters);
        if (!parsed) throw new Error("بند مصروف مقدم: توزيع مراكز التكلفة غير صالح — مجموع النسب يجب أن يساوي 100%");
        l.deferredCostCenters = parsed;
        for (const s of parsed) ccIdsNeeded.add(s.costCenterId);
      }
    } else {
      // Never persist a stale plan on a non-prepaid line.
      l.deferredExpenseAccountId = null;
      l.deferredStartDate = null; l.deferredEndDate = null;
      l.deferredPeriodicity = null; l.deferredCostCenters = null;
    }
    if (l.opType === "fixed_asset") {
      // Asset account is user-picked (line.accountId, tenant-checked below);
      // the card needs at least a name + sane depreciation params.
      if (!l.assetName) throw new Error("بند أصل ثابت: اسم الأصل مطلوب");
      if (!l.faLifeYears || l.faLifeYears <= 0) l.faLifeYears = 5;
    } else {
      l.assetName = null; l.faMethod = null; l.faLifeYears = null; l.faStart = null;
    }
    if (l.opType !== "supplier_advance" && l.opType !== "supplier_settlement") l.opSupplierId = null;
    if (l.opType !== "employee_loan" && l.opType !== "employee_custody") l.opEmployeeId = null;
    if (l.opType !== "employee_loan") l.loanInstallments = null;
  }
  if (ccIdsNeeded.size) {
    const found = await db.select({ id: costCentersTable.id }).from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), inArray(costCentersTable.id, [...ccIdsNeeded])));
    const fs = new Set(found.map((c) => c.id));
    for (const id of ccIdsNeeded) {
      if (!fs.has(id)) throw new Error("بند مصروف مقدم: مركز تكلفة غير موجود في توزيع النسب");
    }
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
  // Wholesale replace loses line ids — capture existing prepaid-adjustment
  // links BEFORE the delete and re-attach each to the first unclaimed new
  // prepaid line with the same (prepaid account, expense account) pair, so an
  // unpost→edit→repost cycle reuses the SAME adjustment instead of minting a
  // duplicate. Links with no matching new line stay detached; the repost
  // orphan guard cancels their adjustments.
  const prev = await db.select({
    adjId:   paymentVoucherLinesTable.deferredAdjustmentId,
    acct:    paymentVoucherLinesTable.accountId,
    expAcct: paymentVoucherLinesTable.deferredExpenseAccountId,
    amount:  paymentVoucherLinesTable.amount,
    dStart:  paymentVoucherLinesTable.deferredStartDate,
    dEnd:    paymentVoucherLinesTable.deferredEndDate,
    dPer:    paymentVoucherLinesTable.deferredPeriodicity,
    dCcs:    paymentVoucherLinesTable.deferredCostCenters,
  }).from(paymentVoucherLinesTable)
    .where(and(
      eq(paymentVoucherLinesTable.voucherId, voucherId),
      sql`${paymentVoucherLinesTable.deferredAdjustmentId} IS NOT NULL`,
    ));
  const adjByLine = new Map<number, number>(); // line index → adjustment id
  const pool = prev.filter((p): p is typeof p & { adjId: number } => typeof p.adjId === "number");
  for (const p of pool) {
    // Reuse a link ONLY when the COMPLETE plan is unchanged (accounts, net
    // amount, window, periodicity, CC split). Any edit → leave detached; the
    // repost orphan guard cancels the stale adjustment and a fresh one is
    // minted with the new plan. Reusing on a partial match would silently
    // amortize the OLD schedule against the NEW payment JE.
    const idx = lines.findIndex((l, i) =>
      l.opType === "prepaid" && !adjByLine.has(i) &&
      l.accountId === p.acct && l.deferredExpenseAccountId === p.expAcct &&
      Math.abs(l.amount - (parseFloat(String(p.amount)) || 0)) < 0.005 &&
      l.deferredStartDate === p.dStart && l.deferredEndDate === p.dEnd &&
      (l.deferredPeriodicity || "monthly") === (p.dPer || "monthly") &&
      JSON.stringify(l.deferredCostCenters ?? null) === JSON.stringify(p.dCcs ?? null));
    if (idx >= 0) adjByLine.set(idx, p.adjId);
  }
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
    opType: l.opType,
    deferredExpenseAccountId: l.deferredExpenseAccountId,
    deferredStartDate: l.deferredStartDate,
    deferredEndDate: l.deferredEndDate,
    deferredPeriodicity: l.deferredPeriodicity,
    deferredCostCenters: l.deferredCostCenters,
    deferredAdjustmentId: adjByLine.get(i) ?? null,
    opSupplierId: l.opSupplierId,
    opEmployeeId: l.opEmployeeId,
    assetName: l.assetName,
    faMethod: l.faMethod,
    faLifeYears: l.faLifeYears != null ? String(l.faLifeYears) : null,
    faStart: l.faStart,
    loanInstallments: l.loanInstallments,
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

// Overpayment guard — BUSINESS RULE (explicit user decision): DRAFT vouchers
// count too. The sum of ALL vouchers linked to a purchase invoice (draft +
// posted, header-linked or line-linked) plus the allocation being saved must
// never exceed the invoice's net due (invoice total − linked returns).
// Everything is compared in BASE currency (amount × exchangeRate) so mixed
// currencies stay consistent. `excludeVoucherId` skips the voucher being
// updated (PUT) so its own old amount doesn't block the edit.
async function assertNoPurchaseOverpayment(
  cid: number,
  voucherRate: number,
  lines: RawPvLine[] | null,
  headerInvoiceId: number | null,
  headerAmount: number | null, // used only when the voucher has no lines
  excludeVoucherId: number | null,
): Promise<void> {
  // Allocation this request adds, in base currency, per linked invoice.
  // With lines: each line allocates (net + VAT) to ITS invoice; a header link
  // adopted from a line is already covered, so we never double count.
  const add = new Map<number, number>();
  if (lines) {
    for (const l of lines) {
      if (!l.purchaseInvoiceId) continue;
      add.set(l.purchaseInvoiceId, (add.get(l.purchaseInvoiceId) ?? 0) + (l.amount + l.taxAmount) * voucherRate);
    }
    // Bypass guard: a header link with NO matching line allocation still
    // settles that invoice — count the whole voucher against it (mirrors how
    // existing header-linked vouchers without line rows are summed below).
    if (headerInvoiceId && !add.has(headerInvoiceId)) {
      const total = lines.reduce((s, l) => s + l.amount + l.taxAmount, 0);
      if (total > 0) add.set(headerInvoiceId, total * voucherRate);
    }
  } else if (headerInvoiceId && headerAmount && headerAmount > 0) {
    add.set(headerInvoiceId, headerAmount * voucherRate);
  }
  for (const [invId, addBase] of add) {
    const [inv] = await db.select({
      total: purchaseInvoicesTable.totalAmount,
      rate:  purchaseInvoicesTable.exchangeRate,
    }).from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, invId), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
    // Persisted totalAmount already includes loaded LC expenses.
    const invBase = (parseFloat(String(inv.total)) || 0) * (parseFloat(String(inv.rate)) || 1);
    const rets = await db.select({
      total: purchaseReturnsTable.totalAmount,
      rate:  purchaseReturnsTable.exchangeRate,
    }).from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnsTable.invoiceId, invId)));
    const retBase = rets.reduce((s, r) => s + (parseFloat(String(r.total)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
    const netDue = Math.max(0, invBase - retBase);

    // Existing line-linked allocations (multi-form vouchers), net + VAT.
    const lineRows = await db.select({
      voucherId: paymentVoucherLinesTable.voucherId,
      amount:    paymentVoucherLinesTable.amount,
      taxAmount: paymentVoucherLinesTable.taxAmount,
      vRate:     paymentVouchersTable.exchangeRate,
    }).from(paymentVoucherLinesTable)
      .innerJoin(paymentVouchersTable, eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id))
      .where(and(
        eq(paymentVouchersTable.companyId, cid),
        eq(paymentVoucherLinesTable.purchaseInvoiceId, invId),
      ));
    const lineLinked = new Set(lineRows.map((r) => r.voucherId));
    let existing = 0;
    for (const r of lineRows) {
      if (excludeVoucherId && r.voucherId === excludeVoucherId) continue;
      existing += ((parseFloat(String(r.amount)) || 0) + (parseFloat(String(r.taxAmount)) || 0)) * (parseFloat(String(r.vRate)) || 1);
    }
    // Plus header-linked vouchers with NO line rows for this invoice
    // (simple-form vouchers); line-carrying vouchers were counted above.
    const headerRows = await db.select({
      id:     paymentVouchersTable.id,
      amount: paymentVouchersTable.amount,
      vRate:  paymentVouchersTable.exchangeRate,
    }).from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.purchaseInvoiceId, invId)));
    for (const v of headerRows) {
      if (excludeVoucherId && v.id === excludeVoucherId) continue;
      if (lineLinked.has(v.id)) continue;
      existing += (parseFloat(String(v.amount)) || 0) * (parseFloat(String(v.vRate)) || 1);
    }

    // Plus PARTIAL settlement links from other payment vouchers (سداد جزئي).
    existing += await sumPartialLinksForInvoice(cid, "purchase", invId, "payment_voucher");

    // Plus manual journal entries linked as settlements (draft + posted) —
    // sumSettlementJEs already includes JE-sourced partial links.
    existing += await sumSettlementJEs(cid, "purchase", invId);

    const remaining = netDue - existing;
    if (addBase > remaining + 0.01) {
      throw new Error(
        `لا يمكن حفظ السند: إجمالي السداد يتجاوز قيمة الفاتورة المرتبطة. المتبقي المسموح ${Math.max(0, remaining).toFixed(2)} فقط (تُحتسب السندات المسودة والقيود المحاسبية المرتبطة ضمن السداد)`
      );
    }
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
  // Overpayment guard BEFORE consuming a sequence number (no gap on reject).
  if (purchaseInvoiceId) {
    try {
      await assertNoPurchaseOverpayment(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerPurchaseInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        null,
      );
    } catch (e: any) { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return; }
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

  // Settlement race guard: serialize per-invoice + RE-check the cap under a
  // transaction-scoped advisory lock (closes the concurrent-saves window).
  const [row] = await db.transaction(async (tx) => {
    if (purchaseInvoiceId) {
      // Lock EVERY distinct linked invoice (sorted → deadlock-free), not just
      // the first: multi-line vouchers can settle several invoices at once.
      const lockIds = [...new Set([purchaseInvoiceId, ...(lines ?? []).map((l) => l.purchaseInvoiceId).filter((x): x is number => !!x)])].sort((a, b) => a - b);
      for (const lid of lockIds) await acquireSettlementLock(tx, cid, "purchase", lid);
      await assertNoPurchaseOverpayment(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerPurchaseInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        null,
      );
    }
    return tx.insert(paymentVouchersTable).values({
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
  }).catch((e: any) => { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return [null as any]; });
  if (!row) return;
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
  // Overpayment guard — exclude THIS voucher's old amounts (being replaced).
  if (purchaseInvoiceId) {
    try {
      await assertNoPurchaseOverpayment(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerPurchaseInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        id,
      );
    } catch (e: any) { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return; }
  }
  // When `lines` is present, header amount is derived from them; a legacy
  // caller (no `lines`) keeps sending its own `amount`.
  const headerAmount = lines ? paymentLinesTotal(lines).toFixed(2) : d.amount;

  // سداد جزئي: partial settlement links already consumed from THIS voucher
  // must still fit under the edited amount (net of new invoice-linked lines).
  {
    const linksConsumed = await sumConsumedFromSource(cid, "payment_voucher", id);
    if (linksConsumed > 0.005) {
      const newTotal = parseFloat(String(headerAmount ?? "0")) || 0;
      const newLineAlloc = (lines ?? [])
        .filter((l) => l.purchaseInvoiceId)
        .reduce((s, l) => s + l.amount + l.taxAmount, 0);
      if (newLineAlloc + linksConsumed > newTotal + 0.005) {
        res.status(400).json({ error: `لا يمكن تخفيض السند: ${linksConsumed.toFixed(2)} منه مستهلك كسداد جزئي لفواتير — فُكّ الارتباط أولاً` });
        return;
      }
    }
  }

  // Settlement race guard — same advisory-lock re-check as on create,
  // excluding THIS voucher's own old amounts.
  const [row] = await db.transaction(async (tx) => {
    if (purchaseInvoiceId) {
      // Lock EVERY distinct linked invoice (sorted → deadlock-free).
      const lockIds = [...new Set([purchaseInvoiceId, ...(lines ?? []).map((l) => l.purchaseInvoiceId).filter((x): x is number => !!x)])].sort((a, b) => a - b);
      for (const lid of lockIds) await acquireSettlementLock(tx, cid, "purchase", lid);
      await assertNoPurchaseOverpayment(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerPurchaseInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        id,
      );
    }
    return tx.update(paymentVouchersTable).set({
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
  }).catch((e: any) => { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return [null as any]; });
  if (!row) return;
  // Replace lines only when the caller sent a `lines` array (undefined =
  // legacy update that shouldn't wipe existing allocations).
  if (lines) await replacePaymentLines(row.id, lines);
  res.json(row);
});

router.post("/:id/post", requirePostRight("payment"), async (req, res) => {
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
  // ── مصروف مقدم: FX guard. The amortization engine posts BASE-currency JEs
  // and accounting_adjustments carries no currency, so a foreign-currency
  // voucher would amortize the wrong value. Reject explicitly (never guess).
  const pvRate = parseFloat(String((existing as any).exchangeRate ?? "1")) || 1;
  const anySpecialOp = await db.select({ id: paymentVoucherLinesTable.id })
    .from(paymentVoucherLinesTable)
    .where(and(eq(paymentVoucherLinesTable.voucherId, id), sql`${paymentVoucherLinesTable.opType} <> 'direct'`))
    .limit(1);
  if (anySpecialOp.length && Math.abs(pvRate - 1) > 1e-9) {
    res.status(400).json({ error: "بنود العمليات الخاصة (مصروف مقدم/أصل/سلفة/عهدة/مورد) متاحة فقط لسندات الصرف بالعملة الأساسية (سعر الصرف = 1)" });
    return;
  }
  // Atomically CLAIM the draft→posted transition so two concurrent /post
  // requests can never both build a JE / mint adjustments. Loser gets 400.
  const [claimed] = await db.update(paymentVouchersTable)
    .set({ status: "posted" })
    .where(and(
      eq(paymentVouchersTable.id, id),
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.status, "draft"),
    )).returning();
  if (!claimed) { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  try {
    const journalId = await buildPaymentJournal(existing.companyId, existing, req);
    const [row] = await db.update(paymentVouchersTable)
      .set({ status: "posted", journalEntryId: journalId })
      .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid))).returning();

    // ── مصروف مقدم: mint ONE linked accounting adjustment per prepaid line
    // (same amortization engine as deferred-expense purchase-invoice lines).
    // The voucher JE above already debited the prepaid asset account; the
    // adjustment amortizes it monthly: DR expense (+CC split) / CR prepaid.
    const adjustmentRunWarnings: string[] = [];
    const vLines = await db.select().from(paymentVoucherLinesTable)
      .where(eq(paymentVoucherLinesTable.voucherId, id))
      .orderBy(asc(paymentVoucherLinesTable.sortOrder), asc(paymentVoucherLinesTable.id));
    const prepaidLines = vLines.filter((l) => (l as any).opType === "prepaid");
    for (const l of prepaidLines) {
      // Idempotency: a line already carrying a linked adjustment is skipped so
      // a retried post (or unpost→repost) never mints a duplicate.
      if ((l as any).deferredAdjustmentId) continue;
      const netTotal = parseFloat(String(l.amount)) || 0; // net of VAT — exactly what hit the prepaid account
      const expAcc = (l as any).deferredExpenseAccountId as number | null;
      const start = (l as any).deferredStartDate as string | null;
      const end = (l as any).deferredEndDate as string | null;
      if (netTotal <= 0 || !expAcc || !start || !end) continue; // validated at save; belt-and-braces
      const monthsCount = installmentsBetween(start, end, "monthly").length || 1;
      const monthly = +(netTotal / monthsCount).toFixed(2);
      const [adj] = await db.insert(accountingAdjustmentsTable).values({
        companyId:        cid,
        type:             "prepaid",
        name:             `مصروف مقدم — ${l.description || existing.description || ""} (سند صرف ${existing.code})`.trim(),
        expenseAccountId: expAcc,
        contraAccountId:  l.accountId!, // حساب المصروف المقدم
        totalAmount:      String(netTotal.toFixed(2)),
        startDate:        start,
        endDate:          end,
        monthlyAmount:    String(monthly),
        periodicity:      (l as any).deferredPeriodicity || "monthly",
        sourceType:       "payment_voucher",
        sourceId:         id,
        costCenterSplit:  (l as any).deferredCostCenters ?? null,
        autoGenerate:     true,
        status:           "active",
        notes:            `مُنشأ تلقائياً من ترحيل سند الصرف ${existing.code}`,
      }).returning();
      if (adj) {
        await db.update(paymentVoucherLinesTable)
          .set({ deferredAdjustmentId: adj.id })
          .where(eq(paymentVoucherLinesTable.id, l.id));
      }
    }

    // ── Phase-2 op types: mint the linked records (asset card / HR loan /
    // HR custody). Idempotent — retried posts and unpost→repost cycles skip
    // lines whose record already exists. Supplier ops need nothing here: the
    // JE already debits the supplier AP account and the settlement cap
    // guarded the invoice link at save time.
    const vDate = String((existing as any).date ?? new Date().toISOString().slice(0, 10));
    for (const l of vLines) {
      const op = (l as any).opType as string;
      const net = parseFloat(String(l.amount)) || 0;
      if (net <= 0) continue;
      if (op === "fixed_asset") {
        // One live asset per source line — the partial unique index
        // uq_fixed_assets_source is the race-safe guard; the pre-check keeps
        // the common retry path quiet.
        const [dup] = await db.select({ id: fixedAssetsTable.id }).from(fixedAssetsTable)
          .where(and(
            eq(fixedAssetsTable.companyId, cid),
            eq(fixedAssetsTable.sourceType, "payment_voucher"),
            eq(fixedAssetsTable.sourceDocumentId, id),
            eq(fixedAssetsTable.sourceLineId, l.id),
            sql`${fixedAssetsTable.status} NOT IN ('sold','scrapped')`,
          ));
        if (dup) continue;
        const nameAr = (l as any).assetName || l.description || `أصل — سند صرف ${existing.code}`;
        const code = await nextSequenceOrFallback(
          cid, "fixed_asset",
          { userId: (req as any).authUser?.id ?? null, refTable: "fixed_assets", branchId: (l as any).branchId ?? null },
          async () => `AST-PV${id}-${l.id}`,
        );
        try {
          await db.insert(fixedAssetsTable).values({
            companyId: cid,
            branchId: (l as any).branchId ?? null,
            code,
            nameAr,
            status: "active",
            purchaseDate: vDate,
            purchaseValue: net.toFixed(2),
            paymentMethod: existing.paymentType === "bank" ? "bank" : "cash",
            // Cost already booked by the voucher JE (DR asset account) —
            // never post a second acquisition JE.
            skipAcquisitionJe: true,
            depreciationMethod: ((l as any).faMethod === "declining_balance" ? "declining_balance" : "straight_line") as any,
            lifeYears: String(parseFloat((l as any).faLifeYears || "5") || 5),
            scrapValue: "0",
            depreciationStart: (l as any).faStart || vDate,
            accumulatedDepreciation: "0",
            bookValue: net.toFixed(2),
            qrPayload: JSON.stringify({ kind: "fixed_asset", code, name: nameAr, companyId: cid }),
            notes: `مُنشأ تلقائياً من سند الصرف ${existing.code}`,
            sourceType: "payment_voucher",
            sourceDocumentId: id,
            sourceLineId: l.id,
          });
        } catch (e: any) {
          if (e?.code === "23505") continue; // concurrent duplicate — already created
          adjustmentRunWarnings.push(`تعذّر إنشاء بطاقة الأصل «${nameAr}»: ${e?.message ?? "خطأ"}`);
        }
      } else if (op === "employee_loan" && !(l as any).opRefId && (l as any).opEmployeeId) {
        const inst = Math.max(1, Number((l as any).loanInstallments) || 1);
        // Insert + line-link in ONE tx so a crash can never strand an
        // unlinked loan that a retried post would duplicate.
        await db.transaction(async (tx) => {
        const [loan] = await tx.insert(employeeLoansTable).values({
          companyId: cid,
          employeeId: (l as any).opEmployeeId,
          loanDate: vDate,
          loanType: "loan",
          amount: net.toFixed(2),
          installments: inst,
          installmentAmt: (net / inst).toFixed(2),
          paidAmount: "0",
          status: "active",
          reason: l.description ?? null,
          notes: `صُرفت عبر سند الصرف ${existing.code} — لا تُنشئ قيد صرف إضافياً`,
          loanAccountId: l.accountId ?? null,
        }).returning();
        if (loan) {
          await tx.update(paymentVoucherLinesTable).set({ opRefId: loan.id })
            .where(eq(paymentVoucherLinesTable.id, l.id));
        }
        });
      } else if (op === "employee_custody" && !(l as any).opRefId && (l as any).opEmployeeId) {
        // Same single-tx pattern as loans — never strand an unlinked custody.
        await db.transaction(async (tx) => {
        const [cust] = await tx.insert(employeeCustodiesTable).values({
          companyId: cid,
          branchId: (l as any).branchId ?? existing.branchId ?? null,
          employeeId: (l as any).opEmployeeId,
          custodyDate: vDate,
          amount: net.toFixed(2),
          settledAmount: "0",
          returnedAmount: "0",
          purpose: l.description ?? null,
          notes: `صُرفت عبر سند الصرف ${existing.code}`,
          status: "active",
          custodyAccountId: l.accountId ?? null,
          // The voucher JE IS the disbursement JE (DR custody / CR treasury).
          disbursementJournalId: journalId,
        }).returning();
        if (cust) {
          await tx.update(paymentVoucherLinesTable).set({ opRefId: cust.id })
            .where(eq(paymentVoucherLinesTable.id, l.id));
        }
        });
      }
    }

    // Repost lifecycle — mirrors purchase invoices: reactivate line-linked
    // adjustments (unpost froze them), cancel line-orphaned ones, flip their
    // frozen draft run JEs back to posted, then auto-run due installments.
    const sourceLinkedAdjs = await db.select({
      id: accountingAdjustmentsTable.id,
      name: accountingAdjustmentsTable.name,
      status: accountingAdjustmentsTable.status,
    }).from(accountingAdjustmentsTable)
      .where(and(
        eq(accountingAdjustmentsTable.companyId, cid),
        eq(accountingAdjustmentsTable.sourceType, "payment_voucher"),
        eq(accountingAdjustmentsTable.sourceId, id),
      ));
    if (sourceLinkedAdjs.length) {
      const lineLinkedIds = new Set(
        vLines.map((l) => (l as any).deferredAdjustmentId).filter((x: any): x is number => typeof x === "number"),
      );
      // Re-read links updated just above (fresh inserts aren't in vLines).
      const freshLinks = await db.select({ adjId: paymentVoucherLinesTable.deferredAdjustmentId })
        .from(paymentVoucherLinesTable)
        .where(and(eq(paymentVoucherLinesTable.voucherId, id), sql`${paymentVoucherLinesTable.deferredAdjustmentId} IS NOT NULL`));
      for (const r of freshLinks) if (typeof r.adjId === "number") lineLinkedIds.add(r.adjId);
      const activeIds = sourceLinkedAdjs.filter((a) => lineLinkedIds.has(a.id)).map((a) => a.id);
      const orphanIds = sourceLinkedAdjs.filter((a) => !lineLinkedIds.has(a.id) && a.status !== "cancelled").map((a) => a.id);
      if (orphanIds.length) {
        await db.update(accountingAdjustmentsTable)
          .set({ status: "cancelled", autoGenerate: false, updatedAt: new Date() })
          .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, orphanIds)));
      }
      if (activeIds.length) {
        await db.update(accountingAdjustmentsTable)
          .set({ autoGenerate: true, status: "active", updatedAt: new Date() })
          .where(and(
            eq(accountingAdjustmentsTable.companyId, cid),
            inArray(accountingAdjustmentsTable.id, activeIds),
            sql`${accountingAdjustmentsTable.status} <> 'completed'`,
          ));
        const runRows = await db.select({ jeId: accountingAdjustmentRunsTable.journalEntryId })
          .from(accountingAdjustmentRunsTable)
          .where(inArray(accountingAdjustmentRunsTable.adjustmentId, activeIds));
        const runJeIds = runRows.map((r) => r.jeId).filter((x): x is number => typeof x === "number");
        if (runJeIds.length) {
          await db.update(journalEntriesTable)
            .set({ status: "posted", updatedAt: new Date() })
            .where(and(
              eq(journalEntriesTable.companyId, cid),
              inArray(journalEntriesTable.id, runJeIds),
              eq(journalEntriesTable.status, "draft"),
            ));
        }
        for (const adjId of activeIds) {
          try { await runDueAdjustmentsForCompany(cid, req as any, adjId); }
          catch (err: any) {
            const nm = sourceLinkedAdjs.find((a) => a.id === adjId)?.name || `#${adjId}`;
            adjustmentRunWarnings.push(`تعذّر توليد/ترحيل قيود التسوية «${nm}»: ${err?.message || "خطأ غير معروف"}`);
          }
        }
      }
    }

    res.json(adjustmentRunWarnings.length ? { ...row, adjustmentRunWarnings } : row);
  } catch (e: any) {
    // JE build (or adjustment wiring) failed — release the claim so the
    // voucher returns to an editable draft instead of a posted-without-JE limbo.
    await db.update(paymentVouchersTable)
      .set({ status: "draft", journalEntryId: null })
      .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)))
      .catch(() => { /* best-effort rollback */ });
    res.status(e?.status ?? 400).json({ error: e?.message || "تعذّر إنشاء القيد المحاسبي" });
  }
});

router.post("/:id/unpost", requireUnpostRight("payment"), async (req, res) => {
  const id = parseInt(req.params.id as string);
  // Multi-tenant guard — admins from one tenant must not unpost another
  // tenant's voucher even if they happen to know the ID.
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status !== "posted") { res.status(400).json({ error: "السند ليس مرحّلاً" }); return; }
  // ── Phase-2 op types: guard + rollback the linked records BEFORE touching
  // the JE. Any record that has downstream activity BLOCKS the unpost (the
  // user must undo that activity first); untouched records are deleted so a
  // repost re-mints them cleanly.
  const opLines = await db.select().from(paymentVoucherLinesTable)
    .where(and(eq(paymentVoucherLinesTable.voucherId, id), sql`${paymentVoucherLinesTable.opType} IN ('fixed_asset','employee_loan','employee_custody')`));
  if (opLines.length) {
    // Fixed assets: block if any linked asset was already disposed (sold/
    // scrapped = downstream activity) or has depreciation runs.
    const allSourced = await db.select({ id: fixedAssetsTable.id, nameAr: fixedAssetsTable.nameAr, status: fixedAssetsTable.status })
      .from(fixedAssetsTable)
      .where(and(
        eq(fixedAssetsTable.companyId, cid),
        eq(fixedAssetsTable.sourceType, "payment_voucher"),
        eq(fixedAssetsTable.sourceDocumentId, id),
      ));
    const disposed = allSourced.find((a) => a.status === "sold" || a.status === "scrapped");
    if (disposed) {
      res.status(400).json({ error: `لا يمكن فك الترحيل: الأصل «${disposed.nameAr}» المرتبط بالسند تم بيعه أو إعدامه` });
      return;
    }
    const assets = allSourced;
    if (assets.length) {
      const runs = await db.select({ assetId: faDepreciationRunsTable.assetId })
        .from(faDepreciationRunsTable)
        .where(inArray(faDepreciationRunsTable.assetId, assets.map((a) => a.id)))
        .limit(1);
      if (runs.length) {
        const blocked = assets.find((a) => a.id === runs[0].assetId);
        res.status(400).json({ error: `لا يمكن فك الترحيل: الأصل «${blocked?.nameAr ?? runs[0].assetId}» له قيود إهلاك — احذف قيود الإهلاك أولاً من وحدة الأصول الثابتة` });
        return;
      }
    }
    // Loans: block if any repayment was deducted; custody: block if settled/returned.
    const loanIds = opLines.filter((l) => (l as any).opType === "employee_loan" && (l as any).opRefId).map((l) => (l as any).opRefId as number);
    if (loanIds.length) {
      const loans = await db.select({ id: employeeLoansTable.id, paid: employeeLoansTable.paidAmount })
        .from(employeeLoansTable)
        .where(and(eq(employeeLoansTable.companyId, cid), inArray(employeeLoansTable.id, loanIds)));
      const busy = loans.find((x) => (parseFloat(String(x.paid)) || 0) > 0);
      if (busy) { res.status(400).json({ error: "لا يمكن فك الترحيل: سلفة الموظف المرتبطة سُدد جزء منها عبر الرواتب" }); return; }
    }
    const custIds = opLines.filter((l) => (l as any).opType === "employee_custody" && (l as any).opRefId).map((l) => (l as any).opRefId as number);
    if (custIds.length) {
      const custs = await db.select({
        id: employeeCustodiesTable.id,
        settled: employeeCustodiesTable.settledAmount,
        returned: employeeCustodiesTable.returnedAmount,
      }).from(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.companyId, cid), inArray(employeeCustodiesTable.id, custIds)));
      const busy = custs.find((x) => (parseFloat(String(x.settled)) || 0) > 0 || (parseFloat(String(x.returned)) || 0) > 0);
      if (busy) { res.status(400).json({ error: "لا يمكن فك الترحيل: عهدة الموظف المرتبطة لها تسويات أو إرجاعات" }); return; }
    }
    // All guards passed → delete the untouched records + clear line links.
    if (assets.length) {
      await db.delete(fixedAssetsTable)
        .where(and(eq(fixedAssetsTable.companyId, cid), inArray(fixedAssetsTable.id, assets.map((a) => a.id))));
    }
    if (loanIds.length || custIds.length) {
      await db.update(paymentVoucherLinesTable).set({ opRefId: null })
        .where(and(eq(paymentVoucherLinesTable.voucherId, id), sql`${paymentVoucherLinesTable.opRefId} IS NOT NULL`));
    }
    if (loanIds.length) {
      await db.delete(employeeLoansTable)
        .where(and(eq(employeeLoansTable.companyId, cid), inArray(employeeLoansTable.id, loanIds)));
    }
    if (custIds.length) {
      await db.delete(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.companyId, cid), inArray(employeeCustodiesTable.id, custIds)));
    }
  }
  if (existing.journalEntryId) {
    // Stash the JE number BEFORE deleting so the next post (after an edit)
    // reuses the SAME journal-entry number instead of burning a fresh one.
    await reserveJeNumberFromEntry(cid, "payment_voucher", id, existing.journalEntryId);
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, existing.journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
  // ── مصروف مقدم: freeze the linked amortization plans while the voucher is
  // a draft (mirrors purchase invoices). Adjustments WITH generated runs are
  // kept (their run JEs flip to DRAFT, docNumbers preserved) + autoGenerate
  // OFF so the hourly scheduler stays away; run-less adjustments are deleted
  // (repost recreates them via the line link being cleared).
  const srcAdjs = await db.select({ id: accountingAdjustmentsTable.id })
    .from(accountingAdjustmentsTable)
    .where(and(
      eq(accountingAdjustmentsTable.companyId, cid),
      eq(accountingAdjustmentsTable.sourceType, "payment_voucher"),
      eq(accountingAdjustmentsTable.sourceId, id),
    ));
  if (srcAdjs.length) {
    const adjIds = srcAdjs.map((a) => a.id);
    const runs = await db.select({
      adjId: accountingAdjustmentRunsTable.adjustmentId,
      jeId:  accountingAdjustmentRunsTable.journalEntryId,
    }).from(accountingAdjustmentRunsTable)
      .where(inArray(accountingAdjustmentRunsTable.adjustmentId, adjIds));
    const withRuns = new Set(runs.map((r) => r.adjId));
    const runJeIds = runs.map((r) => r.jeId).filter((x): x is number => typeof x === "number");
    if (runJeIds.length) {
      await db.update(journalEntriesTable)
        .set({ status: "draft", updatedAt: new Date() })
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          inArray(journalEntriesTable.id, runJeIds),
          eq(journalEntriesTable.status, "posted"),
        ));
    }
    const keepIds = adjIds.filter((x) => withRuns.has(x));
    let dropIds = adjIds.filter((x) => !withRuns.has(x));
    // Never delete an adjustment still referenced by ANOTHER voucher's lines
    // (no FK on deferred_adjustment_id — a stale cross-link would dangle).
    if (dropIds.length) {
      const foreignRefs = await db.select({ adjId: paymentVoucherLinesTable.deferredAdjustmentId })
        .from(paymentVoucherLinesTable)
        .where(and(
          inArray(paymentVoucherLinesTable.deferredAdjustmentId, dropIds),
          sql`${paymentVoucherLinesTable.voucherId} <> ${id}`,
        ));
      const foreign = new Set(foreignRefs.map((r) => r.adjId));
      dropIds = dropIds.filter((x) => !foreign.has(x));
    }
    if (keepIds.length) {
      await db.update(accountingAdjustmentsTable)
        .set({ autoGenerate: false, updatedAt: new Date() })
        .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, keepIds)));
    }
    if (dropIds.length) {
      // Clear line links FIRST so repost re-mints cleanly.
      await db.update(paymentVoucherLinesTable)
        .set({ deferredAdjustmentId: null })
        .where(and(eq(paymentVoucherLinesTable.voucherId, id), inArray(paymentVoucherLinesTable.deferredAdjustmentId, dropIds)));
      await db.delete(accountingAdjustmentsTable)
        .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, dropIds)));
    }
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
