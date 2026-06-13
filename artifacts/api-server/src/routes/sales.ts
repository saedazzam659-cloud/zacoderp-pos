import { Router } from "express";
import { db } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import {
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  salesQuotationsTable, salesQuotationLinesTable,
  salesOrdersTable, salesOrderLinesTable,
  customerSettlementsTable, stockBalanceTable, stockLedgerTable,
  companiesTable,
  customersTable, cashBoxesTable, bankAccountsTable, warehousesTable,
  journalEntriesTable, journalEntryLinesTable,
  receiptVouchersTable, paymentVouchersTable,
  salesRepsTable, offersTable,
  goodsDeliveriesTable,
  subscriptionsTable,
  itemsTable,
} from "@workspace/db";
import { getDeliveryClearingAccountId } from "./goodsDeliveries.js";
import { eq, and, asc, desc, sql, inArray, isNull, count, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread, branchScopeFilter, multiBranchScopeSpread } from "../middleware/auth.js";
import { resolveTaxRate } from "../lib/companyTaxes.js";
import { pathRbac, requireAdminRole } from "../middleware/permissions.js";
import { upsertBalance, getBalance, addStockLedgerEntry, pickBatches, type BatchPick } from "../lib/stockHelpers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { buildSignedZatcaInvoice } from "../lib/zatca-build-signed.js";
import { salesInvoiceRowToZatcaData } from "../lib/zatca-sales-mapper.js";
import { getZatcaBaseUrl, resolveZatcaEnv, GENESIS_HASH } from "../lib/zatca-env.js";

// ─── Journal entry helper (mirrors purchasing.ts) ────────────────────────────
type JLine = { accountId: number | null; debit?: number; credit?: number; description?: string | null; costCenter?: string | null };
export async function createJournalEntry(opts: {
  companyId: number;
  branchId?: number | null;
  date: string;
  description: string;
  docNumber?: string | null;
  entryType?: string;
  exchangeRate?: string | null;
  // Header-level cost-center code applied to every line that doesn't
  // explicitly set its own. Lets a single field on the source document
  // (sales invoice, sales return, …) tag the entire JE.
  costCenter?: string | null;
  // Audit-trail fields (createdBy/Ip/UA + posted*) injected by callers via
  // `fullAuditFor(req)` so the JE remembers who/where created+posted it.
  audit?: Record<string, unknown>;
  lines: JLine[];
}): Promise<number> {
  const cleanLines = opts.lines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
  if (cleanLines.length < 2) {
    // Build a diagnostic showing which proposed lines were rejected and why,
    // so the operator can fix the underlying mapping/amount issue instead of
    // staring at a generic "needs at least 2 sides" error.
    const rejected = opts.lines.map((l, i) => {
      const reasons: string[] = [];
      if (!l.accountId) reasons.push("حساب غير محدد");
      const dr = l.debit  ?? 0;
      const cr = l.credit ?? 0;
      if (!(dr > 0 || cr > 0)) reasons.push(dr < 0 || cr < 0 ? "مبلغ غير موجب" : "مبلغ صفر");
      if (!reasons.length) return null;
      const label = l.description?.trim() || `سطر ${i + 1}`;
      return `«${label}» (${reasons.join("، ")})`;
    }).filter(Boolean).join("؛ ");
    throw new Error(
      `القيد المحاسبي يحتاج إلى طرفين على الأقل (المقبول: ${cleanLines.length}/${opts.lines.length}). ` +
      `الأسطر المرفوضة: ${rejected || "—"}. ` +
      `الأسباب الشائعة: حسابات الربط غير مضبوطة، أو إجمالي الفاتورة وتكلفة البضاعة كلاهما صفر.`
    );
  }
  const totalDebit  = cleanLines.reduce((s, l) => s + (l.debit  ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
  }
  // Period guard: never let a source document (invoice, return, settlement,
  // etc.) post a journal entry into a soft/hard-closed fiscal period. We
  // tag the thrown Error with `.status = 423` so the route's catch handler
  // surfaces a Locked response (instead of generic 500), letting the UI
  // show its dedicated "لا يمكن الترحيل في فترة مقفلة" message.
  const writability = await assertWritableForDate(opts.companyId, opts.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  // Pre-resolve status so the helper can drop the posted_* trail when the
  // tenant has auto-post OFF — otherwise a draft JE would look "posted"
  // in the audit dialog. Callers pass `audit: { req }` (or an old-style
  // pre-baked object); the latter is preserved verbatim for legacy paths.
  const jeStatus = await resolvePostingStatus(opts.companyId, "sales");
  const auditFields = opts.audit?.req
    ? fullAuditFor(opts.audit.req as any, jeStatus)
    : (opts.audit ?? {});
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: opts.companyId, branchId: opts.branchId ?? null,
    docNumber: opts.docNumber ?? null, entryDate: opts.date,
    currency: "SAR", exchangeRate: opts.exchangeRate ?? "1",
    description: opts.description, entryType: opts.entryType ?? "general",
    status: jeStatus,
    periodId: writability.period?.id ?? null,
    ...auditFields,
  }).returning();
  await db.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId: entry.id, accountId: l.accountId!,
      debit: String((l.debit ?? 0).toFixed(2)),
      credit: String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description, sortOrder: i,
      // Persist cost-center code (text) so cost-center reports pick it up.
      // Per-line override wins; header-level value applies otherwise.
      costCenter: l.costCenter ?? opts.costCenter ?? null,
    }))
  );
  return entry.id;
}

async function getCustomerAccountId(cid: number, customerId: number | null | undefined): Promise<number | null> {
  if (!customerId) return null;
  const [c] = await db.select().from(customersTable)
    .where(and(eq(customersTable.id, customerId), eq(customersTable.companyId, cid)));
  return c?.accountId ?? null;
}
async function getCashBoxAccountId(cid: number, cashBoxId: number | null | undefined): Promise<number | null> {
  if (!cashBoxId) return null;
  const [cb] = await db.select().from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.id, cashBoxId), eq(cashBoxesTable.companyId, cid)));
  return cb?.accountId ?? null;
}
async function getBankAccountAccountId(cid: number, bankAccountId: number | null | undefined): Promise<number | null> {
  if (!bankAccountId) return null;
  const [ba] = await db.select().from(bankAccountsTable)
    .where(and(eq(bankAccountsTable.id, bankAccountId), eq(bankAccountsTable.companyId, cid)));
  return ba?.accountId ?? null;
}

/**
 * Resolve the rep's commission% (snapshot) and compute commissionAmount = totalAmount × pct/100.
 * Returns string "0" for the numeric fields (NEVER null — schema is NOT NULL with default "0").
 * Returns salesRepId=null when no rep / inactive rep / wrong company; in that case both numerics
 * are "0". For commissionType="collection" the snapshot pct is preserved but invoice-time
 * commissionAmount is "0" (collection commission is computed at receipt time from receipts).
 */
// Look up the rep linked to a given user (per company). Returns null when no
// rep is linked. Used to auto-attribute invoices to the logged-in salesperson
// when the form didn't pass an explicit salesRepId — see resolveRepCommission.
async function repIdForUser(cid: number, userId: number | null | undefined): Promise<number | null> {
  if (!userId) return null;
  const [rep] = await db.select({ id: salesRepsTable.id })
    .from(salesRepsTable)
    .where(and(
      eq(salesRepsTable.companyId, cid),
      eq(salesRepsTable.userId, Number(userId)),
      eq(salesRepsTable.isActive, true),
    ));
  return rep?.id ?? null;
}

async function resolveRepCommission(
  cid: number,
  salesRepId: number | string | null | undefined,
  totalAmount: number | string | null | undefined,
): Promise<{ salesRepId: number | null; commissionPct: string; commissionAmount: string }> {
  const rid = salesRepId ? Number(salesRepId) : null;
  if (!rid) return { salesRepId: null, commissionPct: "0", commissionAmount: "0" };
  const [rep] = await db.select().from(salesRepsTable)
    .where(and(eq(salesRepsTable.id, rid), eq(salesRepsTable.companyId, cid)));
  // Drop attribution silently on missing/inactive rep — keeps numeric fields safe and
  // prevents "ghost" commissions from disabled reps.
  if (!rep || !rep.isActive) return { salesRepId: null, commissionPct: "0", commissionAmount: "0" };
  const pct = Number(rep.commissionPct ?? 0);
  if (rep.commissionType === "collection" || !pct) {
    return { salesRepId: rep.id, commissionPct: String(pct), commissionAmount: "0" };
  }
  const total = Number(totalAmount ?? 0);
  const commission = (total * pct) / 100;
  return {
    salesRepId: rep.id,
    commissionPct: String(pct),
    commissionAmount: commission.toFixed(2),
  };
}

/** Map a list of warehouse IDs (used by an invoice) to their {accountId, allowNegative, name}. */
async function loadWarehouseInfo(cid: number, ids: number[]): Promise<Record<number, { accountId: number | null; allowNegative: boolean; nameAr: string | null }>> {
  const out: Record<number, any> = {};
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  for (const wid of uniq) {
    const [w] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, wid), eq(warehousesTable.companyId, cid)));
    out[wid] = { accountId: w?.accountId ?? null, allowNegative: !!w?.allowNegative, nameAr: w?.nameAr ?? null };
  }
  return out;
}

const router = Router();
router.use(extractAuth);
router.use(pathRbac([
  ["/sales-invoices",        "sales_invoices"],
  ["/sales-returns",         "sales_returns"],
  ["/sales-quotations",      "sales_quotations"],
  // Sales orders piggy-back on the sales_invoices permission key — no
  // dedicated module key needed and existing roles work without migration.
  ["/sales-orders",          "sales_invoices"],
  ["/customer-settlements",  "sales_invoices"],
]));

// Strict boolean parser for API boundary — accepts true|false (and "true"/"false") only.
// Anything else becomes false (the safe default for priceIncludesVat).
function asBool(v: any): boolean {
  if (v === true || v === "true") return true;
  if (v === false || v === "false" || v == null) return false;
  return false;
}

// Clamp document-level discount server-side: must be >= 0 and <= subtotal+vat.
// Also recompute totalAmount as gross - discount so the stored row is internally consistent.
function clampDiscountAndTotal(subtotal: any, vatAmount: any, discountAmount: any) {
  const sub  = Math.max(0, Number(subtotal)    || 0);
  const vat  = Math.max(0, Number(vatAmount)   || 0);
  const gross = sub + vat;
  const disc = Math.max(0, Math.min(gross, Number(discountAmount) || 0));
  const total = gross - disc;
  return {
    subtotal:       sub.toFixed(2),
    vatAmount:      vat.toFixed(2),
    discountAmount: disc.toFixed(2),
    totalAmount:    total.toFixed(2),
  };
}

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// Cleanup any orphan stock movements / vouchers / journal entries tied to a draft document
// (defensive: a draft normally has none, but past bugs may have left orphans behind).
async function cleanupDocArtifacts(opts: {
  companyId: number;
  refType: string;       // "sales_invoice" | "sales_return" | "purchase_invoice" | "purchase_return"
  refId: number;
  journalEntryId?: number | null;
}) {
  const { companyId: cid, refType, refId, journalEntryId } = opts;

  // 1) Reverse stock_balance for any orphan ledger entries, then delete them
  const ledger = await db.select().from(stockLedgerTable).where(and(
    eq(stockLedgerTable.companyId, cid),
    eq(stockLedgerTable.refType, refType),
    eq(stockLedgerTable.refId,   refId),
  ));
  for (const row of ledger) {
    const qty = Number(row.qty);
    const [bal] = await db.select().from(stockBalanceTable).where(and(
      eq(stockBalanceTable.companyId,   cid),
      eq(stockBalanceTable.itemId,      row.itemId),
      eq(stockBalanceTable.warehouseId, row.warehouseId),
    ));
    if (bal) {
      await db.update(stockBalanceTable)
        .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
        .where(eq(stockBalanceTable.id, bal.id));
    }
  }
  if (ledger.length) {
    await db.delete(stockLedgerTable).where(and(
      eq(stockLedgerTable.companyId, cid),
      eq(stockLedgerTable.refType, refType),
      eq(stockLedgerTable.refId,   refId),
    ));
  }

  // 2) Delete any cash/bank vouchers tied to this document
  // Vouchers reference docs via refType + refNumber (text); the post handler
  // sets refNumber to inv.docNumber || String(inv.id), so try both.
  const refNum = (opts as any).refNumber as string | null | undefined;
  const candidates = [String(refId), refNum].filter(Boolean) as string[];
  for (const rn of candidates) {
    await db.delete(receiptVouchersTable).where(and(
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.refType, refType),
      eq(receiptVouchersTable.refNumber, rn),
    ));
    await db.delete(paymentVouchersTable).where(and(
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.refType, refType),
      eq(paymentVouchersTable.refNumber, rn),
    ));
  }

  // 3) Delete any journal entry tied to this document
  if (journalEntryId) {
    await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, journalEntryId));
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
}

async function getAvgCost(companyId: number, itemId: number, warehouseId: number): Promise<number> {
  const [bal] = await db.select().from(stockBalanceTable).where(and(
    eq(stockBalanceTable.companyId, companyId),
    eq(stockBalanceTable.itemId, itemId),
    eq(stockBalanceTable.warehouseId, warehouseId),
  ));
  return Number(bal?.avgCost ?? 0);
}

