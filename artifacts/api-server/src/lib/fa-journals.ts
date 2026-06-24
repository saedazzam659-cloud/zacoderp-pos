// ─────────────────────────────────────────────────────────────────────────
// Fixed-Assets Journal Engine (IAS 16)
//
// Three lifecycle JEs:
//   1. Acquisition  — DR Asset Cost / CR Cash | Bank | Acquisition Clearing
//   2. Depreciation — DR Depreciation Expense / CR Accumulated Depreciation
//   3. Disposal     — full balanced unwind:
//        DR Cash/Bank (proceeds)         when type=sale and source supplied
//        DR Accumulated Depreciation     (entire accum at disposal date)
//        CR Asset Cost                   (entire original cost)
//        DR Loss on Disposal   if proceeds < bookValue
//        CR Gain on Disposal   if proceeds > bookValue
//
// Account resolution (resolveFaAccounts) follows a two-tier waterfall:
//   1. faCategoriesTable.{costAccountId | accumDepreciationAccountId |
//      depreciationExpenseAccountId}  — per-category override
//   2. companies.{faAssetCost… | faAccumDepreciation… | faDepreciationExpense…
//      | faAcquisitionClearing… | faDisposalGain… | faDisposalLoss…}
//      — company-wide defaults
//
// If a required account is missing, we throw a clear Arabic error pointing
// the user at /fixed-assets/settings (or the category edit form).
//
// Posting status comes from resolvePostingStatus(cid, "faAcquisition"
// | "faDepreciation" | "faDisposal") — flipping the matching toggle off
// in /general-settings causes the JE to be saved as draft (zero impact on
// financial reports until manually posted from مركز الترحيل).
// ─────────────────────────────────────────────────────────────────────────
import { and, eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  fixedAssetsTable,
  faCategoriesTable,
  faDepreciationRunsTable,
  faDisposalsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  suppliersTable,
} from "@workspace/db";
import { resolvePostingStatus } from "./postingStatus.js";
import { resolveCashAccount } from "./hr-journals.js";
import { assertWritableForDate } from "./periodGuard.js";
import { nextSequenceNumber } from "./sequences.js";

type DbOrTx = typeof db;

export interface FaAccountMap {
  assetCost:             number | null;
  accumDepreciation:     number | null;
  depreciationExpense:   number | null;
  acquisitionClearing:   number | null;
  disposalGain:          number | null;
  disposalLoss:          number | null;
}

/** Resolve the active account map for an asset, with category override. */
export async function resolveFaAccounts(
  cid: number,
  categoryId: number | null | undefined,
  dx: DbOrTx = db,
): Promise<FaAccountMap> {
  const [c] = await dx.select({
    assetCost:           companiesTable.faAssetCostAccountId,
    accumDepreciation:   companiesTable.faAccumDepreciationAccountId,
    depreciationExpense: companiesTable.faDepreciationExpenseAccountId,
    acquisitionClearing: companiesTable.faAcquisitionClearingAccountId,
    disposalGain:        companiesTable.faDisposalGainAccountId,
    disposalLoss:        companiesTable.faDisposalLossAccountId,
  }).from(companiesTable).where(eq(companiesTable.id, cid));
  if (!c) throw new Error("الشركة غير موجودة");

  const map: FaAccountMap = {
    assetCost:           c.assetCost           ?? null,
    accumDepreciation:   c.accumDepreciation   ?? null,
    depreciationExpense: c.depreciationExpense ?? null,
    acquisitionClearing: c.acquisitionClearing ?? null,
    disposalGain:        c.disposalGain        ?? null,
    disposalLoss:        c.disposalLoss        ?? null,
  };

  if (categoryId) {
    const [cat] = await dx.select({
      cost:    faCategoriesTable.costAccountId,
      accum:   faCategoriesTable.accumDepreciationAccountId,
      depExp:  faCategoriesTable.depreciationExpenseAccountId,
    }).from(faCategoriesTable)
      .where(and(eq(faCategoriesTable.id, categoryId), eq(faCategoriesTable.companyId, cid)));
    if (cat) {
      if (cat.cost   != null) map.assetCost           = cat.cost;
      if (cat.accum  != null) map.accumDepreciation   = cat.accum;
      if (cat.depExp != null) map.depreciationExpense = cat.depExp;
    }
  }
  return map;
}

