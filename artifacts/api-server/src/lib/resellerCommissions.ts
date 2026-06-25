import { db } from "@workspace/db";
import { resellersTable, resellerCompaniesTable, resellerCommissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────
// Reseller commission engine — Task #237 (additive only).
//
// Accrues a commission row whenever a subscription event happens for a company
// that is linked to a reseller. This is a pure side-effect helper: if the
// company has NO reseller link (the overwhelming majority of companies), it is
// a silent no-op. It NEVER throws into the caller — a commission-accrual
// failure must never break a subscription create / renew, so all errors are
// swallowed + logged.
// ─────────────────────────────────────────────────────────────────────────

export type ResellerCommissionEvent = "new_subscription" | "renewal" | "addon";

interface AccrueOpts {
  companyId: number;
  eventType: ResellerCommissionEvent;
  baseAmount: number;           // the monetary base the commission % applies to
  subscriptionId?: number | null;
  description?: string | null;
  when?: Date;                  // accrual date — defaults to now
}

export async function accrueResellerCommission(opts: AccrueOpts): Promise<void> {
  try {
    const { companyId } = opts;
    if (!Number.isInteger(companyId) || companyId <= 0) return;

    // Is this company linked to a reseller?
    const [link] = await db
      .select({ resellerId: resellerCompaniesTable.resellerId })
      .from(resellerCompaniesTable)
      .where(eq(resellerCompaniesTable.companyId, companyId));
    if (!link) return; // not a reseller-managed company → nothing to accrue

    const [reseller] = await db
      .select()
      .from(resellersTable)
      .where(eq(resellersTable.id, link.resellerId));
    if (!reseller || !reseller.isActive || reseller.status !== "active") return;

    const rate = Number(reseller.commissionRate ?? 0);
    const base = Number.isFinite(opts.baseAmount) ? Number(opts.baseAmount) : 0;
    const amount = Math.round(((base * rate) / 100) * 100) / 100;

    const when = opts.when ?? new Date();
    await db.insert(resellerCommissionsTable).values({
      resellerId: reseller.id,
      companyId,
      subscriptionId: opts.subscriptionId ?? null,
      eventType: opts.eventType,
      description: opts.description ?? null,
      baseAmount: base.toFixed(2),
      commissionRate: rate.toFixed(3),
      commissionAmount: amount.toFixed(2),
      periodMonth: when.getMonth() + 1,
      periodYear: when.getFullYear(),
      status: "accrued",
    });
  } catch (err) {
    logger.warn({ err, opts }, "accrueResellerCommission failed (continuing)");
  }
}
