import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { compareDocumentQuantities } from "@/lib/documentQuantityDiff";

type Props = {
  sourceLabel: string;
  sourceNumber?: string | null;
  sourceLines?: any[];
  invoiceLines: any[];
};

export function DocumentQuantityWarnings({ sourceLabel, sourceNumber, sourceLines, invoiceLines }: Props) {
  const { i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const differences = useMemo(
    () => compareDocumentQuantities(sourceLines ?? [], invoiceLines ?? []),
    [sourceLines, invoiceLines],
  );
  if (!differences.length) return null;

  const number = new Intl.NumberFormat(isRtl ? "ar-EG" : "en", { maximumFractionDigits: 4 });
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="document-quantity-warning"
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50/80 px-4 py-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {isRtl ? "تنبيه: كميات الفاتورة تختلف عن المستند المصدر" : "Warning: invoice quantities differ from the source"}
          </h3>
          <p className="mt-0.5 text-xs opacity-80">
            {isRtl ? "يمكنك حفظ الفاتورة؛ هذا التنبيه لا يمنع الحفظ." : "You can still save the invoice; this warning does not block saving."}
            {sourceNumber ? ` ${sourceLabel}: ${sourceNumber}` : ""}
          </p>
          <ul className="mt-2 space-y-1">
            {differences.map(row => (
              <li key={row.key} data-testid={`quantity-difference-${row.key}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium">{row.itemName}{row.itemCode ? ` (${row.itemCode})` : ""}</span>
                <span>
                  {isRtl ? "المصدر" : "Source"}: {number.format(row.sourceQuantity)}{row.unit ? ` ${row.unit}` : ""}
                </span>
                <span>
                  {isRtl ? "الفاتورة" : "Invoice"}: {number.format(row.invoiceQuantity)}{row.unit ? ` ${row.unit}` : ""}
                </span>
                <span className="font-semibold">
                  {isRtl ? "الفرق" : "Difference"}: {row.difference > 0 ? "+" : ""}{number.format(row.difference)}{row.unit ? ` ${row.unit}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
