import { Router } from "express";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import {
  journalEntriesTable, journalEntryLinesTable, branchesTable, usersTable,
  salesInvoicesTable, salesReturnsTable, customerSettlementsTable,
  purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable,
  receiptVouchersTable, paymentVouchersTable,
  receiptVoucherLinesTable, paymentVoucherLinesTable,
  stockTransfersTable, stockAdjustmentsTable,
  payrollRunsTable, employeeLoansTable,
  fixedAssetsTable, faDepreciationRunsTable,
  accountingAdjustmentRunsTable,
} from "@workspace/db";
import { unpostDepreciationRun } from "../lib/depreciationPosting.js";
import { unpostAdjustmentRunJe, syncAdjustmentRunAmountForJe } from "../lib/adjustmentPosting.js";
import { eq, and, desc, sql, inArray, notInArray, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId, intersectBranchRequest, branchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate, assertWritableForPeriodId } from "../lib/periodGuard.js";
import { createdAuditFor, postedAuditFor, fullAuditFor } from "../lib/journalAudit.js";
import { describeDevice } from "../lib/deviceFingerprint.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import {
  assertJeSettlementAllowed, acquireSettlementLock,
  invoiceNetDueBase, sumVouchersForInvoice, sumSettlementJEs,
  type SettlementKind,
} from "../lib/invoiceSettlement.js";
import { customersTable, suppliersTable } from "@workspace/db";

// ── سداد فاتورة عن طريق القيد ─────────────────────────────────────────────
// Parse + normalize the optional invoice-settlement link on a manual JE.
// Exactly ONE of salesInvoiceId / purchaseInvoiceId may be set, and then a
// positive settlementAmount (in the entry's currency) is required.
function parseJeSettlement(body: any): {
  salesInvoiceId: number | null;
  purchaseInvoiceId: number | null;
  settlementAmount: string | null;
} {
  const sid = body?.salesInvoiceId != null && String(body.salesInvoiceId).trim() !== ""
    ? Number(body.salesInvoiceId) : null;
  const pid = body?.purchaseInvoiceId != null && String(body.purchaseInvoiceId).trim() !== ""
    ? Number(body.purchaseInvoiceId) : null;
  if (sid != null && (!Number.isInteger(sid) || sid <= 0)) throw new Error("معرّف فاتورة المبيعات غير صالح");
  if (pid != null && (!Number.isInteger(pid) || pid <= 0)) throw new Error("معرّف فاتورة المشتريات غير صالح");
  if (sid != null && pid != null) throw new Error("لا يمكن ربط القيد بفاتورة مبيعات وفاتورة مشتريات معاً");
  if (sid == null && pid == null) return { salesInvoiceId: null, purchaseInvoiceId: null, settlementAmount: null };
  const amt = parseFloat(String(body?.settlementAmount ?? "")) || 0;
  if (!(amt > 0)) throw new Error("مبلغ السداد مطلوب عند ربط القيد بفاتورة");
  return { salesInvoiceId: sid, purchaseInvoiceId: pid, settlementAmount: amt.toFixed(2) };
}

