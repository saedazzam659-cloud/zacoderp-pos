import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  companiesTable,
  salesInvoicesTable,
  salesReturnsTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  invoicesTable,
  journalEntriesTable,
  journalEntryLinesTable,
  accountsTable,
  accountingMappingsTable,
  paymentVouchersTable,
  paymentVoucherLinesTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray, notInArray, sql as dsql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { customersTable } from "@workspace/db";
import { suppliersTable } from "@workspace/db";

// Entry types created automatically by source documents (sales/purchase
// invoices, vouchers, payroll, stock moves). Their VAT impact is ALREADY
// captured by the invoice tables aggregated above, so they MUST be excluded
// from the manual-adjustment query to avoid double counting.
// Mirrors LOCKED_ENTRY_TYPES in routes/journalEntries.ts — keep in sync.
const AUTO_GENERATED_ENTRY_TYPES = [
  "purchase_invoice", "purchase_return",
  "sales_invoice", "sales_return",
  "receipt_voucher", "payment_voucher", "receipt", "payment",
  "stock_transfer", "stock_adjustment",
  "supplier_settlement", "customer_settlement",
  "payroll_run", "employee_loan", "eos_payment",
];

// Default account codes used by the seed chart of accounts when the tenant
// has not customized accountingMappings yet. These match the defaults in
// artifacts/api-server/src/lib/accountingMappings.ts.
const VAT_OUTPUT_DEFAULT_CODE = "21041";
const VAT_INPUT_DEFAULT_CODE  = "11071";

// Resolve the company's VAT output / VAT input account ids. Prefers the
// accountingMappings configured by the tenant; falls back to the default
// chart-of-accounts codes (21041 / 11071). Returns null for either side if
// neither source can resolve the account — the caller treats that as
// "no manual adjustments to report" for that side.
async function resolveVatAccountIds(companyId: number) {
  const mappings = await db.select().from(accountingMappingsTable).where(and(
    eq(accountingMappingsTable.companyId, companyId),
    inArray(accountingMappingsTable.roleKey, ["vat_output", "vat_input"]),
  ));
  let outputId: number | null = null;
  let inputId:  number | null = null;
  for (const m of mappings) {
    if (m.accountId == null) continue;
    if (m.roleKey === "vat_output" && outputId == null) outputId = m.accountId;
    if (m.roleKey === "vat_input"  && inputId  == null) inputId  = m.accountId;
  }
  if (outputId == null || inputId == null) {
    const accts = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, companyId),
      inArray(accountsTable.code, [VAT_OUTPUT_DEFAULT_CODE, VAT_INPUT_DEFAULT_CODE]),
    ));
    for (const a of accts) {
      if (outputId == null && a.code === VAT_OUTPUT_DEFAULT_CODE) outputId = a.id;
      if (inputId  == null && a.code === VAT_INPUT_DEFAULT_CODE)  inputId  = a.id;
    }
  }
  return { outputId, inputId };
}

const router = Router();
router.use(extractAuth);
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// Bucket = { taxable base, VAT amount, document count } per rate category.
type Bucket = { base: number; vat: number; count: number };
const empty = (): Bucket => ({ base: 0, vat: 0, count: 0 });

// Classify a single document into standard / zero / exempt buckets using the
// header-level VAT amount. Matches the original classification rule so
// existing tenants see consistent numbers across the version bump.
function classify(rows: { base: number; vat: number }[]) {
  const std = empty(), zero = empty(), exempt = empty();
  for (const r of rows) {
    if (r.vat > 0)         { std.base    += r.base; std.vat    += r.vat; std.count++; }
    else if (r.base > 0)   { zero.base   += r.base; zero.vat   += 0;     zero.count++; }
    else                   { exempt.base += r.base; exempt.count++; }
  }
  const total: Bucket = {
    base:  std.base + zero.base + exempt.base,
    vat:   std.vat  + zero.vat,
    count: std.count + zero.count + exempt.count,
  };
  return { standardRated: std, zeroRated: zero, exempt, total };
}

