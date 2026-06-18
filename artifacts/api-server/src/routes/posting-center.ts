/**
 * Posting Center (مركز الترحيل)
 *
 * Unified read-only listing endpoint that aggregates documents across all
 * "postable" modules in one place so accountants can do bulk manual posting
 * from a single screen instead of jumping between Sales / Purchases / Cash.
 *
 * Bulk POST / UNPOST is intentionally NOT implemented in this router — the
 * client calls the existing per-module post endpoints in chunks
 * (PATCH /api/sales/sales-invoices/:id/post, etc.) so the original posting
 * logic (journal entries, stock movements, account-mapping resolution) is
 * not duplicated. This keeps a single source of truth for the JE math and
 * means improvements to those handlers automatically apply here too.
 *
 * Endpoints:
 *   GET /api/posting-center/list?module=X&status=Y[&search=&dateFrom=&dateTo=]
 *   GET /api/posting-center/ai-summary?module=X
 *
 * Modules supported (all read with company-scoped queries):
 *   sales_invoices, sales_returns,
 *   purchase_invoices, purchase_returns,
 *   receipt_vouchers, payment_vouchers
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesReturnsTable,
  purchaseInvoicesTable, purchaseReturnsTable,
  receiptVouchersTable, paymentVouchersTable,
  customersTable, suppliersTable,
  journalEntriesTable, journalEntryLinesTable,
  goodsReceiptsTable, goodsDeliveriesTable,
  cashTransfersTable,
  stockTransfersTable, stockAdjustmentsTable, stockCountsTable,
  warehousesTable, cashBoxesTable, bankAccountsTable,
  sisterTransfersTable, sisterReturnsTable, sisterSettlementsTable,
  sisterCompaniesTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, inArray, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import type { Request } from "express";

const router = Router();
// Auth gate at the router level — closes the unauthenticated
// `?companyId=…` data-exposure path that an `extractAuth`-only setup
// would leave open. Per-MODULE permission checks happen inside each
// handler (see requireModuleView below) once we know which module the
// caller is asking about — gating the entire router on `journal_entries`
// would lock users out of "مرتجعات المبيعات" / "سندات القبض" / etc.
// when their tenant only has Sales/Cash enabled but not Accounting.
router.use(extractAuth);

// Maps each posting-center module to the permission key the regular
// per-module routes use. requirePermission(key, "view") then enforces
// BOTH the company-level menu gate (e.g. sales_module / cash_module)
// AND the per-user view permission, exactly like the per-module
// listing endpoint would. Admins/superadmins still bypass.
const MODULE_PERM_KEY: Record<string, string> = {
  sales_invoices:    "sales_invoices",
  pos_sales:         "pos",              // POS-originated invoices (posSessionId IS NOT NULL)
  sales_returns:     "sales_returns",
  purchase_invoices: "purchase_invoices",
  purchase_returns:  "purchase_returns",
  receipt_vouchers:  "receipt_vouchers",
  payment_vouchers:  "payment_vouchers",
  journal_entries:   "journal_entries",
  goods_receipts:    "purchase_invoices", // GRNs gated under purchases module
  goods_deliveries:  "sales_invoices",    // delivery notes gated under sales module
  cash_transfers:    "cash_boxes",
  stock_transfers:   "stock_transfers",
  stock_adjustments: "stock_adjustments",
  stock_counts:      "stock_counts",
  sister_transfers:   "sister_companies",
  sister_returns:     "sister_companies",
  sister_settlements: "sister_companies",
};

// Hard server-side cap on the number of rows returned per list call. The
// frontend is a non-virtualized table, and the bulk-post action operates on
// client-selected rows, so returning the whole module table for very large
// tenants would crash the browser and balloon the JSON payload. Tenants
// exceeding the cap are expected to narrow with status / date / search
// filters (the sticky header surfaces the cap). 5000 is well above the
// daily working set of any realistic SMB while staying within a few-MB
// JSON payload and a snappy DOM render.
const LIST_LIMIT = 5000;

const MODULES = [
  "sales_invoices",
  "pos_sales",
  "sales_returns",
  "purchase_invoices",
  "purchase_returns",
  "receipt_vouchers",
  "payment_vouchers",
  "journal_entries",
  "goods_receipts",
  "goods_deliveries",
  "cash_transfers",
  "stock_transfers",
  "stock_adjustments",
  "stock_counts",
  "sister_transfers",
  "sister_returns",
  "sister_settlements",
] as const;
type ModuleKey = typeof MODULES[number];

const MODULE_LABELS_AR: Record<ModuleKey, string> = {
  sales_invoices:    "فواتير المبيعات",
  pos_sales:         "فواتير نقاط البيع",
  sales_returns:     "مرتجعات المبيعات",
  purchase_invoices: "فواتير المشتريات",
  purchase_returns:  "مرتجعات المشتريات",
  receipt_vouchers:  "سندات القبض",
  payment_vouchers:  "سندات الصرف",
  journal_entries:   "القيود المحاسبية",
  goods_receipts:    "إيصالات الاستلام",
  goods_deliveries:  "إذونات التسليم",
  cash_transfers:    "التحويلات النقدية",
  stock_transfers:   "تحويلات المخزون",
  stock_adjustments: "تسويات المخزون",
  stock_counts:      "جرد المخزون",
  sister_transfers:   "تحويلات الشركات الشقيقة",
  sister_returns:     "مرتجعات الشركات الشقيقة",
  sister_settlements: "تسويات الشركات الشقيقة",
};

// Unified row shape returned to the client. Every module is mapped onto this
// shape so the frontend grid can render a single column set regardless of
// which module is selected.
type PostingRow = {
  id: number;
  module: ModuleKey;
  docNumber: string | null;
  date: string;
  type: string;            // human-readable Arabic label of the module
  description: string | null;
  party: string | null;    // customer / supplier / entity name
  amount: number;
  status: string;          // raw module status (draft / posted / cancelled)
  posted: boolean;
  journalEntryId: number | null;
  journalEntryDocNumber: string | null;
};

// Per-module permission gate used as inline middleware on each handler.
// Resolves the requested module from the query string, validates it, then
// hands off to requirePermission(modKey, "view") which enforces the
// company-level menu gate AND the per-user view permission. Centralised
// here so /list and /ai-summary share the exact same gating logic.
function gateByModule(req: any, res: any, next: any) {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  const moduleParam = (req.query.module as string) || "sales_invoices";
  if (!MODULES.includes(moduleParam as ModuleKey)) {
    res.status(400).json({ error: "نوع حركة غير صالح" });
    return;
  }
  const permKey = MODULE_PERM_KEY[moduleParam] || "journal_entries";
  return requirePermission(permKey, "view")(req, res, next);
}

// ─── List endpoint ──────────────────────────────────────────────────────────
router.get("/list", gateByModule, async (req, res) => {
  const cid = resolveCompanyId(
    req,
    req.query.companyId ? parseInt(req.query.companyId as string) : undefined,
  );
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  // gateByModule already validated the module; safe to cast.
  const mod = ((req.query.module as string) || "sales_invoices") as ModuleKey;

  // posted | unposted | all  (default: unposted — matches "غير مرحل" in the UI)
  const statusFilter = (req.query.status as string) || "unposted";
  const dateFrom = (req.query.dateFrom as string) || undefined;
  const dateTo = (req.query.dateTo as string) || undefined;
  // Branch filter — when omitted ("all"), branchScopeSpread still applies the
  // user's per-branch policy (viewAllBranches=false → only assigned branches).
  // When a specific branchId is passed, rows where branch_id matches OR
  // branch_id IS NULL (shared/company-wide) are included — see Branch Filter
  // semantics in replit.md.
  const branchIdRaw = req.query.branchId as string | undefined;

  try {
    let rows: PostingRow[] = [];

    switch (mod) {
      case "sales_invoices":    rows = await listSalesInvoices(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "pos_sales":         rows = await listPosSales(req, cid, dateFrom, dateTo, branchIdRaw);      break;
      case "sales_returns":     rows = await listSalesReturns(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "purchase_invoices": rows = await listPurchaseInvoices(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "purchase_returns":  rows = await listPurchaseReturns(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "receipt_vouchers":  rows = await listReceiptVouchers(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "payment_vouchers":  rows = await listPaymentVouchers(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "journal_entries":   rows = await listJournalEntries(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "goods_receipts":    rows = await listGoodsReceipts(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "goods_deliveries":  rows = await listGoodsDeliveries(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "cash_transfers":    rows = await listCashTransfers(req, cid, dateFrom, dateTo, branchIdRaw); break;
      // stock_transfers / stock_adjustments / stock_counts have no branch_id
      // column on the header — they're scoped by warehouse, not branch.
      case "stock_transfers":   rows = await listStockTransfers(cid, dateFrom, dateTo); break;
      case "stock_adjustments": rows = await listStockAdjustments(cid, dateFrom, dateTo); break;
      case "stock_counts":      rows = await listStockCounts(cid, dateFrom, dateTo); break;
      case "sister_transfers":   rows = await listSisterTransfers(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "sister_returns":     rows = await listSisterReturns(req, cid, dateFrom, dateTo, branchIdRaw); break;
      case "sister_settlements": rows = await listSisterSettlements(req, cid, dateFrom, dateTo, branchIdRaw); break;
    }

    // Resolve journal-entry doc numbers in one extra round-trip when any
    // posted rows are present, so the grid can show "رقم القيد" without
    // forcing the client to fetch each JE individually.
    const jeIds = rows.map(r => r.journalEntryId).filter((x): x is number => !!x);
    if (jeIds.length > 0) {
      const uniqueJeIds = Array.from(new Set(jeIds));
      const jeRows = await db.select({
        id: journalEntriesTable.id,
        docNumber: journalEntriesTable.docNumber,
      })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          inArray(journalEntriesTable.id, uniqueJeIds),
        ));
      const jeMap = new Map(jeRows.map(j => [j.id, j.docNumber] as const));
      for (const r of rows) {
        if (r.journalEntryId) {
          r.journalEntryDocNumber = jeMap.get(r.journalEntryId) ?? null;
        }
      }
    }

    // Apply status filter AFTER mapping so each module's status semantics
    // are normalised through `posted` first.
    let filtered = rows;
    if (statusFilter === "posted") {
      filtered = rows.filter(r => r.posted);
    } else if (statusFilter === "unposted") {
      // "Unposted" means: anything that COULD still be posted — i.e. not
      // already posted AND not cancelled. We only show actionable rows so
      // the bulk-post button never hits a cancelled doc and gets rejected.
      filtered = rows.filter(r => !r.posted && r.status !== "cancelled");
    }

    // Optional client-side search hook (Arabic name, doc#, JE#, description)
    const search = (req.query.search as string)?.trim().toLowerCase();
    if (search) {
      filtered = filtered.filter(r =>
        (r.docNumber ?? "").toLowerCase().includes(search) ||
        (r.party ?? "").toLowerCase().includes(search) ||
        (r.description ?? "").toLowerCase().includes(search) ||
        (r.journalEntryDocNumber ?? "").toLowerCase().includes(search),
      );
    }

    // Cap payload size to keep the browser snappy and prevent multi-MB
    // JSON responses for very large tenants. Filters narrow the set first,
    // so the cap only kicks in when the user picks a deliberately broad
    // selection (e.g. "all of last year, posted + unposted, no search").
    const totalMatched = filtered.length;
    const truncated = totalMatched > LIST_LIMIT;
    const items = truncated ? filtered.slice(0, LIST_LIMIT) : filtered;

    res.json({
      module: mod,
      moduleLabel: MODULE_LABELS_AR[mod],
      total: items.length,
      totalMatched,
      truncated,
      limit: LIST_LIMIT,
      items,
    });
  } catch (err: any) {
    req.log?.error?.({ err }, "posting-center list failed");
    res.status(500).json({ error: err?.message || "خطأ في جلب البيانات" });
  }
});

// ─── AI summary ─────────────────────────────────────────────────────────────
// Lightweight statistical analysis for the currently-selected module: counts,
// totals, anomaly flags. No external AI call required — we keep this fast and
// deterministic so it never hangs on a missing API key. The frontend renders
// the result as a friendly Arabic summary card.
router.get("/ai-summary", gateByModule, async (req, res) => {
  const cid = resolveCompanyId(
    req,
    req.query.companyId ? parseInt(req.query.companyId as string) : undefined,
  );
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  // gateByModule already validated the module; safe to cast.
  const mod = ((req.query.module as string) || "sales_invoices") as ModuleKey;
  const branchIdRaw = req.query.branchId as string | undefined;

  try {
    let rows: PostingRow[] = [];
    switch (mod as ModuleKey) {
      case "sales_invoices":    rows = await listSalesInvoices(req, cid, undefined, undefined, branchIdRaw);    break;
      case "pos_sales":         rows = await listPosSales(req, cid, undefined, undefined, branchIdRaw);         break;
      case "sales_returns":     rows = await listSalesReturns(req, cid, undefined, undefined, branchIdRaw);     break;
      case "purchase_invoices": rows = await listPurchaseInvoices(req, cid, undefined, undefined, branchIdRaw); break;
      case "purchase_returns":  rows = await listPurchaseReturns(req, cid, undefined, undefined, branchIdRaw);  break;
      case "receipt_vouchers":  rows = await listReceiptVouchers(req, cid, undefined, undefined, branchIdRaw);  break;
      case "payment_vouchers":  rows = await listPaymentVouchers(req, cid, undefined, undefined, branchIdRaw);  break;
      case "journal_entries":   rows = await listJournalEntries(req, cid, undefined, undefined, branchIdRaw);   break;
      case "goods_receipts":    rows = await listGoodsReceipts(req, cid, undefined, undefined, branchIdRaw);    break;
      case "goods_deliveries":  rows = await listGoodsDeliveries(req, cid, undefined, undefined, branchIdRaw);  break;
      case "cash_transfers":    rows = await listCashTransfers(req, cid, undefined, undefined, branchIdRaw);    break;
      case "stock_transfers":   rows = await listStockTransfers(cid);   break;
      case "stock_adjustments": rows = await listStockAdjustments(cid); break;
      case "stock_counts":      rows = await listStockCounts(cid);      break;
      case "sister_transfers":   rows = await listSisterTransfers(req, cid, undefined, undefined, branchIdRaw);   break;
      case "sister_returns":     rows = await listSisterReturns(req, cid, undefined, undefined, branchIdRaw);     break;
      case "sister_settlements": rows = await listSisterSettlements(req, cid, undefined, undefined, branchIdRaw); break;
    }

    const unposted = rows.filter(r => !r.posted && r.status !== "cancelled");
    const posted = rows.filter(r => r.posted);
    const totalUnpostedAmount = unposted.reduce((s, r) => s + (r.amount || 0), 0);
    const totalPostedAmount = posted.reduce((s, r) => s + (r.amount || 0), 0);

    // Anomaly detectors — keep them conservative so we don't spam the user.
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldUnposted = unposted.filter(r => {
      const d = new Date(r.date);
      return !isNaN(d.getTime()) && d < thirtyDaysAgo;
    });
    const missingParty = unposted.filter(r => !r.party);
    const zeroAmount = unposted.filter(r => !r.amount || r.amount <= 0);
    const avgAmount = unposted.length
      ? totalUnpostedAmount / unposted.length
      : 0;
    const largeAmount = unposted.filter(r => avgAmount > 0 && r.amount > avgAmount * 5);

    const insights: { level: "info" | "warning" | "danger"; message: string }[] = [];
    if (unposted.length === 0) {
      insights.push({ level: "info", message: "لا توجد عمليات غير مرحّلة في هذا الموديول" });
    } else {
      insights.push({
        level: "info",
        message: `يوجد ${unposted.length} عملية غير مرحّلة بإجمالي ${totalUnpostedAmount.toFixed(2)} ر.س جاهزة للترحيل`,
      });
    }
    if (oldUnposted.length > 0) {
      insights.push({
        level: "warning",
        message: `${oldUnposted.length} عملية مضى عليها أكثر من 30 يومًا دون ترحيل — يُفضّل ترحيلها قبل إغلاق الفترة`,
      });
    }
    if (missingParty.length > 0) {
      insights.push({
        level: "warning",
        message: `${missingParty.length} عملية بدون جهة محددة — تحقق منها قبل الترحيل`,
      });
    }
    if (zeroAmount.length > 0) {
      insights.push({
        level: "danger",
        message: `${zeroAmount.length} عملية بقيمة صفرية — لن يتم إنشاء قيد محاسبي لها`,
      });
    }
    if (largeAmount.length > 0 && largeAmount.length <= 5) {
      insights.push({
        level: "warning",
        message: `${largeAmount.length} عملية ذات قيمة كبيرة بشكل غير معتاد — راجعها يدويًا`,
      });
    }

    res.json({
      module: mod,
      moduleLabel: MODULE_LABELS_AR[mod as ModuleKey],
      counts: {
        total: rows.length,
        unposted: unposted.length,
        posted: posted.length,
      },
      totals: {
        unposted: totalUnpostedAmount,
        posted: totalPostedAmount,
      },
      anomalies: {
        oldUnposted: oldUnposted.length,
        missingParty: missingParty.length,
        zeroAmount: zeroAmount.length,
        largeAmount: largeAmount.length,
      },
      insights,
    });
  } catch (err: any) {
    req.log?.error?.({ err }, "posting-center ai-summary failed");
    res.status(500).json({ error: err?.message || "خطأ في التحليل" });
  }
});

// ─── Per-module list helpers ────────────────────────────────────────────────
// Each returns rows mapped to the unified PostingRow shape. Customer/supplier
// lookups are batched in one extra query rather than N joins so the routine
// stays fast even with 100k+ rows.

async function listSalesInvoices(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  // Manual sales invoices ONLY — POS-originated invoices (posSessionId IS NOT NULL)
  // are surfaced under the dedicated "pos_sales" module so the accountant can
  // batch-post them separately. Without this filter, busy POS tenants drown
  // out manual sales invoices and the totals/anomaly detectors get confused.
  const conds = [
    eq(salesInvoicesTable.companyId, cid),
    sql`${salesInvoicesTable.posSessionId} IS NULL`,
    ...branchScopeSpread(req, salesInvoicesTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(salesInvoicesTable.invoiceDate, dateFrom));
  if (dateTo)   conds.push(lte(salesInvoicesTable.invoiceDate, dateTo));
  const docs = await db.select().from(salesInvoicesTable)
    .where(and(...conds))
    .orderBy(desc(salesInvoicesTable.invoiceDate));

  const cusMap = await loadCustomerMap(cid, docs.map(d => d.customerId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "sales_invoices",
    docNumber: d.docNumber,
    date: d.invoiceDate,
    type: MODULE_LABELS_AR.sales_invoices,
    description: d.notes,
    party: d.customerId ? (cusMap.get(d.customerId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// POS-originated sales invoices (posSessionId IS NOT NULL). Lives in the same
// salesInvoicesTable as manual sales invoices and shares the exact same
// /post endpoint server-side — we only split the *listing* so the accountant
// can post POS shifts in bulk without mixing them with manual invoices.
async function listPosSales(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(salesInvoicesTable.companyId, cid),
    sql`${salesInvoicesTable.posSessionId} IS NOT NULL`,
    ...branchScopeSpread(req, salesInvoicesTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(salesInvoicesTable.invoiceDate, dateFrom));
  if (dateTo)   conds.push(lte(salesInvoicesTable.invoiceDate, dateTo));
  const docs = await db.select().from(salesInvoicesTable)
    .where(and(...conds))
    .orderBy(desc(salesInvoicesTable.invoiceDate));

  const cusMap = await loadCustomerMap(cid, docs.map(d => d.customerId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "pos_sales",
    docNumber: d.docNumber,
    date: d.invoiceDate,
    type: MODULE_LABELS_AR.pos_sales,
    description: d.notes,
    party: d.customerId ? (cusMap.get(d.customerId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listSalesReturns(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(salesReturnsTable.companyId, cid),
    ...branchScopeSpread(req, salesReturnsTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(salesReturnsTable.returnDate, dateFrom));
  if (dateTo)   conds.push(lte(salesReturnsTable.returnDate, dateTo));
  const docs = await db.select().from(salesReturnsTable)
    .where(and(...conds))
    .orderBy(desc(salesReturnsTable.returnDate));

  const cusMap = await loadCustomerMap(cid, docs.map(d => d.customerId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "sales_returns",
    docNumber: d.docNumber,
    date: d.returnDate,
    type: MODULE_LABELS_AR.sales_returns,
    description: d.notes,
    party: d.customerId ? (cusMap.get(d.customerId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listPurchaseInvoices(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(purchaseInvoicesTable.companyId, cid),
    ...branchScopeSpread(req, purchaseInvoicesTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(purchaseInvoicesTable.invoiceDate, dateFrom));
  if (dateTo)   conds.push(lte(purchaseInvoicesTable.invoiceDate, dateTo));
  const docs = await db.select().from(purchaseInvoicesTable)
    .where(and(...conds))
    .orderBy(desc(purchaseInvoicesTable.invoiceDate));

  const supMap = await loadSupplierMap(cid, docs.map(d => d.supplierId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "purchase_invoices",
    docNumber: d.docNumber,
    date: d.invoiceDate,
    type: MODULE_LABELS_AR.purchase_invoices,
    description: d.notes,
    party: d.supplierId ? (supMap.get(d.supplierId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listPurchaseReturns(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(purchaseReturnsTable.companyId, cid),
    ...branchScopeSpread(req, (purchaseReturnsTable as any).branchId, branchIdRaw),
  ];
  // purchaseReturnsTable's date column is `returnDate` per schema convention
  if (dateFrom) conds.push(gte((purchaseReturnsTable as any).returnDate, dateFrom));
  if (dateTo)   conds.push(lte((purchaseReturnsTable as any).returnDate, dateTo));
  const docs = await db.select().from(purchaseReturnsTable)
    .where(and(...conds))
    .orderBy(desc((purchaseReturnsTable as any).returnDate));

  const supMap = await loadSupplierMap(cid, docs.map((d: any) => d.supplierId).filter((x: any): x is number => !!x));
  return docs.map((d: any) => ({
    id: d.id,
    module: "purchase_returns",
    docNumber: d.docNumber,
    date: d.returnDate,
    type: MODULE_LABELS_AR.purchase_returns,
    description: d.notes,
    party: d.supplierId ? (supMap.get(d.supplierId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId ?? null,
    journalEntryDocNumber: null,
  }));
}

async function listReceiptVouchers(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(receiptVouchersTable.companyId, cid),
    ...branchScopeSpread(req, receiptVouchersTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(receiptVouchersTable.date, dateFrom));
  if (dateTo)   conds.push(lte(receiptVouchersTable.date, dateTo));
  const docs = await db.select().from(receiptVouchersTable)
    .where(and(...conds))
    .orderBy(desc(receiptVouchersTable.date));

  // entityType is 'customer' for receipt vouchers — fetch names in bulk.
  const customerIds = docs
    .filter(d => d.entityType === "customer" && d.entityId)
    .map(d => d.entityId as number);
  const cusMap = await loadCustomerMap(cid, customerIds);

  return docs.map(d => ({
    id: d.id,
    module: "receipt_vouchers",
    docNumber: d.code,
    date: d.date,
    type: MODULE_LABELS_AR.receipt_vouchers,
    description: d.description,
    party: d.entityName
      || (d.entityType === "customer" && d.entityId ? cusMap.get(d.entityId) ?? null : null),
    amount: parseFloat(d.amount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listPaymentVouchers(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(paymentVouchersTable.companyId, cid),
    ...branchScopeSpread(req, paymentVouchersTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(paymentVouchersTable.date, dateFrom));
  if (dateTo)   conds.push(lte(paymentVouchersTable.date, dateTo));
  const docs = await db.select().from(paymentVouchersTable)
    .where(and(...conds))
    .orderBy(desc(paymentVouchersTable.date));

  // entityType is 'supplier' for payment vouchers — fetch names in bulk.
  const supplierIds = docs
    .filter(d => d.entityType === "supplier" && d.entityId)
    .map(d => d.entityId as number);
  const supMap = await loadSupplierMap(cid, supplierIds);

  return docs.map(d => ({
    id: d.id,
    module: "payment_vouchers",
    docNumber: d.code,
    date: d.date,
    type: MODULE_LABELS_AR.payment_vouchers,
    description: d.description,
    party: d.entityName
      || (d.entityType === "supplier" && d.entityId ? supMap.get(d.entityId) ?? null : null),
    amount: parseFloat(d.amount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Journal Entries ────────────────────────────────────────────────────────
// Manual JEs that the accountant created directly.
//
// Auto-generated JEs (entryType IN LOCKED_JE_TYPES) are EXCLUDED from this
// list because:
//   1) they're already posted by their source document, and
//   2) the JE post/unpost endpoint refuses to flip them — they must be
//      unposted via the source document (invoice/voucher/etc.).
// Surfacing them here would let the user select them and trigger a wave of
// 403 errors on bulk-unpost. Their source documents already appear in the
// posting center under their own modules.
//
// Amount = sum of debits (== sum of credits when balanced). We use a
// subquery aggregate so the outer SELECT stays scalar and groupBy-safe.
const LOCKED_JE_TYPES = [
  "purchase_invoice", "purchase_return",
  "sales_invoice", "sales_return",
  "receipt_voucher", "payment_voucher", "receipt", "payment",
  "stock_transfer", "stock_adjustment",
  "supplier_settlement", "customer_settlement",
  "payroll_run", "employee_loan", "eos_payment",
];

async function listJournalEntries(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(journalEntriesTable.companyId, cid),
    // Only manual JEs — null entryType is treated as "general" and kept.
    sql`(${journalEntriesTable.entryType} IS NULL OR ${journalEntriesTable.entryType} NOT IN ${LOCKED_JE_TYPES})`,
    ...branchScopeSpread(req, journalEntriesTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(journalEntriesTable.entryDate, dateFrom));
  if (dateTo)   conds.push(lte(journalEntriesTable.entryDate, dateTo));

  const docs = await db.select().from(journalEntriesTable)
    .where(and(...conds))
    .orderBy(desc(journalEntriesTable.entryDate));

  if (docs.length === 0) return [];

  // Per-entry debit totals in one query — keyed by entryId for O(1) lookup.
  const totals = await db
    .select({
      entryId:    journalEntryLinesTable.entryId,
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`.as("total_debit"),
    })
    .from(journalEntryLinesTable)
    .where(inArray(journalEntryLinesTable.entryId, docs.map(d => d.id)))
    .groupBy(journalEntryLinesTable.entryId);
  const totalMap = new Map(totals.map(t => [t.entryId, parseFloat(t.totalDebit || "0")] as const));

  // When docNumber is NULL (most common case — the form shows "تلقائي" in the
  // رقم المستند input), the JournalEntryForm synthesizes a display badge of
  // the form `QYD-{id-padded-to-4}`. We mirror that exact fallback here so
  // that copy-pasting the QYD-XXXX badge from the form into the posting
  // center search box returns the matching row instead of zero hits.
  const synthesizeDoc = (id: number, real: string | null) =>
    real ?? `QYD-${String(id).padStart(4, "0")}`;

  return docs.map(d => ({
    id: d.id,
    module: "journal_entries",
    docNumber: synthesizeDoc(d.id, d.docNumber),
    date: d.entryDate,
    type: MODULE_LABELS_AR.journal_entries,
    description: d.description,
    party: null,
    amount: totalMap.get(d.id) ?? 0,
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.id,            // self-reference: the JE is itself
    journalEntryDocNumber: synthesizeDoc(d.id, d.docNumber),
  }));
}

// ─── Goods Receipts ─────────────────────────────────────────────────────────
async function listGoodsReceipts(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(goodsReceiptsTable.companyId, cid),
    ...branchScopeSpread(req, (goodsReceiptsTable as any).branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(goodsReceiptsTable.receiptDate, dateFrom));
  if (dateTo)   conds.push(lte(goodsReceiptsTable.receiptDate, dateTo));
  const docs = await db.select().from(goodsReceiptsTable)
    .where(and(...conds))
    .orderBy(desc(goodsReceiptsTable.receiptDate));
  const supMap = await loadSupplierMap(cid, docs.map(d => d.supplierId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "goods_receipts",
    docNumber: d.docNumber,
    date: d.receiptDate,
    type: MODULE_LABELS_AR.goods_receipts,
    description: d.notes,
    party: d.supplierId ? (supMap.get(d.supplierId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted" || d.status === "invoiced",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Goods Deliveries ───────────────────────────────────────────────────────
async function listGoodsDeliveries(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(goodsDeliveriesTable.companyId, cid),
    ...branchScopeSpread(req, (goodsDeliveriesTable as any).branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(goodsDeliveriesTable.deliveryDate, dateFrom));
  if (dateTo)   conds.push(lte(goodsDeliveriesTable.deliveryDate, dateTo));
  const docs = await db.select().from(goodsDeliveriesTable)
    .where(and(...conds))
    .orderBy(desc(goodsDeliveriesTable.deliveryDate));
  const cusMap = await loadCustomerMap(cid, docs.map(d => d.customerId).filter((x): x is number => !!x));
  return docs.map(d => ({
    id: d.id,
    module: "goods_deliveries",
    docNumber: d.docNumber,
    date: d.deliveryDate,
    type: MODULE_LABELS_AR.goods_deliveries,
    description: d.notes,
    party: d.customerId ? (cusMap.get(d.customerId) ?? null) : null,
    amount: parseFloat(d.totalAmount || "0"),
    status: d.status,
    posted: d.status === "posted" || d.status === "invoiced",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Cash Transfers ─────────────────────────────────────────────────────────
// Note: cash_transfers has only POST /post (no unpost endpoint server-side).
// Frontend disables the unpost button for this module.
async function listCashTransfers(
  _req: Request, cid: number, dateFrom?: string, dateTo?: string, _branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  // cash_transfers header has no branch_id column — it's scoped by
  // from/to cash boxes & banks (which themselves carry branchId). Branch
  // filtering on this module is intentionally a no-op.
  const conds = [eq(cashTransfersTable.companyId, cid)];
  if (dateFrom) conds.push(gte(cashTransfersTable.date, dateFrom));
  if (dateTo)   conds.push(lte(cashTransfersTable.date, dateTo));
  const docs = await db.select().from(cashTransfersTable)
    .where(and(...conds))
    .orderBy(desc(cashTransfersTable.date));

  // Resolve cash-box and bank names for the from/to fields so the "party"
  // column shows a useful "From → To" string instead of bare IDs.
  const cashBoxIds = new Set<number>();
  const bankIds    = new Set<number>();
  for (const d of docs) {
    if (d.fromCashBoxId) cashBoxIds.add(d.fromCashBoxId);
    if (d.toCashBoxId)   cashBoxIds.add(d.toCashBoxId);
    if (d.fromBankId)    bankIds.add(d.fromBankId);
    if (d.toBankId)      bankIds.add(d.toBankId);
  }
  const cashBoxRows = cashBoxIds.size > 0
    ? await db.select({ id: cashBoxesTable.id, nameAr: cashBoxesTable.nameAr, nameEn: cashBoxesTable.nameEn })
        .from(cashBoxesTable)
        .where(and(eq(cashBoxesTable.companyId, cid), inArray(cashBoxesTable.id, Array.from(cashBoxIds))))
    : [];
  const bankRows = bankIds.size > 0
    ? await db.select({ id: bankAccountsTable.id, nameAr: bankAccountsTable.nameAr, nameEn: bankAccountsTable.nameEn })
        .from(bankAccountsTable)
        .where(and(eq(bankAccountsTable.companyId, cid), inArray(bankAccountsTable.id, Array.from(bankIds))))
    : [];
  const cashBoxMap = new Map(cashBoxRows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));
  const bankMap    = new Map(bankRows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));
  const fromName = (d: typeof docs[number]) =>
    (d.fromCashBoxId && cashBoxMap.get(d.fromCashBoxId)) ||
    (d.fromBankId    && bankMap.get(d.fromBankId)) || "—";
  const toName = (d: typeof docs[number]) =>
    (d.toCashBoxId && cashBoxMap.get(d.toCashBoxId)) ||
    (d.toBankId    && bankMap.get(d.toBankId))    || "—";

  return docs.map(d => ({
    id: d.id,
    module: "cash_transfers",
    docNumber: d.code,
    date: d.date,
    type: MODULE_LABELS_AR.cash_transfers,
    description: d.description ?? d.notes,
    party: `${fromName(d)} ← ${toName(d)}`,
    amount: parseFloat(d.amount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: null,
    journalEntryDocNumber: null,
  }));
}

// ─── Sister Companies (الشركات الشقيقة) ──────────────────────────────────────
// transfers / returns / settlements — gated under the single "sister_companies"
// module permission. The "party" column shows the sister-company name. Amounts
// use the supply value (= the AR side of the JE) for transfers/returns and the
// settlement amount for settlements.
async function loadSisterMap(cid: number, ids: number[]): Promise<Map<number, string>> {
  const uniq = Array.from(new Set(ids.filter((x): x is number => !!x)));
  if (uniq.length === 0) return new Map();
  const rows = await db.select({ id: sisterCompaniesTable.id, nameAr: sisterCompaniesTable.nameAr, nameEn: sisterCompaniesTable.nameEn })
    .from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.companyId, cid), inArray(sisterCompaniesTable.id, uniq)));
  return new Map(rows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));
}

async function listSisterTransfers(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(sisterTransfersTable.companyId, cid),
    ...branchScopeSpread(req, sisterTransfersTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(sisterTransfersTable.transferDate, dateFrom));
  if (dateTo)   conds.push(lte(sisterTransfersTable.transferDate, dateTo));
  const docs = await db.select().from(sisterTransfersTable)
    .where(and(...conds))
    .orderBy(desc(sisterTransfersTable.transferDate));
  const sisMap = await loadSisterMap(cid, docs.map(d => d.sisterCompanyId));
  return docs.map(d => ({
    id: d.id,
    module: "sister_transfers",
    docNumber: d.transferNumber,
    date: d.transferDate,
    type: MODULE_LABELS_AR.sister_transfers,
    description: d.notes,
    party: sisMap.get(d.sisterCompanyId) ?? null,
    amount: parseFloat(d.totalSupply || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listSisterReturns(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(sisterReturnsTable.companyId, cid),
    ...branchScopeSpread(req, sisterReturnsTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(sisterReturnsTable.returnDate, dateFrom));
  if (dateTo)   conds.push(lte(sisterReturnsTable.returnDate, dateTo));
  const docs = await db.select().from(sisterReturnsTable)
    .where(and(...conds))
    .orderBy(desc(sisterReturnsTable.returnDate));
  const sisMap = await loadSisterMap(cid, docs.map(d => d.sisterCompanyId));
  return docs.map(d => ({
    id: d.id,
    module: "sister_returns",
    docNumber: d.returnNumber,
    date: d.returnDate,
    type: MODULE_LABELS_AR.sister_returns,
    description: d.notes,
    party: sisMap.get(d.sisterCompanyId) ?? null,
    amount: parseFloat(d.totalSupply || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

async function listSisterSettlements(
  req: Request, cid: number, dateFrom?: string, dateTo?: string, branchIdRaw?: unknown,
): Promise<PostingRow[]> {
  const conds = [
    eq(sisterSettlementsTable.companyId, cid),
    ...branchScopeSpread(req, sisterSettlementsTable.branchId, branchIdRaw),
  ];
  if (dateFrom) conds.push(gte(sisterSettlementsTable.date, dateFrom));
  if (dateTo)   conds.push(lte(sisterSettlementsTable.date, dateTo));
  const docs = await db.select().from(sisterSettlementsTable)
    .where(and(...conds))
    .orderBy(desc(sisterSettlementsTable.date));
  const sisMap = await loadSisterMap(cid, docs.map(d => d.sisterCompanyId));
  return docs.map(d => ({
    id: d.id,
    module: "sister_settlements",
    docNumber: d.code,
    date: d.date,
    type: MODULE_LABELS_AR.sister_settlements,
    description: d.description ?? (d.direction === "receive" ? "تحصيل" : "سداد"),
    party: sisMap.get(d.sisterCompanyId) ?? null,
    amount: parseFloat(d.amount || "0"),
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Stock Transfers ────────────────────────────────────────────────────────
// Note: stock_transfers / stock_adjustments / stock_counts have post-only
// endpoints in inventory.ts. Frontend hides the unpost button for these.
async function listStockTransfers(
  cid: number, dateFrom?: string, dateTo?: string,
): Promise<PostingRow[]> {
  const conds = [eq(stockTransfersTable.companyId, cid)];
  if (dateFrom) conds.push(gte(stockTransfersTable.transferDate, dateFrom));
  if (dateTo)   conds.push(lte(stockTransfersTable.transferDate, dateTo));
  const docs = await db.select().from(stockTransfersTable)
    .where(and(...conds))
    .orderBy(desc(stockTransfersTable.transferDate));

  const whIds = new Set<number>();
  for (const d of docs) {
    if (d.fromWarehouseId) whIds.add(d.fromWarehouseId);
    if (d.toWarehouseId)   whIds.add(d.toWarehouseId);
  }
  const whRows = whIds.size > 0
    ? await db.select({ id: warehousesTable.id, nameAr: warehousesTable.nameAr, nameEn: warehousesTable.nameEn })
        .from(warehousesTable)
        .where(and(eq(warehousesTable.companyId, cid), inArray(warehousesTable.id, Array.from(whIds))))
    : [];
  const whMap = new Map(whRows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));

  return docs.map(d => ({
    id: d.id,
    module: "stock_transfers",
    docNumber: d.transferNumber,
    date: d.transferDate,
    type: MODULE_LABELS_AR.stock_transfers,
    description: d.notes,
    party: `${whMap.get(d.fromWarehouseId) ?? "—"} ← ${whMap.get(d.toWarehouseId) ?? "—"}`,
    amount: 0,                       // header has no total — derived from items
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Stock Adjustments ──────────────────────────────────────────────────────
async function listStockAdjustments(
  cid: number, dateFrom?: string, dateTo?: string,
): Promise<PostingRow[]> {
  const conds = [eq(stockAdjustmentsTable.companyId, cid)];
  if (dateFrom) conds.push(gte(stockAdjustmentsTable.adjustmentDate, dateFrom));
  if (dateTo)   conds.push(lte(stockAdjustmentsTable.adjustmentDate, dateTo));
  const docs = await db.select().from(stockAdjustmentsTable)
    .where(and(...conds))
    .orderBy(desc(stockAdjustmentsTable.adjustmentDate));

  const whIds = Array.from(new Set(docs.map(d => d.warehouseId).filter((x): x is number => !!x)));
  const whRows = whIds.length > 0
    ? await db.select({ id: warehousesTable.id, nameAr: warehousesTable.nameAr, nameEn: warehousesTable.nameEn })
        .from(warehousesTable)
        .where(and(eq(warehousesTable.companyId, cid), inArray(warehousesTable.id, whIds)))
    : [];
  const whMap = new Map(whRows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));

  return docs.map(d => ({
    id: d.id,
    module: "stock_adjustments",
    docNumber: d.adjustmentNumber,
    date: d.adjustmentDate,
    type: MODULE_LABELS_AR.stock_adjustments,
    description: d.reason || d.notes,
    party: whMap.get(d.warehouseId) ?? null,
    amount: 0,
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: d.journalEntryId,
    journalEntryDocNumber: null,
  }));
}

// ─── Stock Counts ───────────────────────────────────────────────────────────
async function listStockCounts(
  cid: number, dateFrom?: string, dateTo?: string,
): Promise<PostingRow[]> {
  const conds = [eq(stockCountsTable.companyId, cid)];
  if (dateFrom) conds.push(gte(stockCountsTable.countDate, dateFrom));
  if (dateTo)   conds.push(lte(stockCountsTable.countDate, dateTo));
  const docs = await db.select().from(stockCountsTable)
    .where(and(...conds))
    .orderBy(desc(stockCountsTable.countDate));

  const whIds = Array.from(new Set(docs.map(d => d.warehouseId).filter((x): x is number => !!x)));
  const whRows = whIds.length > 0
    ? await db.select({ id: warehousesTable.id, nameAr: warehousesTable.nameAr, nameEn: warehousesTable.nameEn })
        .from(warehousesTable)
        .where(and(eq(warehousesTable.companyId, cid), inArray(warehousesTable.id, whIds)))
    : [];
  const whMap = new Map(whRows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));

  return docs.map(d => ({
    id: d.id,
    module: "stock_counts",
    docNumber: d.countNumber,
    date: d.countDate,
    type: MODULE_LABELS_AR.stock_counts,
    description: d.notes,
    party: whMap.get(d.warehouseId) ?? null,
    amount: 0,
    status: d.status,
    posted: d.status === "posted",
    journalEntryId: null,
    journalEntryDocNumber: null,
  }));
}

// ─── Lookup helpers (batched) ───────────────────────────────────────────────
async function loadCustomerMap(cid: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const unique = Array.from(new Set(ids));
  const rows = await db.select({
    id: customersTable.id,
    nameAr: customersTable.nameAr,
    nameEn: customersTable.nameEn,
  })
    .from(customersTable)
    .where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, unique)));
  return new Map(rows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));
}

async function loadSupplierMap(cid: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const unique = Array.from(new Set(ids));
  const rows = await db.select({
    id: suppliersTable.id,
    nameAr: suppliersTable.nameAr,
    nameEn: suppliersTable.nameEn,
  })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, cid), inArray(suppliersTable.id, unique)));
  return new Map(rows.map(r => [r.id, r.nameAr || r.nameEn || `#${r.id}`] as const));
}

export default router;
