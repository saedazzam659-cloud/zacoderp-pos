import { db } from "@workspace/db";
import { platformPartnersTable, partnerCompaniesTable, partnerCommissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────
// Developer / partner commission engine (additive only).
//
// Accrues a commission row whenever a revenue event (app sale, app
// subscription renewal, add-on purchase) happens for a company that is linked
// to one or more developers/partners. This is the partner analogue of
// `accrueResellerCommission`: a pure side-effect helper that is a silent no-op
// for the overwhelming majority of companies (which have NO partner link), and
// it NEVER throws into the caller — a commission-accrual failure must never
// break the originating sale/subscription, so all errors are swallowed +
// logged.
//
// Unlike resellers (one company → one reseller), a company MAY be linked to
// MULTIPLE partners (the partner_companies pair is unique, not the company), so
// this accrues one row per linked & approved partner.
// ─────────────────────────────────────────────────────────────────────────

export type PartnerCommissionEvent = "app_sale" | "app_renewal" | "subscription" | "adjustment";

interface AccruePartnerOpts {
  companyId: number;
  eventType: PartnerCommissionEvent;
  baseAmount: number;            // the monetary base the commission % applies to
  description?: string | null;
  extensionId?: string | null;  // optional extension this commission relates to
  when?: Date;                   // accrual date — defaults to now
}

export async function accruePartnerCommission(opts: AccruePartnerOpts): Promise<void> {
  try {
    const { companyId } = opts;
    if (!Number.isInteger(companyId) || companyId <= 0) return;

    // A company may be linked to MULTIPLE partners — accrue for each.
    const links = await db
      .select({ partnerId: partnerCompaniesTable.partnerId })
      .from(partnerCompaniesTable)
      .where(eq(partnerCompaniesTable.companyId, companyId));
    if (links.length === 0) return; // not partner-linked → nothing to accrue

    const when = opts.when ?? new Date();
    const base = Number.isFinite(opts.baseAmount) ? Number(opts.baseAmount) : 0;

    for (const link of links) {
      const [partner] = await db
        .select()
        .from(platformPartnersTable)
        .where(eq(platformPartnersTable.id, link.partnerId));
      // Only credit approved & active partners (suspended/rejected/draft skip).
      if (!partner || !partner.isActive || partner.status !== "approved") continue;

      const rate = Number(partner.commissionRate ?? 0);
      const amount = Math.round(((base * rate) / 100) * 100) / 100;

      await db.insert(partnerCommissionsTable).values({
        partnerId: partner.id,
        companyId,
        extensionId: opts.extensionId ?? null,
        eventType: opts.eventType,
        description: opts.description ?? null,
        baseAmount: base.toFixed(2),
        commissionRate: rate.toFixed(3),
        commissionAmount: amount.toFixed(2),
        periodMonth: when.getMonth() + 1,
        periodYear: when.getFullYear(),
        status: "accrued",
      });
    }
  } catch (err) {
    logger.warn({ err, opts }, "accruePartnerCommission failed (continuing)");
  }
}
