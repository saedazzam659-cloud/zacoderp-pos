import { db } from "@workspace/db";
import {
  extensionListingsTable,
  extensionPurchasesTable,
  platformPartnersTable,
  type ExtensionListing,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────
// Marketplace helpers — Phase 4 (additive). Shared by the tenant storefront
// routes AND the extension-platform enable path so a PAID extension can never
// be enabled for a company that does not hold an active entitlement.
// ─────────────────────────────────────────────────────────────────────────

export async function getListingByExtensionId(extensionId: string): Promise<ExtensionListing | null> {
  if (!extensionId) return null;
  const [row] = await db
    .select()
    .from(extensionListingsTable)
    .where(eq(extensionListingsTable.extensionId, extensionId))
    .limit(1);
  return row ?? null;
}

// A listing is "paid" only when it is published, priced > 0, and not free.
export function listingIsPaid(listing: ExtensionListing | null): boolean {
  if (!listing) return false;
  if (listing.pricingModel === "free") return false;
  return Number(listing.price ?? 0) > 0;
}

// True when the listing is sellable to a tenant (visible in the store).
export function listingIsPublished(listing: ExtensionListing | null): boolean {
  return !!listing && listing.status === "published";
}

// Resolve Zacode's commission rate: the listing override, else the attributed
// developer's default partner rate, else 0.
export async function resolveCommissionRate(listing: ExtensionListing | null): Promise<number> {
  if (!listing) return 0;
  if (listing.commissionRate != null && listing.commissionRate !== "") {
    const r = Number(listing.commissionRate);
    if (Number.isFinite(r)) return r;
  }
  if (listing.partnerId) {
    const [partner] = await db
      .select({ commissionRate: platformPartnersTable.commissionRate })
      .from(platformPartnersTable)
      .where(eq(platformPartnersTable.id, listing.partnerId));
    const r = Number(partner?.commissionRate ?? 0);
    if (Number.isFinite(r)) return r;
  }
  return 0;
}

// True when the company holds an active purchase (entitlement) for an extension.
export async function hasActiveEntitlement(
  companyId: number | null,
  extensionId: string,
): Promise<boolean> {
  if (companyId == null || !extensionId) return false;
  const [row] = await db
    .select({ id: extensionPurchasesTable.id })
    .from(extensionPurchasesTable)
    .where(
      and(
        eq(extensionPurchasesTable.companyId, companyId),
        eq(extensionPurchasesTable.extensionId, extensionId),
        eq(extensionPurchasesTable.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
}
