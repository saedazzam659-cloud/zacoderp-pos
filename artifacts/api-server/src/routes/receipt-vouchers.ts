import { Router } from "express";
import { db } from "@workspace/db";
import {
  receiptVouchersTable, receiptVoucherLinesTable,
  cashBoxesTable, bankAccountsTable,
  customersTable,
  salesInvoicesTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable,
} from "@workspace/db";
import { eq, and, or, desc, inArray, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId, multiBranchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requireAdminRole } from "../middleware/permissions.js";
import { nextSequenceNumber, nextSequenceForPayment } from "../lib/sequences.js";
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
  if (Number.isInteger(rawSiId) && rawSiId > 0) {
    const lineVoucherIds = await db
      .selectDistinct({ voucherId: receiptVoucherLinesTable.voucherId })
      .from(receiptVoucherLinesTable)
      .where(eq(receiptVoucherLinesTable.salesInvoiceId, rawSiId));
    const vIds = lineVoucherIds.map((r) => r.voucherId).filter((n): n is number => n != null);
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
  // When `lines` is present, header amount is derived from them; a legacy
  // caller (no `lines`) keeps sending its own `amount`.
  const headerAmount = lines ? receiptLinesTotal(lines).toFixed(2) : d.amount;

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
  // Replace lines only when the caller sent a `lines` array (undefined =
  // legacy update that shouldn't wipe existing allocations).
  if (lines) await replaceReceiptLines(row.id, lines);
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
