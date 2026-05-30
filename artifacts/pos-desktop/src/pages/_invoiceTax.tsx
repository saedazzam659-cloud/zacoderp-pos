// Shared header-tax picker logic for the 4 invoice forms (sales invoice,
// sales return, purchase, purchase return).
//
// A "header tax" is one tax from the dynamic Taxes screen applied to the WHOLE
// invoice: selecting it broadcasts its percent rate to every line. Only active,
// percent-type taxes enabled for the form's direction are offered. Fixed-value
// taxes are intentionally excluded — the invoice engine computes VAT as a
// percentage of the net base. When a default tax exists for the direction it is
// pre-selected so the common case needs no extra click.
import { useEffect, useMemo, useState } from "react";
import { listTaxes, isTaxEnabledFor, type Tax, type TaxDirection } from "../lib/taxes";

export function useInvoiceTaxes(direction: TaxDirection) {
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [taxId, setTaxId] = useState<number | "">("");

  useEffect(() => {
    void listTaxes()
      .then((all) => {
        const usable = all.filter(
          (t) => t.isActive && t.rateType === "percent" && isTaxEnabledFor(t, direction),
        );
        setTaxes(usable);
        const def = usable.find((t) => t.isDefault);
        if (def) setTaxId(def.id);
      })
      .catch(() => { /* browser-dev / no taxes: leave the per-line rates as-is */ });
  }, [direction]);

  const taxOptions = useMemo(() => [
    { value: "", label: "— بدون ضريبة موحّدة —" },
    ...taxes.map((t) => ({ value: t.id, label: `${t.code} — ${t.nameAr} (${t.rateValue}%)` })),
  ], [taxes]);

  /** Percent rate of the currently-selected header tax, or null when none. */
  const selectedRate = useMemo(() => {
    const t = taxes.find((x) => x.id === taxId);
    return t ? t.rateValue : null;
  }, [taxes, taxId]);

  return { taxes, taxId, setTaxId, taxOptions, selectedRate };
}
