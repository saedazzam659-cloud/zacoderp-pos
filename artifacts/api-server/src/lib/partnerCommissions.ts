import { db } from "@workspace/db";
import { platformPartnersTable, partnerCompaniesTable, partnerCommissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────
// Developer / partner commission engine (additive only).
//
// This module hosts TWO accrual helpers that both write to partner_commissions
// and both NEVER throw into the caller (a commission-accrual failure must never
// break the originating sale/subscription/purchase — all errors are swallowed +
// logged):
//
//   1. accruePartnerCommission(companyId-based) — the partner analogue of
//      `accrueResellerCommission`. Accrues a commission row whenever a revenue
//      event (app sale, subscription renewal, add-on) happens for a company
//      that is linked to one or more developers/partners. Silent no-op for the
//      overwhelming majority of companies (no partner link). Unlike resellers
//      (one company → one reseller), a company MAY be linked to MULTIPLE
//      partners, so this accrues one row per linked & approved partner.
//
//   2. accrueMarketplaceCommission(partnerId-based) — Marketplace Phase 4. A
//      marketplace purchase is attributed to ONE developer (the listing owner),
//      so this accrues a single row against an explicit partnerId using the
//      commission snapshot computed at purchase time. The stored commission is
//      ZACODE's cut (baseAmount × rate / 100, see computeCommission).
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

export function computeCommission(baseAmount: number, ratePercent: number): number {
  const base = Number.isFinite(baseAmount) ? Number(baseAmount) : 0;
  const rate = Number.isFinite(ratePercent) ? Number(ratePercent) : 0;
  return Math.round(((base * rate) / 100) * 100) / 100;
}

interface AccrueMarketplaceOpts {
  partnerId: number;
  companyId: number | null;
  extensionId?: string | null;
  eventType: PartnerCommissionEvent;
  baseAmount: number;
  commissionRate: number; // percent
  commissionAmount: number; // pre-computed Zacode cut (kept in lockstep with the purchase snapshot)
  description?: string | null;
  when?: Date;
}

export async function accrueMarketplaceCommission(opts: AccrueMarketplaceOpts): Promise<void> {
  try {
    const { partnerId } = opts;
    if (!Number.isInteger(partnerId) || partnerId <= 0) return;

    // Only accrue for an existing partner.
    const [partner] = await db
      .select({ id: platformPartnersTable.id, isActive: platformPartnersTable.isActive, status: platformPartnersTable.status })
      .from(platformPartnersTable)
      .where(eq(platformPartnersTable.id, partnerId));
    if (!partner) return;

    const when = opts.when ?? new Date();
    await db.insert(partnerCommissionsTable).values({
      partnerId,
      companyId: opts.companyId ?? null,
      extensionId: opts.extensionId ?? null,
      eventType: opts.eventType,
      description: opts.description ?? null,
      baseAmount: (Number.isFinite(opts.baseAmount) ? Number(opts.baseAmount) : 0).toFixed(2),
      commissionRate: (Number.isFinite(opts.commissionRate) ? Number(opts.commissionRate) : 0).toFixed(3),
      commissionAmount: (Number.isFinite(opts.commissionAmount) ? Number(opts.commissionAmount) : 0).toFixed(2),
      periodMonth: when.getMonth() + 1,
      periodYear: when.getFullYear(),
      status: "accrued",
    });
  } catch (err) {
    logger.warn({ err, opts }, "accrueMarketplaceCommission failed (continuing)");
  }
}
