import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, CalendarRange, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type PosPeriodReport } from "@/lib/api";

type Ranges = { period1From: string; period1To: string; period2From: string; period2To: string };
type Metric = "netSales" | "orders" | "averageOrder" | "discounts" | "returns" | "returnCount" | "voidCount" | "voidAmount";

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftDate(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

function defaultRanges(): Ranges {
  const today = localDate(new Date());
  return { period1From: shiftDate(today, -6), period1To: today, period2From: shiftDate(today, -13), period2To: shiftDate(today, -7) };
}

function money(value: number, currency: string) {
  return `${Number(value || 0).toLocaleString("ar-SA", { maximumFractionDigits: 2 })} ${currency}`;
}

function delta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? "0%" : "جديد";
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function paymentName(value: string) {
  return ({ cash: "نقدي", card: "بطاقة", apple: "Apple Pay", wallet: "محفظة", mixed: "دفع مختلط", credit: "آجل" } as Record<string, string>)[value] ?? value;
}

const metricLabels: Record<Metric, string> = {
  netSales: "صافي المبيعات",
  orders: "عدد الفواتير",
  averageOrder: "متوسط الفاتورة",
  discounts: "الخصومات",
  returns: "قيمة المرتجعات",
  returnCount: "عدد المرتجعات",
  voidCount: "الفواتير الملغاة",
  voidAmount: "قيمة الفواتير الملغاة",
};

function emptyPeriod(currencyCode: string): PosPeriodReport {
  return { currencyCode, sales: 0, returns: 0, netSales: 0, orders: 0, averageOrder: 0, discounts: 0, returnCount: 0, voidCount: 0, voidAmount: 0, paymentMix: [], topItems: [] };
}

export default function PosPeriodComparison() {
  const [draft, setDraft] = useState<Ranges>(defaultRanges);
  const [applied, setApplied] = useState<Ranges>(defaultRanges);
  const [formError, setFormError] = useState("");
  const report = useQuery({
    queryKey: ["pos-period-comparison", applied],
    queryFn: () => api.rCustomPeriodComparison(applied),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.period1From > draft.period1To || draft.period2From > draft.period2To) {
      setFormError("تاريخ البداية يجب أن يسبق تاريخ النهاية في كل فترة.");
      return;
    }
    setFormError("");
    setApplied({ ...draft });
  }

  const currencies = Array.from(new Set([
    ...(report.data?.period1.currencies.map(item => item.currencyCode) ?? []),
    ...(report.data?.period2.currencies.map(item => item.currencyCode) ?? []),
  ])).sort();

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-xl" data-testid="section-pos-period-comparison">
      <header className="flex items-center gap-3 border-b border-white/10 bg-gradient-to-l from-emerald-500/10 via-slate-900 to-slate-900 p-4">
        <span className="grid size-10 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300"><CalendarRange className="size-5" /></span>
        <div>
          <h2 className="font-black">مقارنة فترتين</h2>
          <p className="mt-0.5 text-xs text-white/55">قارن المبيعات والفواتير والخصومات والمرتجعات بين تاريخين</p>
        </div>
      </header>

      <form onSubmit={submit} className="grid gap-3 border-b border-white/10 p-4 lg:grid-cols-[1fr_1fr_auto]">
        {([
          ["الفترة الأولى", "period1From", "period1To"],
          ["فترة المقارنة", "period2From", "period2To"],
        ] as const).map(([label, fromKey, toKey]) => (
          <fieldset key={fromKey} className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-slate-950/40 p-3">
            <legend className="px-1 text-xs font-bold text-emerald-200">{label}</legend>
            <label className="text-[11px] text-white/55">من
              <input type="date" value={draft[fromKey]} onChange={e => setDraft(value => ({ ...value, [fromKey]: e.target.value }))} className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-white" data-testid={`input-${fromKey}`} />
            </label>
            <label className="text-[11px] text-white/55">إلى
              <input type="date" value={draft[toKey]} onChange={e => setDraft(value => ({ ...value, [toKey]: e.target.value }))} className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-white" data-testid={`input-${toKey}`} />
            </label>
          </fieldset>
        ))}
        <div className="flex flex-col justify-end gap-2">
          <Button type="submit" className="h-10 bg-emerald-600 font-bold text-white hover:bg-emerald-500" data-testid="button-run-period-comparison">
            {report.isFetching ? <Loader2 className="me-2 size-4 animate-spin" /> : <Search className="me-2 size-4" />}
            عرض المقارنة
          </Button>
          {formError && <p role="alert" className="text-xs text-rose-300">{formError}</p>}
        </div>
      </form>

      {report.isLoading ? <div className="p-8 text-center text-white/60"><Loader2 className="mx-auto mb-2 size-5 animate-spin" />جارٍ تحميل المقارنة…</div> :
        report.isError ? <div role="alert" className="p-5 text-sm text-rose-300">{report.error.message}</div> :
        currencies.length === 0 ? <div className="p-8 text-center text-sm text-white/55">لا توجد مبيعات نقاط بيع في الفترتين المحددتين.</div> :
        <div className="space-y-4 p-4">
          {currencies.map(currency => {
            const first = report.data!.period1.currencies.find(item => item.currencyCode === currency) ?? emptyPeriod(currency);
            const second = report.data!.period2.currencies.find(item => item.currencyCode === currency) ?? emptyPeriod(currency);
            const metrics: Metric[] = ["netSales", "orders", "averageOrder", "discounts", "returns", "returnCount", "voidCount", "voidAmount"];
            const format = (metric: Metric, value: number) => metric === "orders" || metric === "returnCount" || metric === "voidCount" ? value.toLocaleString("ar-SA") : money(value, currency);
            const paymentTypes = Array.from(new Set([...first.paymentMix.map(item => item.paymentType), ...second.paymentMix.map(item => item.paymentType)])).sort();
            return (
              <article key={currency} className="rounded-xl border border-white/10 bg-slate-950/35 p-4" data-testid={`comparison-currency-${currency}`}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-black text-emerald-200">{currency}</h3>
                  <span className="text-[11px] text-white/45">{report.data!.period1.from} — {report.data!.period1.to} مقابل {report.data!.period2.from} — {report.data!.period2.to}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {metrics.map(metric => {
                    const a = Number(first[metric]);
                    const b = Number(second[metric]);
                    const pct = delta(a, b);
                    const movedUp = a >= b;
                    const favorable = ["netSales", "orders", "averageOrder"].includes(metric) ? movedUp : !movedUp;
                    return (
                      <div key={metric} className="rounded-lg border border-white/8 bg-slate-900 p-3">
                        <p className="text-[11px] text-white/55">{metricLabels[metric]}</p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div><span className="block text-[10px] text-white/40">الأولى</span><strong className="text-sm">{format(metric, a)}</strong></div>
                          <div className="text-center">
                            <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold ${favorable ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
                              {movedUp ? <ArrowUpRight className="me-0.5 size-3" /> : <ArrowDownRight className="me-0.5 size-3" />}{pct}
                            </span>
                          </div>
                          <div className="text-end"><span className="block text-[10px] text-white/40">المقارنة</span><strong className="text-sm">{format(metric, b)}</strong></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <h4 className="mb-2 text-sm font-bold">المبيعات حسب وسيلة الدفع</h4>
                    {paymentTypes.length ? <div className="overflow-x-auto rounded-lg border border-white/10">
                      <table className="w-full text-xs">
                        <thead className="bg-white/5 text-white/55"><tr><th className="p-2 text-right">الوسيلة</th><th className="p-2 text-right">الفترة الأولى</th><th className="p-2 text-right">المقارنة</th></tr></thead>
                        <tbody>{paymentTypes.map(type => {
                          const a = first.paymentMix.find(item => item.paymentType === type);
                          const b = second.paymentMix.find(item => item.paymentType === type);
                          return <tr key={type} className="border-t border-white/5"><td className="p-2">{paymentName(type)}</td><td className="p-2">{money(a?.amount ?? 0, currency)} <span className="text-white/40">({a?.count ?? 0})</span></td><td className="p-2">{money(b?.amount ?? 0, currency)} <span className="text-white/40">({b?.count ?? 0})</span></td></tr>;
                        })}</tbody>
                      </table>
                    </div> : <p className="text-xs text-white/45">لا توجد بيانات دفع.</p>}
                  </div>
                  <div>
                    <h4 className="mb-2 text-sm font-bold">الأصناف الأعلى مبيعًا</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {([[first.topItems, "الفترة الأولى"], [second.topItems, "فترة المقارنة"]] as const).map(([items, label]) => (
                        <div key={label} className="rounded-lg border border-white/10 p-2">
                          <p className="mb-2 text-[11px] font-bold text-emerald-200">{label}</p>
                          {items.length ? <ol className="space-y-1.5">{items.slice(0, 5).map((item, index) => <li key={`${item.itemId}-${item.name}`} className="flex justify-between gap-2 text-[11px]"><span className="min-w-0 truncate"><b className="me-1 text-white/40">{index + 1}.</b>{item.name}<span className="ms-1 text-white/40">×{item.qty}</span></span><span className="shrink-0 text-white/70">{money(item.revenue, currency)}</span></li>)}</ol> : <p className="text-[11px] text-white/45">لا توجد بيانات.</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>}
    </section>
  );
}
