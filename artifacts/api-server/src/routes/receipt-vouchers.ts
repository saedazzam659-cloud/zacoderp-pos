import { Router } from "express";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import {
  receiptVouchersTable, receiptVoucherLinesTable,
  cashBoxesTable, bankAccountsTable,
  customersTable,
  salesInvoicesTable,
  salesReturnsTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable,
} from "@workspace/db";
import { eq, and, or, desc, inArray, asc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber, nextSequenceForPayment, resolveJeNumber, reserveJeNumberFromEntry } from "../lib/sequences.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { sumSettlementJEs, acquireSettlementLock, acquireSourceLock, sumVouchersForInvoice, sumConsumedFromSource, sumPartialLinksForInvoice, invoiceNetDueBase } from "../lib/invoiceSettlement.js";
import { settlementLinksTable } from "@workspace/db";

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

  const desc = `سند قبض ${v.code}${v.description ? " - " + v.description : ""}`;
  const cc = v.costCenter ? String(v.costCenter).trim() || null : null;

  // Multi-allocation model: one treasury DR side + many CR allocation lines
  // (each crediting a customer receivable or income account). Receipt lines
  // carry NO VAT. When no lines exist (legacy single-`amount` voucher) we
  // fall back to the classic two-line JE.
  const lines = await db.select().from(receiptVoucherLinesTable)
    .where(eq(receiptVoucherLinesTable.voucherId, v.id))
    .orderBy(asc(receiptVoucherLinesTable.sortOrder), asc(receiptVoucherLinesTable.id));

  const jeLines: {
    accountId: number; debit: string; credit: string;
    description: string; sortOrder: number; costCenter: string | null;
  }[] = [];
  const acctIds = new Set<number>([drAccountId]);
  let total = 0;
  let so = 1; // sortOrder 0 reserved for the treasury DR line

  if (lines.length > 0) {
    // ─── CR side: per-line allocation ─────────────────────────────────
    for (const l of lines) {
      const lineAcct = l.accountId ?? null;
      if (!lineAcct) throw new Error("كل بند يجب أن يحتوي على حساب محاسبي");
      const net = parseFloat(l.amount || "0");
      if (net <= 0) throw new Error("مبلغ البند يجب أن يكون أكبر من صفر");
      const lineCc = (l.costCenter ? String(l.costCenter).trim() || null : null) ?? cc;
      acctIds.add(lineAcct);
      jeLines.push({ accountId: lineAcct, debit: "0.00", credit: net.toFixed(2), description: l.description || desc, sortOrder: so++, costCenter: lineCc });
      total += net;
    }
    if (total <= 0) throw new Error("إجمالي السند يجب أن يكون أكبر من صفر");
    // ─── DR side: single treasury line for the grand total ────────────
    jeLines.unshift({ accountId: drAccountId, debit: total.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0, costCenter: cc });
  } else {
    // ─── Legacy fallback: single treasury DR / customer-receivable CR ──
    if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
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
    acctIds.add(crAccountId);
    total = amount;
    jeLines.push({ accountId: drAccountId, debit: amount.toFixed(2), credit: "0.00", description: drLabel || desc, sortOrder: 0, costCenter: cc });
    jeLines.push({ accountId: crAccountId, debit: "0.00", credit: amount.toFixed(2), description: crLabel || desc, sortOrder: 1, costCenter: cc });
  }

  // Guard against dangling account links: a customer/cashbox/bank/line may
  // carry an accountId whose account row was later deleted. Without this the
  // JE header inserts and then the LINES insert fails on the account_id FK,
  // stranding an orphan zero-balance journal entry.
  const acctRows = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, [...acctIds])));
  const foundAccts = new Set(acctRows.map((a) => a.id));
  if (!foundAccts.has(drAccountId)) {
    throw new Error("حساب الخزنة/البنك المرتبط غير موجود في شجرة الحسابات — يرجى ربطه بحساب صحيح");
  }
  for (const id of acctIds) {
    if (!foundAccts.has(id)) {
      throw new Error("أحد الحسابات المرتبطة غير موجود في شجرة الحسابات — يرجى مراجعة حسابات البنود والعملاء");
    }
  }

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
  // Atomic: header + all lines commit together, so a mid-way failure never
  // strands an orphan (zero-balance) journal entry.
  const entryId = await db.transaction(async (tx) => {
    // JE number: reuse the number reserved at unpost time (edit→repost keeps
    // the SAME journal-entry number), else draw the next continuous
    // "journal_entry" number. Falls back to the voucher code.
    // Resolved INSIDE the tx (dx: tx) so a rollback restores the reservation.
    const jeDocNumber = (await resolveJeNumber({
      companyId: cid, sourceType: "receipt_voucher", sourceId: v.id,
      userId: (req as any).authUser?.id ?? null,
      branchId: v.branchId ?? null, docDate: v.date as any,
      dx: tx,
    })) ?? v.code;
    const [entry] = await tx.insert(journalEntriesTable).values({
      companyId: cid, branchId: v.branchId ?? null,
      docNumber: jeDocNumber, entryDate: v.date,
      currency: "SAR", exchangeRate: String(v.exchangeRate ?? "1"),
      description: desc, entryType: "receipt",
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
  const branchScope = multiBranchScopeSpread(req, receiptVouchersTable.branchId, req.query.branchIds ?? req.query.branchId);
  // Optional ?salesInvoiceId= filter (additive): return only vouchers linked
  // to that invoice — either via the header `salesInvoiceId` OR any of the
  // voucher's allocation lines. Used by the sales-invoice Payments tab. When
  // the param is absent the query is unchanged.
  const rawSiId = req.query.salesInvoiceId ? parseInt(req.query.salesInvoiceId as string) : NaN;
  const siFilter: any[] = [];
  // Per-invoice applied amounts (سداد جزئي): lines + partial links carry their
  // own amount; a bare header link counts the FULL voucher amount.
  const appliedByVoucher = new Map<number, number>();
  if (Number.isInteger(rawSiId) && rawSiId > 0) {
    const lineRows = await db
      .select({ voucherId: receiptVoucherLinesTable.voucherId, amount: receiptVoucherLinesTable.amount })
      .from(receiptVoucherLinesTable)
      .where(eq(receiptVoucherLinesTable.salesInvoiceId, rawSiId));
    const linkRows = await db
      .select({ voucherId: settlementLinksTable.sourceId, amount: settlementLinksTable.amount })
      .from(settlementLinksTable)
      .where(and(
        eq(settlementLinksTable.sourceType, "receipt_voucher"),
        eq(settlementLinksTable.salesInvoiceId, rawSiId),
      ));
    for (const r of [...lineRows, ...linkRows]) {
      const k = Number(r.voucherId);
      if (!k) continue;
      appliedByVoucher.set(k, (appliedByVoucher.get(k) ?? 0) + (parseFloat(String(r.amount)) || 0));
    }
    const vIds = [...appliedByVoucher.keys()];
    const linkOr = vIds.length
      ? or(eq(receiptVouchersTable.salesInvoiceId, rawSiId), inArray(receiptVouchersTable.id, vIds))
      : eq(receiptVouchersTable.salesInvoiceId, rawSiId);
    siFilter.push(linkOr);
  }
  const rows = cid
    ? await db.select().from(receiptVouchersTable)
        .where(and(eq(receiptVouchersTable.companyId, cid), ...branchScope, ...siFilter))
        .orderBy(desc(receiptVouchersTable.createdAt))
    : await db.select().from(receiptVouchersTable)
        .where((branchScope.length || siFilter.length) ? and(...branchScope, ...siFilter) : undefined)
        .orderBy(desc(receiptVouchersTable.createdAt));
  // A voucher is MULTI iff it actually has allocation LINES — the header
  // accountId is NOT a reliable discriminator (simple party-mode vouchers
  // also store accountId = null). Expose canonical `isMulti` to the lists.
  const rowIds = rows.map((r) => r.id);
  const multiIds = new Set<number>();
  if (rowIds.length) {
    const lineOwners = await db.select({ voucherId: receiptVoucherLinesTable.voucherId })
      .from(receiptVoucherLinesTable)
      .where(inArray(receiptVoucherLinesTable.voucherId, rowIds));
    for (const lo of lineOwners) if (lo.voucherId != null) multiIds.add(lo.voucherId);
  }
  res.json(rows.map((r) => ({
    ...r,
    isMulti: multiIds.has(r.id),
    // With an invoice filter: the amount actually applied to THAT invoice —
    // partial links/lines carry their own amount; a bare header link means
    // the full voucher amount (legacy behaviour).
    ...(Number.isInteger(rawSiId) && rawSiId > 0 ? {
      appliedForInvoice: (appliedByVoucher.get(r.id) ?? (Number(r.salesInvoiceId) === rawSiId ? (parseFloat(String(r.amount)) || 0) : 0)).toFixed(2),
    } : {}),
  })));
});

// ─── Settlement candidates (سندات قبض غير مرتبطة بأي فاتورة) ────────────────
// Receipt vouchers collected from the INVOICE'S CUSTOMER that are not linked
// to any invoice (neither header nor allocation lines). Surfaced on the sales
// invoice «السداد» tab with an «إضافة» button — mirrors the manual-JE
// settlement-candidates flow. Literal sub-segment BEFORE /:id (Express 5).
router.get("/settlement-candidates", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const invId = Number(req.query.salesInvoiceId);
    if (!Number.isInteger(invId) || invId <= 0) { res.status(400).json({ error: "salesInvoiceId مطلوب" }); return; }
    const [inv] = await db.select({ customerId: salesInvoicesTable.customerId })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, invId), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.customerId == null) { res.json([]); return; }
    const branchScope = multiBranchScopeSpread(req, receiptVouchersTable.branchId, req.query.branchIds ?? req.query.branchId);
    const rows = await db.select().from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.entityId, inv.customerId),
        sql`${receiptVouchersTable.salesInvoiceId} IS NULL`,
        ...branchScope,
      ))
      .orderBy(desc(receiptVouchersTable.id))
      .limit(100);
    if (!rows.length) { res.json([]); return; }
    // سداد جزئي: available = header amount − invoice-linked allocation lines
    // − partial settlement links. Candidates keep showing while any residual
    // remains; `amount` returned is the REMAINING available amount.
    const ids = rows.map((r) => r.id);
    const lineRows = await db.select({
      voucherId: receiptVoucherLinesTable.voucherId,
      sum: sql<string>`SUM(${receiptVoucherLinesTable.amount})`,
    }).from(receiptVoucherLinesTable)
      .where(and(
        inArray(receiptVoucherLinesTable.voucherId, ids),
        sql`${receiptVoucherLinesTable.salesInvoiceId} IS NOT NULL`,
      ))
      .groupBy(receiptVoucherLinesTable.voucherId);
    const linkRows = await db.select({
      sourceId: settlementLinksTable.sourceId,
      sum: sql<string>`SUM(${settlementLinksTable.amount})`,
    }).from(settlementLinksTable)
      .where(and(
        eq(settlementLinksTable.companyId, cid),
        eq(settlementLinksTable.sourceType, "receipt_voucher"),
        inArray(settlementLinksTable.sourceId, ids),
      ))
      .groupBy(settlementLinksTable.sourceId);
    const consumed = new Map<number, number>();
    for (const r of lineRows) consumed.set(Number(r.voucherId), (consumed.get(Number(r.voucherId)) ?? 0) + (parseFloat(String(r.sum)) || 0));
    for (const r of linkRows) consumed.set(Number(r.sourceId), (consumed.get(Number(r.sourceId)) ?? 0) + (parseFloat(String(r.sum)) || 0));
    res.json(rows.map((r) => {
      const total = parseFloat(String(r.amount)) || 0;
      const available = total - (consumed.get(r.id) ?? 0);
      return {
        id: r.id, code: r.code, date: r.date,
        amount: available.toFixed(2), totalAmount: total.toFixed(2),
        exchangeRate: r.exchangeRate, paymentType: r.paymentType,
        status: r.status, description: r.description,
        isMulti: r.accountId == null,
      };
    }).filter((r) => parseFloat(r.amount) > 0.005));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Apply an EXISTING unlinked voucher as invoice settlement ────────────────
