import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type CompanyTax = {
  id: number; companyId: number; code: string; nameAr: string; nameEn: string | null;
  rate: string; rateType: "percent" | "fixed"; currencyCode: string | null;
  branchId: number | null; costCenter: string | null;
  accountId: number | null; salesTaxAccountId: number | null; purchaseTaxAccountId: number | null;
  isActive: boolean; isDefault: boolean; isSystem: boolean; notes: string | null;
};

/**
 * Shared catalog of company taxes for document/JE forms.
 * - `taxes` is the active list (for the header tax picker).
 * - `defaultTax` is the company's default tax (falls back to the system VAT).
 * - `byId` resolves a tax by id.
 * - `comboItems` are ready for <SearchCombobox>.
 *
 * ZATCA SAFETY: the percent rate here ONLY pre-fills the editable line vatRate
 * before a document is issued. It never renames or overwrites the stored
 * vat_rate/vat_amount/tax_category that ZATCA XML/QR read at/after issue.
 */
export function useCompanyTaxes() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: taxesAll = [], isLoading } = useQuery<CompanyTax[]>({
    queryKey: ["taxes", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/taxes${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const taxes = useMemo(() => taxesAll.filter(t => t.isActive), [taxesAll]);
  /**
   * Active PERCENT-only taxes. The document/JE VAT-rate flows compute VAT as a
   * percentage of the line/base, so a `fixed` (flat-amount) tax has no defined
   * behaviour there. These flows must pick from `taxesPercent` only — never
   * offer a fixed tax that would be silently ignored.
   */
  const taxesPercent = useMemo(() => taxes.filter(t => t.rateType === "percent"), [taxes]);
  const defaultTax = useMemo(
    () => taxesAll.find(t => t.isDefault) ?? taxesAll.find(t => t.isSystem) ?? null,
    [taxesAll],
  );
  /** Default tax restricted to percent — for VAT-rate flows (docs/JE). */
  const defaultPercentTax = useMemo(
    () =>
      taxesAll.find(t => t.isDefault && t.rateType === "percent") ??
      taxesAll.find(t => t.isSystem && t.rateType === "percent") ??
      taxesPercent[0] ??
      null,
    [taxesAll, taxesPercent],
  );
  const byId = useMemo(() => {
    const m = new Map<number, CompanyTax>();
    for (const t of taxesAll) m.set(t.id, t);
    return m;
  }, [taxesAll]);

  const comboItems = useMemo(() => ([
    { value: "", label: "— بدون ضريبة —" },
    ...taxes.map(t => ({
      value: String(t.id),
      label: `${t.nameAr}${t.rateType === "percent" ? ` (${t.rate}%)` : ` (${t.rate})`}`,
    })),
  ]), [taxes]);

  /** Combobox items for VAT-rate flows: «بدون» + PERCENT taxes only. */
  const comboItemsPercent = useMemo(() => ([
    { value: "", label: "— بدون ضريبة —" },
    ...taxesPercent.map(t => ({
      value: String(t.id),
      label: `${t.nameAr} (${t.rate}%)`,
    })),
  ]), [taxesPercent]);

  /** Resolve the percent rate (number) for a tax id, or null for fixed/unknown. */
  const percentRateOf = (taxId: string | number | null | undefined): number | null => {
    if (taxId === null || taxId === undefined || taxId === "") return null;
    const t = byId.get(Number(taxId));
    if (!t || t.rateType !== "percent") return null;
    const n = Number(t.rate);
    return Number.isFinite(n) ? n : null;
  };

  return { taxes, taxesPercent, taxesAll, defaultTax, defaultPercentTax, byId, comboItems, comboItemsPercent, percentRateOf, isLoading };
}
