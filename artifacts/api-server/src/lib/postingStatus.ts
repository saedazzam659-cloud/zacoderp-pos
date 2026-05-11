// Centralized resolver for "should this newly-created journal entry be POSTED
// immediately, or saved as a DRAFT for later manual posting?".
//
// Why this lives in one place:
//   The decision depends on TWO settings on the company record:
//     1. The master switch  `companies.auto_posting_enabled` (legacy global flag)
//     2. A per-document-type flag like `companies.auto_post_sales`,
//        `companies.auto_post_production`, etc.
//   Either being explicitly false means "save as draft". Both true (or NULL,
//   for legacy rows that pre-date a column) means "post immediately".
//
//   Every JE-creating route used to hardcode `status: "posted"`. The UI exposed
//   per-doc-type toggles in /general-settings that ran end-to-end through the
//   PATCH /companies/:id/general-settings handler and were persisted… but no
//   route ever READ them. The toggles were essentially dead. This helper is
//   the single point of truth that brings every toggle to life consistently.
//
//   The financial-reports gotcha in replit.md guarantees that "draft entries
//   have ZERO impact on any financial report". So flipping a toggle off causes
//   the document operation to succeed normally (e.g., a sales invoice still
//   gets created and stays posted) BUT the resulting JE is left as a draft —
//   the user must visit مركز الترحيل to actually post it before it shows on
//   the trial balance / income statement / balance sheet.
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";

/**
 * Document categories that produce a journal entry. Add a new entry here
 * AND a matching `auto_post_<x>` boolean column on the companies table to
 * surface a new toggle on /general-settings.
 */
export type AutoPostDocType =
  | "sales"
  | "purchase"
  | "receipt"
  | "payment"
  | "financial"
  | "cashTransfer"
  | "payroll"
  | "production"
  | "stockMovement"
  | "goodsReceipt"
  | "goodsDelivery"
  | "adjustment"
  | "faAcquisition"
  | "faDepreciation"
  | "faDisposal"
  | "ctgOutgoingBill"
  | "ctgIncomingBill";

/**
 * Look up the company's master switch + per-doc-type flag and return the
 * journal-entry status to persist. Returns "draft" only when the user has
 * explicitly disabled auto-posting for that document type (or globally);
 * otherwise the safe legacy default is "posted".
 *
 * NOTE: this issues a small SELECT on every JE insert. For the call sites
 * that already do multiple round-trips per JE (writability check, lines
 * insert, etc.) the extra read is negligible. If this ever becomes a hot
 * path for batch posting, swap to a per-request memoized lookup.
 */
export async function resolvePostingStatus(
  cid: number,
  docType: AutoPostDocType,
): Promise<"posted" | "draft"> {
  const [c] = await db
    .select({
      master:        companiesTable.autoPostingEnabled,
      sales:         companiesTable.autoPostSales,
      purchase:      companiesTable.autoPostPurchase,
      receipt:       companiesTable.autoPostReceipt,
      payment:       companiesTable.autoPostPayment,
      financial:     companiesTable.autoPostFinancial,
      cashTransfer:  companiesTable.autoPostCashTransfer,
      payroll:       companiesTable.autoPostPayroll,
      production:    companiesTable.autoPostProduction,
      stockMovement: companiesTable.autoPostStockMovement,
      goodsReceipt:  companiesTable.autoPostGoodsReceipt,
      goodsDelivery: companiesTable.autoPostGoodsDelivery,
      adjustment:    companiesTable.autoPostAdjustment,
      faAcquisition:  companiesTable.autoPostFaAcquisition,
      faDepreciation: companiesTable.autoPostFaDepreciation,
      faDisposal:     companiesTable.autoPostFaDisposal,
      ctgOutgoingBill: companiesTable.autoPostCtgOutgoingBill,
      ctgIncomingBill: companiesTable.autoPostCtgIncomingBill,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, cid));

  // Defensive default: if the company row vanished mid-request (shouldn't
  // happen because the caller is already operating on it) keep the legacy
  // posted-by-default behavior so a transient lookup miss never silently
  // converts otherwise-posted entries into hidden drafts.
  if (!c) return "posted";

  // Master switch off → every doc type is forced to draft regardless of the
  // per-doc flag. Mirrors the UI label "المفتاح العام للترحيل التلقائي".
  if (c.master === false) return "draft";

  // Per-doc-type flag explicitly false → draft. We compare strictly with
  // `=== false` so that NULL on a legacy row (in case a future migration
  // makes the column nullable) still defaults to posted.
  if (c[docType] === false) return "draft";

  return "posted";
}