// ═══════════════════════════════════════════════
// SALES INVOICES
// ═══════════════════════════════════════════════
router.get("/sales-invoices", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    // Source filter — separates POS-originated invoices from manually-entered ones.
    // Default `manual` hides POS rows so the Sales Invoices screen stays clean
    // (POS invoices live under POS Operations). Pass `?source=all` to see both
    // or `?source=pos` to filter to POS only.
    const source = String(req.query.source ?? "manual").toLowerCase();
    const sourceFilter =
      source === "pos"    ? [sql`${salesInvoicesTable.posSessionId} IS NOT NULL`] :
      source === "manual" ? [sql`${salesInvoicesTable.posSessionId} IS NULL`] :
      [];
    const rows = await db.select().from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        ...sourceFilter,
        // Accept multi-branch filter (?branchIds=1,2,3 or repeated
        // ?branchIds=1&branchIds=2) for managers with view-all-branches.
        // Falls back to legacy single ?branchId when branchIds is absent.
        ...multiBranchScopeSpread(
          req,
          salesInvoicesTable.branchId,
          req.query.branchIds ?? req.query.branchId,
        ),
      ))
      .orderBy(desc(salesInvoicesTable.invoiceDate));

    // Resolve usernames for createdById / postedById in one pass so the grid
    // can render "أنشأه" / "رحّله" columns without an extra round trip.
    const { usersTable } = await import("@workspace/db");
    const { inArray: _inArr } = await import("drizzle-orm");
    const auditUserIds = Array.from(new Set(
      rows.flatMap(r => [r.createdById, r.postedById])
        .filter((x): x is number => typeof x === "number")
    ));
    const auditUserMap = new Map<number, string>();
    if (auditUserIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(_inArr(usersTable.id, auditUserIds));
      for (const u of us) auditUserMap.set(u.id, u.username);
    }
    const enrichedRows = rows.map(r => ({
      ...r,
      createdByName: r.createdById != null ? (auditUserMap.get(r.createdById) ?? null) : null,
      postedByName:  r.postedById  != null ? (auditUserMap.get(r.postedById)  ?? null) : null,
    }));

    // Enrich each invoice with its latest linked receipt voucher so the
    // listing can show a "paid via cash/bank" badge in the side row. We
    // pull all linked vouchers for this tenant in a single query and
    // group in memory — cheap, and avoids N+1 even for large tenants.
    const ids = enrichedRows.map(r => r.id);
    if (ids.length === 0) { res.json(enrichedRows); return; }
    const { receiptVouchersTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const links = await db.select({
      voucherId:     receiptVouchersTable.id,
      code:          receiptVouchersTable.code,
      paymentType:   receiptVouchersTable.paymentType,
      amount:        receiptVouchersTable.amount,
      status:        receiptVouchersTable.status,
      date:          receiptVouchersTable.date,
      salesInvoiceId: receiptVouchersTable.salesInvoiceId,
    }).from(receiptVouchersTable).where(and(
      eq(receiptVouchersTable.companyId, cid),
      inArray(receiptVouchersTable.salesInvoiceId, ids),
      // Only POSTED vouchers turn an invoice into "paid". Drafts stay
      // invisible in the listing badge — otherwise we would mislead the
      // user that an invoice is settled when in reality the voucher is
      // still being edited.
      eq(receiptVouchersTable.status, "posted"),
    ));
    // Group by invoice; deterministic tiebreaker: latest date, then
    // highest voucherId, so the badge never flickers between rows that
    // share the same date.
    const byInvoice = new Map<number, typeof links>();
    for (const l of links) {
      if (!l.salesInvoiceId) continue;
      const arr = byInvoice.get(l.salesInvoiceId) ?? [];
      arr.push(l);
      byInvoice.set(l.salesInvoiceId, arr);
    }
    // Lightweight per-invoice warehouseIds set — used by the audit grid's
    // warehouse filter so we don't ship every line over the wire. Single
    // grouped query keeps this O(N+M) instead of N+1.
    const lineWh = await db.select({
      invoiceId:   salesInvoiceLinesTable.invoiceId,
      warehouseId: salesInvoiceLinesTable.warehouseId,
    }).from(salesInvoiceLinesTable).where(inArray(salesInvoiceLinesTable.invoiceId, ids));
    const whByInvoice = new Map<number, Set<number>>();
    for (const lw of lineWh) {
      if (!lw.invoiceId || lw.warehouseId == null) continue;
      const s = whByInvoice.get(lw.invoiceId) ?? new Set<number>();
      s.add(Number(lw.warehouseId));
      whByInvoice.set(lw.invoiceId, s);
    }
    const enriched = enrichedRows.map(r => {
      const arr = byInvoice.get(r.id) ?? [];
      const sorted = [...arr].sort((a, b) => {
        const dateCmp = String(b.date).localeCompare(String(a.date));
        if (dateCmp !== 0) return dateCmp;
        return b.voucherId - a.voucherId;
      });
      const top = sorted[0];
      return {
        ...r,
        warehouseIds: Array.from(whByInvoice.get(r.id) ?? []),
        paymentSettlement: top ? {
          voucherId:   top.voucherId,
          code:        top.code,
          paymentType: top.paymentType,
          amount:      top.amount,
          status:      top.status,
          date:        top.date,
        } : null,
      };
    });
    res.json(enriched);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// GET /sales-invoices/quota — surfaces "X of Y this month" so the user
// knows where they stand BEFORE creating a new invoice. Frontend
// invalidates this on `subscription_changed` SSE.
// IMPORTANT: must be registered BEFORE `/sales-invoices/:id`, otherwise
// Express matches "quota" as the :id param and the handler is never hit.
// `getInvoiceQuota` is a hoisted function declaration defined later in
// this file, which is why the forward reference here is safe.
router.get("/sales-invoices/quota", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const q = await getInvoiceQuota(cid);
  res.json(q);
});

router.get("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    // Branch-level isolation: prevent IDOR-within-tenant. A restricted user
    // (viewAllBranches=false) must not be able to fetch a single invoice
    // belonging to a branch they aren't linked to, even if they discover
    // the id externally. Shared rows (branch_id IS NULL) remain visible.
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.id, id),
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
      ));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id))
      .orderBy(asc(salesInvoiceLinesTable.id));
    // Surface offer names alongside the FK ids so the form can render the
    // "applied offer" badges immediately on edit, without an extra round-trip.
    const offerIds = new Set<number>();
    if (inv.documentOfferId) offerIds.add(inv.documentOfferId);
    for (const l of lines) if (l.appliedOfferId) offerIds.add(l.appliedOfferId);
    const offerRows = offerIds.size
      ? await db.select({ id: offersTable.id, nameAr: offersTable.nameAr, offerNumber: offersTable.offerNumber })
          .from(offersTable)
          // Tenant-scoped — never resolve names for offers that don't belong
          // to this company, even if the FK somehow points cross-tenant.
          .where(and(inArray(offersTable.id, [...offerIds]), eq(offersTable.companyId, cid)))
      : [];
    const offerNameById = new Map(offerRows.map(o => [o.id, o.nameAr ?? o.offerNumber] as const));
    const linesWithOfferName = lines.map(l => ({
      ...l,
      appliedOfferName: l.appliedOfferId ? (offerNameById.get(l.appliedOfferId) ?? null) : null,
    }));
    // Resolve `createdByName` / `postedByName` so the print templates (and
    // the read-only view) can show "أنشأ بواسطة" + "رحّل بواسطة" without
    // requiring an extra users round-trip from the client.
    const { usersTable } = await import("@workspace/db");
    const auditIds = Array.from(new Set(
      [inv.createdById, inv.postedById].filter((x): x is number => typeof x === "number")
    ));
    const auditMap = new Map<number, string>();
    if (auditIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, auditIds));
      for (const u of us) auditMap.set(u.id, u.username);
    }
    res.json({
      ...inv,
      documentOfferName: inv.documentOfferId ? (offerNameById.get(inv.documentOfferId) ?? null) : null,
      createdByName: inv.createdById != null ? (auditMap.get(inv.createdById) ?? null) : null,
      postedByName:  inv.postedById  != null ? (auditMap.get(inv.postedById)  ?? null) : null,
      lines: linesWithOfferName,
    });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Sum of already-returned quantity (in base units) per itemId across ALL
// existing sales returns linked to this invoice. Used by the sales-return
// item picker to compute the remaining cap per line so the UI can show
// (and enforce) "remaining = sold − previously returned" before the user
// hits Save. ?excludeReturnId=N excludes a return being edited so its own
// lines don't subtract from their own cap.
router.get("/sales-invoices/:id/returned-by-item", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const invId = Number(req.params.id);
    const excludeReturnId = req.query.excludeReturnId != null
      ? Number(req.query.excludeReturnId) : null;
    const where = [
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.invoiceId, invId),
      ...(excludeReturnId ? [sql`${salesReturnsTable.id} <> ${excludeReturnId}`] : []),
    ];
    const retIds = await db.select({ id: salesReturnsTable.id })
      .from(salesReturnsTable).where(and(...where));
    const ids = retIds.map((r: any) => r.id);
    const byItem: Record<string, number> = {};
    if (ids.length) {
      const rows = await db.select({
        itemId: salesReturnLinesTable.itemId,
        qty: salesReturnLinesTable.qty,
        conversionFactor: salesReturnLinesTable.conversionFactor,
      }).from(salesReturnLinesTable).where(inArray(salesReturnLinesTable.returnId, ids));
      for (const r of rows) {
        if (r.itemId == null) continue;
        const base = Number(r.qty || 0) * Number(r.conversionFactor || 1);
        const k = String(r.itemId);
        byItem[k] = (byItem[k] || 0) + base;
      }
    }
    res.json({ invoiceId: invId, byItem });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

function mapInvoiceLine(l: any, invoiceId: number, cid: number, fallbackRate = "15") {
  return {
    invoiceId, companyId: cid,
    itemId:      l.itemId      ? Number(l.itemId)      : null,
    itemName:    l.itemName,
    itemCode:    l.itemCode    || null,
    unit:        l.unit        || null,
    unitId:      l.unitId      ? Number(l.unitId)      : null,
    conversionFactor: String(l.conversionFactor || "1"),
    warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
    qty:         String(l.qty       || "1"),
    freeQty:     String(l.freeQty   || "0"),
    unitPrice:   String(l.unitPrice || "0"),
    discount:    String(l.discount  || "0"),
    discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
    vatRate:     String(l.vatRate   || fallbackRate),
    lineTotal:   String(l.lineTotal || "0"),
    notes:       l.notes || null,
    // Audit trail link to the line-level promotion that produced this
    // discount / unit-price (line_pricing or buy_x_get_y). NULL when the
    // discount was manual or no offer matched.
    appliedOfferId: l.appliedOfferId ? Number(l.appliedOfferId) : null,
  };
}

// Bumps the `times_used` counter for every distinct offer id given. Safe to
// call with an empty array. Tenant-scoped so a malicious client can't bump
// counters on another company's offers by sending its ids.
async function bumpOffersTimesUsed(cid: number, offerIds: number[]) {
  if (!offerIds.length) return;
  await db.update(offersTable)
    .set({ timesUsed: sql`${offersTable.timesUsed} + 1` })
    .where(and(inArray(offersTable.id, offerIds), eq(offersTable.companyId, cid)));
}

// Throws if any of the given offer ids don't belong to `cid`. Used on the
// invoice POST/PUT path so a crafted client payload can't pin a foreign
// company's offer onto our invoice (which would corrupt the audit trail
// and leak that offer's name back through the invoice GET join).
async function validateOffersBelongToCompany(cid: number, offerIds: number[]) {
  if (!offerIds.length) return;
  const found = await db.select({ id: offersTable.id })
    .from(offersTable)
    .where(and(inArray(offersTable.id, offerIds), eq(offersTable.companyId, cid)));
  const foundSet = new Set(found.map(r => r.id));
  for (const oid of offerIds) {
    if (!foundSet.has(oid)) {
      throw new Error(`العرض رقم ${oid} غير موجود ضمن هذه الشركة`);
    }
  }
}

// Collects every distinct offer id referenced by an invoice payload (line
// `appliedOfferId`s + header `documentOfferId`). Returns an empty array if
// nothing is referenced.
function collectInvoiceOfferIds(documentOfferId: any, lines: any[] | undefined): number[] {
  const ids = new Set<number>();
  for (const l of (lines ?? [])) {
    if (l?.appliedOfferId) ids.add(Number(l.appliedOfferId));
  }
  if (documentOfferId) ids.add(Number(documentOfferId));
  return [...ids];
}