const fix = (n: number) => n.toFixed(2);

// ═════════════════════════════════════════════════════════════════════════
// 1) ACQUISITION
// ═════════════════════════════════════════════════════════════════════════
export interface AcquisitionSource {
  cashBoxId?:    number | null;
  bankAccountId?: number | null;
  /** When set and no cash/bank source given, credit the supplier's AP
   *  account (true ذمم/AP behaviour) instead of the generic acquisition
   *  clearing account. Mirrors the purchase-invoice convention. */
  supplierId?:    number | null;
}

/** Posts the acquisition JE and writes journalEntryId back on the asset.
 *  Returns the new entry id, or null when skipped (e.g. opening balance). */
export async function buildAcquisitionJournal(
  cid: number,
  assetId: number,
  source: AcquisitionSource = {},
  dx: DbOrTx = db,
): Promise<number | null> {
  const [a] = await dx.select().from(fixedAssetsTable)
    .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
  if (!a) throw new Error("الأصل غير موجود");

  const cost = Number(a.purchaseValue || 0);
  if (!(cost > 0)) return null;        // nothing to post (placeholder asset)
  if (a.journalEntryId) return a.journalEntryId; // already posted

  const accounts = await resolveFaAccounts(cid, a.categoryId, dx);
  if (!accounts.assetCost) {
    throw new Error("حساب تكلفة الأصل غير مربوط في إعدادات الأصول الثابتة");
  }

  let crAccountId: number;
  let crLabel: string;
  if (source.cashBoxId || source.bankAccountId) {
    const cash = await resolveCashAccount(cid, source, dx);
    crAccountId = cash.accountId;
    crLabel     = cash.label;
  } else if (source.supplierId) {
    const [sup] = await dx.select({
      accountId: suppliersTable.accountId,
      nameAr:    suppliersTable.nameAr,
      nameEn:    suppliersTable.nameEn,
    }).from(suppliersTable)
      .where(and(eq(suppliersTable.id, source.supplierId), eq(suppliersTable.companyId, cid)));
    if (!sup?.accountId) {
      throw new Error("المورد المختار غير مربوط بحساب ذمم محاسبي");
    }
    crAccountId = sup.accountId;
    crLabel     = `ذمم مورد: ${sup.nameAr ?? sup.nameEn ?? ""}`.trim();
  } else {
    if (!accounts.acquisitionClearing) {
      throw new Error("حساب وسيط اقتناء الأصول غير مربوط (يستخدم عند الشراء الآجل)");
    }
    crAccountId = accounts.acquisitionClearing;
    crLabel     = "حساب وسيط اقتناء أصول ثابتة";
  }

  const acqDate = a.purchaseDate || new Date().toISOString().slice(0, 10);
  const acqW = await assertWritableForDate(cid, acqDate);
  if (!acqW.ok) throw new Error(acqW.reason);
  const desc = `اقتناء أصل ثابت: ${a.nameAr} (${a.code})`;
  // JE draws its own continuous "journal_entry" number; asset code stays in the
  // description + source link. Falls back to the asset code.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: null, refTable: "journal_entries", branchId: a.branchId ?? null, docDate: acqDate,
  })) ?? a.code;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: a.branchId ?? null,
    docNumber: jeDocNumber,
    entryDate: acqDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "fa_acquisition",
    status: await resolvePostingStatus(cid, "faAcquisition"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: accounts.assetCost!, debit: fix(cost), credit: "0.00",
      description: `تكلفة ${a.nameAr}`, sortOrder: 0,
      costCenter: a.costCenterId ? String(a.costCenterId) : null },
    { entryId: entry.id, accountId: crAccountId,         debit: "0.00",   credit: fix(cost),
      description: crLabel, sortOrder: 1,
      costCenter: a.costCenterId ? String(a.costCenterId) : null },
  ]);

  await dx.update(fixedAssetsTable)
    .set({ journalEntryId: entry.id, updatedAt: new Date() })
    .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));

  return entry.id;
}

