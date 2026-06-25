// ─────────────────────────────────────────────────────────────────────────
// Frontend marketplace API — Phase 4 (المتجر والماركت بليس).
//
// Talks to the tenant /api/marketplace storefront and the SuperAdmin
// /api/admin/marketplace Control Center. Fetch style mirrors the extension
// registry (plain fetch + Bearer auth + acting-company header), since these
// are isolated endpoints outside the OpenAPI generator.
// ─────────────────────────────────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch { /* keep text */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export type PricingModel = "free" | "one_time" | "monthly";
export type ListingStatus = "draft" | "published" | "unpublished";

// ── Tenant storefront types ──────────────────────────────────────────────
export interface StorefrontItem {
  extensionId: string;
  nameAr: string;
  nameEn: string | null;
  version: string;
  vendor: string | null;
  category: string;
  summaryAr: string | null;
  summaryEn: string | null;
  descriptionAr: string | null;
  iconUrl: string | null;
  pricingModel: PricingModel;
  price: string;
  currency: string;
  featured: boolean;
  screens: Array<{ key: string; titleAr: string }>;
  permissions: Array<unknown>;
  paid: boolean;
  owned: boolean;
  installed: boolean;
}

export interface Purchase {
  id: number;
  companyId: number;
  extensionId: string;
  listingId: number | null;
  partnerId: number | null;
  pricingModel: PricingModel;
  amount: string;
  currency: string;
  commissionRate: string;
  commissionAmount: string;
  status: string;
  billingCycleEnd: string | null;
  purchasedByUsername: string | null;
  createdAt: string | null;
}

// ── Admin types ──────────────────────────────────────────────────────────
export interface AdminListing {
  id: number;
  extensionId: string;
  partnerId: number | null;
  partnerName: string | null;
  category: string;
  summaryAr: string | null;
  summaryEn: string | null;
  descriptionAr: string | null;
  iconUrl: string | null;
  pricingModel: PricingModel;
  price: string;
  currency: string;
  commissionRate: string | null;
  status: ListingStatus;
  featured: boolean;
  activeInstalls: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CatalogExtensionLite {
  extensionId: string;
  nameAr: string;
  nameEn: string | null;
  version: string;
  vendor: string | null;
}

export interface PartnerLite {
  id: number;
  nameAr: string;
  partnerCode: string | null;
  commissionRate: string;
}

export interface ListingsResponse {
  listings: AdminListing[];
  extensions: CatalogExtensionLite[];
  partners: PartnerLite[];
}

export interface SalesRow {
  id: number;
  companyId: number;
  companyName: string | null;
  extensionId: string;
  partnerId: number | null;
  partnerName: string | null;
  pricingModel: PricingModel;
  amount: string;
  currency: string;
  commissionRate: string;
  commissionAmount: string;
  status: string;
  createdAt: string | null;
}

export interface SalesResponse {
  purchases: SalesRow[];
  byExtension: Array<{ extensionId: string; sales: number; gross: string; commission: string; developerNet: string }>;
  totals: { sales: number; gross: string; commission: string; developerNet: string };
}

// ── Query keys ───────────────────────────────────────────────────────────
export const marketKeys = {
  storefront: ["market", "storefront"] as const,
  myPurchases: ["market", "my-purchases"] as const,
  adminListings: ["market", "admin", "listings"] as const,
  adminSales: ["market", "admin", "sales"] as const,
};

// ── Tenant hooks ─────────────────────────────────────────────────────────
export function useStorefront(enabled = true) {
  return useQuery({
    queryKey: marketKeys.storefront,
    enabled,
    queryFn: async () =>
      jsonOrThrow<{ items: StorefrontItem[] }>(
        await fetch(`${API}/api/marketplace/storefront`, { headers: authHeaders() }),
      ),
  });
}

export function useMyPurchases(enabled = true) {
  return useQuery({
    queryKey: marketKeys.myPurchases,
    enabled,
    queryFn: async () =>
      jsonOrThrow<{ purchases: Purchase[] }>(
        await fetch(`${API}/api/marketplace/my-purchases`, { headers: authHeaders() }),
      ),
  });
}

function useStorefrontAction(action: "purchase" | "install" | "uninstall") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (extensionId: string) =>
      jsonOrThrow<{ ok: true }>(
        await fetch(`${API}/api/marketplace/storefront/${encodeURIComponent(extensionId)}/${action}`, {
          method: "POST",
          headers: authHeaders(),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketKeys.storefront });
      void qc.invalidateQueries({ queryKey: marketKeys.myPurchases });
      void qc.invalidateQueries({ queryKey: ["ext", "installed"] });
      void qc.invalidateQueries({ queryKey: ["ext", "catalog"] });
    },
  });
}

export const usePurchaseApp = () => useStorefrontAction("purchase");
export const useInstallApp = () => useStorefrontAction("install");
export const useUninstallApp = () => useStorefrontAction("uninstall");

// ── Admin hooks ──────────────────────────────────────────────────────────
export function useAdminListings(enabled = true) {
  return useQuery({
    queryKey: marketKeys.adminListings,
    enabled,
    queryFn: async () =>
      jsonOrThrow<ListingsResponse>(
        await fetch(`${API}/api/admin/marketplace/listings`, { headers: authHeaders() }),
      ),
  });
}

export function useAdminSales(enabled = true) {
  return useQuery({
    queryKey: marketKeys.adminSales,
    enabled,
    queryFn: async () =>
      jsonOrThrow<SalesResponse>(
        await fetch(`${API}/api/admin/marketplace/sales`, { headers: authHeaders() }),
      ),
  });
}

export function useSaveListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Record<string, unknown> & { id?: number }) => {
      const isUpdate = typeof body.id === "number" && body.id > 0;
      const url = isUpdate
        ? `${API}/api/admin/marketplace/listings/${body.id}`
        : `${API}/api/admin/marketplace/listings`;
      return jsonOrThrow<{ ok: true; listing: AdminListing }>(
        await fetch(url, {
          method: isUpdate ? "PUT" : "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        }),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketKeys.adminListings });
      void qc.invalidateQueries({ queryKey: marketKeys.adminSales });
    },
  });
}

export function useDeleteListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) =>
      jsonOrThrow<{ ok: true }>(
        await fetch(`${API}/api/admin/marketplace/listings/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketKeys.adminListings });
    },
  });
}
