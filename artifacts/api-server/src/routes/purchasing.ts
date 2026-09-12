import { Router } from "express";
import { nextEntityCode } from "../lib/nextEntityCode.js";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { checkItemsUsable, usageViolationMessage } from "../lib/itemUsageControl.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import {
  supplierGroupsTable, lettersOfCreditTable, lcExpensesTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseOrdersTable, purchaseOrderLinesTable,
  purchaseReturnsTable, purchaseReturnLinesTable,
  supplierSettlementsTable, suppliersTable,
  productionCommercialAccrualsTable,
  cashBoxesTable, bankAccountsTable, journalEntriesTable, journalEntryLinesTable,
  stockBalanceTable, stockLedgerTable, warehousesTable, branchesTable,
  receiptVouchersTable, paymentVouchersTable,
  currenciesTable,
  itemsTable,
  itemGroupsTable,
  fixedAssetsTable,
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
  costCentersTable,
  accountsTable,
  unitsTable,
  taxesTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql, inArray, notInArray, isNull, or } from "drizzle-orm";
import {
  extractAuth, resolveCompanyId, branchScopeFilter, branchScopeSpread,
  multiBranchScopeSpread, effectiveBranchCondition,
} from "../middleware/auth.js";
import { resolveTaxRate } from "../lib/companyTaxes.js";
import { pathRbac, requireAdminRole, requirePermission } from "../middleware/permissions.js";
import { upsertBalance, getBalance, addStockLedgerEntry, refreshItemCost } from "../lib/stockHelpers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { nextSequenceNumber, nextSequenceForPayment, resolveJeNumber, reserveJeNumberFromEntry } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { goodsReceiptsTable } from "@workspace/db";
import { getReceivingClearingAccountId } from "./goodsReceipts.js";
import { assertInvoiceEditKeepsSettlementsCovered } from "../lib/invoiceSettlement.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizePeriodicity, parseCcSplit, installmentsBetween, runDueAdjustmentsForCompany } from "../lib/adjustmentPosting.js";
import { logger } from "../lib/logger.js";
import { isPrimaryKeyCollision, postgresErrorField, safeWriteErrorMessage } from "../lib/postRestoreWriteGuard.js";
import { itemNamesWithSupplierDescription, purchaseSupplierDescription } from "../lib/journalLineDescriptions.js";
import {
  assertIndustrialCostPeriodsWritable,
  assertIndustrialCostTagsOwned,
  assertIndustrialReturnSourceLinks,
  calculateIndustrialPostedBaseAmount,
  industrialCostWithSourceFacts,
  readIndustrialCostSourceFacts,
  normalizeIndustrialCostTag,
} from "../lib/industrialPurchaseCosts.js";
import {
  resolveItemUnitConversion,
  multiplyQuantity,
  divideQuantity,
  roundQuantity,
} from "../lib/unitConversion.js";

function purchasingWriteError(error: any, documentName: string): { status: number; message: string } {
  const code = String(postgresErrorField(error, "code") ?? "");
  const constraint = String(
    postgresErrorField(error, "constraint_name")
      ?? postgresErrorField(error, "constraint")
      ?? "",
  );
  if (code === "23503") {
    return {
      status: 409,
      message: `تعذر حفظ ${documentName} لأن أحد الارتباطات القديمة غير موجود بعد الاستعادة${constraint ? ` (${constraint})` : ""}. حدّث الصفحة وأعد اختيار البيانات ثم حاول مجدداً.`,
    };
  }
  if (code === "23505") {
    return {
      status: 409,
      message: constraint.includes("pkey")
        ? `تعذر حفظ ${documentName} بسبب تعارض رقم داخلي بعد الاستعادة. تمت محاولة إصلاح العداد؛ أعد المحاولة.`
        : `رقم ${documentName} مستخدم مسبقاً بعد الاستعادة. راجع إعدادات التسلسل.`,
    };
  }
  if (code) {
    return {
      status: Number(error?.status) || 500,
      message: `تعذر حفظ ${documentName} بسبب خطأ في قاعدة البيانات`,
    };
  }
  return {
    status: Number(error?.status) || 500,
    message: safeWriteErrorMessage(error, `تعذر حفظ ${documentName} بسبب خطأ في قاعدة البيانات`),
  };
}

async function insertPurchaseInvoiceWithSerialRepair(values: any, executor: any = db) {
  try {
    // Use a savepoint when called by a document transaction. PostgreSQL marks
    // a transaction aborted after a duplicate-key error; catching it outside a
    // savepoint would make the subsequent repair unusable.
    return await executor.transaction(async (insertTx: any) => {
      const [invoice] = await insertTx.insert(purchaseInvoicesTable).values(values).returning();
      return invoice;
    });
  } catch (error: any) {
    if (!isPrimaryKeyCollision(error)) throw error;
    // A restored serial can be behind the rows restored with explicit IDs.
    // Serialize repairers so a second concurrent writer cannot calculate the
    // same MAX(id), reset the serial, and collide again after the first retry.
    return executor.transaction(async (tx: any) => {
      await tx.execute(sql`LOCK TABLE purchase_invoices IN EXCLUSIVE MODE`);
      await tx.execute(sql.raw(`
        DO $repair$
        DECLARE
          seq_name regclass := pg_get_serial_sequence('purchase_invoices', 'id');
          next_id bigint;
        BEGIN
          EXECUTE format('ALTER SEQUENCE %s OWNED BY purchase_invoices.id', seq_name);
          SELECT GREATEST(COALESCE(MAX(id), 0) + 1, 1) INTO next_id FROM purchase_invoices;
          EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq_name, next_id);
        END
        $repair$
      `));
      const [invoice] = await tx.insert(purchaseInvoicesTable).values(values).returning();
      return invoice;
    });
  }
}

async function insertPurchaseReturnWithSerialRepair(values: any, executor: any = db) {
  try {
    return await executor.transaction(async (insertTx: any) => {
      const [purchaseReturn] = await insertTx.insert(purchaseReturnsTable).values(values).returning();
      return purchaseReturn;
    });
  } catch (error: any) {
    if (!isPrimaryKeyCollision(error)) throw error;
    return executor.transaction(async (tx: any) => {
      await tx.execute(sql`LOCK TABLE purchase_returns IN EXCLUSIVE MODE`);
      await tx.execute(sql.raw(`
        DO $repair$
        DECLARE
          seq_name regclass := pg_get_serial_sequence('purchase_returns', 'id');
          next_id bigint;
        BEGIN
          EXECUTE format('ALTER SEQUENCE %s OWNED BY purchase_returns.id', seq_name);
          SELECT GREATEST(COALESCE(MAX(id), 0) + 1, 1) INTO next_id FROM purchase_returns;
          EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq_name, next_id);
        END
        $repair$
      `));
      const [purchaseReturn] = await tx.insert(purchaseReturnsTable).values(values).returning();
      return purchaseReturn;
    });
  }
}

type PurchaseWriteReferences = {
  supplierId?: unknown;
  branchId?: unknown;
  cashBoxId?: unknown;
  bankAccountId?: unknown;
  lcId?: unknown;
  taxId?: unknown;
  invoiceId?: unknown;
  headerCostCenter?: unknown;
  lines?: any[];
};

async function resolvePurchaseLineUnits(
  companyId: number,
  mappedLines: any[],
  inputLines: any[] | undefined,
  existingRows: any[] = [],
  sourceRows: any[] = [],
  executor: any = db,
): Promise<any[]> {
  const oldById = new Map<number, any>();
  const oldByItem = new Map<string, any[]>();
  for (const row of existingRows) {
    if (row?.id != null) oldById.set(Number(row.id), row);
    const key = String(row?.itemId ?? "");
    oldByItem.set(key, [...(oldByItem.get(key) ?? []), row]);
  }
  const sourceByItem = new Map<string, any[]>();
  for (const row of sourceRows) {
    const key = String(row?.itemId ?? "");
    sourceByItem.set(key, [...(sourceByItem.get(key) ?? []), row]);
  }
  return Promise.all(mappedLines.map(async (mapped, index) => {
    const input = inputLines?.[index] ?? {};
    const itemId = mapped.itemId == null ? null : Number(mapped.itemId);
    if (!itemId) {
      mapped.unitId = null;
      mapped.conversionFactor = "1";
      return mapped;
    }
    const key = String(itemId);
    let old: any;
    if (existingRows.length && input?.id != null) {
      old = oldById.get(Number(input.id));
      if (!old || String(old.itemId ?? "") !== key) {
        throw Object.assign(new Error("معرّف سطر فاتورة الشراء غير مطابق للصنف؛ حدّث الصفحة وأعد المحاولة"), {
          status: 400, code: "UNIT_LINE_ID_REQUIRED",
        });
      }
    } else if (existingRows.length) {
      const candidates = oldByItem.get(key) ?? [];
      if (candidates.length > 1) {
        throw Object.assign(new Error("يجب إرسال معرّف سطر فاتورة الشراء عند تكرار الصنف؛ حدّث الصفحة وأعد المحاولة"), {
          status: 400, code: "UNIT_LINE_ID_REQUIRED",
        });
      }
      old = candidates[0];
    }
    let source: any;
    if (sourceRows.length && input?.sourceLineId != null) {
      source = sourceRows.find((row) => Number(row?.id) === Number(input.sourceLineId));
      if (!source || String(source.itemId ?? "") !== key) {
        throw Object.assign(new Error("معرّف سطر فاتورة الشراء المصدر غير مطابق للصنف؛ حدّث الصفحة وأعد المحاولة"), {
          status: 400, code: "UNIT_SOURCE_LINE_ID_REQUIRED",
        });
      }
    } else {
      const candidates = sourceByItem.get(key) ?? [];
      if (candidates.length > 1) {
        throw Object.assign(new Error("يجب إرسال معرّف سطر فاتورة الشراء المصدر عند تكرار الصنف؛ حدّث الصفحة وأعد المحاولة"), {
          status: 400, code: "UNIT_SOURCE_LINE_ID_REQUIRED",
        });
      }
      source = candidates[0];
    }
    const sourceUnitUnchanged = !!source
      && input.unitCode == null
      && (input.unitId == null || Number(input.unitId) === Number(source.unitId));
    const snapshot = sourceUnitUnchanged ? source : (
      old && (!Object.prototype.hasOwnProperty.call(input, "unitId")
        || Number(input.unitId) === Number(old.unitId))
        ? old
        : null
    );
    const requestedUnitId = source && input.unitId == null && input.unitCode == null
      ? source.unitId
      : Object.prototype.hasOwnProperty.call(input, "unitId")
        ? (input.unitId == null ? undefined : Number(input.unitId))
        : old?.unitId == null ? undefined : Number(old.unitId);
    const resolved = await resolveItemUnitConversion({
      companyId,
      itemId,
      unitId: requestedUnitId,
      unitCode: source && input.unitId == null && input.unitCode == null
        ? undefined
        : (input.unitCode == null ? undefined : String(input.unitCode)),
      historicalFactor: snapshot?.conversionFactor == null
        ? undefined
        : String(snapshot.conversionFactor),
      executor,
    });
    mapped.unitId = resolved.unitId;
    mapped.conversionFactor = roundQuantity(String(resolved.factor), 18, "half_up");
    return mapped;
  }));
}

/**
 * Validate every business reference persisted by purchase create/conversion.
 * Header GL overrides are intentionally excluded: restored foreign-company
 * overrides are normalized to null by the caller so normal posting mappings
 * can heal them, matching the sales-create policy.
 */
async function assertPurchaseWriteReferences(
  cid: number,
  refs: PurchaseWriteReferences,
  executor: any = db,
): Promise<void> {
  const lines = Array.isArray(refs.lines) ? refs.lines : [];
  const integerIds = (label: string, values: unknown[]): number[] => {
    const ids: number[] = [];
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error(`مرجع ${label} غير صالح`), { status: 400 });
      }
      ids.push(id);
    }
    return [...new Set(ids)];
  };
  const specifications = [
    { label: "المورد", table: suppliersTable, id: suppliersTable.id, companyId: suppliersTable.companyId, values: [refs.supplierId] },
    { label: "الفرع", table: branchesTable, id: branchesTable.id, companyId: branchesTable.companyId, values: [refs.branchId] },
    { label: "الخزنة", table: cashBoxesTable, id: cashBoxesTable.id, companyId: cashBoxesTable.companyId, values: [refs.cashBoxId] },
    { label: "الحساب البنكي", table: bankAccountsTable, id: bankAccountsTable.id, companyId: bankAccountsTable.companyId, values: [refs.bankAccountId] },
    { label: "الاعتماد المستندي", table: lettersOfCreditTable, id: lettersOfCreditTable.id, companyId: lettersOfCreditTable.companyId, values: [refs.lcId] },
    { label: "الضريبة", table: taxesTable, id: taxesTable.id, companyId: taxesTable.companyId, values: [refs.taxId] },
    { label: "فاتورة الشراء المرتبطة", table: purchaseInvoicesTable, id: purchaseInvoicesTable.id, companyId: purchaseInvoicesTable.companyId, values: [refs.invoiceId] },
    { label: "الصنف", table: itemsTable, id: itemsTable.id, companyId: itemsTable.companyId, values: lines.map(line => line?.itemId) },
    { label: "الوحدة", table: unitsTable, id: unitsTable.id, companyId: unitsTable.companyId, values: lines.map(line => line?.unitId) },
    { label: "المستودع", table: warehousesTable, id: warehousesTable.id, companyId: warehousesTable.companyId, values: lines.map(line => line?.warehouseId) },
    { label: "الحساب المحاسبي في السطر", table: accountsTable, id: accountsTable.id, companyId: accountsTable.companyId, values: lines.map(line => line?.accountId) },
  ];
  for (const specification of specifications) {
    const ids = integerIds(specification.label, specification.values);
    if (!ids.length) continue;
    const owned = await executor.select({ id: specification.id })
      .from(specification.table)
      .where(and(
        eq(specification.companyId, cid),
        inArray(specification.id, ids),
      ));
    const ownedIds = new Set(owned.map((row: { id: number }) => Number(row.id)));
    const invalid = ids.filter(id => !ownedIds.has(id));
    if (invalid.length) {
      throw Object.assign(
        new Error(`مرجع ${specification.label} لا يخص الشركة الحالية أو غير موجود (${invalid.join(", ")})`),
        { status: 400 },
      );
    }
  }

  const costCenterCodes = [
    refs.headerCostCenter,
    ...lines.map(line => line?.costCenter),
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const uniqueCodes = [...new Set(costCenterCodes)];
  if (uniqueCodes.length) {
    const owned = await executor.select({ code: costCentersTable.code })
      .from(costCentersTable)
      .where(and(
        eq(costCentersTable.companyId, cid),
        inArray(costCentersTable.code, uniqueCodes),
      ));
    const ownedCodes = new Set(owned.map((row: { code: string }) => row.code));
    const invalid = uniqueCodes.filter(code => !ownedCodes.has(code));
    if (invalid.length) {
      throw Object.assign(
        new Error(`مركز التكلفة لا يخص الشركة الحالية أو غير موجود (${invalid.join(", ")})`),
        { status: 400 },
      );
    }
  }
  // Industrial actual costs are optional, but when a source line is tagged its
  // plant and cost-center must be active masters of this same tenant.
  await assertIndustrialCostTagsOwned(executor, cid, lines);
}

// ─── Journal entry helper ────────────────────────────────────────────────────
type JLine = { accountId: number | null; debit?: number; credit?: number; description?: string | null; costCenter?: string | null };

async function createJournalEntry(opts: {
  companyId: number;
  branchId?: number | null;
  date: string;
  description: string;
  docNumber?: string | null;
  entryType?: string;
  exchangeRate?: string | null;
  // Header-level cost-center code applied to every line that doesn't
  // explicitly set its own. Lets a single field on the source document
  // (purchase invoice, purchase return, …) tag the entire JE.
  costCenter?: string | null;
  // Audit-trail fields injected by callers via `fullAuditFor(req)`.
  audit?: Record<string, unknown>;
  // Stable source-document identity used to RESERVE+REUSE the JE number across
  // an unpost→edit→repost cycle (e.g. "purchase_invoice" + invoice id). When
  // omitted, the JE simply draws the next number with no reuse.
  sourceType?: string;
  sourceId?: number;
  // A linked commercial settlement posts inside the settlement transaction and
  // must explicitly create a posted clearing JE. Existing callers omit these.
  status?: string;
  dx?: any;
  lines: JLine[];
}): Promise<number> {
  const executor = opts.dx ?? db;
  // Filter out lines with zero amount or no account
  const cleanLines = opts.lines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
  if (cleanLines.length < 2) throw new Error("القيد المحاسبي يحتاج إلى طرفين على الأقل");

  const totalDebit  = cleanLines.reduce((s, l) => s + (l.debit  ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
  }

  // Period guard: never let a source document (PO, GRN settlement, return, …)
  // post a journal entry into a soft/hard-closed fiscal period.
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
  const jeStatus = opts.status ?? await resolvePostingStatus(opts.companyId, "purchase");
  const auditFields = opts.audit?.req
    ? fullAuditFor(opts.audit.req as any, jeStatus)
    : (opts.audit ?? {});
  // The journal entry draws its OWN continuous number from the "journal_entry"
  // sequence — independent of the source document's number. The source number
  // stays in the description + the source.jeId link, so traceability and
  // unposting are unaffected. Falls back to the source docNumber when no active
  // "journal_entry" sequence is configured (back-compat).
  // Reuse the SAME journal-entry number when this source document is being
  // RE-POSTED after an unpost→edit cycle (a reservation was stashed at unpost
  // time). Otherwise draw the next continuous "journal_entry" number. Reuse
  // NEVER consumes the counter, so unpost→repost leaves no sequence gap.
  const seqDocNumber = await resolveJeNumber({
    companyId:  opts.companyId,
    sourceType: opts.sourceType,
    sourceId:   opts.sourceId,
    branchId:   opts.branchId ?? null,
    docDate:    opts.date,
    userId:     (opts.audit?.req as any)?.authUser?.id ?? null,
  });
  const jeDocNumber = seqDocNumber ?? (opts.docNumber ?? null);
  const [entry] = await executor.insert(journalEntriesTable).values({
    companyId:    opts.companyId,
    branchId:     opts.branchId ?? null,
    docNumber:    jeDocNumber,
    entryDate:    opts.date,
    currency:     "SAR",
    exchangeRate: opts.exchangeRate ?? "1",
    description:  opts.description,
    entryType:    opts.entryType ?? "general",
    status:       jeStatus,
    periodId:     writability.period?.id ?? null,
    ...auditFields,
  }).returning();

  await executor.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId:     entry.id,
      accountId:   l.accountId!,
      debit:       String((l.debit  ?? 0).toFixed(2)),
      credit:      String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description,
      sortOrder:   i,
      // Persist cost-center code (text) so cost-center reports pick it up.
      // Per-line override wins; header-level value applies otherwise.
      // An EXPLICIT `costCenter: null` on a line (e.g. VAT lines) opts OUT of
      // the header fallback — only `undefined` falls back.
      costCenter:  l.costCenter !== undefined ? (l.costCenter || null) : (opts.costCenter ?? null),
    }))
  );
  return entry.id;
}

async function validateLinkedSettlementAccount(
  executor: any,
  companyId: number,
  accountId: unknown,
  label: string,
): Promise<number> {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0)
    throw Object.assign(new Error(`${label} مطلوب`), { status: 400 });
  const [account] = await executor.select({
    id: accountsTable.id,
    accountType: accountsTable.accountType,
    isPosting: accountsTable.isPosting,
    isActive: accountsTable.isActive,
  }).from(accountsTable).where(and(
    eq(accountsTable.id, id),
    eq(accountsTable.companyId, companyId),
  )).limit(1);
  if (!account || !account.isActive || !account.isPosting || account.accountType !== "liability")
    throw Object.assign(
      new Error(`${label} يجب أن يكون حساب التزام مرحّل ونشط في نفس الشركة`),
      { status: 400 },
    );
  return id;
}

// Resolve cash-box account
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
async function getSupplierAccountId(cid: number, supplierId: number | null | undefined): Promise<number | null> {
  if (!supplierId) return null;
  const [s] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, supplierId), eq(suppliersTable.companyId, cid)));
  return s?.accountId ?? null;
}

/** Map a list of warehouse IDs to their {accountId, allowNegative, name}. */
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

// ── مصروف يوزع على فترات (deferred expense) — per-line recognition plan ──
// ADDITIVE: lines of a deferred_expense category may carry a recognition
// window + periodicity + optional multi-cost-center split. Stored verbatim on
// the line; the linked accounting_adjustment is created at POST time.
const DEF_ISO = /^\d{4}-\d{2}-\d{2}$/;
function deferredLineFields(l: any) {
  const start = typeof l?.deferredStartDate === "string" && DEF_ISO.test(l.deferredStartDate) ? l.deferredStartDate : null;
  const end   = typeof l?.deferredEndDate   === "string" && DEF_ISO.test(l.deferredEndDate)   ? l.deferredEndDate   : null;
  if (!start || !end || end < start) {
    return { deferredStartDate: null, deferredEndDate: null, deferredPeriodicity: null, deferredCostCenters: null };
  }
  let ccs: any = null;
  if (Array.isArray(l?.deferredCostCenters) && l.deferredCostCenters.length) {
    const parsed = parseCcSplit(l.deferredCostCenters);
    ccs = parsed ?? null;
  }
  return {
    deferredStartDate:   start,
    deferredEndDate:     end,
    deferredPeriodicity: normalizePeriodicity(l?.deferredPeriodicity),
    deferredCostCenters: ccs,
  };
}

const router = Router();
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        providers: ["gemini"],
    });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  
router.use(extractAuth);
router.use(pathRbac([
  ["/purchase-invoices",      "purchase_invoices"],
  ["/purchase-orders",        "purchase_invoices"],
  ["/purchase-returns",       "purchase_returns"],
  ["/supplier-settlements",   "supplier_settlements"],
  ["/letters-of-credit",      "purchase_invoices"],
  ["/supplier-groups",        "suppliers"],
]));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

async function settlementSupplierInScope(req: any, cid: number, supplierId: number | null): Promise<boolean> {
  if (supplierId == null) return true;
  const [supplier] = await db.select({ branchId: suppliersTable.branchId }).from(suppliersTable).where(and(
    eq(suppliersTable.id, supplierId),
    eq(suppliersTable.companyId, cid),
  )).limit(1);
  if (!supplier) return false;
  return !("deny" in effectiveBranchCondition(req, suppliersTable.branchId, supplier.branchId));
}

// Cleanup any orphan stock movements / vouchers / journal entries tied to a draft document
// (defensive: a draft normally has none, but past bugs may have left orphans behind).
async function cleanupDocArtifacts(opts: {
  companyId: number;
  refType: string;
  refId: number;
  journalEntryId?: number | null;
}) {
  const { companyId: cid, refType, refId, journalEntryId } = opts;

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

  if (journalEntryId) {
    await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, journalEntryId));
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
}

