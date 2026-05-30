// Client wrapper for tax (الضرائب) commands.
// Tauri-only: browser-dev preview returns empty arrays / throws clear errors.
//
// A tax is a master-data record: one GL account + a rate (percent OR a fixed
// value) + per-direction availability and debit/credit nature. Exactly one
// tax may be the system default; its percent rate drives the manual
// journal-entry screen and pre-selects on the 4 invoice forms.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type TaxRateType = "percent" | "value";
export type TaxNature = "debit" | "credit";

/** The 4 invoice directions a tax can be wired to. */
export type TaxDirection =
  | "sales" | "sales_return" | "purchase" | "purchase_return";

export type Tax = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  currencyCode: string | null;
  branchId: number | null;
  rateType: TaxRateType;
  rateValue: number;
  accountId: number | null;
  salesEnabled: boolean;
  salesNature: TaxNature;
  salesReturnEnabled: boolean;
  salesReturnNature: TaxNature;
  purchaseEnabled: boolean;
  purchaseNature: TaxNature;
  purchaseReturnEnabled: boolean;
  purchaseReturnNature: TaxNature;
  isDefault: boolean;
  isActive: boolean;
};

export type TaxInput = {
  code: string;
  nameAr: string;
  nameEn: string | null;
  currencyCode: string | null;
  branchId: number | null;
  rateType: TaxRateType;
  rateValue: number;
  accountId: number | null;
  salesEnabled: boolean;
  salesNature: TaxNature;
  salesReturnEnabled: boolean;
  salesReturnNature: TaxNature;
  purchaseEnabled: boolean;
  purchaseNature: TaxNature;
  purchaseReturnEnabled: boolean;
  purchaseReturnNature: TaxNature;
  isDefault: boolean;
  isActive: boolean;
};

export async function listTaxes(): Promise<Tax[]> {
  if (!hasTauri()) return [];
  return await invoke<Tax[]>("taxes_list");
}
export async function createTax(input: TaxInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("tax_create", { input });
}
export async function updateTax(id: number, input: TaxInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("tax_update", { id, input });
}
export async function deleteTax(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("tax_delete", { id });
}
export async function setDefaultTax(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("tax_set_default", { id });
}

/** Is this tax available for the given invoice direction? */
export function isTaxEnabledFor(t: Tax, dir: TaxDirection): boolean {
  switch (dir) {
    case "sales": return t.salesEnabled;
    case "sales_return": return t.salesReturnEnabled;
    case "purchase": return t.purchaseEnabled;
    case "purchase_return": return t.purchaseReturnEnabled;
  }
}

/** The debit/credit nature the tax account takes for a direction. */
export function taxNatureFor(t: Tax, dir: TaxDirection): TaxNature {
  switch (dir) {
    case "sales": return t.salesNature;
    case "sales_return": return t.salesReturnNature;
    case "purchase": return t.purchaseNature;
    case "purchase_return": return t.purchaseReturnNature;
  }
}

/**
 * Active, default tax (if any). The list is small, so a linear scan is fine.
 * Returns null in browser-dev or when no default is configured.
 */
export async function getDefaultTax(): Promise<Tax | null> {
  const all = await listTaxes();
  return all.find((t) => t.isDefault && t.isActive) ?? null;
}

/**
 * Default tax *percent* rate, or null when there is no active default of
 * rate_type 'percent'. Callers fall back to the country/localStorage rate.
 * Fixed-value taxes are intentionally ignored here — the JE and invoice
 * engines compute VAT as a percentage of the base.
 */
export async function getDefaultTaxPercent(): Promise<number | null> {
  const t = await getDefaultTax();
  if (!t || t.rateType !== "percent") return null;
  const n = Number(t.rateValue);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
