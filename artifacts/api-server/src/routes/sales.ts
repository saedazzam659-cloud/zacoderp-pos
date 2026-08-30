import { Router } from "express";
import { canPostDoc, requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { randomUUID } from "node:crypto";
import { db, getActiveExternalDb } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { checkItemsUsable, usageViolationMessage } from "../lib/itemUsageControl.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import {
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  salesQuotationsTable, salesQuotationLinesTable,
  salesOrdersTable, salesOrderLinesTable,
  customerSettlementsTable, stockBalanceTable, stockLedgerTable,
  companiesTable, currenciesTable,
  customersTable, cashBoxesTable, bankAccountsTable, warehousesTable,
  journalEntriesTable, journalEntryLinesTable,
  receiptVouchersTable, paymentVouchersTable,
  salesRepsTable, offersTable,
  goodsDeliveriesTable,
  subscriptionsTable,
  itemsTable,
  itemUnitPricesTable,
  posSessionsTable,
  itemBrandsTable,
  brandsTable,
  accountsTable,
} from "@workspace/db";
import { getDeliveryClearingAccountId } from "./goodsDeliveries.js";
import { eq, and, asc, desc, sql, inArray, isNull, count, gte, lte, ilike, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread, branchScopeFilter, multiBranchScopeSpread, intersectBranchRequest } from "../middleware/auth.js";
import { isMobileChannel, mobilePermAllowed } from "../lib/mobilePerms.js";
import { requireMobilePerm } from "../lib/mobileGuard.js";
import { usersTable } from "@workspace/db";
import { resolveTaxRate } from "../lib/companyTaxes.js";
import { canAccessModule, pathRbac, requireAdminRole } from "../middleware/permissions.js";
import {
  upsertBalance,
  getBalance,
  addStockLedgerEntry,
  allocateBatchPicks,
  readBatchRemainingBulk,
  type BatchPick,
} from "../lib/stockHelpers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { nextSequenceNumber, nextSequenceForPayment, nextPosStationNumber, resolveJeNumber, reserveJeNumberFromEntry } from "../lib/sequences.js";
import { itemNamesDescription } from "../lib/journalLineDescriptions.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { assertInvoiceEditKeepsSettlementsCovered } from "../lib/invoiceSettlement.js";
import { buildSignedZatcaInvoice } from "../lib/zatca-build-signed.js";
import { salesInvoiceRowToZatcaData, salesReturnRowToZatcaData } from "../lib/zatca-sales-mapper.js";
import { getZatcaBaseUrl, resolveZatcaEnv, GENESIS_HASH, csidEnvMismatchMessage } from "../lib/zatca-env.js";
import { boundedOffsetPage } from "../lib/boundedPagination.js";
import { logger } from "../lib/logger.js";
import { getAgentDbPoolStats } from "../lib/agentDb.js";
import { ensureCustomerLedger } from "../lib/entityAccounts.js";
import { assertZatcaSubmissionAllowed, resolveZatcaChain, withZatcaChainLock } from "../lib/zatcaRegistrationTransfer.js";
import {
  admitInvoiceAcceleration,
  getInvoiceAccelerationMode,
  recordInvoiceSampleOnFinish,
} from "../lib/agentInvoiceAcceleration.js";

type AgentInvoiceTiming = {
  mark: (stage: string) => void;
  setLineCount: (count: number) => void;
  completeBusinessOutcome: (status: number) => void;
};

type AgentInvoiceTimingStart = {
  timing: AgentInvoiceTiming | null;
  accelerated: boolean;
  blockedReason: string | null;
};

function postgresErrorField(error: any, field: string): unknown {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    if (current[field] != null) return current[field];
  }
  return undefined;
}

function salesInvoiceWriteError(error: any): { status: number; message: string } {
  const code = String(postgresErrorField(error, "code") ?? "");
  const constraint = String(
    postgresErrorField(error, "constraint_name")
      ?? postgresErrorField(error, "constraint")
      ?? "",
  );
  const causeMessage = String(postgresErrorField(error?.cause, "message") ?? "");
  const outerMessage = String(error?.message ?? "");
  const safeOuterMessage = /^Failed query:/i.test(outerMessage) ? "" : outerMessage;
  if (code === "23503") {
    return {
      status: 409,
      message: `تعذر حفظ فاتورة المبيعات لأن أحد الارتباطات القديمة غير موجود بعد الاستعادة${constraint ? ` (${constraint})` : ""}. حدّث الصفحة وأعد اختيار العميل ثم حاول مجدداً.`,
    };
  }
  if (code === "23505") {
    return {
      status: 409,
      message: constraint.includes("pkey")
        ? "تعذر حفظ الفاتورة بسبب تعارض رقم داخلي بعد الاستعادة. تمت محاولة إصلاح العداد؛ أعد المحاولة."
        : "رقم فاتورة المبيعات مستخدم مسبقاً بعد الاستعادة. راجع إعدادات تسلسل فواتير المبيعات.",
    };
  }
  if (code === "42703") {
    return {
      status: 503,
      message: `مخطط قاعدة بيانات KARM غير مكتمل التحديث${causeMessage ? `: ${causeMessage}` : ""}`,
    };
  }
  return {
    status: Number(error?.status) || 500,
    message: causeMessage || safeOuterMessage || "تعذر حفظ فاتورة المبيعات بسبب خطأ في قاعدة البيانات",
  };
}

function salesReturnWriteError(error: any): { status: number; message: string } {
  const classified = salesInvoiceWriteError(error);
  return {
    ...classified,
    message: classified.message
      .replaceAll("فاتورة المبيعات", "مرتجع المبيعات")
      .replaceAll("الفاتورة", "المرتجع")
      .replaceAll("فاتورة", "مرتجع"),
  };
}

async function beginAgentInvoiceTiming(
  req: any,
  res: any,
  operation: "create" | "update" | "post",
  lineCount: number,
): Promise<AgentInvoiceTimingStart> {
  const agentId = Number(req?.agentDomainHit?.id);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return { timing: null, accelerated: false, blockedReason: null };
  }
  // Never let an agent-domain invoice write fall through to the central
  // business database, even if another API replica has a stale host-mode cache.
  if (!getActiveExternalDb()) {
    return {
      timing: null,
      accelerated: false,
      blockedReason: "قاعدة بيانات الوكيل غير جاهزة — تم إيقاف الطلب لحماية البيانات من الكتابة في القاعدة المركزية",
    };
  }
  const logEnabled = process.env.AGENT_INVOICE_TIMING_LOG !== "0"
    && process.env.AGENT_INVOICE_TIMING_LOG !== "false";
  // Install this before central admission: close can fire while admission is
  // awaited, and EventEmitter will not replay it to the recorder added later.
  let responseClosedBeforeRecorder = !!res.destroyed && !res.writableFinished;
  res.once("close", () => {
    if (!res.writableFinished) responseClosedBeforeRecorder = true;
  });
  const startedAt = Date.now();
  let previousAt = startedAt;
  let observedLineCount = lineCount;
  const stages: Record<string, number> = {};
  const poolStart = getAgentDbPoolStats(agentId);
  let accelerationMode = getInvoiceAccelerationMode(req);
  let accelerated = false;
  let trialStartAt: Date | null = null;
  let trialClaimId: number | null = null;
  const controlPlaneAdmissionRequired = (operation === "create" || operation === "update")
    && (accelerationMode === "trial" || accelerationMode === "on");
  if (controlPlaneAdmissionRequired) {
    try {
      const admission = await admitInvoiceAcceleration(agentId, operation, {
        mode: accelerationMode as "trial" | "on",
        generation: Number.isInteger(req?.agentDomainHit?.accelerationRequestGeneration)
          ? req.agentDomainHit.accelerationRequestGeneration
          : null,
      });
      accelerationMode = admission.mode;
      accelerated = admission.accelerated;
      trialStartAt = admission.trialStartAt;
      trialClaimId = admission.trialClaimId;
      stages["central-admission"] = Date.now() - startedAt;
      previousAt = Date.now();
    } catch (err) {
      logger.warn({ err, agentId, operation }, "Agent invoice acceleration admission failed closed");
      return {
        timing: null,
        accelerated: false,
        blockedReason: "تعذّر التحقق من حالة تسريع الوكيل — أُوقف الطلب بأمان ولم تُكتب أي بيانات",
      };
    }
  }

  const recorder = recordInvoiceSampleOnFinish(res, {
    agentId,
    operation,
    accelerated,
    get totalMs() { return Date.now() - startedAt; },
    get stages() { return { ...stages }; },
    get lineCount() { return observedLineCount; },
    poolStart,
    get poolEnd() { return getAgentDbPoolStats(agentId); },
  }, trialStartAt, trialClaimId, responseClosedBeforeRecorder || (!!res.destroyed && !res.writableFinished));

  if (logEnabled) {
    res.once("finish", () => {
      logger.info({
        agentId,
        operation,
        accelerationMode,
        accelerated,
        statusCode: res.statusCode,
        lineCount: observedLineCount,
        totalMs: Date.now() - startedAt,
        stages,
        poolStart,
        poolEnd: getAgentDbPoolStats(agentId),
      }, "Agent sales invoice timing");
    });
  }
  return {
    timing: {
      mark(stage: string) {
        const now = Date.now();
        stages[stage] = now - previousAt;
        previousAt = now;
      },
      setLineCount(count: number) {
        observedLineCount = count;
      },
      completeBusinessOutcome(status: number) {
        recorder.completeBusinessOutcome(status);
      },
    },
    accelerated,
    blockedReason: null,
  };
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

type CapturedRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Attach a rejection handler immediately to every speculative read. This lets
 * the accelerated agent path overlap independent WAN database round-trips
 * without creating unhandled rejections, while `readCaptured` still rethrows
 * failures in the same business-validation order as the legacy path.
 */
function captureRead<T>(promise: PromiseLike<T>): Promise<CapturedRead<T>> {
  return Promise.resolve(promise).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  );
}

async function readCaptured<T>(captured: Promise<CapturedRead<T>>): Promise<T> {
  const result = await captured;
  if (!result.ok) throw result.error;
  return result.value;
}

function usesAcceleratedAgentInvoicePath(timingStart: AgentInvoiceTimingStart): boolean {
  return timingStart.accelerated;
}

function invoiceLinesFingerprint(lines: Array<Record<string, any>>): string {
  return JSON.stringify(
    lines
      .map((line) => [
        line.id,
        line.itemId,
        line.warehouseId,
        line.qty,
        line.freeQty,
        line.conversionFactor,
        line.unitPrice,
        line.discount,
        line.discountAmount,
        line.vatRate,
        line.lineTotal,
        line.costCenter,
        line.appliedOfferId,
      ])
      .sort((a, b) => Number(a[0] ?? 0) - Number(b[0] ?? 0)),
  );
}

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
  // Stable source-document identity used to RESERVE+REUSE the JE number across
  // an unpost→edit→repost cycle (e.g. "sales_invoice" + invoice id). When
  // omitted, the JE simply draws the next number with no reuse.
  sourceType?: string;
  sourceId?: number;
  lines: JLine[];
  executor?: any;
}): Promise<number> {
  const executor = opts.executor ?? db;
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
    dx:         executor,
  });
  const jeDocNumber = seqDocNumber ?? (opts.docNumber ?? null);
  const proposedAccountIds = [...new Set(cleanLines.map(line => line.accountId!).filter(Boolean))];
  const ownedAccountRows = proposedAccountIds.length
    ? await executor.select({ id: accountsTable.id }).from(accountsTable).where(and(
        eq(accountsTable.companyId, opts.companyId),
        inArray(accountsTable.id, proposedAccountIds),
      ))
    : [];
  const ownedAccountIds = new Set(ownedAccountRows.map((row: { id: number }) => row.id));
  const invalidAccountIds = proposedAccountIds.filter(id => !ownedAccountIds.has(id));
  if (invalidAccountIds.length) {
    throw Object.assign(
      new Error(
        `تعذّر ترحيل القيد: توجد حسابات محاسبية مستعادة لا تخص الشركة الحالية (${invalidAccountIds.join(", ")}). أعد تطبيق الربط المحاسبي الافتراضي ثم حاول مجددًا.`,
      ),
      { status: 400 },
    );
  }
  const [entry] = await executor.insert(journalEntriesTable).values({
    companyId: opts.companyId, branchId: opts.branchId ?? null,
    docNumber: jeDocNumber, entryDate: opts.date,
    currency: "SAR", exchangeRate: opts.exchangeRate ?? "1",
    description: opts.description, entryType: opts.entryType ?? "general",
    status: jeStatus,
    periodId: writability.period?.id ?? null,
    ...auditFields,
  }).returning();
  await executor.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId: entry.id, accountId: l.accountId!,
      debit: String((l.debit ?? 0).toFixed(2)),
      credit: String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description, sortOrder: i,
      // Persist cost-center code (text) so cost-center reports pick it up.
      // Per-line override wins; header-level value applies otherwise.
      // An EXPLICIT `costCenter: null` on a line (e.g. VAT lines) opts OUT of
      // the header fallback — only `undefined` falls back.
      costCenter: l.costCenter !== undefined ? (l.costCenter || null) : (opts.costCenter ?? null),
    }))
  );
  return entry.id;
}

async function getCustomerAccountId(
  cid: number,
  customerId: number | null | undefined,
  executor: any = db,
): Promise<number | null> {
  if (!customerId) return null;
  const [c] = await executor.select().from(customersTable)
    .where(and(eq(customersTable.id, customerId), eq(customersTable.companyId, cid)));
  if (!c) return null;

  if (c.accountId) {
    const [ownedAccount] = await executor.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, c.accountId), eq(accountsTable.companyId, cid)));
    if (ownedAccount) return ownedAccount.id;
  }

  // Cross-company backups can carry the source company's customer.account_id.
  // Re-mint/reuse the customer's ledger under the target company's AR parent,
  // then persist the repaired link in the same posting transaction.
  const repairedAccountId = await ensureCustomerLedger(cid, c.nameAr, false, undefined, executor);
  if (!repairedAccountId) return null;
  await executor.update(customersTable)
    .set({ accountId: repairedAccountId, updatedAt: new Date() })
    .where(and(eq(customersTable.id, c.id), eq(customersTable.companyId, cid)));
  return repairedAccountId;
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
type WarehouseInfo = {
  accountId: number | null;
  allowNegative: boolean;
  negativeLimit: number | null;
  nameAr: string | null;
};

async function loadWarehouseInfo(cid: number, ids: number[]): Promise<Record<number, WarehouseInfo>> {
  const out: Record<number, any> = {};
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return out;
  const rows = await db.select({
    id: warehousesTable.id,
    accountId: warehousesTable.accountId,
    allowNegative: warehousesTable.allowNegative,
    negativeLimit: warehousesTable.negativeLimit,
    nameAr: warehousesTable.nameAr,
  }).from(warehousesTable)
    .where(and(eq(warehousesTable.companyId, cid), inArray(warehousesTable.id, uniq)));
  for (const w of rows) {
    out[w.id] = {
      accountId: w.accountId ?? null,
      allowNegative: !!w.allowNegative,
      negativeLimit: w.negativeLimit == null ? null : Number(w.negativeLimit),
      nameAr: w.nameAr ?? null,
    };
  }
  return out;
}

type StockSnapshot = { id: number; qty: number; avgCost: number };

async function loadStockSnapshots(
  cid: number,
  pairs: Array<{ itemId: number; warehouseId: number }>,
  executor: any = db,
  forUpdate = false,
): Promise<Map<string, StockSnapshot>> {
  const requested = new Set(
    pairs
      .filter((p) => Number.isInteger(p.itemId) && Number.isInteger(p.warehouseId))
      .map((p) => `${p.itemId}:${p.warehouseId}`),
  );
  const out = new Map<string, StockSnapshot>();
  if (!requested.size) return out;
  const tuples = [...requested].map((key) => {
    const [itemId, warehouseId] = key.split(":").map(Number);
    return sql`(${itemId}::integer, ${warehouseId}::integer)`;
  });
  const result = await executor.execute(sql`
    WITH requested(item_id, warehouse_id) AS (
      VALUES ${sql.join(tuples, sql`, `)}
    )
    SELECT
      balance.id AS "id",
      balance.item_id AS "itemId",
      balance.warehouse_id AS "warehouseId",
      balance.qty AS "qty",
      balance.avg_cost AS "avgCost"
    FROM stock_balance AS balance
    JOIN requested
      ON requested.item_id = balance.item_id
     AND requested.warehouse_id = balance.warehouse_id
    WHERE balance.company_id = ${cid}
    ${forUpdate ? sql`FOR UPDATE OF balance` : sql``}
  `);
  const rows = queryRows<{
    id: number;
    itemId: number;
    warehouseId: number;
    qty: string;
    avgCost: string;
  }>(result);
  for (const row of rows) {
    const key = `${row.itemId}:${row.warehouseId}`;
    out.set(key, { id: row.id, qty: Number(row.qty ?? 0), avgCost: Number(row.avgCost ?? 0) });
  }
  return out;
}