// Validate the settlement link against the tenant + overpayment policy.
async function validateJeSettlement(
  cid: number,
  s: { salesInvoiceId: number | null; purchaseInvoiceId: number | null; settlementAmount: string | null },
  exchangeRate: any,
  excludeJeId: number | null,
  lines?: any[],
): Promise<void> {
  if (!s.salesInvoiceId && !s.purchaseInvoiceId) return;
  const kind: SettlementKind = s.salesInvoiceId ? "sales" : "purchase";
  const invId = (s.salesInvoiceId ?? s.purchaseInvoiceId)!;
  const rate = parseFloat(String(exchangeRate ?? "1")) || 1;
  const amt = parseFloat(String(s.settlementAmount)) || 0;
  // مبلغ السداد can never exceed the JE's own debit total (entry currency):
  // the invoice can't be "paid" more than the entry actually posts. The cap
  // is UNCONDITIONAL — when the payload has no lines (e.g. PUT that keeps
  // the existing lines), fall back to the PERSISTED lines of this entry.
  let totalDebit: number;
  if (Array.isArray(lines)) {
    totalDebit = lines.reduce(
      (sum, l) => sum + (parseFloat(String(l?.debit ?? "0")) || 0), 0);
  } else if (excludeJeId != null) {
    const [row] = await db.select({
      sum: sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
    }).from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, excludeJeId));
    totalDebit = parseFloat(String(row?.sum ?? "0")) || 0;
  } else {
    totalDebit = 0;
  }
  if (amt > totalDebit + 0.01) {
    throw new Error(
      `مبلغ السداد (${amt.toFixed(2)}) يتجاوز إجمالي مدين القيد (${totalDebit.toFixed(2)}) — عدِّل مبلغ السداد أو سطور القيد`);
  }
  const amountBase = amt * rate;
  await assertJeSettlementAllowed(cid, kind, invId, amountBase, excludeJeId);
}

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("journal_entries"));
router.use(moduleAudit("journal_entries"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Batch size for IN-list lookups — keeps every query far below Postgres's
// 65 535 bind-parameter protocol cap even on data-heavy companies.
const IN_CHUNK = 5000;
function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return arr.length ? [arr] : [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Trim a free-text per-line supplier-tax metadata field to null when blank.
function jeTxtOrNull(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Resolves and authorizes a branchId for a journal-entry write. Mirrors the
 * payroll-runs flow:
 *   - Caller-supplied branchId is intersected against the user's allowed scope
 *     (a restricted user picking a forbidden branch is rejected with 403).
 *   - If the caller did not pick one and the user is restricted to a single
 *     branch, that branch is used implicitly so reports filtered by branch
 *     do not silently drop the entry.
 *   - The chosen branch must belong to this company (returns 400 otherwise).
 * On error the response is sent and `null` is returned (sentinel "DENY").
 */
async function resolveBranchForWrite(
  req: any, res: any, cid: number, raw: unknown,
): Promise<number | null | "DENY"> {
  const requested = (raw == null || raw === "") ? null : Number(raw);
  // Accept only positive integers — guards against NaN, decimals, negatives,
  // and Infinity all in one check.
  if (requested != null && (!Number.isInteger(requested) || requested <= 0)) {
    res.status(400).json({ error: "معرّف الفرع غير صحيح" }); return "DENY";
  }
  const intersected = intersectBranchRequest(req, requested);
  if (intersected === "deny") {
    res.status(403).json({ error: "غير مصرح بالوصول إلى هذا الفرع" }); return "DENY";
  }
  const allowed = (req as any).authUser?.branchIds as number[] | undefined;
  const viewAll = (req as any).authUser?.viewAllBranches === true
    || ["admin", "superadmin"].includes((req as any).authUser?.role);
  let resolved: number | null = null;
  if (typeof intersected === "number") {
    resolved = intersected;
  } else if (!viewAll && allowed?.length === 1) {
    resolved = allowed[0];
  }
  if (resolved != null) {
    const [br] = await db.select({ id: branchesTable.id }).from(branchesTable)
      .where(and(eq(branchesTable.id, resolved), eq(branchesTable.companyId, cid)));
    if (!br) { res.status(400).json({ error: "الفرع غير موجود في هذه الشركة" }); return "DENY"; }
  }
  return resolved;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
// Source-doc table descriptors used by the LIST endpoint to enrich each
// journal-entry row with the `sourceId` of the document that produced it.
// The match key is whichever column on the source table holds the value the
// poster wrote into `journal_entries.doc_number` (see hr-journals.ts,
// receipt-vouchers.ts, sales.ts, purchasing.ts, inventory.ts).
const SOURCE_TABLES: Record<string, { table: any; col: any }> = {
  sales_invoice:        { table: salesInvoicesTable,        col: salesInvoicesTable.docNumber },
  sales_return:         { table: salesReturnsTable,         col: salesReturnsTable.docNumber },
  customer_settlement:  { table: customerSettlementsTable,  col: customerSettlementsTable.docNumber },
  purchase_invoice:     { table: purchaseInvoicesTable,     col: purchaseInvoicesTable.docNumber },
  purchase_return:      { table: purchaseReturnsTable,      col: purchaseReturnsTable.docNumber },
  supplier_settlement:  { table: supplierSettlementsTable,  col: supplierSettlementsTable.docNumber },
  receipt:              { table: receiptVouchersTable,      col: receiptVouchersTable.code },
  receipt_voucher:      { table: receiptVouchersTable,      col: receiptVouchersTable.code },
  payment:              { table: paymentVouchersTable,      col: paymentVouchersTable.code },
  payment_voucher:      { table: paymentVouchersTable,      col: paymentVouchersTable.code },
  stock_transfer:       { table: stockTransfersTable,       col: stockTransfersTable.transferNumber },
  stock_adjustment:     { table: stockAdjustmentsTable,     col: stockAdjustmentsTable.adjustmentNumber },
  payroll_run:          { table: payrollRunsTable,          col: payrollRunsTable.code },
};

// Authoritative reverse link: source-document tables that persist the id of the
// journal entry they produced in a `journal_entry_id` column. Matching on this
// FK is far more reliable than the legacy doc_number/code match in
// SOURCE_TABLES: some companies run a SEPARATE numbering sequence for journal
// entries vs. the source voucher/document, so a JE "QYD/06/1366" never matches
// a voucher whose code is "PYB-202600015" even though they are linked. Tables
// WITHOUT this column (customer/supplier settlements, payroll runs) keep using
// the doc_number fallback; employee_loan encodes its id as "LOAN-{id}".
const REVERSE_SOURCE: Record<string, { table: any; jeCol: any }> = {
  sales_invoice:    { table: salesInvoicesTable,    jeCol: salesInvoicesTable.journalEntryId },
  sales_return:     { table: salesReturnsTable,     jeCol: salesReturnsTable.journalEntryId },
  purchase_invoice: { table: purchaseInvoicesTable, jeCol: purchaseInvoicesTable.journalEntryId },
  purchase_return:  { table: purchaseReturnsTable,  jeCol: purchaseReturnsTable.journalEntryId },
  receipt:          { table: receiptVouchersTable,  jeCol: receiptVouchersTable.journalEntryId },
  receipt_voucher:  { table: receiptVouchersTable,  jeCol: receiptVouchersTable.journalEntryId },
  payment:          { table: paymentVouchersTable,  jeCol: paymentVouchersTable.journalEntryId },
  payment_voucher:  { table: paymentVouchersTable,  jeCol: paymentVouchersTable.journalEntryId },
  stock_transfer:   { table: stockTransfersTable,   jeCol: stockTransfersTable.journalEntryId },
  stock_adjustment: { table: stockAdjustmentsTable, jeCol: stockAdjustmentsTable.journalEntryId },
};

// True when a source document that produced this JE still exists. Checks the
// authoritative reverse FK first, then the LOAN-{id} encoding, then the legacy
// doc_number/code match. ANY hit ⇒ genuinely source-backed (must be unwound
// from the source). NOTHING matches ⇒ an ORPHAN whose source document was
// deleted, leaving a locked JE stuck forever — the only case we allow to be
// converted into a general draft.
async function sourceDocExists(
  entryType: string, docNumber: string | null, jeId: number, cid: number,
): Promise<boolean> {
  const rev = REVERSE_SOURCE[entryType];
  if (rev) {
    const [hit] = await db.select({ id: (rev.table as any).id }).from(rev.table)
      .where(and(eq((rev.table as any).companyId, cid), eq(rev.jeCol, jeId)))
      .limit(1);
    if (hit) return true;
  }
  if (entryType === "employee_loan" && docNumber) {
    const m = /^LOAN-(\d+)$/.exec(docNumber);
    if (m) {
      const [hit] = await db.select({ id: employeeLoansTable.id }).from(employeeLoansTable)
        .where(and(eq(employeeLoansTable.companyId, cid), eq(employeeLoansTable.id, Number(m[1]))))
        .limit(1);
      if (hit) return true;
    }
  }
  const src = SOURCE_TABLES[entryType];
  if (src && docNumber) {
    const [hit] = await db.select({ id: (src.table as any).id }).from(src.table)
      .where(and(eq((src.table as any).companyId, cid), eq(src.col, docNumber)))
      .limit(1);
    if (hit) return true;
  }
  return false;
}

router.get("/", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    // Build the entries filter ONCE so the row fetch and the line-sum
    // aggregation below share the exact same predicate (via a subquery)
    // instead of exploding thousands of entry ids into a giant IN list.
    const whereExpr = cid
      ? and(
          eq(journalEntriesTable.companyId, cid),
          // Branch scope: a specific ?branchId yields `branch_id = X OR NULL`
          // (NULL = shared/opening/system entries visible from every branch);
          // restricted users are auto-capped to their assigned branches; an
          // admin with no branchId sees all. Without this the JE list (and the
          // Posting Center built on it) leaked every branch regardless of filter.
          ...branchScopeSpread(req, journalEntriesTable.branchId, req.query.branchId),
        )
      : undefined;
    const rows = whereExpr
      ? await db.select().from(journalEntriesTable)
          .where(whereExpr)
          .orderBy(desc(journalEntriesTable.createdAt))
      : await db.select().from(journalEntriesTable)
          .orderBy(desc(journalEntriesTable.createdAt));

    if (rows.length === 0) { res.json([]); return; }

    // 1) Aggregate debit/credit per entry in a single SQL pass instead of N+1.
    //    The scope is expressed as a SUBQUERY over the same whereExpr — on
    //    data-heavy companies the old inArray(ids) shape shipped tens of
    //    thousands of bind params per request, which both bloated the query
    //    and risked the 65 535-param protocol cap.
    const idsSubquery = whereExpr
      ? db.select({ id: journalEntriesTable.id }).from(journalEntriesTable).where(whereExpr)
      : db.select({ id: journalEntriesTable.id }).from(journalEntriesTable);
    const sums = await db.select({
      entryId:     journalEntryLinesTable.entryId,
      totalDebit:  sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}),  0)`.as("total_debit"),
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`.as("total_credit"),
    })
      .from(journalEntryLinesTable)
      .where(inArray(journalEntryLinesTable.entryId, idsSubquery))
      .groupBy(journalEntryLinesTable.entryId);
    const sumByEntry = new Map(sums.map(s => [s.entryId, s]));

    // 2) Resolve sourceId for each row by batching lookups per
    //    (entryType, companyId). Always pinning by companyId — even in
    //    superadmin all-companies mode where `cid` is undefined — guarantees
    //    a docNumber collision across tenants can never resolve to the
    //    wrong tenant's source row. `employee_loan` is a special case: the
    //    poster encodes the source id into the docNumber as "LOAN-{id}"
    //    (see hr-journals.ts), so we parse rather than query. Unknown or
    //    manually-created entry types simply get no sourceId — the
    //    frontend then renders the docNumber as plain text.
    const sourceIdByEntry = new Map<number, number>();
    const byTypeCompany = new Map<string, { docNum: string; entryId: number }[]>();
    for (const r of rows) {
      const et = r.entryType ?? "";
      const dn = r.docNumber ?? "";
      if (!dn) continue;
      if (et === "employee_loan") {
        const m = /^LOAN-(\d+)$/.exec(dn);
        if (m) sourceIdByEntry.set(r.id, Number(m[1]));
        continue;
      }
      if (!SOURCE_TABLES[et]) continue;
      const key = `${et}|${r.companyId}`;
      if (!byTypeCompany.has(key)) byTypeCompany.set(key, []);
      byTypeCompany.get(key)!.push({ docNum: dn, entryId: r.id });
    }
    for (const [key, items] of byTypeCompany) {
      const sep = key.indexOf("|");
      const et = key.slice(0, sep);
      const groupCid = Number(key.slice(sep + 1));
      const { table, col } = SOURCE_TABLES[et];
      const docNums = Array.from(new Set(items.map(i => i.docNum)));
      // Always company-scoped — every source table follows the same
      // `company_id` convention so the same WHERE shape works for all.
      // Chunked so a data-heavy company can never overflow the protocol's
      // bind-parameter cap with one giant IN list.
      const found: any[] = [];
      for (const part of chunk(docNums, IN_CHUNK)) {
        found.push(...await db.select({ id: (table as any).id, key: col }).from(table)
          .where(and(eq((table as any).companyId, groupCid), inArray(col, part))));
      }
      const byKey = new Map(found.map((f: any) => [f.key, f.id]));
      for (const it of items) {
        const sid = byKey.get(it.docNum);
        if (sid != null) sourceIdByEntry.set(it.entryId, sid as number);
      }
    }

    // 2b) Authoritative reverse-FK pass — source tables that store
    //     journal_entry_id link the JE even when its doc_number differs from
    //     the source's code/docNumber (companies running separate numbering
    //     sequences). This both fixes the "فتح المستند" deep-link for those
    //     rows AND, crucially, lets us flag true orphans below: a locked-type
    //     JE with NO source row anywhere. Overrides the doc_number result
    //     because the FK is definitive.
    const revByTypeCompany = new Map<string, number[]>();
    for (const r of rows) {
      const et = r.entryType ?? "";
      if (!REVERSE_SOURCE[et]) continue;
      const key = `${et}|${r.companyId}`;
      if (!revByTypeCompany.has(key)) revByTypeCompany.set(key, []);
      revByTypeCompany.get(key)!.push(r.id);
    }
    for (const [key, jeIdList] of revByTypeCompany) {
      const sep = key.indexOf("|");
      const et = key.slice(0, sep);
      const groupCid = Number(key.slice(sep + 1));
      const { table, jeCol } = REVERSE_SOURCE[et];
      const jeIds = Array.from(new Set(jeIdList));
      const found: any[] = [];
      for (const part of chunk(jeIds, IN_CHUNK)) {
        found.push(...await db.select({ id: (table as any).id, jeId: jeCol }).from(table)
          .where(and(eq((table as any).companyId, groupCid), inArray(jeCol, part))));
      }
      for (const f of found as any[]) {
        if (f.jeId != null) sourceIdByEntry.set(f.jeId as number, f.id as number);
      }
    }

    // Resolve usernames for the createdBy / postedBy ids in one pass so the
    // grid can render "أنشأه" / "رحّله" columns without an extra round trip.
    const userIds = Array.from(new Set(
      rows.flatMap(r => [r.createdBy, r.postedBy]).filter((x): x is number => typeof x === "number")
    ));
    const userMap = new Map<number, string>();
    if (userIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, userIds));
      for (const u of us) userMap.set(u.id, u.username);
    }

    res.json(rows.map(r => {
      const s = sumByEntry.get(r.id);
      // Strip the audit IP/user-agent columns from the LIST payload — no
      // frontend consumer reads them here (they stay on GET /:id and the
      // audit endpoint) and on data-heavy companies they add megabytes of
      // useless text to every list response.
      const { createdIp, createdUserAgent, postedIp, postedUserAgent, ...lean } = r as any;
      return {
        ...lean,
        totalDebit:    s?.totalDebit  ?? "0",
        totalCredit:   s?.totalCredit ?? "0",
        sourceId:      sourceIdByEntry.get(r.id) ?? null,
        // A locked-type JE whose source document no longer exists (checked via
        // reverse FK above) is an ORPHAN — stuck locked with nothing to unwind.
        // The frontend shows a "تحويل إلى قيد عام (مسودة)" action only for these.
        isOrphanLocked: LOCKED_ENTRY_TYPES.includes(r.entryType ?? "") && !sourceIdByEntry.has(r.id),
        createdByName: r.createdBy != null ? (userMap.get(r.createdBy) ?? null) : null,
        postedByName:  r.postedBy  != null ? (userMap.get(r.postedBy)  ?? null) : null,
      };
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE (with lines) ─────────────────────────────────────────────────────
// ─── Settlement JEs linked to an invoice ─────────────────────────────────────
// Lightweight list used by the invoice "السداد" tabs: manual journal entries
// that settle the given sales/purchase invoice via the header link. Literal
// sub-segment registered BEFORE /:id (Express 5 — no inline regex params).
router.get("/for-invoice", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const sid = req.query.salesInvoiceId ? Number(req.query.salesInvoiceId) : null;
    const pid = req.query.purchaseInvoiceId ? Number(req.query.purchaseInvoiceId) : null;
    const linkId = sid ?? pid;
    if (!linkId || !Number.isInteger(linkId) || linkId <= 0) {
      res.status(400).json({ error: "salesInvoiceId أو purchaseInvoiceId مطلوب" });
      return;
    }
    const linkCol = sid ? journalEntriesTable.salesInvoiceId : journalEntriesTable.purchaseInvoiceId;
    const rows = await db.select({
      id:               journalEntriesTable.id,
      docNumber:        journalEntriesTable.docNumber,
      entryDate:        journalEntriesTable.entryDate,
      description:      journalEntriesTable.description,
      status:           journalEntriesTable.status,
      currency:         journalEntriesTable.currency,
      exchangeRate:     journalEntriesTable.exchangeRate,
      settlementAmount: journalEntriesTable.settlementAmount,
    }).from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        eq(linkCol, linkId),
        sql`${journalEntriesTable.settlementAmount} IS NOT NULL`,
      ))
      .orderBy(desc(journalEntriesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Opening-balance entry (screen: الأرصدة الافتتاحية) ──────────────────────
// Returns the LATEST manually-created opening JE (entryType="opening") with
// its lines so the opening-balances screen can re-load it for editing after
// an unpost. Party-import opening JEs (hidden "[ob:" marker in description)
// are EXCLUDED — they are managed by the customers/suppliers bulk importer
// and must never be overwritten from this screen.
// Literal sub-segment registered BEFORE /:id (Express 5 rule).
router.get("/opening-entry", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const [entry] = await db.select().from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.entryType, "opening"),
        sql`COALESCE(${journalEntriesTable.description}, '') NOT LIKE '%[ob:%'`,
      ))
      .orderBy(desc(journalEntriesTable.createdAt), desc(journalEntriesTable.id))
      .limit(1);
    if (!entry) { res.json(null); return; }
    const lines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, entry.id))
      .orderBy(journalEntryLinesTable.sortOrder);
    res.json({ ...entry, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Settlement candidates ────────────────────────────────────────────────
// Manual (general) journal entries that touch the invoice's PARTY account
// (customer credited / supplier debited) and are NOT yet linked to any
// invoice. Surfaced on the invoice "السداد" tab with an "إضافة" button —
// applying one links it (settlement) WITHOUT generating a new JE.
// Literal sub-segment registered BEFORE /:id (Express 5 rule).
router.get("/settlement-candidates", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const sid = req.query.salesInvoiceId ? Number(req.query.salesInvoiceId) : null;
    const pid = req.query.purchaseInvoiceId ? Number(req.query.purchaseInvoiceId) : null;
    const invId = sid ?? pid;
    if (!invId || !Number.isInteger(invId) || invId <= 0) {
      res.status(400).json({ error: "salesInvoiceId أو purchaseInvoiceId مطلوب" });
      return;
    }
    const kind: SettlementKind = sid ? "sales" : "purchase";

    // Resolve the invoice's party account (customer AR / supplier AP).
    let partyAccountId: number | null = null;
    if (kind === "sales") {
      const [inv] = await db.select({ customerId: salesInvoicesTable.customerId })
        .from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, invId), eq(salesInvoicesTable.companyId, cid)));
      if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
      if (inv.customerId != null) {
        const [c] = await db.select({ accountId: customersTable.accountId })
          .from(customersTable)
          .where(and(eq(customersTable.id, inv.customerId), eq(customersTable.companyId, cid)));
        partyAccountId = c?.accountId ?? null;
      }
    } else {
      const [inv] = await db.select({ supplierId: purchaseInvoicesTable.supplierId })
        .from(purchaseInvoicesTable)
        .where(and(eq(purchaseInvoicesTable.id, invId), eq(purchaseInvoicesTable.companyId, cid)));
      if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
      if (inv.supplierId != null) {
        const [s] = await db.select({ accountId: suppliersTable.accountId })
          .from(suppliersTable)
          .where(and(eq(suppliersTable.id, inv.supplierId), eq(suppliersTable.companyId, cid)));
        partyAccountId = s?.accountId ?? null;
      }
    }
    if (!partyAccountId) { res.json([]); return; }

    // A payment DIRECTION line: customer account CREDITED (sales) /
    // supplier account DEBITED (purchase). Net per entry must be > 0.
    const amountExpr = kind === "sales"
      ? sql<string>`SUM(${journalEntryLinesTable.credit} - ${journalEntryLinesTable.debit})`
      : sql<string>`SUM(${journalEntryLinesTable.debit} - ${journalEntryLinesTable.credit})`;
    const rows = await db.select({
      id:           journalEntriesTable.id,
      docNumber:    journalEntriesTable.docNumber,
      entryDate:    journalEntriesTable.entryDate,
      description:  journalEntriesTable.description,
      status:       journalEntriesTable.status,
      currency:     journalEntriesTable.currency,
      exchangeRate: journalEntriesTable.exchangeRate,
      amount:       amountExpr,
    }).from(journalEntriesTable)
      .innerJoin(journalEntryLinesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.entryType, "general"),
        sql`${journalEntriesTable.salesInvoiceId} IS NULL`,
        sql`${journalEntriesTable.purchaseInvoiceId} IS NULL`,
        eq(journalEntryLinesTable.accountId, partyAccountId),
      ))
      .groupBy(
        journalEntriesTable.id, journalEntriesTable.docNumber,
        journalEntriesTable.entryDate, journalEntriesTable.description,
        journalEntriesTable.status, journalEntriesTable.currency,
        journalEntriesTable.exchangeRate,
      )
      .having(sql`${kind === "sales"
        ? sql`SUM(${journalEntryLinesTable.credit} - ${journalEntryLinesTable.debit})`
        : sql`SUM(${journalEntryLinesTable.debit} - ${journalEntryLinesTable.credit})`} > 0.005`)
      .orderBy(desc(journalEntriesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Open credit invoices (for the JE form's "ربط بفاتورة" picker) ──────────
// Posted CREDIT invoices with remaining due > 0, newest first. remaining =
// netDue (total − returns) − vouchers − settlement JEs, all in BASE currency.
// Literal sub-segment registered BEFORE /:id (Express 5 rule).
router.get("/open-invoices", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const kind: SettlementKind = req.query.kind === "purchase" ? "purchase" : "sales";

    const invTable   = kind === "sales" ? salesInvoicesTable : purchaseInvoicesTable;
    const retTable   = kind === "sales" ? salesReturnsTable  : purchaseReturnsTable;
    const partyTable = kind === "sales" ? customersTable     : suppliersTable;
    const partyCol   = kind === "sales" ? salesInvoicesTable.customerId : purchaseInvoicesTable.supplierId;
    const partyName  = kind === "sales" ? customersTable.nameAr : suppliersTable.nameAr;

    const invs = await db.select({
      id:        (invTable as any).id,
      docNumber: (invTable as any).docNumber,
      invoiceDate: (invTable as any).invoiceDate,
      total:     (invTable as any).totalAmount,
      rate:      (invTable as any).exchangeRate,
      partyName: partyName,
    }).from(invTable as any)
      .leftJoin(partyTable as any, eq(partyCol as any, (partyTable as any).id))
      .where(and(
        eq((invTable as any).companyId, cid),
        eq((invTable as any).paymentType, "credit"),
        eq((invTable as any).status, "posted"),
      ))
      .orderBy(desc((invTable as any).id))
      .limit(300);
    if (invs.length === 0) { res.json([]); return; }
    const ids = invs.map((i: any) => Number(i.id));

    // Grouped sums in ONE query each (BASE currency), keyed by invoice id.
    const retRows = await db.select({
      invoiceId: (retTable as any).invoiceId,
      sum: sql<string>`SUM(${(retTable as any).totalAmount} * ${(retTable as any).exchangeRate})`,
    }).from(retTable as any)
      .where(and(eq((retTable as any).companyId, cid), inArray((retTable as any).invoiceId, ids)))
      .groupBy((retTable as any).invoiceId);

    const vTable   = kind === "sales" ? receiptVouchersTable     : paymentVouchersTable;
    const lTable   = kind === "sales" ? receiptVoucherLinesTable : paymentVoucherLinesTable;
    const lLink    = kind === "sales" ? receiptVoucherLinesTable.salesInvoiceId : paymentVoucherLinesTable.purchaseInvoiceId;
    const hLink    = kind === "sales" ? receiptVouchersTable.salesInvoiceId     : paymentVouchersTable.purchaseInvoiceId;

    const lineRows = await db.select({
      invoiceId: lLink as any,
      voucherId: (lTable as any).voucherId,
      amount:    (lTable as any).amount,
      vRate:     (vTable as any).exchangeRate,
    }).from(lTable as any)
      .innerJoin(vTable as any, eq((lTable as any).voucherId, (vTable as any).id))
      .where(and(eq((vTable as any).companyId, cid), inArray(lLink as any, ids)));

    const headerRows = await db.select({
      invoiceId: hLink as any,
      id:        (vTable as any).id,
      amount:    (vTable as any).amount,
      vRate:     (vTable as any).exchangeRate,
    }).from(vTable as any)
      .where(and(eq((vTable as any).companyId, cid), inArray(hLink as any, ids)));

    const jeLink = kind === "sales" ? journalEntriesTable.salesInvoiceId : journalEntriesTable.purchaseInvoiceId;
    const jeRows = await db.select({
      invoiceId: jeLink as any,
      sum: sql<string>`SUM(${journalEntriesTable.settlementAmount} * ${journalEntriesTable.exchangeRate})`,
    }).from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        inArray(jeLink as any, ids),
        sql`${journalEntriesTable.settlementAmount} IS NOT NULL`,
      ))
      .groupBy(jeLink as any);

    const num = (v: any) => parseFloat(String(v)) || 0;
    const retBy = new Map<number, number>(retRows.map((r: any) => [Number(r.invoiceId), num(r.sum)]));
    const jeBy  = new Map<number, number>(jeRows.map((r: any) => [Number(r.invoiceId), num(r.sum)]));
    // Vouchers: line rows authoritative; a header-linked voucher counts its
    // full amount ONLY when it has no line rows for THAT SAME invoice
    // (mirrors sumVouchersForInvoice — the skip is per (voucher, invoice)
    // pair, never global per voucher).
    const vBy = new Map<number, number>();
    const linePairs = new Set<string>();
    for (const r of lineRows as any[]) {
      const k = Number(r.invoiceId);
      linePairs.add(`${Number(r.voucherId)}:${k}`);
      vBy.set(k, (vBy.get(k) ?? 0) + num(r.amount) * (num(r.vRate) || 1));
    }
    for (const v of headerRows as any[]) {
      const k = Number(v.invoiceId);
      if (linePairs.has(`${Number(v.id)}:${k}`)) continue;
      vBy.set(k, (vBy.get(k) ?? 0) + num(v.amount) * (num(v.vRate) || 1));
    }

    const out = invs.map((inv: any) => {
      const id = Number(inv.id);
      const netDue = Math.max(0, num(inv.total) * (num(inv.rate) || 1) - (retBy.get(id) ?? 0));
      const remaining = netDue - (vBy.get(id) ?? 0) - (jeBy.get(id) ?? 0);
      return {
        id,
        docNumber:   inv.docNumber ?? null,
        invoiceDate: inv.invoiceDate ?? null,
        partyName:   inv.partyName ?? null,
        total:       netDue,
        remaining,
      };
    }).filter((r: any) => r.remaining > 0.005);
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Apply an EXISTING JE as invoice settlement (no new JE produced) ─────────
// Links the JE to the invoice + sets settlementAmount = min(JE party-line
// amount, remaining due). Race-safe: advisory lock + re-check inside the tx.
router.post("/:id/apply-settlement", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const jeId = Number(req.params.id);
    if (!Number.isInteger(jeId) || jeId <= 0) { res.status(400).json({ error: "معرّف القيد غير صحيح" }); return; }
    const sid = req.body?.salesInvoiceId != null ? Number(req.body.salesInvoiceId) : null;
    const pid = req.body?.purchaseInvoiceId != null ? Number(req.body.purchaseInvoiceId) : null;
    const invId = sid ?? pid;
    if (!invId || !Number.isInteger(invId) || invId <= 0 || (sid != null && pid != null)) {
      res.status(400).json({ error: "salesInvoiceId أو purchaseInvoiceId مطلوب (واحد فقط)" });
      return;
    }
    const kind: SettlementKind = sid ? "sales" : "purchase";

    const out = await db.transaction(async (tx) => {
      await acquireSettlementLock(tx, cid, kind, invId);

      const [je] = await tx.select().from(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, jeId), eq(journalEntriesTable.companyId, cid)));
      if (!je) throw Object.assign(new Error("القيد غير موجود"), { httpStatus: 404 });
      if (je.salesInvoiceId != null || je.purchaseInvoiceId != null) {
        throw Object.assign(new Error("هذا القيد مرتبط بفاتورة بالفعل"), { httpStatus: 409 });
      }
      if ((je.entryType ?? "general") !== "general") {
        throw Object.assign(new Error("لا يمكن استخدام قيد نظامي (مولَّد من مستند) كسداد — القيود اليدوية فقط"), { httpStatus: 400 });
      }

      // Invoice must exist, be CREDIT type; net due computed in base.
      const { netDue, paymentType } = await invoiceNetDueBase(cid, kind, invId);
      if (paymentType !== "credit") {
        throw Object.assign(new Error("لا يمكن سداد إلا فاتورة آجلة — الفواتير النقدية/البنكية تُسدَّد تلقائياً عند الترحيل"), { httpStatus: 400 });
      }
      const vouchers = await sumVouchersForInvoice(cid, kind, invId);
      const jes = await sumSettlementJEs(cid, kind, invId, jeId);
      const remainingBase = netDue - vouchers - jes;
      if (remainingBase <= 0.005) {
        throw Object.assign(new Error("الفاتورة مسدَّدة بالكامل — لا يوجد متبقٍّ لإضافته من هذا القيد"), { httpStatus: 409 });
      }

      // JE's party-line amount (in the entry's currency).
      const rate = parseFloat(String(je.exchangeRate ?? "1")) || 1;
      const partyAccountId = await resolvePartyAccountForInvoice(tx, cid, kind, invId);
      if (!partyAccountId) {
        throw Object.assign(new Error("لا يمكن تحديد حساب العميل/المورد للفاتورة"), { httpStatus: 400 });
      }
      const lines = await tx.select({
        debit:  journalEntryLinesTable.debit,
        credit: journalEntryLinesTable.credit,
      }).from(journalEntryLinesTable)
        .where(and(
          eq(journalEntryLinesTable.entryId, jeId),
          eq(journalEntryLinesTable.accountId, partyAccountId),
        ));
      const jeAmountDoc = lines.reduce((s, l) => {
        const d = parseFloat(String(l.debit)) || 0;
        const c = parseFloat(String(l.credit)) || 0;
        return s + (kind === "sales" ? c - d : d - c);
      }, 0);
      if (jeAmountDoc <= 0.005) {
        throw Object.assign(new Error("هذا القيد لا يحتوي على مبلغ سداد على حساب العميل/المورد لهذه الفاتورة"), { httpStatus: 400 });
      }
      const jeAmountBase = jeAmountDoc * rate;

      // Clamp to the remaining due — سداد أكبر من الفاتورة ممنوع.
      const appliedBase = Math.min(jeAmountBase, remainingBase);
      const appliedDoc = rate > 0 ? appliedBase / rate : appliedBase;

      await tx.update(journalEntriesTable).set({
        salesInvoiceId:    kind === "sales" ? invId : null,
        purchaseInvoiceId: kind === "purchase" ? invId : null,
        settlementAmount:  appliedDoc.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(journalEntriesTable.id, jeId));

      const remainingAfter = Math.max(0, remainingBase - appliedBase);
      return {
        applied: Number(appliedDoc.toFixed(2)),
        appliedBase: Number(appliedBase.toFixed(2)),
        remainingAfter: Number(remainingAfter.toFixed(2)),
        partial: remainingAfter > 0.005,
        clamped: jeAmountBase > remainingBase + 0.005,
      };
    });
    res.json(out);
  } catch (e: any) {
    res.status(e?.httpStatus ?? 500).json({ error: e.message });
  }
});