// Sets the header salesInvoiceId. A header-linked voucher counts its FULL
// amount toward the invoice (sumVouchersForInvoice rule), so — unlike the JE
// flow — the amount cannot be clamped: it must fit within the remaining due.
// Race-safe: advisory lock + re-check inside the tx (invoice-settlement cap).
router.post("/:id/apply-settlement", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? parseInt(String(req.body.companyId)) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const vid = Number(req.params.id);
    const invId = Number(req.body?.salesInvoiceId);
    if (!Number.isInteger(vid) || vid <= 0) { res.status(400).json({ error: "معرّف السند غير صحيح" }); return; }
    if (!Number.isInteger(invId) || invId <= 0) { res.status(400).json({ error: "salesInvoiceId مطلوب" }); return; }

    // Branch scope — restricted-branch users must not link vouchers/invoices
    // outside their allowed branches (NULL-branch rows remain shared).
    const vBranchScope = multiBranchScopeSpread(req, receiptVouchersTable.branchId, undefined);
    const iBranchScope = multiBranchScopeSpread(req, salesInvoicesTable.branchId, undefined);

    const out = await db.transaction(async (tx) => {
      await acquireSettlementLock(tx, cid, "sales", invId);
      await acquireSourceLock(tx, cid, "receipt_voucher", vid);

      const [v] = await tx.select().from(receiptVouchersTable)
        .where(and(eq(receiptVouchersTable.id, vid), eq(receiptVouchersTable.companyId, cid), ...vBranchScope));
      if (!v) throw Object.assign(new Error("السند غير موجود"), { httpStatus: 404 });
      if (v.salesInvoiceId != null) {
        throw Object.assign(new Error("هذا السند مرتبط بفاتورة من رأس السند بالفعل"), { httpStatus: 409 });
      }
      // Allocation LINES linked to invoices consume part of the voucher —
      // they no longer block; their amounts are subtracted from المتاح below.
      const invLineRows = await tx.select({ amount: receiptVoucherLinesTable.amount })
        .from(receiptVoucherLinesTable)
        .where(and(
          eq(receiptVoucherLinesTable.voucherId, vid),
          sql`${receiptVoucherLinesTable.salesInvoiceId} IS NOT NULL`,
        ));
      const lineConsumedDoc = invLineRows.reduce((s, r) => s + (parseFloat(String(r.amount)) || 0), 0);

      const [inv] = await tx.select({ customerId: salesInvoicesTable.customerId })
        .from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, invId), eq(salesInvoicesTable.companyId, cid), ...iBranchScope));
      if (!inv) throw Object.assign(new Error("الفاتورة غير موجودة"), { httpStatus: 404 });
      if (inv.customerId == null || Number(v.entityId) !== Number(inv.customerId)) {
        throw Object.assign(new Error("السند ليس على عميل هذه الفاتورة"), { httpStatus: 400 });
      }

      const { netDue, paymentType } = await invoiceNetDueBase(cid, "sales", invId);
      if (paymentType !== "credit") {
        throw Object.assign(new Error("لا يمكن سداد إلا فاتورة آجلة — الفواتير النقدية/البنكية تُسدَّد تلقائياً عند الترحيل"), { httpStatus: 400 });
      }
      const vouchers = await sumVouchersForInvoice(cid, "sales", invId);
      const jes = await sumSettlementJEs(cid, "sales", invId);
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
      // lines − partial links already consumed (any invoice).
      const linksConsumedDoc = await sumConsumedFromSource(cid, "receipt_voucher", vid, tx);
      const availableDoc = vAmountDoc - lineConsumedDoc - linksConsumedDoc;
      if (availableDoc <= 0.005) {
        throw Object.assign(new Error("استُهلك مبلغ هذا السند بالكامل في سدادات سابقة — لا يوجد متبقٍّ متاح"), { httpStatus: 409 });
      }
      const availableBase = availableDoc * vRate;

      // Clamp to the remaining due — الباقي من السند يبقى متاحاً لفواتير أخرى.
      const appliedBase = Math.min(availableBase, remainingBase);
      const appliedDoc = vRate > 0 ? appliedBase / vRate : appliedBase;

      await tx.insert(settlementLinksTable).values({
        companyId: cid,
        sourceType: "receipt_voucher",
        sourceId: vid,
        salesInvoiceId: invId,
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
    const vBranchScope = multiBranchScopeSpread(req, receiptVouchersTable.branchId, undefined);
    const [v] = await db.select({ id: receiptVouchersTable.id, sid: receiptVouchersTable.salesInvoiceId })
      .from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.id, vid), eq(receiptVouchersTable.companyId, cid), ...vBranchScope));
    if (!v) { res.status(404).json({ error: "السند غير موجود" }); return; }

    // Partial-link unlink: an explicit linkId removes ONE settlement link row.
    const linkId = req.body?.linkId != null ? Number(req.body.linkId) : null;
    if (linkId != null) {
      if (!Number.isInteger(linkId) || linkId <= 0) { res.status(400).json({ error: "linkId غير صحيح" }); return; }
      const deleted = await db.delete(settlementLinksTable)
        .where(and(
          eq(settlementLinksTable.id, linkId),
          eq(settlementLinksTable.companyId, cid),
          eq(settlementLinksTable.sourceType, "receipt_voucher"),
          eq(settlementLinksTable.sourceId, vid),
        )).returning({ id: settlementLinksTable.id });
      if (!deleted.length) { res.status(404).json({ error: "رابط السداد غير موجود" }); return; }
      res.json({ ok: true });
      return;
    }

    // Fallback: no linkId but an invoice id given → remove ALL partial links
    // between this voucher and that invoice (the UI lists vouchers, not links).
    const invId = req.body?.salesInvoiceId != null ? Number(req.body.salesInvoiceId) : null;
    if (v.sid == null && invId != null && Number.isInteger(invId) && invId > 0) {
      const deleted = await db.delete(settlementLinksTable)
        .where(and(
          eq(settlementLinksTable.companyId, cid),
          eq(settlementLinksTable.sourceType, "receipt_voucher"),
          eq(settlementLinksTable.sourceId, vid),
          eq(settlementLinksTable.salesInvoiceId, invId),
        )).returning({ id: settlementLinksTable.id });
      if (deleted.length) { res.json({ ok: true }); return; }
    }

    if (v.sid == null) { res.status(409).json({ error: "السند غير مرتبط بفاتورة من رأس السند — البنود المرتبطة تُدار من شاشة السند نفسه" }); return; }
    await db.update(receiptVouchersTable)
      .set({ salesInvoiceId: null })
      .where(eq(receiptVouchersTable.id, vid));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  const lines = await db.select().from(receiptVoucherLinesTable)
    .where(eq(receiptVoucherLinesTable.voucherId, row.id))
    .orderBy(asc(receiptVoucherLinesTable.sortOrder), asc(receiptVoucherLinesTable.id));
  res.json({ ...row, lines });
});