async function lockStockPairs(
  cid: number,
  pairKeys: string[],
  executor: any,
): Promise<void> {
  const keys = [...new Set(pairKeys)].sort();
  if (!keys.length) return;
  const tuples = keys.map((key) => sql`(${key}::text)`);
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(${cid}::integer, hashtext(ordered.lock_key))
    FROM (
      SELECT lock_key
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS requested(lock_key)
      ORDER BY lock_key
    ) AS ordered
  `);
}

type StockBalanceDelta = {
  itemId: number;
  warehouseId: number;
  deltaQty: number;
  costPrice: number;
};

async function applyStockBalanceDeltasBulk(
  cid: number,
  deltas: StockBalanceDelta[],
  snapshots: Map<string, StockSnapshot>,
  executor: any,
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  if (!deltas.length) return balances;

  const existing = deltas.filter((delta) => snapshots.has(`${delta.itemId}:${delta.warehouseId}`));
  if (existing.length) {
    const tuples = existing.map((delta) => sql`
      (${delta.itemId}::integer, ${delta.warehouseId}::integer, ${delta.deltaQty}::numeric)
    `);
    const result = await executor.execute(sql`
      WITH deltas(item_id, warehouse_id, delta_qty) AS (
        VALUES ${sql.join(tuples, sql`, `)}
      )
      UPDATE stock_balance AS balance
      SET
        qty = balance.qty + deltas.delta_qty,
        updated_at = NOW()
      FROM deltas
      WHERE balance.company_id = ${cid}
        AND balance.item_id = deltas.item_id
        AND balance.warehouse_id = deltas.warehouse_id
      RETURNING
        balance.item_id AS "itemId",
        balance.warehouse_id AS "warehouseId",
        balance.qty AS "qty"
    `);
    for (const row of queryRows<{ itemId: number; warehouseId: number; qty: string }>(result)) {
      balances.set(`${Number(row.itemId)}:${Number(row.warehouseId)}`, Number(row.qty));
    }
  }

  const missing = deltas.filter((delta) => !snapshots.has(`${delta.itemId}:${delta.warehouseId}`));
  if (missing.length) {
    const inserted = await executor.insert(stockBalanceTable).values(
      missing.map((delta) => ({
        companyId: cid,
        itemId: delta.itemId,
        warehouseId: delta.warehouseId,
        qty: String(delta.deltaQty),
        avgCost: String(delta.costPrice),
      })),
    ).returning({
      itemId: stockBalanceTable.itemId,
      warehouseId: stockBalanceTable.warehouseId,
      qty: stockBalanceTable.qty,
    });
    for (const row of inserted) {
      balances.set(`${row.itemId}:${row.warehouseId}`, Number(row.qty));
    }
  }

  return balances;
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

export function effectiveLineDiscount(line: any, gross: number): number {
  const fixed = Math.max(0, Number(line?.discountAmount) || 0);
  if (fixed > 0) return Math.min(gross, fixed);
  const pct = Math.max(0, Math.min(100, Number(line?.discount) || 0));
  return Math.min(gross, gross * pct / 100);
}

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// Authoritative capability probe for the invoice overdraft control.
// The UI must not infer this sensitive grant from a possibly stale user object:
// the same backend predicate that protects create/update/post answers here.
router.get("/sales-invoices/overdraft-capability", (req, res) => {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  res.json({
    view: canAccessModule(req.authUser, "sales_invoice_overdraft", "view"),
    edit: canAccessModule(req.authUser, "sales_invoice_overdraft", "edit"),
  });
});

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
    const paged = String(req.query.paged ?? "") === "1";
    const emptyPaged = {
      items: [],
      page: 1,
      pageSize: 10,
      total: 0,
      pageCount: 1,
      summary: { totalInvoices: 0, postedInvoices: 0, draftInvoices: 0, totalPostedAmount: 0 },
    };
    if (!cid) { res.json(paged ? emptyPaged : []); return; }
    // Source filter — separates POS-originated invoices from manually-entered ones.
    // Default `manual` hides POS rows so the Sales Invoices screen stays clean
    // (POS invoices live under POS Operations). Pass `?source=all` to see both
    // or `?source=pos` to filter to POS only.
    const source = String(req.query.source ?? "manual").toLowerCase();
    const sourceFilter =
      source === "pos"    ? [sql`${salesInvoicesTable.posSessionId} IS NOT NULL`] :
      source === "manual" ? [sql`${salesInvoicesTable.posSessionId} IS NULL`] :
      [];
    const baseWhere = and(
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
    );

    let rows: (typeof salesInvoicesTable.$inferSelect)[];
    let pageMeta: {
      page: number;
      pageSize: number;
      total: number;
      pageCount: number;
      accessibleTotal: number;
      truncated: boolean;
      summary: {
        totalInvoices: number;
        postedInvoices: number;
        draftInvoices: number;
        totalPostedAmount: number;
      };
    } | null = null;

    if (paged) {
      const rawPage = Number(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page);
      const rawPageSize = Number(Array.isArray(req.query.pageSize) ? req.query.pageSize[0] : req.query.pageSize);
      // A deliberately small ceiling keeps the settlement/line enrichment
      // bounded even when a caller supplies an abusive pageSize.
      const pageSize = Math.min(
        100,
        Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.floor(rawPageSize) : 10,
      );
      // Offset paging is retained for the existing table UI, but the offset
      // itself is bounded so a hostile/deep page cannot force an arbitrarily
      // expensive scan or overflow PostgreSQL's OFFSET.
      const maxPage = Math.floor(100_000 / pageSize) + 1;
      let page = Math.min(
        maxPage,
        Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1,
      );
      const statusRaw = String(req.query.status ?? "all").toLowerCase();
      const status = statusRaw === "draft" || statusRaw === "posted" || statusRaw === "cancelled"
        ? statusRaw
        : null;
      const search = String(req.query.search ?? "").trim().slice(0, 100);
      const searchPattern = `%${search}%`;
      const dateFromRaw = String(req.query.dateFrom ?? "");
      const dateToRaw = String(req.query.dateTo ?? "");
      const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(dateFromRaw) ? dateFromRaw : null;
      const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(dateToRaw) ? dateToRaw : null;
      const rawWarehouseId = Number(req.query.warehouseId);
      const warehouseId = Number.isInteger(rawWarehouseId) && rawWarehouseId > 0 ? rawWarehouseId : null;
      const listWhere = and(
        baseWhere,
        status ? eq(salesInvoicesTable.status, status) : undefined,
        dateFrom ? gte(salesInvoicesTable.invoiceDate, dateFrom) : undefined,
        dateTo ? lte(salesInvoicesTable.invoiceDate, dateTo) : undefined,
        warehouseId
          ? sql`exists (
              select 1
              from ${salesInvoiceLinesTable}
              where ${salesInvoiceLinesTable.invoiceId} = ${salesInvoicesTable.id}
                and ${salesInvoiceLinesTable.warehouseId} = ${warehouseId}
            )`
          : undefined,
        search
          ? or(
              ilike(salesInvoicesTable.docNumber, searchPattern),
              ilike(salesInvoicesTable.notes, searchPattern),
              // Correlated EXISTS keeps customer-name search inside PostgreSQL.
              // It avoids materialising a potentially huge customer-id array
              // in Node when the user types a common Arabic character.
              sql`exists (
                select 1
                from ${customersTable}
                where ${customersTable.id} = ${salesInvoicesTable.customerId}
                  and ${customersTable.companyId} = ${cid}
                  and (
                    ${ilike(customersTable.nameAr, searchPattern)}
                    or ${ilike(customersTable.nameEn, searchPattern)}
                    or ${ilike(customersTable.vatNumber, searchPattern)}
                    or ${ilike(customersTable.phone, searchPattern)}
                    or ${ilike(customersTable.city, searchPattern)}
                    or ${ilike(customersTable.district, searchPattern)}
                    or cast(${customersTable.id} as text) ilike ${searchPattern}
                  )
              )`,
            )
          : undefined,
      );

      let [pageRows, totalRows, summaryRows] = await Promise.all([
        db.select().from(salesInvoicesTable)
          .where(listWhere)
          .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db.select({ value: count() }).from(salesInvoicesTable).where(listWhere),
        db.select({
          totalInvoices: sql<number>`count(*)::int`,
          postedInvoices: sql<number>`count(*) filter (where ${salesInvoicesTable.status} = 'posted')::int`,
          draftInvoices: sql<number>`count(*) filter (where ${salesInvoicesTable.status} = 'draft')::int`,
          totalPostedAmount: sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}) filter (where ${salesInvoicesTable.status} = 'posted'), 0)`,
        }).from(salesInvoicesTable).where(baseWhere),
      ]);

      const total = Number(totalRows[0]?.value ?? 0);
      const bounded = boundedOffsetPage(total, page, pageSize);
      if (bounded.page !== page) {
        page = bounded.page;
        pageRows = await db.select().from(salesInvoicesTable)
          .where(listWhere)
          .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
      }
      rows = pageRows;
      const summary = summaryRows[0];
      pageMeta = {
        page,
        pageSize,
        total,
        pageCount: bounded.pageCount,
        accessibleTotal: bounded.accessibleTotal,
        truncated: bounded.truncated,
        summary: {
          totalInvoices: Number(summary?.totalInvoices ?? 0),
          postedInvoices: Number(summary?.postedInvoices ?? 0),
          draftInvoices: Number(summary?.draftInvoices ?? 0),
          totalPostedAmount: Number(summary?.totalPostedAmount ?? 0),
        },
      };
    } else {
      // Backwards-compatible mode for POS, mobile, voucher pickers, and sales
      // returns. These consumers still expect a bare Array response.
      rows = await db.select().from(salesInvoicesTable)
        .where(baseWhere)
        .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id));
    }

    const respond = (items: unknown[]) => {
      res.json(pageMeta ? { items, ...pageMeta } : items);
    };

    // Resolve usernames for createdById / postedById in one pass so the grid
    // can render "أنشأه" / "رحّله" columns without an extra round trip.
    const auditUserIds = Array.from(new Set(
      rows.flatMap(r => [r.createdById, r.postedById])
        .filter((x): x is number => typeof x === "number")
    ));
    const auditUserMap = new Map<number, string>();
    const pageCustomerIds = pageMeta
      ? Array.from(new Set(rows.map((row) => row.customerId).filter((id): id is number => id != null)))
      : [];
    const [auditUsers, pageCustomers] = await Promise.all([
      auditUserIds.length
        ? db.select({ id: usersTable.id, username: usersTable.username })
            .from(usersTable).where(inArray(usersTable.id, auditUserIds))
        : Promise.resolve([]),
      pageCustomerIds.length
        ? db.select({
            id: customersTable.id,
            nameAr: customersTable.nameAr,
            nameEn: customersTable.nameEn,
            vatNumber: customersTable.vatNumber,
            phone: customersTable.phone,
            city: customersTable.city,
            district: customersTable.district,
          })
            .from(customersTable)
            .where(and(
              eq(customersTable.companyId, cid),
              inArray(customersTable.id, pageCustomerIds),
            ))
        : Promise.resolve([]),
    ]);
    for (const u of auditUsers) auditUserMap.set(u.id, u.username);
    const pageCustomerMap = new Map(pageCustomers.map((customer) => [customer.id, customer] as const));
    const enrichedRows = rows.map(r => ({
      ...r,
      createdByName: r.createdById != null ? (auditUserMap.get(r.createdById) ?? null) : null,
      postedByName:  r.postedById  != null ? (auditUserMap.get(r.postedById)  ?? null) : null,
      ...(pageMeta ? {
        customerName: r.customerId != null
          ? (pageCustomerMap.get(r.customerId)?.nameAr || pageCustomerMap.get(r.customerId)?.nameEn || null)
          : null,
        customer: r.customerId != null ? (pageCustomerMap.get(r.customerId) ?? null) : null,
      } : {}),
    }));

    // Enrich each invoice with its latest linked receipt voucher so the
    // listing can show a "paid via cash/bank" badge in the side row. We
    // pull all linked vouchers for this tenant in a single query and
    // group in memory — cheap, and avoids N+1 even for large tenants.
    const ids = enrichedRows.map(r => r.id);
    if (ids.length === 0) { respond(enrichedRows); return; }
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
      qty:         salesInvoiceLinesTable.qty,
      freeQty:     salesInvoiceLinesTable.freeQty,
      unitPrice:   salesInvoiceLinesTable.unitPrice,
      discount:    salesInvoiceLinesTable.discount,
      discountAmount: salesInvoiceLinesTable.discountAmount,
    }).from(salesInvoiceLinesTable).where(inArray(salesInvoiceLinesTable.invoiceId, ids));
    const returnedRows = await db.selectDistinct({ invoiceId: salesReturnsTable.invoiceId })
      .from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        inArray(salesReturnsTable.invoiceId, ids),
      ));
    const returnedInvoiceIds = new Set(
      returnedRows.map((row) => row.invoiceId).filter((invoiceId): invoiceId is number => invoiceId != null),
    );
    const whByInvoice = new Map<number, Set<number>>();
    // Σ effective per-line discount (SAR) per invoice. Line discounts are
    // folded into the stored NET `subtotal` and NEVER surface on the header
    // `discountAmount` (which only holds the document-level discount), so the
    // audit grid needs this to (a) show the real total discount and (b)
    // reconstruct the GROSS subtotal. Mirrors `effectiveLineDiscount`:
    // amount wins when set (capped at gross), else derive from the percent.
    const lineDiscByInvoice = new Map<number, number>();
    // Σ free quantity (الكمية المجانية) per invoice for the audit-grid column.
    const freeQtyByInvoice = new Map<number, number>();
    for (const lw of lineWh) {
      if (!lw.invoiceId) continue;
      freeQtyByInvoice.set(lw.invoiceId, (freeQtyByInvoice.get(lw.invoiceId) ?? 0) + (Number(lw.freeQty) || 0));
      if (lw.warehouseId != null) {
        const s = whByInvoice.get(lw.invoiceId) ?? new Set<number>();
        s.add(Number(lw.warehouseId));
        whByInvoice.set(lw.invoiceId, s);
      }
      const gross = (Number(lw.qty) || 0) * (Number(lw.unitPrice) || 0);
      const amt = Math.max(0, Number(lw.discountAmount) || 0);
      const eff = amt > 0
        ? Math.min(amt, gross)
        : (gross * Math.max(0, Math.min(100, Number(lw.discount) || 0))) / 100;
      lineDiscByInvoice.set(lw.invoiceId, (lineDiscByInvoice.get(lw.invoiceId) ?? 0) + eff);
    }
    // حالة السداد الحقيقية (سندات + قيود سداد + روابط جزئية) — batch, no N+1.
    const { batchInvoiceSettlementStatus } = await import("../lib/invoiceSettlement.js");
    const payMap = await batchInvoiceSettlementStatus(cid, "sales", enrichedRows.map(r => ({
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
        warehouseIds: Array.from(whByInvoice.get(r.id) ?? []),
        lineDiscountTotal: (lineDiscByInvoice.get(r.id) ?? 0).toFixed(2),
        totalFreeQty: (freeQtyByInvoice.get(r.id) ?? 0),
        hasReturn: returnedInvoiceIds.has(r.id),
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
    respond(enriched);
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
    const [lines, customerRows] = await Promise.all([
      db.select().from(salesInvoiceLinesTable)
        .where(eq(salesInvoiceLinesTable.invoiceId, id))
        .orderBy(asc(salesInvoiceLinesTable.id)),
      inv.customerId != null
        ? db.select().from(customersTable)
            .where(and(
              eq(customersTable.id, inv.customerId),
              eq(customersTable.companyId, cid),
            ))
            .limit(1)
        : Promise.resolve([]),
    ]);
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
      customer: customerRows[0] ?? null,
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
    // item_name is NOT NULL — older mobile clients omit it, so fall back to
    // any provided display name and finally a generic label (never null).
    itemName:    String(l.itemName ?? l.name ?? (l.itemId != null ? `صنف ${l.itemId}` : "صنف")),
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
    // OPTIONAL per-line cost-center CODE — JE/reporting only, NEVER in ZATCA XML.
    costCenter:  l.costCenter ? String(l.costCenter).trim() || null : null,
    notes:       l.notes || null,
    // Audit trail link to the line-level promotion that produced this
    // discount / unit-price (line_pricing or buy_x_get_y). NULL when the
    // discount was manual or no offer matched.
    appliedOfferId: l.appliedOfferId ? Number(l.appliedOfferId) : null,
    // Brand (العلامة التجارية) — OPTIONAL, PRINT-ONLY. Snapshotted for display
    // on the invoice; NEVER emitted into the ZATCA UBL XML, hash, QR, or
    // ICV/PIH chain (the XML builder simply ignores these columns).
    brandId:   l.brandId ? Number(l.brandId) : null,
    brandName: l.brandName || null,
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

// Validates that every line's brandId (العلامة التجارية) belongs to this company
// AND is actually linked to that line's itemId in item_brands. A crafted payload
// could otherwise pin a foreign / non-canonical brand onto an invoice line and
// have its name printed back via the invoice GET. Brand is PRINT-ONLY (never in
// the ZATCA XML/QR/hash), so this is an integrity guard, not a ZATCA concern.
// Any line whose brandId fails validation is normalized to null in-place.
async function validateBrandLinesBelongToCompany(cid: number, lines: any[]) {
  if (!Array.isArray(lines) || !lines.length) return;
  const branded = lines.filter(l => l && l.brandId != null && l.brandId !== "");
  if (!branded.length) return;
  const brandIds = [...new Set(branded.map(l => Number(l.brandId)).filter(Number.isInteger))];
  if (!brandIds.length) return;
  const rows = await db.select({
      brandId: itemBrandsTable.brandId,
      itemId: itemBrandsTable.itemId,
      brandNameAr: brandsTable.nameAr,
    })
    .from(itemBrandsTable)
    .innerJoin(brandsTable, eq(brandsTable.id, itemBrandsTable.brandId))
    .where(and(inArray(itemBrandsTable.brandId, brandIds), eq(itemBrandsTable.companyId, cid)));
  // key `${brandId}:${itemId}` → canonical brand name (from the DB, not the client).
  const validPairs = new Map<string, string>();
  for (const r of rows) validPairs.set(`${r.brandId}:${r.itemId}`, r.brandNameAr ?? "");
  for (const l of branded) {
    const bid = Number(l.brandId);
    const iid = l.itemId ? Number(l.itemId) : null;
    const key = `${bid}:${iid}`;
    if (!Number.isInteger(bid) || iid == null || !validPairs.has(key)) {
      // Non-canonical / foreign brand → drop it silently rather than 400 the
      // whole invoice (brand is an optional cosmetic annotation).
      l.brandId = null;
      l.brandName = null;
    } else {
      // Canonicalize the print-only snapshot from the DB — never trust the
      // client-sent brandName (it is cosmetic and could be spoofed).
      l.brandName = validPairs.get(key) || null;
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
  // Month boundaries in Asia/Riyadh local time (UTC+3, no DST). Using
  // UTC here would shift the cutoff by 3 hours and falsely roll the
  // month over for invoices issued late at night in KSA.
  const nowKsa = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const yyyy = nowKsa.getUTCFullYear();
  const mm = String(nowKsa.getUTCMonth() + 1).padStart(2, "0");
  const periodStart = `${yyyy}-${mm}-01`;
  const lastDay = new Date(Date.UTC(yyyy, nowKsa.getUTCMonth() + 1, 0)).getUTCDate();
  const periodEnd = `${yyyy}-${mm}-${String(lastDay).padStart(2, "0")}`;
  // One round-trip instead of "latest subscription" then "invoice count".
  // On remote agent databases each serial query pays WAN latency, even when
  // both statements are individually fast inside PostgreSQL.
  const result = await db.execute(sql`
    SELECT
      COALESCE((
        SELECT max_invoices
        FROM subscriptions
        WHERE company_id = ${companyId}
        ORDER BY end_date DESC, id DESC
        LIMIT 1
      ), 1000000)::int AS "limit",
      EXISTS(
        SELECT 1 FROM subscriptions WHERE company_id = ${companyId}
      ) AS "hasSubscription",
      (
        SELECT COUNT(*)::int
        FROM sales_invoices
        WHERE company_id = ${companyId}
          AND invoice_date >= ${periodStart}
          AND invoice_date <= ${periodEnd}
      ) AS "used"
  `);
  const row = queryRows<{ limit?: unknown; used?: unknown; hasSubscription?: unknown }>(result)[0] ?? {};
  const limit = Number(row.limit ?? 1_000_000);
  const used = Number(row.used ?? 0);
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    hasSubscription: row.hasSubscription === true,
    periodStart,
    periodEnd,
  };
}

type OldestOutstandingCredit = {
  customerName: string;
  paymentTermsDays: number;
  invoiceDate: string;
  outstandingAmount: number;
};

export async function findOldestOutstandingCredit(
  companyId: number,
  customerId: number,
): Promise<OldestOutstandingCredit | null> {
  // Preserve the existing FIFO rule while reducing four serial reads
  // (customer → invoices → returns → receipts) to one PostgreSQL statement.
  const result = await db.execute(sql`
    WITH customer AS (
      SELECT
        name_ar AS "customerName",
        COALESCE(payment_terms_days, 0)::int AS "paymentTermsDays"
      FROM customers
      WHERE id = ${customerId}
        AND company_id = ${companyId}
        AND COALESCE(payment_terms_days, 0) > 0
    ),
    credits AS (
      SELECT
        COALESCE((
          SELECT SUM(total_amount)
          FROM sales_returns
          WHERE company_id = ${companyId}
            AND customer_id = ${customerId}
            AND status = 'posted'
            AND payment_type = 'credit'
        ), 0)::numeric
        +
        COALESCE((
          SELECT SUM(amount)
          FROM receipt_vouchers
          WHERE company_id = ${companyId}
            AND entity_type = 'customer'
            AND entity_id = ${customerId}
            AND status = 'posted'
        ), 0)::numeric AS credit
    ),
    prior AS (
      SELECT
        id,
        invoice_date AS "invoiceDate",
        total_amount::numeric AS total,
        COALESCE(
          SUM(total_amount::numeric) OVER (
            ORDER BY invoice_date ASC, id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ),
          0
        )::numeric AS "priorTotal"
      FROM sales_invoices
      WHERE company_id = ${companyId}
        AND customer_id = ${customerId}
        AND status = 'posted'
        AND payment_type = 'credit'
    )
    SELECT
      c."customerName",
      c."paymentTermsDays",
      p."invoiceDate",
      GREATEST(
        0,
        p.total - GREATEST(0, cr.credit - p."priorTotal")
      )::numeric AS "outstandingAmount"
    FROM customer c
    CROSS JOIN credits cr
    CROSS JOIN prior p
    WHERE cr.credit < p."priorTotal" + p.total
    ORDER BY p."invoiceDate" ASC, p.id ASC
    LIMIT 1
  `);
  const row = queryRows<{
    customerName?: unknown;
    paymentTermsDays?: unknown;
    invoiceDate?: unknown;
    outstandingAmount?: unknown;
  }>(result)[0];
  if (!row) return null;
  return {
    customerName: String(row.customerName ?? ""),
    paymentTermsDays: Number(row.paymentTermsDays ?? 0),
    invoiceDate: String(row.invoiceDate),
    outstandingAmount: Number(row.outstandingAmount ?? 0),
  };
}

// ─── Mobile-app rights gate (صلاحيات تطبيق الموبايل) ────────────────────────
// Applies ONLY to requests carrying `x-app-channel: mobile`. Web/API clients
// are untouched. Semantics: users.mobile_permissions NULL / missing key =
// allowed; explicit false = denied; admin/superadmin bypass.
//   invoice_create      → gates POST (creating a new sales invoice)
//   invoice_edit_price  → when denied, every line's unitPrice must equal the
//                         item's stored salePrice (±0.01 rounding tolerance)
//                         so a stale/patched app can't override prices.
// Returns true when the request may proceed; otherwise the response has
// already been sent (403/400).
async function enforceMobileSalesRights(
  req: any, res: any, cid: number, lines: any[] | undefined, action: "create" | "edit",
): Promise<boolean> {
  const ls = Array.isArray(lines) ? lines : [];
  if (ls.some((line: any) => {
    const freeQty = Number(line?.freeQty ?? 0);
    return !Number.isFinite(freeQty) || freeQty < 0;
  })) {
    res.status(400).json({ error: "الكمية المجانية يجب أن تكون صفراً أو أكبر" });
    return false;
  }
  const role = req.authUser?.role;
  if (role === "admin" || role === "superadmin") return true;
  const uid = Number(req.authUser?.id);
  if (!Number.isFinite(uid) || uid <= 0) return true; // no user context → other guards handle auth
  const [u] = await db.select({
    mobilePermissions: usersTable.mobilePermissions,
    role: usersTable.role,
    sessionChannel: usersTable.sessionChannel,
  })
    .from(usersTable)
    .where(and(eq(usersTable.id, uid), eq(usersTable.companyId, cid)));
  if (!u) return true;
  // Mobile is decided by the SESSION's opening channel (set at login), OR by
  // the per-request header — dropping the header on a mobile session cannot
  // un-bind enforcement.
  if (u.sessionChannel !== "mobile" && !isMobileChannel(req)) return true;
  req.resolvedMobileSalesContext = true;
  const holder = { role: u.role, mobilePermissions: u.mobilePermissions };
  if (action === "create" && !mobilePermAllowed(holder, "invoice_create")) {
    res.status(403).json({ error: "ليست لديك صلاحية إنشاء فاتورة من تطبيق الموبايل" });
    return false;
  }
  // The mobile client persists before calling /post, but "save draft" and
  // "save + issue" remain separate legacy save-intent controls. The actual
  // posting action is independently enforced by invoice_post in /post.
  const saveMode = req.body?.mobileSaveMode === "issue" ? "issue" : "draft";
  const savePerm = saveMode === "issue" ? "invoice_save_issue" : "invoice_save_draft";
  if (!mobilePermAllowed(holder, savePerm)) {
    res.status(403).json({
      error: saveMode === "issue"
        ? "ليست لديك صلاحية حفظ وإصدار الفاتورة من تطبيق الموبايل"
        : "ليست لديك صلاحية حفظ الفاتورة كمسودة من تطبيق الموبايل",
    });
    return false;
  }
  const unchangedProtectedUnitLines = new Set<any>();
  const protectedUnitPriceByLine = new Map<any, number>();
  // PUT replaces all line rows.  Before that happens, merge omitted protected
  // fields from the stored row and reject explicit changes.  Mobile clients
  // historically did not retain line ids, so match an id when available and
  // otherwise use item id + occurrence (the same stable order used by the
  // mobile form).  This prevents a stale client from changing a hidden field
  // without turning an omitted field into mapInvoiceLine's zero/null default.
  if (action === "edit" && ls.length) {
    const invoiceId = Number(req.params?.id);
    if (Number.isInteger(invoiceId) && invoiceId > 0) {
      const stored = await db.select({
        id: salesInvoiceLinesTable.id, itemId: salesInvoiceLinesTable.itemId,
        unitPrice: salesInvoiceLinesTable.unitPrice,
        freeQty: salesInvoiceLinesTable.freeQty, discount: salesInvoiceLinesTable.discount,
        discountAmount: salesInvoiceLinesTable.discountAmount, unitId: salesInvoiceLinesTable.unitId,
        unit: salesInvoiceLinesTable.unit, conversionFactor: salesInvoiceLinesTable.conversionFactor,
      }).from(salesInvoiceLinesTable).where(and(
        eq(salesInvoiceLinesTable.invoiceId, invoiceId), eq(salesInvoiceLinesTable.companyId, cid),
      )).orderBy(salesInvoiceLinesTable.id);
      const byId = new Map(stored.map((row) => [row.id, row]));
      const byItem = new Map<string, typeof stored>();
      for (const row of stored) {
        const key = String(row.itemId ?? "");
        byItem.set(key, [...(byItem.get(key) ?? []), row]);
      }
      const usedByItem = new Map<string, number>();
      const has = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
      const n = (v: any, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
      for (const [position, line] of ls.entries()) {
        const itemKey = String(line?.itemId ?? "");
        const occurrence = usedByItem.get(itemKey) ?? 0;
        usedByItem.set(itemKey, occurrence + 1);
        const old = byId.get(Number(line?.id)) ?? byItem.get(itemKey)?.[occurrence] ?? stored[position];
        if (!old) {
          // A new row on an edit has no stored value to merge.  It must still
          // obey field rights (otherwise adding a line would bypass the PUT
          // comparison above).
          if (!mobilePermAllowed(holder, "invoice_free_qty") && Math.abs(n(line?.freeQty)) > 0.0001) {
            res.status(403).json({ error: "ليست لديك صلاحية الكمية المجانية في الفاتورة من تطبيق الموبايل" }); return false;
          }
          if (!mobilePermAllowed(holder, "invoice_discount") &&
              (Math.abs(n(line?.discount)) > 0.0001 || Math.abs(n(line?.discountAmount)) > 0.0001)) {
            res.status(403).json({ error: "ليست لديك صلاحية خصم سطر الفاتورة من تطبيق الموبايل" }); return false;
          }
          if (!mobilePermAllowed(holder, "invoice_unit_selection") &&
              Math.abs(n(line?.conversionFactor, 1) - 1) > 0.000001) {
            res.status(403).json({ error: "ليست لديك صلاحية اختيار وحدة سطر الفاتورة من تطبيق الموبايل" }); return false;
          }
          continue;
        }
        const protectedNumber = (key: "freeQty" | "discount" | "discountAmount", permission: string) => {
          const oldValue = n(old[key]);
          if (!has(line, key)) { line[key] = oldValue; return true; }
          if (!mobilePermAllowed(holder, permission) && Math.abs(n(line[key]) - oldValue) > 0.0001) return false;
          return true;
        };
        if (!protectedNumber("freeQty", "invoice_free_qty")) {
          res.status(403).json({ error: "ليست لديك صلاحية تعديل الكمية المجانية في الفاتورة من تطبيق الموبايل" }); return false;
        }
        if (!protectedNumber("discount", "invoice_discount") || !protectedNumber("discountAmount", "invoice_discount")) {
          res.status(403).json({ error: "ليست لديك صلاحية تعديل خصم سطر الفاتورة من تطبيق الموبايل" }); return false;
        }
        const unitChanged = (has(line, "unitId") && Number(line.unitId) !== Number(old.unitId)) ||
          (has(line, "conversionFactor") && Math.abs(n(line.conversionFactor, 1) - n(old.conversionFactor, 1)) > 0.000001);
        if (!mobilePermAllowed(holder, "invoice_unit_selection") && unitChanged) {
          res.status(403).json({ error: "ليست لديك صلاحية تعديل وحدة سطر الفاتورة من تطبيق الموبايل" }); return false;
        }
        if (!mobilePermAllowed(holder, "invoice_unit_selection") && !unitChanged) {
          unchangedProtectedUnitLines.add(line);
          protectedUnitPriceByLine.set(line, n(old.unitPrice));
        }
        if (!has(line, "unitId")) line.unitId = old.unitId;
        if (!has(line, "unit")) line.unit = old.unit;
        if (!has(line, "conversionFactor")) line.conversionFactor = n(old.conversionFactor, 1);
      }
    }
  }
  // Do not accept privileged line values from an old/patched mobile client.
  // Existing protected values are accepted on update so hiding a field never
  // erases it; only a non-default value introduced by the mobile payload is
  // rejected here (the normal line writer keeps stored values for omissions).
  if (action === "create" && !mobilePermAllowed(holder, "invoice_free_qty") &&
      ls.some((l: any) => Math.abs(Number(l?.freeQty ?? 0)) > 0.0001)) {
    res.status(403).json({ error: "ليست لديك صلاحية الكمية المجانية في الفاتورة من تطبيق الموبايل" });
    return false;
  }
  if (action === "create" && !mobilePermAllowed(holder, "invoice_discount") &&
      ls.some((l: any) => Math.abs(Number(l?.discount ?? 0)) > 0.0001 || Math.abs(Number(l?.discountAmount ?? 0)) > 0.0001)) {
    res.status(403).json({ error: "ليست لديك صلاحية خصم سطر الفاتورة من تطبيق الموبايل" });
    return false;
  }
  if (action === "create" && !mobilePermAllowed(holder, "invoice_unit_selection") &&
      ls.some((l: any) => Math.abs(Number(l?.conversionFactor ?? 1) - 1) > 0.000001)) {
    res.status(403).json({ error: "ليست لديك صلاحية اختيار وحدة سطر الفاتورة من تطبيق الموبايل" });
    return false;
  }
  const itemIds = Array.from(new Set(
    ls.map((l: any) => Number(l?.itemId)).filter((n) => Number.isInteger(n) && n > 0),
  ));
  const itemRows = itemIds.length
    ? await db.select({ id: itemsTable.id, unitId: itemsTable.unitId, salePrice: itemsTable.salePrice })
      .from(itemsTable)
      .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  const unitSelectionAllowed = mobilePermAllowed(holder, "invoice_unit_selection");
  const configuredUnitRows = itemIds.length
    ? await db.select({
      itemId: itemUnitPricesTable.itemId,
      unitId: itemUnitPricesTable.unitId,
      salePrice: itemUnitPricesTable.salePrice,
      conversionFactor: itemUnitPricesTable.conversionFactor,
    })
      .from(itemUnitPricesTable)
      .where(and(eq(itemUnitPricesTable.companyId, cid), inArray(itemUnitPricesTable.itemId, itemIds)))
    : [];
  const configuredUnitByKey = new Map(
    configuredUnitRows.map((row) => [`${row.itemId}:${row.unitId}`, row]),
  );
  const n = (value: unknown, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  for (const line of ls) {
    const item = itemById.get(Number(line?.itemId));
    if (!item) continue;
    const sentUnitId = line?.unitId == null ? null : Number(line.unitId);
    const sentFactor = n(line?.conversionFactor, 1);
    if (!unitSelectionAllowed) {
      if (unchangedProtectedUnitLines.has(line)) continue;
      if ((sentUnitId != null && sentUnitId !== Number(item.unitId)) ||
          Math.abs(sentFactor - 1) > 0.000001) {
        res.status(403).json({ error: "ليست لديك صلاحية اختيار وحدة سطر الفاتورة من تطبيق الموبايل" });
        return false;
      }
      continue;
    }
    const configured = sentUnitId == null || sentUnitId === Number(item.unitId)
      ? null
      : configuredUnitByKey.get(`${item.id}:${sentUnitId}`);
    if (sentUnitId != null && sentUnitId !== Number(item.unitId) && !configured) {
      res.status(403).json({ error: "وحدة الصنف المختارة غير معتمدة لتطبيق الموبايل" });
      return false;
    }
    const expectedFactor = configured ? n(configured.conversionFactor, 1) : 1;
    if (Math.abs(sentFactor - expectedFactor) > 0.000001) {
      res.status(403).json({ error: "معامل تحويل وحدة الصنف غير صحيح" });
      return false;
    }
  }
  if (!mobilePermAllowed(holder, "invoice_edit_price")) {
    // Editing without resending lines could silently rewrite header totals —
    // require the full line set when price-editing is denied.
    if (action === "edit" && !ls.length) {
      res.status(403).json({ error: "ليست لديك صلاحية تعديل أسعار/مبالغ الفاتورة من تطبيق الموبايل" });
      return false;
    }
    if (itemIds.length) {
      for (const l of ls) {
        const iid = Number(l?.itemId);
        const item = itemById.get(iid);
        if (!item) continue;
        const sent = parseFloat(String(l?.unitPrice ?? "0")) || 0;
        const protectedStoredPrice = protectedUnitPriceByLine.get(l);
        const selectedUnit = l?.unitId != null &&
          Number(l.unitId) !== Number(item.unitId)
          ? configuredUnitByKey.get(`${iid}:${Number(l.unitId)}`)
          : null;
        const stored = protectedStoredPrice != null
          ? protectedStoredPrice
          : selectedUnit
          ? parseFloat(String(selectedUnit.salePrice ?? "0")) || 0
          : parseFloat(String(item.salePrice ?? "0")) || 0;
        if (Math.abs(sent - stored) > 0.01) {
          res.status(403).json({ error: "ليست لديك صلاحية تعديل سعر البيع من تطبيق الموبايل" });
          return false;
        }
      }
    }
    // Header totals must be derivable from the (verified) lines — blocks
    // forged subtotal/vatAmount/totalAmount or discount abuse while unit
    // prices look correct.
    const body = req.body ?? {};
    const inclusive = body.priceIncludesVat === true;
    const [company] = await db.select({ taxCalculationMode: companiesTable.taxCalculationMode })
      .from(companiesTable).where(eq(companiesTable.id, cid));
    const beforeDiscount = company?.taxCalculationMode === "before_discount";
    let expSub = 0, expVat = 0;
    for (const l of ls) {
      const q = parseFloat(String(l?.qty ?? l?.quantity ?? "0")) || 0;
      const p = parseFloat(String(l?.unitPrice ?? "0")) || 0;
      const r = (parseFloat(String(l?.vatRate ?? "15")) || 0) / 100;
      const fullGross = q * p;
      const discount = effectiveLineDiscount(l, fullGross);
      if (beforeDiscount) {
        if (inclusive) { const net = fullGross / (1 + r); expSub += Math.max(0, net - discount); expVat += fullGross - net; }
        else { expSub += Math.max(0, fullGross - discount); expVat += fullGross * r; }
      } else {
        const gross = Math.max(0, fullGross - discount);
        if (inclusive) { const net = gross / (1 + r); expSub += net; expVat += gross - net; }
        else { expSub += gross; expVat += gross * r; }
      }
    }
    const discount = Math.abs(parseFloat(String(body.discountAmount ?? "0")) || 0);
    const sentTotal = parseFloat(String(body.totalAmount ?? "0")) || 0;
    // Allow generous rounding slack (0.05 SAR per line + 0.1) but nothing more.
    const tol = 0.1 + ls.length * 0.05;
    if (discount > 0.009 || (sentTotal > 0 && Math.abs(sentTotal - (expSub + expVat)) > tol)) {
      res.status(403).json({ error: "ليست لديك صلاحية تعديل مبالغ الفاتورة (خصم/إجمالي) من تطبيق الموبايل" });
      return false;
    }
  }
  return true;
}

router.post("/sales-invoices", async (req, res) => {
  const timingStart = await beginAgentInvoiceTiming(req, res, "create", Array.isArray(req.body?.lines) ? req.body.lines.length : 0);
  if (timingStart.blockedReason) {
    res.status(503).json({ error: timingStart.blockedReason });
    return;
  }
  const timing = timingStart.timing;
  try {
    const cid = guard(req, res); if (!cid) return;
    // ─── Mobile-app rights (صلاحيات تطبيق الموبايل) ───
    // Enforced server-side for the mobile channel so a revoked right applies
    // immediately even if the app UI is stale. NULL map = all allowed.
    if (!(await enforceMobileSalesRights(req, res, cid, req.body?.lines, "create"))) return;
    timing?.mark("mobile-rights");
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, allowNegativeStock, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
            posSessionId, salesRepId, documentOfferId, sourceQuotationId, costCenter, taxId } = req.body;
    const usageIds = Array.from(new Set<number>(
      (lines ?? [])
        .map((line: any) => Number(line?.itemId))
        .filter((itemId: number) => Number.isInteger(itemId) && itemId > 0),
    ));
    const acceleratedPath = usesAcceleratedAgentInvoicePath(timingStart);
    const pType = paymentType || "credit";
    const requestedOverdraft = asBool(allowNegativeStock);
    if (requestedOverdraft && !canAccessModule(req.authUser, "sales_invoice_overdraft", "edit")) {
      res.status(403).json({ error: "ليست لديك صلاحية تفعيل السحب على المكشوف في فواتير المبيعات" });
      return;
    }
    const issueInline = (isMobileChannel(req) || (req as any).resolvedMobileSalesContext === true) &&
      req.body?.mobileSaveMode === "issue";
    if (issueInline && !canPostDoc(req.authUser as any, "sales")) {
      res.status(403).json({ error: "ليس لديك صلاحية ترحيل هذا النوع من المستندات" });
      return;
    }
    const offerIds = collectInvoiceOfferIds(documentOfferId, lines);
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const repRole = req.authUser?.role;
    const isManagerRole = repRole === "admin" || repRole === "superadmin";

    const loadSourceQuotation = () => {
      if (!sourceQuotationId) {
        return Promise.resolve([] as Array<{
          id: number;
          docNumber: string | null;
          status: string;
          convertedInvoiceId: number | null;
        }>);
      }
      return db.select({
        id: salesQuotationsTable.id,
        docNumber: salesQuotationsTable.docNumber,
        status: salesQuotationsTable.status,
        convertedInvoiceId: salesQuotationsTable.convertedInvoiceId,
      }).from(salesQuotationsTable)
        .where(and(
          eq(salesQuotationsTable.id, Number(sourceQuotationId)),
          eq(salesQuotationsTable.companyId, cid),
        ));
    };
    const loadRepInfo = async () => {
      const linkedRepId = isManagerRole ? null : await repIdForUser(cid, req.authUser?.id);
      // A normal user linked to a sales rep is always attributed to that rep,
      // even if a patched mobile/web client submits another salesRepId.
      // Managers keep the web policy: free choice of any rep or none.
      const effectiveRepId = linkedRepId ?? salesRepId ?? null;
      return resolveRepCommission(cid, effectiveRepId, totals.totalAmount);
    };
    const loadBuyerCountry = () => customerId
      ? db.select({ country: customersTable.country })
          .from(customersTable)
          .where(and(eq(customersTable.id, Number(customerId)), eq(customersTable.companyId, cid)))
          .limit(1)
      : Promise.resolve([] as Array<{ country: string | null }>);
    const loadTaxRate = () => lines?.length
      ? resolveTaxRate(cid, taxId ? Number(taxId) : null)
      : Promise.resolve("15");
    const loadPosSession = () => posSessionId
      ? db.select({
          id: posSessionsTable.id,
          companyId: posSessionsTable.companyId,
          status: posSessionsTable.status,
        }).from(posSessionsTable)
          .where(eq(posSessionsTable.id, Number(posSessionId)))
          .limit(1)
      : Promise.resolve([] as Array<{ id: number; companyId: number; status: string }>);

    // In trial/on mode only, overlap independent read-only checks across the
    // remote agent DB. Captured promises attach rejection handlers immediately;
    // each result is still consumed at its legacy validation point below.
    const fastReads = acceleratedPath ? {
      quota: captureRead(getInvoiceQuota(cid)),
      usage: captureRead(checkItemsUsable(cid, "sales_invoices", usageIds, req.authUser, "save")),
      sourceQuotation: captureRead(loadSourceQuotation()),
      overdue: captureRead(
        pType === "credit" && customerId
          ? findOldestOutstandingCredit(cid, Number(customerId))
          : Promise.resolve(null),
      ),
      offers: captureRead(validateOffersBelongToCompany(cid, offerIds)),
      brands: captureRead(validateBrandLinesBelongToCompany(cid, lines)),
      repInfo: captureRead(loadRepInfo()),
      buyerCountry: captureRead(loadBuyerCountry()),
      taxRate: captureRead(loadTaxRate()),
      posSession: captureRead(loadPosSession()),
    } : null;

    // These are independent read-only preflights. Running them together saves
    // one remote-agent round trip without changing which validation wins.
    const [invQuota, usageV] = await Promise.all([
      fastReads ? readCaptured(fastReads.quota) : getInvoiceQuota(cid),
      fastReads
        ? readCaptured(fastReads.usage)
        : checkItemsUsable(cid, "sales_invoices", usageIds, req.authUser, "save"),
    ]);
    timing?.mark("quota-and-item-validation");
    if (invQuota.used >= invQuota.limit) {
      res.status(403).json({
        error: `وصلت إلى الحد الأقصى للفواتير الشهرية المسموح به في خطتك (${invQuota.limit} فاتورة/شهر). يرجى ترقية الخطة لإضافة المزيد.`,
        code: "INVOICE_LIMIT_REACHED",
        limit: invQuota.limit,
        used: invQuota.used,
      });
      return;
    }
    // Item Usage Control (Phase ب): block a save containing items routed
    // hidden/readonly/requires_permission for this screen (unprivileged).
    if (usageV.length) {
      res.status(403).json({
        error: usageViolationMessage(usageV, "save"),
        code: "ITEM_USAGE_BLOCKED",
        violations: usageV,
      });
      return;
    }
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
      const [sq] = fastReads
        ? await readCaptured(fastReads.sourceQuotation)
        : await loadSourceQuotation();
      if (!sq) { res.status(404).json({ error: "عرض السعر غير موجود" }); return; }
      if (sq.convertedInvoiceId) { res.status(400).json({ error: "تم تحويل عرض السعر مسبقاً إلى فاتورة" }); return; }
      if (sq.status !== "accepted") { res.status(400).json({ error: "يجب قبول عرض السعر قبل التحويل لفاتورة" }); return; }
      validatedSourceQuotation = { id: sq.id, docNumber: sq.docNumber };
    }
    timing?.mark("source-and-item-validation");
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
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    // ── Overdue-payment guard ──
    // When the customer has `paymentTermsDays > 0`, refuse a new CREDIT invoice
    // if any prior posted credit invoice of theirs still has an outstanding
    // balance AND is older than the term (counted from the new invoice date).
    // FIFO-applies posted receipts + posted credit returns to oldest invoices
    // first, then checks the oldest remaining one. Cash invoices and customers
    // without payment terms bypass the guard entirely.
    const [overdue] = await Promise.all([
      fastReads
        ? readCaptured(fastReads.overdue)
        : pType === "credit" && customerId
          ? findOldestOutstandingCredit(cid, Number(customerId))
          : Promise.resolve(null),
      fastReads
        ? readCaptured(fastReads.offers)
        : validateOffersBelongToCompany(cid, offerIds),
      fastReads
        ? readCaptured(fastReads.brands)
        : validateBrandLinesBelongToCompany(cid, lines),
    ]);
    if (overdue) {
      const refMs = new Date(invoiceDate).getTime();
      const days = Math.floor((refMs - new Date(overdue.invoiceDate).getTime()) / 86400000);
      if (days > overdue.paymentTermsDays) {
        res.status(409).json({
          error:
            `لا يمكن إصدار فاتورة جديدة للعميل "${overdue.customerName}" — يوجد فاتورة سابقة بتاريخ ${overdue.invoiceDate} ` +
            `بمبلغ مستحق ${overdue.outstandingAmount.toFixed(2)} ر.س لم تُسدَّد خلال مدة الاستحقاق (${overdue.paymentTermsDays} يوم — تأخر ${days} يوماً). ` +
            `الرجاء سرعة السداد لاستكمال عمليات البيع.`,
          code: "OVERDUE_PAYMENT",
          overdueDays: days,
          paymentTermsDays: overdue.paymentTermsDays,
          outstandingAmount: Number(overdue.outstandingAmount.toFixed(2)),
          oldestUnpaidInvoiceDate: overdue.invoiceDate,
        });
        return;
      }
    }
    timing?.mark("credit-offer-and-brand-validation");
    // Snapshot the rep's commission % at save time so historical invoices keep
    // their commission even if the rep's % changes later.
    // ─── Auto-attribution ───
    // If the form didn't pass an explicit salesRepId, fall back to the rep
    // linked to the currently-logged-in user (sales_reps.user_id). This is
    // the whole point of the user↔rep link: the salesperson logs in, opens a
    // new invoice, and their commission is automatically tagged without any
    // manual selection. Admin/superadmin keep FULL freedom: they are NEVER
    // auto-attributed to their own linked rep — they must pick a rep explicitly
    // (or leave it blank for a no-rep invoice). This mirrors the unlocked rep
    // picker they get in the UI (sales-reps /me/current returns "not linked").
    const [repInfo, buyerCountryRows, resolvedRate, posSessionRows] = await Promise.all([
      fastReads ? readCaptured(fastReads.repInfo) : loadRepInfo(),
      fastReads ? readCaptured(fastReads.buyerCountry) : loadBuyerCountry(),
      fastReads ? readCaptured(fastReads.taxRate) : loadTaxRate(),
      fastReads ? readCaptured(fastReads.posSession) : loadPosSession(),
    ]);
    const buyerIsForeign = !!buyerCountryRows[0]
      && String(buyerCountryRows[0].country ?? "SA").toUpperCase() !== "SA";
    const validPosSession = posSessionRows[0];
    const validPosSessionId = validPosSession
      && validPosSession.companyId === cid
      && validPosSession.status === "open"
      ? validPosSession.id
      : null;
    timing?.mark("independent-lookups");

    // The central sequence engine is authoritative whenever an active
    // sequence exists for "sales_invoice" — we always allocate server-side
    // (atomic, FOR UPDATE) and ignore any client-supplied number so two
    // simultaneous submissions can never persist the same docNumber. When
    // no active sequence is configured, we fall back to the client-supplied
    // value or null (legacy free-numbering behaviour).
    // Foreign-customer numbering: when the buyer's country is not SA, the
    // invoice draws from the separate "sales_invoice_foreign" series (if the
    // company configured one). The ZATCA ICV/PIH chain stays unified.
    let resolvedDocNumber: string | null;
    try {
      const allocateSequenceNumber = async (): Promise<string | null> => {
        // POS-screen sales (posSessionId present) number from a PER-STATION
        // sequence, auto-created on first use. The ZATCA ICV/PIH chain stays
        // unified and is untouched — only the human docNumber differs.
        let allocated: string | null = null;
        if (posSessionId) {
          allocated = await nextPosStationNumber(cid, Number(posSessionId), {
            userId: req.authUser?.id ?? null,
            refTable: "sales_invoices",
            docDate: invoiceDate,
          });
        }
        if (allocated == null && String(req.headers["x-app-channel"] ?? "").toLowerCase() === "mobile") {
          allocated = await nextSequenceNumber(cid, "sales_invoice_mobile", {
            userId: req.authUser?.id ?? null,
            refTable: "sales_invoices",
            branchId: branchId ? Number(branchId) : null,
            docDate: invoiceDate,
          });
        }
        if (allocated == null) {
          allocated = await nextSequenceForPayment(cid, "sales_invoice", pType, {
            userId: req.authUser?.id ?? null,
            refTable: "sales_invoices",
            branchId: branchId ? Number(branchId) : null,
            docDate: invoiceDate,
          }, buyerIsForeign);
        }
        return allocated;
      };
      let fromSeq = await allocateSequenceNumber();
      // Imported companies may carry counters that lag behind their historical
      // documents. Consume stale generated numbers until the first unused one;
      // never make the operator repair an entire restored sequence by hand.
      for (let skipped = 0; fromSeq != null; skipped += 1) {
        const duplicate = await db.select({ id: salesInvoicesTable.id })
          .from(salesInvoicesTable)
          .where(and(
            eq(salesInvoicesTable.companyId, cid),
            eq(salesInvoicesTable.docNumber, fromSeq),
          ))
          .limit(1);
        if (!duplicate.length) break;
        if (skipped >= 999) throw new Error("تعذر الوصول إلى رقم فاتورة غير مستخدم بعد الاستعادة");
        fromSeq = await allocateSequenceNumber();
      }
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الفاتورة" });
      return;
    }
    timing?.mark("sequence");

    const requestedAccountIds = [
      cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
    ].map(Number).filter((id) => Number.isInteger(id) && id > 0);
    const validAccountIds = requestedAccountIds.length
      ? new Set((await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
          eq(accountsTable.companyId, cid),
          inArray(accountsTable.id, [...new Set(requestedAccountIds)]),
        ))).map((row) => row.id))
      : new Set<number>();
    const validAccount = (value: unknown): number | null => {
      const id = Number(value);
      return Number.isInteger(id) && validAccountIds.has(id) ? id : null;
    };
    const invoiceValues: any = {
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
      allowNegativeStock: requestedOverdraft,
      // "cancelled" is used only as an internal, non-editable issue-pending
      // sentinel during this same request.  Success changes it to posted;
      // any failure deletes it via the compensation callback below.
      status: issueInline ? "cancelled" : "draft", notes: notes || null,
      // Creation channel — 'mobile' when the companion app created the doc.
      sourceChannel: String(req.headers["x-app-channel"] ?? "").toLowerCase() === "mobile" ? "mobile" : null,
      posSessionId: validPosSessionId,
      // Manual session (admin-created) the user is currently working under,
      // resolved by extractAuth from the trusted x-session-id header. Null when
      // the user is operating without a manual session.
      sessionId: (req as any).manualSessionId ?? null,
      createdById:  req.authUser?.id ?? null,
      cogsAccountId:      validAccount(cogsAccountId),
      inventoryAccountId: validAccount(inventoryAccountId),
      salesAccountId:     validAccount(salesAccountId),
      taxAccountId:       validAccount(taxAccountId),
      discountAccountId:  validAccount(discountAccountId),
      salesRepId:         repInfo.salesRepId,
      commissionPct:      repInfo.commissionPct,
      commissionAmount:   repInfo.commissionAmount,
      documentOfferId:    documentOfferId ? Number(documentOfferId) : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      taxId:              taxId ? Number(taxId) : null,
    };
    let inv: typeof salesInvoicesTable.$inferSelect;
    try {
      [inv] = await db.insert(salesInvoicesTable).values(invoiceValues).returning();
    } catch (insertError: any) {
      const code = String(postgresErrorField(insertError, "code") ?? "");
      const constraint = String(
        postgresErrorField(insertError, "constraint_name")
          ?? postgresErrorField(insertError, "constraint")
          ?? "",
      );
      if (code !== "23505" || !constraint.includes("pkey")) throw insertError;
      // Old SQL dumps can restore explicit IDs without advancing the serial
      // sequence. Repair only this table's sequence, then retry once.
      await db.execute(sql`
        SELECT setval(
          pg_get_serial_sequence('sales_invoices', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM sales_invoices), 0) + 1, 1),
          false
        )
      `);
      [inv] = await db.insert(salesInvoicesTable).values(invoiceValues).returning();
    }
    if (lines?.length) {
      await db.insert(salesInvoiceLinesTable).values(lines.map((l: any) => mapInvoiceLine(l, inv.id, cid, resolvedRate)));
    }
    timing?.mark("invoice-and-lines-write");
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
    timing?.mark("post-write-links");
    if (issueInline) {
      const previousParams = req.params;
      req.params = { ...previousParams, id: String(inv.id) };
      await postSalesInvoiceHandler(req, res, async () => {
        await db.transaction(async (tx) => {
          if (validatedSourceQuotation) {
            await tx.update(salesQuotationsTable).set({
              status: "accepted",
              convertedInvoiceId: null,
              updatedAt: new Date(),
            }).where(and(
              eq(salesQuotationsTable.id, validatedSourceQuotation.id),
              eq(salesQuotationsTable.companyId, cid),
              eq(salesQuotationsTable.status, "converted"),
              eq(salesQuotationsTable.convertedInvoiceId, inv.id),
            ));
          }
          await tx.delete(salesInvoicesTable).where(and(
            eq(salesInvoicesTable.id, inv.id),
            eq(salesInvoicesTable.companyId, cid),
            eq(salesInvoicesTable.status, "cancelled"),
          ));
        });
      });
      req.params = previousParams;
      return;
    }
    timing?.completeBusinessOutcome(201);
    res.status(201).json(inv);
  } catch (e: any) {
    logger.error({ err: e }, "sales invoice create failed");
    const friendly = salesInvoiceWriteError(e);
    res.status(friendly.status).json({ error: friendly.message });
  } finally {
    timing?.completeBusinessOutcome(res.statusCode);
  }
});

router.put("/sales-invoices/:id", async (req, res) => {
  const timingStart = await beginAgentInvoiceTiming(req, res, "update", Array.isArray(req.body?.lines) ? req.body.lines.length : 0);
  if (timingStart.blockedReason) {
    res.status(503).json({ error: timingStart.blockedReason });
    return;
  }
  const timing = timingStart.timing;
  try {
    const cid = guard(req, res); if (!cid) return;
    // Mobile-app rights — same gate as POST (see enforceMobileSalesRights).
    if (!(await requireMobilePerm(req, res, cid, "invoice_edit", "ليست لديك صلاحية تعديل الفواتير من تطبيق الموبايل"))) return;
    if (!(await enforceMobileSalesRights(req, res, cid, req.body?.lines, "edit"))) return;
    timing?.mark("mobile-rights");
    const id = Number(req.params.id);
    const issueInline = (isMobileChannel(req) || (req as any).resolvedMobileSalesContext === true) &&
      req.body?.mobileSaveMode === "issue";
    if (issueInline && !canPostDoc(req.authUser as any, "sales")) {
      res.status(403).json({ error: "ليس لديك صلاحية ترحيل هذا النوع من المستندات" });
      return;
    }
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
    let issueRestoreHeader: any = null;
    let issueRestoreLines: any[] = [];
    if (issueInline) {
      [issueRestoreHeader] = await db.select().from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
      issueRestoreLines = await db.select().from(salesInvoiceLinesTable)
        .where(and(eq(salesInvoiceLinesTable.invoiceId, id), eq(salesInvoiceLinesTable.companyId, cid)));
    }
    timing?.mark("invoice-read");
    // docNumber is intentionally not destructured here — it is immutable on
    // edit (see the .set() below).
    const { invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, allowNegativeStock, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
            documentOfferId, costCenter, taxId } = req.body;
    // Same required-fields gate as the POST path so a direct PUT (e.g.
    // from a script or a stale draft that pre-dates the policy) cannot
    // strip the customer/branch off an existing invoice on edit.
    if (!customerId) { res.status(400).json({ error: "يجب اختيار العميل قبل حفظ الفاتورة", field: "customerId" }); return; }
    if (!branchId)   { res.status(400).json({ error: "يجب اختيار الفرع قبل حفظ الفاتورة",  field: "branchId"   }); return; }
    const acceleratedPath = usesAcceleratedAgentInvoicePath(timingStart);
    const incomingOfferIds = collectInvoiceOfferIds(documentOfferId, lines);
    const pType = paymentType || "credit";
    const requestedOverdraft = asBool(allowNegativeStock);
    if (requestedOverdraft && !canAccessModule(req.authUser, "sales_invoice_overdraft", "edit")) {
      res.status(403).json({ error: "ليست لديك صلاحية تفعيل السحب على المكشوف في فواتير المبيعات" });
      return;
    }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const newTotalBase = (parseFloat(String(totals.totalAmount)) || 0)
      * (parseFloat(String(exchangeRate)) || 1);
    const hasRepKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "salesRepId");
    const loadRepPatch = async () => {
      const role = req.authUser?.role;
      const linkedRepId = role === "admin" || role === "superadmin"
        ? null
        : await repIdForUser(cid, req.authUser?.id);
      if (!hasRepKey && linkedRepId == null) return {};
      const r = await resolveRepCommission(
        cid,
        linkedRepId ?? (req.body as any).salesRepId,
        totals.totalAmount,
      );
      return {
        salesRepId: r.salesRepId,
        commissionPct: r.commissionPct,
        commissionAmount: r.commissionAmount,
      };
    };
    const loadLineTaxRate = () => lines !== undefined
      ? resolveTaxRate(cid, taxId ? Number(taxId) : null)
      : Promise.resolve(null);

    const fastReads = acceleratedPath ? {
      previousLineOffers: captureRead(
        db.select({ aoid: salesInvoiceLinesTable.appliedOfferId })
          .from(salesInvoiceLinesTable)
          .where(eq(salesInvoiceLinesTable.invoiceId, id)),
      ),
      previousInvoiceOffer: captureRead(
        db.select({ doid: salesInvoicesTable.documentOfferId })
          .from(salesInvoicesTable)
          .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid))),
      ),
      offers: captureRead(validateOffersBelongToCompany(cid, incomingOfferIds)),
      brands: captureRead(validateBrandLinesBelongToCompany(cid, lines)),
      settlements: captureRead(assertInvoiceEditKeepsSettlementsCovered(cid, "sales", id, newTotalBase)),
      repPatch: captureRead(loadRepPatch()),
      lineTaxRate: captureRead(loadLineTaxRate()),
    } : null;

    // Snapshot offer ids that were already attached to this invoice BEFORE
    // we delete-and-reinsert lines, so we can bump times_used for the offers
    // that are NEW on this update (and not double-count the ones already
    // there). Computed before the update so we don't lose them when the
    // line-level FKs are cascaded away.
    const prevLineOffers = fastReads
      ? await readCaptured(fastReads.previousLineOffers)
      : await db.select({ aoid: salesInvoiceLinesTable.appliedOfferId })
          .from(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
    const [prevInvRow] = fastReads
      ? await readCaptured(fastReads.previousInvoiceOffer)
      : await db.select({ doid: salesInvoicesTable.documentOfferId })
          .from(salesInvoicesTable)
          .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    const prevOfferIds = new Set<number>();
    for (const r of prevLineOffers) if (r.aoid) prevOfferIds.add(r.aoid);
    if (prevInvRow?.doid) prevOfferIds.add(prevInvRow.doid);
    // Same tenant guard as POST — incoming payload can't reference a foreign
    // company's offer.
    if (fastReads) {
      await readCaptured(fastReads.offers);
      await readCaptured(fastReads.brands);
    } else {
      await validateOffersBelongToCompany(cid, incomingOfferIds);
      await validateBrandLinesBelongToCompany(cid, lines);
    }
    timing?.mark("validation");
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    // حارس ما بعد السداد: لا يجوز أن يصبح صافي الفاتورة أقل من المسدَّد عليها.
    try {
      if (fastReads) await readCaptured(fastReads.settlements);
      else await assertInvoiceEditKeepsSettlementsCovered(cid, "sales", id, newTotalBase);
    } catch (e: any) {
      res.status(e?.status ?? 400).json({ error: e?.message || "التعديل يتعارض مع دفعات مسجَّلة على الفاتورة" });
      return;
    }
    // Only re-snapshot commission when the caller explicitly sent salesRepId
    // (so existing forms that don't know about reps don't wipe historical data).
    const repPatch = fastReads
      ? await readCaptured(fastReads.repPatch)
      : await loadRepPatch();
    // Note: docNumber is intentionally omitted from the update set — once a
    // sales invoice number is assigned (by the central sequence engine or by
    // the user on creation) it is immutable, both for ZATCA audit compliance
    // and to keep the sequence log consistent.
    const resolvedLineTaxRate = fastReads
      ? await readCaptured(fastReads.lineTaxRate)
      : await loadLineTaxRate();
    const inv = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ status: salesInvoicesTable.status })
        .from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)))
        .for("update");
      if (!locked) {
        const err: any = new Error("الفاتورة غير موجودة");
        err.status = 404;
        throw err;
      }
      if (locked.status === "posted") {
        const err: any = new Error("لا يمكن تعديل فاتورة مُرحَّلة. قم بفك الترحيل أولاً.");
        err.status = 409;
        throw err;
      }

      const [updated] = await tx.update(salesInvoicesTable).set({
        // See POST: cancelled is a request-local issue-pending sentinel, not
        // a saved draft.  It is posted or restored before this request ends.
        status: issueInline ? "cancelled" : "draft",
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
        allowNegativeStock: requestedOverdraft,
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
      }).where(and(
        eq(salesInvoicesTable.id, id),
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.status, "draft"),
      )).returning();
      if (!updated) {
        const err: any = new Error("تعذر تعديل الفاتورة بعد تغير حالتها — أعد المحاولة");
        err.status = 409;
        throw err;
      }
      if (lines !== undefined) {
        await tx.delete(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
        if (lines.length) {
          await tx.insert(salesInvoiceLinesTable).values(
            lines.map((l: any) => mapInvoiceLine(l, id, cid, resolvedLineTaxRate ?? "15")),
          );
        }
      }
      return updated;
    });
    timing?.mark("invoice-and-lines-write");
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
    timing?.mark("offer-links");
    if (issueInline) {
      const restoreDraft = async () => {
        if (!issueRestoreHeader) return;
        await db.transaction(async (tx) => {
          const { id: _id, companyId: _companyId, ...headerPatch } = issueRestoreHeader;
          await tx.update(salesInvoicesTable).set(headerPatch as any).where(and(
            eq(salesInvoicesTable.id, id),
            eq(salesInvoicesTable.companyId, cid),
            eq(salesInvoicesTable.status, "cancelled"),
          ));
          await tx.delete(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
          if (issueRestoreLines.length) {
            await tx.insert(salesInvoiceLinesTable).values(issueRestoreLines);
          }
        });
      };
      const previousParams = req.params;
      req.params = { ...previousParams, id: String(id) };
      await postSalesInvoiceHandler(req, res, restoreDraft);
      req.params = previousParams;
      return;
    }
    timing?.completeBusinessOutcome(200);
    res.json(inv);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  } finally {
    timing?.completeBusinessOutcome(res.statusCode);
  }
});

