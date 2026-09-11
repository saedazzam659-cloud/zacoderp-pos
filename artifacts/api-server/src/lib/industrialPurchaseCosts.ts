import {
  branchesTable,
  costCentersTable,
  purchaseInvoiceLinesTable,
  purchaseInvoicesTable,
  purchaseReturnLinesTable,
  purchaseReturnsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { assertWritableForDate } from "./periodGuard.js";

export const INDUSTRIAL_COST_TYPES = [
  "electricity",
  "maintenance",
  "industrial_services",
  "indirect_materials",
  "other_industrial_overhead",
] as const;

export const INDUSTRIAL_ALLOCATION_DRIVERS = [
  "machine_hours",
  "labor_hours",
  "production_quantity",
  "percentage",
  "direct_cost",
] as const;

export type IndustrialCostTag = {
  costType: typeof INDUSTRIAL_COST_TYPES[number];
  /** FK to branches.id; branches are the existing cost-plant master. */
  factoryId: number;
  /** Existing cost-centre code, retained to match journal/reporting convention. */
  costCenter: string;
  /** Accounting month in YYYY-MM form. */
  period: string;
  allocationDriver: typeof INDUSTRIAL_ALLOCATION_DRIVERS[number];
  /** Return-only FK back to the exact original purchased expense line. */
  sourcePurchaseLineId?: number;
  sourceFacts?: IndustrialCostSourceFacts;
};

export type IndustrialCostSourceFacts = {
  netBaseAmount: number;
  sourceAccountId: number;
  quantity: number;
  sourceCurrency: string;
  exchangeRate: number;
};

export type PostedIndustrialSourceCost = {
  sourceKey: string;
  sourceType: "purchase_invoice" | "purchase_return";
  sourceDocumentId: number;
  sourceDocumentNumber: string | null;
  sourceLineId: number;
  sourcePurchaseLineId: number;
  sourceAccountId: number;
  sourceDate: string;
  period: string;
  costType: string;
  factoryId: number;
  costCenter: string | null;
  allocationDriver: string;
  /** Net purchased source amount; return amounts are negative. */
  amount: number;
  currencyCode: string;
  sourceStatus: "posted";
  linkedInvoiceId: number | null;
};

const isOneOf = <T extends readonly string[]>(v: unknown, values: T): v is T[number] =>
  typeof v === "string" && (values as readonly string[]).includes(v);

export function industrialCostWithSourceFacts(
  tag: IndustrialCostTag,
  sourceFacts: IndustrialCostSourceFacts,
): IndustrialCostTag {
  return { ...tag, sourceFacts };
}

export function readIndustrialCostSourceFacts(value: unknown): IndustrialCostSourceFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, any>).sourceFacts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const netBaseAmount = Number(raw.netBaseAmount);
  const sourceAccountId = Number(raw.sourceAccountId);
  const quantity = Number(raw.quantity);
  const exchangeRate = Number(raw.exchangeRate);
  const sourceCurrency = String(raw.sourceCurrency ?? "").trim();
  if (!Number.isFinite(netBaseAmount) || netBaseAmount < 0 || !Number.isInteger(sourceAccountId) || sourceAccountId <= 0
    || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0 || !sourceCurrency) return null;
  return { netBaseAmount, sourceAccountId, quantity, sourceCurrency, exchangeRate };
}

/**
 * Mirrors the posted JE's proportional allocation: `documentPostingBasis` is
 * the VAT-exclusive document debit after fixed/percentage/header discounts and
 * landed-cost loading; each line keeps its pre-allocation posting basis.
 */
export function calculateIndustrialPostedBaseAmount(input: {
  linePostingBasis: number;
  totalPostingBasis: number;
  documentPostingBasis: number;
  exchangeRate: number;
}): number {
  const { linePostingBasis, totalPostingBasis, documentPostingBasis, exchangeRate } = input;
  if (![linePostingBasis, totalPostingBasis, documentPostingBasis, exchangeRate].every(Number.isFinite)
    || linePostingBasis < 0 || totalPostingBasis <= 0 || documentPostingBasis < 0 || exchangeRate <= 0) return 0;
  return Math.round((linePostingBasis * (documentPostingBasis / totalPostingBasis) * exchangeRate) * 100) / 100;
}

/**
 * Normalizes the persisted source metadata. A blank tag means "not an
 * industrial source"; partial tags are rejected so core never sees ambiguous
 * source facts.
 */
