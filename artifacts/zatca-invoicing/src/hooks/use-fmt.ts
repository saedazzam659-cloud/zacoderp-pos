import { useAuth } from "@/contexts/AuthContext";

/**
 * useFmt — Central formatting hook respecting company decimalPlaces setting.
 *
 * fmt(n)         — monetary amounts / prices        (dp places)
 * fmtQty(n)      — quantities                       (dp places)
 * fmtCost(n)     — unit/avg cost prices             (max(dp, 4) for precision)
 * fmtVal(n)      — totals with Arabic locale        (dp places, no currency)
 * fmtCurrency(n) — amounts with SAR currency symbol (dp places)
 * dp             — raw number of decimal places
 */
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

  return { dp, fmt, fmtQty, fmtCost, fmtVal, fmtCurrency };
}