// ─── Plan-based monthly invoice quota ────────────────────────────
// Counts sales invoices created in the current calendar month against
// the company's max_invoices subscription cap. No caching so SuperAdmin
// plan edits apply on the very next request.
async function getInvoiceQuota(companyId: number): Promise<{ limit: number; used: number; remaining: number; hasSubscription: boolean; periodStart: string; periodEnd: string }> {
  const [sub] = await db
    .select({ maxInvoices: subscriptionsTable.maxInvoices })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, companyId))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id))
    .limit(1);
  const limit = sub?.maxInvoices ?? 1_000_000;
  // Month boundaries in Asia/Riyadh local time (UTC+3, no DST). Using
  // UTC here would shift the cutoff by 3 hours and falsely roll the
  // month over for invoices issued late at night in KSA.
  const nowKsa = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const yyyy = nowKsa.getUTCFullYear();
  const mm = String(nowKsa.getUTCMonth() + 1).padStart(2, "0");
  const periodStart = `${yyyy}-${mm}-01`;
  const lastDay = new Date(Date.UTC(yyyy, nowKsa.getUTCMonth() + 1, 0)).getUTCDate();
  const periodEnd = `${yyyy}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const [{ n }] = await db
    .select({ n: count() })
    .from(salesInvoicesTable)
    .where(and(
      eq(salesInvoicesTable.companyId, companyId),
      gte(salesInvoicesTable.invoiceDate, periodStart),
      lte(salesInvoicesTable.invoiceDate, periodEnd),
    ));
  const used = Number(n ?? 0);
  return { limit, used, remaining: Math.max(0, limit - used), hasSubscription: !!sub, periodStart, periodEnd };
}

router.post("/sales-invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    // Plan-based monthly cap. Re-checked on every POST so SuperAdmin
    // upgrades take effect immediately. Returns the limit + used count
    // so the frontend can render an actionable message.
    const invQuota = await getInvoiceQuota(cid);
    if (invQuota.used >= invQuota.limit) {
      res.status(403).json({
        error: `وصلت إلى الحد الأقصى للفواتير الشهرية المسموح به في خطتك (${invQuota.limit} فاتورة/شهر). يرجى ترقية الخطة لإضافة المزيد.`,
        code: "INVOICE_LIMIT_REACHED",
        limit: invQuota.limit,
        used: invQuota.used,
      });
      return;
    }
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
            posSessionId, salesRepId, documentOfferId, sourceQuotationId, costCenter, taxId } = req.body;
    // If the user picked an existing quotation as the source via the
    // "بناءً على عرض سعر" combobox on the new-invoice form, validate it
    // BEFORE we INSERT the invoice (rules mirror the /convert endpoint
    // exactly so the two paths can never diverge):
    //   1. Quotation must belong to this tenant.
    //   2. Status must be 'accepted' — drafts/sent quotations cannot be
    //      invoiced; rejected/converted ones obviously can't either.
    //   3. Must not already be converted (one quotation → one invoice).
    let validatedSourceQuotation: { id: number; docNumber: string | null } | null = null;
    if (sourceQuotationId) {
      const sqId = Number(sourceQuotationId);
      const [sq] = await db.select({
        id: salesQuotationsTable.id,
        docNumber: salesQuotationsTable.docNumber,
        status: salesQuotationsTable.status,
        convertedInvoiceId: salesQuotationsTable.convertedInvoiceId,
      }).from(salesQuotationsTable)
        .where(and(eq(salesQuotationsTable.id, sqId), eq(salesQuotationsTable.companyId, cid)));
      if (!sq) { res.status(404).json({ error: "عرض السعر غير موجود" }); return; }
      if (sq.convertedInvoiceId) { res.status(400).json({ error: "تم تحويل عرض السعر مسبقاً إلى فاتورة" }); return; }
      if (sq.status !== "accepted") { res.status(400).json({ error: "يجب قبول عرض السعر قبل التحويل لفاتورة" }); return; }
      validatedSourceQuotation = { id: sq.id, docNumber: sq.docNumber };
    }
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    // Required-fields gate (per company policy): every sales invoice must
    // have an explicit customer + branch. Server-side enforcement here is
    // the safety net — the form prevalidates too. Returning 400 with the
    // field key lets the client highlight the offending input.
    //
    // POS exemption: walk-in customers are a first-class POS feature, so
    // when the request carries a posSessionId we skip the customer-required
    // rule. Branch is ALWAYS required (POS auto-fills it from the session).
    if (!posSessionId && !customerId) { res.status(400).json({ error: "يجب اختيار العميل قبل حفظ الفاتورة", field: "customerId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ الفاتورة",  field: "branchId"   }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    // ── Overdue-payment guard ──
    // When the customer has `paymentTermsDays > 0`, refuse a new CREDIT invoice
    // if any prior posted credit invoice of theirs still has an outstanding
    // balance AND is older than the term (counted from the new invoice date).
    // FIFO-applies posted receipts + posted credit returns to oldest invoices
    // first, then checks the oldest remaining one. Cash invoices and customers
    // without payment terms bypass the guard entirely.
    if (pType === "credit" && customerId) {
      const [cust] = await db.select({
        nameAr: customersTable.nameAr,
        paymentTermsDays: customersTable.paymentTermsDays,
      }).from(customersTable)
        .where(and(eq(customersTable.id, Number(customerId)), eq(customersTable.companyId, cid)));
      const terms = Number(cust?.paymentTermsDays ?? 0);
      if (cust && terms > 0) {
        const priorInvs = await db.select({
          date:  salesInvoicesTable.invoiceDate,
          total: salesInvoicesTable.totalAmount,
        }).from(salesInvoicesTable)
          .where(and(
            eq(salesInvoicesTable.companyId, cid),
            eq(salesInvoicesTable.customerId, Number(customerId)),
            eq(salesInvoicesTable.status, "posted"),
            eq(salesInvoicesTable.paymentType, "credit"),
          ))
          .orderBy(asc(salesInvoicesTable.invoiceDate), asc(salesInvoicesTable.id));
        const [retSum] = await db.select({
          s: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)`,
        }).from(salesReturnsTable).where(and(
          eq(salesReturnsTable.companyId, cid),
          eq(salesReturnsTable.customerId, Number(customerId)),
          eq(salesReturnsTable.status, "posted"),
          eq(salesReturnsTable.paymentType, "credit"),
        ));
        const [recSum] = await db.select({
          s: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
        }).from(receiptVouchersTable).where(and(
          eq(receiptVouchersTable.companyId, cid),
          eq(receiptVouchersTable.entityType, "customer"),
          eq(receiptVouchersTable.entityId, Number(customerId)),
          eq(receiptVouchersTable.status, "posted"),
        ));
        let credit = Number(retSum?.s ?? 0) + Number(recSum?.s ?? 0);
        const refMs = new Date(invoiceDate).getTime();
        for (const inv of priorInvs) {
          let remaining = Number(inv.total);
          if (credit >= remaining) { credit -= remaining; continue; }
          remaining -= credit; credit = 0;
          const days = Math.floor((refMs - new Date(inv.date).getTime()) / 86400000);
          if (days > terms) {
            res.status(409).json({
              error:
                `لا يمكن إصدار فاتورة جديدة للعميل "${cust.nameAr}" — يوجد فاتورة سابقة بتاريخ ${inv.date} ` +
                `بمبلغ مستحق ${remaining.toFixed(2)} ر.س لم تُسدَّد خلال مدة الاستحقاق (${terms} يوم — تأخر ${days} يوماً). ` +
                `الرجاء سرعة السداد لاستكمال عمليات البيع.`,
              code: "OVERDUE_PAYMENT",
              overdueDays: days,
              paymentTermsDays: terms,
              outstandingAmount: Number(remaining.toFixed(2)),
              oldestUnpaidInvoiceDate: inv.date,
            });
            return;
          }
          break; // oldest unpaid is within terms → all newer ones are too
        }
      }
    }
    // Reject the request before INSERT if any offer id (line-level or
    // document-level) doesn't belong to this tenant. Prevents cross-tenant
    // FK pollution and the resulting offer-name leak via the GET join.
    await validateOffersBelongToCompany(cid, collectInvoiceOfferIds(documentOfferId, lines));
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    // Snapshot the rep's commission % at save time so historical invoices keep
    // their commission even if the rep's % changes later.
    // ─── Auto-attribution ───
    // If the form didn't pass an explicit salesRepId, fall back to the rep
    // linked to the currently-logged-in user (sales_reps.user_id). This is
    // the whole point of the user↔rep link: the salesperson logs in, opens a
    // new invoice, and their commission is automatically tagged without any
    // manual selection. Admin/superadmin can still override by passing
    // salesRepId explicitly in the body.
    const effectiveRepId = salesRepId ?? await repIdForUser(cid, req.authUser?.id);
    const repInfo = await resolveRepCommission(cid, effectiveRepId, totals.totalAmount);

    // The central sequence engine is authoritative whenever an active
    // sequence exists for "sales_invoice" — we always allocate server-side
    // (atomic, FOR UPDATE) and ignore any client-supplied number so two
    // simultaneous submissions can never persist the same docNumber. When
    // no active sequence is configured, we fall back to the client-supplied
    // value or null (legacy free-numbering behaviour).
    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "sales_invoice", {
        userId:   req.authUser?.id ?? null,
        refTable: "sales_invoices",
        branchId: branchId ? Number(branchId) : null,
        docDate:  invoiceDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الفاتورة" });
      return;
    }

    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      status: "draft", notes: notes || null,
      posSessionId: null, // set below after validation
      // Manual session (admin-created) the user is currently working under,
      // resolved by extractAuth from the trusted x-session-id header. Null when
      // the user is operating without a manual session.
      sessionId: (req as any).manualSessionId ?? null,
      createdById:  req.authUser?.id ?? null,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      salesRepId:         repInfo.salesRepId,
      commissionPct:      repInfo.commissionPct,
      commissionAmount:   repInfo.commissionAmount,
      documentOfferId:    documentOfferId ? Number(documentOfferId) : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      taxId:              taxId ? Number(taxId) : null,
    }).returning();
    // Validate posSessionId belongs to the same company before linking — prevents cross-tenant pollution.
    if (posSessionId) {
      const sid = Number(posSessionId);
      const { posSessionsTable } = await import("@workspace/db");
      const [s] = await db.select({ id: posSessionsTable.id, companyId: posSessionsTable.companyId, status: posSessionsTable.status })
        .from(posSessionsTable).where(eq(posSessionsTable.id, sid));
      if (s && s.companyId === cid && s.status === "open") {
        await db.update(salesInvoicesTable).set({ posSessionId: sid })
          .where(eq(salesInvoicesTable.id, inv.id));
        inv.posSessionId = sid;
      }
    }
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(salesInvoiceLinesTable).values(lines.map((l: any) => mapInvoiceLine(l, inv.id, cid, resolvedRate)));
    }
    // Bump times_used once per distinct offer that influenced this invoice
    // (line-level + the doc-level header offer). Counter increments only
    // when an invoice is actually saved — never just by the matcher firing.
    {
      const usedOfferIds = new Set<number>();
      for (const l of (lines ?? [])) {
        if (l?.appliedOfferId) usedOfferIds.add(Number(l.appliedOfferId));
      }
      if (documentOfferId) usedOfferIds.add(Number(documentOfferId));
      await bumpOffersTimesUsed(cid, [...usedOfferIds]);
    }
    // Mirror the /convert path: once the invoice is created from an
    // accepted quotation, mark the quotation as converted and back-link
    // it. The pre-insert validation can race — two clients hitting this
    // endpoint with the same `sourceQuotationId` simultaneously would
    // both pass the SELECT check and both create invoices. The atomic
    // gate is the conditional UPDATE below: only ONE row can move from
    // {status:'accepted', convertedInvoiceId:null} → {status:'converted',
    // convertedInvoiceId:inv.id}; the loser sees `updateResult.length === 0`
    // and we compensate by deleting the invoice we just created (FK
    // cascade nukes invoice lines automatically — confdeltype='c').
    if (validatedSourceQuotation) {
      const updated = await db.update(salesQuotationsTable)
        .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
        .where(and(
          eq(salesQuotationsTable.id, validatedSourceQuotation.id),
          eq(salesQuotationsTable.companyId, cid),
          eq(salesQuotationsTable.status, "accepted"),
          isNull(salesQuotationsTable.convertedInvoiceId),
        ))
        .returning({ id: salesQuotationsTable.id });
      if (updated.length === 0) {
        await db.delete(salesInvoicesTable).where(and(
          eq(salesInvoicesTable.id, inv.id),
          eq(salesInvoicesTable.companyId, cid),
        ));
        res.status(409).json({ error: "تم تحويل عرض السعر بواسطة مستخدم آخر — أعد المحاولة" });
        return;
      }
    }
    res.status(201).json(inv);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // POSTED-DOC LOCK: a sales invoice that has been posted (status='posted')
    // is immutable from the edit screen. The user must explicitly call the
    // unpost endpoint (admin-only) before any further changes are accepted.
    // This is the server-side gate; the UI also disables the form.
    const [existing] = await db.select({ status: salesInvoicesTable.status })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (existing.status === "posted") {
      res.status(409).json({ error: "لا يمكن تعديل فاتورة مُرحَّلة. قم بفك الترحيل أولاً." });
      return;
    }
    // docNumber is intentionally not destructured here — it is immutable on
    // edit (see the .set() below).
    const { invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
            documentOfferId, costCenter, taxId } = req.body;
    // Same required-fields gate as the POST path so a direct PUT (e.g.
    // from a script or a stale draft that pre-dates the policy) cannot
    // strip the customer/branch off an existing invoice on edit.
    if (!customerId) { res.status(400).json({ error: "يجب اختيار العميل قبل حفظ الفاتورة", field: "customerId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ الفاتورة",  field: "branchId"   }); return; }
    // Snapshot offer ids that were already attached to this invoice BEFORE
    // we delete-and-reinsert lines, so we can bump times_used for the offers
    // that are NEW on this update (and not double-count the ones already
    // there). Computed before the update so we don't lose them when the
    // line-level FKs are cascaded away.
    const prevLineOffers = await db.select({ aoid: salesInvoiceLinesTable.appliedOfferId })
      .from(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
    const [prevInvRow] = await db.select({ doid: salesInvoicesTable.documentOfferId })
      .from(salesInvoicesTable).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    const prevOfferIds = new Set<number>();
    for (const r of prevLineOffers) if (r.aoid) prevOfferIds.add(r.aoid);
    if (prevInvRow?.doid) prevOfferIds.add(prevInvRow.doid);
    // Same tenant guard as POST — incoming payload can't reference a foreign
    // company's offer.
    await validateOffersBelongToCompany(cid, collectInvoiceOfferIds(documentOfferId, lines));
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    // Only re-snapshot commission when the caller explicitly sent salesRepId
    // (so existing forms that don't know about reps don't wipe historical data).
    const hasRepKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "salesRepId");
    const repPatch = hasRepKey
      ? await (async () => {
          const r = await resolveRepCommission(cid, (req.body as any).salesRepId, totals.totalAmount);
          return { salesRepId: r.salesRepId, commissionPct: r.commissionPct, commissionAmount: r.commissionAmount };
        })()
      : {};
    // Note: docNumber is intentionally omitted from the update set — once a
    // sales invoice number is assigned (by the central sequence engine or by
    // the user on creation) it is immutable, both for ZATCA audit compliance
    // and to keep the sequence log consistent.
    const [inv] = await db.update(salesInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      notes: notes || null, updatedAt: new Date(),
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      // documentOfferId is allowed to be cleared (set to null) on edit when
      // the matcher decides the doc-level promo no longer qualifies — the
      // explicit `documentOfferId === undefined` ? skip : write semantics
      // would be safer but, since the form always sends it, an unconditional
      // write is fine here and keeps the audit trail honest.
      documentOfferId:    documentOfferId ? Number(documentOfferId) : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      taxId:              taxId ? Number(taxId) : null,
      ...repPatch,
    }).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid))).returning();
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (lines !== undefined) {
      await db.delete(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        await db.insert(salesInvoiceLinesTable).values(lines.map((l: any) => mapInvoiceLine(l, id, cid, resolvedRate)));
      }
    }
    // Bump times_used for offers that are NEW to this invoice on this edit
    // (didn't exist before the update). Re-saving the same invoice with the
    // same offers does NOT bump the counter — matches the "counted once per
    // applied invoice" intent.
    {
      const newOfferIds = new Set<number>();
      for (const l of (lines ?? [])) {
        if (l?.appliedOfferId) newOfferIds.add(Number(l.appliedOfferId));
      }
      if (documentOfferId) newOfferIds.add(Number(documentOfferId));
      const toBump: number[] = [];
      for (const oid of newOfferIds) if (!prevOfferIds.has(oid)) toBump.push(oid);
      await bumpOffersTimesUsed(cid, toBump);
    }
    res.json(inv);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/sales-invoices/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard: a restricted user must not be able to post
    // another branch's invoice by guessing the id. Shared (branch_id NULL)
    // rows remain visible, mirroring the GET-by-id route at L459.
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.id, id),
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
      ));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") { res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" }); return; }

    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في الفاتورة" }); return; }

    // When this invoice was created from a Goods Delivery Note (GDN), the
    // stock movement (and inventory credit) already happened at GDN-post
    // time. SKIP the stock loop entirely so we don't double-count, and
    // CREDIT Delivery Clearing (instead of revenue/inventory) so it nets
    // out against the GDN's debit to that same clearing account.
    const gdnSourced = !!(inv as any).sourceGdnId;

    // Guard: every stock-affecting (item-bearing) line must specify a warehouse.
    // (Skip when GDN-sourced — the GDN already validated this.)
    const noWh = gdnSourced ? [] : lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info (account + allow-negative) for every distinct warehouse used.
    // (Not needed when GDN-sourced — no stock loop and no per-warehouse inventory credits.)
    const whInfo = gdnSourced ? {} : await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Validate stock availability first (qty * conversionFactor = base-unit qty)
    // Skip the check for warehouses that explicitly allow negative stock.
    if (!gdnSourced) {
      for (const line of lines) {
        if (!line.itemId || !line.warehouseId) continue;
        const wh = whInfo[line.warehouseId];
        if (wh?.allowNegative) continue;
        const factor = Number(line.conversionFactor || "1") || 1;
        // Free qty leaves the warehouse exactly like paid qty — include it
        // in the availability check so a 5-paid + 3-free line that exceeds
        // stock fails up-front instead of going negative on the COGS leg.
        const qty = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
        const cur = await getBalance(cid, line.itemId, line.warehouseId);
        if (cur < qty) {
          res.status(400).json({
            error: `رصيد الصنف "${line.itemName}" غير كافٍ في مخزن "${wh?.nameAr ?? line.warehouseId}" — المتاح ${cur} والمطلوب ${qty}. فعّل خاصية "السماح بالسالب" على المخزن إن كنت ترغب بتجاوز الرصيد.`,
          });
          return;
        }
      }
    }

    // ─── PRE-COMPUTE COGS (no mutation) ───
    // Two-pass design: first pass walks the lines without mutating stock so
    // the zero-value early guard below can fire BEFORE any side effect. The
    // second pass (after all validations) actually decrements stock and
    // writes the ledger. GDN-sourced invoices skip COGS entirely.
    let totalCogs = 0;
    const cogsByWarehouse: Record<number, number> = {};
    // PHASE G — FG outbound batch picking on sales invoice posting.
    //   * batch_tracking_mode='none'  → legacy single-row WAC issue (picks=null)
    //   * batch_tracking_mode='fifo'  → oldest received batch first
    //   * batch_tracking_mode='fefo'  → earliest expiry first (NULLS LAST)
    // COGS for batch-tracked items uses the weighted sum of picks instead of
    // a single getAvgCost(); the ledger write loop below emits N stamped rows
    // per line (one per pick) so traceability/recall works on sales OUT too.
    type StockOp = {
      itemId: number;
      warehouseId: number;
      qty: number;
      avgCost: number;
      notes: string | null;
      picks: BatchPick[] | null; // null = legacy single-row, [] = nothing to pick
    };
    const stockOps: StockOp[] = [];
    if (!gdnSourced) {
      // Fetch batch_tracking_mode for every line item in one query.
      const lineItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const itemRows = lineItemIds.length
        ? await db
            .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode })
            .from(itemsTable)
            .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, lineItemIds)))
        : [];
      const modeById = new Map<number, "none" | "fifo" | "fefo">();
      for (const r of itemRows) {
        const m = (r.mode ?? "none") as string;
        modeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
      }
      for (const line of lines) {
        if (!line.itemId || !line.warehouseId) continue;
        const factor  = Number(line.conversionFactor || "1") || 1;
        // Free qty consumes inventory at the same avg cost as paid qty —
        // both legs add to COGS so the inventory credit matches the actual
        // units leaving the warehouse. Revenue stays on `qty` only.
        const qty     = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
        // Skip non-positive effective qty: a zero/negative line has nothing
        // to issue and would either write a no-op ledger row or (worse)
        // *increase* stock on a sale via the `-op.qty` upsertBalance below.
        if (qty <= 0) continue;
        const mode = modeById.get(line.itemId) ?? "none";
        let avgCost: number;
        let picks: BatchPick[] | null;
        if (mode === "none") {
          avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
          picks = null;
        } else {
          // pickBatches throws when stock is insufficient — surface as 400.
          try {
            picks = await pickBatches(cid, line.itemId, line.warehouseId, qty, mode);
          } catch (e: any) {
            res.status(400).json({ error: `${line.itemName ?? "صنف"}: ${e?.message ?? "كمية غير متاحة"}` });
            return;
          }
          const lineCost = picks.reduce((s, p) => s + p.takeQty * p.costPrice, 0);
          avgCost = qty > 0 ? lineCost / qty : 0;
        }
        const lineCogs = qty * avgCost;
        totalCogs += lineCogs;
        cogsByWarehouse[line.warehouseId] = (cogsByWarehouse[line.warehouseId] ?? 0) + lineCogs;
        stockOps.push({ itemId: line.itemId, warehouseId: line.warehouseId, qty, avgCost, notes: line.notes ?? null, picks });
      }
    }

    // ── Build journal entry ──
    // Dr Customer/Cash (= total = subtotal − discount + vat)
    // Dr Sales Discount (if any)
    // Dr COGS  (computed from avg cost × qty)
    //   Cr Sales Revenue (= subtotal, gross before discount)
    //   Cr VAT Output    (= vatAmount)
    //   Cr Inventory     (= total cost — credit reduces inventory asset)
    //
    // Early guard: an invoice that carries no monetary value AND no inventory
    // cost has nothing to journalise — every proposed line would be filtered
    // out for being zero, surfacing as the cryptic "needs at least 2 sides"
    // downstream. Catch it here with an actionable message instead. Runs
    // BEFORE any stock mutation so a rejection leaves no partial state.
    {
      const totalForGuard = Number(inv.totalAmount || 0);
      if (totalForGuard === 0 && totalCogs === 0) {
        res.status(400).json({
          error: gdnSourced
            ? "لا يمكن ترحيل هذه الفاتورة المُولَّدة من إذن تسليم: إجمالي الفاتورة صفر — لا يوجد ما يُسجَّل محاسبياً."
            : "لا يمكن ترحيل هذه الفاتورة: إجمالي الفاتورة وتكلفة البضاعة كلاهما صفر. تأكد من إدخال أسعار البيع للأصناف أو وجود تكلفة مخزنية مسجلة قبل الترحيل.",
        });
        return;
      }
    }

    // POS invoices prefer the dedicated `pos_invoice` mapping so the operator
    // can route POS revenue/discount/VAT to separate GL accounts from manual
    // sales when desired. Falls back to `sales_invoice` for any role left
    // unconfigured under POS so a missing POS mapping never breaks posting.
    const isPos = !!inv.posSessionId;
    const mapSi = await loadMappings(cid, "sales_invoice");
    const mapPos = isPos ? await loadMappings(cid, "pos_invoice") : null;
    const pick = (role: string): number | null =>
      (mapPos ? mapPos("pos_invoice", role) : null) ?? mapSi("sales_invoice", role);
    const salesAccId    = pickAccount(inv.salesAccountId,    pick("revenue"));
    const cogsAccId     = pickAccount(inv.cogsAccountId,     pick("cogs"));
    const taxAccId      = pickAccount(inv.taxAccountId,      pick("vat_output"));
    const discountAccId = pickAccount(inv.discountAccountId, pick("discount"));
    // Revenue / COGS / per-warehouse inventory accounts are NOT required for
    // GDN-sourced invoices — they post against Delivery Clearing instead.
    if (!gdnSourced) {
      if (!salesAccId) { res.status(400).json({ error: "لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)" }); return; }
      if (!cogsAccId)  { res.status(400).json({ error: "لم يتم تحديد حساب تكلفة البضاعة المباعة (اضبطه من ربط القيود المحاسبية)" }); return; }
      // Inventory account is taken from each warehouse, not the invoice. Verify every used warehouse has one.
      const missingWh: string[] = [];
      for (const [widStr, amt] of Object.entries(cogsByWarehouse)) {
        if (amt <= 0) continue;
        const wid = Number(widStr);
        if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
      }
      if (missingWh.length) {
        res.status(400).json({ error: `لم يتم ربط حساب محاسبي للمخزن/المخازن التالية: ${missingWh.join("، ")}. اضبط حساب المخزون من شاشة المخازن.` });
        return;
      }
    }
    // Resolve Delivery Clearing for GDN-sourced invoices (auto-provisioning).
    let deliveryClearingAccId: number | null = null;
    if (gdnSourced) {
      deliveryClearingAccId = await getDeliveryClearingAccountId(cid);
      if (!deliveryClearingAccId) {
        res.status(400).json({ error: "حساب وسيط التسليم (1110/11101) غير موجود — يرجى استيراد دليل الحسابات الافتراضي أولاً" });
        return;
      }
    }

    const subtotalAmt = Number(inv.subtotal || 0);
    const vatAmt      = Number(inv.vatAmount || 0);
    const headerDiscAmt = Number(inv.discountAmount || 0);
    const totalAmt    = Number(inv.totalAmount || 0);

    // Roll line-level discounts (per-line `discount` % + `discountAmount`)
    // into a single "خصم مسموح به" debit so promotions like Buy-X-Get-Y /
    // line-pricing / fixed-amount discounts surface as a discrete journal
    // line instead of being silently absorbed into a smaller revenue figure.
    // The amount is computed as the VAT-exclusive saving per line so it
    // stacks cleanly with the existing VAT-exclusive `subtotal`.
    const priceIncludesVat = !!(inv as any).priceIncludesVat;
    let lineDiscountTotal = 0;
    for (const ln of lines) {
      const qty     = Number(ln.qty)       || 0;
      const price   = Number(ln.unitPrice) || 0;
      const discPct = Number(ln.discount)  || 0;
      const discAmt = Number((ln as any).discountAmount) || 0;
      if (qty <= 0 || price <= 0) continue;
      const grossPre = qty * price;
      // Percent first, then fixed-amount (matches form's calcLine). Clamp at
      // grossPre so an over-discount never makes the JE line go negative.
      const discGross = Math.min(grossPre, grossPre * (discPct / 100) + discAmt);
      if (discGross <= 0) continue;
      const rate    = (Number(ln.vatRate) || 0) / 100;
      // When prices are VAT-inclusive, the gross saving carries VAT — strip
      // it so we only book the net portion against revenue. VAT line stays
      // unchanged because `inv.vatAmount` is already net of the discount.
      lineDiscountTotal += priceIncludesVat && rate > -1
        ? discGross / (1 + rate)
        : discGross;
    }
    lineDiscountTotal = Math.round(lineDiscountTotal * 100) / 100;

    // Gross-up for the journal: revenue is credited at pre-discount value
    // and the saving flows through the discount account. Header discount
    // (document-level promo) and line discount both ride the same debit.
    const grossSubtotalAmt = subtotalAmt + lineDiscountTotal;
    const discountAmt      = headerDiscAmt + lineDiscountTotal;

    const partyAccountId =
      inv.paymentType === "cash" ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? await getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : await getCustomerAccountId(cid, inv.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error:
        inv.paymentType === "cash" ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : inv.paymentType === "bank" ? "الحساب البنكي لا يحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط (حساب الذمم المدينة)" });
      return;
    }

    if (discountAmt > 0 && !discountAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب الخصم المسموح به (اضبطه من ربط القيود المحاسبية)" }); return;
    }
    if (vatAmt > 0 && !taxAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب ضريبة القيمة المضافة مخرجات (اضبطه من ربط القيود المحاسبية)" }); return;
    }

    let journalId: number | null = null;
    {
    // GDN-sourced invoices: replace the revenue + inventory credits with a
    // single CREDIT to Delivery Clearing. The clearing account was DEBITED
    // at GDN-post time (Dr Clearing / Cr Inventory), so this credit unwinds
    // it. Goods value = totalAmt − vatAmt + headerDiscAmt = pre-discount,
    // VAT-exclusive sale price.
    journalId = await createJournalEntry({
      companyId: cid,
      audit: { req },
      branchId: inv.branchId,
      date: inv.invoiceDate,
      docNumber: inv.docNumber,
      entryType: "sales_invoice",
      exchangeRate: inv.exchangeRate,
      // Header-level cost center tags every JE line for cost-center reports.
      costCenter: (inv as any).costCenter ?? null,
      description: `قيد فاتورة مبيعات رقم ${inv.docNumber || inv.id}`,
      lines: gdnSourced
        ? [
            // Dr Customer/Cash/Bank @ total
            { accountId: partyAccountId,         debit: totalAmt,                              description: inv.paymentType === "cash" ? "تحصيل نقدي" : inv.paymentType === "bank" ? "تحصيل بنكي" : "ذمم العميل" },
            // Cr VAT Output (still booked separately — operator can claim it)
            { accountId: taxAccId,               credit: vatAmt,                               description: "ضريبة القيمة المضافة (مخرجات)" },
            // Cr Delivery Clearing (replaces revenue + inventory credits)
            { accountId: deliveryClearingAccId!, credit: totalAmt - vatAmt,                    description: "تسوية وسيط تسليم البضاعة" },
          ]
        : [
            // Debits
            { accountId: partyAccountId,        debit: totalAmt,    description: inv.paymentType === "cash" ? "تحصيل نقدي" : inv.paymentType === "bank" ? "تحصيل بنكي" : "ذمم العميل" },
            { accountId: discountAccId, debit: discountAmt, description: "خصم مسموح به" },
            { accountId: cogsAccId,     debit: totalCogs,   description: "تكلفة البضاعة المباعة" },
            // Credits
            { accountId: salesAccId,     credit: grossSubtotalAmt, description: "إيراد المبيعات" },
            { accountId: taxAccId,       credit: vatAmt,      description: "ضريبة القيمة المضافة (مخرجات)" },
            // Inventory: one credit line per warehouse using its own GL account
            ...Object.entries(cogsByWarehouse)
              .filter(([, amt]) => amt > 0)
              .map(([widStr, amt]) => {
                const wid = Number(widStr);
                return {
                  accountId: whInfo[wid]!.accountId!,
                  credit: amt,
                  description: `إنقاص المخزون — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
                };
              }),
          ],
    });
    }  // end JE block

    // ─── ACTUAL STOCK MUTATION ───
    // Now that all validations passed AND the journal entry was created
    // successfully, persist the stock decrements. Doing this after JE
    // creation guarantees a rejected/unbalanced JE leaves stock untouched.
    for (const op of stockOps) {
      await upsertBalance(cid, op.itemId, op.warehouseId, -op.qty, op.avgCost);
      const newBal = await getBalance(cid, op.itemId, op.warehouseId);
      if (!op.picks || op.picks.length === 0) {
        // Legacy single-row WAC issue (batch_tracking_mode='none').
        await addStockLedgerEntry({
          companyId:   cid,
          itemId:      op.itemId,
          warehouseId: op.warehouseId,
          txDate:      inv.invoiceDate,
          txType:      "sale",
          qty:         String(-op.qty),
          costPrice:   String(op.avgCost.toFixed(4)),
          totalCost:   String((-op.qty * op.avgCost).toFixed(2)),
          balanceQty:  String(newBal),
          refId:       id,
          refType:     "sales_invoice",
          notes:       op.notes ?? undefined,
        });
      } else {
        // FIFO/FEFO — write one stamped ledger row per pick.
        // balance_qty walks down from the pre-issue total so each row reflects
        // the post-row running balance (mirrors production_issue pattern).
        let cursor = newBal + op.qty; // pre-issue total
        for (const p of op.picks) {
          cursor -= p.takeQty;
          await addStockLedgerEntry({
            companyId:   cid,
            itemId:      op.itemId,
            warehouseId: op.warehouseId,
            txDate:      inv.invoiceDate,
            txType:      "sale",
            qty:         String(-p.takeQty),
            costPrice:   String(p.costPrice.toFixed(4)),
            totalCost:   String((-p.takeQty * p.costPrice).toFixed(2)),
            balanceQty:  String(cursor.toFixed(4)),
            refId:       id,
            refType:     "sales_invoice",
            batchNumber: p.batchNumber,
            expiryDate:  p.expiryDate,
            notes:       `${op.notes ?? ""}${p.batchNumber ? ` — تشغيلة ${p.batchNumber}` : ""}`.trim() || undefined,
          });
        }
      }
    }

    const [updated] = await db.update(salesInvoicesTable)
      .set({
        status: "posted",
        journalEntryId: journalId,
        postedById: req.authUser?.id ?? null,
        postedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoicesTable.id, id))
      .returning();

    // NOTE: لا نُنشئ سند قبض تلقائياً عند ترحيل فاتورة نقدية/بنكية.
    // القيد المحاسبي أعلاه يكفي لتسجيل الأثر النقدي؛ سند القبض يُنشأ يدوياً عند الحاجة.

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST sales invoice (فك الترحيل) ──────────────────────────────────────
router.patch("/sales-invoices/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard (mirrors /post above).
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.id, id),
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
      ));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status !== "posted") { res.status(400).json({ error: "الفاتورة ليست مُرحَّلة" }); return; }

    // GDN-sourced invoices never touched stock (the GDN did), so the stock
    // loop below would be a no-op anyway — short-circuit for clarity.
    const gdnSourced = !!(inv as any).sourceGdnId;

    // Reverse stock movements (sales reduced stock; unpost adds back)
    const ledger = gdnSourced ? [] : await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "sales_invoice"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty); // negative for sale; subtracting it adds back
      const [bal] = await db.select().from(stockBalanceTable)
        .where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, row.itemId),
          eq(stockBalanceTable.warehouseId, row.warehouseId),
        ));
      if (bal) {
        await db.update(stockBalanceTable)
          .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
          .where(eq(stockBalanceTable.id, bal.id));
      }
    }
    if (!gdnSourced) {
      await db.delete(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "sales_invoice"),
          eq(stockLedgerTable.refId, id),
        ));
    }

    if (inv.journalEntryId) {
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, inv.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(salesInvoicesTable)
      .set({ status: "draft", journalEntryId: null, postedById: null, postedAt: null, updatedAt: new Date() })
      .where(eq(salesInvoicesTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف فاتورة مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    // Block deletion when sales returns reference this invoice (FK has no cascade).
    const relatedReturns = await db.select({
      id: salesReturnsTable.id, docNumber: salesReturnsTable.docNumber,
    }).from(salesReturnsTable).where(and(
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.invoiceId, id),
    )).limit(5);
    if (relatedReturns.length) {
      const refs = relatedReturns.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها مرتبطة بمرتجع/مرتجعات مبيعات: ${refs}. يرجى حذف المرتجع أولاً.` });
      return;
    }
    // Block deletion when a quotation was converted into this invoice
    // (sales_quotations.converted_invoice_id has no cascade either).
    const relatedQuotes = await db.select({
      id: salesQuotationsTable.id, docNumber: salesQuotationsTable.docNumber,
    }).from(salesQuotationsTable).where(and(
      eq(salesQuotationsTable.companyId, cid),
      eq(salesQuotationsTable.convertedInvoiceId, id),
    )).limit(5);
    if (relatedQuotes.length) {
      const refs = relatedQuotes.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها ناتجة عن تحويل عرض/عروض أسعار: ${refs}. يرجى فك ربط العرض أولاً.` });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "sales_invoice", refId: id, journalEntryId: inv.journalEntryId });

    // If this draft invoice was created from a GDN, atomically restore the
    // GDN to posted (un-link it) and delete the invoice in one transaction
    // so a partial failure can't leave the GDN permanently stuck in
    // "invoiced" status. The GDN revert is guarded by status='invoiced' AND
    // linked_invoice_id = this invoice.id so concurrent state changes (e.g.
    // someone re-linking the GDN to a different invoice) can't be silently
    // overwritten.
    const gdnId = (inv as any).sourceGdnId as number | null | undefined;
    if (gdnId) {
      await db.transaction(async (tx) => {
        const reverted = await tx.update(goodsDeliveriesTable)
          .set({ status: "posted", linkedInvoiceId: null, updatedAt: new Date() })
          .where(and(
            eq(goodsDeliveriesTable.id, gdnId),
            eq(goodsDeliveriesTable.companyId, cid),
            eq(goodsDeliveriesTable.status, "invoiced"),
            eq(goodsDeliveriesTable.linkedInvoiceId, id),
          ))
          .returning({ id: goodsDeliveriesTable.id });
        if (reverted.length === 0) {
          // GDN was already unposted/deleted/re-linked — log but proceed
          // with the invoice delete since the link is already broken.
          req.log?.warn({ gdnId, invoiceId: id }, "sales-invoice delete: GDN revert affected 0 rows (already unlinked or in different state)");
        }
        await tx.delete(salesInvoicesTable).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
      });
    } else {
      await db.delete(salesInvoicesTable).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SALES RETURNS
// ═══════════════════════════════════════════════
router.get("/sales-returns", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    // Source filter — POS-originated returns are returns whose source invoice
    // (`invoiceId`) was issued from a POS session. Default `manual` hides them
    // so the Sales Returns screen mirrors the Sales Invoices screen.
    const source = String(req.query.source ?? "manual").toLowerCase();
    const sourceFilter =
      source === "pos" ? [sql`${salesReturnsTable.invoiceId} IN (
        SELECT id FROM sales_invoices
        WHERE company_id = ${cid} AND pos_session_id IS NOT NULL
      )`] :
      source === "manual" ? [sql`(${salesReturnsTable.invoiceId} IS NULL OR ${salesReturnsTable.invoiceId} IN (
        SELECT id FROM sales_invoices
        WHERE company_id = ${cid} AND pos_session_id IS NULL
      ))`] :
      [];
    const rows = await db.select().from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        ...sourceFilter,
        ...multiBranchScopeSpread(req, salesReturnsTable.branchId, req.query.branchIds ?? req.query.branchId),
      ))
      .orderBy(desc(salesReturnsTable.returnDate));
    // Lightweight per-return warehouseIds set — used by the audit grid's
    // warehouse filter so we don't ship every line over the wire. Single
    // grouped query keeps this O(N+M) instead of N+1.
    const ids = rows.map(r => r.id);
    const whByReturn = new Map<number, Set<number>>();
    if (ids.length > 0) {
      const lineWh = await db.select({
        returnId:    salesReturnLinesTable.returnId,
        warehouseId: salesReturnLinesTable.warehouseId,
      }).from(salesReturnLinesTable).where(inArray(salesReturnLinesTable.returnId, ids));
      for (const lw of lineWh) {
        if (!lw.returnId || lw.warehouseId == null) continue;
        const s = whByReturn.get(lw.returnId) ?? new Set<number>();
        s.add(Number(lw.warehouseId));
        whByReturn.set(lw.returnId, s);
      }
    }
    res.json(rows.map(r => ({ ...r, warehouseIds: Array.from(whByReturn.get(r.id) ?? []) })));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/sales-returns/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    const id = Number(req.params.id);
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), cid ? eq(salesReturnsTable.companyId, cid) : sql`true`));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    const lines = await db.select().from(salesReturnLinesTable)
      .where(eq(salesReturnLinesTable.returnId, id))
      .orderBy(asc(salesReturnLinesTable.id));
    res.json({ ...ret, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Shared validation for sales-return POST/PUT. Enforces 4 rules:
//   1) notes (الشرح) is mandatory on every return.
//   2) every line must have itemId, qty>0, and a main unitId.
//   3) when invoiceId is set, the per-item cumulative return qty across
//      *all* returns for that invoice (current + prior, excluding the
//      one being edited) cannot exceed the source invoice's sold qty.
//      Comparison is in base units (qty × conversionFactor) so the rule
//      survives unit changes between source and return.
// Returns true if the request may proceed; otherwise writes a 400 and
// returns false (caller must `return` immediately).
async function validateSalesReturnPayload(
  res: any,
  body: any,
  ctx: { cid: number; excludeReturnId?: number | null },
): Promise<boolean> {
  const { notes, lines, invoiceId } = body ?? {};
  if (!notes || !String(notes).trim()) {
    res.status(400).json({ error: "الشرح (الملاحظات) مطلوب لكل مرتجع", field: "notes" }); return false;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: "يجب إضافة سطر واحد على الأقل في المرتجع" }); return false;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? {};
    if (!l.itemId) {
      res.status(400).json({ error: `السطر ${i + 1}: الصنف مطلوب`, field: `lines.${i}.itemId` }); return false;
    }
    const q = Number(l.qty);
    if (!Number.isFinite(q) || q <= 0) {
      res.status(400).json({ error: `السطر ${i + 1}: الكمية مطلوبة وأكبر من صفر`, field: `lines.${i}.qty` }); return false;
    }
    if (!l.unitId) {
      res.status(400).json({ error: `السطر ${i + 1}: الوحدة الرئيسية مطلوبة`, field: `lines.${i}.unitId` }); return false;
    }
  }
  if (invoiceId) {
    const invId = Number(invoiceId);
    if (Number.isFinite(invId)) {
      const srcLines = await db.select({
        itemId: salesInvoiceLinesTable.itemId,
        qty: salesInvoiceLinesTable.qty,
        conversionFactor: salesInvoiceLinesTable.conversionFactor,
      }).from(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, invId));
      const soldBase = new Map<number, number>();
      for (const sl of srcLines) {
        if (sl.itemId == null) continue;
        const base = Number(sl.qty || 0) * Number(sl.conversionFactor || 1);
        soldBase.set(sl.itemId, (soldBase.get(sl.itemId) || 0) + base);
      }
      const priorWhere = [
        eq(salesReturnsTable.companyId, ctx.cid),
        eq(salesReturnsTable.invoiceId, invId),
        ...(ctx.excludeReturnId ? [sql`${salesReturnsTable.id} <> ${ctx.excludeReturnId}`] : []),
      ];
      const priorRetIds = await db.select({ id: salesReturnsTable.id })
        .from(salesReturnsTable).where(and(...priorWhere));
      const priorIds = priorRetIds.map((r: any) => r.id);
      const returnedBase = new Map<number, number>();
      if (priorIds.length) {
        const prior = await db.select({
          itemId: salesReturnLinesTable.itemId,
          qty: salesReturnLinesTable.qty,
          conversionFactor: salesReturnLinesTable.conversionFactor,
        }).from(salesReturnLinesTable).where(inArray(salesReturnLinesTable.returnId, priorIds));
        for (const pl of prior) {
          if (pl.itemId == null) continue;
          const base = Number(pl.qty || 0) * Number(pl.conversionFactor || 1);
          returnedBase.set(pl.itemId, (returnedBase.get(pl.itemId) || 0) + base);
        }
      }
      const currBase = new Map<number, { base: number; rawQty: number }>();
      for (const l of lines) {
        const iid = Number(l.itemId);
        if (!Number.isFinite(iid) || !iid) continue;
        const base = Number(l.qty || 0) * Number(l.conversionFactor || 1);
        const cur = currBase.get(iid) || { base: 0, rawQty: 0 };
        cur.base += base; cur.rawQty += Number(l.qty || 0);
        currBase.set(iid, cur);
      }
      for (const [iid, cur] of currBase.entries()) {
        const sold = soldBase.get(iid) || 0;
        if (sold <= 0) {
          res.status(400).json({
            error: `الصنف #${iid} غير موجود في الفاتورة المصدر — لا يمكن إرجاعه`,
            field: "lines.itemId", itemId: iid,
          }); return false;
        }
        const prev = returnedBase.get(iid) || 0;
        const remaining = sold - prev;
        if (cur.base > remaining + 1e-6) {
          res.status(400).json({
            error: `الصنف #${iid}: كمية المرتجع تتجاوز المسموح — المباع ${sold}، المرتجع سابقاً ${prev}، المتاح ${Math.max(0, remaining).toFixed(3)} (بالوحدة الأساس)`,
            field: "lines.qty", itemId: iid,
          }); return false;
        }
      }
    }
  }
  return true;
}

