import { useEffect, useState } from "react";
import { Loader2, Wallet, X } from "lucide-react";
import { api, type CashBox } from "@/lib/api";

type Props = {
  open: boolean;
  onClose: () => void;
  companyId: number;
  cashBoxes: CashBox[];
  currentCashBoxId: number | null;
};

export default function CashBoxesDialog({ open, onClose, companyId, cashBoxes, currentCashBoxId }: Props) {
  const [balances, setBalances] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !companyId) return;
    let active = true;
    setLoading(true);
    setError("");
    api.getCashBoxBalances(companyId)
      .then((rows) => {
        if (active) setBalances(Object.fromEntries(rows.map((row) => [row.cashBoxId, Number(row.balance) || 0])));
      })
      .catch((cause: any) => {
        if (active) setError(cause?.message || "تعذّر تحميل أرصدة الخزائن.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, companyId]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/55 p-3" dir="rtl" role="dialog" aria-modal="true" aria-labelledby="pos-cash-boxes-title">
      <section className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Wallet className="size-5" /></span>
            <div>
              <h2 id="pos-cash-boxes-title" className="text-lg font-black">الخزائن المتاحة</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">الخزائن المسموح بها لفرع ومحطة البيع الحالية.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="grid size-9 place-items-center rounded-lg hover:bg-muted"><X className="size-4" /></button>
        </header>
        <div className="max-h-[65vh] space-y-2 overflow-auto p-4">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-primary" /></div>
          ) : error ? (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-bold">تعذّر عرض الخزائن</p>
              <p className="mt-1">{error}</p>
              <p className="mt-2 text-xs">تحقق من تفعيل وحدة الخزائن وصلاحية عرض خزائن نقطة البيع.</p>
            </div>
          ) : cashBoxes.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              لا توجد خزائن متاحة لهذا المستخدم أو الفرع. تحقق من ربط خزنة بمحطة البيع ومنح المستخدم صلاحية الوصول إليها.
            </div>
          ) : cashBoxes.map((box) => (
            <article key={box.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0">
                <p className="truncate font-bold">{box.nameAr}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{box.code}{box.branchId ? ` · فرع ${box.branchId}` : ""}</p>
                {box.id === currentCashBoxId && <span className="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">خزنة الوردية الحالية</span>}
              </div>
              <div className="shrink-0 text-left">
                <p className="text-[10px] text-muted-foreground">الرصيد</p>
                <p className="font-mono text-sm font-black">{(balances[box.id] ?? 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
