// Shared status pill for transactional documents. Reads the document's
// raw status string (sales/purchase invoice|return|order|quotation) and
// renders a colored pill using the global `t('status.<value>')` keys.
//
// Color mapping is deliberately tight to common ERP conventions:
//   draft     amber  (pending action)
//   posted    green  (finalized in ledger)
//   confirmed blue   (locked but not posted — orders)
//   sent      blue   (quotation sent to customer)
//   accepted  green  (quotation accepted)
//   rejected  red    (quotation rejected)
//   converted green  (order/quotation already turned into invoice)
//   cancelled gray   (no further action)
//
// Unknown statuses fall back to the draft (amber) style so we never crash
// on a new enum value introduced server-side.
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const STATUS_CLS: Record<string, string> = {
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  posted:    "bg-green-50 text-green-700 border-green-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  sent:      "bg-blue-50 text-blue-700 border-blue-200",
  accepted:  "bg-green-50 text-green-700 border-green-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  converted: "bg-green-50 text-green-700 border-green-200",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export function DocStatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const st = String(status ?? "draft");
  const cls = STATUS_CLS[st] ?? STATUS_CLS.draft;
  const label = t(`status.${st}`, { defaultValue: st });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        cls,
        className,
      )}
      data-testid="doc-status-badge"
      title={label}
    >
      {label}
    </span>
  );
}
