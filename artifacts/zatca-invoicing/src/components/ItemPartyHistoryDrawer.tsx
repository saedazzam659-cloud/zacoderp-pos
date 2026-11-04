import { useEffect, useState } from "react";
import { History, Loader2, X } from "lucide-react";

type HistoryEntry = {
  invoiceId: number;
  docNumber?: string | null;
  invoiceDate: string;
  qty: string;
  unit?: string | null;
  unitPrice: string;
  discount: string;
  discountAmount: string;
  lineTotal: string;
  currencyCode: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  kind: "sale" | "purchase";
  itemId: string;
  itemCode: string;
  partyId: string;
  apiBase: string;
  authorization: string;
  isRtl: boolean;
};

export default function ItemPartyHistoryDrawer({
  open, onClose, kind, itemId, itemCode, partyId, apiBase, authorization, isRtl,
}: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (!itemId || !partyId) {
      setEntries([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ itemId, partyId, limit: "20" });
    const endpoint = kind === "sale"
      ? "/api/sales/sales-invoices/item-party-history"
      : "/api/purchasing/purchase-invoices/item-party-history";
    setLoading(true);
    setError("");
    fetch(`${apiBase}${endpoint}?${params}`, {
      headers: { Authorization: authorization },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || (isRtl ? "تعذر تحميل حركة الصنف." : "Could not load item history."));
      }
      const body = await response.json();
      setEntries(Array.isArray(body?.entries) ? body.entries : []);
    }).catch((cause: any) => {
      if (cause?.name !== "AbortError") setError(cause?.message || (isRtl ? "تعذر تحميل حركة الصنف." : "Could not load item history."));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, itemId, partyId, kind, apiBase, authorization, isRtl]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const money = (value: string, currency: string) => `${Number(value || 0).toLocaleString(isRtl ? "ar-EG" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
  const title = kind === "sale"
    ? (isRtl ? "حركة الصنف مع العميل" : "Item history with customer")
    : (isRtl ? "حركة الصنف مع المورد" : "Item history with supplier");

  return (
    <div className="fixed inset-0 z-[120] flex bg-black/40" dir={isRtl ? "rtl" : "ltr"} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label={title} className="ms-auto flex h-full w-full max-w-2xl flex-col overflow-hidden border-s bg-background shadow-2xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="font-bold">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{isRtl ? "كود الصنف:" : "Item code:"} <span className="font-mono">{itemCode || itemId}</span></p>
          </div>
          <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-lg hover:bg-muted" aria-label={isRtl ? "إغلاق" : "Close"}><X className="size-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!partyId ? (
            <p className="rounded-xl bg-muted p-4 text-sm">{kind === "sale"
              ? (isRtl ? "اختر العميل أولاً لعرض حركات الصنف معه." : "Select a customer to see this item's history.")
              : (isRtl ? "اختر المورد أولاً لعرض حركات الصنف معه." : "Select a supplier to see this item's history.")}</p>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{isRtl ? "جارٍ تحميل الحركة..." : "Loading history..."}</div>
          ) : error ? (
            <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-muted-foreground"><History className="size-8 opacity-50" />{isRtl ? "لا توجد فواتير معتمدة لهذا الصنف مع الطرف المحدد." : "No posted invoices found for this item and party."}</div>
          ) : (
            <>
              <section className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="text-xs text-muted-foreground">{isRtl ? "آخر سعر للوحدة قبل الخصم" : "Latest unit price before discounts"}</p>
                <strong className="mt-1 block text-xl">{money(entries[0].unitPrice, entries[0].currencyCode)}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{entries[0].invoiceDate} · {entries[0].docNumber || `#${entries[0].invoiceId}`}</p>
              </section>
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[620px] text-start text-xs">
                  <thead className="bg-muted/60"><tr>{[
                    isRtl ? "التاريخ" : "Date", isRtl ? "الفاتورة" : "Invoice",
                    isRtl ? "الكمية" : "Qty", isRtl ? "الوحدة" : "Unit",
                    isRtl ? "سعر الوحدة" : "Unit price", isRtl ? "الخصم" : "Discount",
                  ].map((label) => <th key={label} className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead>
                  <tbody>{entries.map((entry, index) => <tr key={`${entry.invoiceId}-${index}`} className="border-t">
                    <td className="whitespace-nowrap px-3 py-2">{entry.invoiceDate}</td>
                    <td className="px-3 py-2 font-mono">{entry.docNumber || `#${entry.invoiceId}`}</td>
                    <td className="px-3 py-2 tabular-nums">{Number(entry.qty).toLocaleString()}</td>
                    <td className="px-3 py-2">{entry.unit || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{money(entry.unitPrice, entry.currencyCode)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{Number(entry.discount) ? `${entry.discount}%` : "—"}{Number(entry.discountAmount) ? ` + ${money(entry.discountAmount, entry.currencyCode)}` : ""}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">{isRtl ? "الأسعار كما سُجلت في الفواتير، ولا يتم تطبيقها تلقائياً على السطر الحالي." : "Prices are shown as recorded; they are not applied to the current line."}</p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