// Strict YYYY-MM-DD validator. We refuse anything else so we never silently
// shift the period boundary because of a timezone offset on a full
// timestamp string. The four source tables all store dates as TEXT in this
// exact format so lexical comparison is correct.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// GET /api/reports/vat-declaration?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates output VAT (sales invoices − sales returns + legacy ZATCA
// invoices) and input VAT (purchase invoices − purchase returns) from the
// canonical accounting tables, all gated to status='posted' (or 'issued'
// for legacy ZATCA invoices). Drafts and cancelled docs are excluded.
router.get("/vat-declaration", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) { res.status(400).json({ error: "from و to مطلوبان (YYYY-MM-DD)" }); return; }
  if (!validIsoDate(from) || !validIsoDate(to)) {
    res.status(400).json({ error: "صيغة التاريخ غير صحيحة. الصيغة المطلوبة: YYYY-MM-DD" });
    return;
  }
  if (from > to) { res.status(400).json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }); return; }

  const companyId = resolveCompanyId(req, undefined);
  if (!companyId) {
    // Superadmins see this when they hit the endpoint without a company
    // context; non-superadmins are auto-scoped by resolveCompanyId.
    res.status(400).json({
      error: "الشركة غير محددة. يرجى تمرير companyId في الاستعلام (?companyId=<id>) لاختيار الشركة المطلوبة.",
    });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));

  // ─── Pull posted documents from all sources in parallel ────────────────
  // NOTE: branchId exists on the new tables but the report intentionally
  // aggregates across the whole company (matching how the VAT declaration
  // is filed at the legal-entity level).
  const [salesInv, salesRet, purchInv, purchRet, legacyInv] = await Promise.all([
    db.select().from(salesInvoicesTable).where(and(
      eq(salesInvoicesTable.companyId, companyId),
      eq(salesInvoicesTable.status, "posted"),
      gte(salesInvoicesTable.invoiceDate, from),
      lte(salesInvoicesTable.invoiceDate, to),
    )),
    db.select().from(salesReturnsTable).where(and(
      eq(salesReturnsTable.companyId, companyId),
      eq(salesReturnsTable.status, "posted"),
      gte(salesReturnsTable.returnDate, from),
      lte(salesReturnsTable.returnDate, to),
    )),
    db.select().from(purchaseInvoicesTable).where(and(
      eq(purchaseInvoicesTable.companyId, companyId),
      eq(purchaseInvoicesTable.status, "posted"),
      gte(purchaseInvoicesTable.invoiceDate, from),
      lte(purchaseInvoicesTable.invoiceDate, to),
    )),
    db.select().from(purchaseReturnsTable).where(and(
      eq(purchaseReturnsTable.companyId, companyId),
      eq(purchaseReturnsTable.status, "posted"),
      gte(purchaseReturnsTable.returnDate, from),
      lte(purchaseReturnsTable.returnDate, to),
    )),
    // Legacy ZATCA invoices table: kept as an ADDITIVE output-VAT source so
    // tenants that only use the legacy POST /api/invoices flow are not
    // dropped from the declaration. Its rows are independent of
    // sales_invoices (no foreign key, no shared id space) so additive
    // aggregation is safe — there is no de-dup key to use.
    db.select().from(invoicesTable).where(and(
      eq(invoicesTable.companyId, companyId),
      eq(invoicesTable.status, "issued"),
      gte(invoicesTable.issueDate, from),
      lte(invoicesTable.issueDate, to),
    )),
  ]);

  // Derive the taxable base for each document:
  //   • Sales / purchase INVOICES: base = subtotal − discountAmount
  //     (subtotal is the VAT-exclusive line-total sum per the insert
  //     helpers in sales.ts/purchasing.ts; using subtotal also avoids
  //     polluting the base with totalExpensesLoaded on purchase invoices.)
  //   • Sales / purchase RETURNS: base = totalAmount − vatAmount
  //     (returns store totalAmount as the VAT-inclusive grand total
  //     because lineTotal is VAT-inclusive in the form, so we subtract the
  //     header VAT to recover the taxable base.)
  //   • Legacy ZATCA invoices: base = subtotal − discountTotal (matches
  //     the original report's behaviour and the invoicesTable schema).
  const salesInvRows = salesInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountAmount)),
    vat:  Number(r.vatAmount),
  }));
  const salesRetRows = salesRet.map(r => ({
    base: Math.max(0, Number(r.totalAmount) - Number(r.vatAmount)),
    vat:  Number(r.vatAmount),
  }));
  const purchInvRows = purchInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountAmount)),
    vat:  Number(r.vatAmount),
  }));
  const purchRetRows = purchRet.map(r => ({
    base: Math.max(0, Number(r.totalAmount) - Number(r.vatAmount)),
    vat:  Number(r.vatAmount),
  }));
  const legacyRows = legacyInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountTotal)),
    vat:  Number(r.vatTotal),
  }));

  // Combine sales invoices + legacy ZATCA invoices on the output side.
  const outputSales      = classify([...salesInvRows, ...legacyRows]);
  const outputReturnsCls = classify(salesRetRows);
  const inputPurch       = classify(purchInvRows);
  const inputReturnsCls  = classify(purchRetRows);

  // Net the returns out of each side: returns reduce both base and VAT.
  function net(invoices: ReturnType<typeof classify>, returns: ReturnType<typeof classify>) {
    const sub = (a: Bucket, b: Bucket): Bucket => ({
      base:  a.base - b.base,
      vat:   a.vat  - b.vat,
      count: a.count, // count reflects original invoices; returns reported separately
    });
    return {
      standardRated: sub(invoices.standardRated, returns.standardRated),
      zeroRated:     sub(invoices.zeroRated,     returns.zeroRated),
      exempt:        sub(invoices.exempt,        returns.exempt),
      total:         sub(invoices.total,         returns.total),
    };
  }

  const outputTax = net(outputSales, outputReturnsCls);
  const inputTax  = net(inputPurch,  inputReturnsCls);

  // ─── Payment-voucher input VAT (additive) ──────────────────────────────
  // The multi-allocation payment voucher (سند الصرف) lets an accountant
  // record input VAT directly on a payment line (e.g. a cash expense with
  // recoverable VAT that never flowed through a purchase invoice). Each
  // posted line's `taxAmount` is the EXPLICIT input-VAT source — we read it
  // here rather than off the journal, because the voucher's JE carries the
  // "payment_voucher" entryType which is intentionally excluded from the
  // manual-adjustment query above (so there is NO double counting). Lines
  // with a positive taxAmount are treated as standard-rated purchases:
  // `amount` is the taxable base, `taxAmount` the VAT. Legacy single-amount
  // vouchers have no lines, so they contribute nothing here.
  const pvLines = await db
    .select({
      voucherId:  paymentVouchersTable.id,
      docNumber:  paymentVouchersTable.code,
      date:       paymentVouchersTable.date,
      amount:    paymentVoucherLinesTable.amount,
      taxAmount: paymentVoucherLinesTable.taxAmount,
      supplierName:          paymentVoucherLinesTable.supplierName,
      supplierVatNumber:     paymentVoucherLinesTable.supplierVatNumber,
      supplierInvoiceNumber: paymentVoucherLinesTable.supplierInvoiceNumber,
      supplierInvoiceDate:   paymentVoucherLinesTable.supplierInvoiceDate,
    })
    .from(paymentVoucherLinesTable)
    .innerJoin(
      paymentVouchersTable,
      eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id),
    )
    .where(and(
      eq(paymentVouchersTable.companyId, companyId),
      eq(paymentVouchersTable.status, "posted"),
      gte(paymentVouchersTable.date, from),
      lte(paymentVouchersTable.date, to),
    ));

  // Per-line supplier-tax breakdown surfaced on the declaration so the
  // accountant can see WHO the recoverable input VAT was paid to, straight
  // from the payment-voucher and manual-JE lines that carry the metadata.
  type SupplierTaxLine = {
    source: string;
    docNumber: string | null;
    date: string;
    supplierName: string | null;
    supplierVatNumber: string | null;
    supplierInvoiceNumber: string | null;
    supplierInvoiceDate: string | null;
    base: number;
    vat: number;
  };
  const supplierTaxLines: SupplierTaxLine[] = [];
  const hasSup = (l: { supplierName: string | null; supplierVatNumber: string | null; supplierInvoiceNumber: string | null; supplierInvoiceDate: string | null }) =>
    !!((l.supplierName ?? "").trim() || (l.supplierVatNumber ?? "").trim() ||
       (l.supplierInvoiceNumber ?? "").trim() || (l.supplierInvoiceDate ?? "").trim());

  let paymentVoucherInputBase = 0;
  let paymentVoucherInputVat  = 0;
  for (const l of pvLines) {
    const tax = Number(l.taxAmount);
    if (Math.abs(tax) > 0.005) {
      paymentVoucherInputVat  += tax;
      paymentVoucherInputBase += Number(l.amount);
      if (hasSup(l)) {
        supplierTaxLines.push({
          source: "payment_voucher",
          docNumber: l.docNumber ?? null,
          date: l.date,
          supplierName:          (l.supplierName ?? "").trim() || null,
          supplierVatNumber:     (l.supplierVatNumber ?? "").trim() || null,
          supplierInvoiceNumber: (l.supplierInvoiceNumber ?? "").trim() || null,
          supplierInvoiceDate:   (l.supplierInvoiceDate ?? "").trim() || null,
          base: Number(l.amount),
          vat:  tax,
        });
      }
    }
  }
  // Fold into the standard-rated input bucket + totals so it flows through
  // netVat and the frontend's existing input-tax rendering unchanged.
  if (Math.abs(paymentVoucherInputVat) > 0.005 || paymentVoucherInputBase !== 0) {
    inputTax.standardRated.base += paymentVoucherInputBase;
    inputTax.standardRated.vat  += paymentVoucherInputVat;
    inputTax.total.base         += paymentVoucherInputBase;
    inputTax.total.vat          += paymentVoucherInputVat;
  }

  // ─── Manual journal-entry adjustments to VAT ───────────────────────────
  // Tenants sometimes record VAT corrections, accruals, or write-offs
  // directly via a journal entry instead of a sales/purchase invoice
  // (e.g. an external auditor adjustment). These don't show up in the
  // invoice tables, so we additively pull them in here. We only count
  // POSTED entries whose entryType is NOT in AUTO_GENERATED_ENTRY_TYPES —
  // auto-generated entries from invoices/vouchers would otherwise be
  // double-counted with the invoice-based aggregation above.
  //
  // VAT-output is a liability account: a credit increases output VAT
  // (additional VAT collected), a debit reduces it (refund/correction).
  // VAT-input is an asset account: a debit increases input VAT
  // (recoverable), a credit reduces it.
  const { outputId: vatOutAcctId, inputId: vatInAcctId } = await resolveVatAccountIds(companyId);

  type AdjustmentSupplierTax = {
    supplierName: string | null;
    supplierVatNumber: string | null;
    supplierInvoiceNumber: string | null;
    supplierInvoiceDate: string | null;
  };
  type AdjustmentEntry = {
    id: number;
    docNumber: string | null;
    entryDate: string;
    description: string | null;
    entryType: string;
    outputVat: number;
    inputVat:  number;
    // Supplier tax metadata entered via the ⋮ menu on the JE's VAT line(s).
    // Surfaced so the accountant sees the supplier behind each manual VAT
    // adjustment straight from the report's red "تسويات يدوية" section.
    supplierTax: AdjustmentSupplierTax[];
  };
  const journalAdjustments: {
    outputVat: number;
    inputVat:  number;
    entryCount: number;
    entries: AdjustmentEntry[];
  } = { outputVat: 0, inputVat: 0, entryCount: 0, entries: [] };

  const targetAccountIds = [vatOutAcctId, vatInAcctId].filter((x): x is number => x != null);
  if (targetAccountIds.length > 0) {
    const rows = await db
      .select({
        id:           journalEntriesTable.id,
        docNumber:    journalEntriesTable.docNumber,
        entryDate:    journalEntriesTable.entryDate,
        description:  journalEntriesTable.description,
        entryType:    journalEntriesTable.entryType,
        lineAccount:  journalEntryLinesTable.accountId,
        lineDebit:    journalEntryLinesTable.debit,
        lineCredit:   journalEntryLinesTable.credit,
        supplierName:          journalEntryLinesTable.supplierName,
        supplierVatNumber:     journalEntryLinesTable.supplierVatNumber,
        supplierInvoiceNumber: journalEntryLinesTable.supplierInvoiceNumber,
        supplierInvoiceDate:   journalEntryLinesTable.supplierInvoiceDate,
      })
      .from(journalEntriesTable)
      .innerJoin(
        journalEntryLinesTable,
        eq(journalEntryLinesTable.entryId, journalEntriesTable.id),
      )
      .where(and(
        eq(journalEntriesTable.companyId, companyId),
        eq(journalEntriesTable.status, "posted"),
        gte(journalEntriesTable.entryDate, from),
        lte(journalEntriesTable.entryDate, to),
        notInArray(journalEntriesTable.entryType, AUTO_GENERATED_ENTRY_TYPES),
        inArray(journalEntryLinesTable.accountId, targetAccountIds),
      ));

    const byEntry = new Map<number, AdjustmentEntry>();
    for (const r of rows) {
      let agg = byEntry.get(r.id);
      if (!agg) {
        agg = {
          id: r.id, docNumber: r.docNumber, entryDate: r.entryDate,
          description: r.description, entryType: r.entryType,
          outputVat: 0, inputVat: 0, supplierTax: [],
        };
        byEntry.set(r.id, agg);
      }
      const debit  = Number(r.lineDebit);
      const credit = Number(r.lineCredit);
      const isVatOut = vatOutAcctId != null && r.lineAccount === vatOutAcctId;
      const isVatIn  = vatInAcctId  != null && r.lineAccount === vatInAcctId;
      if (isVatOut) {
        agg.outputVat += credit - debit;
      }
      if (isVatIn) {
        agg.inputVat += debit - credit;
      }
      // Surface manual-JE supplier tax metadata on the VAT lines only.
      if ((isVatOut || isVatIn) && hasSup(r)) {
        const block: AdjustmentSupplierTax = {
          supplierName:          (r.supplierName ?? "").trim() || null,
          supplierVatNumber:     (r.supplierVatNumber ?? "").trim() || null,
          supplierInvoiceNumber: (r.supplierInvoiceNumber ?? "").trim() || null,
          supplierInvoiceDate:   (r.supplierInvoiceDate ?? "").trim() || null,
        };
        // Attach to the aggregated entry (dedup — a JE may repeat the same
        // supplier across its output & input VAT lines).
        const blockKey = `${block.supplierName}|${block.supplierVatNumber}|${block.supplierInvoiceNumber}|${block.supplierInvoiceDate}`;
        if (!agg.supplierTax.some(s =>
          `${s.supplierName}|${s.supplierVatNumber}|${s.supplierInvoiceNumber}|${s.supplierInvoiceDate}` === blockKey)) {
          agg.supplierTax.push(block);
        }
        supplierTaxLines.push({
          source: isVatOut ? "journal_output" : "journal_input",
          docNumber: r.docNumber ?? null,
          date: r.entryDate,
          ...block,
          base: 0,
          vat:  isVatOut ? (credit - debit) : (debit - credit),
        });
      }
    }
    // Drop entries whose net VAT impact rounds to zero — those are pure
    // contra entries between the two VAT accounts (e.g. period-end
    // settlement) and adding zero rows clutters the report.
    const entries = Array.from(byEntry.values())
      .filter(e => Math.abs(e.outputVat) > 0.005 || Math.abs(e.inputVat) > 0.005)
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id - b.id);

    journalAdjustments.entries    = entries;
    journalAdjustments.entryCount = entries.length;
    journalAdjustments.outputVat  = entries.reduce((s, e) => s + e.outputVat, 0);
    journalAdjustments.inputVat   = entries.reduce((s, e) => s + e.inputVat,  0);
  }

  // Net VAT now factors in the manual adjustments on both sides.
  const netVat = (outputTax.total.vat + journalAdjustments.outputVat)
               - (inputTax.total.vat  + journalAdjustments.inputVat);

  // Discount disclosure on the sales side (sales_invoices + legacy).
  const discountTotal =
    salesInv.reduce((s, r) => s + Number(r.discountAmount), 0) +
    legacyInv.reduce((s, r) => s + Number(r.discountTotal), 0);

  // invoiceType (standard vs simplified) only exists on the legacy
  // invoicesTable; sales_invoices doesn't track it. We surface the legacy
  // split when present and report 0 for the new-table rows.
  let standardTypeCount = 0;
  let simplifiedTypeCount = 0;
  for (const inv of legacyInv) {
    if (inv.invoiceType === "standard")        standardTypeCount++;
    else if (inv.invoiceType === "simplified") simplifiedTypeCount++;
  }
  const invoiceBreakdown = {
    standardTypeCount,
    simplifiedTypeCount,
    totalCount: salesInv.length + legacyInv.length,
  };

  res.json({
    period: { from, to },
    company: company ? {
      nameAr:    company.nameAr,
      nameEn:    company.nameEn,
      vatNumber: company.vatNumber,
      crNumber:  company.crNumber,
      city:      company.city,
    } : null,
    outputTax,
    inputTax,
    // Per-side returns surfaced so the frontend can show the deducted
    // amount explicitly. Numbers here are POSITIVE; they have already been
    // subtracted from outputTax / inputTax above.
    returns: {
      sales:     outputReturnsCls.total,
      purchases: inputReturnsCls.total,
    },
    netVat,
    discountTotal,
    // Explicit disclosure of the input VAT that came from payment-voucher
    // lines (already folded into inputTax.standardRated / inputTax.total).
    paymentVoucherInputVat,
    // Per-line supplier tax metadata (from payment-voucher lines + manual-JE
    // VAT lines) entered via the ⋮ supplier-details menu. Sorted by date so
    // the frontend renders a clean chronological supplier VAT breakdown.
    supplierTaxLines: supplierTaxLines
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date)),
    invoiceBreakdown,
    // Manual VAT adjustments recorded directly in the journal (NOT auto-
    // generated from invoices). The frontend renders these as a separate
    // section so the auditor can see exactly what came from invoices vs
    // what came from a journal-level correction.
    journalAdjustments,
  });
});

