import { useAuth } from "@/contexts/AuthContext";

/**
 * useFmt — Central formatting hook respecting company decimalPlaces setting.
 *
 * fmt(n)         — monetary amounts / prices        (dp places)
 * fmtQty(n)      — quantities                       (dp places)
 * fmtCost(n)     — unit/avg cost prices             (max(dp, 4) for precision)
 * fmtVal(n)      — totals with Arabic locale        (dp places, no currency)
 * fmtCurrency(n) — amounts with SAR currency symbol (dp places)
 * fmtTrim(n)     — number with trailing zeros after decimal removed (e.g. 6.5000 → 6.5, 6.000 → 6)
 * dp             — raw number of decimal places
 */
export const trimTrailingZeros = (n: number | string | null | undefined): string => {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return "0";
  return num.toFixed(6).replace(/\.?0+$/, "") || "0";
};

export function useFmt() {
  const { user } = useAuth();
  const dp: number = (user?.company?.decimalPlaces as number) ?? 2;

  const fmt = (n: number | string | null | undefined): string =>
    Number(n ?? 0).toFixed(dp);

  const fmtQty = (n: number | string | null | undefined): string =>
    Number(n ?? 0).toFixed(dp);

  const fmtCost = (n: number | string | null | undefined): string =>
    Number(n ?? 0).toFixed(Math.max(dp, 4));

  const fmtVal = (n: number | string | null | undefined): string =>
    Number(n ?? 0).toLocaleString("ar-SA-u-nu-latn", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });

  const fmtCurrency = (n: number | string | null | undefined): string =>
    new Intl.NumberFormat("ar-SA", {
      style: "currency",
      currency: "SAR",
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(Number(n ?? 0));

  const fmtTrim = trimTrailingZeros;

  return { dp, fmt, fmtQty, fmtCost, fmtVal, fmtCurrency, fmtTrim };
}