// Normalize a raw request `lines[]` payload into typed allocation rows,
// dropping fully-empty rows. Returns null when the caller didn't send a
// `lines` array at all (legacy single-`amount` callers keep working).
// Receipt lines carry NO tax fields.
interface RawRvLine {
  accountId: number | null;
  description: string | null;
  amount: number;
  costCenter: string | null;
  branchId: number | null;
  salesInvoiceId: number | null;
}
function normalizeReceiptLines(raw: any): RawRvLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawRvLine[] = [];
  for (const l of raw) {
    const accountId = l?.accountId ? parseInt(l.accountId) : null;
    const amount = parseFloat(l?.amount ?? "0") || 0;
    if (!accountId && amount === 0) continue; // skip blank row
    out.push({
      accountId,
      description: l?.description ?? null,
      amount,
      costCenter: l?.costCenter ? String(l.costCenter).trim() || null : null,
      branchId: l?.branchId ? parseInt(l.branchId) : null,
      salesInvoiceId: l?.salesInvoiceId ? parseInt(l.salesInvoiceId) : null,
    });
  }
  return out;
}

// Validate normalized lines: every line needs an account + positive amount,
// all account ids must belong to the tenant, and any per-line invoice link
// must resolve to the same tenant/customer.
async function validateReceiptLines(cid: number, lines: RawRvLine[], customerId: number | null): Promise<void> {
  if (lines.length === 0) throw new Error("يجب إضافة بند واحد على الأقل");
  const acctIds = new Set<number>();
  for (const l of lines) {
    if (!l.accountId) throw new Error("كل بند يجب أن يحتوي على حساب محاسبي");
    if (l.amount <= 0) throw new Error("مبلغ البند يجب أن يكون أكبر من صفر");
    acctIds.add(l.accountId);
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
    if (l.salesInvoiceId) await validateSalesInvoiceLink(cid, l.salesInvoiceId, customerId);
  }
}