// ═════════════════════════════════════════════════════════════════════════
// 2) DEPRECIATION (per run row)
// ═════════════════════════════════════════════════════════════════════════
export async function buildDepreciationRunJournal(
  cid: number,
  runId: number,
  dx: DbOrTx = db,
): Promise<number | null> {
  const [run] = await dx.select().from(faDepreciationRunsTable)
    .where(and(eq(faDepreciationRunsTable.id, runId), eq(faDepreciationRunsTable.companyId, cid)));
  if (!run) throw new Error("سجل الإهلاك غير موجود");
  if (run.journalEntryId) return run.journalEntryId;
  const amount = Number(run.depreciationAmount || 0);
  if (!(amount > 0)) return null;

  const [a] = await dx.select().from(fixedAssetsTable)
    .where(and(eq(fixedAssetsTable.id, run.assetId), eq(fixedAssetsTable.companyId, cid)));
  if (!a) throw new Error("الأصل غير موجود");

  const accounts = await resolveFaAccounts(cid, a.categoryId, dx);
  if (!accounts.depreciationExpense || !accounts.accumDepreciation) {
    throw new Error("حسابات مصروف الإهلاك أو مجمع الإهلاك غير مربوطة في الإعدادات");
  }

  const period = `${String(run.periodMonth).padStart(2, "0")}/${run.periodYear}`;
  // Use last day of the period as the entry date so the JE falls inside the
  // correct fiscal month for reports.
  const lastDay = new Date(run.periodYear, run.periodMonth, 0).getDate();
  const entryDate = `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const depW = await assertWritableForDate(cid, entryDate);
  if (!depW.ok) throw new Error(depW.reason);
  const desc = `إهلاك شهري ${period} — ${a.nameAr} (${a.code})`;
  // JE draws its own continuous "journal_entry" number; falls back to DEP-*.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: null, refTable: "journal_entries", branchId: a.branchId ?? null, docDate: entryDate,
  })) ?? `DEP-${a.code}-${run.periodYear}${String(run.periodMonth).padStart(2, "0")}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: a.branchId ?? null,
    docNumber: jeDocNumber,
    entryDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "fa_depreciation",
    status: await resolvePostingStatus(cid, "faDepreciation"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: accounts.depreciationExpense!, debit: fix(amount), credit: "0.00",
      description: `مصروف إهلاك ${a.nameAr} ${period}`, sortOrder: 0,
      costCenter: a.costCenterId ? String(a.costCenterId) : null },
    { entryId: entry.id, accountId: accounts.accumDepreciation!,   debit: "0.00",      credit: fix(amount),
      description: `مجمع إهلاك ${a.nameAr} ${period}`, sortOrder: 1,
      costCenter: a.costCenterId ? String(a.costCenterId) : null },
  ]);

  await dx.update(faDepreciationRunsTable)
    .set({ journalEntryId: entry.id })
    .where(and(eq(faDepreciationRunsTable.id, runId), eq(faDepreciationRunsTable.companyId, cid)));

  return entry.id;
}

// ═════════════════════════════════════════════════════════════════════════
// 3) DISPOSAL
// ═════════════════════════════════════════════════════════════════════════
export interface DisposalSource {
  cashBoxId?:    number | null;
  bankAccountId?: number | null;
}