// ═══════════════════════════════════════════════
// SUPPLIER GROUPS
// ═══════════════════════════════════════════════
router.get("/supplier-groups", async (req, res) => {
  try {
    const cid = getCid(req);
    const rows = cid
      ? await db.select().from(supplierGroupsTable)
          .where(eq(supplierGroupsTable.companyId, cid))
          .orderBy(asc(supplierGroupsTable.code))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/supplier-groups", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code: rawCode, nameAr, nameEn, discountPercent, notes, isActive } = req.body;
    if (!nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const existingGroups = await db.select({ code: supplierGroupsTable.code }).from(supplierGroupsTable).where(eq(supplierGroupsTable.companyId, cid));
    const code = String(rawCode ?? "").trim() || nextEntityCode("SG", existingGroups.map(g => g.code));
    if (existingGroups.some(g => g.code?.trim().toLowerCase() === code.toLowerCase())) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمجموعة أخرى` }); return;
    }
    const [row] = await db.insert(supplierGroupsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      discountPercent: discountPercent || "0", notes: notes || null,
      isActive: isActive ?? true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/supplier-groups/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { code, nameAr, nameEn, discountPercent, notes, isActive } = req.body;
    const [row] = await db.update(supplierGroupsTable).set({
      code, nameAr, nameEn: nameEn || null,
      discountPercent: discountPercent || "0", notes: notes || null, isActive,
    }).where(and(eq(supplierGroupsTable.id, id), eq(supplierGroupsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المجموعة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/supplier-groups/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(supplierGroupsTable).where(and(eq(supplierGroupsTable.id, id), eq(supplierGroupsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// LETTERS OF CREDIT
// ═══════════════════════════════════════════════
// ─── LC base-currency conversion helper (IAS 21 historical-rate) ───────
// The company's "functional currency" (base) is whichever currency row
// has isDefault=true. All LC totals/expenses are converted into this
// currency for comparison and posting. The historical rate is the one
// stored on the LC/expense at create time — it does NOT re-translate
// when the spot rate changes later.
async function getBaseCurrencyCode(cid: number, executor: any = db): Promise<string> {
  const rows = await executor.select().from(currenciesTable)
    .where(eq(currenciesTable.companyId, cid));
  return rows.find((c: any) => c.isDefault)?.code ?? rows[0]?.code ?? "SAR";
}
function enrichLcRow(lc: any, expenses: any[], baseCurrency: string) {
  const lcRate    = Number(lc.exchangeRate ?? "1") || 1;
  const totalAmt  = Number(lc.totalAmount  ?? "0") || 0;
  const totalBase = totalAmt * lcRate;

  const expEnriched = expenses.map((e) => {
    const r = Number(e.exchangeRate ?? "1") || 1;
    const a = Number(e.amount       ?? "0") || 0;
    return { ...e, amountBase: (a * r).toFixed(2) };
  });
  const totalExpensesBase = expEnriched.reduce((s, e) => s + Number(e.amountBase), 0);
  // "Remaining" = unused LC capacity = LC face value (in base) minus the
  // goods portion already drawn down by POSTED purchase invoices
  // (`usedAmount`, maintained by recomputeLcUsage).
  // It is NOT `totalBase - expenses` — expenses are loaded on top of goods,
  // not deducted from the LC commitment to the supplier.
  const usedBase          = Number(lc.usedAmount ?? "0") || 0;
  const remainingBase     = Math.max(0, totalBase - usedBase);
  return {
    ...lc,
    totalAmountBase:    totalBase.toFixed(2),
    expenses:           expEnriched,
    totalExpensesBase:  totalExpensesBase.toFixed(2),
    remainingBase:      remainingBase.toFixed(2),
    baseCurrency,
  };
}

router.get("/letters-of-credit", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const baseCurrency = await getBaseCurrencyCode(cid);
    const lcs = await db.select().from(lettersOfCreditTable)
      .where(eq(lettersOfCreditTable.companyId, cid))
      .orderBy(desc(lettersOfCreditTable.lcDate));
    if (lcs.length === 0) { res.json([]); return; }
    const expensesAll = await db.select().from(lcExpensesTable)
      .where(eq(lcExpensesTable.companyId, cid));
    const byLc = new Map<number, any[]>();
    for (const e of expensesAll) {
      const arr = byLc.get(e.lcId) ?? [];
      arr.push(e); byLc.set(e.lcId, arr);
    }
    // Linked purchase invoices per LC (1:N) — surfaced so the list page can
    // deep-link each LC to its invoice(s). docNumber is the human رقم الفاتورة.
    const lcIds = lcs.map(l => l.id);
    const invoices = await db.select({
      id:        purchaseInvoicesTable.id,
      lcId:      purchaseInvoicesTable.lcId,
      docNumber: purchaseInvoicesTable.docNumber,
      status:    purchaseInvoicesTable.status,
    }).from(purchaseInvoicesTable).where(and(
      eq(purchaseInvoicesTable.companyId, cid),
      inArray(purchaseInvoicesTable.lcId, lcIds),
    )).orderBy(asc(purchaseInvoicesTable.invoiceDate));
    const invByLc = new Map<number, any[]>();
    for (const inv of invoices) {
      if (inv.lcId == null) continue;
      const arr = invByLc.get(inv.lcId) ?? [];
      arr.push(inv); invByLc.set(inv.lcId, arr);
    }
    res.json(lcs.map(lc => ({
      ...enrichLcRow(lc, byLc.get(lc.id) ?? [], baseCurrency),
      linkedInvoices: invByLc.get(lc.id) ?? [],
    })));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// NOTE: This route MUST be declared BEFORE `/letters-of-credit/:id` —
// Express matches in registration order and `:id` would otherwise swallow
// `/statement` as id="statement" and return 404.
// ─── LC Statement (تقرير كشف حساب الاعتمادات) ─────────────────────────
//   GET /letters-of-credit/statement
//     ?from=YYYY-MM-DD          (filter by lcDate ≥ from)
//     ?to=YYYY-MM-DD            (filter by lcDate ≤ to)
//     ?supplierId=NN            (only LCs for this supplier)
//     ?status=open|partial|closed
// Returns one row per LC with full details + per-expense breakdown +
// every linked posted purchase invoice, all converted to base currency
// for grand-totals. Also includes top-level summary KPIs.
router.get("/letters-of-credit/statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ rows: [], summary: null, baseCurrency: "SAR" }); return; }
    const { from, to, supplierId, status } = req.query as Record<string, string>;
    const baseCurrency = await getBaseCurrencyCode(cid);

    const conds: any[] = [eq(lettersOfCreditTable.companyId, cid)];
    if (from)       conds.push(sql`${lettersOfCreditTable.lcDate} >= ${from}`);
    if (to)         conds.push(sql`${lettersOfCreditTable.lcDate} <= ${to}`);
    if (supplierId) conds.push(eq(lettersOfCreditTable.supplierId, Number(supplierId)));
    if (status && ["open","partial","closed"].includes(status)) {
      conds.push(eq(lettersOfCreditTable.status, status as any));
    }

    const lcs = await db.select().from(lettersOfCreditTable)
      .where(and(...conds))
      .orderBy(desc(lettersOfCreditTable.lcDate), desc(lettersOfCreditTable.id));

    if (lcs.length === 0) {
      res.json({ rows: [], summary: { count: 0, totalBase: 0, expensesBase: 0, usedBase: 0, remainingBase: 0 }, baseCurrency });
      return;
    }

    const lcIds = lcs.map(l => l.id);
    const supplierIds = Array.from(new Set(lcs.map(l => l.supplierId).filter((v): v is number => v != null)));

    const [allExpenses, allInvoices, allSuppliers, allBanks, allCashBoxes, allTransferEntries] = await Promise.all([
      db.select().from(lcExpensesTable)
        .where(and(eq(lcExpensesTable.companyId, cid), inArray(lcExpensesTable.lcId, lcIds))),
      db.select({
          id:          purchaseInvoicesTable.id,
          lcId:        purchaseInvoicesTable.lcId,
          docNumber:   purchaseInvoicesTable.docNumber,
          invoiceDate: purchaseInvoicesTable.invoiceDate,
          totalAmount: purchaseInvoicesTable.totalAmount,
          vatAmount:   purchaseInvoicesTable.vatAmount,
          totalExpensesLoaded: purchaseInvoicesTable.totalExpensesLoaded,
          currencyCode: purchaseInvoicesTable.currencyCode,
          exchangeRate: purchaseInvoicesTable.exchangeRate,
          status:      purchaseInvoicesTable.status,
          supplierId:  purchaseInvoicesTable.supplierId,
        })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.companyId, cid),
          inArray(purchaseInvoicesTable.lcId, lcIds),
        ))
        .orderBy(asc(purchaseInvoicesTable.invoiceDate)),
      supplierIds.length
        ? db.select({ id: suppliersTable.id, nameAr: suppliersTable.nameAr, nameEn: suppliersTable.nameEn })
            .from(suppliersTable)
            .where(and(eq(suppliersTable.companyId, cid), inArray(suppliersTable.id, supplierIds)))
        : Promise.resolve([] as any[]),
      // Bank accounts → keyed by their GL accountId so we can map
      // a journal-entry-line's accountId back to "this is bank X".
      db.select({ id: bankAccountsTable.id, accountId: bankAccountsTable.accountId,
                  nameAr: bankAccountsTable.nameAr, nameEn: bankAccountsTable.nameEn,
                  bankName: bankAccountsTable.bankName })
        .from(bankAccountsTable)
        .where(eq(bankAccountsTable.companyId, cid)),
      db.select({ id: cashBoxesTable.id, accountId: cashBoxesTable.accountId,
                  nameAr: cashBoxesTable.nameAr, nameEn: cashBoxesTable.nameEn })
        .from(cashBoxesTable)
        .where(eq(cashBoxesTable.companyId, cid)),
      // LC funding / expense-payment journal entries — tagged in their
      // description with [LC#<id>] and optionally [LCE#<expenseId>] by the
      // LC funding mutation. We pull every such entry for this company,
      // then filter in JS by the LC ids we actually need.
      db.select({
          id:          journalEntriesTable.id,
          entryDate:   journalEntriesTable.entryDate,
          description: journalEntriesTable.description,
          entryType:   journalEntriesTable.entryType,
          currency:    journalEntriesTable.currency,
        })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          inArray(journalEntriesTable.entryType, ["lc_funding", "lc_expense_payment"]),
        )),
    ]);

    // ─── Resolve source bank/cash for each LC funding & expense payment ──
    // Map GL accountId → { type, name } so a JE-line's accountId tells us
    // which bank or cash-box was the source side of the transfer.
    const sourceByAccount = new Map<number, { type: "bank" | "cash"; nameAr: string | null; nameEn: string | null; bankName?: string | null }>();
    for (const b of allBanks) {
      if (b.accountId) sourceByAccount.set(b.accountId, { type: "bank", nameAr: b.nameAr, nameEn: b.nameEn, bankName: b.bankName });
    }
    for (const c of allCashBoxes) {
      if (c.accountId) sourceByAccount.set(c.accountId, { type: "cash", nameAr: c.nameAr, nameEn: c.nameEn });
    }

    // Filter JEs whose description tag points at one of our LC ids, then
    // batch-load the credit-side line(s) to find the source accountId.
    const lcIdSet = new Set(lcIds);
    type Tagged = { lcId: number; expenseId: number | null; entryId: number; entryDate: string; description: string | null };
    const tagged: Tagged[] = [];
    for (const j of allTransferEntries) {
      const m = /\[LC#(\d+)\]/.exec(j.description ?? "");
      if (!m) continue;
      const lcId = Number(m[1]);
      if (!lcIdSet.has(lcId)) continue;
      const me = /\[LCE#(\d+)\]/.exec(j.description ?? "");
      tagged.push({ lcId, expenseId: me ? Number(me[1]) : null, entryId: j.id, entryDate: j.entryDate, description: j.description });
    }
    let lineRows: { entryId: number; accountId: number | null; credit: any; debit: any }[] = [];
    if (tagged.length > 0) {
      lineRows = await db.select({
          entryId:   journalEntryLinesTable.entryId,
          accountId: journalEntryLinesTable.accountId,
          credit:    journalEntryLinesTable.credit,
          debit:     journalEntryLinesTable.debit,
        })
        .from(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.entryId, tagged.map(t => t.entryId)));
    }
    const linesByEntry = new Map<number, typeof lineRows>();
    for (const l of lineRows) {
      const arr = linesByEntry.get(l.entryId) ?? [];
      arr.push(l); linesByEntry.set(l.entryId, arr);
    }

    type Transfer = {
      entryId: number; date: string;
      amount: number;
      sourceType: "bank" | "cash" | null;
      sourceNameAr: string | null;
      sourceNameEn: string | null;
      sourceBankName: string | null;
    };
    const transfersByLc       = new Map<number, Transfer[]>();
    const transfersByExpense  = new Map<number, Transfer[]>();
    for (const t of tagged) {
      const lines = linesByEntry.get(t.entryId) ?? [];
      // Source = the line whose accountId matches a bank or cash GL
      // (typically the credit side of the funding/payment entry).
      let src: typeof lineRows[number] | undefined;
      let srcInfo: ReturnType<typeof sourceByAccount.get> | undefined;
      for (const ln of lines) {
        if (ln.accountId == null) continue;
        const info = sourceByAccount.get(ln.accountId);
        if (info) { src = ln; srcInfo = info; break; }
      }
      const amount = src ? Number(src.credit ?? 0) || Number(src.debit ?? 0) : 0;
      const transfer: Transfer = {
        entryId: t.entryId,
        date:    t.entryDate,
        amount,
        sourceType:     srcInfo?.type ?? null,
        sourceNameAr:   srcInfo?.nameAr ?? null,
        sourceNameEn:   srcInfo?.nameEn ?? null,
        sourceBankName: srcInfo?.bankName ?? null,
      };
      if (t.expenseId != null) {
        const arr = transfersByExpense.get(t.expenseId) ?? [];
        arr.push(transfer); transfersByExpense.set(t.expenseId, arr);
      } else {
        const arr = transfersByLc.get(t.lcId) ?? [];
        arr.push(transfer); transfersByLc.set(t.lcId, arr);
      }
    }

    const expByLc = new Map<number, any[]>();
    for (const e of allExpenses) {
      const arr = expByLc.get(e.lcId) ?? [];
      arr.push(e); expByLc.set(e.lcId, arr);
    }
    const invByLc = new Map<number, any[]>();
    for (const i of allInvoices) {
      if (i.lcId == null) continue;
      const arr = invByLc.get(i.lcId) ?? [];
      arr.push(i); invByLc.set(i.lcId, arr);
    }
    const supMap = new Map(allSuppliers.map(s => [s.id, s]));

    const rows = lcs.map(lc => {
      const enriched: any = enrichLcRow(lc, expByLc.get(lc.id) ?? [], baseCurrency);
      // Attach per-expense funding source(s) onto each enriched expense row.
      enriched.expenses = (enriched.expenses ?? []).map((e: any) => ({
        ...e,
        fundingTransfers: transfersByExpense.get(e.id) ?? [],
      }));
      const invs = invByLc.get(lc.id) ?? [];
      const invoiceRows = invs.map(i => {
        const total    = Number(i.totalAmount         || 0);
        const vat      = Number(i.vatAmount           || 0);
        const expLoad  = Number(i.totalExpensesLoaded || 0);
        const goodsInv = total - expLoad;
        const rate     = Number(i.exchangeRate || "1") || 1;
        return {
          ...i,
          totalBase:        +(total    * rate).toFixed(2),
          vatBase:          +(vat      * rate).toFixed(2),
          expensesLoadedBase: +(expLoad  * rate).toFixed(2),
          goodsBase:        +(goodsInv * rate).toFixed(2),
        };
      });
      const usedBase     = invoiceRows
        .filter(i => i.status === "posted")
        .reduce((s, i) => s + i.goodsBase, 0);
      const supplier = lc.supplierId ? supMap.get(lc.supplierId) ?? null : null;
      return {
        ...enriched,
        supplierNameAr: supplier?.nameAr ?? null,
        supplierNameEn: supplier?.nameEn ?? null,
        invoices:       invoiceRows,
        invoiceCount:   invoiceRows.length,
        usedBaseFromInvoices: +usedBase.toFixed(2),
        // LC-value funding transfers (target=settlement, no expense tag).
        fundingTransfers: transfersByLc.get(lc.id) ?? [],
      };
    });

    const summary = {
      count:         rows.length,
      totalBase:     +rows.reduce((s, r) => s + Number(r.totalAmountBase   || 0), 0).toFixed(2),
      expensesBase:  +rows.reduce((s, r) => s + Number(r.totalExpensesBase || 0), 0).toFixed(2),
      usedBase:      +rows.reduce((s, r) => s + Number(r.usedAmount        || 0), 0).toFixed(2),
      remainingBase: +rows.reduce((s, r) => s + Number(r.remainingBase     || 0), 0).toFixed(2),
      invoiceCount:  rows.reduce((s, r) => s + r.invoiceCount, 0),
    };

    res.json({ rows, summary, baseCurrency });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    const expenses = await db.select().from(lcExpensesTable)
      .where(eq(lcExpensesTable.lcId, id));
    const baseCurrency = await getBaseCurrencyCode(cid);
    res.json(enrichLcRow(lc, expenses, baseCurrency));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/letters-of-credit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { lcNumber, lcDate, supplierId, branchId, bankName, currencyCode, exchangeRate,
            totalAmount, settlementAccountId, notes, expenses } = req.body;
    if (!lcNumber || !lcDate || !totalAmount) {
      res.status(400).json({ error: "رقم الاعتماد والتاريخ والقيمة مطلوبة" }); return;
    }
    if (branchId) {
      const bid = Number(branchId);
      if (!Number.isInteger(bid) || bid <= 0) { res.status(400).json({ error: "الفرع المحدّد غير صحيح" }); return; }
      const [br] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, bid), eq(branchesTable.companyId, cid)));
      if (!br) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
    }
    const [lc] = await db.insert(lettersOfCreditTable).values({
      companyId: cid, lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      branchId: branchId ? Number(branchId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate ?? "1"),
      totalAmount: String(totalAmount), usedAmount: "0",
      settlementAccountId: settlementAccountId ? Number(settlementAccountId) : null,
      status: "open", notes: notes || null,
    }).returning();
    if (expenses?.length) {
      const baseCur = await getBaseCurrencyCode(cid);
      await db.insert(lcExpensesTable).values(
        expenses.map((e: any) => {
          const cur = e.currencyCode || "SAR";
          // Defensive: same-currency rows must always have rate=1
          const rate = cur === baseCur ? "1" : String(e.exchangeRate ?? "1");
          return {
            lcId: lc.id, companyId: cid,
            expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
            amount: String(e.amount), currencyCode: cur,
            exchangeRate: rate,
            notes: e.notes || null,
          };
        })
      );
    }
    res.status(201).json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Guard: closed LCs are sealed. Editing any field — including expense
    // lines, settlement account, or amount — would silently invalidate
    // already-posted journal entries that referenced the prior state.
    // Admins must explicitly reopen the LC first (PATCH .../reopen).
    const [existing] = await db.select({ status: lettersOfCreditTable.status })
      .from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (existing.status === "closed") {
      res.status(409).json({
        error: "لا يمكن تعديل اعتماد مغلق. أعد فتحه أولاً ثم عدّله، أو أنشئ قيد تسوية يدوي إذا كان التعديل محاسبياً.",
      });
      return;
    }
    const { lcNumber, lcDate, supplierId, branchId, bankName, currencyCode, exchangeRate,
            totalAmount, settlementAccountId, notes, expenses } = req.body;
    if (branchId) {
      const bid = Number(branchId);
      if (!Number.isInteger(bid) || bid <= 0) { res.status(400).json({ error: "الفرع المحدّد غير صحيح" }); return; }
      const [br] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, bid), eq(branchesTable.companyId, cid)));
      if (!br) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
    }
    const [lc] = await db.update(lettersOfCreditTable).set({
      lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      branchId: branchId ? Number(branchId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate ?? "1"),
      totalAmount: String(totalAmount),
      settlementAccountId: settlementAccountId ? Number(settlementAccountId) : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid))).returning();
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (expenses !== undefined) {
      await db.delete(lcExpensesTable).where(eq(lcExpensesTable.lcId, id));
      if (expenses.length) {
        const baseCur = await getBaseCurrencyCode(cid);
        await db.insert(lcExpensesTable).values(
          expenses.map((e: any) => {
            const cur = e.currencyCode || "SAR";
            const rate = cur === baseCur ? "1" : String(e.exchangeRate ?? "1");
            return {
              lcId: id, companyId: cid,
              expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
              amount: String(e.amount), currencyCode: cur,
              exchangeRate: rate,
              notes: e.notes || null,
            };
          })
        );
      }
    }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Append a SINGLE expense to an existing LC.
// Used by the standalone "Add LC Expense" screen so users can record
// expenses incrementally as procedures complete (shipping → customs →
// insurance, etc.) without reopening the full LC edit dialog every time.
// Returns the created expense row. Blocks when the LC is closed.
router.post("/letters-of-credit/:id/expenses", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [lc] = await db.select({
      id: lettersOfCreditTable.id,
      status: lettersOfCreditTable.status,
      currencyCode: lettersOfCreditTable.currencyCode,
    }).from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (lc.status === "closed") {
      res.status(409).json({ error: "لا يمكن إضافة مصروف لاعتماد مغلق. أعد فتحه أولاً." });
      return;
    }
    const { expenseType, accountId, amount, currencyCode, exchangeRate, notes } = req.body ?? {};
    if (!expenseType || !(Number(amount) > 0)) {
      res.status(400).json({ error: "نوع المصروف والمبلغ مطلوبان" }); return;
    }
    // Validate accountId belongs to this company and is a posting account
    if (accountId) {
      const { accountsTable } = await import("@workspace/db");
      const [acc] = await db.select({
        id: accountsTable.id, isPosting: accountsTable.isPosting,
      }).from(accountsTable)
        .where(and(eq(accountsTable.id, Number(accountId)), eq(accountsTable.companyId, cid)));
      if (!acc) { res.status(400).json({ error: "حساب المصروف غير صالح" }); return; }
      if (!acc.isPosting) { res.status(400).json({ error: "حساب المصروف يجب أن يكون حساب ترحيل" }); return; }
    }
    // Defensive guard: if the expense currency equals the company base
    // currency, force exchangeRate = 1. Prevents clients that mistakenly
    // inherit the LC's foreign rate from inflating amountBase = amount × rate
    // (which has previously caused expenses to be double-counted in totals).
    const baseCurrency = await getBaseCurrencyCode(cid);
    const expCur = currencyCode || lc.currencyCode || baseCurrency;
    const expRate = expCur === baseCurrency ? "1" : String(exchangeRate ?? "1");
    const [created] = await db.insert(lcExpensesTable).values({
      lcId: id, companyId: cid,
      expenseType: String(expenseType),
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount),
      currencyCode: expCur,
      exchangeRate: expRate,
      notes: notes || null,
    }).returning();
    res.status(201).json(created);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Guard: closed LCs cannot be deleted either. Admin must reopen first.
    const [existing] = await db.select({ status: lettersOfCreditTable.status })
      .from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (existing?.status === "closed") {
      res.status(409).json({
        error: "لا يمكن حذف اعتماد مغلق. أعد فتحه أولاً ثم احذفه.",
      });
      return;
    }
    // Guard: purchase_invoices.lc_id is a non-cascading FK. Block delete if
    // any invoice still references this LC and surface a clear, localized
    // message instead of a generic "Failed query" from the FK violation.
    const linked = await db.select({
      id: purchaseInvoicesTable.id,
      docNumber: purchaseInvoicesTable.docNumber,
      status: purchaseInvoicesTable.status,
    }).from(purchaseInvoicesTable).where(and(
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.lcId, id),
    ));
    if (linked.length > 0) {
      const sample = linked.slice(0, 5).map(r => r.docNumber ?? `#${r.id}`).join(", ");
      const more = linked.length > 5 ? ` +${linked.length - 5}` : "";
      res.status(409).json({
        error: `لا يمكن حذف هذا الاعتماد — مرتبط بـ ${linked.length} فاتورة شراء (${sample}${more}). أزل الربط من الفواتير أولاً، أو احذف/الغِ الفواتير، ثم أعد المحاولة.`,
      });
      return;
    }
    // lc_expenses cascades automatically via FK onDelete: "cascade".
    await db.delete(lettersOfCreditTable).where(and(
      eq(lettersOfCreditTable.id, id),
      eq(lettersOfCreditTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── Recompute LC usage from posted purchase invoices ──────────────────────
// Sums the GOODS portion (totalAmount - vatAmount - totalExpensesLoaded,
// converted to LC base via the invoice's exchangeRate) of every POSTED
// purchase invoice linked to this LC. Then auto-derives the status:
//   used == 0                 → open
//   0 < used < totalBase      → partial
//   used >= totalBase         → closed
// Status is NOT changed when the LC was manually closed/reopened by an
// admin AND the auto-rule wouldn't change it back to "closed" — manual
// override always wins for the closed→reopen transition since the user
// explicitly took action.
async function recomputeLcUsage(cid: number, lcId: number): Promise<void> {
  const [lc] = await db.select().from(lettersOfCreditTable)
    .where(and(eq(lettersOfCreditTable.id, lcId), eq(lettersOfCreditTable.companyId, cid)));
  if (!lc) return;

  const invoices = await db.select().from(purchaseInvoicesTable).where(and(
    eq(purchaseInvoicesTable.companyId, cid),
    eq(purchaseInvoicesTable.lcId, lcId),
    eq(purchaseInvoicesTable.status, "posted"),
  ));

  // Goods portion in LC base currency. Each invoice carries its own
  // exchangeRate which converts the invoice amount to the company base
  // currency (same base as the LC's totalAmountBase).
  let usedBase = 0;
  for (const inv of invoices) {
    const total       = Number(inv.totalAmount         || 0);
    const expLoaded   = Number(inv.totalExpensesLoaded || 0);
    // Mirror the JE credit posted to the LC settlement account
    // (see post handler — `goodsPortion = totalAmount - expensesLoaded`),
    // so usedAmount tracks the actual LC settlement clearing.
    const goodsInvCur = total - expLoaded;
    const rate        = Number(inv.exchangeRate || "1") || 1;
    usedBase += goodsInvCur * rate;
  }

  const lcRate    = Number(lc.exchangeRate || "1") || 1;
  const totalBase = (Number(lc.totalAmount || 0) || 0) * lcRate;

  let status: "open" | "partial" | "closed" = "open";
  if (usedBase >= totalBase - 0.01 && totalBase > 0) status = "closed";
  else if (usedBase > 0.01) status = "partial";

  await db.update(lettersOfCreditTable).set({
    usedAmount: usedBase.toFixed(2),
    status,
    updatedAt: new Date(),
  }).where(eq(lettersOfCreditTable.id, lcId));
}

// ─── Manual LC close / reopen (admin override) ───────────────────────────
router.patch("/letters-of-credit/:id/close", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [lc] = await db.update(lettersOfCreditTable)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)))
      .returning();
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/letters-of-credit/:id/reopen", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Reopen falls back to the auto-derived status (open or partial) so the
    // user does not get stuck with a stale "closed" state right after reopen.
    await db.update(lettersOfCreditTable)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    await recomputeLcUsage(cid, id);
    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE INVOICES
// ═══════════════════════════════════════════════
router.get("/purchase-invoices", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseInvoicesTable)
      .where(and(
        eq(purchaseInvoicesTable.companyId, cid),
        ...multiBranchScopeSpread(req, purchaseInvoicesTable.branchId, req.query.branchIds ?? req.query.branchId),
      ))
      .orderBy(desc(purchaseInvoicesTable.invoiceDate));

    // Resolve usernames for createdById / postedById so the grid can render
    // "أنشأه" / "رحّله" columns without an extra round trip.
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

    // Enrich each invoice with its latest linked payment voucher so the
    // listing can show a "paid via cash/bank" badge in the side row. We
    // pull all linked vouchers for this tenant in a single query and
    // group in memory — cheap, and avoids N+1 even for large tenants.
    const ids = enrichedRows.map(r => r.id);
    if (ids.length === 0) { res.json(enrichedRows); return; }
    const { paymentVouchersTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const links = await db.select({
      voucherId:         paymentVouchersTable.id,
      code:              paymentVouchersTable.code,
      paymentType:       paymentVouchersTable.paymentType,
      amount:            paymentVouchersTable.amount,
      status:            paymentVouchersTable.status,
      date:              paymentVouchersTable.date,
      purchaseInvoiceId: paymentVouchersTable.purchaseInvoiceId,
    }).from(paymentVouchersTable).where(and(
      eq(paymentVouchersTable.companyId, cid),
      inArray(paymentVouchersTable.purchaseInvoiceId, ids),
      // Only POSTED vouchers turn an invoice into "paid". Drafts stay
      // invisible in the listing badge — otherwise we would mislead the
      // user that an invoice is settled when in reality the voucher is
      // still being edited.
      eq(paymentVouchersTable.status, "posted"),
    ));
    // Group by invoice; deterministic tiebreaker: latest date, then
    // highest voucherId, so the badge never flickers between rows that
    // share the same date.
    const byInvoice = new Map<number, typeof links>();
    for (const l of links) {
      if (!l.purchaseInvoiceId) continue;
      const arr = byInvoice.get(l.purchaseInvoiceId) ?? [];
      arr.push(l);
      byInvoice.set(l.purchaseInvoiceId, arr);
    }
    // Σ effective per-line discount (percent OR fixed amount) per invoice so the
    // audit grid can render a real total-discount column (document + line),
    // mirroring the sales list endpoint. List rows only carry the document-level
    // discountAmount otherwise.
    const lineDiscByInvoice = new Map<number, number>();
    {
      const plines = await db.select({
        invoiceId:      purchaseInvoiceLinesTable.invoiceId,
        qty:            purchaseInvoiceLinesTable.qty,
        unitPrice:      purchaseInvoiceLinesTable.unitPrice,
        discount:       purchaseInvoiceLinesTable.discount,
        discountAmount: purchaseInvoiceLinesTable.discountAmount,
      }).from(purchaseInvoiceLinesTable).where(inArray(purchaseInvoiceLinesTable.invoiceId, ids));
      for (const l of plines) {
        if (!l.invoiceId) continue;
        const gross = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
        const amt   = Math.max(0, Number(l.discountAmount) || 0);
        const eff   = amt > 0
          ? Math.min(amt, gross)
          : (gross * Math.max(0, Math.min(100, Number(l.discount) || 0))) / 100;
        lineDiscByInvoice.set(l.invoiceId, (lineDiscByInvoice.get(l.invoiceId) ?? 0) + eff);
      }
    }
    // حالة السداد الحقيقية (سندات + قيود سداد + روابط جزئية) — batch, no N+1.
    const { batchInvoiceSettlementStatus } = await import("../lib/invoiceSettlement.js");
    const payMap = await batchInvoiceSettlementStatus(cid, "purchase", enrichedRows.map(r => ({
      id: r.id, totalAmount: r.totalAmount, exchangeRate: (r as any).exchangeRate,
      paymentType: (r as any).paymentType, status: (r as any).status,
    })));
    const enriched = enrichedRows.map(r => {
      const arr = byInvoice.get(r.id) ?? [];
      const sorted = [...arr].sort((a, b) => {
        const dateCmp = String(b.date).localeCompare(String(a.date));
        if (dateCmp !== 0) return dateCmp;
        return b.voucherId - a.voucherId;
      });
      const top = sorted[0];
      const pay = payMap.get(r.id);
      return {
        ...r,
        paymentStatus:   pay?.paymentStatus ?? "unpaid",
        paidAmount:      pay?.paidBase ?? 0,
        remainingAmount: pay?.remainingBase ?? 0,
        netDueAmount:    pay?.netDueBase ?? 0,
        lineDiscountTotal: (lineDiscByInvoice.get(r.id) ?? 0).toFixed(2),
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

router.get("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const lines = await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id))
      .orderBy(asc(purchaseInvoiceLinesTable.id));
    res.json({ ...inv, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ── مصروف مرحّل tab: deferred lines of an invoice + their linked adjustments
// and generated periodic runs. Read-only aggregation for the invoice form.
router.get("/purchase-invoices/:id/deferred", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [inv] = await db.select({ id: purchaseInvoicesTable.id })
      .from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const defLines = (await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id))
      .orderBy(asc(purchaseInvoiceLinesTable.id)))
      .filter(l => (l as any).deferredStartDate || (l as any).deferredAdjustmentId);
    const adjs = await db.select().from(accountingAdjustmentsTable)
      .where(and(
        eq(accountingAdjustmentsTable.companyId, cid),
        eq(accountingAdjustmentsTable.sourceType, "purchase_invoice"),
        eq(accountingAdjustmentsTable.sourceId, id),
      ));
    const adjIds = adjs.map(a => a.id);
    // Runs enriched with their JE's real status + docNumber: the run row
    // itself has no status column — the periodic JE is the source of truth
    // (unpost flips those JEs to draft while keeping the run rows).
    const runs = adjIds.length
      ? await db.select({
          id:             accountingAdjustmentRunsTable.id,
          adjustmentId:   accountingAdjustmentRunsTable.adjustmentId,
          periodMonth:    accountingAdjustmentRunsTable.periodMonth,
          amount:         accountingAdjustmentRunsTable.amount,
          journalEntryId: accountingAdjustmentRunsTable.journalEntryId,
          generatedAt:    accountingAdjustmentRunsTable.generatedAt,
          jeStatus:       journalEntriesTable.status,
          jeDocNumber:    journalEntriesTable.docNumber,
          jeDate:         journalEntriesTable.entryDate,
        }).from(accountingAdjustmentRunsTable)
          .leftJoin(journalEntriesTable, eq(journalEntriesTable.id, accountingAdjustmentRunsTable.journalEntryId))
          .where(inArray(accountingAdjustmentRunsTable.adjustmentId, adjIds))
          .orderBy(asc(accountingAdjustmentRunsTable.id))
      : [];
    res.json({ lines: defLines, adjustments: adjs, runs });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, supplierInvoiceDate, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, costCenter, taxId } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    await assertPurchaseWriteReferences(cid, {
      supplierId, branchId, cashBoxId, bankAccountId, lcId, taxId,
      headerCostCenter: costCenter,
      lines,
    });
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "purchase_invoices", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
    // Required-fields gate (per company policy): every purchase invoice
    // must carry an explicit supplier + branch. Tightened from the older
    // "credit-only" supplier requirement so cash/bank purchases also need
    // an identified supplier — accountants need a clear vendor on every
    // bill for VAT input claim and supplier-statement reporting.
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد قبل حفظ الفاتورة", field: "supplierId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ الفاتورة",  field: "branchId"   }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }

    // Central sequence engine is AUTHORITATIVE: when an active sequence is
    // bound to "purchase_invoice" we consume it (atomic increment) and ignore
    // any client-supplied docNumber — the form peeks the next number purely to
    // preview it, so trusting that peeked value would bypass the engine and
    // mint the SAME number for every invoice. Only when NO sequence is
    // configured do we honour a manually-typed docNumber.
    let resolvedDocNumber: string | null = null;
    try {
      const allocateInvoiceNumber = () => nextSequenceForPayment(cid, "purchase_invoice", pType, {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_invoices",
        branchId: branchId ? Number(branchId) : null,
        docDate:  invoiceDate,
      });
      let fromSeq = await allocateInvoiceNumber();
      for (let skipped = 0; fromSeq != null; skipped += 1) {
        const duplicate = await db.select({ id: purchaseInvoicesTable.id })
          .from(purchaseInvoicesTable)
          .where(and(
            eq(purchaseInvoicesTable.companyId, cid),
            eq(purchaseInvoicesTable.docNumber, fromSeq),
          ))
          .limit(1);
        if (!duplicate.length) break;
        if (skipped >= 999) throw new Error("تعذر الوصول إلى رقم فاتورة شراء غير مستخدم بعد الاستعادة");
        fromSeq = await allocateInvoiceNumber();
      }
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      throw Object.assign(
        new Error(seqErr?.message ?? "تعذر توليد رقم الفاتورة"),
        { status: 400 },
      );
    }

    const requestedAccountIds = [
      inventoryAccountId, taxAccountId, discountAccountId,
    ].map(Number).filter((accountId) => Number.isInteger(accountId) && accountId > 0);
    const validAccountIds = requestedAccountIds.length
      ? new Set((await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
          eq(accountsTable.companyId, cid),
          inArray(accountsTable.id, [...new Set(requestedAccountIds)]),
        ))).map((row) => row.id))
      : new Set<number>();
    const validAccount = (value: unknown): number | null => {
      const accountId = Number(value);
      return Number.isInteger(accountId) && validAccountIds.has(accountId) ? accountId : null;
    };
    const inv = await insertPurchaseInvoiceWithSerialRepair({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber, supplierInvoiceNumber: supplierInvoiceNumber || null,
      supplierInvoiceDate: supplierInvoiceDate || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: validAccount(inventoryAccountId),
      taxAccountId:       validAccount(taxAccountId),
      discountAccountId:  validAccount(discountAccountId),
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      taxId:              taxId ? Number(taxId) : null,
      status: "draft", notes: notes || null,
      createdById: (req as any).authUser?.id ?? null,
    });
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      const mappedLines = await resolvePurchaseLineUnits(
        cid,
        lines.map((l: any) => ({
          invoiceId: inv.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null,
          unit: l.unit || null, unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
          weight: String(l.weight || "0"), unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || resolvedRate),
          discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
          lineTotal: String(l.lineTotal || "0"), expenseShare: String(l.expenseShare || "0"),
          finalCost: String(l.finalCost || "0"),
          accountId: l.accountId ? Number(l.accountId) : null,
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          costCenter: l.costCenter ? String(l.costCenter).trim() || null : null,
          batchNumber: l.batchNumber ? String(l.batchNumber).trim() || null : null,
          expiryDate: l.expiryDate ? String(l.expiryDate) : null,
          notes: l.notes || null, ...deferredLineFields(l),
          industrialCost: normalizeIndustrialCostTag(l.industrialCost),
        })),
        lines,
      );
      await db.insert(purchaseInvoiceLinesTable).values(
        mappedLines
      );
    }
    res.status(201).json(inv);
  } catch (e: any) {
    logger.error({ err: e }, "purchase invoice create failed");
    const friendly = purchasingWriteError(e, "فاتورة الشراء");
    res.status(friendly.status).json({ error: friendly.message });
  }
});

router.put("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // POSTED-DOC LOCK — same rule as sales: a posted purchase invoice is
    // immutable until an admin explicitly unposts it.
    const [existing] = await db.select({ status: purchaseInvoicesTable.status })
      .from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (existing.status === "posted") {
      res.status(409).json({ error: "لا يمكن تعديل فاتورة مُرحَّلة. قم بفك الترحيل أولاً." });
      return;
    }
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, supplierInvoiceDate, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, costCenter, taxId } = req.body;
    // Same required-fields gate as the POST path so a stale-draft PUT
    // can't strip supplier/branch off an existing purchase invoice.
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد قبل حفظ الفاتورة", field: "supplierId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ الفاتورة",  field: "branchId"   }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }
    await assertPurchaseWriteReferences(cid, {
      supplierId, branchId, cashBoxId, bankAccountId, lcId, taxId,
      headerCostCenter: costCenter, lines,
    });
    // حارس ما بعد السداد: لا يجوز أن يصبح صافي الفاتورة أقل من المسدَّد عليها.
    try {
      const newTotalBase = (parseFloat(String(totalAmount)) || 0) * (parseFloat(String(exchangeRate)) || 1);
      await assertInvoiceEditKeepsSettlementsCovered(cid, "purchase", id, newTotalBase);
    } catch (e: any) {
      res.status(e?.status ?? 400).json({ error: e?.message || "التعديل يتعارض مع دفعات مسجَّلة على الفاتورة" });
      return;
    }
    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [inv] = await db.update(purchaseInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      supplierInvoiceDate: supplierInvoiceDate || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      taxId:              taxId ? Number(taxId) : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid))).returning();
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (lines !== undefined) {
      // Capture existing deferred-adjustment links BEFORE the wholesale line
      // rebuild — an unpost→edit cycle keeps the linked adjustments alive
      // (their periodic JEs are drafts holding their docNumbers), so the
      // link must survive the delete+reinsert or re-posting would mint a
      // duplicate adjustment. Matched back by itemId (first unclaimed).
      const previousLines = await db.select().from(purchaseInvoiceLinesTable)
        .where(eq(purchaseInvoiceLinesTable.invoiceId, id));
      const oldDeferredLinks = (await db.select({
        itemId: purchaseInvoiceLinesTable.itemId,
        deferredAdjustmentId: purchaseInvoiceLinesTable.deferredAdjustmentId,
      }).from(purchaseInvoiceLinesTable)
        .where(and(eq(purchaseInvoiceLinesTable.invoiceId, id), sql`${purchaseInvoiceLinesTable.deferredAdjustmentId} IS NOT NULL`))
      ).filter(r => r.deferredAdjustmentId != null);
      await db.delete(purchaseInvoiceLinesTable).where(eq(purchaseInvoiceLinesTable.invoiceId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        const mappedLines = await resolvePurchaseLineUnits(
          cid,
          lines.map((l: any) => ({
            invoiceId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null,
            unit: l.unit || null, unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
            weight: String(l.weight || "0"), unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || resolvedRate),
            discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
            lineTotal: String(l.lineTotal || "0"), expenseShare: String(l.expenseShare || "0"),
            finalCost: String(l.finalCost || "0"),
            accountId: l.accountId ? Number(l.accountId) : null,
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            costCenter: l.costCenter ? String(l.costCenter).trim() || null : null,
            batchNumber: l.batchNumber ? String(l.batchNumber).trim() || null : null,
            expiryDate: l.expiryDate ? String(l.expiryDate) : null,
            notes: l.notes || null, ...deferredLineFields(l),
            industrialCost: normalizeIndustrialCostTag(l.industrialCost),
          })),
          lines,
          previousLines,
        );
        await db.insert(purchaseInvoiceLinesTable).values(
          mappedLines
        );
        // Re-attach the surviving deferred-adjustment links: for each old
        // link, claim the FIRST re-inserted deferred line of the same item
        // that has no link yet. Lines whose item was removed simply drop the
        // link (the orphaned adjustment stays manageable from its screen).
        for (const link of oldDeferredLinks) {
          if (link.itemId == null) continue;
          const [cand] = await db.select({ id: purchaseInvoiceLinesTable.id })
            .from(purchaseInvoiceLinesTable)
            .where(and(
              eq(purchaseInvoiceLinesTable.invoiceId, id),
              eq(purchaseInvoiceLinesTable.itemId, link.itemId),
              sql`${purchaseInvoiceLinesTable.deferredAdjustmentId} IS NULL`,
              sql`${purchaseInvoiceLinesTable.deferredStartDate} IS NOT NULL`,
            ))
            .orderBy(asc(purchaseInvoiceLinesTable.id))
            .limit(1);
          if (cand) {
            await db.update(purchaseInvoiceLinesTable)
              .set({ deferredAdjustmentId: link.deferredAdjustmentId })
              .where(eq(purchaseInvoiceLinesTable.id, cand.id));
          }
        }
      }
    }
    res.json(inv);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// In-process single-flight guard: the /post flow performs many sequential DB