// Sum a voucher's grand total from its allocation lines (no VAT on receipts).
function receiptLinesTotal(lines: RawRvLine[]): number {
  return lines.reduce((s, l) => s + l.amount, 0);
}

// Persist allocation lines for a voucher, replacing any existing rows.
async function replaceReceiptLines(voucherId: number, lines: RawRvLine[]): Promise<void> {
  await db.delete(receiptVoucherLinesTable).where(eq(receiptVoucherLinesTable.voucherId, voucherId));
  if (lines.length === 0) return;
  await db.insert(receiptVoucherLinesTable).values(lines.map((l, i) => ({
    voucherId,
    accountId: l.accountId,
    description: l.description,
    amount: l.amount.toFixed(2),
    costCenter: l.costCenter,
    branchId: l.branchId,
    salesInvoiceId: l.salesInvoiceId,
    sortOrder: i,
  })));
}

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

// Overpayment guard — BUSINESS RULE (explicit user decision): DRAFT vouchers
// count too. The sum of ALL receipt vouchers linked to a sales invoice
// (draft + posted, header-linked or line-linked) plus the allocation being
// saved must never exceed the invoice's net due (invoice total − linked
// returns). Compared in BASE currency (amount × exchangeRate) so mixed
// currencies stay consistent. `excludeVoucherId` skips the voucher being
// updated (PUT) so its own old amount doesn't block the edit.
async function assertNoSalesOvercollection(
  cid: number,
  voucherRate: number,
  lines: RawRvLine[] | null,
  headerInvoiceId: number | null,
  headerAmount: number | null, // used only when the voucher has no lines
  excludeVoucherId: number | null,
): Promise<void> {
  // Allocation this request adds, in base currency, per linked invoice.
  const add = new Map<number, number>();
  if (lines) {
    for (const l of lines) {
      if (!l.salesInvoiceId) continue;
      add.set(l.salesInvoiceId, (add.get(l.salesInvoiceId) ?? 0) + l.amount * voucherRate);
    }
    // Bypass guard: a header link with NO matching line allocation still
    // settles that invoice — count the whole voucher against it (mirrors how
    // existing header-linked vouchers without line rows are summed below).
    if (headerInvoiceId && !add.has(headerInvoiceId)) {
      const total = lines.reduce((s, l) => s + l.amount, 0);
      if (total > 0) add.set(headerInvoiceId, total * voucherRate);
    }
  } else if (headerInvoiceId && headerAmount && headerAmount > 0) {
    add.set(headerInvoiceId, headerAmount * voucherRate);
  }
  for (const [invId, addBase] of add) {
    const [inv] = await db.select({
      total: salesInvoicesTable.totalAmount,
      rate:  salesInvoicesTable.exchangeRate,
    }).from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, invId), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
    const invBase = (parseFloat(String(inv.total)) || 0) * (parseFloat(String(inv.rate)) || 1);
    const rets = await db.select({
      total: salesReturnsTable.totalAmount,
      rate:  salesReturnsTable.exchangeRate,
    }).from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.invoiceId, invId)));
    const retBase = rets.reduce((s, r) => s + (parseFloat(String(r.total)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
    const netDue = Math.max(0, invBase - retBase);

    // Existing line-linked allocations (multi-form vouchers).
    const lineRows = await db.select({
      voucherId: receiptVoucherLinesTable.voucherId,
      amount:    receiptVoucherLinesTable.amount,
      vRate:     receiptVouchersTable.exchangeRate,
    }).from(receiptVoucherLinesTable)
      .innerJoin(receiptVouchersTable, eq(receiptVoucherLinesTable.voucherId, receiptVouchersTable.id))
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVoucherLinesTable.salesInvoiceId, invId),
      ));
    const lineLinked = new Set(lineRows.map((r) => r.voucherId));
    let existing = 0;
    for (const r of lineRows) {
      if (excludeVoucherId && r.voucherId === excludeVoucherId) continue;
      existing += (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.vRate)) || 1);
    }
    // Plus header-linked vouchers with NO line rows for this invoice
    // (simple-form vouchers); line-carrying vouchers were counted above.
    const headerRows = await db.select({
      id:     receiptVouchersTable.id,
      amount: receiptVouchersTable.amount,
      vRate:  receiptVouchersTable.exchangeRate,
    }).from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.salesInvoiceId, invId)));
    for (const v of headerRows) {
      if (excludeVoucherId && v.id === excludeVoucherId) continue;
      if (lineLinked.has(v.id)) continue;
      existing += (parseFloat(String(v.amount)) || 0) * (parseFloat(String(v.vRate)) || 1);
    }

    // Plus PARTIAL settlement links from other receipt vouchers (سداد جزئي).
    existing += await sumPartialLinksForInvoice(cid, "sales", invId, "receipt_voucher");

    // Plus manual journal entries linked as settlements (draft + posted) —
    // sumSettlementJEs already includes JE-sourced partial links.
    existing += await sumSettlementJEs(cid, "sales", invId);

    const remaining = netDue - existing;
    if (addBase > remaining + 0.01) {
      throw new Error(
        `لا يمكن حفظ السند: إجمالي التحصيل يتجاوز قيمة الفاتورة المرتبطة. المتبقي المسموح ${Math.max(0, remaining).toFixed(2)} فقط (تُحتسب السندات المسودة والقيود المحاسبية المرتبطة ضمن التحصيل)`
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
  const lines = normalizeReceiptLines(d.lines);
  if (lines) {
    try { await validateReceiptLines(cid, lines, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "بنود غير صالحة" }); return; }
  }
  const headerSalesInvoiceId = d.salesInvoiceId ? parseInt(d.salesInvoiceId) : null;
  // Prefer an explicit header link; else adopt the first line's invoice so
  // the list view keeps showing a linked-invoice badge.
  const salesInvoiceId = headerSalesInvoiceId
    ?? (lines?.find((l) => l.salesInvoiceId)?.salesInvoiceId ?? null);
  if (headerSalesInvoiceId) {
    try { await validateSalesInvoiceLink(cid, headerSalesInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }
  // Overcollection guard BEFORE consuming a sequence number (no gap on reject).
  if (salesInvoiceId) {
    try {
      await assertNoSalesOvercollection(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerSalesInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        null,
      );
    } catch (e: any) { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return; }
  }
  const headerAmount = lines ? receiptLinesTotal(lines).toFixed(2) : (d.amount || "0");

  // Auto code — prefer the configured "receipt_voucher" sequence when no
  // explicit code was supplied. If no sequence is configured for this tenant
  // the helper returns null and we fall back to the legacy RV-#### scheme so
  // existing companies keep working with no setup required.
  let code: string;
  if (d.code) {
    code = String(d.code);
  } else {
    const seq = await nextSequenceForPayment(cid, "receipt_voucher", d.paymentType || "cash", {
      branchId: d.branchId ? parseInt(d.branchId) : null,
      userId:   (req as any).authUser?.id ?? null,
      refTable: "receipt_vouchers",
      docDate:  d.date ?? null,
    });
    if (seq) {
      code = seq;
    } else {
      const existing = await db.select({ id: receiptVouchersTable.id })
        .from(receiptVouchersTable).where(eq(receiptVouchersTable.companyId, cid));
      code = `RV-${String(existing.length + 1).padStart(4, "0")}`;
    }
  }

  // Settlement race guard: serialize per-invoice + RE-check the cap under a
  // transaction-scoped advisory lock. The pre-check above handles the common
  // case; this closes the concurrent-saves window (two requests both reading
  // the same "remaining" and jointly exceeding the invoice).
  const [row] = await db.transaction(async (tx) => {
    if (salesInvoiceId) {
      await acquireSettlementLock(tx, cid, "sales", salesInvoiceId);
      await assertNoSalesOvercollection(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerSalesInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        null,
      );
    }
    return tx.insert(receiptVouchersTable).values({
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
    // Multi-line vouchers keep the header override null (lines carry the
    // allocation accounts); legacy single-account callers still honor it.
    accountId:     lines ? null : (d.accountId ? parseInt(d.accountId) : null),
    amount:        headerAmount,
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
  }).catch((e: any) => { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return [null as any]; });
  if (!row) return;
  if (lines) await replaceReceiptLines(row.id, lines);
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
  const lines = normalizeReceiptLines(d.lines);
  if (lines) {
    try { await validateReceiptLines(cid, lines, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "بنود غير صالحة" }); return; }
  }
  const headerSalesInvoiceId = d.salesInvoiceId ? parseInt(d.salesInvoiceId) : null;
  const salesInvoiceId = headerSalesInvoiceId
    ?? (lines?.find((l) => l.salesInvoiceId)?.salesInvoiceId ?? null);
  if (headerSalesInvoiceId) {
    try { await validateSalesInvoiceLink(existing.companyId, headerSalesInvoiceId, entityId); }
    catch (e: any) { res.status(400).json({ error: e?.message || "فاتورة غير صالحة" }); return; }
  }
  // Overcollection guard — exclude THIS voucher's old amounts (being replaced).
  if (salesInvoiceId) {
    try {
      await assertNoSalesOvercollection(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerSalesInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        id,
      );
    } catch (e: any) { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return; }
  }
  // When `lines` is present, header amount is derived from them; a legacy
  // caller (no `lines`) keeps sending its own `amount`.
  const headerAmount = lines ? receiptLinesTotal(lines).toFixed(2) : d.amount;

  // سداد جزئي: partial settlement links already consumed from THIS voucher
  // must still fit under the edited amount (net of new invoice-linked lines).
  {
    const linksConsumed = await sumConsumedFromSource(cid, "receipt_voucher", id);
    if (linksConsumed > 0.005) {
      const newTotal = parseFloat(String(headerAmount ?? "0")) || 0;
      const newLineAlloc = (lines ?? [])
        .filter((l) => l.salesInvoiceId)
        .reduce((s, l) => s + l.amount, 0);
      if (newLineAlloc + linksConsumed > newTotal + 0.005) {
        res.status(400).json({ error: `لا يمكن تخفيض السند: ${linksConsumed.toFixed(2)} منه مستهلك كسداد جزئي لفواتير — فُكّ الارتباط أولاً` });
        return;
      }
    }
  }

  // Settlement race guard — same advisory-lock re-check as on create,
  // excluding THIS voucher's own old amounts.
  const [row] = await db.transaction(async (tx) => {
    if (salesInvoiceId) {
      await acquireSettlementLock(tx, cid, "sales", salesInvoiceId);
      await assertNoSalesOvercollection(
        cid,
        parseFloat(d.exchangeRate || "1") || 1,
        lines,
        headerSalesInvoiceId,
        lines ? null : (parseFloat(d.amount || "0") || 0),
        id,
      );
    }
    return tx.update(receiptVouchersTable).set({
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
    accountId:     lines ? null : (d.accountId ? parseInt(d.accountId) : null),
    amount:        headerAmount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? (salesInvoiceId ? "sales_invoice" : null),
    refNumber:     d.refNumber     ?? null,
    salesInvoiceId,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    costCenter:    d.costCenter ? String(d.costCenter).trim() || null : null,
    }).where(and(eq(receiptVouchersTable.id, id), eq(receiptVouchersTable.companyId, cid))).returning();
  }).catch((e: any) => { res.status(400).json({ error: e?.message || "تجاوز قيمة الفاتورة" }); return [null as any]; });
  if (!row) return;
  // Replace lines only when the caller sent a `lines` array (undefined =
  // legacy update that shouldn't wipe existing allocations).
  if (lines) await replaceReceiptLines(row.id, lines);
  res.json(row);
});

router.post("/:id/post", requirePostRight("receipt"), async (req, res) => {
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

router.post("/:id/unpost", requireUnpostRight("receipt"), async (req, res) => {
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
    // Stash the JE number BEFORE deleting so the next post (after an edit)
    // reuses the SAME journal-entry number instead of burning a fresh one.
    await reserveJeNumberFromEntry(cid, "receipt_voucher", id, existing.journalEntryId);
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