// ─── Unlink a JE from its invoice settlement ─────────────────────────────────
router.post("/:id/unlink-settlement", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const jeId = Number(req.params.id);
    if (!Number.isInteger(jeId) || jeId <= 0) { res.status(400).json({ error: "معرّف القيد غير صحيح" }); return; }
    const [je] = await db.select({
      id: journalEntriesTable.id,
      sid: journalEntriesTable.salesInvoiceId,
      pid: journalEntriesTable.purchaseInvoiceId,
    }).from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, jeId), eq(journalEntriesTable.companyId, cid)));
    if (!je) { res.status(404).json({ error: "القيد غير موجود" }); return; }
    if (je.sid == null && je.pid == null) { res.status(409).json({ error: "القيد غير مرتبط بأي فاتورة" }); return; }
    await db.update(journalEntriesTable).set({
      salesInvoiceId: null,
      purchaseInvoiceId: null,
      settlementAmount: null,
      updatedAt: new Date(),
    }).where(eq(journalEntriesTable.id, jeId));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Resolve the invoice's party (customer AR / supplier AP) leaf account id.
async function resolvePartyAccountForInvoice(
  dbx: any, cid: number, kind: SettlementKind, invId: number,
): Promise<number | null> {
  if (kind === "sales") {
    const [inv] = await dbx.select({ customerId: salesInvoicesTable.customerId })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, invId), eq(salesInvoicesTable.companyId, cid)));
    if (!inv?.customerId) return null;
    const [c] = await dbx.select({ accountId: customersTable.accountId })
      .from(customersTable)
      .where(and(eq(customersTable.id, inv.customerId), eq(customersTable.companyId, cid)));
    return c?.accountId ?? null;
  }
  const [inv] = await dbx.select({ supplierId: purchaseInvoicesTable.supplierId })
    .from(purchaseInvoicesTable)
    .where(and(eq(purchaseInvoicesTable.id, invId), eq(purchaseInvoicesTable.companyId, cid)));
  if (!inv?.supplierId) return null;
  const [s] = await dbx.select({ accountId: suppliersTable.accountId })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.id, inv.supplierId), eq(suppliersTable.companyId, cid)));
  return s?.accountId ?? null;
}