export function normalizeIndustrialCostTag(value: unknown): IndustrialCostTag | null {
  if (value == null || value === false || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("بيانات التكلفة الصناعية غير صالحة"), { status: 400 });
  }
  const raw = value as Record<string, unknown>;
  const costType = String(raw.costType ?? "").trim();
  const factoryId = Number(raw.factoryId);
  const costCenter = String(raw.costCenter ?? "").trim();
  const period = String(raw.period ?? "").trim();
  const allocationDriver = String(raw.allocationDriver ?? "").trim();
  const sourcePurchaseLineId = raw.sourcePurchaseLineId == null || raw.sourcePurchaseLineId === ""
    ? undefined : Number(raw.sourcePurchaseLineId);
  if (!isOneOf(costType, INDUSTRIAL_COST_TYPES)) {
    throw Object.assign(new Error("نوع التكلفة الصناعية غير معتمد"), { status: 400 });
  }
  if (!Number.isInteger(factoryId) || factoryId <= 0) {
    throw Object.assign(new Error("المصنع / موقع التكلفة مطلوب وغير صالح"), { status: 400 });
  }
  if (!costCenter || costCenter.length > 80) {
    throw Object.assign(new Error("مركز التكلفة الصناعي مطلوب وغير صالح"), { status: 400 });
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw Object.assign(new Error("فترة التكلفة الصناعية يجب أن تكون بالشكل YYYY-MM"), { status: 400 });
  }
  if (!isOneOf(allocationDriver, INDUSTRIAL_ALLOCATION_DRIVERS)) {
    throw Object.assign(new Error("أساس تحميل التكلفة الصناعية غير معتمد"), { status: 400 });
  }
  if (sourcePurchaseLineId !== undefined && (!Number.isInteger(sourcePurchaseLineId) || sourcePurchaseLineId <= 0)) {
    throw Object.assign(new Error("مرجع سطر فاتورة الشراء للتكلفة الصناعية غير صالح"), { status: 400 });
  }
  return { costType, factoryId, costCenter, period, allocationDriver, ...(sourcePurchaseLineId ? { sourcePurchaseLineId } : {}) };
}

/** A tagged return must reverse an exact tagged purchase line of this tenant. */
export async function assertIndustrialReturnSourceLinks(
  executor: any,
  companyId: number,
  invoiceId: unknown,
  lines: any[] | undefined,
): Promise<void> {
  const tagged = (lines ?? []).map((line: any) => ({
    tag: normalizeIndustrialCostTag(line?.industrialCost),
    itemId: Number(line?.itemId) || null,
  })).filter((row) => row.tag) as { tag: IndustrialCostTag; itemId: number | null }[];
  if (!tagged.length) return;
  const linkedInvoiceId = Number(invoiceId);
  if (!Number.isInteger(linkedInvoiceId) || linkedInvoiceId <= 0) {
    throw Object.assign(new Error("يلزم ربط مرتجع التكلفة الصناعية بفاتورة الشراء المصدر"), { status: 400 });
  }
  if (tagged.some((row) => row.tag.sourcePurchaseLineId == null)) {
    throw Object.assign(new Error("يلزم اختيار سطر فاتورة الشراء الأصلي لكل مرتجع تكلفة صناعية"), { status: 400 });
  }
  const sourceRows = await executor.select({ line: purchaseInvoiceLinesTable, invoice: purchaseInvoicesTable })
    .from(purchaseInvoiceLinesTable)
    .innerJoin(purchaseInvoicesTable, eq(purchaseInvoiceLinesTable.invoiceId, purchaseInvoicesTable.id))
    .where(and(
      eq(purchaseInvoicesTable.companyId, companyId),
      eq(purchaseInvoicesTable.id, linkedInvoiceId),
      eq(purchaseInvoicesTable.status, "posted"),
    ));
  const byId = new Map<number, any>(sourceRows.map((row: any) => [Number(row.line.id), row.line]));
  for (const { tag, itemId } of tagged) {
    const source = byId.get(tag.sourcePurchaseLineId!);
    const sourceTag = source ? normalizeIndustrialCostTag(source.industrialCost) : null;
    if (!source || !sourceTag || !readIndustrialCostSourceFacts(source.industrialCost)
      || (itemId != null && Number(source.itemId) !== itemId)) {
      throw Object.assign(new Error("سطر مرتجع التكلفة الصناعية لا يطابق سطر مصدر صناعي في فاتورة الشراء"), { status: 400 });
    }
    if (sourceTag.costType !== tag.costType || sourceTag.factoryId !== tag.factoryId
      || sourceTag.costCenter !== tag.costCenter || sourceTag.period !== tag.period
      || sourceTag.allocationDriver !== tag.allocationDriver) {
      throw Object.assign(new Error("بيانات مرتجع التكلفة الصناعية يجب أن تطابق سطر فاتورة الشراء المصدر"), { status: 400 });
    }
  }
}