router.post("/sales-returns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, returnDate, customerId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat, salesRepId,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId, taxId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    if (!(await validateSalesReturnPayload(res, req.body, { cid, excludeReturnId: null }))) return;
    // Required-fields gate: every sales return must carry an explicit
    // customer + branch — same policy as the parent sales-invoice flow,
    // so cost-center and customer-statement reports stay consistent.
    //
    // Server-side fall-back: when the caller supplied an invoiceId (linked
    // return) but no customerId, derive the customer from the source
    // invoice. This keeps POS walk-in returns working — the POS payload
    // sets customerId=null because the original invoice has no customer,
    // and we'd otherwise 400 a perfectly legitimate return. Same fall-back
    // for branch so POS returns inherit the source-invoice branch when
    // the cashier didn't override it.
    let resolvedCustomerId: number | null = customerId ? Number(customerId) : null;
    let resolvedBranchId:   number | null = branchId   ? Number(branchId)   : null;
    if ((!resolvedCustomerId || !resolvedBranchId) && invoiceId) {
      const [src] = await db.select({
        customerId: salesInvoicesTable.customerId,
        branchId:   salesInvoicesTable.branchId,
        posSessionId: salesInvoicesTable.posSessionId,
      }).from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, Number(invoiceId)), eq(salesInvoicesTable.companyId, cid)));
      if (src) {
        if (!resolvedCustomerId) resolvedCustomerId = src.customerId ?? null;
        if (!resolvedBranchId)   resolvedBranchId   = src.branchId   ?? null;
        // POS walk-in source: customer legitimately null. Skip the
        // customer-required check so the return can post.
        if (!resolvedCustomerId && src.posSessionId) {
          // intentional — POS walk-in returns have no customer.
        } else if (!resolvedCustomerId) {
          res.status(400).json({ error: "يجب اختيار العميل قبل حفظ المرتجع", field: "customerId" }); return;
        }
      } else {
        res.status(400).json({ error: "يجب اختيار العميل قبل حفظ المرتجع", field: "customerId" }); return;
      }
    } else if (!resolvedCustomerId) {
      res.status(400).json({ error: "يجب اختيار العميل قبل حفظ المرتجع", field: "customerId" }); return;
    }
    if (!resolvedBranchId) { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ المرتجع", field: "branchId" }); return; }
    // Validate sales rep belongs to current tenant (prevents cross-tenant FK assignment).
    let resolvedRepId: number | null = null;
    if (salesRepId) {
      const ridNum = Number(salesRepId);
      if (Number.isFinite(ridNum)) {
        const [rep] = await db.select({ id: salesRepsTable.id }).from(salesRepsTable)
          .where(and(eq(salesRepsTable.id, ridNum), eq(salesRepsTable.companyId, cid)));
        resolvedRepId = rep ? rep.id : null;
      }
    }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند ردّ المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند ردّ المبلغ بنكياً" }); return; }
    const grossR    = (lines || []).reduce((s: number, l: any) => s + Number(l.lineTotal || 0), 0);
    const discR     = Math.max(0, Math.min(grossR, Number(discountAmount) || 0));
    const totalR    = grossR - discR;
    // Central sequence engine is authoritative when an active sequence
    // exists for "sales_return"; otherwise fall back to client-supplied
    // value or null. Server allocation is atomic so concurrent submits
    // can never persist the same number.
    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "sales_return", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "sales_returns",
        branchId: branchId ? Number(branchId) : null,
        docDate:  returnDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم المرتجع" });
      return;
    }
    const [ret] = await db.insert(salesReturnsTable).values({
      companyId: cid, branchId: resolvedBranchId,
      docNumber: resolvedDocNumber, returnDate,
      customerId: resolvedCustomerId,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: totalR.toFixed(2),
      vatAmount: String(vatAmount || "0"),
      discountAmount: discR.toFixed(2),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft", notes: notes || null,
      // Manual session (admin-created) the user is currently working under,
      // resolved by extractAuth from the trusted x-session-id header.
      sessionId: (req as any).manualSessionId ?? null,
      salesRepId:         resolvedRepId,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      taxId:              taxId ? Number(taxId) : null,
      createdById: (req as any).authUser?.id ?? null,
    }).returning();
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(salesReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId:   l.itemId   ? Number(l.itemId)   : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId:   l.unitId   ? Number(l.unitId)   : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"),
          freeQty: String(l.freeQty || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
          vatRate: String(l.vatRate || resolvedRate),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(ret);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/sales-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (existing.status !== "draft") { res.status(400).json({ error: "لا يمكن تعديل مرتجع مُرحَّل. قم بفك الترحيل أولاً." }); return; }

    // docNumber is intentionally not destructured — immutable on edit.
    const { returnDate, customerId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat, salesRepId,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId, taxId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    // Same required-fields gate as the POST path so a stale-draft PUT
    // can't strip customer/branch off an existing sales return.
    if (!customerId) { res.status(400).json({ error: "يجب اختيار العميل قبل حفظ المرتجع", field: "customerId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ المرتجع",  field: "branchId"   }); return; }
    if (!(await validateSalesReturnPayload(res, req.body, { cid, excludeReturnId: id }))) return;
    // Patch-safe rep update: only touch salesRepId when the client explicitly
    // sent the key. Validate company scope when present (cross-tenant guard).
    const hasRepKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "salesRepId");
    let resolvedRepIdPatch: number | null | undefined = undefined;
    if (hasRepKey) {
      if (!salesRepId) {
        resolvedRepIdPatch = null;
      } else {
        const ridNum = Number(salesRepId);
        if (Number.isFinite(ridNum)) {
          const [rep] = await db.select({ id: salesRepsTable.id }).from(salesRepsTable)
            .where(and(eq(salesRepsTable.id, ridNum), eq(salesRepsTable.companyId, cid)));
          resolvedRepIdPatch = rep ? rep.id : null;
        } else {
          resolvedRepIdPatch = null;
        }
      }
    }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند ردّ المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند ردّ المبلغ بنكياً" }); return; }
    const grossR2 = (lines || []).reduce((s: number, l: any) => s + Number(l.lineTotal || 0), 0);
    const discR2  = Math.max(0, Math.min(grossR2, Number(discountAmount) || 0));
    const totalR2 = grossR2 - discR2;

    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [ret] = await db.update(salesReturnsTable).set({
      branchId: branchId ? Number(branchId) : null,
      returnDate,
      customerId: customerId ? Number(customerId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: totalR2.toFixed(2),
      vatAmount: String(vatAmount || "0"),
      discountAmount: discR2.toFixed(2),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null,
      ...(hasRepKey ? { salesRepId: resolvedRepIdPatch as number | null } : {}),
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      taxId:              taxId ? Number(taxId) : null,
      updatedAt: new Date(),
    }).where(eq(salesReturnsTable.id, id)).returning();

    await db.delete(salesReturnLinesTable).where(eq(salesReturnLinesTable.returnId, id));
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(salesReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: id, companyId: cid,
          itemId:   l.itemId   ? Number(l.itemId)   : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId:   l.unitId   ? Number(l.unitId)   : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"),
          freeQty: String(l.freeQty || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
          vatRate: String(l.vatRate || resolvedRate),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.json(ret);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/sales-returns/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard: prevent cross-branch posting by ID guess.
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.id, id),
        eq(salesReturnsTable.companyId, cid),
        ...branchScopeSpread(req, salesReturnsTable.branchId, undefined),
      ));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") { res.status(400).json({ error: "المرتجع مُرحَّل مسبقاً" }); return; }

    // Source-invoice integrity: if linked, the source must belong to the same
    // company (branch scope on the SOURCE is intentionally not enforced — the
    // return itself is already branch-scoped above, and an invoice raised in
    // another branch may legitimately be returned through this branch).
    if (ret.invoiceId) {
      const [srcCheck] = await db
        .select({ id: salesInvoicesTable.id })
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.id, ret.invoiceId),
          eq(salesInvoicesTable.companyId, cid),
        ));
      if (!srcCheck) {
        res.status(400).json({ error: "الفاتورة المصدر غير موجودة في هذه الشركة — فك ربط الفاتورة أو اختر فاتورة صحيحة." });
        return;
      }
    }

    const lines = await db.select().from(salesReturnLinesTable)
      .where(eq(salesReturnLinesTable.returnId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في المرتجع" }); return; }

    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info for inventory account derivation
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Increase stock for each stockable return line (items coming back into inventory, in base units)
    //
    // PHASE H — Batch-aware sales returns:
    //   * batch_tracking_mode='none'  → legacy single-row WAC restore (unchanged)
    //   * batch_tracking_mode='fifo|fefo' AND linked to a source invoice →
    //       read the source invoice's stamped OUT rows for this item+warehouse
    //       and restore the returned qty back onto those original batches in
    //       pick order (so a partial return rebuilds the oldest-shipped batch
    //       first, which keeps FEFO honest for the next outbound). Excess
    //       beyond the original shipment falls back to an unbatched IN row.
    //   * batch-tracked with NO source invoice (orphan return) → legacy WAC
    //       path. We refuse to fabricate a batch for unlinked returns.
    const retItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
    const retItemRows = retItemIds.length
      ? await db
          .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, retItemIds)))
      : [];
    const retModeById = new Map<number, "none" | "fifo" | "fefo">();
    for (const r of retItemRows) {
      const m = (r.mode ?? "none") as string;
      retModeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
    }

    let totalCogs = 0;
    const cogsByWarehouse: Record<number, number> = {};
    // Cross-line bucket consumption — when the same return document has
    // multiple lines for the same (item, warehouse), a batch's restorable
    // headroom must shrink as each line allocates against it. Without this,
    // both lines would each see the same `alreadyByBucket` from DB and
    // collectively over-restore into the same source batch.
    // Key: `${itemId}|${warehouseId}|${batch||__null__}|${expiry||""}`
    const consumedThisDoc = new Map<string, number>();
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor  = Number(line.conversionFactor || "1") || 1;
      // Sales return mirrors the original sale: paid qty + free qty came back, so
      // both must be added back to stock and refunded into COGS reversal.
      const qty     = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
      if (qty <= 0) continue; // skip non-positive returns (mirror /post guard)
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      // If item never existed in warehouse, fall back to the line's price as cost.
      // unitPrice is in the SELECTED unit, so divide by factor to get base-unit cost.
      const costUnit = avgCost > 0 ? avgCost : (Number(line.unitPrice) / factor);

      const mode = retModeById.get(line.itemId) ?? "none";
      const canBatchRestore = mode !== "none" && !!ret.invoiceId;

      // Build the restoration plan: one entry per ledger row to write.
      type RestorePart = { takeQty: number; costPrice: number; batchNumber: string | null; expiryDate: string | null };
      const parts: RestorePart[] = [];

      if (canBatchRestore) {
        // Pull the source invoice's stamped OUT rows for this item+warehouse,
        // ordered by id (matches the original pick order). Each row may carry
        // batch_number + expiry_date (Round 4 stamped them) or be a legacy
        // single row with NULL batch (item was 'none' at sale time but is
        // batch-tracked now — restore as unbatched).
        const srcRows = await db
          .select({
            id: stockLedgerTable.id,
            qty: stockLedgerTable.qty,
            costPrice: stockLedgerTable.costPrice,
            batchNumber: stockLedgerTable.batchNumber,
            expiryDate: stockLedgerTable.expiryDate,
          })
          .from(stockLedgerTable)
          .where(and(
            eq(stockLedgerTable.companyId, cid),
            eq(stockLedgerTable.refType, "sales_invoice"),
            eq(stockLedgerTable.refId, ret.invoiceId!),
            eq(stockLedgerTable.itemId, line.itemId),
            eq(stockLedgerTable.warehouseId, line.warehouseId),
          ))
          .orderBy(asc(stockLedgerTable.id));
        // Aggregate source OUT rows by (batchNumber, expiryDate) so a batch
        // shipped across multiple ledger rows forms a single restorable
        // bucket — prevents the prior-return cap from being applied per row
        // (which would under-allocate when the same batch appears in
        // multiple source rows). firstId preserves pick order for stable
        // allocation.
        type Bucket = { batchNumber: string | null; expiryDate: string | null; shipped: number; costSum: number; firstId: number };
        const buckets = new Map<string, Bucket>();
        for (const row of srcRows) {
          const shipped = Math.abs(Number(row.qty));
          if (shipped <= 0) continue;
          const k = `${row.batchNumber ?? "__null__"}|${row.expiryDate ?? ""}`;
          const b = buckets.get(k);
          if (b) {
            b.shipped += shipped;
            b.costSum += shipped * Number(row.costPrice);
          } else {
            buckets.set(k, {
              batchNumber: row.batchNumber,
              expiryDate: row.expiryDate,
              shipped,
              costSum: shipped * Number(row.costPrice),
              firstId: row.id,
            });
          }
        }
        // Prior POSTED returns against same invoice — subtract per-bucket
        // restored qty so a second partial return can't double-credit the
        // same batch slot. Keyed by (batch,expiry) to match bucket
        // granularity. Excludes current return id defensively.
        const priorReturned = await db
          .select({
            qty: stockLedgerTable.qty,
            batchNumber: stockLedgerTable.batchNumber,
            expiryDate: stockLedgerTable.expiryDate,
          })
          .from(stockLedgerTable)
          .innerJoin(salesReturnsTable, eq(stockLedgerTable.refId, salesReturnsTable.id))
          .where(and(
            eq(stockLedgerTable.companyId, cid),
            eq(stockLedgerTable.refType, "sales_return"),
            eq(stockLedgerTable.itemId, line.itemId),
            eq(stockLedgerTable.warehouseId, line.warehouseId),
            eq(salesReturnsTable.invoiceId, ret.invoiceId!),
            // Only POSTED prior returns count toward the cap. Drafts have no
            // accounting effect (per "Posted-Only Financial Reports" rule).
            eq(salesReturnsTable.status, "posted"),
            // Exclude the current return itself — defensive against retries.
            sql`${salesReturnsTable.id} <> ${id}`,
          ));
        const alreadyByBucket = new Map<string, number>();
        for (const r of priorReturned) {
          const k = `${r.batchNumber ?? "__null__"}|${r.expiryDate ?? ""}`;
          alreadyByBucket.set(k, (alreadyByBucket.get(k) ?? 0) + Number(r.qty)); // qty positive on returns
        }
        const ordered = Array.from(buckets.entries()).sort((a, b) => a[1].firstId - b[1].firstId);
        let remaining = qty;
        for (const [k, b] of ordered) {
          if (remaining <= 0.0001) break;
          const docKey = `${line.itemId}|${line.warehouseId}|${k}`;
          const consumedPrior = alreadyByBucket.get(k) ?? 0;
          const consumedDoc   = consumedThisDoc.get(docKey) ?? 0;
          const restorable = Math.max(0, b.shipped - consumedPrior - consumedDoc);
          if (restorable <= 0.0001) continue;
          const take = Math.min(restorable, remaining);
          const wacCost = b.shipped > 0 ? b.costSum / b.shipped : 0;
          parts.push({
            takeQty: take,
            costPrice: wacCost,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
          });
          consumedThisDoc.set(docKey, consumedDoc + take);
          remaining -= take;
        }
        // Excess (returning more than originally shipped — rare, e.g. legacy
        // data or operator override) falls back to a single unbatched IN row
        // at the current WAC so we never silently drop returned units.
        if (remaining > 0.0001) {
          parts.push({ takeQty: remaining, costPrice: costUnit, batchNumber: null, expiryDate: null });
        }
      } else {
        // Legacy path — one unbatched row at WAC.
        parts.push({ takeQty: qty, costPrice: costUnit, batchNumber: null, expiryDate: null });
      }

      // Aggregate cost across all parts (weighted-sum) for JE math.
      const lineRestoredCost = parts.reduce((s, p) => s + p.takeQty * p.costPrice, 0);
      totalCogs += lineRestoredCost;
      cogsByWarehouse[line.warehouseId] = (cogsByWarehouse[line.warehouseId] ?? 0) + lineRestoredCost;

      // Single balance update for the full qty using the weighted unit cost.
      const wac = qty > 0 ? lineRestoredCost / qty : costUnit;
      await upsertBalance(cid, line.itemId, line.warehouseId, qty, wac);
      let cursor = await getBalance(cid, line.itemId, line.warehouseId);
      // Walk back so each ledger row's balance_qty reflects post-row state.
      let pre = cursor - qty; // pre-restore total
      for (const p of parts) {
        pre += p.takeQty;
        await addStockLedgerEntry({
          companyId:   cid,
          itemId:      line.itemId,
          warehouseId: line.warehouseId,
          txDate:      ret.returnDate,
          txType:      "sales_return",
          qty:         String(p.takeQty),
          costPrice:   String(p.costPrice.toFixed(4)),
          totalCost:   String((p.takeQty * p.costPrice).toFixed(2)),
          balanceQty:  String(pre.toFixed(4)),
          refId:       id,
          refType:     "sales_return",
          batchNumber: p.batchNumber,
          expiryDate:  p.expiryDate,
          notes:       `${line.notes ?? ""}${p.batchNumber ? ` — استرجاع تشغيلة ${p.batchNumber}` : ""}`.trim() || undefined,
        });
      }
    }

    // ── Build reversed journal entry ──
    // (Reverse of sales-invoice JE: customer becomes credit, sales/vat become debit, inventory becomes debit, COGS becomes credit)
    // If account FKs are missing on the return but a source invoice is linked, inherit them from the invoice.
    if (ret.invoiceId && (!ret.salesAccountId || !ret.cogsAccountId || !ret.taxAccountId || !ret.discountAccountId)) {
      const [srcInv] = await db.select().from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, ret.invoiceId), eq(salesInvoicesTable.companyId, cid)));
      if (srcInv) {
        const patch: any = {};
        if (!ret.salesAccountId     && srcInv.salesAccountId)     { patch.salesAccountId     = srcInv.salesAccountId;     ret.salesAccountId     = srcInv.salesAccountId; }
        if (!ret.cogsAccountId      && srcInv.cogsAccountId)      { patch.cogsAccountId      = srcInv.cogsAccountId;      ret.cogsAccountId      = srcInv.cogsAccountId; }
        if (!ret.taxAccountId       && srcInv.taxAccountId)       { patch.taxAccountId       = srcInv.taxAccountId;       ret.taxAccountId       = srcInv.taxAccountId; }
        if (!ret.discountAccountId  && srcInv.discountAccountId)  { patch.discountAccountId  = srcInv.discountAccountId;  ret.discountAccountId  = srcInv.discountAccountId; }
        if (Object.keys(patch).length) {
          await db.update(salesReturnsTable).set(patch).where(eq(salesReturnsTable.id, id));
        }
      }
    }
    // Sales-return mappings fall back to sales-invoice mappings when the company
    // hasn't configured a separate set for returns (a return naturally reverses
    // the same accounts that the original sale used).
    const mapSr = await loadMappings(cid, "sales_return");
    const mapSi = await loadMappings(cid, "sales_invoice");
    const salesAccId    = pickAccount(ret.salesAccountId,    mapSr("sales_return", "revenue")    ?? mapSi("sales_invoice", "revenue"));
    const cogsAccId     = pickAccount(ret.cogsAccountId,     mapSr("sales_return", "cogs")       ?? mapSi("sales_invoice", "cogs"));
    const taxAccId      = pickAccount(ret.taxAccountId,      mapSr("sales_return", "vat_output") ?? mapSi("sales_invoice", "vat_output"));
    const discountAccId = pickAccount(ret.discountAccountId, mapSr("sales_return", "discount")   ?? mapSi("sales_invoice", "discount"));
    if (!salesAccId) { res.status(400).json({ error: "لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)" }); return; }
    if (!cogsAccId)  { res.status(400).json({ error: "لم يتم تحديد حساب تكلفة البضاعة المباعة (اضبطه من ربط القيود المحاسبية)" }); return; }
    // Inventory account derived from warehouse — verify each used warehouse has one
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(cogsByWarehouse)) {
      if (amt <= 0) continue;
      const wid = Number(widStr);
      if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
    }
    if (missingWh.length) {
      res.status(400).json({ error: `لم يتم ربط حساب محاسبي للمخزن/المخازن التالية: ${missingWh.join("، ")}.` });
      return;
    }

    const totalAmt      = Number(ret.totalAmount || 0);
    const vatAmt        = Number(ret.vatAmount || 0);
    const headerDiscAmt = Number(ret.discountAmount || 0);

    // Mirror the sales-invoice posting: roll per-line discount % into a single
    // "عكس خصم مسموح به" credit so a return that was billed with a Buy-X-Get-Y
    // / line-pricing promotion reverses the discount account too — instead of
    // letting the saving silently shrink the revenue-reversal debit. Net of
    // VAT when prices were VAT-inclusive so the existing VAT line stays
    // untouched.
    const priceIncludesVat = !!(ret as any).priceIncludesVat;
    let lineDiscountTotal = 0;
    for (const ln of lines) {
      const qty     = Number(ln.qty)       || 0;
      const price   = Number(ln.unitPrice) || 0;
      const discPct = Number(ln.discount)  || 0;
      const discAmt = Number((ln as any).discountAmount) || 0;
      if (qty <= 0 || price <= 0) continue;
      const grossPre = qty * price;
      const discGross = Math.min(grossPre, grossPre * (discPct / 100) + discAmt);
      if (discGross <= 0) continue;
      const rate    = (Number(ln.vatRate) || 0) / 100;
      lineDiscountTotal += priceIncludesVat && rate > -1
        ? discGross / (1 + rate)
        : discGross;
    }
    lineDiscountTotal = Math.round(lineDiscountTotal * 100) / 100;

    // returns table has no stored subtotal — derive the gross-before-discount
    // figure (the value that originally hit "إيرادات المبيعات" on the sale)
    // from total + headerDisc − vat, then add the line-level rollup so the
    // revenue debit matches what the sales JE credited gross.
    const baseSubtotalAmt  = totalAmt + headerDiscAmt - vatAmt;
    const subtotalAmt      = baseSubtotalAmt + lineDiscountTotal;
    const discountAmt      = headerDiscAmt + lineDiscountTotal;

    const partyAccountId =
      ret.paymentType === "cash" ? await getCashBoxAccountId(cid, ret.cashBoxId)
      : ret.paymentType === "bank" ? await getBankAccountAccountId(cid, (ret as any).bankAccountId)
      : await getCustomerAccountId(cid, ret.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error:
        ret.paymentType === "cash" ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : ret.paymentType === "bank" ? "الحساب البنكي لا يحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط" });
      return;
    }
    if (vatAmt > 0 && !taxAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب ضريبة القيمة المضافة مخرجات (اضبطه من ربط القيود المحاسبية)" }); return;
    }
    if (discountAmt > 0 && !discountAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب الخصم المسموح به (اضبطه من ربط القيود المحاسبية)" }); return;
    }

    const journalId = await createJournalEntry({
      companyId: cid,
      audit: { req },
      branchId: ret.branchId,
      date: ret.returnDate,
      docNumber: ret.docNumber,
      entryType: "sales_return",
      exchangeRate: ret.exchangeRate,
      // Inherit cost center from the original invoice when set so the
      // return tags the same CC as the sale it reverses.
      costCenter: (ret as any).costCenter ?? null,
      description: `قيد مرتجع مبيعات رقم ${ret.docNumber || ret.id}`,
      lines: [
        // Debits (reversed from the original sale)
        { accountId: salesAccId,     debit: subtotalAmt, description: "تخفيض إيراد المبيعات (مرتجع)" },
        { accountId: taxAccId,       debit: vatAmt,      description: "تخفيض ضريبة المخرجات" },
        // Inventory: one debit line per warehouse using its own GL account
        ...Object.entries(cogsByWarehouse)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              debit: amt,
              description: `زيادة المخزون (مرتجع) — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          }),
        // Credits (reversed from the original sale)
        { accountId: partyAccountId,    credit: totalAmt,    description: ret.paymentType === "cash" ? "رد نقدي" : ret.paymentType === "bank" ? "رد بنكي" : "تخفيض ذمم العميل" },
        { accountId: discountAccId,     credit: discountAmt, description: "عكس خصم مسموح به (مرتجع)" },
        { accountId: cogsAccId,         credit: totalCogs,   description: "عكس تكلفة البضاعة المباعة" },
      ],
    });

    const [updated] = await db.update(salesReturnsTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(salesReturnsTable.id, id))
      .returning();

    // NOTE: لا نُنشئ سند صرف تلقائياً عند ترحيل مرتجع نقدي/بنكي.
    // القيد المحاسبي أعلاه يكفي لتسجيل الأثر النقدي؛ سند الصرف يُنشأ يدوياً عند الحاجة.

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST sales return (فك الترحيل) ───────────────────────────────────────
router.patch("/sales-returns/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard (mirrors /post above).
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.id, id),
        eq(salesReturnsTable.companyId, cid),
        ...branchScopeSpread(req, salesReturnsTable.branchId, undefined),
      ));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status !== "posted") { res.status(400).json({ error: "المرتجع ليس مُرحَّلاً" }); return; }

    const ledger = await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "sales_return"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty); // positive on return; subtracting removes the addition
      const [bal] = await db.select().from(stockBalanceTable)
        .where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, row.itemId),
          eq(stockBalanceTable.warehouseId, row.warehouseId),
        ));
      if (bal) {
        await db.update(stockBalanceTable)
          .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
          .where(eq(stockBalanceTable.id, bal.id));
      }
    }
    await db.delete(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "sales_return"),
        eq(stockLedgerTable.refId, id),
      ));

    if (ret.journalEntryId) {
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, ret.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(salesReturnsTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(salesReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/sales-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف مرتجع مُرحَّل. قم بإلغاء الترحيل أولاً ثم احذفه." });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "sales_return", refId: id, journalEntryId: (ret as any).journalEntryId });
    await db.delete(salesReturnsTable).where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SALES QUOTATIONS (Price Quotations)
// ═══════════════════════════════════════════════
router.get("/sales-quotations", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesQuotationsTable)
      .where(eq(salesQuotationsTable.companyId, cid))
      .orderBy(desc(salesQuotationsTable.quotationDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    const lines = await db.select().from(salesQuotationLinesTable)
      .where(eq(salesQuotationLinesTable.quotationId, id))
      .orderBy(asc(salesQuotationLinesTable.id));
    res.json({ ...q, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

function mapQuotationLine(l: any, quotationId: number, cid: number, fallbackRate = "15") {
  return {
    quotationId, companyId: cid,
    itemId:    l.itemId   ? Number(l.itemId)   : null,
    itemName:  l.itemName,
    itemCode:  l.itemCode || null,
    unit:      l.unit     || null,
    unitId:    l.unitId   ? Number(l.unitId)   : null,
    qty:       String(l.qty       || "1"),
    freeQty:   String(l.freeQty   || "0"),
    unitPrice: String(l.unitPrice || "0"),
    discount:  String(l.discount  || "0"),
    discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
    vatRate:   String(l.vatRate   || fallbackRate),
    lineTotal: String(l.lineTotal || "0"),
    notes:     l.notes || null,
  };
}

router.post("/sales-quotations", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, quotationDate, validUntil, customerId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines, taxId } = req.body;
    if (!quotationDate) { res.status(400).json({ error: "تاريخ العرض مطلوب" }); return; }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const [q] = await db.insert(salesQuotationsTable).values({
      companyId: cid, docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      status: "draft", notes: notes || null,
      taxId: taxId ? Number(taxId) : null,
    }).returning();
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(salesQuotationLinesTable).values(lines.map((l: any) => mapQuotationLine(l, q.id, cid, resolvedRate)));
    }
    res.status(201).json(q);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { docNumber, quotationDate, validUntil, customerId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines, taxId } = req.body;
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const [q] = await db.update(salesQuotationsTable).set({
      docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      notes: notes || null, updatedAt: new Date(),
      taxId: taxId ? Number(taxId) : null,
    }).where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid))).returning();
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (lines !== undefined) {
      await db.delete(salesQuotationLinesTable).where(eq(salesQuotationLinesTable.quotationId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        await db.insert(salesQuotationLinesTable).values(lines.map((l: any) => mapQuotationLine(l, id, cid, resolvedRate)));
      }
    }
    res.json(q);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/sales-quotations/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!["draft","sent","accepted","rejected","converted"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    if (status === "converted") {
      res.status(400).json({ error: "استخدم مسار التحويل لإصدار الفاتورة" }); return;
    }
    const [current] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    const allowed: Record<string, string[]> = {
      draft:     ["sent", "accepted", "rejected"],
      sent:      ["accepted", "rejected"],
      accepted:  [],
      rejected:  [],
      converted: [],
    };
    if (!allowed[current.status ?? "draft"]?.includes(status)) {
      res.status(400).json({ error: `لا يمكن الانتقال من ${current.status} إلى ${status}` });
      return;
    }
    const [row] = await db.update(salesQuotationsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Convert quotation → sales invoice (draft)
router.post("/sales-quotations/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (q.convertedInvoiceId) { res.status(400).json({ error: "تم التحويل مسبقاً" }); return; }
    if (q.status !== "accepted") {
      res.status(400).json({ error: "يجب قبول العرض قبل التحويل لفاتورة" }); return;
    }

    const lines = await db.select().from(salesQuotationLinesTable)
      .where(eq(salesQuotationLinesTable.quotationId, id));

    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, docNumber: null, invoiceDate: new Date().toISOString().slice(0,10),
      customerId: q.customerId, paymentType: "credit",
      currencyCode: q.currencyCode, exchangeRate: q.exchangeRate,
      subtotal: q.subtotal, vatAmount: q.vatAmount,
      discountAmount: q.discountAmount, totalAmount: q.totalAmount,
      priceIncludesVat: q.priceIncludesVat,
      status: "draft", notes: `محوّل من عرض السعر ${q.docNumber ?? `SQ-${q.id}`}`,
      createdById: req.authUser?.id ?? null,
      taxId: (q as any).taxId ?? null,
    }).returning();

    if (lines.length) {
      await db.insert(salesInvoiceLinesTable).values(lines.map(l => ({
        invoiceId: inv.id, companyId: cid,
        itemId: l.itemId, itemName: l.itemName, itemCode: l.itemCode,
        unit: l.unit, unitId: l.unitId, warehouseId: null,
        qty: l.qty, freeQty: l.freeQty, unitPrice: l.unitPrice, discount: l.discount,
        discountAmount: String(Math.max(0, Number((l as any).discountAmount) || 0)),
        vatRate: l.vatRate, lineTotal: l.lineTotal, notes: l.notes,
      })));
    }

    await db.update(salesQuotationsTable)
      .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
      .where(eq(salesQuotationsTable.id, id));

    res.json({ quotation: q, invoice: inv });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(salesQuotationsTable).where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SALES ORDERS (أوامر البيع)
// ═══════════════════════════════════════════════
// Pre-invoice commitment document — a sales order represents an agreed
// transaction with a customer that has NOT YET become a financial event.
//
// CRITICAL: every endpoint here is FINANCE-FREE. We MUST NOT:
//   • create journal entries (no `createJournalEntry` calls)
//   • move stock (`stock_balance` / `stock_ledger` are off-limits)
//   • create receipt vouchers / payment vouchers
//   • update customer balance
//   • submit to ZATCA
//
// The order only "becomes real" via /sales-orders/:id/convert which spawns
// a DRAFT sales invoice — and that invoice goes through the normal posting
// flow when the user explicitly posts it. Up until then, an order is just
// a planning document.
function mapOrderLine(l: any, orderId: number, cid: number, fallbackRate = "15") {
  return {
    orderId, companyId: cid,
    itemId:           l.itemId      ? Number(l.itemId)      : null,
    itemName:         l.itemName,
    itemCode:         l.itemCode    || null,
    unit:             l.unit        || null,
    unitId:           l.unitId      ? Number(l.unitId)      : null,
    conversionFactor: String(l.conversionFactor || "1"),
    warehouseId:      l.warehouseId ? Number(l.warehouseId) : null,
    qty:              String(l.qty       || "1"),
    freeQty:          String(l.freeQty   || "0"),
    unitPrice:        String(l.unitPrice || "0"),
    discount:         String(l.discount  || "0"),
    discountAmount:   String(Math.max(0, Number(l.discountAmount) || 0)),
    vatRate:          String(l.vatRate   || fallbackRate),
    lineTotal:        String(l.lineTotal || "0"),
    notes:            l.notes || null,
  };
}

router.get("/sales-orders", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesOrdersTable)
      .where(eq(salesOrdersTable.companyId, cid))
      .orderBy(desc(salesOrdersTable.orderDate), desc(salesOrdersTable.id));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/sales-orders/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [o] = await db.select().from(salesOrdersTable)
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    if (!o) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }
    const lines = await db.select().from(salesOrderLinesTable)
      .where(eq(salesOrderLinesTable.orderId, id))
      .orderBy(asc(salesOrderLinesTable.id));
    res.json({ ...o, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/sales-orders", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, orderDate, expectedDeliveryDate, customerId, branchId,
            paymentType, cashBoxId, bankAccountId, salesRepId,
            currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
            totalAmount, priceIncludesVat, notes, lines, taxId } = req.body;
    if (!orderDate) { res.status(400).json({ error: "تاريخ أمر البيع مطلوب" }); return; }
    const pType = paymentType || "credit";
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);

    // Allocate document number from the central sequence engine when an
    // active "sales_order" sequence exists; otherwise fall back to whatever
    // the client typed (legacy free-numbering). Same atomic FOR-UPDATE
    // pattern as invoices — two concurrent saves can never collide.
    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "sales_order", {
        userId:   req.authUser?.id ?? null,
        refTable: "sales_orders",
        branchId: branchId ? Number(branchId) : null,
        docDate:  orderDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم أمر البيع" });
      return;
    }

    const [o] = await db.insert(salesOrdersTable).values({
      companyId: cid,
      branchId:             branchId ? Number(branchId) : null,
      docNumber:            resolvedDocNumber,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      customerId:           customerId ? Number(customerId) : null,
      paymentType:          pType,
      // Stored informationally so the converted invoice can pre-fill them.
      // No financial action is taken at order save time.
      cashBoxId:            pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId:        pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      salesRepId:           salesRepId ? Number(salesRepId) : null,
      currencyCode:         currencyCode || "SAR",
      exchangeRate:         String(exchangeRate || "1"),
      subtotal:             totals.subtotal,
      vatAmount:            totals.vatAmount,
      discountAmount:       totals.discountAmount,
      totalAmount:          totals.totalAmount,
      priceIncludesVat:     asBool(priceIncludesVat),
      status:               "draft",
      notes:                notes || null,
      taxId:                taxId ? Number(taxId) : null,
      createdById:          req.authUser?.id ?? null,
    }).returning();

    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(salesOrderLinesTable).values(
        lines.map((l: any) => mapOrderLine(l, o.id, cid, resolvedRate))
      );
    }

    // INTENTIONALLY NO: journal entry, stock movement, receipt voucher,
    // ZATCA submission, or customer balance update.
    res.status(201).json(o);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/sales-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Lock down once an order has been converted to an invoice — editing
    // the source document after conversion would let the user retroactively
    // change what the invoice was based on. Cancelled orders are also
    // immutable to keep the audit trail honest.
    const [existing] = await db.select({ status: salesOrdersTable.status, convertedInvoiceId: salesOrdersTable.convertedInvoiceId })
      .from(salesOrdersTable)
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }
    if (existing.status === "converted" || existing.convertedInvoiceId) {
      res.status(409).json({ error: "لا يمكن تعديل أمر بيع تم تحويله إلى فاتورة" }); return;
    }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "لا يمكن تعديل أمر بيع ملغى" }); return;
    }

    const { docNumber, orderDate, expectedDeliveryDate, customerId, branchId,
            paymentType, cashBoxId, bankAccountId, salesRepId,
            currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
            totalAmount, priceIncludesVat, notes, lines, taxId } = req.body;
    const pType = paymentType || "credit";
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);

    const [o] = await db.update(salesOrdersTable).set({
      docNumber:            docNumber || null,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      customerId:           customerId ? Number(customerId) : null,
      branchId:             branchId ? Number(branchId) : null,
      paymentType:          pType,
      cashBoxId:            pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId:        pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      salesRepId:           salesRepId ? Number(salesRepId) : null,
      currencyCode:         currencyCode || "SAR",
      exchangeRate:         String(exchangeRate || "1"),
      subtotal:             totals.subtotal,
      vatAmount:            totals.vatAmount,
      discountAmount:       totals.discountAmount,
      totalAmount:          totals.totalAmount,
      priceIncludesVat:     asBool(priceIncludesVat),
      notes:                notes || null,
      updatedAt:            new Date(),
      taxId:                taxId ? Number(taxId) : null,
    }).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid))).returning();
    if (!o) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }

    if (lines !== undefined) {
      await db.delete(salesOrderLinesTable).where(eq(salesOrderLinesTable.orderId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        await db.insert(salesOrderLinesTable).values(
          lines.map((l: any) => mapOrderLine(l, id, cid, resolvedRate))
        );
      }
    }
    res.json(o);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Status transitions for sales orders. The "converted" status is set
// exclusively by /convert — clients cannot transition to it directly.
router.patch("/sales-orders/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!["draft","confirmed","cancelled"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    const [current] = await db.select().from(salesOrdersTable)
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }
    if (current.status === "converted") {
      res.status(400).json({ error: "لا يمكن تغيير حالة أمر بيع مُحوَّل" }); return;
    }
    const allowed: Record<string, string[]> = {
      draft:     ["confirmed", "cancelled"],
      confirmed: ["cancelled"],
      cancelled: [],
      converted: [],
    };
    if (!allowed[current.status ?? "draft"]?.includes(status)) {
      res.status(400).json({ error: `لا يمكن الانتقال من ${current.status} إلى ${status}` });
      return;
    }
    const [row] = await db.update(salesOrdersTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Convert sales order → DRAFT sales invoice.
// Carries over the order's payment type / branch / sales rep so the
// resulting invoice is a one-click post away. Marks the source order as
// "converted" and records the new invoice id for audit / display.
router.post("/sales-orders/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [o] = await db.select().from(salesOrdersTable)
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    if (!o) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }
    if (o.convertedInvoiceId) { res.status(400).json({ error: "تم التحويل مسبقاً" }); return; }
    if (o.status !== "confirmed") {
      res.status(400).json({ error: "يجب تأكيد أمر البيع قبل تحويله إلى فاتورة" }); return;
    }

    const lines = await db.select().from(salesOrderLinesTable)
      .where(eq(salesOrderLinesTable.orderId, id));

    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId:        cid,
      branchId:         o.branchId,
      docNumber:        null,
      invoiceDate:      new Date().toISOString().slice(0, 10),
      customerId:       o.customerId,
      paymentType:      o.paymentType ?? "credit",
      cashBoxId:        o.cashBoxId,
      bankAccountId:    o.bankAccountId,
      currencyCode:     o.currencyCode,
      exchangeRate:     o.exchangeRate,
      subtotal:         o.subtotal,
      vatAmount:        o.vatAmount,
      discountAmount:   o.discountAmount,
      totalAmount:      o.totalAmount,
      priceIncludesVat: o.priceIncludesVat,
      status:           "draft",
      notes:            `محوّل من أمر البيع ${o.docNumber ?? `SO-${o.id}`}`,
      createdById:      req.authUser?.id ?? null,
      salesRepId:       o.salesRepId,
      taxId:            (o as any).taxId ?? null,
    }).returning();

    if (lines.length) {
      await db.insert(salesInvoiceLinesTable).values(lines.map(l => ({
        invoiceId:        inv.id,
        companyId:        cid,
        itemId:           l.itemId,
        itemName:         l.itemName,
        itemCode:         l.itemCode,
        unit:             l.unit,
        unitId:           l.unitId,
        conversionFactor: l.conversionFactor,
        warehouseId:      l.warehouseId,
        qty:              l.qty,
        freeQty:          l.freeQty,
        unitPrice:        l.unitPrice,
        discount:         l.discount,
        discountAmount:   String(Math.max(0, Number((l as any).discountAmount) || 0)),
        vatRate:          l.vatRate,
        lineTotal:        l.lineTotal,
        notes:            l.notes,
      })));
    }

    await db.update(salesOrdersTable)
      .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
      .where(eq(salesOrdersTable.id, id));

    res.json({ order: o, invoice: inv });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/sales-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Block deletion once converted to keep the FK chain to the spawned
    // invoice intact (and the audit trail meaningful).
    const [existing] = await db.select({ convertedInvoiceId: salesOrdersTable.convertedInvoiceId })
      .from(salesOrdersTable)
      .where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر البيع غير موجود" }); return; }
    if (existing.convertedInvoiceId) {
      res.status(409).json({ error: "لا يمكن حذف أمر بيع تم تحويله إلى فاتورة" }); return;
    }
    await db.delete(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// CUSTOMER SETTLEMENTS
// ═══════════════════════════════════════════════
router.get("/customer-settlements", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(customerSettlementsTable)
      .where(eq(customerSettlementsTable.companyId, cid))
      .orderBy(desc(customerSettlementsTable.settlementDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/customer-settlements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, settlementDate, customerId, paymentMethod, accountId,
            amount, currencyCode, exchangeRate, notes } = req.body;
    if (!settlementDate || !amount) {
      res.status(400).json({ error: "التاريخ والمبلغ مطلوبان" }); return;
    }
    const [row] = await db.insert(customerSettlementsTable).values({
      companyId: cid, docNumber: docNumber || null, settlementDate,
      customerId: customerId ? Number(customerId) : null,
      paymentMethod: paymentMethod || "bank",
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount), currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      status: "draft", notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/customer-settlements/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(customerSettlementsTable)
      .set({ status: "posted", updatedAt: new Date() })
      .where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Mirrors the unpost flow on sales-invoices / sales-returns: admin-only,
// flips status back to draft so the user can edit or delete the row.
// Without this the DELETE guard above would be a dead-end for posted rows.
router.patch("/customer-settlements/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(customerSettlementsTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/customer-settlements/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Posted-status guard — same rule as every other financial doc:
    // a posted settlement cannot be deleted. The user must unpost it
    // first so the audit trail and ledger stay consistent.
    const [existing] = await db.select({ status: customerSettlementsTable.status })
      .from(customerSettlementsTable)
      .where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    if (existing.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف تسوية مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    await db.delete(customerSettlementsTable).where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// ZATCA — Submit a back-office sales invoice for clearance/reporting.
// REAL pipeline (no more local "approved" mock): local BR-KSA rules run as a
// PRE-FLIGHT only (cheap rejection before hitting ZATCA). The actual verdict
// comes from the ZATCA gateway. Requires the company's signing key + a CSID
// (PCSID preferred) — without onboarding the invoice cannot be submitted.
// Standard (B2B, customer has 15-digit VAT) → clearance; simplified → reporting.
// ═══════════════════════════════════════════════════════════════════
router.post("/sales-invoices/:id/zatca-submit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }

    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id));

    // Tenant-scoped customer lookup: must belong to same company
    const customer = inv.customerId
      ? (await db.select().from(customersTable).where(and(
          eq(customersTable.id, inv.customerId),
          eq(customersTable.companyId, cid),
        )))[0] ?? null
      : null;

    // ─── PRE-FLIGHT: local BR-KSA validation (cheap reject before ZATCA) ──
    const errors: { code: string; message: string; field?: string }[] = [];
    const warnings: { code: string; message: string }[] = [];

    if (inv.status !== "posted") {
      errors.push({ code: "BR-KSA-DRAFT", message: "لا يمكن إرسال فاتورة في حالة مسودة (draft) إلى الزكاة. يجب ترحيل الفاتورة أولاً." });
    }
    if (!lines.length) {
      errors.push({ code: "BR-KSA-LINES", message: "الفاتورة لا تحتوي على أي بنود. يجب إضافة بند واحد على الأقل." });
    }
    if (Number(inv.totalAmount || 0) <= 0) {
      errors.push({ code: "BR-KSA-AMOUNT", message: "إجمالي الفاتورة يجب أن يكون أكبر من صفر." });
    }

    // VAT consistency: subtotal * 0.15 should ≈ vatAmount (within 0.5 SAR tolerance)
    const subtotalNet = Number(inv.subtotal || 0) - Number(inv.discountAmount || 0);
    const expectedVat = Math.round(subtotalNet * 0.15 * 100) / 100;
    const declaredVat = Number(inv.vatAmount || 0);
    if (Math.abs(expectedVat - declaredVat) > 0.5) {
      errors.push({
        code: "BR-KSA-VAT-CALC",
        message: `قيمة ضريبة القيمة المضافة غير متطابقة. المتوقع ${expectedVat.toFixed(2)} ريال (15% من الصافي ${subtotalNet.toFixed(2)})، ولكن المسجل في الفاتورة ${declaredVat.toFixed(2)} ريال.`,
      });
    }

    // Customer rules — if total > 1000 SAR a customer is required for B2B clearance flow
    if (Number(inv.totalAmount || 0) >= 1000 && !customer) {
      errors.push({ code: "BR-KSA-CUSTOMER", message: "الفواتير التي يبلغ إجماليها 1000 ريال أو أكثر تتطلب تحديد العميل (فاتورة ضريبية)." });
    }
    // If customer exists and has VAT (B2B), require valid 15-digit VAT and address
    if (customer?.vatNumber) {
      const vat = String(customer.vatNumber).replace(/\D/g, "");
      if (vat.length !== 15 || !vat.startsWith("3") || !vat.endsWith("3")) {
        errors.push({ code: "BR-KSA-CUST-VAT", message: `الرقم الضريبي للعميل (${customer.vatNumber}) غير صحيح. يجب أن يتكوّن من 15 رقماً يبدأ وينتهي بالرقم 3.` });
      }
      if (!customer.city || !customer.street || !customer.buildingNumber || !customer.postalCode) {
        errors.push({
          code: "BR-KSA-CUST-ADDR",
          message: "العنوان الوطني للعميل (المدينة، الشارع، رقم المبنى، الرمز البريدي) مطلوب للفاتورة الضريبية المعيارية (B2B).",
        });
      }
    }

    // Warnings (non-blocking)
    if (lines.some((l: any) => !l.itemCode)) {
      warnings.push({ code: "WARN-ITEM-CODE", message: "بعض البنود لا تحتوي على كود الصنف. يُفضّل تحديد الكود لكل بند." });
    }
    if (!inv.docNumber) {
      warnings.push({ code: "WARN-DOC-NUM", message: "رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي." });
    }

    const now = new Date();
    if (errors.length > 0) {
      await db.update(salesInvoicesTable).set({
        zatcaStatus: "rejected",
        zatcaSubmittedAt: now,
        zatcaUuid: null,                // clear any prior approval UUID
        zatcaResponseCode: "400",
        zatcaErrorMessages: JSON.stringify(errors),
        zatcaWarningMessages: warnings.length ? JSON.stringify(warnings) : null,
        zatcaAiSuggestion: null,        // reset cached AI explanation
        updatedAt: now,
      }).where(eq(salesInvoicesTable.id, id));
      res.json({ status: "rejected", errors, warnings });
      return;
    }

    // ─── Company onboarding gate: need a signing key + a CSID/PCSID ──────
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, cid));
    if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    const authToken = company.zatcaPcsidToken ?? company.zatcaCsidToken;
    const authSecret = company.zatcaPcsidSecret ?? company.zatcaCsidSecret;
    if (!authToken || !authSecret) {
      res.status(400).json({
        error: "لا توجد شهادة ZATCA. يجب إتمام التسجيل والحصول على CSID/PCSID أولاً.",
        hint: "اذهب لصفحة الشركة → تبويب الشهادة → استخراج CSID ثم PCSID.",
      });
      return;
    }
    if (!company.zatcaPrivateKey) {
      res.status(400).json({
        error: "المفتاح الخاص غير متوفر. لا يمكن توقيع الفاتورة.",
        hint: "أعد توليد CSR والحصول على الشهادة (CSID/PCSID).",
      });
      return;
    }

    // ─── ICV / PIH chain (scoped to this company's sales invoices) ───────
    const [{ maxIcv }] = await db
      .select({ maxIcv: sql<number>`COALESCE(MAX(${salesInvoicesTable.zatcaIcv}), 0)` })
      .from(salesInvoicesTable)
      .where(eq(salesInvoicesTable.companyId, cid));
    const invoiceCounterValue = Number(maxIcv ?? 0) + 1;

    const [prevHashRow] = await db
      .select({ hash: salesInvoicesTable.invoiceHash })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        sql`${salesInvoicesTable.invoiceHash} IS NOT NULL`,
      ))
      .orderBy(desc(salesInvoicesTable.zatcaIcv), desc(salesInvoicesTable.id))
      .limit(1);
    const previousInvoiceHash = prevHashRow?.hash || GENESIS_HASH;

    const issueTime = now.toTimeString().split(" ")[0];
    const mapped = salesInvoiceRowToZatcaData(inv, lines, company, customer, {
      invoiceCounterValue,
      previousInvoiceHash,
      issueTime,
    });

    // Fail loud on any reconciliation drift between the per-line construction
    // and the stored header total — better than submitting a doc ZATCA rejects
    // opaquely. Tolerance scales with line count (per-line rounding).
    const tolerance = 0.02 + lines.length * 0.01;
    if (Math.abs(mapped.computedGrandTotalSar - mapped.storedGrandTotalSar) > tolerance) {
      res.status(422).json({
        status: "rejected",
        errors: [{
          code: "BR-KSA-RECON",
          message: `تعذّر مطابقة إجمالي الفاتورة المحسوب (${mapped.computedGrandTotalSar.toFixed(2)} ريال) مع الإجمالي المخزّن (${mapped.storedGrandTotalSar.toFixed(2)} ريال). راجع الخصومات على مستوى المستند أو أسعار الصرف.`,
        }],
        warnings,
      });
      return;
    }

    const env = resolveZatcaEnv(company);
    const baseUrl = getZatcaBaseUrl(env);

    const built = buildSignedZatcaInvoice({
      invoiceData: mapped.data,
      certificatePem: authToken,
      privateKeyPem: company.zatcaPrivateKey,
      seller: { nameAr: company.nameAr ?? "", vatNumber: company.vatNumber ?? "" },
      qr: {
        invoiceTimestamp: `${inv.invoiceDate}T${issueTime}Z`,
        invoiceTotal: mapped.data.grandTotal,
        vatAmount: mapped.data.vatTotal,
      },
    });

    const xmlBase64 = Buffer.from(built.finalXml).toString("base64");
    const hashBase64 = built.invoiceHash;
    const uuid = inv.docNumber || `SINV-${inv.id}`;

    const endpoint = mapped.invoiceType === "simplified"
      ? `${baseUrl}/invoices/reporting/single`
      : `${baseUrl}/invoices/clearance/single`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "Authorization": "Basic " + Buffer.from(`${authToken}:${authSecret}`).toString("base64"),
        "Clearance-Status": mapped.invoiceType === "standard" ? "1" : "0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invoiceHash: hashBase64, uuid, invoice: xmlBase64 }),
    });

    const data = await response.json() as {
      reportingStatus?: string;
      clearanceStatus?: string;
      warningMessages?: Array<{ code: string; message: string }>;
      errorMessages?: Array<{ code: string; message: string }>;
    };

    // Verdict from ZATCA's real document status, never just HTTP 200.
    const clearance = (data.clearanceStatus ?? "").toUpperCase();
    const reporting = (data.reportingStatus ?? "").toUpperCase();
    const accepted = mapped.invoiceType === "simplified"
      ? reporting === "REPORTED" || reporting === "REPORTED_WITH_WARNINGS"
      : clearance === "CLEARED";
    const succeeded = response.ok && accepted;
    const newStatus = succeeded
      ? (mapped.invoiceType === "simplified" ? "reported" : "cleared")
      : "rejected";

    await db.update(salesInvoicesTable).set({
      zatcaStatus: newStatus,
      zatcaSubmittedAt: now,
      zatcaUuid: succeeded ? uuid : null,
      zatcaResponseCode: String(response.status),
      zatcaErrorMessages: data.errorMessages ? JSON.stringify(data.errorMessages) : null,
      zatcaWarningMessages: data.warningMessages ? JSON.stringify(data.warningMessages) : (warnings.length ? JSON.stringify(warnings) : null),
      zatcaAiSuggestion: null,
      xmlContent: built.finalXml,
      invoiceHash: succeeded ? built.invoiceHash : null,
      zatcaIcv: succeeded ? invoiceCounterValue : null,
      zatcaPih: previousInvoiceHash,
      updatedAt: now,
    }).where(eq(salesInvoicesTable.id, id));

    if (!succeeded) {
      res.status(response.ok ? 422 : response.status).json({
        status: "rejected",
        zatcaStatus: newStatus,
        clearanceStatus: data.clearanceStatus,
        reportingStatus: data.reportingStatus,
        errors: data.errorMessages ?? [],
        warnings: data.warningMessages ?? warnings,
        zatcaResponse: data,
        hint: response.ok
          ? "قبلت بوابة ZATCA الطلب لكن لم يتم تخليص/إبلاغ الفاتورة. راجع رسائل التحقق وصحّح البيانات."
          : "راجع رسائل الخطأ من ZATCA وتحقق من صحة بيانات الفاتورة.",
      });
      return;
    }

    res.json({
      status: succeeded ? (mapped.invoiceType === "simplified" ? "reported" : "cleared") : "rejected",
      uuid,
      zatcaStatus: newStatus,
      clearanceStatus: data.clearanceStatus,
      reportingStatus: data.reportingStatus,
      warnings: data.warningMessages ?? warnings,
      message: mapped.invoiceType === "simplified"
        ? "تم إبلاغ ZATCA بالفاتورة المبسطة بنجاح."
        : "تم تخليص الفاتورة الضريبية بنجاح.",
    });
  } catch (e: any) {
    res.status(500).json({ error: "فشل الاتصال بـ ZATCA", details: e?.message ?? String(e) });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ZATCA — Bridge view: list sales invoices joined with customer name
// for the Customer/Sales ↔ ZATCA bridge screen.
// ═══════════════════════════════════════════════════════════════════
router.get("/sales-invoices-zatca-bridge", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const bidRaw = req.query.branchId;
    const bid = (bidRaw === undefined || bidRaw === null || bidRaw === "")
      ? undefined
      : (Number.isFinite(Number(bidRaw)) && Number(bidRaw) > 0 ? Number(bidRaw) : undefined);
    const rows = await db.select({
      id:                   salesInvoicesTable.id,
      docNumber:            salesInvoicesTable.docNumber,
      invoiceDate:          salesInvoicesTable.invoiceDate,
      customerId:           salesInvoicesTable.customerId,
      customerNameAr:       customersTable.nameAr,
      customerVatNumber:    customersTable.vatNumber,
      totalAmount:          salesInvoicesTable.totalAmount,
      vatAmount:            salesInvoicesTable.vatAmount,
      status:               salesInvoicesTable.status,
      zatcaStatus:          salesInvoicesTable.zatcaStatus,
      zatcaSubmittedAt:     salesInvoicesTable.zatcaSubmittedAt,
      zatcaUuid:            salesInvoicesTable.zatcaUuid,
      zatcaErrorMessages:   salesInvoicesTable.zatcaErrorMessages,
      zatcaWarningMessages: salesInvoicesTable.zatcaWarningMessages,
      zatcaResponseCode:    salesInvoicesTable.zatcaResponseCode,
    })
      .from(salesInvoicesTable)
      // Tenant-scoped join: only join customers in the SAME company
      .leftJoin(customersTable, and(
        eq(salesInvoicesTable.customerId, customersTable.id),
        eq(customersTable.companyId, cid),
      ))
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ))
      .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

export default router;