async function postSalesInvoiceHandler(
  req: any,
  res: any,
  onFailure?: () => Promise<void>,
) {
  const timingStart = await beginAgentInvoiceTiming(req, res, "post", 0);
  if (timingStart.blockedReason) {
    res.status(503).json({ error: timingStart.blockedReason });
    if (onFailure) await onFailure();
    return;
  }
  const timing = timingStart.timing;
  try {
    const cid = guard(req, res); if (!cid) return;
    if (!(await requireMobilePerm(req, res, cid, "invoice_post", "ليست لديك صلاحية ترحيل فواتير المبيعات من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);

    // Branch-scope guard: a restricted user must not be able to post
    // another branch's invoice by guessing the id. Shared (branch_id NULL)
    // rows remain visible, mirroring the GET-by-id route at L459.
    const [[initialInvoice], initialLines] = await Promise.all([
      db.select().from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.id, id),
          eq(salesInvoicesTable.companyId, cid),
          ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
        )),
      db.select().from(salesInvoiceLinesTable)
        .where(eq(salesInvoiceLinesTable.invoiceId, id)),
    ]);
    let inv = initialInvoice;
    let lines = initialLines;
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") { res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" }); return; }
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في الفاتورة" }); return; }
    timing?.setLineCount(lines.length);
    timing?.mark("invoice-and-lines-read");

    // When this invoice was created from a Goods Delivery Note (GDN), the
    // stock movement (and inventory credit) already happened at GDN-post
    // time. SKIP the stock loop entirely so we don't double-count, and
    // CREDIT Delivery Clearing (instead of revenue/inventory) so it nets
    // out against the GDN's debit to that same clearing account.
    const gdnSourced = !!(inv as any).sourceGdnId;

    // Load per-item metadata once: batch mode (stock costing), item TYPE
    // (service vs stock) and the per-item revenue account. SERVICE items (خدمي)
    // are SAP-style — they NEVER affect stock/COGS and their revenue is credited
    // to the item's own revenue account instead of the generic sales account.
    const lineItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
    const [usageV, itemMetaRows] = await Promise.all([
      checkItemsUsable(cid, "sales_invoices", lineItemIds, req.authUser, "post"),
      lineItemIds.length
        ? db
            .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode, type: itemsTable.itemType, revAcc: itemsTable.revenueAccountId })
            .from(itemsTable)
            .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, lineItemIds)))
        : Promise.resolve([]),
    ]);
    if (usageV.length) {
      res.status(403).json({ error: usageViolationMessage(usageV, "post"), code: "ITEM_USAGE_BLOCKED", violations: usageV });
      return;
    }
    timing?.mark("item-validation-and-metadata");
    const modeById = new Map<number, "none" | "fifo" | "fefo">();
    const typeById = new Map<number, string>();
    const revAccById = new Map<number, number | null>();
    for (const r of itemMetaRows) {
      const m = (r.mode ?? "none") as string;
      modeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
      typeById.set(r.id, (r.type ?? "stock") as string);
      revAccById.set(r.id, r.revAcc ?? null);
    }
    const isServiceLine = (l: any) => { if (!l.itemId) return false; const t = typeById.get(l.itemId); return t === "service" || t === "prepaid_expense"; };

    // Guard: every stock-affecting (item-bearing) line must specify a warehouse.
    // SERVICE items (خدمي) never touch stock, so they are EXEMPT — a pure
    // service line legitimately carries no warehouse and must still post.
    // (Skip entirely when GDN-sourced — the GDN already validated this.)
    const noWh = gdnSourced ? [] : lines.filter(l => l.itemId && !l.warehouseId && !isServiceLine(l));
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info (account + allow-negative) for every distinct warehouse used.
    // (Not needed when GDN-sourced — no stock loop and no per-warehouse inventory credits.)
    const stockPairs = lines
      .filter((l) => l.itemId && l.warehouseId && !isServiceLine(l))
      .map((l) => ({ itemId: Number(l.itemId), warehouseId: Number(l.warehouseId) }));
    let whInfo: Record<number, WarehouseInfo> = {};
    if (!gdnSourced) {
      whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);
    }
    timing?.mark("warehouse-info");

    // Aggregate demand per item/warehouse before checking stock. Checking every
    // line independently against the same snapshot lets two lines each pass
    // while their combined quantity exceeds the available balance.
    const demandByPair = new Map<string, {
      itemId: number;
      warehouseId: number;
      qty: number;
      itemName: string;
    }>();
    if (!gdnSourced) {
      for (const line of lines) {
        if (!line.itemId || !line.warehouseId || isServiceLine(line)) continue;
        const factor = Number(line.conversionFactor || "1") || 1;
        const qty = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
        if (qty <= 0) continue;
        const key = `${line.itemId}:${line.warehouseId}`;
        const current = demandByPair.get(key);
        if (current) current.qty += qty;
        else demandByPair.set(key, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty,
          itemName: line.itemName ?? "صنف",
        });
      }
    }

    const postedInvoice = await db.transaction(async (tx) => {
      // Serialize repeated clicks on the same invoice and re-check status after
      // the row lock. Without this, two requests can both observe "draft" and
      // create duplicate stock/JE effects.
      const [lockedInvoice] = await tx
        .select()
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.id, id),
          eq(salesInvoicesTable.companyId, cid),
          ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
        ))
        .for("update");
      if (!lockedInvoice) {
        res.status(404).json({ error: "الفاتورة غير موجودة" });
        return;
      }
      if (lockedInvoice.status === "posted") {
        res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" });
        return;
      }
      const lockedLines = await tx
        .select()
        .from(salesInvoiceLinesTable)
        .where(eq(salesInvoiceLinesTable.invoiceId, id));
      if (invoiceLinesFingerprint(lockedLines) !== invoiceLinesFingerprint(lines)) {
        res.status(409).json({ error: "تم تعديل بنود الفاتورة أثناء الترحيل — أعد المحاولة" });
        return;
      }
      inv = lockedInvoice;
      lines = lockedLines;
      const allowInvoiceOverdraft = !!(lockedInvoice as any).allowNegativeStock;
      if (allowInvoiceOverdraft && !canAccessModule(req.authUser, "sales_invoice_overdraft", "edit")) {
        res.status(403).json({ error: "ليست لديك صلاحية ترحيل فاتورة مفعّل بها السحب على المكشوف" });
        return;
      }

      let stockSnapshots = new Map<string, StockSnapshot>();
      if (!gdnSourced) {
        await lockStockPairs(cid, [...demandByPair.keys()], tx);
        stockSnapshots = await loadStockSnapshots(cid, stockPairs, tx, true);
        timing?.mark("stock-locks-and-snapshots");
        for (const [key, demand] of demandByPair) {
          const wh = whInfo[demand.warehouseId];
          const cur = stockSnapshots.get(key)?.qty ?? 0;
          const projected = cur - demand.qty;
          // Two intentional ways to permit negative stock:
          //   1) the warehouse allows it as its standing policy, OR
          //   2) an authorized user opts in for this invoice only.
          // The invoice override must never mutate the warehouse setting.
          const overdraftAllowed = !!wh?.allowNegative || allowInvoiceOverdraft;
          const limit = wh?.negativeLimit;
          const exceedsLimit = overdraftAllowed && limit != null && limit >= 0 && projected < -limit;
          if (!overdraftAllowed && projected < 0) {
            res.status(400).json({
              error: `رصيد الصنف "${demand.itemName}" غير كافٍ في مخزن "${wh?.nameAr ?? demand.warehouseId}" — المتاح ${cur} والمطلوب ${demand.qty}. فعّل السحب على المكشوف لهذه الفاتورة أو اسمح به من إعداد المخزن.`,
            });
            return;
          }
          if (exceedsLimit) {
            res.status(400).json({
              error: `تجاوز الصنف "${demand.itemName}" حد السحب على المكشوف في مخزن "${wh?.nameAr ?? demand.warehouseId}" — الرصيد بعد الترحيل ${projected} والحد المسموح -${limit}.`,
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
    const batchPlans = !gdnSourced
      ? await readBatchRemainingBulk(
          cid,
          [...demandByPair.values()]
            .map((demand) => ({
              itemId: demand.itemId,
              warehouseId: demand.warehouseId,
              mode: modeById.get(demand.itemId) ?? "none",
            }))
            .filter((request): request is { itemId: number; warehouseId: number; mode: "fifo" | "fefo" } =>
              request.mode === "fifo" || request.mode === "fefo"),
          tx,
        )
      : new Map();
    timing?.mark("batch-plans");
    if (!gdnSourced) {
      for (const line of lines) {
        if (!line.itemId || !line.warehouseId) continue;
        if (isServiceLine(line)) continue; // SERVICE items never move stock / accrue COGS
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
          avgCost = stockSnapshots.get(`${line.itemId}:${line.warehouseId}`)?.avgCost ?? 0;
          picks = null;
        } else {
          // Consume the preloaded plan in line order. The allocator mutates the
          // pair plan so repeated lines never re-use the same lot.
          try {
            picks = allocateBatchPicks(
              batchPlans.get(`${line.itemId}:${line.warehouseId}`) ?? [],
              qty,
            );
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
    timing?.mark("costing");

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
    const [mapSi, mapPos] = await Promise.all([
      loadMappings(cid, "sales_invoice"),
      isPos ? loadMappings(cid, "pos_invoice") : Promise.resolve(null),
    ]);
    timing?.mark("account-mappings");
    const pick = (role: string): number | null =>
      (mapPos ? mapPos("pos_invoice", role) : null) ?? mapSi("sales_invoice", role);
    const restoredAccountCandidates = {
      revenue: [inv.salesAccountId, pick("revenue")],
      cogs: [inv.cogsAccountId, pick("cogs")],
      vat_output: [inv.taxAccountId, pick("vat_output")],
      discount: [inv.discountAccountId, pick("discount")],
    } as const;
    const candidateIds = [...new Set(
      Object.values(restoredAccountCandidates)
        .flat()
        .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0),
    )];
    const defaultCodes = {
      revenue: "4101",
      cogs: "5101",
      vat_output: "21041",
      discount: "5103",
    } as const;
    const candidateAccounts = await tx.select({
      id: accountsTable.id,
      code: accountsTable.code,
    }).from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      or(
        inArray(accountsTable.id, candidateIds.length ? candidateIds : [-1]),
        inArray(accountsTable.code, Object.values(defaultCodes)),
      ),
    ));
    const ownedIds = new Set(candidateAccounts.map(account => account.id));
    const defaultIdByCode = new Map(candidateAccounts.map(account => [account.code, account.id]));
    const resolveRestoredAccount = (
      role: keyof typeof restoredAccountCandidates,
    ): number | null => {
      const validCandidate = restoredAccountCandidates[role].find(
        id => id != null && ownedIds.has(id),
      );
      return validCandidate ?? defaultIdByCode.get(defaultCodes[role]) ?? null;
    };
    const salesAccId    = resolveRestoredAccount("revenue");
    const cogsAccId     = resolveRestoredAccount("cogs");
    const taxAccId      = resolveRestoredAccount("vat_output");
    const discountAccId = resolveRestoredAccount("discount");
    // Revenue / COGS / per-warehouse inventory accounts are NOT required for
    // GDN-sourced invoices — they post against Delivery Clearing instead.
    if (!gdnSourced) {
      if (!salesAccId) { res.status(400).json({ error: "لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)" }); return; }
      // COGS account only needed when there IS cost to book — an all-SERVICE
      // invoice has zero COGS and must post without a configured COGS account.
      if (totalCogs > 0 && !cogsAccId)  { res.status(400).json({ error: "لم يتم تحديد حساب تكلفة البضاعة المباعة (اضبطه من ربط القيود المحاسبية)" }); return; }
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
      if (qty <= 0 || price <= 0) continue;
      const grossPre = qty * price;
      // Percentage and amount are synchronized views of one discount.
      const discGross = effectiveLineDiscount(ln, grossPre);
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

    // SERVICE revenue routing: credit each service line's GROSS revenue
    // (qty × unitPrice, pre-discount, VAT-exclusive) to the item's OWN revenue
    // account; the remainder of gross revenue stays on the main sales account.
    // Discount keeps flowing through the discount debit exactly as for goods,
    // so total revenue credits still sum to grossSubtotalAmt (JE stays balanced).
    // Keyed by `accountId|costCenterCode` so a per-line cost center (Odoo-style
    // analytic distribution) survives the aggregation. Empty cc ⇒ "acc|" bucket
    // → emitted WITHOUT costCenter → falls back to the header cost center
    // exactly as before (no behavior change when no line carries a cc).
    const serviceRevenueByAccount: Record<string, number> = {};
    for (const ln of lines) {
      if (!isServiceLine(ln)) continue;
      const acc = revAccById.get(ln.itemId as number) ?? null;
      if (!acc) continue; // no per-item revenue account → falls into main sales revenue
      const qty   = Number(ln.qty) || 0;
      const price = Number(ln.unitPrice) || 0;
      let gross = qty * price;
      if (priceIncludesVat) {
        const rate = (Number(ln.vatRate) || 0) / 100;
        if (rate > -1) gross = gross / (1 + rate);
      }
      gross = Math.round(gross * 100) / 100;
      if (gross <= 0) continue;
      const svcKey = `${acc}|${typeof (ln as any).costCenter === "string" ? (ln as any).costCenter.trim() : ""}`;
      serviceRevenueByAccount[svcKey] = Math.round(((serviceRevenueByAccount[svcKey] ?? 0) + gross) * 100) / 100;
    }
    // `serviceRevenueByAccount` is the SINGLE SOURCE OF TRUTH for the service
    // credit lines. Reconcile its sum against grossSubtotalAmt so that
    // (mainRevenueAmt + Σ serviceRevenueByAccount) === grossSubtotalAmt EXACTLY
    // → the JE always balances even under rounding. Service revenue is a subset
    // of all lines so it can only overshoot by sub-cent rounding; if it does,
    // trim the overflow off the last service account.
    let serviceRevenueTotal = Math.round(Object.values(serviceRevenueByAccount).reduce((s, v) => s + v, 0) * 100) / 100;
    if (serviceRevenueTotal > grossSubtotalAmt) {
      const overflow = Math.round((serviceRevenueTotal - grossSubtotalAmt) * 100) / 100;
      const keys = Object.keys(serviceRevenueByAccount);
      const lastK = keys[keys.length - 1];
      serviceRevenueByAccount[lastK] = Math.round((serviceRevenueByAccount[lastK] - overflow) * 100) / 100;
      if (serviceRevenueByAccount[lastK] <= 0) delete serviceRevenueByAccount[lastK];
      serviceRevenueTotal = Math.round(Object.values(serviceRevenueByAccount).reduce((s, v) => s + v, 0) * 100) / 100;
    }
    const mainRevenueAmt = Math.round((grossSubtotalAmt - serviceRevenueTotal) * 100) / 100;
    const soldItemsDescription = itemNamesDescription(
      lines.map((line) => line.itemName),
      "إيراد المبيعات",
    );

    // ── OPTIONAL per-line cost-center split (Odoo-style analytic distribution) ──
    // Group each NON-service line's gross revenue (qty × unitPrice, pre-discount,
    // VAT-exclusive — same basis as the service split above) by the line's own
    // costCenter code. Lines WITHOUT a cost center fall into the "" bucket, which
    // is emitted with costCenter undefined → createJournalEntry falls back to the
    // header costCenter exactly as before. When NO line carries a cost center the
    // result is a single "" bucket = one revenue line — byte-identical behavior.
    const mainRevenueByCc: Record<string, number> = {};
    for (const ln of lines) {
      if (isServiceLine(ln) && revAccById.get(ln.itemId as number)) continue; // routed to service revenue
      const qty   = Number(ln.qty) || 0;
      const price = Number(ln.unitPrice) || 0;
      let gross = qty * price;
      if (priceIncludesVat) {
        const rate = (Number(ln.vatRate) || 0) / 100;
        if (rate > -1) gross = gross / (1 + rate);
      }
      if (gross <= 0) continue;
      const cc = ((ln as any).costCenter ?? "").toString().trim();
      mainRevenueByCc[cc] = (mainRevenueByCc[cc] ?? 0) + gross;
    }
    // Scale the buckets so they sum EXACTLY to mainRevenueAmt (absorbs rounding
    // and any drift vs the header subtotal); drift lands on the last bucket.
    const mainRevenueLines: JLine[] = [];
    {
      const rawTotal = Object.values(mainRevenueByCc).reduce((s, v) => s + v, 0);
      const ccKeys = Object.keys(mainRevenueByCc);
      if (mainRevenueAmt > 0) {
        if (rawTotal <= 0 || ccKeys.length <= 1) {
          // No usable per-line breakdown (or a single bucket) → one line, as before.
          const onlyCc = ccKeys.length === 1 ? ccKeys[0] : "";
          mainRevenueLines.push({
            accountId: salesAccId, credit: mainRevenueAmt, description: soldItemsDescription,
            ...(onlyCc ? { costCenter: onlyCc } : {}),
          });
        } else {
          let running = 0;
          ccKeys.forEach((cc, idx) => {
            let portion = Math.round((mainRevenueAmt * (mainRevenueByCc[cc] / rawTotal)) * 100) / 100;
            if (idx === ccKeys.length - 1) portion = Math.round((mainRevenueAmt - running) * 100) / 100;
            running = Math.round((running + portion) * 100) / 100;
            if (portion <= 0) {
              // Rounding pushed this bucket to ≤0 — fold the residual into the
              // previous line so credits still sum EXACTLY to mainRevenueAmt.
              const prev = mainRevenueLines[mainRevenueLines.length - 1];
              if (prev && portion < 0) prev.credit = Math.round(((prev.credit ?? 0) + portion) * 100) / 100;
              return;
            }
            mainRevenueLines.push({
              accountId: salesAccId, credit: portion, description: soldItemsDescription,
              ...(cc ? { costCenter: cc } : {}),
            });
          });
        }
      }
    }

    const partyAccountPromise =
      inv.paymentType === "cash" ? getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : getCustomerAccountId(cid, inv.customerId, tx);
    // AR pass-through (mirrors the supplier AP pass-through on purchases):
    // cash/bank invoices route the sale THROUGH the customer's receivable
    // account (DR AR + CR AR collection leg + DR cash/bank) so the turnover
    // and the immediate collection both show on the customer's ledger.
    // Falls back to the old direct debit when the customer has no GL account.
    const customerArPromise =
      (inv.paymentType === "cash" || inv.paymentType === "bank")
        ? getCustomerAccountId(cid, inv.customerId, tx)
        : Promise.resolve(null);
    const [partyAccountId, invCustomerArAccId] = await Promise.all([
      partyAccountPromise,
      customerArPromise,
    ]);
    timing?.mark("party-accounts");
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

    // Debit-side lines shared by both JE shapes (GDN-sourced and normal):
    // credit invoices → single DR customer AR; cash/bank WITH a customer GL
    // account → AR pass-through trio; cash/bank WITHOUT one → legacy direct
    // DR cash/bank (statement pairing still shows; GL AR untouched).
    const journalDescription = `قيد فاتورة مبيعات رقم ${inv.docNumber || inv.id}`;
    const collectionDesc = inv.paymentType === "cash" ? "تحصيل نقدي من العميل" : "تحصيل بنكي من العميل";
    const partyDebitLines =
      (inv.paymentType === "cash" || inv.paymentType === "bank") && invCustomerArAccId
        ? [
            { accountId: invCustomerArAccId, debit: totalAmt,  description: "ذمم العميل (فاتورة نقدية/بنكية)" },
            { accountId: invCustomerArAccId, credit: totalAmt, description: collectionDesc },
            { accountId: partyAccountId,     debit: totalAmt,  description: inv.paymentType === "cash" ? "تحصيل نقدي" : journalDescription },
          ]
        : [
            { accountId: partyAccountId, debit: totalAmt, description: inv.paymentType === "cash" ? "تحصيل نقدي" : inv.paymentType === "bank" ? journalDescription : "ذمم العميل" },
          ];

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
      sourceType: "sales_invoice",
      sourceId: inv.id,
      exchangeRate: inv.exchangeRate,
      executor: tx,
      // Header-level cost center tags every JE line for cost-center reports.
      costCenter: (inv as any).costCenter ?? null,
      description: journalDescription,
      lines: gdnSourced
        ? [
            // Dr Customer/Cash/Bank @ total (AR pass-through for cash/bank)
            ...partyDebitLines,
            // Cr VAT Output (still booked separately — operator can claim it)
            { accountId: taxAccId,               credit: vatAmt,                               description: journalDescription, costCenter: null },
            // Cr Delivery Clearing (replaces revenue + inventory credits)
            { accountId: deliveryClearingAccId!, credit: totalAmt - vatAmt,                    description: "تسوية وسيط تسليم البضاعة" },
          ]
        : [
            // Debits (AR pass-through for cash/bank invoices)
            ...partyDebitLines,
            { accountId: discountAccId, debit: discountAmt, description: "خصم مسموح به" },
            // COGS only when there is cost (stock items); SERVICE-only invoices skip it.
            ...(totalCogs > 0 ? [{ accountId: cogsAccId, debit: totalCogs, description: "تكلفة البضاعة المباعة" }] : []),
            // Credits — main sales revenue (excl. service-routed revenue),
            // split per line-level cost center when present (else one line).
            ...mainRevenueLines,
            // Service revenue → each service item's own revenue account (e.g. مشاريع تحت التنفيذ)
            ...Object.entries(serviceRevenueByAccount)
              .filter(([, amt]) => amt > 0)
              .map(([key, amt]) => {
                const sep = key.indexOf("|");
                const accStr = sep === -1 ? key : key.slice(0, sep);
                const cc = sep === -1 ? "" : key.slice(sep + 1);
                return {
                  accountId: Number(accStr),
                  credit: amt,
                  description: soldItemsDescription,
                  // Per-line cost center wins; empty → header fallback downstream.
                  ...(cc ? { costCenter: cc } : {}),
                };
              }),
            { accountId: taxAccId,       credit: vatAmt,      description: journalDescription, costCenter: null },
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
    timing?.mark("journal-entry");

    // ─── ACTUAL STOCK MUTATION ───
    // Group repeated lines by item/warehouse so each balance is touched once.
    // Distinct balances are independent and can be updated with modest
    // concurrency; remote agent DBs otherwise pay two serial round trips per
    // invoice line inside upsertBalance. Ledger rows are then inserted in one
    // bulk statement while preserving per-pair running balances.
    type StockOpGroup = {
      itemId: number;
      warehouseId: number;
      totalQty: number;
      totalCost: number;
      ops: StockOp[];
    };
    const stockGroups = new Map<string, StockOpGroup>();
    for (const op of stockOps) {
      const key = `${op.itemId}:${op.warehouseId}`;
      const group = stockGroups.get(key);
      if (group) {
        group.totalQty += op.qty;
        group.totalCost += op.qty * op.avgCost;
        group.ops.push(op);
      } else {
        stockGroups.set(key, {
          itemId: op.itemId,
          warehouseId: op.warehouseId,
          totalQty: op.qty,
          totalCost: op.qty * op.avgCost,
          ops: [op],
        });
      }
    }
    const groups = [...stockGroups.values()];
    const newBalances = await applyStockBalanceDeltasBulk(
      cid,
      groups.map((group) => ({
        itemId: group.itemId,
        warehouseId: group.warehouseId,
        deltaQty: -group.totalQty,
        costPrice: group.totalQty > 0 ? group.totalCost / group.totalQty : 0,
      })),
      stockSnapshots,
      tx,
    );
    const appliedGroups = groups.map((group) => {
      const key = `${group.itemId}:${group.warehouseId}`;
      const newBalance = newBalances.get(key);
      if (newBalance === undefined) {
        throw new Error(`تعذر تحديث رصيد المخزون للصنف ${group.itemId} في المخزن ${group.warehouseId}`);
      }
      return { group, newBalance };
    });
    timing?.mark("stock-balances");

    const ledgerEntries: Array<typeof stockLedgerTable.$inferInsert> = [];
    for (const { group, newBalance } of appliedGroups) {
      let cursor = newBalance + group.totalQty;
      for (const op of group.ops) {
        if (!op.picks || op.picks.length === 0) {
          cursor -= op.qty;
          ledgerEntries.push({
            companyId:   cid,
            itemId:      op.itemId,
            warehouseId: op.warehouseId,
            txDate:      inv.invoiceDate,
            txType:      "sale",
            qty:         String(-op.qty),
            costPrice:   String(op.avgCost.toFixed(4)),
            totalCost:   String((-op.qty * op.avgCost).toFixed(2)),
            balanceQty:  String(cursor.toFixed(4)),
            refId:       id,
            refType:     "sales_invoice",
            notes:       op.notes ?? undefined,
          });
          continue;
        }
        for (const pick of op.picks) {
          cursor -= pick.takeQty;
          ledgerEntries.push({
            companyId:   cid,
            itemId:      op.itemId,
            warehouseId: op.warehouseId,
            txDate:      inv.invoiceDate,
            txType:      "sale",
            qty:         String(-pick.takeQty),
            costPrice:   String(pick.costPrice.toFixed(4)),
            totalCost:   String((-pick.takeQty * pick.costPrice).toFixed(2)),
            balanceQty:  String(cursor.toFixed(4)),
            refId:       id,
            refType:     "sales_invoice",
            batchNumber: pick.batchNumber,
            expiryDate:  pick.expiryDate,
            notes:       `${op.notes ?? ""}${pick.batchNumber ? ` — تشغيلة ${pick.batchNumber}` : ""}`.trim() || undefined,
          });
        }
      }
    }
    if (ledgerEntries.length) {
      await tx.insert(stockLedgerTable).values(ledgerEntries);
    }
    timing?.mark("stock-ledger-bulk");

    const [updated] = await tx.update(salesInvoicesTable)
      .set({
        status: "posted",
        journalEntryId: journalId,
        // Heal stale source-company account references left on a draft that
        // was imported from another company. The IDs resolved above are
        // guaranteed to belong to this company.
        salesAccountId: salesAccId,
        cogsAccountId: cogsAccId,
        taxAccountId: taxAccId,
        discountAccountId: discountAccId,
        postedById: req.authUser?.id ?? null,
        postedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(salesInvoicesTable.id, id))
      .returning();
    timing?.mark("invoice-finalize");

    // NOTE: لا نُنشئ سند قبض تلقائياً عند ترحيل فاتورة نقدية/بنكية.
    // القيد المحاسبي أعلاه يكفي لتسجيل الأثر النقدي؛ سند القبض يُنشأ يدوياً عند الحاجة.

    return updated;
    });
    if (!postedInvoice) return;
    // Optional company-level automation: the invoice/stock/JE transaction has
    // already committed at this point. A ZATCA rejection or network failure
    // must never roll back the accounting post; it is persisted on the invoice
    // and remains retryable from the existing manual bridge.
    const [postingCompany] = await db.select({
      autoSendZatcaAfterPost: companiesTable.autoSendZatcaAfterPost,
    }).from(companiesTable).where(eq(companiesTable.id, cid)).limit(1);
    if (postingCompany?.autoSendZatcaAfterPost === true) {
      try {
        const autoReq = Object.create(req);
        autoReq.params = { ...req.params, id: String(id) };
        let autoStatus = 200;
        let autoBody: any = null;
        const autoRes: any = {
          status(code: number) { autoStatus = code; return this; },
          json(body: any) { autoBody = body; return this; },
        };
        await submitSalesInvoiceToZatcaHandler(autoReq, autoRes);
        if (autoStatus >= 400 || autoBody?.status === "rejected") {
          logger.warn({ companyId: cid, invoiceId: id, status: autoStatus, result: autoBody }, "Automatic ZATCA submission was not approved");
        }
      } catch (autoError: any) {
        logger.error({ companyId: cid, invoiceId: id, error: autoError?.message ?? String(autoError) }, "Automatic ZATCA submission failed after posting");
      }
    }
    res.json(postedInvoice);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  } finally {
    if (onFailure && res.statusCode >= 400) {
      try { await onFailure(); }
      catch (cleanupError) { console.error("Failed to roll back mobile save-and-issue", cleanupError); }
    }
  }
}

router.patch(
  "/sales-invoices/:id/post",
  requirePostRight("sales"),
  (req, res) => postSalesInvoiceHandler(req, res),
);

// ─── UNPOST sales invoice (فك الترحيل) ──────────────────────────────────────
router.patch("/sales-invoices/:id/unpost", requireUnpostRight("sales"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (!(await requireMobilePerm(req, res, cid, "invoice_unpost", "ليست لديك صلاحية فك ترحيل فواتير المبيعات من تطبيق الموبايل"))) return;
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

    // ZATCA-approved invoices are sealed fiscal documents: once cleared /
    // reported by the authority they can NEVER be unposted (doing so would
    // break the reported ICV/PIH chain and the legal audit trail).
    const _zsUnpost = String(inv.zatcaStatus || "").toLowerCase();
    if (_zsUnpost === "approved" || _zsUnpost === "cleared" || _zsUnpost === "reported") {
      res.status(409).json({ error: "لا يمكن فك ترحيل فاتورة معتمدة من هيئة الزكاة والضريبة (ZATCA)." });
      return;
    }

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
      // Stash this JE's number so the next re-post reuses it (no gap).
      await reserveJeNumberFromEntry(cid, "sales_invoice", id, inv.journalEntryId);
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
    if (!(await requireMobilePerm(req, res, cid, "invoice_delete", "ليست لديك صلاحية حذف الفواتير من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    // ZATCA-approved invoices can never be deleted — the reported fiscal chain
    // is sealed (this also defends against a rejected→approved edge landing on
    // a draft-status row).
    const _zsDel = String(inv.zatcaStatus || "").toLowerCase();
    if (_zsDel === "approved" || _zsDel === "cleared" || _zsDel === "reported") {
      res.status(409).json({ error: "لا يمكن حذف فاتورة معتمدة من هيئة الزكاة والضريبة (ZATCA)." });
      return;
    }
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

// فك ربط عرض/عروض الأسعار المحوَّلة إلى هذه الفاتورة — يعيد عرض السعر إلى
// حالة "accepted" ويصفّر converted_invoice_id حتى يصبح بالإمكان حذف الفاتورة
// أو إعادة تحويل العرض لاحقاً. لا يوجد عمود back-link على sales_invoices، لذا
// الرابط الوحيد هو sales_quotations.converted_invoice_id.
router.post("/sales-invoices/:id/unlink-quotation", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف فاتورة غير صحيح" }); return; }
    // Branch-level isolation (IDOR-within-tenant): a restricted user must not
    // unlink a quotation tied to an invoice in a branch they aren't linked to,
    // mirroring GET/PATCH /sales-invoices/:id. Shared rows (branch_id NULL) ok.
    const [inv] = await db.select({ id: salesInvoicesTable.id, status: salesInvoicesTable.status })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.id, id),
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, undefined),
      ));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") {
      res.status(400).json({ error: "لا يمكن فك ربط فاتورة مُرحَّلة. قم بإلغاء الترحيل أولاً." });
      return;
    }
    const unlinked = await db.update(salesQuotationsTable)
      .set({ status: "accepted", convertedInvoiceId: null, updatedAt: new Date() })
      .where(and(
        eq(salesQuotationsTable.companyId, cid),
        eq(salesQuotationsTable.convertedInvoiceId, id),
      ))
      .returning({ id: salesQuotationsTable.id, docNumber: salesQuotationsTable.docNumber });
    res.json({ ok: true, unlinked });
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
      .where(and(
        eq(salesReturnsTable.id, id),
        cid ? eq(salesReturnsTable.companyId, cid) : sql`true`,
        // Branch isolation: a branch-restricted user must not read another
        // branch's return by guessing its id (mirrors invoice detail).
        ...multiBranchScopeSpread(req, salesReturnsTable.branchId, undefined),
      ));
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
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set<number>((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "sales_returns", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
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
    // Foreign-customer numbering: a non-SA buyer draws from the separate
    // "sales_return_foreign" series (if configured). ZATCA chain stays unified.
    let buyerIsForeign = false;
    if (resolvedCustomerId) {
      const [cc] = await db.select({ country: customersTable.country })
        .from(customersTable)
        .where(and(eq(customersTable.id, resolvedCustomerId), eq(customersTable.companyId, cid)));
      buyerIsForeign = !!cc && String(cc.country ?? "SA").toUpperCase() !== "SA";
    }
    let resolvedDocNumber: string | null;
    try {
      const allocateReturnNumber = () => nextSequenceForPayment(cid, "sales_return", pType, {
        userId: (req as any).authUser?.id ?? null,
        refTable: "sales_returns",
        branchId: resolvedBranchId,
        docDate: returnDate,
      }, buyerIsForeign);
      let fromSeq = await allocateReturnNumber();
      for (let skipped = 0; fromSeq != null; skipped += 1) {
        const duplicate = await db.select({ id: salesReturnsTable.id })
          .from(salesReturnsTable)
          .where(and(
            eq(salesReturnsTable.companyId, cid),
            eq(salesReturnsTable.docNumber, fromSeq),
          ))
          .limit(1);
        if (!duplicate.length) break;
        if (skipped >= 999) throw new Error("تعذر الوصول إلى رقم مرتجع غير مستخدم بعد الاستعادة");
        fromSeq = await allocateReturnNumber();
      }
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم المرتجع" });
      return;
    }
    const requestedReturnAccountIds = [
      cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
    ].map(Number).filter((id) => Number.isInteger(id) && id > 0);
    const validReturnAccountIds = requestedReturnAccountIds.length
      ? new Set((await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
          eq(accountsTable.companyId, cid),
          inArray(accountsTable.id, [...new Set(requestedReturnAccountIds)]),
        ))).map((row) => row.id))
      : new Set<number>();
    const validReturnAccount = (value: unknown): number | null => {
      const id = Number(value);
      return Number.isInteger(id) && validReturnAccountIds.has(id) ? id : null;
    };
    const returnValues: any = {
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
      // Creation channel — 'mobile' when the companion app created the doc.
      sourceChannel: String(req.headers["x-app-channel"] ?? "").toLowerCase() === "mobile" ? "mobile" : null,
      // Manual session (admin-created) the user is currently working under,
      // resolved by extractAuth from the trusted x-session-id header.
      sessionId: (req as any).manualSessionId ?? null,
      salesRepId:         resolvedRepId,
      cogsAccountId:      validReturnAccount(cogsAccountId),
      inventoryAccountId: validReturnAccount(inventoryAccountId),
      salesAccountId:     validReturnAccount(salesAccountId),
      taxAccountId:       validReturnAccount(taxAccountId),
      discountAccountId:  validReturnAccount(discountAccountId),
      taxId:              taxId ? Number(taxId) : null,
      createdById: (req as any).authUser?.id ?? null,
    };
    let ret: typeof salesReturnsTable.$inferSelect;
    try {
      [ret] = await db.insert(salesReturnsTable).values(returnValues).returning();
    } catch (insertError: any) {
      const code = String(postgresErrorField(insertError, "code") ?? "");
      const constraint = String(
        postgresErrorField(insertError, "constraint_name")
          ?? postgresErrorField(insertError, "constraint")
          ?? "",
      );
      if (code !== "23505" || !constraint.includes("pkey")) throw insertError;
      await db.execute(sql`
        SELECT setval(
          pg_get_serial_sequence('sales_returns', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM sales_returns), 0) + 1, 1),
          false
        )
      `);
      [ret] = await db.insert(salesReturnsTable).values(returnValues).returning();
    }
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
  } catch (e: any) {
    logger.error({ err: e }, "sales return create failed");
    const friendly = salesReturnWriteError(e);
    res.status(friendly.status).json({ error: friendly.message });
  }
});

router.put("/sales-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (!(await requireMobilePerm(req, res, cid, "return_edit", "ليست لديك صلاحية تعديل المرتجعات من تطبيق الموبايل"))) return;
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

router.patch("/sales-returns/:id/post", requirePostRight("sales"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (!(await requireMobilePerm(req, res, cid, "return_post", "ليست لديك صلاحية ترحيل مرتجعات المبيعات من تطبيق الموبايل"))) return;
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

    // Item Usage Control (Phase ب): block posting a doc carrying restricted items.
    {
      const usageIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "sales_returns", usageIds, req.authUser, "post");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "post"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }

    // Per-item metadata (batch mode + TYPE). SERVICE items (خدمي) never touch
    // stock, so they are EXEMPT from the warehouse requirement below — a pure
    // service return line legitimately carries no warehouse and must still post.
    const retItemIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
    const retItemRows = retItemIds.length
      ? await db
          .select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode, type: itemsTable.itemType })
          .from(itemsTable)
          .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, retItemIds)))
      : [];
    const retModeById = new Map<number, "none" | "fifo" | "fefo">();
    const retTypeById = new Map<number, string>();
    for (const r of retItemRows) {
      const m = (r.mode ?? "none") as string;
      retModeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
      retTypeById.set(r.id, (r.type ?? "stock") as string);
    }
    const isServiceLine = (l: any) => { if (!l.itemId) return false; const t = retTypeById.get(l.itemId); return t === "service" || t === "prepaid_expense"; };

    const noWh = lines.filter(l => l.itemId && !l.warehouseId && !isServiceLine(l));
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
      if (qty <= 0 || price <= 0) continue;
      const grossPre = qty * price;
      const discGross = effectiveLineDiscount(ln, grossPre);
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
      : await getCustomerAccountId(cid, ret.customerId, tx);
    // AR pass-through (mirrors purchases): cash/bank returns route through
    // the customer's receivable account (CR AR + DR AR refund leg + CR
    // cash/bank) so the return AND the cash refund both show on the ledger.
    const retCustomerArAccId =
      (ret.paymentType === "cash" || ret.paymentType === "bank")
        ? await getCustomerAccountId(cid, ret.customerId, tx)
        : null;
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
      sourceType: "sales_return",
      sourceId: ret.id,
      exchangeRate: ret.exchangeRate,
      // Inherit cost center from the original invoice when set so the
      // return tags the same CC as the sale it reverses.
      costCenter: (ret as any).costCenter ?? null,
      description: `قيد مرتجع مبيعات رقم ${ret.docNumber || ret.id}`,
      lines: [
        // Debits (reversed from the original sale)
        { accountId: salesAccId,     debit: subtotalAmt, description: "تخفيض إيراد المبيعات (مرتجع)" },
        { accountId: taxAccId,       debit: vatAmt,      description: "تخفيض ضريبة المخرجات", costCenter: null },
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
        // Credits (reversed from the original sale) — AR pass-through for
        // cash/bank returns: CR AR (reduce receivable) + DR AR (refund leg)
        // + CR cash/bank; falls back to old direct credit when the customer
        // has no GL account.
        ...((ret.paymentType === "cash" || ret.paymentType === "bank") && retCustomerArAccId
          ? [
              { accountId: retCustomerArAccId, credit: totalAmt, description: "تخفيض رصيد العميل بالمرتجع" },
              { accountId: retCustomerArAccId, debit: totalAmt,  description: ret.paymentType === "cash" ? "رد نقدي للعميل" : "رد بنكي للعميل" },
              { accountId: partyAccountId,     credit: totalAmt, description: ret.paymentType === "cash" ? "رد نقدي" : "رد بنكي" },
            ]
          : [
              { accountId: partyAccountId, credit: totalAmt, description: ret.paymentType === "cash" ? "رد نقدي" : ret.paymentType === "bank" ? "رد بنكي" : "تخفيض ذمم العميل" },
            ]),
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
    // ZATCA is deliberately outside the accounting result. A gateway rejection
    // or connection failure is logged, never allowed to turn a successful post
    // into an error response or roll back its inventory / journal effects.
    const [postCompany] = await db.select({ autoSendZatcaAfterPost: companiesTable.autoSendZatcaAfterPost })
      .from(companiesTable).where(eq(companiesTable.id, cid));
    if (postCompany?.autoSendZatcaAfterPost) {
      void submitSalesReturnToZatca(cid, id).then((outcome) => {
        if (outcome.httpStatus >= 400 || outcome.body.status === "rejected") {
          logger.warn({ companyId: cid, returnId: id, outcome: outcome.body }, "Automatic ZATCA sales-return submission rejected");
        }
      }).catch((err) => {
        logger.error({ err, companyId: cid, returnId: id }, "Automatic ZATCA sales-return submission failed");
      });
    }

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST sales return (فك الترحيل) ───────────────────────────────────────
router.patch("/sales-returns/:id/unpost", requireUnpostRight("sales"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (!(await requireMobilePerm(req, res, cid, "return_unpost", "ليست لديك صلاحية فك ترحيل مرتجعات المبيعات من تطبيق الموبايل"))) return;
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
    if (ret.zatcaStatus === "cleared" || ret.zatcaStatus === "reported") {
      res.status(400).json({ error: "لا يمكن فك ترحيل مرتجع تم اعتماده لدى ZATCA." }); return;
    }

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
      // Stash this JE's number so the next re-post reuses it (no gap).
      await reserveJeNumberFromEntry(cid, "sales_return", id, ret.journalEntryId);
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
    if (!(await requireMobilePerm(req, res, cid, "return_delete", "ليست لديك صلاحية حذف المرتجعات من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.zatcaStatus === "cleared" || ret.zatcaStatus === "reported") {
      res.status(400).json({ error: "لا يمكن حذف مرتجع تم اعتماده لدى ZATCA." }); return;
    }
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
    if (!(await requireMobilePerm(req, res, cid, "quotations_view", "ليست لديك صلاحية عرض عروض الأسعار من تطبيق الموبايل"))) return;
    const rows = await db.select().from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(salesQuotationsTable.quotationDate));
    // Resolve creator usernames in one pass so the grid can render the
    // "أنشأه" column without an extra round trip (mirrors the invoice grid).
    const { usersTable } = await import("@workspace/db");
    const { inArray: _inArr } = await import("drizzle-orm");
    const creatorIds = Array.from(new Set(
      rows.map(r => r.createdById).filter((x): x is number => typeof x === "number")
    ));
    const creatorMap = new Map<number, string>();
    if (creatorIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(_inArr(usersTable.id, creatorIds));
      for (const u of us) creatorMap.set(u.id, u.username);
    }
    res.json(rows.map(r => ({
      ...r,
      createdByName: r.createdById != null ? (creatorMap.get(r.createdById) ?? null) : null,
    })));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!(await requireMobilePerm(req, res, cid, "quotations_view", "ليست لديك صلاحية عرض عروض الأسعار من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    // Branch-level isolation (mirror of /sales-invoices/:id): a restricted
    // user (viewAllBranches=false) must not fetch a quotation from a branch
    // they aren't linked to, even via a guessed id. Shared rows (NULL) stay.
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.id, id),
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, undefined),
      ));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    const [lines, currencyRows, customerRows] = await Promise.all([
      db.select().from(salesQuotationLinesTable)
        .where(eq(salesQuotationLinesTable.quotationId, id))
        .orderBy(asc(salesQuotationLinesTable.id)),
      db.select({
        code: currenciesTable.code,
        nameAr: currenciesTable.nameAr,
        nameEn: currenciesTable.nameEn,
        symbol: currenciesTable.symbol,
      }).from(currenciesTable).where(and(
        eq(currenciesTable.companyId, cid),
        eq(currenciesTable.code, q.currencyCode),
      )).limit(1),
      q.customerId
        ? db.select().from(customersTable).where(and(
            eq(customersTable.id, q.customerId),
            eq(customersTable.companyId, cid),
          )).limit(1)
        : Promise.resolve([]),
    ]);
    res.json({
      ...q,
      lines,
      currency: currencyRows[0] ?? null,
      customer: customerRows[0] ?? null,
    });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

function mapQuotationLine(l: any, quotationId: number, cid: number, fallbackRate = "15") {
  return {
    quotationId, companyId: cid,
    itemId:    l.itemId   ? Number(l.itemId)   : null,
    itemName:  String(l.itemName ?? l.name ?? (l.itemId != null ? `صنف ${l.itemId}` : "صنف")),
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
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines, taxId, branchId } = req.body;
    if (!quotationDate) { res.status(400).json({ error: "تاريخ العرض مطلوب" }); return; }
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set<number>((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "sales_quotations", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
    // Quotations are now branch-owned (like invoices) — a new quotation MUST
    // carry a branch so it can be scoped. Don't rely on the UI alone.
    if (!branchId) { res.status(400).json({ error: "يجب اختيار الفرع" }); return; }
    // Authorize the requested branch: a restricted user must not write into a
    // branch they aren't linked to (presence alone isn't enough — they could
    // submit another branch's id directly).
    if (intersectBranchRequest(req, Number(branchId)) === "deny") {
      res.status(403).json({ error: "غير مصرح لك بهذا الفرع", field: "branchId" }); return;
    }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const [q] = await db.insert(salesQuotationsTable).values({
      companyId: cid, docNumber: docNumber || null, quotationDate,
      branchId: branchId ? Number(branchId) : null,
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
      createdById: req.authUser?.id ?? null,
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
    if (!(await requireMobilePerm(req, res, cid, "quotation_edit", "ليست لديك صلاحية تعديل عروض الأسعار من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    const { docNumber, quotationDate, validUntil, customerId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines, taxId, branchId } = req.body;
    // Branch presence required on edit too (quotations are branch-owned).
    if (!branchId) { res.status(400).json({ error: "يجب اختيار الفرع" }); return; }
    // Authorize the target branch: a restricted user must not reassign a
    // quotation into a branch they aren't linked to.
    if (intersectBranchRequest(req, Number(branchId)) === "deny") {
      res.status(403).json({ error: "غير مصرح لك بهذا الفرع", field: "branchId" }); return;
    }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    // Branch-scope guard: a restricted user can't edit another branch's
    // quotation (mirror of the by-id read guard).
    const [scoped] = await db.select({ id: salesQuotationsTable.id, status: salesQuotationsTable.status }).from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.id, id),
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, undefined),
      ));
    if (!scoped) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    // Terminal-state immutability: accepted/rejected/converted quotations are
    // read-only (the UI enforces this, but it must hold server-side too).
    if (!["draft", "sent"].includes(String(scoped.status ?? "draft"))) {
      res.status(400).json({ error: "لا يمكن تعديل عرض سعر مقبول أو مرفوض أو محوّل لفاتورة" }); return;
    }
    const [q] = await db.update(salesQuotationsTable).set({
      docNumber: docNumber || null, quotationDate,
      branchId: branchId ? Number(branchId) : null,
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
    if (!(await requireMobilePerm(req, res, cid, "quotation_edit", "ليست لديك صلاحية تعديل عروض الأسعار من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!["draft","sent","accepted","rejected","converted"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    if (status === "converted") {
      res.status(400).json({ error: "استخدم مسار التحويل لإصدار الفاتورة" }); return;
    }
    const [current] = await db.select().from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.id, id),
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, undefined),
      ));
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
    if (!(await requireMobilePerm(req, res, cid, "quotation_edit", "ليست لديك صلاحية تحويل عروض الأسعار من تطبيق الموبايل"))) return;
    // التحويل ينشئ فاتورة مبيعات — يتطلب أيضاً صلاحية إنشاء الفواتير
    if (!(await requireMobilePerm(req, res, cid, "invoice_create", "ليست لديك صلاحية إنشاء فاتورة مبيعات من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.id, id),
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, undefined),
      ));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (q.convertedInvoiceId) { res.status(400).json({ error: "تم التحويل مسبقاً" }); return; }
    if (q.status !== "accepted") {
      res.status(400).json({ error: "يجب قبول العرض قبل التحويل لفاتورة" }); return;
    }

    const lines = await db.select().from(salesQuotationLinesTable)
      .where(eq(salesQuotationLinesTable.quotationId, id));

    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, docNumber: null, invoiceDate: new Date().toISOString().slice(0,10),
      branchId: q.branchId ?? null,
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
    if (!(await requireMobilePerm(req, res, cid, "quotation_delete", "ليست لديك صلاحية حذف عروض الأسعار من تطبيق الموبايل"))) return;
    const id = Number(req.params.id);
    // Branch-scope the delete so a restricted user can't remove another
    // branch's quotation (mirror of the by-id read guard).
    const [target] = await db.select({ id: salesQuotationsTable.id }).from(salesQuotationsTable)
      .where(and(
        eq(salesQuotationsTable.id, id),
        eq(salesQuotationsTable.companyId, cid),
        ...branchScopeSpread(req, salesQuotationsTable.branchId, undefined),
      ));
    if (!target) { res.status(404).json({ error: "العرض غير موجود" }); return; }
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
    // Item Usage Control (Phase ب): block a save containing restricted items.
    {
      const usageIds = Array.from(new Set<number>((lines ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0)));
      const usageV = await checkItemsUsable(cid, "sales_orders", usageIds, req.authUser, "save");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
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

router.patch("/customer-settlements/:id/post", requirePostRight("sales"), async (req, res) => {
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
router.patch("/customer-settlements/:id/unpost", requireUnpostRight("sales"), async (req, res) => {
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
async function submitSalesInvoiceToZatcaUnlocked(req: any, res: any) {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    // Posting retries and manual retries must not re-submit an invoice that
    // ZATCA already accepted. This also makes the optional post hook idempotent.
    if (inv.zatcaStatus === "cleared" || inv.zatcaStatus === "reported") {
      res.json({
        status: "approved",
        zatcaStatus: inv.zatcaStatus,
        uuid: inv.zatcaUuid,
        message: "الفاتورة مرسلة ومعتمدة مسبقًا لدى ZATCA.",
      });
      return;
    }

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

    // Re-check while holding the same advisory chain lock as transfer prepare.
    // This closes the submit-vs-freeze race.
    await assertZatcaSubmissionAllowed(cid);
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

    // ─── ICV / PIH chain (shared by invoices AND credit notes) ────────────
    const chain = await resolveZatcaChain(cid);
    const invoiceCounterValue = chain.maxIcv + 1;
    const previousInvoiceHash = chain.previousInvoiceHash;

    const issueTime = now.toTimeString().split(" ")[0];
    // ZATCA requires the API-body `uuid` (and the matching cbc:UUID embedded in
    // the XML) to be a real GUID. The human doc number ("160") and the
    // `SINV-<id>` fallback are NOT valid UUIDs — the clearance gateway rejects
    // them with "UUID format in the API body is not valid". Generate a proper
    // UUID and use the SAME value for both the embedded XML and the body.
    const documentUuid = randomUUID();
    const mapped = salesInvoiceRowToZatcaData(inv, lines, company, customer, {
      invoiceCounterValue,
      previousInvoiceHash,
      issueTime,
    });
    mapped.data.uuid = documentUuid;

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

    // Guard: a sandbox-issued CSID/PCSID cannot authenticate against the live
    // simulation/production gateway — surface it clearly instead of an opaque 500.
    const envMismatch = csidEnvMismatchMessage(authToken, env);
    if (envMismatch) {
      await db.update(salesInvoicesTable).set({
        zatcaStatus: "rejected",
        zatcaSubmittedAt: now,
        zatcaResponseCode: "401",
        zatcaErrorMessages: JSON.stringify([{ code: "ENV_CSID_MISMATCH", message: envMismatch }]),
        updatedAt: now,
      }).where(eq(salesInvoicesTable.id, id));
      res.status(422).json({ status: "rejected", errors: [{ code: "ENV_CSID_MISMATCH", message: envMismatch }] });
      return;
    }

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
    const uuid = documentUuid;

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

    // Read the body as text FIRST, then JSON.parse. ZATCA can answer a
    // rejection with a non-JSON body (HTML error page / empty body); calling
    // response.json() directly would throw → fall into the catch → a generic
    // "فشل الاتصال" 500 with no stored reason. Parsing defensively lets us keep
    // the raw text as the error message instead.
    const rawText = await response.text();
    let data: {
      reportingStatus?: string;
      clearanceStatus?: string;
      warningMessages?: Array<{ code: string; message: string }>;
      errorMessages?: Array<{ code: string; message: string }>;
      validationResults?: {
        warningMessages?: Array<{ code: string; message: string }>;
        errorMessages?: Array<{ code: string; message: string }>;
      };
      message?: string;
      code?: string | number;
    } = {};
    try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = {}; }

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

    // Normalize ZATCA validation messages from EVERY shape the gateway uses
    // (top-level *Messages OR nested validationResults.*Messages), and ALWAYS
    // synthesize a reason on rejection so the ZATCA bridge never shows
    // "0 خطأ" with no detail. Falls back to the gateway message / raw body /
    // HTTP status when no structured validation errors are present.
    const normMsgs = (arr: unknown): Array<{ code: string; message: string }> =>
      (Array.isArray(arr) ? arr : []).map((m: any) => ({
        code: String(m?.code ?? m?.type ?? "ZATCA"),
        message: String(m?.message ?? m ?? "").trim() || "—",
      }));
    const zErrors = normMsgs(data.errorMessages ?? data.validationResults?.errorMessages);
    const zWarnings = normMsgs(data.warningMessages ?? data.validationResults?.warningMessages);
    const finalErrors = succeeded
      ? zErrors
      : (zErrors.length ? zErrors : [{
          code: data.code != null ? String(data.code) : `HTTP-${response.status}`,
          message:
            (data.message && String(data.message).trim())
            || (rawText && rawText.trim().length > 0 && rawText.trim().length < 1500 ? rawText.trim() : "")
            || `رفضت بوابة ZATCA الفاتورة (رمز ${response.status}) دون تفاصيل تحقق. راجع بيانات الفاتورة وأعد الإرسال.`,
        }]);

    await db.update(salesInvoicesTable).set({
      zatcaStatus: newStatus,
      zatcaSubmittedAt: now,
      zatcaUuid: succeeded ? uuid : null,
      zatcaResponseCode: String(response.status),
      zatcaErrorMessages: finalErrors.length ? JSON.stringify(finalErrors) : null,
      zatcaWarningMessages: zWarnings.length ? JSON.stringify(zWarnings) : (warnings.length ? JSON.stringify(warnings) : null),
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
        errors: finalErrors,
        warnings: zWarnings.length ? zWarnings : warnings,
        zatcaResponse: data,
        hint: response.ok
          ? "قبلت بوابة ZATCA الطلب لكن لم يتم تخليص/إبلاغ الفاتورة. راجع رسائل التحقق وصحّح البيانات."
          : "راجع رسائل الخطأ من ZATCA وتحقق من صحة بيانات الفاتورة.",
      });
      return;
    }

    res.json({
      // Frontend bridge understands only approved/rejected/pending. This path
      // is reached only when succeeded === true, so report "approved" (detailed
      // cleared/reported value stays in zatcaStatus below).
      status: "approved",
      uuid,
      zatcaStatus: newStatus,
      clearanceStatus: data.clearanceStatus,
      reportingStatus: data.reportingStatus,
      warnings: zWarnings.length ? zWarnings : warnings,
      message: mapped.invoiceType === "simplified"
        ? "تم إبلاغ ZATCA بالفاتورة المبسطة بنجاح."
        : "تم تخليص الفاتورة الضريبية بنجاح.",
    });
  } catch (e: any) {
    if (e?.code === "ZATCA_TRANSFER_LOCKED") {
      res.status(e.httpStatus ?? 409).json({ error: e.message, code: e.code });
      return;
    }
    res.status(500).json({ error: "فشل الاتصال بـ ZATCA", details: e?.message ?? String(e) });
  }
}

async function submitSalesInvoiceToZatcaHandler(req: any, res: any) {
  const cid = guard(req, res); if (!cid) return;
  return withZatcaChainLock(cid, () => submitSalesInvoiceToZatcaUnlocked(req, res));
}

router.post("/sales-invoices/:id/zatca-submit", submitSalesInvoiceToZatcaHandler);

type ZatcaSubmitOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

/**
 * Submit a posted sales return as a 381 credit note. Kept independent from the
 * accounting posting transaction: callers may safely log an unsuccessful
 * submission without rolling back a correctly posted return.
 */
async function submitSalesReturnToZatcaUnlocked(companyId: number, id: number): Promise<ZatcaSubmitOutcome> {
  await assertZatcaSubmissionAllowed(companyId);
  const [ret] = await db.select().from(salesReturnsTable).where(and(
    eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, companyId),
  ));
  if (!ret) return { httpStatus: 404, body: { error: "المرتجع غير موجود" } };
  if (ret.zatcaStatus === "cleared" || ret.zatcaStatus === "reported") {
    return { httpStatus: 200, body: { status: "approved", zatcaStatus: ret.zatcaStatus, uuid: ret.zatcaUuid, message: "المرتجع مرسل ومعتمد مسبقًا لدى ZATCA." } };
  }

  const lines = await db.select().from(salesReturnLinesTable)
    .where(and(eq(salesReturnLinesTable.returnId, id), eq(salesReturnLinesTable.companyId, companyId)));
  const [original] = ret.invoiceId ? await db.select().from(salesInvoicesTable).where(and(
    eq(salesInvoicesTable.id, ret.invoiceId), eq(salesInvoicesTable.companyId, companyId),
  )) : [];
  const errors: Array<{ code: string; message: string }> = [];
  if (ret.status !== "posted") errors.push({ code: "BR-KSA-DRAFT", message: "لا يمكن إرسال مرتجع غير مُرحّل إلى الزكاة." });
  if (!lines.length) errors.push({ code: "BR-KSA-LINES", message: "المرتجع لا يحتوي على أي بنود." });
  if (Number(ret.totalAmount) <= 0) errors.push({ code: "BR-KSA-AMOUNT", message: "إجمالي المرتجع يجب أن يكون أكبر من صفر." });
  if (!original || original.status !== "posted" || !original.docNumber) {
    errors.push({ code: "BR-KSA-ORIGINAL", message: "يلزم ربط المرتجع بفاتورة مصدر مُرحّلة في نفس الشركة ولها رقم مستند." });
  }
  const now = new Date();
  const reject = async (status: number, errs: Array<{ code: string; message: string }>, warnings: unknown[] = []) => {
    await db.update(salesReturnsTable).set({
      zatcaStatus: "rejected", zatcaSubmittedAt: now, zatcaUuid: null,
      zatcaResponseCode: String(status), zatcaErrorMessages: JSON.stringify(errs),
      zatcaWarningMessages: warnings.length ? JSON.stringify(warnings) : null,
      zatcaAiSuggestion: null, updatedAt: now,
    }).where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, companyId)));
    return { httpStatus: status === 400 ? 200 : status, body: { status: "rejected", errors: errs, warnings } };
  };
  if (errors.length) return reject(400, errors);

  const customer = ret.customerId ? (await db.select().from(customersTable).where(and(
    eq(customersTable.id, ret.customerId), eq(customersTable.companyId, companyId),
  )))[0] ?? null : null;
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) return { httpStatus: 404, body: { error: "الشركة غير موجودة" } };
  const authToken = company.zatcaPcsidToken ?? company.zatcaCsidToken;
  const authSecret = company.zatcaPcsidSecret ?? company.zatcaCsidSecret;
  if (!authToken || !authSecret || !company.zatcaPrivateKey) {
    return { httpStatus: 400, body: { error: "لا توجد بيانات توقيع ZATCA مكتملة للشركة." } };
  }
  const env = resolveZatcaEnv(company);
  const mismatch = csidEnvMismatchMessage(authToken, env);
  if (mismatch) return reject(422, [{ code: "ENV_CSID_MISMATCH", message: mismatch }]);

  // The company chain is shared by invoices and credit notes. Only accepted
  // documents advance ICV/PIH; rejected attempts never affect it.
  const chain = await resolveZatcaChain(companyId);
  const maxIcv = chain.maxIcv;
  const previousInvoiceHash = chain.previousInvoiceHash;
  const issueTime = now.toTimeString().split(" ")[0];
  const mapped = salesReturnRowToZatcaData(ret, lines, company, customer, {
    invoiceCounterValue: maxIcv + 1, previousInvoiceHash, issueTime,
  }, original!.docNumber!);
  const tolerance = 0.02 + lines.length * 0.01;
  if (Math.abs(mapped.computedGrandTotalSar - mapped.storedGrandTotalSar) > tolerance) {
    return reject(422, [{ code: "BR-KSA-RECON", message: "تعذّر مطابقة إجمالي المرتجع مع الإجمالي المخزّن." }]);
  }
  const uuid = randomUUID();
  mapped.data.uuid = uuid;
  const built = buildSignedZatcaInvoice({
    invoiceData: mapped.data, certificatePem: authToken, privateKeyPem: company.zatcaPrivateKey,
    seller: { nameAr: company.nameAr ?? "", vatNumber: company.vatNumber ?? "" },
    qr: { invoiceTimestamp: `${ret.returnDate}T${issueTime}Z`, invoiceTotal: mapped.data.grandTotal, vatAmount: mapped.data.vatTotal },
  });
  const simplified = mapped.invoiceType === "simplified";
  const response = await fetch(`${getZatcaBaseUrl(env)}/invoices/${simplified ? "reporting" : "clearance"}/single`, {
    method: "POST", headers: {
      "Accept-Version": "V2", "Accept-Language": "en",
      "Authorization": "Basic " + Buffer.from(`${authToken}:${authSecret}`).toString("base64"),
      "Clearance-Status": simplified ? "0" : "1", "Content-Type": "application/json",
    },
    body: JSON.stringify({ invoiceHash: built.invoiceHash, uuid, invoice: Buffer.from(built.finalXml).toString("base64") }),
  });
  const raw = await response.text();
  let gateway: any = {}; try { gateway = raw ? JSON.parse(raw) : {}; } catch { /* normalized below */ }
  const accepted = simplified
    ? ["REPORTED", "REPORTED_WITH_WARNINGS"].includes(String(gateway.reportingStatus ?? "").toUpperCase())
    : String(gateway.clearanceStatus ?? "").toUpperCase() === "CLEARED";
  const succeeded = response.ok && accepted;
  const normalize = (items: unknown) => (Array.isArray(items) ? items : []).map((m: any) => ({
    code: String(m?.code ?? m?.type ?? "ZATCA"), message: String(m?.message ?? m ?? "—").trim() || "—",
  }));
  const zErrors = normalize(gateway.errorMessages ?? gateway.validationResults?.errorMessages);
  const zWarnings = normalize(gateway.warningMessages ?? gateway.validationResults?.warningMessages);
  const finalErrors = succeeded ? zErrors : (zErrors.length ? zErrors : [{
    code: gateway.code != null ? String(gateway.code) : `HTTP-${response.status}`,
    message: String(gateway.message ?? "").trim() || (raw.trim().length < 1500 ? raw.trim() : "") || `رفضت بوابة ZATCA إشعار الدائن (رمز ${response.status}).`,
  }]);
  const zatcaStatus = succeeded ? (simplified ? "reported" : "cleared") : "rejected";
  await db.update(salesReturnsTable).set({
    zatcaStatus, zatcaSubmittedAt: now, zatcaUuid: succeeded ? uuid : null,
    zatcaResponseCode: String(response.status), zatcaErrorMessages: finalErrors.length ? JSON.stringify(finalErrors) : null,
    zatcaWarningMessages: zWarnings.length ? JSON.stringify(zWarnings) : null, zatcaAiSuggestion: null,
    xmlContent: built.finalXml, invoiceHash: succeeded ? built.invoiceHash : null,
    zatcaIcv: succeeded ? maxIcv + 1 : null, zatcaPih: previousInvoiceHash, updatedAt: now,
  }).where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, companyId)));
  return succeeded
    ? { httpStatus: 200, body: { status: "approved", zatcaStatus, uuid, warnings: zWarnings } }
    : { httpStatus: response.ok ? 422 : response.status, body: { status: "rejected", zatcaStatus, errors: finalErrors, warnings: zWarnings } };
}