// ─── GAP SCAN (فحص أرقام التسلسل الناقصة) ────────────────────────────────────
// Given a date range, detects MISSING doc numbers in the company's journal
// entries. Numbers are grouped by their non-numeric prefix (e.g. "QYD/06/"),
// then for each group we list every integer between the observed min and max
// that has no row — those are deleted/never-created numbers the user can
// re-create as empty drafts via the gap-fill flow. Read-only.
// MUST be registered BEFORE "/:id" (Express 5 route ordering).
router.get("/gap-scan", async (req, res) => {
  try {
    // SuperAdmin-only governance tool: company admins/users never see it.
    if (req.authUser?.role !== "superadmin") {
      res.status(403).json({ error: "هذه الأداة متاحة للمشرف العام فقط" });
      return;
    }
    const cid = getCompanyId(req);
    if (!cid) { res.status(400).json({ error: "لا يمكن تحديد الشركة" }); return; }
    const from = String(req.query.from ?? "").trim();
    const to   = String(req.query.to   ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: "يجب تحديد فترة صحيحة (من / إلى)" });
      return;
    }
    if (from > to) { res.status(400).json({ error: "تاريخ البداية بعد تاريخ النهاية" }); return; }

    const rows = await db.select({
      docNumber: journalEntriesTable.docNumber,
      entryDate: journalEntriesTable.entryDate,
    })
      .from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        gte(journalEntriesTable.entryDate, from),
        lte(journalEntriesTable.entryDate, to),
        ...branchScopeSpread(req, journalEntriesTable.branchId, req.query.branchId),
      ));

    // Group by prefix: everything before the TRAILING digit run. Numbers
    // without a trailing digit run (or blank) can't participate in a series.
    type G = { pad: number; nums: Map<number, string> }; // num → entryDate (for date suggestion)
    const groups = new Map<string, G>();
    for (const r of rows) {
      const dn = (r.docNumber ?? "").trim();
      const m = /^(.*?)(\d+)$/.exec(dn);
      if (!m) continue;
      const prefix = m[1];
      const numStr = m[2];
      const n = parseInt(numStr, 10);
      if (!Number.isFinite(n)) continue;
      // Timestamp-suffixed numbers (e.g. TRF-1776880398900) are NOT serial
      // sequences — including them floods the result with fake "gaps".
      // Real doc serials never exceed 8 digits.
      if (numStr.length > 8) continue;
      let g = groups.get(prefix);
      if (!g) { g = { pad: numStr.length, nums: new Map() }; groups.set(prefix, g); }
      g.pad = Math.max(g.pad, 0); // keep dominant padding = longest observed WITH leading zero
      if (numStr.startsWith("0")) g.pad = Math.max(g.pad, numStr.length);
      const prev = g.nums.get(n);
      // keep the EARLIEST date seen for that number (stable suggestion)
      if (!prev || String(r.entryDate) < prev) g.nums.set(n, String(r.entryDate));
    }

    const CAP = 500;
    const missing: { docNumber: string; prefix: string; number: number; suggestedDate: string | null }[] = [];
    let truncated = false;
    for (const [prefix, g] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], "ar"))) {
      const sorted = Array.from(g.nums.keys()).sort((a, b) => a - b);
      if (sorted.length < 2) continue; // a single number defines no range
      const min = sorted[0], max = sorted[sorted.length - 1];
      for (let n = min + 1; n < max; n++) {
        if (g.nums.has(n)) continue;
        if (missing.length >= CAP) { truncated = true; break; }
        // Suggest the date of the closest EXISTING lower number (same series).
        let suggestedDate: string | null = null;
        for (let p = n - 1; p >= min; p--) {
          const d = g.nums.get(p);
          if (d) { suggestedDate = d; break; }
        }
        const numStr = String(n).padStart(g.pad, "0");
        missing.push({ docNumber: `${prefix}${numStr}`, prefix, number: n, suggestedDate });
      }
      if (truncated) break;
    }

    res.json({ missing, truncated, scanned: rows.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const [entry] = cid
      ? await db.select().from(journalEntriesTable)
          .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)))
      : await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
    if (!entry) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    const lines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.json({ ...entry, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// (Reservation endpoint REMOVED in favour of explicit-save. The form now
// only consumes a sequence number when the user actually clicks Save —
// closing the form without saving leaves no row and no number gap by
// design, since nothing was ever inserted.)

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, entryDate, currency, exchangeRate, description, entryType, branchId, lines } = req.body;

    if (!entryDate) { res.status(400).json({ error: "التاريخ مطلوب" }); return; }

    // Optional invoice-settlement link (سداد فاتورة آجلة عن طريق القيد).
    // Parsed + validated BEFORE we burn a sequence number so a rejected
    // link (overpayment / cash invoice / wrong tenant) leaves no gap.
    let settlement: ReturnType<typeof parseJeSettlement>;
    try {
      settlement = parseJeSettlement(req.body);
      await validateJeSettlement(cid, settlement, exchangeRate, null, lines);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "ربط الفاتورة غير صالح" });
      return;
    }

    if (Array.isArray(lines) && lines.length > 0) {
      try {
        await ensureLeafAccounts(cid, lines.map((l: any) => l?.accountId));
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "حساب رئيسي غير مسموح" });
        return;
      }
    }

    // Authorize + validate the requested branch BEFORE we burn a sequence
    // number, so a 403/400 doesn't waste a journal-entry sequence value.
    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

    // Period guard runs BEFORE sequence allocation: writing into a closed
    // period is a 423 reject, and burning a sequence number on a request we
    // already know will fail would leave a permanent gap in the document
    // numbering. Resolve the fiscal period here so we (a) reject early and
    // (b) reuse the resolved period when inserting the entry below.
    const writability = await assertWritableForDate(cid, entryDate);
    if (!writability.ok) {
      res.status(423).json({ error: writability.reason });
      return;
    }

    // ── Gap-fill mode (استرجاع رقم قيد محذوف) ──────────────────────────
    // When the client explicitly sends { gapFill: true, docNumber }, we
    // BYPASS the sequence engine and reuse the supplied number verbatim —
    // this exists to re-create a DELETED doc number as a draft, filling a
    // gap in the numbering. Safety rails:
    //   1. number must be non-empty and NOT already used by this company
    //      (checked here for a friendly 409, re-checked inside the insert
    //      transaction under the per-company advisory lock — hard guarantee)
    //   2. entry ALWAYS lands as "draft" (never auto-posts), so it has zero
    //      report impact until someone deliberately posts it.
    //   3. no sequence counter is consumed or advanced.
    const gapFill = req.body?.gapFill === true;
    const gapFillNumber = gapFill ? String(docNumber ?? "").trim() : null;
    if (gapFill) {
      // Strict contract: gap-fill creates an EMPTY general draft — nothing
      // else. Reject malformed intent instead of silently falling through
      // to the normal create path (which would consume a sequence number).
      // SuperAdmin-only governance action (same model as domains/dev-cloud):
      // regular company admins can neither see the UI nor call this path.
      if (req.authUser?.role !== "superadmin") {
        res.status(403).json({ error: "استرجاع رقم محذوف متاح للمشرف العام فقط" });
        return;
      }
      if (!gapFillNumber) {
        res.status(400).json({ error: "رقم القيد مطلوب لاسترجاع رقم محذوف" });
        return;
      }
      if (Array.isArray(lines) && lines.length > 0) {
        res.status(400).json({ error: "استرجاع رقم محذوف ينشئ قيداً فارغاً — لا يمكن إرسال بنود" });
        return;
      }
      if (settlement.salesInvoiceId != null || settlement.purchaseInvoiceId != null) {
        res.status(400).json({ error: "لا يمكن ربط فاتورة بقيد استرجاع رقم محذوف" });
        return;
      }
      const dup = await db.select({ id: journalEntriesTable.id })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          eq(journalEntriesTable.docNumber, gapFillNumber!),
        ))
        .limit(1);
      if (dup.length > 0) {
        res.status(409).json({ error: `رقم القيد ${gapFillNumber} مستخدم بالفعل` });
        return;
      }
    }

    // Central sequence engine is authoritative when an active sequence
    // exists for "journal_entry"; otherwise fall back to client-supplied
    // value or null (legacy behavior). Server allocation is atomic so
    // concurrent submits can never persist the same number.
    let resolvedDocNumber: string | null;
    if (gapFill) {
      resolvedDocNumber = gapFillNumber;
    } else try {
      const fromSeq = await nextSequenceNumber(cid, "journal_entry", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "journal_entries",
        branchId: resolvedBranchId,
        docDate:  entryDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم القيد" });
      return;
    }

    // Atomic dual-status decision: only flip to "posted" when the entry is
    // both balanced AND has at least 2 valid lines (each with an accountId
    // and a non-zero debit OR credit). Anything else lands as "draft" so
    // the user can finish typing later — but the sequence number is only
    // ever consumed once, on this single Save click.
    const validLines = Array.isArray(lines)
      ? lines.filter((l: any) => l && l.accountId)
      : [];
    const totalDebit  = validLines.reduce(
      (s: number, l: any) => s + (parseFloat(String(l.debit  ?? "0")) || 0), 0,
    );
    const totalCredit = validLines.reduce(
      (s: number, l: any) => s + (parseFloat(String(l.credit ?? "0")) || 0), 0,
    );
    const hasMovement = totalDebit > 0 || totalCredit > 0;
    const isBalanced  = Math.abs(totalDebit - totalCredit) < 0.001 && hasMovement;
    // A balanced 2+-line entry is technically postable — but the company may
    // have flipped the manual-JE auto-post toggle off in /general-settings,
    // in which case we honour their choice and save as draft regardless.
    // Per replit.md the draft will have ZERO impact on financial reports
    // until an admin posts it from مركز الترحيل.
    const technicallyPostable = !gapFill && isBalanced && validLines.length >= 2;
    const desiredStatus = technicallyPostable
      ? await resolvePostingStatus(cid, "journalEntry")
      : "draft";
    const canPost = desiredStatus === "posted";

    // Wrap the INSERT + (optional) QYD fallback assignment in a single
    // transaction guarded by a per-company advisory lock. Without the lock,
    // two concurrent saves can both read the same MAX(QYD-XXXX) before
    // either has updated, then both write the SAME doc_number — producing
    // duplicates (e.g. two rows both labeled QYD-0722). The advisory lock
    // serializes assignment per company while leaving other tenants
    // unaffected. Lock is held until COMMIT/ROLLBACK.
    const entry = await db.transaction(async (tx) => {
      // Settlement race guard: serialize per-invoice under an advisory lock
      // and RE-validate inside the transaction. Two concurrent saves against
      // the same invoice would otherwise both read the same "remaining" and
      // jointly exceed the cap. The pre-check above handles the common case
      // (nice 400 before the sequence burns); this one is the hard guarantee.
      if (settlement.salesInvoiceId != null || settlement.purchaseInvoiceId != null) {
        const kind: SettlementKind = settlement.salesInvoiceId != null ? "sales" : "purchase";
        const invId = (settlement.salesInvoiceId ?? settlement.purchaseInvoiceId)!;
        await acquireSettlementLock(tx, cid, kind, invId);
        try {
          await validateJeSettlement(cid, settlement, exchangeRate, null, lines);
        } catch (err: any) {
          (err ?? {}).settlementReject = true;
          throw err;
        }
      }
      if (!resolvedDocNumber) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, 1001)`);
      }
      // Gap-fill hard guarantee: re-check uniqueness of the requested number
      // INSIDE the transaction under the per-company advisory lock, so two
      // concurrent gap-fill saves of the same number can never both win.
      if (gapFill) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, 1001)`);
        const dupTx = await tx.select({ id: journalEntriesTable.id })
          .from(journalEntriesTable)
          .where(and(
            eq(journalEntriesTable.companyId, cid),
            eq(journalEntriesTable.docNumber, gapFillNumber!),
          ))
          .limit(1);
        if (dupTx.length > 0) {
          const err: any = new Error(`رقم القيد ${gapFillNumber} مستخدم بالفعل`);
          err.gapFillDup = true;
          throw err;
        }
      }
      const [e] = await tx.insert(journalEntriesTable).values({
        companyId:    cid,
        docNumber:    resolvedDocNumber,
        entryDate,
        currency:     currency || "SAR",
        exchangeRate: exchangeRate ?? "1",
        description:  description || null,
        // Gap-fill entries are always plain "general" — never allow a crafted
        // payload to mint pseudo-source/system entry types via this path.
        entryType:    gapFill ? "general" : (entryType || "general"),
        branchId:     resolvedBranchId,
        periodId:     writability.period?.id ?? null,
        salesInvoiceId:    settlement.salesInvoiceId,
        purchaseInvoiceId: settlement.purchaseInvoiceId,
        settlementAmount:  settlement.settlementAmount,
        status:       canPost ? "posted" : "draft",
        // Audit trail — when the entry lands as "posted" on the same save,
        // we stamp BOTH the created* and posted* fields so the audit dialog
        // can attribute creation and posting to the same user/IP/UA.
        ...(canPost ? fullAuditFor(req) : createdAuditFor(req)),
      }).returning();

      // Legacy QYD fallback: when no central sequence is configured AND the
      // client didn't supply a docNumber, compose a stable QYD-XXXX label.
      // Compute next number PER COMPANY = MAX(numeric part of QYD-XXXX) + 1.
      // Using global entry.id would interleave ids across tenants and create
      // artificial gaps in each company's view of its own numbering.
      if (!resolvedDocNumber) {
        const result = await tx.execute<{ next: number }>(sql`
          SELECT COALESCE(MAX(
            CASE
              WHEN doc_number ~ '^QYD-[0-9]+$'
              THEN (regexp_replace(doc_number, '^QYD-', ''))::int
              ELSE 0
            END
          ), 0) + 1 AS next
          FROM journal_entries
          WHERE company_id = ${cid}
            AND id <> ${e.id}
        `);
        const next = Number((result as any).rows?.[0]?.next ?? 1);
        resolvedDocNumber = `QYD-${String(next).padStart(4, "0")}`;
        await tx.update(journalEntriesTable)
          .set({ docNumber: resolvedDocNumber })
          .where(eq(journalEntriesTable.id, e.id));
        e.docNumber = resolvedDocNumber;
      }
      return e;
    });

    if (Array.isArray(lines) && lines.length > 0) {
      await db.insert(journalEntryLinesTable).values(
        lines.map((l: any, i: number) => ({
          entryId:     entry.id,
          accountId:   l.accountId ? Number(l.accountId) : null,
          costCenter:  l.costCenter || null,
          debit:       l.debit  ?? "0",
          credit:      l.credit ?? "0",
          description: l.description || null,
          supplierName:          jeTxtOrNull(l.supplierName),
          supplierVatNumber:     jeTxtOrNull(l.supplierVatNumber),
          supplierInvoiceNumber: jeTxtOrNull(l.supplierInvoiceNumber),
          supplierInvoiceDate:   jeTxtOrNull(l.supplierInvoiceDate),
          sortOrder:   i,
        }))
      );
    }

    const linesOut = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, entry.id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.status(201).json({ ...entry, lines: linesOut });
  } catch (e: any) { res.status(e?.settlementReject ? 400 : e?.gapFillDup ? 409 : 500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
// Entry types that are auto-generated by source documents; these JEs must NOT
// be modified or deleted directly — use the source document's unpost action.
const LOCKED_ENTRY_TYPES = [
  "purchase_invoice", "purchase_return",
  "sales_invoice", "sales_return",
  // Voucher routes today emit the legacy bare strings "receipt" /
  // "payment" (see receipt-vouchers.ts / payment-vouchers.ts). The
  // canonical names are kept here for forward compatibility once
  // those routes are normalized.
  "receipt_voucher", "payment_voucher", "receipt", "payment",
  "stock_transfer", "stock_adjustment",
  "supplier_settlement", "customer_settlement",
  "payroll_run", "employee_loan", "eos_payment",
];

// A fa_depreciation JE is generated by a depreciation RUN row. Direct manual
// edit/delete would desync the run (amount, asset accumulated depreciation),
// so both are blocked while a run still references the JE. Unpost CASCADES to
// the run instead of a bare status flip (see POST /:id/unpost).
async function findDepreciationRunForJe(id: number, cid: number) {
  const [run] = await db.select({
    id:     faDepreciationRunsTable.id,
    status: faDepreciationRunsTable.status,
  }).from(faDepreciationRunsTable)
    .where(and(
      eq(faDepreciationRunsTable.companyId, cid),
      eq(faDepreciationRunsTable.journalEntryId, id),
    )).limit(1);
  return run ?? null;
}

async function ensureNotLocked(id: number, cid: number): Promise<{ ok: boolean; entryType?: string | null }> {
  const [existing] = await db.select().from(journalEntriesTable)
    .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
  if (!existing) return { ok: true };
  if (existing.entryType && LOCKED_ENTRY_TYPES.includes(existing.entryType)) {
    return { ok: false, entryType: existing.entryType };
  }
  return { ok: true };
}

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر (فاتورة/سند) ولا يمكن تعديله مباشرة. لتعديله قم بفك ترحيل المستند الأصلي." });
      return;
    }

    // fa_depreciation JEs are generated from depreciation runs — manual edits
    // would desync the run amount + asset accumulated depreciation.
    if (await findDepreciationRunForJe(id, cid)) {
      res.status(403).json({ error: "قيد إهلاك مُولَّد من سجل إهلاك الأصول الثابتة — لا يمكن تعديله يدوياً. قم بفك الترحيل ثم أعد الترحيل من شاشة الأصول الثابتة ليُعاد احتسابه." });
      return;
    }

    // Posted-status guard — refuse to edit a posted JE. The user must
    // unpost it first (POST /:id/unpost) before any field/line change.
    const [statusRow] = await db.select({
      status:    journalEntriesTable.status,
      entryType: journalEntriesTable.entryType,
    })
      .from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (statusRow?.status === "posted") {
      res.status(423).json({ error: "هذا القيد مُرحَّل ولا يمكن تعديله. قم بفك الترحيل أولاً ثم أعد المحاولة." });
      return;
    }
    // Adjustment JEs keep their entryType across edits — the unpost→edit→
    // re-post cycle must never let the client body downgrade the type to
    // "general" (that would orphan the run linkage semantics).
    const isAdjustmentJe = statusRow?.entryType === "adjustment_prepaid"
      || statusRow?.entryType === "adjustment_accrued";

    // docNumber is intentionally not destructured — immutable on edit.
    const { entryDate, currency, exchangeRate, description, entryType, branchId, lines } = req.body;

    // Optional invoice-settlement link — re-validated on every edit with
    // the entry itself excluded so its own old amount doesn't block it.
    let settlement: ReturnType<typeof parseJeSettlement>;
    try {
      settlement = parseJeSettlement(req.body);
      await validateJeSettlement(cid, settlement, exchangeRate, id, lines);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "ربط الفاتورة غير صالح" });
      return;
    }

    // Validate accounts BEFORE mutating the entry header so a bad
    // account doesn't leave the journal half-updated.
    if (Array.isArray(lines) && lines.length > 0) {
      try {
        await ensureLeafAccounts(cid, lines.map((l: any) => l?.accountId));
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "حساب رئيسي غير مسموح" });
        return;
      }
    }

    // Authorize + validate the requested branch (same rules as on create:
    // branch must be inside the user's allowed scope and belong to this
    // company). NULL is preserved for users who explicitly clear it.
    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

    // Period guard — verify both the existing entry's period AND the new
    // target date's period are open. This protects against editing into or
    // out of a closed period.
    const [pre] = await db.select({ periodId: journalEntriesTable.periodId })
      .from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (pre) {
      const oldGuard = await assertWritableForPeriodId(cid, pre.periodId);
      if (!oldGuard.ok) { res.status(423).json({ error: oldGuard.reason }); return; }
    }
    const newDate = entryDate || undefined;
    let resolvedPeriodId: number | null | undefined = undefined;
    if (newDate) {
      const newGuard = await assertWritableForDate(cid, newDate);
      if (!newGuard.ok) { res.status(423).json({ error: newGuard.reason }); return; }
      resolvedPeriodId = newGuard.period?.id ?? null;
    }

    // docNumber is intentionally omitted — once assigned, it is immutable.
    // The update runs inside a transaction so the per-invoice settlement
    // advisory lock (when a link exists) serializes concurrent settlement
    // writes and the cap is re-checked under the lock (hard guarantee; the
    // earlier pre-check only covers the friendly-400 common case).
    const [entry] = await db.transaction(async (tx) => {
      if (settlement.salesInvoiceId != null || settlement.purchaseInvoiceId != null) {
        const kind: SettlementKind = settlement.salesInvoiceId != null ? "sales" : "purchase";
        const invId = (settlement.salesInvoiceId ?? settlement.purchaseInvoiceId)!;
        await acquireSettlementLock(tx, cid, kind, invId);
        try {
          await validateJeSettlement(cid, settlement, exchangeRate, id, lines);
        } catch (err: any) {
          (err ?? {}).settlementReject = true;
          throw err;
        }
      }
      return tx.update(journalEntriesTable).set({
        entryDate:    entryDate || undefined,
        currency:     currency || "SAR",
        exchangeRate: exchangeRate ?? "1",
        description:  description || null,
        entryType:    isAdjustmentJe ? statusRow!.entryType : (entryType || "general"),
        branchId:     resolvedBranchId,
        salesInvoiceId:    settlement.salesInvoiceId,
        purchaseInvoiceId: settlement.purchaseInvoiceId,
        settlementAmount:  settlement.settlementAmount,
        ...(resolvedPeriodId !== undefined ? { periodId: resolvedPeriodId } : {}),
        updatedAt:    new Date(),
      }).where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid))).returning();
    });

    if (!entry) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    if (Array.isArray(lines)) {
      await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, id));
      if (lines.length > 0) {
        await db.insert(journalEntryLinesTable).values(
          lines.map((l: any, i: number) => ({
            entryId:     id,
            accountId:   l.accountId ? Number(l.accountId) : null,
            costCenter:  l.costCenter || null,
            debit:       l.debit  ?? "0",
            credit:      l.credit ?? "0",
            description: l.description || null,
            supplierName:          jeTxtOrNull(l.supplierName),
            supplierVatNumber:     jeTxtOrNull(l.supplierVatNumber),
            supplierInvoiceNumber: jeTxtOrNull(l.supplierInvoiceNumber),
            supplierInvoiceDate:   jeTxtOrNull(l.supplierInvoiceDate),
            sortOrder:   i,
          }))
        );
      }
    }

    // Adjustment JE edited → re-sync its run row's recognized amount to the
    // new expense-side (debit) total so the adjustments screen keeps
    // reporting the true recognized sum.
    if (isAdjustmentJe && Array.isArray(lines)) {
      const totalDebit = lines.reduce(
        (s: number, l: any) => s + (parseFloat(l?.debit || "0") || 0), 0);
      await syncAdjustmentRunAmountForJe(cid, id, totalDebit.toFixed(2));
    }

    const linesOut = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.json({ ...entry, lines: linesOut });
  } catch (e: any) { res.status(e?.settlementReject ? 400 : 500).json({ error: e.message }); }
});