/** Applies the existing closed-period rule at every posting state transition. */
export async function assertIndustrialCostPeriodsWritable(
  companyId: number,
  lines: any[] | undefined,
): Promise<void> {
  const tags = (lines ?? []).map((line: any) => normalizeIndustrialCostTag(line?.industrialCost))
    .filter(Boolean) as IndustrialCostTag[];
  for (const period of new Set(tags.map((tag) => tag.period))) {
    const writable = await assertWritableForDate(companyId, `${period}-01`);
    if (!writable.ok) {
      throw Object.assign(new Error(`فترة التكلفة الصناعية ${period} مقفلة: ${writable.reason}`), { status: 423 });
    }
  }
}

/** Tenant/FK validation for tags supplied with purchase-line writes. */
export async function assertIndustrialCostTagsOwned(
  executor: any,
  companyId: number,
  lines: any[] | undefined,
): Promise<void> {
  const tags = (lines ?? []).map((line) => normalizeIndustrialCostTag(line?.industrialCost)).filter(Boolean) as IndustrialCostTag[];
  if (!tags.length) return;
  const factoryIds = [...new Set(tags.map((tag) => tag.factoryId))];
  const centers = [...new Set(tags.map((tag) => tag.costCenter))];
  const [plants, costCenters] = await Promise.all([
    executor.select({ id: branchesTable.id, status: branchesTable.status }).from(branchesTable).where(and(
      eq(branchesTable.companyId, companyId),
      // Tags are source metadata; never allow a foreign or inactive plant.
      eq(branchesTable.status, "active"),
    )),
    executor.select({ code: costCentersTable.code, isActive: costCentersTable.isActive, isPosting: costCentersTable.isPosting })
      .from(costCentersTable).where(eq(costCentersTable.companyId, companyId)),
  ]);
  const plantSet = new Set(plants.map((row: any) => Number(row.id)));
  const centerSet = new Set(costCenters.filter((row: any) => row.isActive !== false && row.isPosting !== false)
    .map((row: any) => String(row.code)));
  const badPlants = factoryIds.filter((id) => !plantSet.has(id));
  const badCenters = centers.filter((code) => !centerSet.has(code));
  if (badPlants.length) throw Object.assign(new Error(`المصنع / موقع التكلفة لا يخص الشركة أو غير نشط (${badPlants.join(", ")})`), { status: 400 });
  if (badCenters.length) throw Object.assign(new Error(`مركز التكلفة الصناعي لا يخص الشركة أو غير مرحّل (${badCenters.join(", ")})`), { status: 400 });
  await assertIndustrialCostPeriodsWritable(companyId, lines);
}

export function calculateIndustrialSourceNet(line: {
  qty?: unknown; unitPrice?: unknown; discount?: unknown; vatRate?: unknown;
}, priceIncludesVat: boolean): number {
  const qty = Number(line.qty ?? 0);
  const unitPrice = Number(line.unitPrice ?? 0);
  const discount = Math.max(0, Math.min(100, Number(line.discount ?? 0)));
  const rate = Number(line.vatRate ?? 0) / 100;
  // Do not derive actual cost from rounded lineTotal. Base it on the original
  // quantity, entered unit price and line discount, then remove VAT exactly
  // once when the entered price is VAT-inclusive.
  const afterDiscount = qty * unitPrice * (1 - discount / 100);
  const net = priceIncludesVat ? afterDiscount / (1 + rate) : afterDiscount;
  return Number.isFinite(net) ? net : 0;
};

/**
 * Contract consumed by smart-manufacturing-core. It intentionally reads only
 * posted source documents and never touches vouchers, payments, allocations,
 * production operations, or journal entries.
 */