export async function buildDisposalJournal(
  cid: number,
  disposalId: number,
  source: DisposalSource = {},
  dx: DbOrTx = db,
): Promise<number | null> {
  const [d] = await dx.select().from(faDisposalsTable)
    .where(and(eq(faDisposalsTable.id, disposalId), eq(faDisposalsTable.companyId, cid)));
  if (!d) throw new Error("سجل الاستبعاد غير موجود");
  if (d.journalEntryId) return d.journalEntryId;

  const [a] = await dx.select().from(fixedAssetsTable)
    .where(and(eq(fixedAssetsTable.id, d.assetId), eq(fixedAssetsTable.companyId, cid)));
  if (!a) throw new Error("الأصل غير موجود");

  const cost     = Number(a.purchaseValue || 0);
  const accum    = Number(a.accumulatedDepreciation || 0);
  const book     = Number(d.bookValueAtDisposal || (cost - accum));
  const proceeds = d.type === "sale"   ? Number(d.salePrice  || 0)
                 : d.type === "scrap"  ? Number(d.scrapValue || 0)
                 : 0;
  const gain     = +(proceeds - book).toFixed(2); // +ve = gain, -ve = loss

  if (cost <= 0 && accum <= 0 && proceeds <= 0) return null; // nothing to post

  const accounts = await resolveFaAccounts(cid, a.categoryId, dx);
  if (cost > 0  && !accounts.assetCost)         throw new Error("حساب تكلفة الأصل غير مربوط");
  if (accum > 0 && !accounts.accumDepreciation) throw new Error("حساب مجمع الإهلاك غير مربوط");
  if (gain > 0  && !accounts.disposalGain)      throw new Error("حساب أرباح بيع الأصول غير مربوط");
  if (gain < 0  && !accounts.disposalLoss)      throw new Error("حساب خسائر بيع الأصول غير مربوط");

  let proceedsLine: { accountId: number; label: string } | null = null;
  if (proceeds > 0) {
    if (source.cashBoxId || source.bankAccountId) {
      const cash = await resolveCashAccount(cid, source, dx);
      proceedsLine = { accountId: cash.accountId, label: cash.label };
    } else {
      if (!accounts.acquisitionClearing) {
        throw new Error("لم يتم تحديد صندوق/بنك لاستلام قيمة البيع، ولا يوجد حساب وسيط");
      }
      proceedsLine = { accountId: accounts.acquisitionClearing, label: "حساب وسيط اقتناء/استبعاد أصول" };
    }
  }

  const typeLabel = d.type === "sale" ? "بيع" : d.type === "scrap" ? "تخريد"
                   : d.type === "full_depreciation" ? "إهلاك كامل" : "شطب";
  const desc = `استبعاد أصل ثابت (${typeLabel}): ${a.nameAr} (${a.code})`;

  const dispW = await assertWritableForDate(cid, d.disposalDate);
  if (!dispW.ok) throw new Error(dispW.reason);
  // JE draws its own continuous "journal_entry" number; disposal code stays in
  // the description + source link. Falls back to the disposal code.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: null, refTable: "journal_entries", branchId: a.branchId ?? null, docDate: d.disposalDate,
  })) ?? d.code;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: a.branchId ?? null,
    docNumber: jeDocNumber,
    entryDate: d.disposalDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "fa_disposal",
    status: await resolvePostingStatus(cid, "faDisposal"),
  }).returning();

  const lines: any[] = [];
  let i = 0;
  const cc = a.costCenterId ? String(a.costCenterId) : null;
  if (proceedsLine && proceeds > 0) {
    lines.push({ entryId: entry.id, accountId: proceedsLine.accountId, debit: fix(proceeds), credit: "0.00",
      description: `قيمة الاستبعاد — ${proceedsLine.label}`, sortOrder: i++, costCenter: cc });
  }
  if (accum > 0) {
    lines.push({ entryId: entry.id, accountId: accounts.accumDepreciation!, debit: fix(accum), credit: "0.00",
      description: `إقفال مجمع إهلاك ${a.nameAr}`, sortOrder: i++, costCenter: cc });
  }
  if (gain < 0) {
    lines.push({ entryId: entry.id, accountId: accounts.disposalLoss!, debit: fix(-gain), credit: "0.00",
      description: `خسارة استبعاد ${a.nameAr}`, sortOrder: i++, costCenter: cc });
  }
  if (cost > 0) {
    lines.push({ entryId: entry.id, accountId: accounts.assetCost!, debit: "0.00", credit: fix(cost),
      description: `إقفال تكلفة ${a.nameAr}`, sortOrder: i++, costCenter: cc });
  }
  if (gain > 0) {
    lines.push({ entryId: entry.id, accountId: accounts.disposalGain!, debit: "0.00", credit: fix(gain),
      description: `ربح استبعاد ${a.nameAr}`, sortOrder: i++, costCenter: cc });
  }

  // Sanity: balance check (rounding tolerance 0.05)
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.05) {
    throw new Error(`قيد الاستبعاد غير متوازن: مدين ${fix(dr)} ≠ دائن ${fix(cr)}`);
  }

  await dx.insert(journalEntryLinesTable).values(lines);
  await dx.update(faDisposalsTable)
    .set({ journalEntryId: entry.id })
    .where(and(eq(faDisposalsTable.id, disposalId), eq(faDisposalsTable.companyId, cid)));

  return entry.id;
}