async function submitSalesReturnToZatca(companyId: number, id: number): Promise<ZatcaSubmitOutcome> {
  return withZatcaChainLock(companyId, () => submitSalesReturnToZatcaUnlocked(companyId, id));
}

router.post("/sales-returns/:id/zatca-submit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const outcome = await submitSalesReturnToZatca(cid, Number(req.params.id));
    res.status(outcome.httpStatus).json(outcome.body);
  } catch (e: any) {
    if (e?.code === "ZATCA_TRANSFER_LOCKED") {
      res.status(e.httpStatus ?? 409).json({ error: e.message, code: e.code });
      return;
    }
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
        // Only POSTED (مرحّلة) invoices belong in the ZATCA bridge — draft
        // (مسودة) invoices are NOT eligible for submission and must never
        // appear here (they also skewed the header totals).
        eq(salesInvoicesTable.status, "posted"),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ))
      .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id));
    const returnRows = await db.select({
      id:                   salesReturnsTable.id,
      docNumber:            salesReturnsTable.docNumber,
      invoiceDate:          salesReturnsTable.returnDate,
      customerId:           salesReturnsTable.customerId,
      customerNameAr:       customersTable.nameAr,
      customerVatNumber:    customersTable.vatNumber,
      totalAmount:          salesReturnsTable.totalAmount,
      vatAmount:            salesReturnsTable.vatAmount,
      status:               salesReturnsTable.status,
      zatcaStatus:          salesReturnsTable.zatcaStatus,
      zatcaSubmittedAt:     salesReturnsTable.zatcaSubmittedAt,
      zatcaUuid:            salesReturnsTable.zatcaUuid,
      zatcaErrorMessages:   salesReturnsTable.zatcaErrorMessages,
      zatcaWarningMessages: salesReturnsTable.zatcaWarningMessages,
      zatcaResponseCode:    salesReturnsTable.zatcaResponseCode,
      originalDocNumber:    salesInvoicesTable.docNumber,
    })
      .from(salesReturnsTable)
      .leftJoin(customersTable, and(
        eq(salesReturnsTable.customerId, customersTable.id),
        eq(customersTable.companyId, cid),
      ))
      .leftJoin(salesInvoicesTable, and(
        eq(salesReturnsTable.invoiceId, salesInvoicesTable.id),
        eq(salesInvoicesTable.companyId, cid),
      ))
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        eq(salesReturnsTable.status, "posted"),
        ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
      ))
      .orderBy(desc(salesReturnsTable.returnDate), desc(salesReturnsTable.id));
    // Normalize the persisted ZATCA status to the 3 buckets the bridge UI
    // renders (approved/rejected/pending). The DB stores the detailed
    // cleared/reported on success — without this, a cleared invoice has NO
    // badge and is counted in neither approved nor rejected totals.
    const normZatca = (s: string | null): "approved" | "rejected" | "pending" => {
      if (s === "cleared" || s === "reported" || s === "approved") return "approved";
      if (s === "rejected") return "rejected";
      return "pending";
    };
    // `sourceType` is part of identity: invoice #7 and return #7 are distinct
    // bridge rows and must route to different submit/detail endpoints.
    res.json([
      ...rows.map((r) => ({
        ...r, sourceType: "invoice" as const, sourceId: r.id,
        documentType: "invoice" as const, originalDocNumber: null,
        zatcaStatus: normZatca(r.zatcaStatus),
      })),
      ...returnRows.map((r) => ({
        ...r, sourceType: "return" as const, sourceId: r.id,
        documentType: "credit" as const, zatcaStatus: normZatca(r.zatcaStatus),
      })),
    ].sort((a, b) => String(b.invoiceDate).localeCompare(String(a.invoiceDate)) || b.sourceId - a.sourceId));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

export default router;