export async function getPostedIndustrialPurchaseCosts(
  executor: any,
  companyId: number,
  filters: { factoryId?: number; period?: string; costCenter?: string; costType?: string } = {},
): Promise<PostedIndustrialSourceCost[]> {
  const [invoiceRows, returnRows] = await Promise.all([
    executor.select({ doc: purchaseInvoicesTable, line: purchaseInvoiceLinesTable })
      .from(purchaseInvoiceLinesTable)
      .innerJoin(purchaseInvoicesTable, eq(purchaseInvoicesTable.id, purchaseInvoiceLinesTable.invoiceId))
      .where(and(eq(purchaseInvoicesTable.companyId, companyId), eq(purchaseInvoicesTable.status, "posted"))),
    executor.select({ doc: purchaseReturnsTable, line: purchaseReturnLinesTable })
      .from(purchaseReturnLinesTable)
      .innerJoin(purchaseReturnsTable, eq(purchaseReturnsTable.id, purchaseReturnLinesTable.returnId))
      .innerJoin(purchaseInvoicesTable, eq(purchaseReturnsTable.invoiceId, purchaseInvoicesTable.id))
      .where(and(
        eq(purchaseReturnsTable.companyId, companyId),
        eq(purchaseReturnsTable.status, "posted"),
        eq(purchaseInvoicesTable.status, "posted"),
      )),
  ]);
  // Re-validate the immutable return link at read time as well as write time:
  // restores/imports must not be able to inject a negative source that points
  // at a different plant, period, tag, or account than the original expense.
  const returnSourceIds: number[] = [...new Set<number>((returnRows as any[]).flatMap(({ line }): number[] => {
    const tag = normalizeIndustrialCostTag(line.industrialCost);
    return tag?.sourcePurchaseLineId ? [tag.sourcePurchaseLineId] : [];
  }))];
  const returnOrigins: any[] = returnSourceIds.length
    ? await executor.select({
      id: purchaseInvoiceLinesTable.id,
      invoiceId: purchaseInvoiceLinesTable.invoiceId,
      accountId: purchaseInvoiceLinesTable.accountId,
      // The server package can temporarily compile against a stale workspace
      // declaration during schema reconciliation; the runtime column is
      // declared in purchasing.ts and is intentionally selected here.
      industrialCost: (purchaseInvoiceLinesTable as any).industrialCost,
    }).from(purchaseInvoiceLinesTable).where(and(
      eq(purchaseInvoiceLinesTable.companyId, companyId),
      inArray(purchaseInvoiceLinesTable.id, returnSourceIds),
    ))
    : [];
  const returnOriginById = new Map<number, any>(returnOrigins.map((row: any) => [Number(row.id), row]));
  const mapRows = (rows: any[], sourceType: "purchase_invoice" | "purchase_return", sign: 1 | -1) =>
    rows.flatMap(({ doc, line }) => {
      const tag = normalizeIndustrialCostTag(line.industrialCost);
      if (!tag
        || (filters.factoryId != null && tag.factoryId !== filters.factoryId)
        || (filters.period != null && tag.period !== filters.period)
        || (filters.costCenter != null && tag.costCenter !== filters.costCenter)
        || (filters.costType != null && tag.costType !== filters.costType)
        || (sourceType === "purchase_return" && (!doc.invoiceId || !tag.sourcePurchaseLineId))) return [];
      const facts = readIndustrialCostSourceFacts(line.industrialCost);
      if (!facts) {
        throw Object.assign(
          new Error(`مصدر التكلفة الصناعية ${line.id} يفتقد لقطة التكلفة الفعلية المرحّلة`),
          { status: 409 },
        );
      }
      if (sourceType === "purchase_return") {
        const original = returnOriginById.get(tag.sourcePurchaseLineId!);
        const originalTag = original ? normalizeIndustrialCostTag(original.industrialCost) : null;
        const originalFacts = original ? readIndustrialCostSourceFacts(original.industrialCost) : null;
        if (!original || Number(original.invoiceId) !== Number(doc.invoiceId) || !originalFacts || !originalTag
          || originalTag.costType !== tag.costType || originalTag.factoryId !== tag.factoryId
          || originalTag.costCenter !== tag.costCenter || originalTag.period !== tag.period
          || originalTag.allocationDriver !== tag.allocationDriver || originalFacts.sourceAccountId !== facts.sourceAccountId) {
          throw Object.assign(
            new Error(`مرتجع التكلفة الصناعية ${line.id} لا يطابق سطر فاتورة الشراء المصدر أو حسابه`),
            { status: 409 },
          );
        }
      }
      return [{
        sourceKey: `${sourceType}_line:${line.id}`,
        sourceType,
        sourceDocumentId: doc.id,
        sourceDocumentNumber: doc.docNumber ?? null,
        sourceLineId: line.id,
        sourcePurchaseLineId: sourceType === "purchase_return" ? tag.sourcePurchaseLineId! : line.id,
        sourceAccountId: facts.sourceAccountId,
        sourceDate: sourceType === "purchase_invoice" ? doc.invoiceDate : doc.returnDate,
        period: tag.period,
        costType: tag.costType,
        factoryId: tag.factoryId,
        costCenter: tag.costCenter,
        allocationDriver: tag.allocationDriver,
        amount: sign * facts.netBaseAmount,
        currencyCode: "SAR",
        sourceStatus: "posted" as const,
        linkedInvoiceId: sourceType === "purchase_return" ? (doc.invoiceId ?? null) : null,
      }];
    });
  return [...mapRows(invoiceRows, "purchase_invoice", 1), ...mapRows(returnRows, "purchase_return", -1)];
}