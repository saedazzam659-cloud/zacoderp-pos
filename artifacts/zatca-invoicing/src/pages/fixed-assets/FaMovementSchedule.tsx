import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { DateField } from "@/components/ui/date-field";
import { CalendarRange, Printer, Download, FileSpreadsheet, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Move = { opening: number; additions: number; exclusions: number; closing: number };
type Row = {
  kind: "asset" | "unlinked";
  assetId: number | null;
  code: string;
  name: string;
  status: string | null;
  acquisitionDate: string | null;
  depreciationStart: string | null;
  method: string | null;
  methodLabel: string | null;
  lifeYears: number | null;
  rate: number | null;
  cost: Move;
  dep: Move;
  bookValue: number;
};
type Group = {
  accountId: number | null;
  accountCode: string;
  accountName: string;
  rows: Row[];
  totals: { cost: Move; dep: Move; bookValue: number };
};
type ScheduleResp = {
  from: string;
  to: string;
  groups: Group[];
  totals: { cost: Move; dep: Move; bookValue: number };
};

const fmt = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString("ar-EG-u-ca-gregory-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string | null) => (d ? d : "—");

const STATUS_LABELS: Record<string, string> = {
  active: "نشط", in_maintenance: "تحت الصيانة", transferred: "منقول",
  sold: "مباع", scrapped: "مخرّد", fully_depreciated: "مهلك بالكامل",
};

function defaultRange() {
  const today = new Date();
  const y = today.getFullYear();
  const to = today.toISOString().slice(0, 10);
  return { from: `${y}-01-01`, to };
}

export default function FaMovementSchedule() {
  const { user, token } = useAuth() as any;
  const cid = user?.companyId;
  const headers = { Authorization: `Bearer ${token}` };

  const init = defaultRange();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);

  const { data, isFetching, isError } = useQuery<ScheduleResp>({
    queryKey: ["fa/movement-schedule", cid, from, to],
    queryFn: async () => {
      const r = await fetch(
        `${API}/api/fixed-assets/reports/movement-schedule?companyId=${cid}&from=${from}&to=${to}`,
        { headers },
      );
      if (!r.ok) throw new Error("فشل تحميل التقرير");
      return r.json();
    },
    enabled: !!cid,
  });

  const groups = data?.groups ?? [];
  const totals = data?.totals;

  const flatCount = useMemo(
    () => groups.reduce((s, g) => s + g.rows.length, 0),
    [groups],
  );

  function exportCsv() {
    if (!data) return;
    const head = [
      "الحساب", "الأصل", "الحالة", "تاريخ الاستحواذ", "بداية الإهلاك", "الطريقة", "العمر/المعدل",
      "تكلفة رصيد أول", "تكلفة إضافات", "تكلفة استبعادات", "تكلفة رصيد آخر",
      "إهلاك رصيد أول", "إهلاك إضافات", "إهلاك استبعادات", "إهلاك رصيد آخر",
      "القيمة الدفترية",
    ];
    const lines = [head.join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        const life = r.lifeYears ? `${r.lifeYears} سنة${r.rate ? ` / ${r.rate}%` : ""}` : "";
        const cells = [
          `${g.accountCode} ${g.accountName}`,
          `${r.code !== "—" ? r.code + " " : ""}${r.name}`,
          r.status ? STATUS_LABELS[r.status] ?? r.status : "",
          r.acquisitionDate ?? "", r.depreciationStart ?? "",
          r.methodLabel ?? "", life,
          r.cost.opening, r.cost.additions, r.cost.exclusions, r.cost.closing,
          r.dep.opening, r.dep.additions, r.dep.exclusions, r.dep.closing,
          r.bookValue,
        ];
        lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
      }
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `جدول-الإهلاك_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const numCell = "px-2 py-1 text-center font-mono tabular-nums whitespace-nowrap";
  const th = "px-2 py-2 text-center font-semibold border border-slate-300";

  return (
    <div className="p-4 space-y-4" dir="rtl">
      {/* Header / controls */}
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-emerald-800 flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-emerald-600" />
            جدول الإهلاك وحركة الأصول الثابتة
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            مبني على القيود المحاسبية المُرحّلة — يشمل الأصول من الموديول ومن فواتير المشتريات والقيود اليدوية.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            من
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 w-36" />
          </label>
          <label className="text-xs text-slate-600">
            إلى
            <DateField value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 w-36" />
          </label>
          <button
            onClick={() => window.print()}
            className="h-9 px-3 rounded-md bg-slate-700 text-white text-sm flex items-center gap-1 hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" /> طباعة
          </button>
          <button
            onClick={exportCsv}
            className="h-9 px-3 rounded-md bg-emerald-600 text-white text-sm flex items-center gap-1 hover:bg-emerald-700"
          >
            <FileSpreadsheet className="h-4 w-4" /> تصدير CSV
          </button>
        </div>
      </div>

      {/* Print title */}
      <div className="hidden print:block text-center mb-2">
        <div className="text-lg font-bold">جدول الإهلاك وحركة الأصول الثابتة</div>
        <div className="text-sm">من {from} إلى {to}</div>
      </div>

      {isFetching && (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      )}
      {isError && (
        <div className="text-red-600 text-sm">تعذّر تحميل التقرير. حاول مرة أخرى.</div>
      )}
      {!isFetching && !isError && flatCount === 0 && (
        <div className="text-slate-500 text-sm border border-dashed rounded-lg p-8 text-center">
          لا توجد حركة أصول ثابتة في الفترة المحددة.
        </div>
      )}

      {flatCount > 0 && (
        <div className="overflow-x-auto border border-slate-300 rounded-lg">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th rowSpan={2} className={th}>الأصل / البيان</th>
                <th rowSpan={2} className={th}>تاريخ الاستحواذ</th>
                <th rowSpan={2} className={th}>بداية الإهلاك</th>
                <th rowSpan={2} className={th}>الطريقة</th>
                <th rowSpan={2} className={th}>العمر / المعدل</th>
                <th colSpan={4} className={`${th} bg-emerald-50`}>التكلفة (الأصول)</th>
                <th colSpan={4} className={`${th} bg-amber-50`}>مجمع الإهلاك</th>
                <th rowSpan={2} className={`${th} bg-sky-50`}>القيمة الدفترية</th>
              </tr>
              <tr>
                <th className={`${th} bg-emerald-50`}>رصيد أول</th>
                <th className={`${th} bg-emerald-50`}>+ إضافات</th>
                <th className={`${th} bg-emerald-50`}>− استبعادات</th>
                <th className={`${th} bg-emerald-50`}>رصيد آخر</th>
                <th className={`${th} bg-amber-50`}>رصيد أول</th>
                <th className={`${th} bg-amber-50`}>+ إهلاك الفترة</th>
                <th className={`${th} bg-amber-50`}>− استبعادات</th>
                <th className={`${th} bg-amber-50`}>رصيد آخر</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupBlock key={g.accountId ?? g.accountCode} g={g} numCell={numCell} />
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="bg-slate-800 text-white font-bold">
                  <td className="px-2 py-2 text-right" colSpan={5}>الإجمالي العام</td>
                  <td className={numCell}>{fmt(totals.cost.opening)}</td>
                  <td className={numCell}>{fmt(totals.cost.additions)}</td>
                  <td className={numCell}>{fmt(totals.cost.exclusions)}</td>
                  <td className={numCell}>{fmt(totals.cost.closing)}</td>
                  <td className={numCell}>{fmt(totals.dep.opening)}</td>
                  <td className={numCell}>{fmt(totals.dep.additions)}</td>
                  <td className={numCell}>{fmt(totals.dep.exclusions)}</td>
                  <td className={numCell}>{fmt(totals.dep.closing)}</td>
                  <td className={numCell}>{fmt(totals.bookValue)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function GroupBlock({ g, numCell }: { g: Group; numCell: string }) {
  return (
    <>
      <tr className="bg-emerald-100/70 text-emerald-900 font-bold">
        <td className="px-2 py-1.5 text-right" colSpan={14}>
          <span className="font-mono">{g.accountCode}</span> — {g.accountName}
        </td>
      </tr>
      {g.rows.map((r, i) => (
        <tr
          key={`${r.assetId ?? "u"}-${i}`}
          className={r.kind === "unlinked" ? "bg-slate-50 text-slate-600 italic" : "hover:bg-slate-50"}
        >
          <td className="px-2 py-1 text-right whitespace-nowrap">
            {r.code !== "—" && <span className="font-mono text-slate-400 ml-1">{r.code}</span>}
            {r.name}
            {r.status && (
              <span className="mr-1 text-[10px] text-slate-400">({STATUS_LABELS[r.status] ?? r.status})</span>
            )}
          </td>
          <td className="px-2 py-1 text-center whitespace-nowrap">{fmtDate(r.acquisitionDate)}</td>
          <td className="px-2 py-1 text-center whitespace-nowrap">{fmtDate(r.depreciationStart)}</td>
          <td className="px-2 py-1 text-center whitespace-nowrap">{r.methodLabel ?? "—"}</td>
          <td className="px-2 py-1 text-center whitespace-nowrap">
            {r.lifeYears ? `${r.lifeYears} سنة${r.rate ? ` / ${r.rate}%` : ""}` : "—"}
          </td>
          <td className={numCell}>{fmt(r.cost.opening)}</td>
          <td className={numCell}>{fmt(r.cost.additions)}</td>
          <td className={numCell}>{fmt(r.cost.exclusions)}</td>
          <td className={`${numCell} font-semibold`}>{fmt(r.cost.closing)}</td>
          <td className={numCell}>{fmt(r.dep.opening)}</td>
          <td className={numCell}>{fmt(r.dep.additions)}</td>
          <td className={numCell}>{fmt(r.dep.exclusions)}</td>
          <td className={`${numCell} font-semibold`}>{fmt(r.dep.closing)}</td>
          <td className={`${numCell} font-bold text-sky-800`}>{fmt(r.bookValue)}</td>
        </tr>
      ))}
      <tr className="bg-slate-100 font-semibold border-t border-slate-300">
        <td className="px-2 py-1 text-right" colSpan={5}>إجمالي {g.accountName}</td>
        <td className={numCell}>{fmt(g.totals.cost.opening)}</td>
        <td className={numCell}>{fmt(g.totals.cost.additions)}</td>
        <td className={numCell}>{fmt(g.totals.cost.exclusions)}</td>
        <td className={numCell}>{fmt(g.totals.cost.closing)}</td>
        <td className={numCell}>{fmt(g.totals.dep.opening)}</td>
        <td className={numCell}>{fmt(g.totals.dep.additions)}</td>
        <td className={numCell}>{fmt(g.totals.dep.exclusions)}</td>
        <td className={numCell}>{fmt(g.totals.dep.closing)}</td>
        <td className={`${numCell} text-sky-800`}>{fmt(g.totals.bookValue)}</td>
      </tr>
    </>
  );
}