// writes (stock, JE, deferred adjustments) without one wrapping transaction —
// two concurrent posts of the SAME invoice could otherwise both pass the
// status check and duplicate side effects. api-server is a single process,
// so a process-local lock fully serializes concurrent requests.
const __postingLocks = new Set<string>();
router.patch("/purchase-invoices/:id/post", requirePostRight("purchase"), async (req, res) => {
  let __lockKey: string | null = null;
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    __lockKey = `pi-post:${cid}:${id}`;
    if (__postingLocks.has(__lockKey)) {
      __lockKey = null;
      res.status(409).json({ error: "جارٍ ترحيل هذه الفاتورة بالفعل — انتظر انتهاء العملية" });
      return;
    }
    __postingLocks.add(__lockKey);

    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") { res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" }); return; }

    const lines = await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في الفاتورة" }); return; }
    await assertIndustrialCostPeriodsWritable(cid, lines);

    // Item Usage Control (Phase ب): block posting a doc carrying restricted items.
    {
      const usageIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "purchase_invoices", usageIds, req.authUser, "post");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "post"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }

    // Load item metadata (type + per-item cost account). SERVICE items (خدمي)
    // are handled SAP-style: they NEVER touch inventory/stock and their cost
    // is debited to the item's own cost account (e.g. "مشاريع تحت التنفيذ")
    // instead of a warehouse inventory account.
    const lineItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
    const itemMetaRows = lineItemIds.length
      ? await db.select({ id: itemsTable.id, type: itemsTable.itemType, costAcc: itemsTable.costAccountId })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, lineItemIds)))
      : [];
    const itemTypeById = new Map<number, string>();
    const costAccById  = new Map<number, number | null>();
    for (const r of itemMetaRows) { itemTypeById.set(r.id, (r.type ?? "stock") as string); costAccById.set(r.id, r.costAcc ?? null); }
    // prepaid_expense (مصروف مقدم) items behave like services here: no stock
    // movement, cost routed to item.costAccountId (unless group routing wins).
    const isServiceLine = (l: any) => {
      if (!l.itemId) return false;
      const t = itemTypeById.get(l.itemId);
      return t === "service" || t === "prepaid_expense";
    };

    // ── فئات الأصناف (item-group accounting routing) ─────────────────────
    // A group with categoryType + accountId routes its items' purchase debit:
    //   inventory   → debit the group's account (stock movement still happens)
    //   fixed_asset → debit the group's asset account, NO stock movement
    //   expense     → debit the group's expense account, NO stock movement
    // Groups without routing (legacy) keep the current warehouse-derived path.
    // Group asset/expense routing WINS over item-level SERVICE typing: a user
    // who links a category to an account expects that account to be debited
    // even if the item was (mis)typed as service (e.g. مكيف في فئة أصل ثابت).
    const itemGroupIdRows = lineItemIds.length
      ? await db.select({ id: itemsTable.id, groupId: itemsTable.groupId })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, lineItemIds)))
      : [];
    const groupIdByItem = new Map<number, number | null>(itemGroupIdRows.map(r => [r.id, r.groupId ?? null]));
    const groupIds = Array.from(new Set(itemGroupIdRows.map(r => r.groupId).filter((x): x is number => !!x)));
    const groupRows = groupIds.length
      ? await db.select().from(itemGroupsTable)
          .where(and(eq(itemGroupsTable.companyId, cid), inArray(itemGroupsTable.id, groupIds)))
      : [];
    const groupById = new Map(groupRows.map(g => [g.id, g]));
    const groupRoutingForItem = (itemId: number | null) => {
      if (!itemId) return null;
      const gid = groupIdByItem.get(itemId);
      const g = gid ? groupById.get(gid) : null;
      if (!g || !g.categoryType || !g.accountId) return null;
      return { type: g.categoryType as "inventory" | "fixed_asset" | "expense" | "deferred_expense", accountId: g.accountId, costAccountId: g.costAccountId ?? null, nameAr: g.nameAr };
    };
    // Non-stock routed line = group type asset/expense/deferred_expense.
    // Applies to service-typed items too — category routing takes precedence.
    // deferred_expense debits the category's PREPAID asset account; the
    // amortization to expense happens via the linked accounting adjustment.
    const isGroupNoStockLine = (l: any) => {
      if (!l.itemId) return false;
      const r = groupRoutingForItem(l.itemId);
      return !!r && (r.type === "fixed_asset" || r.type === "expense" || r.type === "deferred_expense");
    };
    // Reject a tagged inventory/asset/deferred line BEFORE stock or journal
    // mutation. Industrial actuals may only be real non-stock expense debits:
    // an item service, or an item-group explicitly routed to an expense account.
    const industrialSourceAccountByLine = new Map<number, number>();
    for (const line of lines) {
      if (!normalizeIndustrialCostTag((line as any).industrialCost)) continue;
      const group = groupRoutingForItem(line.itemId);
      const sourceAccountId = group?.type === "expense"
        ? group.accountId
        : (!group && isServiceLine(line) ? costAccById.get(line.itemId!) : null);
      if (!sourceAccountId) {
        throw Object.assign(
          new Error(`سطر التكلفة الصناعية "${line.itemName ?? line.id}" يجب أن يكون خدمة أو صنف فئة مصروف مع حساب تكلفة فعلي`),
          { status: 400 },
        );
      }
      industrialSourceAccountByLine.set(line.id, sourceAccountId);
    }

    // ── مصروف يوزع على فترات: pre-validate deferred lines BEFORE any stock
    // mutation. A line in a deferred_expense category MUST carry a valid
    // recognition window, and an EXPENSE account must be resolvable
    // (item.costAccountId → group.costAccountId) for the amortization JEs.
    const deferredPlans: {
      line: any; total: number; expenseAccountId: number; contraAccountId: number;
      start: string; end: string; periodicity: string; ccSplit: any; itemName: string;
    }[] = [];
    {
      const problems: string[] = [];
      // Tenant-scoped cost-center id set for split validation (lazy-loaded once).
      let ccIdSet: Set<number> | null = null;
      const loadCcIds = async () => {
        if (ccIdSet) return ccIdSet;
        const rows = await db.select({ id: costCentersTable.id }).from(costCentersTable)
          .where(eq(costCentersTable.companyId, cid));
        ccIdSet = new Set(rows.map(r => r.id));
        return ccIdSet;
      };
      for (const l of lines) {
        if (!l.itemId) continue;
        const r = groupRoutingForItem(l.itemId);
        if (!r || r.type !== "deferred_expense") continue;
        const nm = l.itemName ?? `صنف #${l.itemId}`;
        const start = (l as any).deferredStartDate as string | null;
        const end   = (l as any).deferredEndDate   as string | null;
        if (!start || !end || end < start) { problems.push(`${nm}: فترة التوزيع (من/إلى) مطلوبة`); continue; }
        const expAcc = costAccById.get(l.itemId) ?? r.costAccountId ?? null;
        if (!expAcc) { problems.push(`${nm}: حساب المصروف مطلوب (حساب تكلفة الصنف أو حساب مصروف الفئة)`); continue; }
        // Qty-aware amount basis: persisted landed cost first, then the line
        // total, then qty×unitPrice — bare unitPrice would ignore quantity.
        const total = (Number(l.finalCost) || Number((l as any).lineTotal)
          || (Number(l.qty) || 1) * (Number(l.unitPrice) || 0)) || 0;
        if (total <= 0) continue;
        const monthsCount = installmentsBetween(start, end, "monthly").length;
        if (monthsCount <= 0) { problems.push(`${nm}: لا توجد أشهر صالحة بين تاريخي التوزيع`); continue; }
        // Optional multi-CC split: parse canonical {costCenterId,pct} and
        // verify every id belongs to THIS tenant. A present-but-invalid split
        // blocks posting explicitly (silent null would surprise the user).
        let ccSplit: { costCenterId: number; pct: number }[] | null = null;
        const rawSplit = (l as any).deferredCostCenters;
        if (Array.isArray(rawSplit) && rawSplit.length) {
          ccSplit = parseCcSplit(rawSplit);
          if (!ccSplit) { problems.push(`${nm}: توزيع مراكز التكلفة غير صالح — مجموع النسب يجب أن يساوي 100%`); continue; }
          const ids = await loadCcIds();
          const bad = ccSplit.filter(s => !ids.has(s.costCenterId));
          if (bad.length) { problems.push(`${nm}: مركز تكلفة غير موجود في توزيع النسب`); continue; }
        }
        deferredPlans.push({
          line: l, total, expenseAccountId: expAcc, contraAccountId: r.accountId,
          start, end, periodicity: normalizePeriodicity((l as any).deferredPeriodicity),
          ccSplit, itemName: nm,
        });
      }
      if (problems.length) {
        res.status(400).json({ error: `لا يمكن الترحيل — مصروفات موزعة على فترات: ${problems.join("، ")}` });
        return;
      }
    }

    // Stock items still require a warehouse; SERVICE items must NOT have one.
    // Asset/expense-routed group lines don't move stock → no warehouse needed.
    const noWh = lines.filter(l => l.itemId && !l.warehouseId && !isServiceLine(l) && !isGroupNoStockLine(l));
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Pre-validate SERVICE cost accounts BEFORE any stock mutation so a missing
    // account fails fast without leaving partial stock movements behind.
    // Group-routed asset/expense lines don't need an item cost account —
    // they debit the category's account instead.
    const svcNoCost = lines.filter(l => isServiceLine(l) && !isGroupNoStockLine(l) && Number(l.finalCost || l.unitPrice) > 0 && !costAccById.get(l.itemId as number));
    if (svcNoCost.length) {
      res.status(400).json({ error: `يجب تحديد حساب التكلفة للأصناف الخدمية قبل الترحيل: ${svcNoCost.map(l => l.itemName ?? `صنف #${l.itemId}`).join("، ")}` });
      return;
    }

    // Load warehouse info for inventory account derivation
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // When this invoice was created from a Goods Receipt Note (GRN), the
    // stock movement already happened at GRN-post time. Skip the stock
    // loop entirely so we don't double-count, and DEBIT Receiving Clearing
    // (instead of Inventory) so it nets out against the GRN's credit to
    // that same clearing account.
    const grnSourced = !!(inv as any).sourceGrnId;

    // Update stock balance for each stockable line (in base units), accumulate inventory debit per warehouse.
    // Keyed by "warehouseId|costCenterCode" — the OPTIONAL per-line cost center
    // (Odoo-style analytic distribution) splits the goods debit per cost center;
    // lines without one use "" and fall back to the header costCenter (unchanged).
    const inventoryByWarehouse: Record<string, number> = {};
    const whCcKey = (line: any) => `${line.warehouseId}|${((line as any).costCenter ?? "").toString().trim()}`;
    // Composite `accountId|costCenterCode` key so the OPTIONAL per-line cost
    // center survives service/category aggregation too; "" cc ⇒ header fallback.
    const accCcKey = (accountId: number, line: any) => `${accountId}|${((line as any).costCenter ?? "").toString().trim()}`;
    const serviceCostByAccount: Record<string, number> = {}; // SERVICE: cost → item.costAccountId (keyed acc|cc)
    const serviceItemNamesByAccount: Record<string, string[]> = {};
    const serviceMissing: string[] = [];                     // SERVICE lines lacking a cost account
    let serviceCostTotal = 0;
    // فئات الأصناف routing buckets:
    //   groupNoStockByAccount — asset/expense categories: debit, NO stock move
    //   groupInvByAccount     — inventory categories: debit the CATEGORY account
    //                           (stock movement still happens per warehouse)
    const groupNoStockByAccount: Record<string, number> = {}; // keyed acc|cc
    const groupNoStockItemNamesByAccount: Record<string, string[]> = {};
    let groupNoStockTotal = 0;
    const groupInvByAccount: Record<string, number> = {};     // keyed acc|cc
    const groupInvItemNamesByAccount: Record<string, string[]> = {};
    let groupInvTotal = 0;
    const costRefreshItemIds = new Set<number>();
    for (const line of lines) {
      if (!line.itemId) continue;
      // فئة أصل ثابت / مصروف: debit the category account, NO stock movement.
      // Checked BEFORE service typing — category routing takes precedence.
      if (isGroupNoStockLine(line)) {
        const r = groupRoutingForItem(line.itemId)!;
        const cost = Number(line.finalCost || line.unitPrice);
        if (cost <= 0) continue;
        const gk = accCcKey(r.accountId, line);
        groupNoStockByAccount[gk] = (groupNoStockByAccount[gk] ?? 0) + cost;
        (groupNoStockItemNamesByAccount[gk] ??= []).push(line.itemName ?? `صنف #${line.itemId}`);
        groupNoStockTotal += cost;
        continue;
      }
      // SERVICE items: no stock movement; route their cost to the per-item
      // cost account (e.g. مشاريع تحت التنفيذ). Uses the SAME cost formula as
      // goods so the proportional inventory-debit split stays balanced.
      if (isServiceLine(line)) {
        const svcCost = Number(line.finalCost || line.unitPrice);
        if (svcCost <= 0) continue;
        const acc = costAccById.get(line.itemId) ?? null;
        if (!acc) { serviceMissing.push(line.itemName ?? `صنف #${line.itemId}`); continue; }
        const sk = accCcKey(acc, line);
        serviceCostByAccount[sk] = (serviceCostByAccount[sk] ?? 0) + svcCost;
        (serviceItemNamesByAccount[sk] ??= []).push(line.itemName ?? `صنف #${line.itemId}`);
        serviceCostTotal += svcCost;
        continue;
      }
      if (!line.warehouseId) continue;
      const factor   = String(line.conversionFactor || "1");
      // Stock receives paid qty + free qty (supplier bonus units), but the
      // cost paid (finalCost) covers only the paid qty — so free units land
      // in inventory at zero marginal cost, lowering the weighted avg cost.
      // Example: buy 10 @ 100 + 2 free ⇒ 12 units for 1000 ⇒ 83.33 avg.
      const qty      = Number(multiplyQuantity(String(line.qty || "0"), factor))
        + Number(multiplyQuantity(String(line.freeQty || "0"), factor));
      const cost     = Number(line.finalCost || line.unitPrice);
      const costUnit = qty > 0
        ? Number(roundQuantity(divideQuantity(String(cost), String(qty)), 18, "half_up"))
        : Number(roundQuantity(divideQuantity(String(line.unitPrice || "0"), factor), 18, "half_up"));
      // فئة مخزون: debit the CATEGORY's own inventory account instead of the
      // warehouse-derived one (stock movement below is identical either way).
      const invRouting = groupRoutingForItem(line.itemId);
      if (invRouting && invRouting.type === "inventory") {
        const ik = accCcKey(invRouting.accountId, line);
        groupInvByAccount[ik] = (groupInvByAccount[ik] ?? 0) + cost;
        (groupInvItemNamesByAccount[ik] ??= []).push(line.itemName ?? `صنف #${line.itemId}`);
        groupInvTotal += cost;
      } else {
        inventoryByWarehouse[whCcKey(line)] = (inventoryByWarehouse[whCcKey(line)] ?? 0) + cost;
      }

      if (grnSourced) continue;

      await upsertBalance(cid, line.itemId, line.warehouseId, qty, costUnit);
      costRefreshItemIds.add(line.itemId);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      await addStockLedgerEntry({
        companyId:   cid,
        itemId:      line.itemId,
        warehouseId: line.warehouseId,
        txDate:      inv.invoiceDate,
        txType:      "purchase",
        qty:         String(qty),
        costPrice:   String(costUnit.toFixed(4)),
        totalCost:   String(cost.toFixed(2)),
        balanceQty:  String(newBal),
        refId:       id,
        refType:     "purchase_invoice",
        batchNumber: line.batchNumber ? String(line.batchNumber).trim() || null : null,
        expiryDate:  line.expiryDate  ? String(line.expiryDate)  : null,
        notes:       line.notes ?? undefined,
      });
    }

    // Write the new company-wide weighted-average cost back to the item master
    // so the الأصناف (items) grid shows the latest landed cost after posting.
    for (const itemId of costRefreshItemIds) {
      await refreshItemCost(cid, itemId);
    }

    // ── Create journal entry (قيد محاسبي) ──────────────────────────
    // Dr Inventory  = landed cost (goods + loaded LC expenses - discount, i.e. totalAmount - vat + discount)
    // Dr VAT Input  = vatAmount
    // Cr Supplier/Cash   = totalAmount
    // Cr Discount Earned = discountAmount
    // This formula balances even when LC expenses are loaded onto the invoice.
    const vatAmount      = Number(inv.vatAmount      || 0);
    const discountAmount = Number(inv.discountAmount || 0);
    const totalAmount    = Number(inv.totalAmount    || 0);
    const inventoryDebit = totalAmount - vatAmount + discountAmount;

    // Fallback to accounting mappings when per-invoice accounts are not set
    const mapPi = await loadMappings(cid, "purchase_invoice");
    const taxAccId      = pickAccount(inv.taxAccountId,      mapPi("purchase_invoice", "vat_input"));
    const discountAccId = pickAccount(inv.discountAccountId, mapPi("purchase_invoice", "discount"));

    // ─── LC-linked invoice: replace counterparty credit ──────────────────
    // When an invoice is tied to a Letter of Credit, the supplier was
    // already paid through the LC margin / bank transfer. So the credit
    // side becomes:
    //   Cr LC settlement account  (goods value, pre-tax, pre-expenses)
    //   Cr each LC expense account (proportional to its share)
    // This zeros-out the LC asset balance as goods are received and
    // properly reverses the expense clearing entries created on payment.
    let lcRow: any = null;
    let lcExpenseRows: any[] = [];
    if (inv.lcId) {
      const [lcr] = await db.select().from(lettersOfCreditTable)
        .where(and(eq(lettersOfCreditTable.id, inv.lcId), eq(lettersOfCreditTable.companyId, cid)));
      if (!lcr) throw new Error("الاعتماد المستندي المرتبط بالفاتورة غير موجود");
      lcRow = lcr;
      lcExpenseRows = await db.select().from(lcExpensesTable)
        .where(eq(lcExpensesTable.lcId, inv.lcId));
    }

    const counterpartyAccountId = inv.lcId
      ? (lcRow?.settlementAccountId ?? null)
      : inv.paymentType === "cash" ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? await getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : await getSupplierAccountId(cid, inv.supplierId);

    const missing: string[] = [];
    if (vatAmount > 0 && !taxAccId) missing.push("حساب الضرائب (مدخلات)");
    if (discountAmount > 0 && !discountAccId) missing.push("حساب الخصم المكتسب");
    if (!counterpartyAccountId) missing.push(
      inv.lcId          ? "حساب تسوية الاعتماد المستندي (يُضبط من شاشة الاعتمادات)"
      : inv.paymentType === "cash" ? "حساب الخزنة"
      : inv.paymentType === "bank" ? "الحساب البنكي"
      : "حساب المورد",
    );
    // Validate per-expense clearing accounts when posting an LC-linked invoice
    if (inv.lcId) {
      const missingExp = lcExpenseRows.filter(e => Number(e.amount) > 0 && !e.accountId)
        .map(e => e.expenseType || "—");
      if (missingExp.length) missing.push(`حساب مصروف الاعتماد لـ: ${missingExp.join("، ")}`);
    }

    // GRN-sourced invoices DEBIT Receiving Clearing instead of Inventory.
    // For non-GRN invoices, derive Inventory from each warehouse's account.
    let clearingAccId: number | null = null;
    if (grnSourced) {
      clearingAccId = await getReceivingClearingAccountId(cid);
      if (!clearingAccId) missing.push("حساب وسيط الاستلام");
    } else {
      const missingWh: string[] = [];
      for (const [key, amt] of Object.entries(inventoryByWarehouse)) {
        if (amt <= 0) continue;
        const wid = Number(key.split("|")[0]);
        if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
      }
      if (missingWh.length) missing.push(`حساب المخزون لـ: ${missingWh.join("، ")}`);
    }
    // SERVICE items must carry a cost account (e.g. مشاريع تحت التنفيذ).
    if (serviceMissing.length) missing.push(`حساب التكلفة للأصناف الخدمية: ${serviceMissing.join("، ")}`);
    if (missing.length) {
      throw new Error(`يجب تحديد الحسابات التالية قبل الترحيل: ${missing.join("، ")}`);
    }

    // Distribute landed-cost adjustment (LC expenses - discount on goods) proportionally over the warehouses,
    // so the per-warehouse inventory debits sum to inventoryDebit instead of just goods cost.
    // SERVICE lines share the landed-cost adjustment proportionally too, so the
    // ratio is taken over the COMBINED (goods + service) cost basis. Goods get
    // warehouse-inventory debits; service gets per-item cost-account debits.
    const goodsCostTotal = Object.values(inventoryByWarehouse).reduce((s, v) => s + v, 0);
    const allCostTotal   = goodsCostTotal + serviceCostTotal + groupNoStockTotal + groupInvTotal;
    const inventoryDebitByWh: Record<string, number> = {}; // keyed "warehouseId|costCenterCode"
    const serviceDebitByAccount: Record<string, number> = {};      // keyed acc|cc
    const groupNoStockDebitByAccount: Record<string, number> = {}; // keyed acc|cc
    const groupInvDebitByAccount: Record<string, number> = {};     // keyed acc|cc
    if (allCostTotal > 0) {
      const ratio = inventoryDebit / allCostTotal;
      for (const [key, amt] of Object.entries(inventoryByWarehouse)) {
        inventoryDebitByWh[key] = amt * ratio;
      }
      for (const [key, amt] of Object.entries(serviceCostByAccount)) {
        serviceDebitByAccount[key] = amt * ratio;
      }
      for (const [key, amt] of Object.entries(groupNoStockByAccount)) {
        groupNoStockDebitByAccount[key] = amt * ratio;
      }
      for (const [key, amt] of Object.entries(groupInvByAccount)) {
        groupInvDebitByAccount[key] = amt * ratio;
      }
      // Fix rounding drift so ALL debits (goods + service + category-routed)
      // exactly sum to inventoryDebit — prefer the last group/service account,
      // else the last warehouse.
      const sum = Object.values(inventoryDebitByWh).reduce((s, v) => s + v, 0)
                + Object.values(serviceDebitByAccount).reduce((s, v) => s + v, 0)
                + Object.values(groupNoStockDebitByAccount).reduce((s, v) => s + v, 0)
                + Object.values(groupInvDebitByAccount).reduce((s, v) => s + v, 0);
      const drift = inventoryDebit - sum;
      if (Math.abs(drift) > 0.001) {
        const grpNsKeys = Object.keys(groupNoStockDebitByAccount);
        const grpInvKeys = Object.keys(groupInvDebitByAccount);
        const svcKeys = Object.keys(serviceDebitByAccount);
        if (grpNsKeys.length) groupNoStockDebitByAccount[grpNsKeys[grpNsKeys.length - 1]] += drift;
        else if (grpInvKeys.length) groupInvDebitByAccount[grpInvKeys[grpInvKeys.length - 1]] += drift;
        else if (svcKeys.length) serviceDebitByAccount[svcKeys[svcKeys.length - 1]] += drift;
        else {
          const lastKey = Object.keys(inventoryDebitByWh).pop();
          if (lastKey) inventoryDebitByWh[lastKey] += drift;
        }
      }
    }
    // Industrial actuals are only non-stock expenses. Freeze the exact
    // posting-time debit basis and account, not a mutable catalog/warehouse
    // mapping or a re-derived commercial line amount. `inventoryDebit` already
    // contains document discounts and loaded costs; the same ratio used by the
    // JE therefore allocates both correctly to each immutable source line.
    const industrialFx = Number(inv.exchangeRate || "1") || 1;
    for (const line of lines) {
      const tag = normalizeIndustrialCostTag((line as any).industrialCost);
      if (!tag) continue;
      const sourceAccountId = industrialSourceAccountByLine.get(line.id)!;
      const grossSourceCost = Number(line.finalCost || line.lineTotal || 0);
      const netBaseAmount = calculateIndustrialPostedBaseAmount({
        linePostingBasis: grossSourceCost,
        totalPostingBasis: allCostTotal,
        documentPostingBasis: inventoryDebit,
        exchangeRate: industrialFx,
      });
      const frozen = industrialCostWithSourceFacts(tag, {
        netBaseAmount,
        sourceAccountId,
        quantity: Number(line.qty || 0),
        sourceCurrency: inv.currencyCode || "SAR",
        exchangeRate: industrialFx,
      });
      await (db.update(purchaseInvoiceLinesTable) as any).set({ industrialCost: frozen })
        .where(and(eq(purchaseInvoiceLinesTable.id, line.id), eq(purchaseInvoiceLinesTable.companyId, cid)));
      (line as any).industrialCost = frozen;
    }
    const servicePortionTotal = Object.values(serviceDebitByAccount).reduce((s, v) => s + v, 0)
                              + Object.values(groupNoStockDebitByAccount).reduce((s, v) => s + v, 0)
                              + Object.values(groupInvDebitByAccount).reduce((s, v) => s + v, 0);

    const desc = `قيد فاتورة مشتريات رقم ${inv.docNumber || inv.id}`;
    const [postingSupplier] = await db.select({ nameAr: suppliersTable.nameAr, nameEn: suppliersTable.nameEn })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.id, inv.supplierId), eq(suppliersTable.companyId, cid)));
    const postingSupplierName = postingSupplier?.nameAr ?? postingSupplier?.nameEn ?? "";
    const supplierLineDesc = purchaseSupplierDescription({
      supplierName: postingSupplierName,
      purchaseInvoiceNumber: inv.docNumber || inv.id,
      supplierInvoiceNumber: inv.supplierInvoiceNumber,
      supplierInvoiceDate: inv.supplierInvoiceDate,
      fallback: desc,
    });
    // SERVICE cost debits (به: حساب تكلفة الصنف الخدمي) — appended to both the
    // GRN and non-GRN debit sets. For GRN the clearing debit absorbs only the
    // GOODS slice (inventoryDebit − servicePortionTotal).
    const splitAccCc = (key: string) => {
      const sep = key.indexOf("|");
      return sep === -1
        ? { accountId: Number(key), cc: "" }
        : { accountId: Number(key.slice(0, sep)), cc: key.slice(sep + 1) };
    };
    const serviceDebitLines: JLine[] = Object.entries(serviceDebitByAccount)
      .filter(([, amt]) => amt > 0)
      .map(([key, amt]) => {
        const { accountId, cc } = splitAccCc(key);
        return {
          accountId,
          debit: amt,
          description: itemNamesWithSupplierDescription(serviceItemNamesByAccount[key] ?? [], postingSupplierName, "تكلفة صنف خدمي"),
          ...(cc ? { costCenter: cc } : {}),
        };
      });
    // فئات الأصناف debit lines: asset/expense categories (no stock) + inventory
    // categories (stock moved, debit hits the category's own account).
    const groupDebitLines: JLine[] = [
      ...Object.entries(groupNoStockDebitByAccount)
        .filter(([, amt]) => amt > 0)
        .map(([key, amt]) => {
          const { accountId, cc } = splitAccCc(key);
          return {
            accountId,
            debit: amt,
            description: itemNamesWithSupplierDescription(groupNoStockItemNamesByAccount[key] ?? [], postingSupplierName, "توجيه فئة الصنف (أصل/مصروف)"),
            ...(cc ? { costCenter: cc } : {}),
          };
        }),
      ...Object.entries(groupInvDebitByAccount)
        .filter(([, amt]) => amt > 0)
        .map(([key, amt]) => {
          const { accountId, cc } = splitAccCc(key);
          return {
            accountId,
            debit: amt,
            description: itemNamesWithSupplierDescription(groupInvItemNamesByAccount[key] ?? [], postingSupplierName, "قيمة البضاعة — حساب فئة الصنف"),
            ...(cc ? { costCenter: cc } : {}),
          };
        }),
    ];
    const debitLines: JLine[] = grnSourced
      ? [
          ...(inventoryDebit - servicePortionTotal > 0
            ? [{ accountId: clearingAccId!, debit: inventoryDebit - servicePortionTotal, description: "تسوية وسيط استلام البضاعة" }]
            : []),
          ...serviceDebitLines,
          ...groupDebitLines,
        ]
      : [
          ...Object.entries(inventoryDebitByWh)
            .filter(([, amt]) => amt > 0)
            .map(([key, amt]) => {
              const [widStr, cc] = key.split("|");
              const wid = Number(widStr);
              return {
                accountId: whInfo[wid]!.accountId!,
                debit: amt,
                description: `قيمة البضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
                // Per-line cost center (optional) — "" falls back to header via createJournalEntry.
                ...(cc ? { costCenter: cc } : {}),
              };
            }),
          ...serviceDebitLines,
          ...groupDebitLines,
        ];
    // Build credit lines. For LC-linked invoices, split the credit:
    //   - Goods portion → LC settlement account (clears the LC asset)
    //   - Expenses portion → each LC expense's clearing account
    //     (proportional to the original expense amounts; in invoice currency
    //     so the entry stays balanced)
    const expensesLoaded = Number(inv.totalExpensesLoaded || 0);
    // Credits must sum to (totalAmount + discountAmount) to balance debits
    // (= inventoryDebit + vatAmount). We credit `expensesLoaded` to the LC
    // expense clearing accounts and `discountAmount` to discount-earned, so
    // the LC settlement account absorbs the rest:
    //   goodsPortion = totalAmount - expensesLoaded
    // This is the slice of the invoice the LC actually paid on behalf of the
    // buyer (goods value plus any VAT charged by the foreign supplier — for
    // typical KSA imports the supplier VAT is zero and this collapses to pure
    // goods value). Using the same value for `recomputeLcUsage` keeps the LC
    // settlement account perfectly zero when the LC is fully drawn.
    const goodsPortion = totalAmount - expensesLoaded;
    // Guard: invoice carries loaded expenses but the LC has no expense rows
    // to credit against → JE would be unbalanced. Block with a clear message.
    if (expensesLoaded > 0 && lcExpenseRows.length === 0) {
      return res.status(400).json({
        error: "هذه الفاتورة تحتوي مصاريف اعتماد محمّلة (totalExpensesLoaded > 0) لكن الاعتماد المستندي لا يتضمن أي بنود مصاريف. أضف بنود المصاريف للاعتماد قبل الترحيل.",
      });
    }
    const creditLines: JLine[] = [];
    if (inv.lcId) {
      // Cr LC settlement account (goods portion)
      creditLines.push({
        accountId: counterpartyAccountId,
        credit: goodsPortion,
        description: `تسوية اعتماد مستندي رقم ${lcRow?.lcNumber ?? inv.lcId}`,
      });
      // Cr each LC expense's clearing account, proportional to its share
      const totalExpOrig = lcExpenseRows.reduce(
        (s, e) => s + (Number(e.amount) || 0) * (Number(e.exchangeRate) || 1),
        0,
      );
      if (expensesLoaded > 0 && totalExpOrig > 0) {
        let runningSum = 0;
        const expCredits = lcExpenseRows.map((e, idx) => {
          const baseAmt = (Number(e.amount) || 0) * (Number(e.exchangeRate) || 1);
          const share   = baseAmt / totalExpOrig;
          let portion   = +(expensesLoaded * share).toFixed(2);
          // Drift fix on last row so credits sum exactly to expensesLoaded
          if (idx === lcExpenseRows.length - 1) portion = +(expensesLoaded - runningSum).toFixed(2);
          runningSum += portion;
          return { accountId: e.accountId as number, credit: portion, description: `تسوية مصروف اعتماد — ${e.expenseType ?? ""}` };
        }).filter(l => l.credit > 0);
        creditLines.push(...expCredits);
      }
      creditLines.push({ accountId: discountAccId, credit: discountAmount, description: "خصم مكتسب" });
    } else if (inv.paymentType === "cash" || inv.paymentType === "bank") {
      // CASH/BANK invoices pass through the supplier's AP account so كشف حساب
      // المورد shows BOTH legs (الاستحقاق ثم السداد) instead of nothing:
      //   Cr supplier AP  (استحقاق الفاتورة)
      //   Dr supplier AP  (سدادها فوراً)
      //   Cr cash box / bank (خروج النقدية)
      // The two AP legs net to zero, so supplier balances are unaffected.
      // If the supplier has no ledger account, fall back to the old direct credit.
      const supplierApAccId = await getSupplierAccountId(cid, inv.supplierId);
      if (supplierApAccId) {
        creditLines.push(
          { accountId: supplierApAccId, credit: totalAmount, description: supplierLineDesc },
          { accountId: supplierApAccId, debit:  totalAmount, description: supplierLineDesc } as JLine,
          { accountId: counterpartyAccountId, credit: totalAmount, description: inv.paymentType === "cash" ? "صرف نقدي" : desc },
          { accountId: discountAccId, credit: discountAmount, description: "خصم مكتسب" },
        );
      } else {
        creditLines.push(
          { accountId: counterpartyAccountId, credit: totalAmount, description: inv.paymentType === "cash" ? "صرف نقدي" : desc },
          { accountId: discountAccId, credit: discountAmount, description: "خصم مكتسب" },
        );
      }
    } else {
      creditLines.push(
        { accountId: counterpartyAccountId,  credit: totalAmount,    description: supplierLineDesc },
        { accountId: discountAccId,          credit: discountAmount, description: "خصم مكتسب" },
      );
    }

    const journalId = await createJournalEntry({
      companyId:    cid,
      audit:        { req },
      branchId:     inv.branchId,
      date:         inv.invoiceDate,
      docNumber:    inv.docNumber,
      description:  desc,
      entryType:    "purchase_invoice",
      sourceType:   "purchase_invoice",
      sourceId:     inv.id,
      exchangeRate: inv.exchangeRate,
      // Header-level cost center tags every JE line for cost-center reports.
      costCenter:   (inv as any).costCenter ?? null,
      lines: [
        ...debitLines,
        { accountId: taxAccId, debit: vatAmount, description: "ضريبة القيمة المضافة", costCenter: null },
        ...creditLines,
      ],
    });

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({
        status: "posted",
        journalEntryId: journalId,
        postedById: (req as any).authUser?.id ?? null,
        postedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();

    // Auto-update LC usedAmount + status based on this newly-posted invoice
    if (inv.lcId) await recomputeLcUsage(cid, inv.lcId);

    // ── مصروف يوزع على فترات: create ONE linked accounting adjustment per
    // deferred line. The prepaid asset was already debited above (category
    // account); the adjustment amortizes it: DR expense / CR prepaid on the
    // anniversary schedule (periodicity-aware, optional multi-CC split).
    // Net-of-VAT/discount basis: the adjustment must amortize EXACTLY what was
    // debited to the prepaid account in the JE above — i.e. the line's share
    // of inventoryDebit (totalAmount − VAT + doc discount, LC expenses
    // included). p.total is the GROSS line figure (finalCost/lineTotal is
    // VAT-inclusive when priceIncludesVat, and ignores the document
    // discount), so we scale it by the SAME ratio the JE debit used.
    const deferredNetRatio = allCostTotal > 0 ? inventoryDebit / allCostTotal : 1;
    for (const p of deferredPlans) {
      // Idempotency belt-and-braces (in addition to the process-local post
      // lock): a line that already carries a linked adjustment is skipped so
      // a retried/duplicated post can never mint a second adjustment.
      if (p.line?.deferredAdjustmentId) continue;
      const netTotal = +(p.total * deferredNetRatio).toFixed(2);
      if (netTotal <= 0) continue;
      const monthsCount = installmentsBetween(p.start, p.end, "monthly").length;
      const monthly = +(netTotal / monthsCount).toFixed(2);
      const [adj] = await db.insert(accountingAdjustmentsTable).values({
        companyId:        cid,
        type:             "prepaid",
        name:             `مصروف مرحّل — ${p.itemName} (فاتورة ${inv.docNumber || inv.id})`,
        expenseAccountId: p.expenseAccountId,
        contraAccountId:  p.contraAccountId,
        totalAmount:      String(netTotal.toFixed(2)),
        startDate:        p.start,
        endDate:          p.end,
        monthlyAmount:    String(monthly),
        periodicity:      p.periodicity,
        sourceType:       "purchase_invoice",
        sourceId:         inv.id,
        costCenterSplit:  p.ccSplit ?? null,
        autoGenerate:     true,
        status:           "active",
        notes:            `مُنشأ تلقائياً من ترحيل فاتورة المشتريات #${inv.id}`,
      }).returning();
      if (p.line?.id && adj) {
        await db.update(purchaseInvoiceLinesTable)
          .set({ deferredAdjustmentId: adj.id })
          .where(and(eq(purchaseInvoiceLinesTable.id, p.line.id), eq(purchaseInvoiceLinesTable.companyId, cid)));
      }
    }

    // ── Auto-run the deferred adjustments right after posting (نفس شغل
    // "تشغيل التسويات المستحقة"): the user must NOT need to visit the
    // adjustments screen to generate/post the due monthly entries.
    // Repost case first: an unpost→edit→repost cycle left the previously
    // generated periodic JEs as DRAFTS that KEPT their docNumbers — flip
    // them back to posted BEFORE running the engine so only those legacy
    // drafts are flipped (newly generated months keep honoring the
    // company's auto-post setting inside runDueAdjustmentsForCompany).
    const adjustmentRunWarnings: string[] = [];
    {
      const sourceLinkedAdjs = await db.select({ id: accountingAdjustmentsTable.id, name: accountingAdjustmentsTable.name, status: accountingAdjustmentsTable.status })
        .from(accountingAdjustmentsTable)
        .where(and(
          eq(accountingAdjustmentsTable.companyId, cid),
          eq(accountingAdjustmentsTable.sourceType, "purchase_invoice"),
          eq(accountingAdjustmentsTable.sourceId, inv.id),
        ));
      if (sourceLinkedAdjs.length) {
        // Only adjustments STILL referenced by a current invoice line are
        // reactivated/run. An unpost→edit cycle that removed a deferred line
        // leaves its adjustment source-linked but line-orphaned — running it
        // would keep posting a plan the user deleted, so orphans get
        // CANCELLED instead (rows + their draft run JEs stay for audit).
        const lineLinked = await db.select({ adjId: purchaseInvoiceLinesTable.deferredAdjustmentId })
          .from(purchaseInvoiceLinesTable)
          .where(and(
            eq(purchaseInvoiceLinesTable.invoiceId, inv.id),
            sql`${purchaseInvoiceLinesTable.deferredAdjustmentId} IS NOT NULL`,
          ));
        const lineLinkedIds = new Set(lineLinked.map(r => r.adjId).filter((x): x is number => typeof x === "number"));
        const activeIds = sourceLinkedAdjs.filter(a => lineLinkedIds.has(a.id)).map(a => a.id);
        const orphanIds = sourceLinkedAdjs.filter(a => !lineLinkedIds.has(a.id) && a.status !== "cancelled").map(a => a.id);
        if (orphanIds.length) {
          await db.update(accountingAdjustmentsTable)
            .set({ status: "cancelled", autoGenerate: false, updatedAt: new Date() })
            .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, orphanIds)));
          req.log?.warn({ invoiceId: inv.id, orphanIds }, "post-invoice: cancelled line-orphaned deferred adjustments");
        }
        if (activeIds.length) {
          // Unfreeze: unpost set autoGenerate=false to keep the hourly
          // scheduler away while the invoice was a draft — restore it now.
          await db.update(accountingAdjustmentsTable)
            .set({ autoGenerate: true, updatedAt: new Date() })
            .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, activeIds)));
          const runRows = await db.select({ jeId: accountingAdjustmentRunsTable.journalEntryId })
            .from(accountingAdjustmentRunsTable)
            .where(inArray(accountingAdjustmentRunsTable.adjustmentId, activeIds));
          const runJeIds = runRows.map(r => r.jeId).filter((x): x is number => typeof x === "number");
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
              req.log?.warn({ adjId, err: err?.message }, "post-invoice: auto-run adjustment failed");
              const nm = sourceLinkedAdjs.find(a => a.id === adjId)?.name || `#${adjId}`;
              adjustmentRunWarnings.push(`تعذّر توليد/ترحيل قيود التسوية «${nm}»: ${err?.message || "خطأ غير معروف"}`);
            }
          }
        }
      }
    }

    res.json(adjustmentRunWarnings.length ? { ...updated, adjustmentRunWarnings } : updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
  finally { if (__lockKey) __postingLocks.delete(__lockKey); }
});