// ─── POST /:id/post — flip status from draft → posted ───────────────────────
// Used by the unified Posting Center AND the journal-log "ترحيل" button. We
// require the entry to be balanced (sum debit === sum credit) with ≥2 valid
// lines and an open period. Source-document JEs left as drafts (auto-posting
// OFF) ARE postable here — see the NOTE in the handler.
router.post("/:id/post", requirePostRight("journalEntry"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    // NOTE: source-document JEs (sales_invoice, purchase_invoice, …) are
    // intentionally POSTABLE here even though they remain locked from
    // edit/delete/unpost. When a company has auto-posting OFF
    // (resolvePostingStatus → "draft"), the source document is posted but its
    // JE is deliberately left as a draft for a later review-and-post step
    // (segregation of duties). The ONLY safe way to complete that step is to
    // flip the existing, already-correct JE draft → posted — which is exactly
    // what this endpoint does (the balance + period + ≥2-line checks below
    // still apply). Editing/deleting/unposting such a JE stays blocked (see
    // ensureNotLocked on PUT /:id, DELETE /:id, POST /:id/unpost) so the JE can
    // never drift out of sync with its source document. Before this, turning
    // auto-posting off produced draft source-document JEs that no screen could
    // ever post — they never reached the financial reports.

    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "القيد غير موجود" }); return; }
    if (existing.status === "posted") { res.json({ ok: true, alreadyPosted: true }); return; }

    // fa_depreciation draft: distinguish two shapes.
    //   • LEGITIMATE (auto-post OFF): JE created as draft awaiting manual post
    //     — postedAt is NULL (fa-journals only stamps it when landing posted).
    //     Must stay postable (plain flip) or it strands out of all reports.
    //   • LEGACY-BROKEN (old bulk unpost): JE was posted once (postedAt set),
    //     then bare-flipped to draft while the run stayed 'posted'. Re-posting
    //     would freeze stale amounts — force the FA unpost→repost flow which
    //     recomputes from the asset's CURRENT state.
    if (existing.entryType === "fa_depreciation" && existing.postedAt != null) {
      const run = await findDepreciationRunForJe(id, cid);
      if (run) {
        res.status(409).json({ error: "قيد إهلاك مرتبط بسجل إهلاك — لا يُرحَّل يدوياً. قم بفك ترحيل السجل ثم أعد ترحيله من شاشة الأصول الثابتة ليُعاد احتساب المبلغ." });
        return;
      }
      // Orphan (no run references it) → plain flip below stays allowed.
    }

    // Period guard — refuse to flip status when the entry's period is closed
    const postGuard = await assertWritableForPeriodId(cid, existing.periodId);
    if (!postGuard.ok) { res.status(423).json({ error: postGuard.reason }); return; }

    // Balance check — sum debit must equal sum credit. We pull the lines
    // raw (numeric → string) and parseFloat so the comparison is float-safe
    // up to two decimal places (Saudi accounting precision). We also
    // require at least 2 valid posting lines (each with an accountId AND a
    // non-zero debit OR credit) so the posted path mirrors the create-time
    // dual-status decision (a one-line entry can never be balanced).
    const lines = await db.select({
      accountId: journalEntryLinesTable.accountId,
      debit:     journalEntryLinesTable.debit,
      credit:    journalEntryLinesTable.credit,
    }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, id));
    const validLines = lines.filter(l => {
      const d = parseFloat(l.debit  || "0") || 0;
      const c = parseFloat(l.credit || "0") || 0;
      return l.accountId != null && (d > 0 || c > 0);
    });
    if (validLines.length < 2) {
      res.status(400).json({ error: "يجب أن يحتوي القيد على سطرين فعّالين على الأقل قبل الترحيل" });
      return;
    }
    const totalDebit  = lines.reduce((s, l) => s + parseFloat(l.debit  || "0"), 0);
    const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit || "0"), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({ error: `القيد غير متوازن — مدين: ${totalDebit.toFixed(2)} / دائن: ${totalCredit.toFixed(2)}` });
      return;
    }
    if (totalDebit === 0 && totalCredit === 0) {
      res.status(400).json({ error: "لا يمكن ترحيل قيد بقيمة صفرية" });
      return;
    }

    await db.update(journalEntriesTable)
      .set({ status: "posted", updatedAt: new Date(), ...postedAuditFor(req) })
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/unpost — flip status from posted → draft ─────────────────────
router.post("/:id/unpost", requireUnpostRight("journalEntry"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر — لفك ترحيله قم بفك ترحيل المستند الأصلي" });
      return;
    }

    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    // ── fa_depreciation cascade ──────────────────────────────────────────────
    // Unposting a depreciation JE must unwind the WHOLE run (reverse the
    // asset's accumulated depreciation + book value, flip the run row to
    // 'unposted', delete the JE reserving its number for re-post). A bare
    // status flip used to leave the run 'posted' + the asset accum applied →
    // the schedule kept showing "تم ترحيلها" and asset edits never reached
    // the stale draft JE. NOTE: runs before the `status !== "posted"` early
    // return on purpose — it also HEALS broken rows left by the old behavior
    // (draft JE whose run is still 'posted').
    if (existing.entryType === "fa_depreciation") {
      const run = await findDepreciationRunForJe(id, cid);
      if (run && run.status === "posted") {
        const faGuard = await assertWritableForPeriodId(cid, existing.periodId);
        if (!faGuard.ok) { res.status(423).json({ error: faGuard.reason }); return; }
        try {
          await unpostDepreciationRun(cid, run.id, { userId: req.authUser?.id ?? null });
          res.json({ ok: true, cascaded: "fa_depreciation" });
        } catch (err: any) {
          res.status(409).json({ error: err?.message || "تعذّر فك ترحيل سجل الإهلاك" });
        }
        return;
      }
      // No run (orphan) or run already unposted → fall through to plain flip.
    }

    // ── adjustment_prepaid / adjustment_accrued cascade ─────────────────────
    // These JEs are generated by an accounting-adjustment RUN row. Per
    // explicit user requirement, unposting must PRESERVE the JE and its
    // document number: the JE flips to a draft (same docNumber), the run row
    // stays (month keeps counting as generated — no duplicate from the
    // scheduler), and after the user edits the draft they re-post it via
    // POST /:id/post onto the SAME sequence number.
    if (existing.entryType === "adjustment_prepaid" || existing.entryType === "adjustment_accrued") {
      const adjGuard = await assertWritableForPeriodId(cid, existing.periodId);
      if (!adjGuard.ok) { res.status(423).json({ error: adjGuard.reason }); return; }
      try {
        const unposted = await unpostAdjustmentRunJe(cid, id);
        if (unposted) {
          res.json({ ok: true, cascaded: "adjustment", keptNumber: true, adjustmentId: unposted.adjustmentId, periodMonth: unposted.ym });
          return;
        }
      } catch (err: any) {
        res.status(409).json({ error: err?.message || "تعذّر فك ترحيل قيد التسوية" });
        return;
      }
      // No run references this JE (orphan) → fall through to plain flip.
    }

    if (existing.status !== "posted") { res.json({ ok: true, alreadyUnposted: true }); return; }

    // ── Fixed-asset linkage guard: a JE that spawned a LIVE fixed-asset card
    // cannot be unposted (the asset's cost basis would point at a draft).
    // Dispose/delete the asset first; sold/scrapped assets don't block.
    const linkedFa = await db.select({ code: fixedAssetsTable.code })
      .from(fixedAssetsTable)
      .where(and(
        eq(fixedAssetsTable.companyId, cid),
        eq(fixedAssetsTable.sourceType, "journal_entry"),
        eq(fixedAssetsTable.sourceDocumentId, id),
        notInArray(fixedAssetsTable.status, ["sold", "scrapped"]),
      )).limit(1);
    if (linkedFa.length) {
      res.status(409).json({ error: `لا يمكن فك الترحيل: يوجد أصل ثابت مرتبط بهذا القيد (${linkedFa[0].code}) — قم باستبعاد الأصل أو حذفه أولاً` });
      return;
    }

    // Period guard — refuse to unpost from a closed period
    const unpGuard = await assertWritableForPeriodId(cid, existing.periodId);
    if (!unpGuard.ok) { res.status(423).json({ error: unpGuard.reason }); return; }

    await db.update(journalEntriesTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/convert-to-general — rescue an ORPHANED locked entry ─────────
// A JE auto-generated by a source document (invoice/voucher/…) is locked from
// manual edit/unpost/delete — the user must unwind it from the source. But
// when that source document no longer exists (an orphan left by an earlier
// bug) there is nothing to unwind and the entry is stuck forever. This
// converts such an orphan into an ordinary GENERAL DRAFT entry: entry_type →
// "general", status → "draft", KEEPING its document number so the numbering
// sequence stays gap-free. A draft carries zero report impact everywhere, and
// once general the user can edit/delete it like any manual entry. Refuses when
// the source document still exists (must be unwound from the source) or the
// entry is not a locked type. Does NOT loosen the edit/unpost/delete guards.
router.post("/:id/convert-to-general", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صحيح" }); return; }

    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    const et = existing.entryType ?? "";
    if (!LOCKED_ENTRY_TYPES.includes(et)) {
      res.status(400).json({ error: "هذا القيد ليس من نوع مقفول — لا حاجة للتحويل." });
      return;
    }

    // Only ORPHANS qualify: a locked entry whose source document is gone.
    const hasSource = await sourceDocExists(et, existing.docNumber, existing.id, cid);
    if (hasSource) {
      res.status(409).json({ error: "لا يمكن التحويل: المستند المصدر لا يزال موجوداً. قم بفك ترحيله من المستند الأصلي بدلاً من ذلك." });
      return;
    }

    // Flipping posted → draft mutates the ledger's posted set, so honour the
    // same closed-period guard the unpost path uses.
    const periodGuard = await assertWritableForPeriodId(cid, existing.periodId);
    if (!periodGuard.ok) { res.status(423).json({ error: periodGuard.reason }); return; }

    await db.update(journalEntriesTable)
      .set({ entryType: "general", status: "draft", updatedAt: new Date() })
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// (Discard-empty endpoint REMOVED alongside the reservation endpoint —
// no row is created until the user explicitly saves, so there is nothing
// to discard on cancel/exit.)

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر (فاتورة/سند) ولا يمكن حذفه مباشرة. لحذفه قم بفك ترحيل المستند الأصلي." });
      return;
    }

    // fa_depreciation JEs are owned by their depreciation run — deleting one
    // directly would strand the run's journalEntryId FK + the asset's accum.
    if (await findDepreciationRunForJe(id, cid)) {
      res.status(403).json({ error: "قيد إهلاك مُولَّد من سجل إهلاك الأصول الثابتة — لا يمكن حذفه مباشرة. قم بفك ترحيل سجل الإهلاك من شاشة الأصول الثابتة." });
      return;
    }

    // adjustment JEs owned by an adjustment run are never deleted directly —
    // deleting would burn the document number (sequence gap) and strand the
    // run's journalEntryId FK. The supported flow is unpost → edit → re-post
    // on the SAME number; removing the month entirely goes through the
    // adjustments screen (cancel/edit re-spread).
    {
      const [advRun] = await db.select({ id: accountingAdjustmentRunsTable.id })
        .from(accountingAdjustmentRunsTable)
        .where(and(
          eq(accountingAdjustmentRunsTable.companyId, cid),
          eq(accountingAdjustmentRunsTable.journalEntryId, id),
        )).limit(1);
      if (advRun) {
        res.status(403).json({ error: "قيد تسوية شهرية مرتبط بجدول التسويات — لا يمكن حذفه حتى لا يُفقد تسلسل الأرقام. قم بفك الترحيل وتعديله ثم إعادة ترحيله بنفس الرقم، أو أدر الشهر من شاشة التسويات الشهرية." });
        return;
      }
    }

    // Period guard + posted-status guard — refuse to delete entries inside
    // a closed period AND refuse to delete any posted JE (must unpost first
    // so the financial reports stay consistent with the audit trail).
    const [pre] = await db.select({
      periodId: journalEntriesTable.periodId,
      status:   journalEntriesTable.status,
    })
      .from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (pre) {
      if (pre.status === "posted") {
        res.status(423).json({ error: "هذا القيد مُرحَّل ولا يمكن حذفه. قم بفك الترحيل أولاً ثم أعد المحاولة." });
        return;
      }
      const delGuard = await assertWritableForPeriodId(cid, pre.periodId);
      if (!delGuard.ok) { res.status(423).json({ error: delGuard.reason }); return; }
    }

    await db.delete(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /:id/audit — manager-only forensic audit dialog ──────────────────
// Returns the captured create + post audit fields, the resolved usernames,
// a friendly device label (browser + OS) parsed from the user-agent, and
// the country resolved on demand from the stored IP via the same free
// Geo-IP service the visitor-country middleware uses. Restricted to
// admin/superadmin so regular users can't snoop on each other's IPs.
router.get("/:id/audit", async (req, res) => {
  try {
    const role = req.authUser?.role;
    if (role !== "admin" && role !== "superadmin") {
      res.status(403).json({ error: "صلاحية المدير مطلوبة لعرض سجل التدقيق" });
      return;
    }
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const [e] = await db.select({
      id:               journalEntriesTable.id,
      createdAt:        journalEntriesTable.createdAt,
      createdBy:        journalEntriesTable.createdBy,
      createdIp:        journalEntriesTable.createdIp,
      createdUserAgent: journalEntriesTable.createdUserAgent,
      postedAt:         journalEntriesTable.postedAt,
      postedBy:         journalEntriesTable.postedBy,
      postedIp:         journalEntriesTable.postedIp,
      postedUserAgent:  journalEntriesTable.postedUserAgent,
      status:           journalEntriesTable.status,
    }).from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!e) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    // Resolve usernames in one pass.
    const userIds = [e.createdBy, e.postedBy].filter((x): x is number => typeof x === "number");
    const userMap = new Map<number, string>();
    if (userIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, userIds));
      for (const u of us) userMap.set(u.id, u.username);
    }

    // Tiny inline geo-IP — the visitorCountry middleware keeps its own
    // cache but doesn't expose a lookup-by-ip helper, so we issue the
    // same upstream call here. Failures degrade silently to null so
    // the dialog still renders the rest of the audit info.
    async function lookupCountry(ip: string | null): Promise<string | null> {
      if (!ip) return null;
      // Skip private/loopback ranges — they have no public country.
      if (/^(10\.|192\.168\.|127\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(ip)) return null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        const j: any = await r.json();
        return String(j?.country || "").toUpperCase() || null;
      } catch { return null; }
    }

    const [createdCountry, postedCountry] = await Promise.all([
      lookupCountry(e.createdIp),
      // Don't double-lookup when create+post share the same IP.
      e.postedIp && e.postedIp === e.createdIp
        ? Promise.resolve(null)
        : lookupCountry(e.postedIp),
    ]);

    function deviceLabel(ua: string | null): string | null {
      if (!ua) return null;
      const fakeReq = { headers: { "user-agent": ua } } as any;
      return describeDevice(fakeReq) || null;
    }

    res.json({
      id: e.id,
      status: e.status,
      created: {
        userId:    e.createdBy,
        username:  e.createdBy != null ? (userMap.get(e.createdBy) ?? null) : null,
        at:        e.createdAt,
        ip:        e.createdIp,
        userAgent: e.createdUserAgent,
        device:    deviceLabel(e.createdUserAgent),
        country:   createdCountry,
      },
      posted: e.postedAt ? {
        userId:    e.postedBy,
        username:  e.postedBy != null ? (userMap.get(e.postedBy) ?? null) : null,
        at:        e.postedAt,
        ip:        e.postedIp,
        userAgent: e.postedUserAgent,
        device:    deviceLabel(e.postedUserAgent),
        country:   e.postedIp && e.postedIp === e.createdIp ? createdCountry : postedCountry,
      } : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