// GET /api/reports/vat-declaration/details?from=&to=&bucket=<key>
// Drill-down: returns the underlying invoices/returns that produced the
// given bucket value on the VAT declaration. Buckets:
//   sales_standard | sales_zero | sales_exempt
//   purchases_standard | purchases_zero | purchases_exempt
//   sales_returns | purchase_returns
type Bucket3 = "standard" | "zero" | "exempt";
function classifyOne(base: number, vat: number): Bucket3 {
  if (vat > 0) return "standard";
  if (base > 0) return "zero";
  return "exempt";
}

router.get("/vat-declaration/details", async (req, res) => {
  const { from, to, bucket } = req.query as { from?: string; to?: string; bucket?: string };
  if (!from || !to || !bucket) { res.status(400).json({ error: "from و to و bucket مطلوبة" }); return; }
  if (!validIsoDate(from) || !validIsoDate(to)) { res.status(400).json({ error: "صيغة التاريخ غير صحيحة" }); return; }
  const companyId = resolveCompanyId(req, undefined);
  if (!companyId) { res.status(400).json({ error: "الشركة غير محددة" }); return; }

  type DocRow = {
    id: number; source: string; docNumber: string | null; date: string;
    partyName: string | null;
    // Supplier tax metadata surfaced in the drill-down so the empty
    // "العميل / المورد" cell for payment-voucher rows gets filled and the
    // supplier VAT #, supplier invoice #, and invoice date are visible.
    supplierVatNumber: string | null;
    supplierInvoiceNumber: string | null;
    supplierInvoiceDate: string | null;
    // Payment-voucher-only extras: header البيان (description) + ملاحظات
    // (notes), plus whether the voucher carries multiple allocation lines
    // (عمليات متعددة) vs a single normal operation (عادي). The frontend shows
    // البيان/ملاحظات only for the normal (single-operation) case.
    voucherDescription?: string | null;
    voucherNotes?: string | null;
    isMultiVoucher?: boolean;
    base: number; vat: number; total: number; link: string | null;
  };
  const out: DocRow[] = [];

  const want = bucket; // sales_standard | sales_zero | sales_exempt | purchases_* | sales_returns | purchase_returns

  if (want.startsWith("sales_") && want !== "sales_returns") {
    const target: Bucket3 = want === "sales_standard" ? "standard" : want === "sales_zero" ? "zero" : "exempt";
    // sales_invoices left-join customers
    const rows = await db
      .select({
        id: salesInvoicesTable.id,
        docNumber: salesInvoicesTable.docNumber,
        date: salesInvoicesTable.invoiceDate,
        subtotal: salesInvoicesTable.subtotal,
        discountAmount: salesInvoicesTable.discountAmount,
        vat: salesInvoicesTable.vatAmount,
        total: salesInvoicesTable.totalAmount,
        custAr: customersTable.nameAr,
        custEn: customersTable.nameEn,
      })
      .from(salesInvoicesTable)
      .leftJoin(customersTable, eq(customersTable.id, salesInvoicesTable.customerId))
      .where(and(
        eq(salesInvoicesTable.companyId, companyId),
        eq(salesInvoicesTable.status, "posted"),
        gte(salesInvoicesTable.invoiceDate, from),
        lte(salesInvoicesTable.invoiceDate, to),
      ));
    for (const r of rows) {
      const base = Math.max(0, Number(r.subtotal) - Number(r.discountAmount));
      const vat  = Number(r.vat);
      if (classifyOne(base, vat) !== target) continue;
      out.push({
        id: r.id, source: "sales_invoice",
        docNumber: r.docNumber, date: r.date,
        partyName: r.custAr ?? r.custEn ?? null,
        supplierVatNumber: null, supplierInvoiceNumber: null, supplierInvoiceDate: null,
        base, vat, total: Number(r.total),
        link: `/sales/invoices/${r.id}`,
      });
    }
    // legacy invoices
    const legacy = await db.select().from(invoicesTable).where(and(
      eq(invoicesTable.companyId, companyId),
      eq(invoicesTable.status, "issued"),
      gte(invoicesTable.issueDate, from),
      lte(invoicesTable.issueDate, to),
    ));
    for (const r of legacy) {
      const base = Math.max(0, Number(r.subtotal) - Number(r.discountTotal));
      const vat  = Number(r.vatTotal);
      if (classifyOne(base, vat) !== target) continue;
      out.push({
        id: r.id, source: "legacy_invoice",
        docNumber: r.invoiceNumber, date: String(r.issueDate),
        partyName: (r as any).customerName ?? null,
        supplierVatNumber: null, supplierInvoiceNumber: null, supplierInvoiceDate: null,
        base, vat, total: base + vat,
        link: `/invoices/${r.id}`,
      });
    }
  } else if (want.startsWith("purchases_") && want !== "purchases_returns") {
    const target: Bucket3 = want === "purchases_standard" ? "standard" : want === "purchases_zero" ? "zero" : "exempt";
    const rows = await db
      .select({
        id: purchaseInvoicesTable.id,
        docNumber: purchaseInvoicesTable.docNumber,
        date: purchaseInvoicesTable.invoiceDate,
        subtotal: purchaseInvoicesTable.subtotal,
        discountAmount: purchaseInvoicesTable.discountAmount,
        vat: purchaseInvoicesTable.vatAmount,
        total: purchaseInvoicesTable.totalAmount,
        supAr: suppliersTable.nameAr,
        supEn: suppliersTable.nameEn,
        supVat: suppliersTable.vatNumber,
        supplierInvoiceNumber: purchaseInvoicesTable.supplierInvoiceNumber,
      })
      .from(purchaseInvoicesTable)
      .leftJoin(suppliersTable, eq(suppliersTable.id, purchaseInvoicesTable.supplierId))
      .where(and(
        eq(purchaseInvoicesTable.companyId, companyId),
        eq(purchaseInvoicesTable.status, "posted"),
        gte(purchaseInvoicesTable.invoiceDate, from),
        lte(purchaseInvoicesTable.invoiceDate, to),
      ));
    for (const r of rows) {
      const base = Math.max(0, Number(r.subtotal) - Number(r.discountAmount));
      const vat  = Number(r.vat);
      if (classifyOne(base, vat) !== target) continue;
      out.push({
        id: r.id, source: "purchase_invoice",
        docNumber: r.docNumber, date: r.date,
        partyName: r.supAr ?? r.supEn ?? null,
        supplierVatNumber: (r.supVat ?? "").trim() || null,
        supplierInvoiceNumber: (r.supplierInvoiceNumber ?? "").trim() || null,
        supplierInvoiceDate: r.date,
        base, vat, total: Number(r.total),
        link: `/purchasing/invoices/${r.id}`,
      });
    }
    // Payment-voucher lines with input VAT are standard-rated purchases.
    if (target === "standard") {
      const pvRows = await db
        .select({
          voucherId:  paymentVouchersTable.id,
          docNumber:  paymentVouchersTable.code,
          date:       paymentVouchersTable.date,
          entityId:   paymentVouchersTable.entityId,
          entityName: paymentVouchersTable.entityName,
          voucherDescription: paymentVouchersTable.description,
          voucherNotes:       paymentVouchersTable.notes,
          // Header supplier (resolved from entityId) so a voucher that stored
          // no free-text entityName still shows the supplier's real name.
          hdrSupAr:   suppliersTable.nameAr,
          hdrSupEn:   suppliersTable.nameEn,
          amount:     paymentVoucherLinesTable.amount,
          taxAmount:  paymentVoucherLinesTable.taxAmount,
          supplierName:          paymentVoucherLinesTable.supplierName,
          supplierVatNumber:     paymentVoucherLinesTable.supplierVatNumber,
          supplierInvoiceNumber: paymentVoucherLinesTable.supplierInvoiceNumber,
          supplierInvoiceDate:   paymentVoucherLinesTable.supplierInvoiceDate,
        })
        .from(paymentVoucherLinesTable)
        .innerJoin(
          paymentVouchersTable,
          eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id),
        )
        .leftJoin(
          suppliersTable,
          and(
            eq(suppliersTable.id, paymentVouchersTable.entityId),
            eq(suppliersTable.companyId, companyId),
          ),
        )
        .where(and(
          eq(paymentVouchersTable.companyId, companyId),
          eq(paymentVouchersTable.status, "posted"),
          gte(paymentVouchersTable.date, from),
          lte(paymentVouchersTable.date, to),
        ));
      // Count allocation lines per voucher: >1 line ⇒ multi-operation voucher
      // (عمليات متعددة), exactly one ⇒ normal single-operation voucher (عادي).
      const pvLineCount = new Map<number, number>();
      for (const r of pvRows) pvLineCount.set(r.voucherId, (pvLineCount.get(r.voucherId) ?? 0) + 1);
      for (const r of pvRows) {
        const vat = Number(r.taxAmount);
        if (Math.abs(vat) <= 0.005) continue;
        const base = Number(r.amount);
        const isMulti = (pvLineCount.get(r.voucherId) ?? 1) > 1;
        // Resolve the supplier name: per-line supplier (multi) → header
        // free-text entity name → header supplier looked up via entityId.
        const pvSupName = (r.supplierName ?? "").trim()
          || (r.entityName ?? "").trim()
          || (r.hdrSupAr ?? "").trim()
          || (r.hdrSupEn ?? "").trim()
          || null;
        out.push({
          id: r.voucherId, source: "payment_voucher",
          docNumber: r.docNumber, date: r.date,
          partyName: pvSupName,
          supplierVatNumber:     (r.supplierVatNumber ?? "").trim() || null,
          supplierInvoiceNumber: (r.supplierInvoiceNumber ?? "").trim() || null,
          supplierInvoiceDate:   (r.supplierInvoiceDate ?? "").trim() || null,
          // Normal (single-operation) vouchers also surface البيان + ملاحظات
          // in the consolidated cell; multi-operation vouchers do not.
          voucherDescription: isMulti ? null : ((r.voucherDescription ?? "").trim() || null),
          voucherNotes:       isMulti ? null : ((r.voucherNotes ?? "").trim() || null),
          isMultiVoucher: isMulti,
          base, vat, total: base + vat,
          link: `/cash/payment-vouchers/${r.voucherId}`,
        });
      }
    }
  } else if (want === "sales_returns") {
    const rows = await db
      .select({
        id: salesReturnsTable.id,
        docNumber: salesReturnsTable.docNumber,
        date: salesReturnsTable.returnDate,
        total: salesReturnsTable.totalAmount,
        vat: salesReturnsTable.vatAmount,
        custAr: customersTable.nameAr,
        custEn: customersTable.nameEn,
      })
      .from(salesReturnsTable)
      .leftJoin(customersTable, eq(customersTable.id, salesReturnsTable.customerId))
      .where(and(
        eq(salesReturnsTable.companyId, companyId),
        eq(salesReturnsTable.status, "posted"),
        gte(salesReturnsTable.returnDate, from),
        lte(salesReturnsTable.returnDate, to),
      ));
    for (const r of rows) {
      const vat = Number(r.vat);
      const base = Math.max(0, Number(r.total) - vat);
      out.push({
        id: r.id, source: "sales_return", docNumber: r.docNumber, date: r.date,
        partyName: r.custAr ?? r.custEn ?? null,
        supplierVatNumber: null, supplierInvoiceNumber: null, supplierInvoiceDate: null,
        base, vat, total: Number(r.total), link: `/sales/returns`,
      });
    }
  } else if (want === "purchase_returns" || want === "purchases_returns") {
    const rows = await db
      .select({
        id: purchaseReturnsTable.id,
        docNumber: purchaseReturnsTable.docNumber,
        date: purchaseReturnsTable.returnDate,
        total: purchaseReturnsTable.totalAmount,
        vat: purchaseReturnsTable.vatAmount,
        supAr: suppliersTable.nameAr,
        supEn: suppliersTable.nameEn,
        supVat: suppliersTable.vatNumber,
      })
      .from(purchaseReturnsTable)
      .leftJoin(suppliersTable, eq(suppliersTable.id, purchaseReturnsTable.supplierId))
      .where(and(
        eq(purchaseReturnsTable.companyId, companyId),
        eq(purchaseReturnsTable.status, "posted"),
        gte(purchaseReturnsTable.returnDate, from),
        lte(purchaseReturnsTable.returnDate, to),
      ));
    for (const r of rows) {
      const vat = Number(r.vat);
      const base = Math.max(0, Number(r.total) - vat);
      out.push({
        id: r.id, source: "purchase_return", docNumber: r.docNumber, date: r.date,
        partyName: r.supAr ?? r.supEn ?? null,
        supplierVatNumber: (r.supVat ?? "").trim() || null,
        supplierInvoiceNumber: null, supplierInvoiceDate: null,
        base, vat, total: Number(r.total), link: `/purchasing/returns`,
      });
    }
  } else {
    res.status(400).json({ error: "bucket غير معروف" });
    return;
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const totals = out.reduce(
    (s, r) => ({ base: s.base + r.base, vat: s.vat + r.vat, total: s.total + r.total, count: s.count + 1 }),
    { base: 0, vat: 0, total: 0, count: 0 },
  );
  // dsql import retained for future filters; suppress lint if unused.
  void dsql;
  res.json({ bucket: want, period: { from, to }, items: out, totals });
});

export default router;