// ─── UNPOST purchase invoice (فك الترحيل) ───────────────────────────────────
// Reverses stock movements, zeroes-out the journal entry lines (audit trail),
// then deletes the JE and sets the invoice back to draft.
router.patch("/purchase-invoices/:id/unpost", requireUnpostRight("purchase"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status !== "posted") { res.status(400).json({ error: "الفاتورة ليست مُرحَّلة" }); return; }
    const industrialLines = await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id));
    await assertIndustrialCostPeriodsWritable(cid, industrialLines);

    // ── Fixed-asset linkage guard: an invoice that spawned a LIVE fixed-asset
    // card cannot be unposted (the asset's cost basis would point at a void
    // document). The user must dispose/delete the asset first. sold/scrapped
    // assets no longer depend on the acquisition document.
    const linkedAssets = await db.select({ id: fixedAssetsTable.id, code: fixedAssetsTable.code })
      .from(fixedAssetsTable)
      .where(and(
        eq(fixedAssetsTable.companyId, cid),
        eq(fixedAssetsTable.sourceType, "purchase_invoice"),
        eq(fixedAssetsTable.sourceDocumentId, id),
        notInArray(fixedAssetsTable.status, ["sold", "scrapped"]),
      )).limit(1);
    if (linkedAssets.length) {
      res.status(409).json({ error: `لا يمكن إلغاء الترحيل: يوجد أصل ثابت مرتبط بهذه الفاتورة (${linkedAssets[0].code}) — قم باستبعاد الأصل أو حذفه أولاً` });
      return;
    }

    // ── مصروف يوزع على فترات guard: adjustments spawned by this invoice.
    // If ANY linked adjustment already generated periodic JEs (runs exist),
    // unposting would orphan real GL entries → block with 409. Otherwise the
    // run-less adjustments are deleted (re-posting recreates them fresh).
    const linkedAdjs = await db.select({ id: accountingAdjustmentsTable.id, name: accountingAdjustmentsTable.name })
      .from(accountingAdjustmentsTable)
      .where(and(
        eq(accountingAdjustmentsTable.companyId, cid),
        eq(accountingAdjustmentsTable.sourceType, "purchase_invoice"),
        eq(accountingAdjustmentsTable.sourceId, id),
      ));
    if (linkedAdjs.length) {
      const adjIds = linkedAdjs.map(a => a.id);
      const runRows = await db.select({ adjustmentId: accountingAdjustmentRunsTable.adjustmentId })
        .from(accountingAdjustmentRunsTable)
        .where(inArray(accountingAdjustmentRunsTable.adjustmentId, adjIds))
        .limit(1);
      if (runRows.length) {
        // Runs exist → do NOT block and do NOT delete anything. Flip every
        // generated periodic JE to DRAFT while KEEPING its docNumber and its
        // run row (per explicit user requirement: the JE sequence must be
        // preserved across an unpost→edit→repost cycle). The adjustments and
        // the line links are kept too, so re-posting the invoice never mints
        // duplicates — it just flips these drafts back to posted.
        const allRuns = await db.select({ jeId: accountingAdjustmentRunsTable.journalEntryId })
          .from(accountingAdjustmentRunsTable)
          .where(inArray(accountingAdjustmentRunsTable.adjustmentId, adjIds));
        const runJeIds = allRuns.map(r => r.jeId).filter((x): x is number => typeof x === "number");
        if (runJeIds.length) {
          await db.update(journalEntriesTable)
            .set({ status: "draft", updatedAt: new Date() })
            .where(and(
              eq(journalEntriesTable.companyId, cid),
              inArray(journalEntriesTable.id, runJeIds),
            ));
        }
        // Freeze the engines while the invoice sits as a draft: the hourly
        // adj-auto scheduler would otherwise keep generating+posting NEW
        // months for these adjustments. Re-posting restores autoGenerate
        // for the line-linked ones before it calls the run engine.
        await db.update(accountingAdjustmentsTable)
          .set({ autoGenerate: false, updatedAt: new Date() })
          .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, adjIds)));
      } else {
        // Run-less adjustments are safe to delete — re-posting recreates
        // them fresh from the (possibly edited) line plans.
        await db.update(purchaseInvoiceLinesTable)
          .set({ deferredAdjustmentId: null })
          .where(and(eq(purchaseInvoiceLinesTable.invoiceId, id), inArray(purchaseInvoiceLinesTable.deferredAdjustmentId, adjIds)));
        await db.delete(accountingAdjustmentsTable)
          .where(and(eq(accountingAdjustmentsTable.companyId, cid), inArray(accountingAdjustmentsTable.id, adjIds)));
      }
    }

    // GRN-sourced invoices never touched stock (the GRN did), so there's
    // nothing in the stock ledger under refType=purchase_invoice for them
    // — the loop below is a safe no-op in that case but we short-circuit
    // to make the intent obvious.
    const grnSourced = !!(inv as any).sourceGrnId;

    // ── Reverse stock movements (delete ledger rows + decrement balances) ──
    const ledger = grnSourced ? [] : await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_invoice"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty);
      // Reverse: subtract the qty that was added (cost stays at current avg)
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
    if (!grnSourced) {
      await db.delete(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "purchase_invoice"),
          eq(stockLedgerTable.refId, id),
        ));
    }

    // ── Zero-out the JE lines, then delete the JE ──
    if (inv.journalEntryId) {
      // Stash this JE's number so the next re-post reuses it (no gap).
      await reserveJeNumberFromEntry(cid, "purchase_invoice", id, inv.journalEntryId);
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, inv.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({ status: "draft", journalEntryId: null, postedById: null, postedAt: null, updatedAt: new Date() })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();

    // Reverse LC consumption when an LC-linked invoice is unposted
    if (inv.lcId) await recomputeLcUsage(cid, inv.lcId);

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف فاتورة مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    // Block deletion when purchase returns reference this invoice (FK has no
    // cascade). Tell the user clearly which returns to remove first.
    const relatedReturns = await db.select({
      id: purchaseReturnsTable.id, docNumber: purchaseReturnsTable.docNumber,
    }).from(purchaseReturnsTable).where(and(
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.invoiceId, id),
    )).limit(5);
    if (relatedReturns.length) {
      const refs = relatedReturns.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها مرتبطة بمرتجع/مرتجعات مشتريات: ${refs}. يرجى حذف المرتجع أولاً.` });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "purchase_invoice", refId: id, journalEntryId: (inv as any).journalEntryId });

    // If this draft invoice was created from a GRN, restore the GRN to
    // posted (un-link it) so the user can re-issue an invoice or unpost
    // the GRN itself. Without this, a deleted draft would leave the GRN
    // permanently stuck in "invoiced" status.
    const grnId = (inv as any).sourceGrnId as number | null | undefined;
    if (grnId) {
      await db.update(goodsReceiptsTable)
        .set({ status: "posted", linkedInvoiceId: null, updatedAt: new Date() })
        .where(and(eq(goodsReceiptsTable.id, grnId), eq(goodsReceiptsTable.companyId, cid)));
    }

    // If this invoice was created by converting a purchase order, snap that
    // PO back to "confirmed" and clear its convertedInvoiceId so it doesn't
    // dangle pointing at a non-existent invoice. Without this fix the source
    // PO is stuck in "converted" forever (status badge shows "محوّلة") even
    // though no real invoice exists, blocking unconfirm / re-convert.
    const sourcePOs = await db.select({ id: purchaseOrdersTable.id })
      .from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.companyId, cid),
        eq(purchaseOrdersTable.convertedInvoiceId, id),
      ));
    if (sourcePOs.length) {
      await db.update(purchaseOrdersTable)
        .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
        .where(and(
          eq(purchaseOrdersTable.companyId, cid),
          eq(purchaseOrdersTable.convertedInvoiceId, id),
        ));
    }

    await db.delete(purchaseInvoicesTable).where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    res.json({ ok: true, restoredPurchaseOrderIds: sourcePOs.map(p => p.id) });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// One-shot self-heal endpoint: scans for purchase orders stuck in
// status="converted" whose convertedInvoiceId no longer points to a real
// purchase invoice (the invoice was deleted before the fix above shipped),
// and snaps them back to "confirmed". Idempotent — safe to call repeatedly.
router.post("/purchase-orders/heal-orphan-converted", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const candidates = await db.select({
      id: purchaseOrdersTable.id,
      convertedInvoiceId: purchaseOrdersTable.convertedInvoiceId,
    }).from(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.companyId, cid),
      eq(purchaseOrdersTable.status, "converted"),
    ));
    const orphanIds: number[] = [];
    for (const po of candidates) {
      if (!po.convertedInvoiceId) { orphanIds.push(po.id); continue; }
      const [inv] = await db.select({ id: purchaseInvoicesTable.id })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.id, po.convertedInvoiceId),
          eq(purchaseInvoicesTable.companyId, cid),
        ));
      if (!inv) orphanIds.push(po.id);
    }
    if (orphanIds.length) {
      await db.update(purchaseOrdersTable)
        .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
        .where(and(
          eq(purchaseOrdersTable.companyId, cid),
          inArray(purchaseOrdersTable.id, orphanIds),
        ));
    }
    res.json({ healed: orphanIds.length, orderIds: orphanIds });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE ORDERS — operational, FINANCE-FREE
// ═══════════════════════════════════════════════
// Purchase orders mirror purchase invoices for items / supplier / branch /
// totals but are intentionally INERT financially:
//   • POST / PUT / PATCH (status) / DELETE never write a journal entry, never
//     move stock, never settle a supplier balance, never create a voucher.
//   • Only POST /purchase-orders/:id/convert spawns a DRAFT purchase invoice
//     (which still needs to be posted separately to incur any finance impact).
//   • Status flow: draft → confirmed | cancelled, then confirmed → converted
//     (only via /convert; the status PATCH refuses "converted" directly).
//   • Once converted or cancelled, the order is locked against PUT/DELETE.
router.get("/purchase-orders", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }

    // Auto-heal orphan "converted" rows: any PO whose convertedInvoiceId is
    // NULL or points to a deleted purchase invoice gets snapped back to
    // "confirmed" before the listing is returned. Cheap, idempotent — no
    // user action required, fixes legacy rows on first page load.
    const stuck = await db.select({
      id: purchaseOrdersTable.id,
      convertedInvoiceId: purchaseOrdersTable.convertedInvoiceId,
    }).from(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.companyId, cid),
      eq(purchaseOrdersTable.status, "converted"),
    ));
    if (stuck.length) {
      const refIds = Array.from(new Set(stuck.map(s => s.convertedInvoiceId).filter((v): v is number => v != null)));
      const liveInvIds = new Set<number>();
      if (refIds.length) {
        const live = await db.select({ id: purchaseInvoicesTable.id })
          .from(purchaseInvoicesTable)
          .where(and(
            eq(purchaseInvoicesTable.companyId, cid),
            inArray(purchaseInvoicesTable.id, refIds),
          ));
        live.forEach(r => liveInvIds.add(r.id));
      }
      const orphanIds = stuck
        .filter(s => s.convertedInvoiceId == null || !liveInvIds.has(s.convertedInvoiceId))
        .map(s => s.id);
      if (orphanIds.length) {
        await db.update(purchaseOrdersTable)
          .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
          .where(and(
            eq(purchaseOrdersTable.companyId, cid),
            inArray(purchaseOrdersTable.id, orphanIds),
          ));
      }
    }

    const rows = await db.select().from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.companyId, cid),
        ...branchScopeSpread(req, purchaseOrdersTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(purchaseOrdersTable.orderDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [ord] = await db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    const lines = await db.select().from(purchaseOrderLinesTable)
      .where(eq(purchaseOrderLinesTable.orderId, id))
      .orderBy(asc(purchaseOrderLinesTable.id));
    res.json({ ...ord, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-orders", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, orderDate, expectedDeliveryDate,
            supplierId, branchId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount,
            notes, lines, priceIncludesVat, taxId } = req.body;
    if (!orderDate)  { res.status(400).json({ error: "تاريخ الأمر مطلوب" }); return; }
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد" }); return; }
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "purchase_orders", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }

    // Sequence engine authoritative (see purchase_invoice note above): consume
    // it first and ignore the peeked client docNumber, else every order reuses
    // the same previewed number.
    let resolvedDocNumber: string | null = null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "purchase_order", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_orders",
        branchId: branchId ? Number(branchId) : null,
        docDate:  orderDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الأمر" });
      return;
    }

    const [ord] = await db.insert(purchaseOrdersTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: Number(supplierId),
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft",
      notes: notes || null,
      taxId: taxId ? Number(taxId) : null,
    }).returning();
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      const mappedLines = await resolvePurchaseLineUnits(
        cid,
        lines.map((l: any) => ({
          orderId: ord.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
          weight: String(l.weight || "0"), unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
          vatRate: String(l.vatRate || resolvedRate), lineTotal: String(l.lineTotal || "0"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null, notes: l.notes || null,
        })),
        lines,
      );
      await db.insert(purchaseOrderLinesTable).values(
        mappedLines
      );
    }
    res.status(201).json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (existing.status === "converted" || existing.status === "cancelled") {
      res.status(409).json({ error: "لا يمكن تعديل أمر شراء محوّل أو ملغي" });
      return;
    }
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, orderDate, expectedDeliveryDate,
            supplierId, branchId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount,
            notes, lines, priceIncludesVat, taxId } = req.body;
    if (!orderDate)  { res.status(400).json({ error: "تاريخ الأمر مطلوب" }); return; }
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد" }); return; }
    const [ord] = await db.update(purchaseOrdersTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: Number(supplierId),
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null, updatedAt: new Date(),
      taxId: taxId ? Number(taxId) : null,
    }).where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid))).returning();
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (lines !== undefined) {
      const previousLines = await db.select().from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.orderId, id));
      await db.delete(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.orderId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        const mappedLines = await resolvePurchaseLineUnits(
          cid,
          lines.map((l: any) => ({
            orderId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
            weight: String(l.weight || "0"), unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            discountAmount: String(Math.max(0, Number(l.discountAmount) || 0)),
            vatRate: String(l.vatRate || resolvedRate), lineTotal: String(l.lineTotal || "0"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null, notes: l.notes || null,
          })),
          lines,
          previousLines,
        );
        await db.insert(purchaseOrderLinesTable).values(
          mappedLines
        );
      }
    }
    res.json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/purchase-orders/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body as { status?: string };
    // The /convert endpoint is the ONLY way to land in "converted". This
    // PATCH is for user-driven workflow transitions (confirm / cancel).
    const allowed = ["draft", "confirmed", "cancelled"] as const;
    if (!status || !allowed.includes(status as any)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    const [existing] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (existing.status === "converted") {
      res.status(409).json({ error: "تم تحويل الأمر إلى فاتورة بالفعل" }); return;
    }
    const [ord] = await db.update(purchaseOrdersTable)
      .set({ status: status as any, updatedAt: new Date() })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)))
      .returning();
    res.json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-orders/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const conversion = await db.transaction(async (tx) => {
      // Lock before reading status/link so concurrent conversion requests
      // serialize on this source order. The invoice and its lines are then
      // committed with the state transition, or all rolled back together.
      await tx.execute(sql`
        SELECT id
        FROM purchase_orders
        WHERE id = ${id} AND company_id = ${cid}
        FOR UPDATE
      `);
      const [ord] = await tx.select().from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
      if (!ord) throw Object.assign(new Error("أمر الشراء غير موجود"), { status: 404 });
      if (ord.status !== "confirmed") {
        throw Object.assign(new Error("يجب تأكيد الأمر قبل تحويله إلى فاتورة"), { status: 409 });
      }
      if (ord.convertedInvoiceId) {
        throw Object.assign(new Error("تم تحويل الأمر إلى فاتورة بالفعل"), { status: 409 });
      }
      const lines = await tx.select().from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.orderId, id),
        eq(purchaseOrderLinesTable.companyId, cid),
      ))
      .orderBy(asc(purchaseOrderLinesTable.id));
      await assertPurchaseWriteReferences(cid, {
        supplierId: ord.supplierId,
        branchId: ord.branchId,
        taxId: (ord as any).taxId,
        lines,
      }, tx);

    // Issue a NEW invoice docNumber from the purchase_invoice sequence
    // (independent counter — orders and invoices have separate sequences).
    // Normalise the payment type BEFORE issuing the number so the doc number's
    // payment-split series matches the payment type the invoice is persisted
    // with (legacy/null order paymentType persists as "credit" below — the
    // sequence must resolve purchase_invoice_credit, not the base series).
    const pType = ord.paymentType || "credit";

    let invDocNumber: string | null = null;
    try {
      const allocateInvoiceNumber = () => nextSequenceForPayment(cid, "purchase_invoice", pType, {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_invoices",
        branchId: ord.branchId ?? null,
        docDate:  ord.orderDate ?? null,
      });
      invDocNumber = await allocateInvoiceNumber();
      for (let skipped = 0; invDocNumber != null; skipped += 1) {
        const duplicate = await tx.select({ id: purchaseInvoicesTable.id })
          .from(purchaseInvoicesTable)
          .where(and(
            eq(purchaseInvoicesTable.companyId, cid),
            eq(purchaseInvoicesTable.docNumber, invDocNumber),
          ))
          .limit(1);
        if (!duplicate.length) break;
        if (skipped >= 999) throw new Error("تعذر الوصول إلى رقم فاتورة شراء غير مستخدم بعد الاستعادة");
        invDocNumber = await allocateInvoiceNumber();
      }
    } catch (seqErr: any) {
      throw Object.assign(
        new Error(seqErr?.message ?? "تعذر توليد رقم الفاتورة"),
        { status: 400 },
      );
    }

    // Currency conversion: when the PO is in a foreign currency, materialise
    // the resulting purchase invoice in the company's BASE currency by
    // multiplying every monetary field by the PO's exchange rate. The
    // resulting invoice carries currencyCode=base / exchangeRate=1 so all
    // downstream reports, JEs, and totals show base-currency values
    // (e.g. PO 100 USD × 3.75 ⇒ invoice subtotal 375 SAR).
    const baseCurrency = await getBaseCurrencyCode(cid, tx);
    const fxRate = Number(ord.exchangeRate ?? "1") || 1;
    const isForeign = !!ord.currencyCode && ord.currencyCode !== baseCurrency && fxRate !== 1;
    const conv = (v: any): string => {
      const n = Number(v ?? "0");
      if (!isForeign) return String(v ?? "0");
      // Round to 4 dp on line-level fields, 2 dp on totals — but use a single
      // rounding here (4 dp) and let the form's display format handle the rest.
      return (n * fxRate).toFixed(4);
    };

    const inv = await insertPurchaseInvoiceWithSerialRepair({
      companyId: cid,
      branchId: ord.branchId ?? null,
      docNumber: invDocNumber,
      supplierInvoiceNumber: ord.supplierInvoiceNumber ?? null,
      invoiceDate: ord.orderDate,
      supplierId: ord.supplierId,
      // Carry the payment-type intent over but DO NOT auto-pick cash/bank
      // accounts here — those are operator choices made when posting.
      paymentType: pType,
      cashBoxId: null,
      bankAccountId: null,
      currencyCode: isForeign ? baseCurrency : ord.currencyCode,
      exchangeRate: isForeign ? "1" : ord.exchangeRate,
      lcId: null,
      distributionMethod: "value",
      subtotal: conv(ord.subtotal),
      vatAmount: conv(ord.vatAmount),
      discountAmount: conv(ord.discountAmount),
      totalExpensesLoaded: "0",
      totalAmount: conv(ord.totalAmount),
      priceIncludesVat: ord.priceIncludesVat,
      status: "draft",
      notes: isForeign
        ? [ord.notes, `(محوَّل من أمر شراء بعملة ${ord.currencyCode} بسعر صرف ${fxRate} ⇒ ${baseCurrency})`].filter(Boolean).join("\n")
        : ord.notes,
      createdById: req.authUser?.id ?? null,
      taxId: (ord as any).taxId ?? null,
    }, tx);
    if (lines.length) {
      await tx.insert(purchaseInvoiceLinesTable).values(
        lines.map(l => ({
          invoiceId: inv.id, companyId: cid,
          itemId: l.itemId, itemName: l.itemName, itemCode: l.itemCode,
          unit: l.unit, unitId: l.unitId,
          conversionFactor: l.conversionFactor ?? "1",
          qty: l.qty, freeQty: l.freeQty ?? "0", weight: l.weight ?? "0",
          unitPrice: conv(l.unitPrice),
          discount: conv(l.discount ?? "0"),
          vatRate: l.vatRate ?? "15",
          lineTotal: conv(l.lineTotal),
          expenseShare: "0",
          finalCost: "0",
          accountId: null,
          warehouseId: l.warehouseId,
          notes: l.notes,
        }))
      );
    }

    const updatedOrder = await tx.update(purchaseOrdersTable)
      .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
      .where(and(
        eq(purchaseOrdersTable.id, id),
        eq(purchaseOrdersTable.companyId, cid),
        eq(purchaseOrdersTable.status, "confirmed"),
        isNull(purchaseOrdersTable.convertedInvoiceId),
      ))
      .returning({ id: purchaseOrdersTable.id });
    if (!updatedOrder.length) {
      throw Object.assign(new Error("تم تحويل الأمر إلى فاتورة بالفعل"), { status: 409 });
    }
    return { invoice: inv };
    });

    res.status(201).json({ orderId: id, invoiceId: conversion.invoice.id, invoice: conversion.invoice });
  } catch (e: any) {
    logger.error({ err: e }, "purchase order conversion failed");
    const friendly = purchasingWriteError(e, "فاتورة الشراء المحوّلة");
    res.status(friendly.status).json({ error: friendly.message });
  }
});

router.delete("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ord] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    // Mirror PUT/edit lock: orders that are no longer in a mutable state
    // (converted to an invoice, or explicitly cancelled) cannot be deleted.
    // Cancelled rows stay around as an audit trail of the cancellation.
    if (ord.status === "converted") {
      res.status(409).json({ error: "لا يمكن حذف أمر شراء محوّل إلى فاتورة" });
      return;
    }
    if (ord.status === "cancelled") {
      res.status(409).json({ error: "لا يمكن حذف أمر شراء ملغي" });
      return;
    }
    await db.delete(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.orderId, id));
    await db.delete(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE RETURNS
// ═══════════════════════════════════════════════
router.get("/purchase-returns", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseReturnsTable)
      .where(and(
        eq(purchaseReturnsTable.companyId, cid),
        ...multiBranchScopeSpread(req, purchaseReturnsTable.branchId, req.query.branchIds ?? req.query.branchId),
      ))
      .orderBy(desc(purchaseReturnsTable.returnDate));
    // Σ effective per-line discount per return so the audit grid can show a real
    // total-discount column (document + line); list rows only carry the
    // document-level discountAmount otherwise.
    const ids = rows.map(r => r.id);
    const lineDiscByReturn = new Map<number, number>();
    if (ids.length > 0) {
      const { inArray } = await import("drizzle-orm");
      const rlines = await db.select({
        returnId:       purchaseReturnLinesTable.returnId,
        qty:            purchaseReturnLinesTable.qty,
        unitPrice:      purchaseReturnLinesTable.unitPrice,
        discount:       purchaseReturnLinesTable.discount,
        discountAmount: purchaseReturnLinesTable.discountAmount,
      }).from(purchaseReturnLinesTable).where(inArray(purchaseReturnLinesTable.returnId, ids));
      for (const l of rlines) {
        if (!l.returnId) continue;
        const gross = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
        const amt   = Math.max(0, Number(l.discountAmount) || 0);
        const eff   = amt > 0
          ? Math.min(amt, gross)
          : (gross * Math.max(0, Math.min(100, Number(l.discount) || 0))) / 100;
        lineDiscByReturn.set(l.returnId, (lineDiscByReturn.get(l.returnId) ?? 0) + eff);
      }
    }
    res.json(rows.map(r => ({ ...r, lineDiscountTotal: (lineDiscByReturn.get(r.id) ?? 0).toFixed(2) })));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    const id = Number(req.params.id);
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), cid ? eq(purchaseReturnsTable.companyId, cid) : sql`true`));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    const lines = await db.select().from(purchaseReturnLinesTable)
      .where(eq(purchaseReturnLinesTable.returnId, id))
      .orderBy(asc(purchaseReturnLinesTable.id));
    res.json({ ...ret, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-returns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, returnDate, supplierId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId,
            currencyCode, exchangeRate, totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, taxId, postVariance } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    await assertPurchaseWriteReferences(cid, {
      supplierId, branchId, cashBoxId, bankAccountId, taxId, invoiceId,
      lines,
    });
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "purchase_returns", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
    // Required-fields gate (per company policy): every purchase return
    // must carry an explicit supplier + branch. Tightened from the
    // older "credit-only" supplier requirement so cash/bank returns
    // also need an identified vendor for accurate supplier statements.
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد قبل حفظ المرتجع", field: "supplierId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ المرتجع",  field: "branchId"   }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند استرداد المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند استرداد المبلغ بنكياً" }); return; }
    await assertIndustrialReturnSourceLinks(db, cid, invoiceId, lines);
    // Central sequence engine is authoritative when an active sequence
    // exists for "purchase_return"; otherwise fall back to client-supplied
    // value or null. Server allocation is atomic so concurrent submits
    // can never persist the same number.
    let resolvedDocNumber: string | null;
    try {
      const allocateReturnNumber = () => nextSequenceForPayment(cid, "purchase_return", pType, {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_returns",
        branchId: branchId ? Number(branchId) : null,
        docDate:  returnDate,
      });
      let fromSeq = await allocateReturnNumber();
      for (let skipped = 0; fromSeq != null; skipped += 1) {
        const duplicate = await db.select({ id: purchaseReturnsTable.id })
          .from(purchaseReturnsTable)
          .where(and(
            eq(purchaseReturnsTable.companyId, cid),
            eq(purchaseReturnsTable.docNumber, fromSeq),
          ))
          .limit(1);
        if (!duplicate.length) break;
        if (skipped >= 999) throw new Error("تعذر الوصول إلى رقم مرتجع شراء غير مستخدم بعد الاستعادة");
        fromSeq = await allocateReturnNumber();
      }
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم المرتجع" });
      return;
    }
    const requestedReturnAccountIds = [
      inventoryAccountId, taxAccountId, discountAccountId,
    ].map(Number).filter((accountId) => Number.isInteger(accountId) && accountId > 0);
    const validReturnAccountIds = requestedReturnAccountIds.length
      ? new Set((await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
          eq(accountsTable.companyId, cid),
          inArray(accountsTable.id, [...new Set(requestedReturnAccountIds)]),
        ))).map((row) => row.id))
      : new Set<number>();
    const validReturnAccount = (value: unknown): number | null => {
      const accountId = Number(value);
      return Number.isInteger(accountId) && validReturnAccountIds.has(accountId) ? accountId : null;
    };
    const ret = await insertPurchaseReturnWithSerialRepair({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber, supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
      supplierId: supplierId ? Number(supplierId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: validReturnAccount(inventoryAccountId),
      taxAccountId:       validReturnAccount(taxAccountId),
      discountAccountId:  validReturnAccount(discountAccountId),
      taxId:              taxId ? Number(taxId) : null,
      postVariance: postVariance === true || postVariance === "true",
      status: "draft", notes: notes || null,
    });
    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      const sourceReturnLines = invoiceId
        ? await db.select().from(purchaseInvoiceLinesTable)
            .where(and(
              eq(purchaseInvoiceLinesTable.invoiceId, Number(invoiceId)),
              eq(purchaseInvoiceLinesTable.companyId, cid),
            ))
            .orderBy(asc(purchaseInvoiceLinesTable.id))
        : [];
      const mappedLines = await resolvePurchaseLineUnits(
        cid,
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || resolvedRate), lineTotal: String(l.lineTotal || "0"),
          costCenter: l.costCenter ? String(l.costCenter).trim() || null : null,
          industrialCost: normalizeIndustrialCostTag(l.industrialCost),
          notes: l.notes || null,
        })),
        lines,
        [],
        sourceReturnLines,
      );
      await db.insert(purchaseReturnLinesTable).values(
        mappedLines
      );
    }
    res.status(201).json(ret);
  } catch (e: any) {
    logger.error({ err: e }, "purchase return create failed");
    const friendly = purchasingWriteError(e, "مرتجع الشراء");
    res.status(friendly.status).json({ error: friendly.message });
  }
});

router.put("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, returnDate, supplierId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId,
            currencyCode, exchangeRate, totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, taxId, postVariance } = req.body;
    const [existing] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل مرتجع مُرحَّل. قم بفك الترحيل أولاً." }); return; }
    // Same required-fields gate as the POST path so a stale-draft PUT
    // can't strip supplier/branch off an existing purchase return.
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد قبل حفظ المرتجع", field: "supplierId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ المرتجع",  field: "branchId"   }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند استرداد المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند استرداد المبلغ بنكياً" }); return; }
    await assertPurchaseWriteReferences(cid, {
      supplierId, branchId, cashBoxId, bankAccountId, taxId, invoiceId, lines,
    });
    await assertIndustrialReturnSourceLinks(db, cid, invoiceId, lines);
    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [ret] = await db.update(purchaseReturnsTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
      supplierId: supplierId ? Number(supplierId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      // Preserve the stored flag when the field is absent (partial PUT).
      postVariance: postVariance === undefined
        ? existing.postVariance
        : (postVariance === true || postVariance === "true"),
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      taxId:              taxId ? Number(taxId) : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid))).returning();
    if (lines !== undefined) {
      const previousReturnLines = await db.select().from(purchaseReturnLinesTable)
        .where(eq(purchaseReturnLinesTable.returnId, id));
      const sourceReturnLines = invoiceId
        ? await db.select().from(purchaseInvoiceLinesTable)
            .where(and(
              eq(purchaseInvoiceLinesTable.invoiceId, Number(invoiceId)),
              eq(purchaseInvoiceLinesTable.companyId, cid),
            ))
            .orderBy(asc(purchaseInvoiceLinesTable.id))
        : [];
      await db.delete(purchaseReturnLinesTable).where(eq(purchaseReturnLinesTable.returnId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        const mappedLines = await resolvePurchaseLineUnits(
          cid,
          lines.map((l: any) => ({
            returnId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            qty: String(l.qty || "1"), freeQty: String(l.freeQty || "0"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || resolvedRate), lineTotal: String(l.lineTotal || "0"),
            costCenter: l.costCenter ? String(l.costCenter).trim() || null : null,
            industrialCost: normalizeIndustrialCostTag(l.industrialCost),
            notes: l.notes || null,
          })),
          lines,
          previousReturnLines,
          sourceReturnLines,
        );
        await db.insert(purchaseReturnLinesTable).values(
          mappedLines
        );
      }
    }
    res.json(ret);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/purchase-returns/:id/post", requirePostRight("purchase"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard: prevent cross-branch posting by ID guess.
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(
        eq(purchaseReturnsTable.id, id),
        eq(purchaseReturnsTable.companyId, cid),
        ...branchScopeSpread(req, purchaseReturnsTable.branchId, undefined),
      ));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") { res.status(400).json({ error: "المرتجع مُرحَّل مسبقاً" }); return; }

    // Source-invoice integrity check: if linked, must exist in same company.
    if (ret.invoiceId) {
      const [srcCheck] = await db
        .select({ id: purchaseInvoicesTable.id })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.id, ret.invoiceId),
          eq(purchaseInvoicesTable.companyId, cid),
        ));
      if (!srcCheck) {
        res.status(400).json({ error: "فاتورة المشتريات المصدر غير موجودة في هذه الشركة — فك ربط الفاتورة أو اختر فاتورة صحيحة." });
        return;
      }
    }

    const lines = await db.select().from(purchaseReturnLinesTable)
      .where(eq(purchaseReturnLinesTable.returnId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في المرتجع" }); return; }
    await assertIndustrialCostPeriodsWritable(cid, lines);
    await assertIndustrialReturnSourceLinks(db, cid, ret.invoiceId, lines);

    // Item Usage Control (Phase ب): block posting a doc carrying restricted items.
    {
      const usageIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "purchase_returns", usageIds, req.authUser, "post");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "post"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }

    // Item metadata (type + batch mode + cost account). SERVICE/prepaid items
    // (خدمي/مصروف مقدم) NEVER touch stock — mirrors the purchase-invoice
    // posting path: exempt from the warehouse requirement, skipped in stock
    // ops, and CREDITED to their own cost account (reversal of the invoice's
    // service-cost debit).
    const retItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
    const retItemRows = retItemIds.length
      ? await db
          .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode, type: itemsTable.itemType, costAcc: itemsTable.costAccountId })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, retItemIds)))
      : [];
    const retTypeById = new Map<number, string>();
    const retCostAccById = new Map<number, number | null>();
    for (const r of retItemRows) { retTypeById.set(r.id, (r.type ?? "stock") as string); retCostAccById.set(r.id, r.costAcc ?? null); }
    const isSvcLine = (l: any) => {
      if (!l.itemId) return false;
      const t = retTypeById.get(l.itemId);
      return t === "service" || t === "prepaid_expense";
    };

    const noWh = lines.filter(l => l.itemId && !l.warehouseId && !isSvcLine(l));
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }
    const svcNoCost = lines.filter(l => isSvcLine(l) && Number(l.unitPrice) * Number(l.qty) > 0 && !retCostAccById.get(l.itemId as number));
    if (svcNoCost.length) {
      res.status(400).json({ error: `يجب تحديد حساب التكلفة للأصناف الخدمية قبل الترحيل: ${svcNoCost.map(l => l.itemName ?? `صنف #${l.itemId}`).join("، ")}` });
      return;
    }

    // Load warehouse info (account + allow-negative)
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Validate stock availability — purchase returns ship goods OUT to the supplier.
    // Pre-aggregate required qty per (item, warehouse) so multiple lines for the
    // same item+warehouse can't each pass against the same opening balance and
    // collectively over-issue when allowNegative=false.
    {
      const reqByKey = new Map<string, { itemId: number; warehouseId: number; qty: number; itemName: string | null }>();
      for (const line of lines) {
        if (!line.itemId || !line.warehouseId || isSvcLine(line)) continue;
        const wh = whInfo[line.warehouseId];
        if (wh?.allowNegative) continue;
        const factor = String(line.conversionFactor || "1");
        const qty = Number(multiplyQuantity(String(line.qty || "0"), factor))
          + Number(multiplyQuantity(String(line.freeQty || "0"), factor));
        if (qty <= 0) continue;
        const k = `${line.itemId}|${line.warehouseId}`;
        const prev = reqByKey.get(k);
        if (prev) prev.qty += qty;
        else reqByKey.set(k, { itemId: line.itemId, warehouseId: line.warehouseId, qty, itemName: line.itemName });
      }
      for (const r of reqByKey.values()) {
        const cur = await getBalance(cid, r.itemId, r.warehouseId);
        if (cur < r.qty) {
          const wh = whInfo[r.warehouseId];
          res.status(400).json({
            error: `رصيد الصنف "${r.itemName}" غير كافٍ في مخزن "${wh?.nameAr ?? r.warehouseId}" — المتاح ${cur} والمطلوب ${r.qty}. فعّل خاصية "السماح بالسالب" على المخزن إن كنت ترغب بتجاوز الرصيد.`,
          });
          return;
        }
      }
    }

    // Decrease stock for each stockable return line (in base units), accumulate per-warehouse credits
    //
    // PHASE I — Batch-aware purchase returns:
    //   * batch_tracking_mode='none'  → legacy single-row WAC OUT (unchanged)
    //   * batch_tracking_mode='fifo|fefo' AND linked to source invoice →
    //       read the source invoice's stamped IN rows (qty>0, with
    //       batch_number/expiry_date from Round 1) and decrement returned
    //       qty from those specific batches in original receipt order so a
    //       partial return shrinks the oldest received batch first. Excess
    //       beyond what was originally received falls back to an unbatched
    //       OUT row at the line's derived cost.
    //   * batch-tracked WITHOUT source invoice → legacy WAC OUT path.
    const retModeById = new Map<number, "none" | "fifo" | "fefo">();
    for (const r of retItemRows) {
      const m = (r.mode ?? "none") as string;
      retModeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
    }

    // Keyed by "warehouseId|costCenterCode" — the OPTIONAL per-line cost center
    // splits the inventory credit per cost center; "" falls back to header cc.
    const inventoryByWarehouse: Record<string, number> = {};
    // Same keys, but at DOCUMENT line value (net of discount, excl VAT) —
    // used for the conventional no-variance JE (the default).
    const docNetByWarehouse: Record<string, number> = {};
    // Cross-line bucket consumption — duplicate (item, warehouse) lines in
    // the same return must share a batch's returnable headroom. Without
    // this, both lines would see the same `alreadyByBucket` snapshot and
    // collectively over-deduct the same source batch.
    // Key: `${itemId}|${warehouseId}|${batch||__null__}|${expiry||""}`
    const consumedThisDoc = new Map<string, number>();
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId || isSvcLine(line)) continue;
      const factor   = String(line.conversionFactor || "1");
      // Inventory credit covers BOTH paid and free units leaving the warehouse.
      // Cost-per-unit for the JE is derived from the paid line value spread
      // across the full physical quantity (paid + free) — same averaging
      // principle as the purchase-invoice posting that received them.
      const paidQty  = Number(multiplyQuantity(String(line.qty || "0"), factor));
      const freeQ    = Number(multiplyQuantity(String(line.freeQty || "0"), factor));
      const qty      = paidQty + freeQ;
      if (qty <= 0) continue; // skip non-positive returns
      const lineDisc = Math.max(0, Math.min(100, Number((line as any).discount) || 0));
      const paidLineValue = Number(multiplyQuantity(
        String(line.unitPrice || "0"),
        String(paidQty),
      )) * (1 - lineDisc / 100);
      const costUnit = qty > 0
        ? Number(roundQuantity(divideQuantity(String(paidLineValue), String(qty)), 18, "half_up"))
        : 0;

      const mode = retModeById.get(line.itemId) ?? "none";
      const canBatchTrace = mode !== "none" && !!ret.invoiceId;

      type ReturnPart = { takeQty: number; costPrice: number; batchNumber: string | null; expiryDate: string | null };
      const parts: ReturnPart[] = [];

      if (canBatchTrace) {
        // Source IN rows from the original purchase invoice for this
        // item+warehouse, in receipt order.
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
            eq(stockLedgerTable.refType, "purchase_invoice"),
            eq(stockLedgerTable.refId, ret.invoiceId!),
            eq(stockLedgerTable.itemId, line.itemId),
            eq(stockLedgerTable.warehouseId, line.warehouseId),
          ))
          .orderBy(asc(stockLedgerTable.id));
        // Aggregate source rows by (batchNumber, expiryDate) so a batch
        // received across multiple split lines/receipts forms a single
        // returnable bucket. Weighted-avg cost = Σ(qty×price)/Σ(qty);
        // firstId preserves receipt order for deterministic allocation.
        type Bucket = { batchNumber: string | null; expiryDate: string | null; received: number; costSum: number; firstId: number };
        const buckets = new Map<string, Bucket>();
        for (const row of srcRows) {
          const received = Number(row.qty);
          if (received <= 0) continue;
          const k = `${row.batchNumber ?? "__null__"}|${row.expiryDate ?? ""}`;
          const b = buckets.get(k);
          if (b) {
            b.received += received;
            b.costSum += received * Number(row.costPrice);
          } else {
            buckets.set(k, {
              batchNumber: row.batchNumber,
              expiryDate: row.expiryDate,
              received,
              costSum: received * Number(row.costPrice),
              firstId: row.id,
            });
          }
        }
        // Prior POSTED returns against the same invoice — subtract per-bucket
        // returned qty so a second partial return doesn't double-deduct.
        // Excludes current return id defensively. Keyed by (batch,expiry) to
        // match bucket granularity exactly.
        const priorReturned = await db
          .select({
            qty: stockLedgerTable.qty,
            batchNumber: stockLedgerTable.batchNumber,
            expiryDate: stockLedgerTable.expiryDate,
          })
          .from(stockLedgerTable)
          .innerJoin(purchaseReturnsTable, eq(stockLedgerTable.refId, purchaseReturnsTable.id))
          .where(and(
            eq(stockLedgerTable.companyId, cid),
            eq(stockLedgerTable.refType, "purchase_return"),
            eq(stockLedgerTable.itemId, line.itemId),
            eq(stockLedgerTable.warehouseId, line.warehouseId),
            eq(purchaseReturnsTable.invoiceId, ret.invoiceId!),
            eq(purchaseReturnsTable.status, "posted"),
            sql`${purchaseReturnsTable.id} <> ${id}`,
          ));
        const alreadyByBucket = new Map<string, number>();
        for (const r of priorReturned) {
          const k = `${r.batchNumber ?? "__null__"}|${r.expiryDate ?? ""}`;
          // Returns are OUT (qty<0) — abs() so the cap math is positive.
          alreadyByBucket.set(k, (alreadyByBucket.get(k) ?? 0) + Math.abs(Number(r.qty)));
        }
        // Walk buckets in receipt order (firstId asc) and allocate `qty`.
        const ordered = Array.from(buckets.entries()).sort((a, b) => a[1].firstId - b[1].firstId);
        let remaining = qty;
        for (const [k, b] of ordered) {
          if (remaining <= 0.0001) break;
          const docKey = `${line.itemId}|${line.warehouseId}|${k}`;
          const consumedPrior = alreadyByBucket.get(k) ?? 0;
          const consumedDoc   = consumedThisDoc.get(docKey) ?? 0;
          const returnable = Math.max(0, b.received - consumedPrior - consumedDoc);
          if (returnable <= 0.0001) continue;
          const take = Math.min(returnable, remaining);
          const wacCost = b.received > 0 ? b.costSum / b.received : 0;
          parts.push({
            takeQty: take,
            costPrice: wacCost,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
          });
          consumedThisDoc.set(docKey, consumedDoc + take);
          remaining -= take;
        }
        // Excess overflow → single unbatched OUT row at the line's derived cost.
        if (remaining > 0.0001) {
          parts.push({ takeQty: remaining, costPrice: costUnit, batchNumber: null, expiryDate: null });
        }
      } else {
        parts.push({ takeQty: qty, costPrice: costUnit, batchNumber: null, expiryDate: null });
      }

      const lineRemovedCost = parts.reduce((s, p) => s + p.takeQty * p.costPrice, 0);
      const whCcKey = `${line.warehouseId}|${(((line as any).costCenter ?? "") as string).toString().trim()}`;
      inventoryByWarehouse[whCcKey] = (inventoryByWarehouse[whCcKey] ?? 0) + lineRemovedCost;
      // Parallel accumulation at DOCUMENT value (net of discount, excl VAT) —
      // used when the return posts WITHOUT a variance line (default).
      docNetByWarehouse[whCcKey] = (docNetByWarehouse[whCcKey] ?? 0) + paidLineValue;

      const wac = qty > 0 ? lineRemovedCost / qty : costUnit;
      await upsertBalance(cid, line.itemId, line.warehouseId, -qty, wac);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      let cursor = newBal + qty; // pre-issue total
      for (const p of parts) {
        cursor -= p.takeQty;
        await addStockLedgerEntry({
          companyId:   cid,
          itemId:      line.itemId,
          warehouseId: line.warehouseId,
          txDate:      ret.returnDate,
          txType:      "purchase_return",
          qty:         String(-p.takeQty),
          costPrice:   String(p.costPrice.toFixed(4)),
          totalCost:   String((-p.takeQty * p.costPrice).toFixed(2)),
          balanceQty:  String(cursor.toFixed(4)),
          refId:       id,
          refType:     "purchase_return",
          batchNumber: p.batchNumber,
          expiryDate:  p.expiryDate,
          notes:       `${line.notes ?? ""}${p.batchNumber ? ` — ارتجاع تشغيلة ${p.batchNumber}` : ""}`.trim() || undefined,
        });
      }
    }

    // ── Create journal entry (قيد محاسبي) — reverse of purchase invoice ──
    // Dr Supplier/Cash    = totalAmount  (we get the money/credit back)
    // Dr Discount Earned  = discountAmount (reverse the discount)
    // Cr Inventory        = subtotal     (goods leaving stock)
    // Cr VAT Input        = vatAmount    (reverse the input VAT)
    const totalAmount    = Number(ret.totalAmount    || 0);
    const vatAmount      = Number(ret.vatAmount      || 0);
    const discountAmount = Number((ret as any).discountAmount || 0);
    const subtotal       = totalAmount - vatAmount + discountAmount;

    const mapPr = await loadMappings(cid, "purchase_return");
    const taxAccId      = pickAccount((ret as any).taxAccountId,      mapPr("purchase_return", "vat_input"));
    const discountAccId = pickAccount((ret as any).discountAccountId, mapPr("purchase_return", "discount"));
    const varianceAccId = mapPr("purchase_return", "variance");

    const counterpartyAccountId =
      ret.paymentType === "cash" ? await getCashBoxAccountId(cid, ret.cashBoxId)
      : ret.paymentType === "bank" ? await getBankAccountAccountId(cid, (ret as any).bankAccountId)
      : await getSupplierAccountId(cid, ret.supplierId);
    // Supplier AP account for the cash/bank pass-through legs (may be null).
    const returnSupplierApAccId =
      (ret.paymentType === "cash" || ret.paymentType === "bank")
        ? await getSupplierAccountId(cid, ret.supplierId)
        : null;

    // Supplier display info for the JE line description — كشف الحساب must show
    // WHO the return belongs to + the supplier's invoice number, not just
    // "تخفيض رصيد المورد".
    const [retSupRow] = ret.supplierId
      ? await db.select({ nameAr: suppliersTable.nameAr, nameEn: suppliersTable.nameEn })
          .from(suppliersTable)
          .where(and(eq(suppliersTable.id, ret.supplierId), eq(suppliersTable.companyId, cid)))
      : [];
    const retSupName = ((retSupRow?.nameAr ?? "").trim() || (retSupRow?.nameEn ?? "").trim());
    const retSupInv  = ((ret as any).supplierInvoiceNumber ?? "").toString().trim();
    const apLineDesc = [
      "تخفيض رصيد المورد بالمرتجع",
      retSupName ? `المورد: ${retSupName}` : "",
      retSupInv ? `فاتورة المورد رقم ${retSupInv}` : "",
    ].filter(Boolean).join(" — ");

    const missing: string[] = [];
    if (vatAmount > 0 && !taxAccId) missing.push("حساب الضرائب (مدخلات)");
    if (discountAmount > 0 && !discountAccId) missing.push("حساب الخصم المكتسب");
    if (!counterpartyAccountId) missing.push(ret.paymentType === "cash" ? "حساب الخزنة" : ret.paymentType === "bank" ? "الحساب البنكي" : "حساب المورد");
    // Inventory account derived from warehouse — verify each used warehouse has one
    const missingWh: string[] = [];
    // Check BOTH maps — the JE may credit at actual cost OR doc value.
    for (const [key, amt] of Object.entries({ ...inventoryByWarehouse, ...docNetByWarehouse })) {
      if (amt <= 0) continue;
      const wid = Number(key.split("|")[0]);
      if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
    }
    if (missingWh.length) missing.push(`حساب المخزون لـ: ${missingWh.join("، ")}`);

    // ── GL vs stock variance handling ─────────────────────────────────────
    // Inventory CR lines now post at ACTUAL stock-out cost (= sum of
    // `lineRemovedCost` accumulated above, which uses each batch's weighted-
    // average source cost). This keeps GL inventory movement perfectly in
    // sync with the stock subledger.
    //
    // When the document subtotal (what we agreed to refund with the
    // supplier) differs from the actual stock-out cost — e.g. supplier
    // applied a flat restocking fee, prices changed since the original
    // receipt, or the return value was negotiated independently — the
    // difference is routed to a dedicated "purchase-return variance"
    // account. Sub-cent drift (≤ 0.01 SAR) is silently nudged into the
    // last inventory line instead of forcing the user to wire a variance
    // account just for rounding.
    // Two posting flavors (per-return flag, default OFF = conventional):
    //   * postVariance=false → Cr inventory at DOCUMENT value (net) per
    //     warehouse — supplier DR gross, inventory CR net, VAT CR. No
    //     variance account needed; GL follows the document.
    //   * postVariance=true  → Cr inventory at ACTUAL stock-out cost and
    //     route the doc-vs-cost delta to the variance account (old behavior).
    // SERVICE credits — reversal of the invoice's service-cost debit, at
    // document net value, keyed "costAccountId|costCenter". Service lines
    // never touched the stock loops above, so they get their own bucket.
    const serviceCreditByKey: Record<string, number> = {};
    for (const line of lines) {
      if (!isSvcLine(line)) continue;
      const lineDisc = Math.max(0, Math.min(100, Number((line as any).discount) || 0));
      const val = Number(line.unitPrice) * Number(line.qty) * (1 - lineDisc / 100);
      if (val <= 0) continue;
      const acc = retCostAccById.get(line.itemId as number);
      if (!acc) continue; // valued lines guarded above (svcNoCost)
      const cc = (((line as any).costCenter ?? "") as string).toString().trim();
      const k = `${acc}|${cc}`;
      serviceCreditByKey[k] = (serviceCreditByKey[k] ?? 0) + val;
    }
    const svcRawTotal = Object.values(serviceCreditByKey).reduce((s, v) => s + v, 0);
    let svcCreditByKey: Record<string, number> = { ...serviceCreditByKey };

    const useVariance = (ret as any).postVariance === true;
    let creditBaseByWh = useVariance ? inventoryByWarehouse : docNetByWarehouse;
    if (!useVariance) {
      // paidLineValue is the RAW discounted line value — with price-includes-
      // VAT it is gross, and header discount/tax modes can also skew it.
      // Scale ALL buckets proportionally so their sum equals the document
      // subtotal (net of VAT) — never dump the difference into one bucket.
      const rawTotal = Object.values(docNetByWarehouse).reduce((s, v) => s + v, 0) + svcRawTotal;
      if (rawTotal <= 0 && subtotal > 0.01) {
        throw new Error("لا يمكن ترحيل المرتجع بقيمة المستند: لا توجد بنود (صنف + مستودع، أو صنف خدمي) تحمل قيمة. حدّد الصنف والمستودع على البنود أو فعّل قيد فروق الأسعار.");
      }
      if (rawTotal > 0 && Math.abs(rawTotal - subtotal) > 0.005) {
        const scale = subtotal / rawTotal;
        creditBaseByWh = Object.fromEntries(
          Object.entries(docNetByWarehouse).map(([k, v]) => [k, Math.round(v * scale * 100) / 100]),
        );
        svcCreditByKey = Object.fromEntries(
          Object.entries(serviceCreditByKey).map(([k, v]) => [k, Math.round(v * scale * 100) / 100]),
        );
      }
    }
    const goodsCostTotal = Object.values(creditBaseByWh).reduce((s, v) => s + v, 0)
      + Object.values(svcCreditByKey).reduce((s, v) => s + v, 0);
    const varianceDelta  = subtotal - goodsCostTotal; // >0 → CR variance (refund > cost = gain); <0 → DR variance (refund < cost = loss)
    const VARIANCE_NUDGE_THRESHOLD = 0.01;
    const needsVarianceLine = useVariance && Math.abs(varianceDelta) > VARIANCE_NUDGE_THRESHOLD;
    if (needsVarianceLine && !varianceAccId) {
      missing.push(`حساب فروق سعر مرتجع المشتريات (الفرق = ${varianceDelta.toFixed(2)} ر.س — اربط الحساب من /admin/accounting-mappings تحت "مرتجع المشتريات")`);
    }
    if (missing.length) {
      throw new Error(`يجب تحديد الحسابات التالية قبل الترحيل: ${missing.join("، ")}`);
    }

    // Build inventory credits; nudge residual drift into the last line so
    // the JE balances (doc-value mode: only sub-cent rounding remains).
    const inventoryCreditByWh: Record<string, number> = { ...creditBaseByWh };
    if (!needsVarianceLine && Math.abs(varianceDelta) > 0) {
      // Sub-cent rounding — push the leftover into the last inventory line
      // (or last service line for service-only returns) so the JE still
      // balances without needing a variance account.
      const lastKey = Object.keys(inventoryCreditByWh).pop();
      if (lastKey) inventoryCreditByWh[lastKey] += varianceDelta;
      else {
        const lastSvc = Object.keys(svcCreditByKey).pop();
        if (lastSvc) svcCreditByKey[lastSvc] += varianceDelta;
      }
    }

    // A tagged return reverses the immutable original industrial expense, not
    // today's item/warehouse mapping or the commercial refund price. Cap both
    // physical quantity and base-currency source value against all previously
    // posted returns for the same original line before this return is posted.
    const taggedReturns = lines.map((line) => ({ line, tag: normalizeIndustrialCostTag((line as any).industrialCost) }))
      .filter((row) => row.tag) as { line: any; tag: NonNullable<ReturnType<typeof normalizeIndustrialCostTag>> }[];
    if (taggedReturns.length) {
      const originalIds = [...new Set(taggedReturns.map((row) => row.tag.sourcePurchaseLineId!))];
      await db.transaction(async (tx) => {
      // Serialize capacity checks on the original immutable source lines.
      await tx.execute(sql`SELECT id FROM purchase_invoice_lines WHERE id IN ${originalIds} FOR UPDATE`);
      const originals = await tx.select().from(purchaseInvoiceLinesTable).where(and(
        eq(purchaseInvoiceLinesTable.companyId, cid),
        inArray(purchaseInvoiceLinesTable.id, originalIds),
      ));
      const originalById = new Map(originals.map((line) => [line.id, line]));
      const postedReturns = await tx.select({ line: purchaseReturnLinesTable })
        .from(purchaseReturnLinesTable)
        .innerJoin(purchaseReturnsTable, eq(purchaseReturnLinesTable.returnId, purchaseReturnsTable.id))
        .where(and(
          eq(purchaseReturnsTable.companyId, cid),
          eq(purchaseReturnsTable.invoiceId, ret.invoiceId!),
          eq(purchaseReturnsTable.status, "posted"),
          sql`${purchaseReturnsTable.id} <> ${id}`,
        ));
      const used = new Map<number, { qty: number; amount: number }>();
      for (const { line } of postedReturns) {
        const priorTag = normalizeIndustrialCostTag((line as any).industrialCost);
        const priorFacts = readIndustrialCostSourceFacts((line as any).industrialCost);
        if (!priorTag?.sourcePurchaseLineId || !priorFacts) continue;
        const current = used.get(priorTag.sourcePurchaseLineId) ?? { qty: 0, amount: 0 };
        current.qty += Number(line.qty || 0);
        current.amount += priorFacts.netBaseAmount;
        used.set(priorTag.sourcePurchaseLineId, current);
      }
      for (const { line, tag } of taggedReturns) {
        const source = originalById.get(tag.sourcePurchaseLineId!);
        const originalFacts = source ? readIndustrialCostSourceFacts((source as any).industrialCost) : null;
        if (!source || !originalFacts || originalFacts.quantity <= 0) {
          throw Object.assign(new Error("مصدر مرتجع التكلفة الصناعية لا يملك لقطة أصلية صالحة"), { status: 409 });
        }
        const returnedQty = Number(line.qty || 0);
        const returnBaseAmount = Math.round((originalFacts.netBaseAmount * returnedQty / originalFacts.quantity) * 100) / 100;
        const prior = used.get(tag.sourcePurchaseLineId!) ?? { qty: 0, amount: 0 };
        if (prior.qty + returnedQty > originalFacts.quantity + 0.0001
          || prior.amount + returnBaseAmount > originalFacts.netBaseAmount + 0.01) {
          throw Object.assign(new Error(`كمية أو قيمة المرتجع الصناعي تتجاوز مصدر الفاتورة #${tag.sourcePurchaseLineId}`), { status: 409 });
        }
        const frozen = industrialCostWithSourceFacts(tag, {
          netBaseAmount: returnBaseAmount,
          sourceAccountId: originalFacts.sourceAccountId,
          quantity: returnedQty,
          sourceCurrency: ret.currencyCode || "SAR",
          exchangeRate: Number(ret.exchangeRate || "1") || 1,
        });
        await (tx.update(purchaseReturnLinesTable) as any).set({ industrialCost: frozen })
          .where(and(eq(purchaseReturnLinesTable.id, line.id), eq(purchaseReturnLinesTable.companyId, cid)));
        line.industrialCost = frozen;
        used.set(tag.sourcePurchaseLineId!, { qty: prior.qty + returnedQty, amount: prior.amount + returnBaseAmount });
      }
      });
    }

    const desc = `قيد مرتجع مشتريات رقم ${ret.docNumber || ret.id}`;
    const journalId = await createJournalEntry({
      companyId:    cid,
      audit:        { req },
      branchId:     ret.branchId,
      date:         ret.returnDate,
      docNumber:    ret.docNumber,
      description:  desc,
      entryType:    "purchase_return",
      sourceType:   "purchase_return",
      sourceId:     ret.id,
      exchangeRate: ret.exchangeRate,
      // Inherit cost center from the original invoice when set so the
      // return tags the same CC as the purchase it reverses.
      costCenter:   (ret as any).costCenter ?? null,
      lines: [
        // CASH/BANK returns pass through the supplier's AP account so كشف حساب
        // المورد shows BOTH legs (تخفيض الرصيد بالمرتجع ثم الاسترداد) — mirrors
        // the cash/bank purchase-invoice pass-through. The two AP legs net to
        // zero, so supplier balances are unaffected. If the supplier has no
        // ledger account, fall back to the old direct debit.
        ...(((ret.paymentType === "cash" || ret.paymentType === "bank") && returnSupplierApAccId)
          ? [
              { accountId: returnSupplierApAccId, debit:  totalAmount, description: apLineDesc },
              { accountId: returnSupplierApAccId, credit: totalAmount, description: ret.paymentType === "cash" ? "استرداد نقدي من المورد" : "استرداد بنكي من المورد" },
              { accountId: counterpartyAccountId, debit:  totalAmount, description: ret.paymentType === "cash" ? "استرداد نقدي" : "استرداد بنكي" },
            ]
          : [
              { accountId: counterpartyAccountId, debit:  totalAmount, description: ret.paymentType === "cash" ? "استرداد نقدي" : ret.paymentType === "bank" ? "استرداد بنكي" : apLineDesc },
            ]),
        { accountId: discountAccId,                   debit:  discountAmount, description: "إلغاء خصم مكتسب" },
        // Inventory: one credit line per warehouse using its own GL account.
        // Posted at actual stock-out cost (weighted source cost) so GL ties
        // exactly to the stock subledger.
        ...Object.entries(inventoryCreditByWh)
          .filter(([, amt]) => amt > 0)
          .map(([key, amt]) => {
            const [widStr, cc] = key.split("|");
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              credit: amt,
              description: `ارتجاع البضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
              // Per-line cost center (optional) — "" falls back to header via createJournalEntry.
              ...(cc ? { costCenter: cc } : {}),
            };
          }),
        // SERVICE items (خدمي): credit each item's own cost account —
        // reversal of the purchase-invoice service-cost debit.
        ...Object.entries(svcCreditByKey)
          .filter(([, amt]) => amt > 0)
          .map(([key, amt]) => {
            const [accStr, cc] = key.split("|");
            return {
              accountId: Number(accStr),
              credit: amt,
              description: "ارتجاع صنف خدمي",
              ...(cc ? { costCenter: cc } : {}),
            };
          }),
        { accountId: taxAccId,                        credit: vatAmount,      description: "إلغاء ضريبة القيمة المضافة", costCenter: null },
        // Variance: balances the JE when refund value ≠ actual stock cost.
        // delta > 0 → CR variance (refund exceeds cost = gain for buyer).
        // delta < 0 → DR variance (refund below cost = loss for buyer).
        ...(needsVarianceLine
          ? [{
              accountId: varianceAccId!,
              debit:  varianceDelta < 0 ? -varianceDelta : 0,
              credit: varianceDelta > 0 ?  varianceDelta : 0,
              description: varianceDelta < 0
                ? `فرق سعر مرتجع — تكلفة المخزون أعلى من قيمة الاسترداد بمقدار ${(-varianceDelta).toFixed(2)}`
                : `فرق سعر مرتجع — قيمة الاسترداد أعلى من تكلفة المخزون بمقدار ${varianceDelta.toFixed(2)}`,
            }]
          : []),
      ],
    });

    const [updated] = await db.update(purchaseReturnsTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(purchaseReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST purchase return (فك الترحيل) ────────────────────────────────────
router.patch("/purchase-returns/:id/unpost", requireUnpostRight("purchase"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Branch-scope guard (mirrors /post above).
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(
        eq(purchaseReturnsTable.id, id),
        eq(purchaseReturnsTable.companyId, cid),
        ...branchScopeSpread(req, purchaseReturnsTable.branchId, undefined),
      ));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status !== "posted") { res.status(400).json({ error: "المرتجع ليس مُرحَّلاً" }); return; }
    const industrialLines = await db.select().from(purchaseReturnLinesTable)
      .where(eq(purchaseReturnLinesTable.returnId, id));
    await assertIndustrialCostPeriodsWritable(cid, industrialLines);

    // Reverse stock movements (returns reduce stock; unposting adds it back)
    const ledger = await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_return"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty);
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
        eq(stockLedgerTable.refType, "purchase_return"),
        eq(stockLedgerTable.refId, id),
      ));

    if (ret.journalEntryId) {
      // Stash this JE's number so the next re-post reuses it (no gap).
      await reserveJeNumberFromEntry(cid, "purchase_return", id, ret.journalEntryId);
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, ret.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(purchaseReturnsTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(purchaseReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف مرتجع مُرحَّل. قم بإلغاء الترحيل أولاً ثم احذفه." });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "purchase_return", refId: id, journalEntryId: (ret as any).journalEntryId });
    await db.delete(purchaseReturnsTable).where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SUPPLIER SETTLEMENTS
// ═══════════════════════════════════════════════
router.get("/supplier-settlements", requirePermission("supplier_settlements", "view"), async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const supplierScope = effectiveBranchCondition(req, suppliersTable.branchId, req.query.branchId);
    if ("deny" in supplierScope) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" }); return;
    }
    const supplierIds = supplierScope.cond
      ? (await db.select({ id: suppliersTable.id }).from(suppliersTable).where(and(
          eq(suppliersTable.companyId, cid),
          or(isNull(suppliersTable.branchId), supplierScope.cond),
        ))).map((row) => row.id)
      : null;
    const conditions: any[] = [eq(supplierSettlementsTable.companyId, cid)];
    if (supplierIds) {
      conditions.push(or(
        isNull(supplierSettlementsTable.supplierId),
        supplierIds.length ? inArray(supplierSettlementsTable.supplierId, supplierIds) : sql`false`,
      ));
    }
    const rows = await db.select().from(supplierSettlementsTable)
      .where(and(...conditions))
      .orderBy(desc(supplierSettlementsTable.settlementDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/supplier-settlements", requirePermission("supplier_settlements", "create"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, settlementDate, supplierId, paymentMethod, accountId,
            amount, currencyCode, exchangeRate, notes, sourceType,
            sourceRecordId, sourceKey } = req.body;
    if (!settlementDate || !amount) {
      res.status(400).json({ error: "التاريخ والمبلغ مطلوبان" }); return;
    }
    const normalizedSupplierId = supplierId == null || supplierId === "" ? null : Number(supplierId);
    if (normalizedSupplierId != null && (!Number.isInteger(normalizedSupplierId) || normalizedSupplierId <= 0)) {
      res.status(400).json({ error: "المورد غير صحيح" }); return;
    }
    const rawSourceKey = sourceKey == null || sourceKey === "" ? "" : String(sourceKey).trim();
    if (rawSourceKey.length > 240) {
      res.status(400).json({ error: "مفتاح مصدر التسوية طويل جداً" }); return;
    }
    const normalizedSourceKey = rawSourceKey || null;
    if (sourceKey != null && !normalizedSourceKey) {
      res.status(400).json({ error: "مفتاح مصدر التسوية غير صحيح" }); return;
    }
    const normalizedSourceType = sourceType == null || sourceType === ""
      ? null : String(sourceType).trim();
    if (normalizedSourceType && /^production_/i.test(normalizedSourceType)) {
      res.status(400).json({
        error: "مرجع production_* محجوز لمسار الاستحقاق التجاري؛ لا يمكن إنشاؤه من مسار تسوية المورد العام",
      });
      return;
    }
    const normalizedSourceRecordId = sourceRecordId == null || sourceRecordId === ""
      ? null : Number(sourceRecordId);
    if (normalizedSourceRecordId != null &&
        (!Number.isInteger(normalizedSourceRecordId) || normalizedSourceRecordId <= 0)) {
      res.status(400).json({ error: "مرجع مصدر التسوية غير صحيح" }); return;
    }
    if (normalizedSupplierId != null) {
      const [supplier] = await db.select({ id: suppliersTable.id, branchId: suppliersTable.branchId })
        .from(suppliersTable)
        .where(and(
          eq(suppliersTable.id, normalizedSupplierId),
          eq(suppliersTable.companyId, cid),
        )).limit(1);
      if (!supplier) {
        res.status(400).json({ error: "المورد غير موجود في هذه الشركة" }); return;
      }
      const scope = effectiveBranchCondition(req, suppliersTable.branchId, supplier.branchId);
      if ("deny" in scope) {
        res.status(403).json({ error: "لا يمكنك العمل على فرع المورد" }); return;
      }
    }
    const values = {
      companyId: cid, docNumber: docNumber || null, settlementDate,
      supplierId: normalizedSupplierId,
      paymentMethod: paymentMethod || "bank",
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount), currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      status: "draft", notes: notes || null,
      sourceType: normalizedSourceType,
      sourceRecordId: normalizedSourceRecordId,
      sourceKey: normalizedSourceKey,
    };
    try {
      const [row] = await db.insert(supplierSettlementsTable).values(values).returning();
      res.status(201).json(row);
    } catch (e: any) {
      // Generated payable drafts are retried by lifecycle actions and workers.
      // A unique company/source key makes the retry idempotent; return the
      // original row instead of surfacing a duplicate-key error.
      if (normalizedSourceKey && String(e?.code ?? "") === "23505") {
        const [existing] = await db.select().from(supplierSettlementsTable).where(and(
          eq(supplierSettlementsTable.companyId, cid),
          eq(supplierSettlementsTable.sourceKey, normalizedSourceKey),
        )).limit(1);
        if (existing) {
          res.status(200).json({ ...existing, idempotentReplay: true });
          return;
        }
      }
      throw e;
    }
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/supplier-settlements/:id/post",
  requirePermission("supplier_settlements", "post"),
  requirePostRight("purchase"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(supplierSettlementsTable).where(and(
        eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid),
      )).for("update").limit(1);
      if (!existing) throw Object.assign(new Error("التسوية غير موجودة"), { status: 404 });
      if (!(await settlementSupplierInScope(req, cid, existing.supplierId)))
        throw Object.assign(new Error("لا يمكنك العمل على فرع المورد"), { status: 403 });

      // Ordinary supplier settlements retain their historical status-only
      // behavior. Only the royalty accrual link opts into the atomic clearing
      // journal below.
      if (existing.sourceType && /^production_/i.test(existing.sourceType) &&
          existing.sourceType !== "production_royalty_accrual")
        throw Object.assign(new Error("مسودة Royalty قديمة أو مرجع production_* غير قابل للترحيل؛ أنشئ استحقاقاً تجارياً جديداً"), { status: 409 });
      if (existing.sourceType !== "production_royalty_accrual")
        return (await tx.update(supplierSettlementsTable)
          .set({ status: "posted", updatedAt: new Date() })
          .where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)))
          .returning())[0];

      const sourceId = Number(existing.sourceRecordId);
      if (!Number.isInteger(sourceId) || sourceId <= 0)
        throw Object.assign(new Error("مرجع استحقاق Royalty في التسوية غير صحيح"), { status: 409 });
      const lockedAccrual = await tx.select().from(productionCommercialAccrualsTable).where(and(
        eq(productionCommercialAccrualsTable.id, sourceId),
        eq(productionCommercialAccrualsTable.companyId, cid),
        eq(productionCommercialAccrualsTable.obligationType, "royalty"),
      )).for("update").limit(1);
      const accrual = lockedAccrual[0];
      if (!accrual)
        throw Object.assign(new Error("استحقاق Royalty المصدر غير موجود في هذه الشركة"), { status: 404 });
      if ("deny" in effectiveBranchCondition(req, branchesTable.id, accrual.branchId))
        throw Object.assign(new Error("لا يمكنك العمل على فرع استحقاق Royalty"), { status: 403 });
      if (accrual.status !== "posted" || !accrual.journalEntryId)
        throw Object.assign(new Error("تسوية Royalty تتطلب استحقاقاً وقيده مرحّلين"), { status: 409 });
      if (accrual.settlementId == null || Number(accrual.settlementId) !== id)
        throw Object.assign(new Error("الاستحقاق مرتبط بتسوية أخرى"), { status: 409 });
      const expectedSourceKey = `production_royalty_accrual_settlement:${cid}:${sourceId}`;
      if (existing.sourceRecordId == null || Number(existing.sourceRecordId) !== sourceId ||
          existing.sourceKey !== expectedSourceKey)
        throw Object.assign(new Error("مرجع تسوية Royalty أو مفتاح مصدرها غير مطابق للاستحقاق"), { status: 409 });
      if (existing.supplierId == null || Number(existing.supplierId) !== Number(accrual.supplierId))
        throw Object.assign(new Error("مورد تسوية Royalty لا يطابق مورد الاستحقاق"), { status: 409 });
      if (Math.abs(Number(existing.amount) - Number(accrual.amount)) > 0.005)
        throw Object.assign(new Error("مبلغ التسوية لا يطابق مبلغ استحقاق Royalty"), { status: 409 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(existing.settlementDate)))
        throw Object.assign(new Error("تاريخ تسوية Royalty غير صحيح"), { status: 400 });

      const [supplier] = await tx.select({
        id: suppliersTable.id,
        accountId: suppliersTable.accountId,
        branchId: suppliersTable.branchId,
      }).from(suppliersTable).where(and(
        eq(suppliersTable.id, existing.supplierId),
        eq(suppliersTable.companyId, cid),
      )).limit(1);
      if (!supplier)
        throw Object.assign(new Error("المورد غير موجود في هذه الشركة"), { status: 400 });
      if (accrual.branchId != null && supplier.branchId != null &&
          Number(accrual.branchId) !== Number(supplier.branchId))
        throw Object.assign(new Error("فرع مورد Royalty لا يطابق فرع الاستحقاق"), { status: 409 });
      if (String(existing.paymentMethod ?? "").toLowerCase() === "cash")
        throw Object.assign(new Error("تسوية Royalty المرتبطة ليست دفعة نقدية؛ استخدم حساب دائن المورد"), { status: 409 });
      const supplierApAccountId = await validateLinkedSettlementAccount(
        tx, cid, supplier.accountId, "حساب دائن المورد",
      );
      const accruedLiabilityAccountId = await validateLinkedSettlementAccount(
        tx, cid, accrual.liabilityAccountId, "حساب التزام Royalty المستحق",
      );
      if (supplierApAccountId === accruedLiabilityAccountId)
        throw Object.assign(new Error("حساب دائن المورد يجب أن يختلف عن حساب الالتزام المستحق"), { status: 400 });
      if (existing.accountId == null || Number(existing.accountId) !== supplierApAccountId)
        throw Object.assign(new Error("حساب التسوية يجب أن يكون حساب دائن المورد"), { status: 409 });

      // The settlement is a payable-obligation transition, not a cash
      // payment: DR the accrued royalty liability and CR the supplier AP.
      const journalEntryId = existing.status === "posted" && existing.journalEntryId
        ? existing.journalEntryId
        : await createJournalEntry({
            companyId: cid,
            branchId: accrual.branchId,
            date: String(existing.settlementDate),
            description: `تسوية التزام Royalty #${sourceId} إلى دائن المورد`,
            docNumber: existing.docNumber,
            entryType: "production_royalty_settlement_clearing",
            status: "posted",
            audit: { req },
            sourceType: "supplier_settlement",
            sourceId: id,
            dx: tx,
            lines: [
              {
                accountId: accruedLiabilityAccountId,
                debit: Number(Number(existing.amount).toFixed(2)),
                description: `إقفال التزام Royalty #${sourceId}`,
              },
              {
                accountId: supplierApAccountId,
                credit: Number(Number(existing.amount).toFixed(2)),
                description: `دائن المورد لتسوية Royalty #${sourceId}`,
              },
            ],
          });
      const [posted] = await tx.update(supplierSettlementsTable).set({
        status: "posted",
        accountId: supplierApAccountId,
        journalEntryId,
        updatedAt: new Date(),
      }).where(and(
        eq(supplierSettlementsTable.id, id),
        eq(supplierSettlementsTable.companyId, cid),
      )).returning();
      if (!posted) throw Object.assign(new Error("تعذر ترحيل تسوية Royalty"), { status: 409 });
      return posted;
    });
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Mirrors the unpost flow on purchase-invoices / purchase-returns: admin-only,
// flips status back to draft so the user can edit or delete the row.
// Without this the DELETE guard above would be a dead-end for posted rows.
router.patch("/supplier-settlements/:id/unpost",
  requirePermission("supplier_settlements", "unpost"),
  requireUnpostRight("purchase"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(supplierSettlementsTable).where(and(
        eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid),
      )).for("update").limit(1);
      if (!existing) throw Object.assign(new Error("التسوية غير موجودة"), { status: 404 });
      if (!(await settlementSupplierInScope(req, cid, existing.supplierId)))
        throw Object.assign(new Error("لا يمكنك العمل على فرع المورد"), { status: 403 });
      if (existing.sourceType !== "production_royalty_accrual")
        return (await tx.update(supplierSettlementsTable)
          .set({ status: "draft", updatedAt: new Date() })
          .where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)))
          .returning())[0];
      if (existing.status === "draft") return existing;
      if (existing.status !== "posted" || !existing.journalEntryId)
        throw Object.assign(new Error("تسوية Royalty مرحّلة بلا قيد قابل للعكس"), { status: 409 });

      const sourceId = Number(existing.sourceRecordId);
      const lockedAccrual = await tx.select().from(productionCommercialAccrualsTable).where(and(
        eq(productionCommercialAccrualsTable.id, sourceId),
        eq(productionCommercialAccrualsTable.companyId, cid),
        eq(productionCommercialAccrualsTable.obligationType, "royalty"),
      )).for("update").limit(1);
      const accrual = lockedAccrual[0];
      if (!accrual || accrual.status !== "posted")
        throw Object.assign(new Error("لا يمكن عكس تسوية Royalty دون استحقاق مرحّل"), { status: 409 });
      if ("deny" in effectiveBranchCondition(req, branchesTable.id, accrual.branchId))
        throw Object.assign(new Error("لا يمكنك العمل على فرع استحقاق Royalty"), { status: 403 });
      const originalLines = await tx.select({
        accountId: journalEntryLinesTable.accountId,
        debit: journalEntryLinesTable.debit,
        credit: journalEntryLinesTable.credit,
        description: journalEntryLinesTable.description,
        costCenter: journalEntryLinesTable.costCenter,
      }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, existing.journalEntryId))
        .orderBy(asc(journalEntryLinesTable.sortOrder));
      if (originalLines.length < 2)
        throw Object.assign(new Error("قيد تسوية Royalty الأصلي غير مكتمل ولا يمكن عكسه"), { status: 409 });
      const reversalJournalEntryId = await createJournalEntry({
        companyId: cid,
        branchId: accrual.branchId,
        date: String(existing.settlementDate),
        description: `عكس تسوية التزام Royalty #${sourceId} — القيد #${existing.journalEntryId}`,
        docNumber: existing.docNumber,
        entryType: "production_royalty_settlement_reversal",
        status: "posted",
        audit: { req },
        sourceType: "supplier_settlement_reversal",
        sourceId: id,
        dx: tx,
        lines: originalLines.map((line) => ({
          accountId: line.accountId,
          debit: Number(line.credit ?? 0),
          credit: Number(line.debit ?? 0),
          description: `عكس: ${line.description ?? "تسوية التزام Royalty"}`,
          costCenter: line.costCenter,
        })),
      });
      const [unposted] = await tx.update(supplierSettlementsTable).set({
        status: "draft",
        reversalJournalEntryId,
        updatedAt: new Date(),
      }).where(and(
        eq(supplierSettlementsTable.id, id),
        eq(supplierSettlementsTable.companyId, cid),
      )).returning();
      if (!unposted) throw Object.assign(new Error("تعذر عكس تسوية Royalty"), { status: 409 });
      return unposted;
    });
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/supplier-settlements/:id", requirePermission("supplier_settlements", "delete"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Posted-status guard — same rule as every other financial doc:
    // a posted settlement cannot be deleted. The user must unpost it
    // first so the audit trail and ledger stay consistent.
    const [existing] = await db.select({
      status: supplierSettlementsTable.status,
      supplierId: supplierSettlementsTable.supplierId,
    })
      .from(supplierSettlementsTable)
      .where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    if (!(await settlementSupplierInScope(req, cid, existing.supplierId))) {
      res.status(403).json({ error: "لا يمكنك العمل على فرع المورد" }); return;
    }
    if (existing.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف تسوية مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    await db.delete(supplierSettlementsTable).where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ── AI-generated journal entry for a Letter of Credit ───────────────────
router.post("/letters-of-credit/:id/ai-journal", requireAiFeature("account_suggestions"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const save = !!req.body?.save;

    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    const expenses = await db.select().from(lcExpensesTable).where(eq(lcExpensesTable.lcId, id));

    let supplierName = "—", supplierAccountId: number | null = null;
    if (lc.supplierId) {
      const [s] = await db.select().from(suppliersTable)
        .where(and(eq(suppliersTable.id, lc.supplierId), eq(suppliersTable.companyId, cid)));
      supplierName = s?.nameAr ?? "—";
      supplierAccountId = s?.accountId ?? null;
    }

    const { accountsTable } = await import("@workspace/db");
    const dbAccounts = await db.select().from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));
    const postable = dbAccounts.filter(a => a.isPosting !== false);
    if (postable.length < 2) { res.status(400).json({ error: "شجرة الحسابات غير مهيأة" }); return; }

    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY  = "AI_PROXY";
    if (!isAIAvailable()) { res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" }); return; }

    // Convert all amounts to the company's base/functional currency (IAS 21).
    // The journal entry MUST be posted in the base currency only; the original
    // foreign-currency values are kept as informational context for the AI.
    const baseCurrency = await getBaseCurrencyCode(cid);
    const lcRate       = Number(lc.exchangeRate ?? "1") || 1;
    const lcTotalBase  = +(Number(lc.totalAmount ?? 0) * lcRate).toFixed(2);
    const expensesBase = expenses.map(e => {
      const r = Number(e.exchangeRate ?? "1") || 1;
      const a = Number(e.amount       ?? "0") || 0;
      return { ...e, amountBase: +(a * r).toFixed(2), rate: r };
    });

    const accountList = postable.slice(0, 400).map(a =>
      `- id=${a.id} | ${a.code} | ${a.nameAr} | ${a.accountType}`
    ).join("\n");
    const expList = expensesBase.length
      ? expensesBase.map((e, i) =>
          `  ${i + 1}) ${e.expenseType || "—"} — ${Number(e.amount || 0)} ${e.currencyCode || baseCurrency} × ${e.rate} = ${e.amountBase} ${baseCurrency}${e.accountId ? ` (حساب مقترح id=${e.accountId})` : ""}`
        ).join("\n")
      : "  (لا توجد مصاريف مسجلة)";

    const prompt = `أنت محاسب سعودي خبير. مطلوب إنشاء قيد محاسبي متوازن (debit = credit) يعكس فتح اعتماد مستندي وتسجيل مصاريف الاستيراد المرتبطة به.

⚠️ مهم جداً: العملة الأساسية للشركة هي ${baseCurrency}. كل المبالغ في القيد يجب أن تكون بالعملة الأساسية ${baseCurrency} بعد التحويل بسعر الصرف. لا تستخدم المبالغ الأصلية بالعملة الأجنبية. (وفق IAS 21)

بيانات الاعتماد:
- رقم الاعتماد: ${lc.lcNumber}
- التاريخ: ${lc.lcDate}
- المورد: ${supplierName}${supplierAccountId ? ` (حساب مورد id=${supplierAccountId})` : ""}
- البنك: ${lc.bankName || "—"}
- العملة الأصلية: ${lc.currencyCode}
- سعر الصرف: ${lcRate}  (1 ${lc.currencyCode} = ${lcRate} ${baseCurrency})
- قيمة الاعتماد الأصلية: ${Number(lc.totalAmount)} ${lc.currencyCode}
- قيمة الاعتماد بالعملة الأساسية: ${lcTotalBase} ${baseCurrency}  ← استخدم هذه القيمة في القيد

مصاريف الاستيراد (الأرقام بعد علامة "=" هي القيم بالعملة الأساسية ${baseCurrency} وهي التي تُستخدم في القيد):
${expList}

إجمالي المصاريف بالعملة الأساسية: ${expensesBase.reduce((s, e) => s + e.amountBase, 0).toFixed(2)} ${baseCurrency}

شجرة الحسابات المتاحة (استخدم id الرقمي فقط):
${accountList}

المبادئ المحاسبية لفتح الاعتماد المستندي:
1) عند فتح الاعتماد: مدين "اعتمادات مستندية" أو "بضاعة بالطريق" بقيمة الاعتماد بالعملة الأساسية، دائن "البنك" أو "هامش اعتماد" بنفس القيمة.
2) كل مصروف استيراد: مدين الحساب المحدد له (أو حساب "مصاريف استيراد") بقيمة المصروف بالعملة الأساسية، دائن "البنك" أو "الموردون" بنفس القيمة.
3) اختر أنسب حساب موجود فعلياً في القائمة؛ لا تخترع أرقاماً.
4) يجب أن يكون مجموع المدين = مجموع الدائن بالضبط، وكلها بالعملة الأساسية ${baseCurrency}.

أرجع JSON فقط بالشكل التالي (بدون أي نص قبله أو بعده):
{
  "description": "<وصف عربي مختصر للقيد>",
  "lines": [
    {"accountId": <id>, "debit": <رقم>, "credit": 0, "description": "<وصف مختصر>"},
    {"accountId": <id>, "debit": 0, "credit": <رقم>, "description": "<وصف مختصر>"}
  ],
  "reasoning": "<شرح موجز بالعربية لاختيار الحسابات>"
}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    let aiRes: any;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت محاسب سعودي. أعد JSON صالحاً فقط بدون أي نص إضافي." },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const msg = e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي";
      res.status(502).json({ error: msg }); return;
    }
    clearTimeout(timer);
    if (!aiRes.ok) { res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي" }); return; }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    const rawLines: any[] = Array.isArray(parsed.lines) ? parsed.lines : [];
    const accMap = new Map(postable.map(a => [a.id, a]));
    const linesValidated = rawLines
      .map(l => ({
        accountId: Number(l.accountId) || null,
        debit:  Math.max(0, Number(l.debit  || 0)),
        credit: Math.max(0, Number(l.credit || 0)),
        description: String(l.description || "").slice(0, 200),
      }))
      .filter(l => l.accountId && accMap.has(l.accountId) && (l.debit > 0 || l.credit > 0));

    if (linesValidated.length < 2) {
      res.status(422).json({ error: "الذكاء الاصطناعي لم يُنتج قيداً صالحاً", raw: parsed }); return;
    }
    const totalDebit  = linesValidated.reduce((s, l) => s + l.debit,  0);
    const totalCredit = linesValidated.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(422).json({ error: `القيد غير متوازن: ${totalDebit.toFixed(2)} ≠ ${totalCredit.toFixed(2)}`, preview: { lines: linesValidated } });
      return;
    }

    const linesOut = linesValidated.map(l => {
      const a = accMap.get(l.accountId!)!;
      return { ...l, accountCode: a.code, accountNameAr: a.nameAr };
    });
    const description = String(parsed.description || `قيد اعتماد مستندي ${lc.lcNumber}`).slice(0, 300);
    const reasoning = String(parsed.reasoning || "").slice(0, 1000);

    if (!save) {
      res.json({ preview: true, description, reasoning, lines: linesOut, totalDebit, totalCredit });
      return;
    }

    const entryId = await createJournalEntry({
      companyId: cid,
      audit: { req },
      date: lc.lcDate,
      description,
      docNumber: `LC-${lc.lcNumber}`,
      entryType: "general",
      exchangeRate: "1",
      lines: linesValidated.map(l => ({
        accountId: l.accountId,
        debit:  l.debit,
        credit: l.credit,
        description: l.description,
      })),
    });
    res.json({ saved: true, entryId, description, reasoning, lines: linesOut, totalDebit, totalCredit });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ── AI explanation for Letters of Credit ───────────────────────────────
router.post("/letters-of-credit/ai-explain", requireAiFeature("account_suggestions"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const lc = req.body?.lc ?? {};
    const expenses: any[] = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
    const supplierName = String(req.body?.supplierName ?? "—");

    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY  = "AI_PROXY";
    if (!isAIAvailable()) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    const totalAmt = Number(lc.totalAmount || 0);
    const totalExp = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const remaining = totalAmt - totalExp;
    const expList = expenses.length
      ? expenses.map((e, i) => `  ${i + 1}) ${e.expenseType || "—"} — ${Number(e.amount || 0)} ${e.currencyCode || "SAR"}`).join("\n")
      : "  (لا توجد مصاريف مسجلة)";

    const prompt = `أنت خبير في التمويل التجاري والاعتمادات المستندية (Letter of Credit) في المملكة العربية السعودية.
اشرح للمستخدم هذا الاعتماد المستندي بلغة عربية واضحة وبسيطة، ثم قدّم توصيات عملية.

بيانات الاعتماد:
- رقم الاعتماد: ${lc.lcNumber || "—"}
- التاريخ: ${lc.lcDate || "—"}
- المورد: ${supplierName}
- البنك: ${lc.bankName || "—"}
- العملة: ${lc.currencyCode || "SAR"}
- قيمة الاعتماد: ${totalAmt}
- إجمالي المصاريف المسجلة: ${totalExp}
- المتبقي: ${remaining}
- ملاحظات: ${lc.notes || "—"}

مصاريف الاستيراد المرتبطة:
${expList}

أرجع JSON فقط بالشكل:
{
  "summary": "<فقرة قصيرة 2-3 أسطر تشرح ما هو الاعتماد المستندي بشكل عام>",
  "currentState": "<تحليل مختصر للحالة الحالية لهذا الاعتماد — مفتوح/مستخدم جزئياً/مغلق وما الذي يعنيه ذلك>",
  "expensesInsight": "<ملاحظات على توزيع المصاريف وما قد يكون ناقصاً (شحن/جمارك/تأمين/رسوم بنكية)>",
  "recommendations": ["<توصية عملية 1>", "<توصية عملية 2>", "<توصية عملية 3>"]
}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let aiRes: any;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت مستشار تمويل تجاري. أعد JSON صالحاً فقط بالعربية." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const msg = e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي";
      res.status(502).json({ error: msg });
      return;
    }
    clearTimeout(timer);
    if (!aiRes.ok) { res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي" }); return; }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    res.json({
      summary: String(parsed.summary || "").slice(0, 2000),
      currentState: String(parsed.currentState || "").slice(0, 2000),
      expensesInsight: String(parsed.expensesInsight || "").slice(0, 2000),
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 8).map((r: any) => String(r).slice(0, 500))
        : [],
    });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

export default router;
