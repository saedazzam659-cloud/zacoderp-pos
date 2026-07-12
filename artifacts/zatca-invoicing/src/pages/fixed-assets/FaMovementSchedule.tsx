import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { DateField } from "@/components/ui/date-field";
import ExportButtons from "@/components/ExportButtons";
import { exportToPDF, type ExportColumn, type ExportCompanyInfo } from "@/lib/export";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CalendarRange, Printer, Loader2, ChevronDown, ChevronLeft, ChevronsDownUp, ChevronsUpDown, Layers, ListTree } from "lucide-react";

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

  // Collapsible category groups (SAP/Odoo-style): each category row acts as a
  // subtotal and is collapsed by default (the user will hold many assets, so
  // showing every row up-front is noise). Clicking a category expands its rows.
  const groupKey = (g: Group) => String(g.accountId ?? g.accountCode);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  const expandAll = () => setExpanded(new Set(groups.map(groupKey)));
  const collapseAll = () => setExpanded(new Set());
  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(groupKey(g)));

  // ── Year quick-filter ──────────────────────────────────────────────────────
  // Picking a year sets the range to Jan 1 → Dec 31 of that year. The manual
  // from/to date fields stay usable; the select shows the year only while the
  // range exactly matches a full calendar year.
  const currentYear = new Date().getFullYear();
  const yearOptions = useMemo(() => {
    const ys: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 10; y--) ys.push(y);
    return ys;
  }, [currentYear]);
  const selectedYear = useMemo(() => {
    const m = /^(\d{4})-01-01$/.exec(from);
    return m && to === `${m[1]}-12-31` ? m[1] : "";
  }, [from, to]);
  const pickYear = (y: string) => {
    if (!y) return;
    setFrom(`${y}-01-01`);
    setTo(`${y}-12-31`);
  };

  // ── Export (Excel / PDF / Print) — same pattern as the rest of the system ──
  const num = "#,##0.00";
  const exportColumns: ExportColumn[] = useMemo(() => [
    { header: "الأصل / البيان",     key: "item", width: 34 },
    { header: "الحالة",             key: "status", width: 12 },
    { header: "تاريخ الاستحواذ",    key: "acq", width: 13 },
    { header: "بداية الإهلاك",      key: "depStart", width: 13 },
    { header: "الطريقة",            key: "method", width: 12 },
    { header: "العمر / المعدل",     key: "life", width: 13 },
    { header: "تكلفة — رصيد أول",   key: "costOpen",  numFmt: num },
    { header: "تكلفة — إضافات",     key: "costAdd",   numFmt: num },
    { header: "تكلفة — استبعادات",  key: "costExcl",  numFmt: num },
    { header: "تكلفة — رصيد آخر",   key: "costClose", numFmt: num },
    { header: "إهلاك — رصيد أول",   key: "depOpen",   numFmt: num },
    { header: "إهلاك الفترة",       key: "depAdd",    numFmt: num },
    { header: "إهلاك — استبعادات",  key: "depExcl",   numFmt: num },
    { header: "إهلاك — رصيد آخر",   key: "depClose",  numFmt: num },
    { header: "القيمة الدفترية",    key: "bookValue", numFmt: num },
  ], []);

  const exportRows = useMemo(() => {
    const out: Record<string, unknown>[] = [];
    for (const g of groups) {
      // Category subtotal row (mirrors the on-screen green group row).
      out.push({
        item: `${g.accountCode} — ${g.accountName} (${g.rows.length} أصل)`,
        status: "", acq: "", depStart: "", method: "", life: "",
        costOpen: g.totals.cost.opening,  costAdd: g.totals.cost.additions,
        costExcl: g.totals.cost.exclusions, costClose: g.totals.cost.closing,
        depOpen: g.totals.dep.opening,    depAdd: g.totals.dep.additions,
        depExcl: g.totals.dep.exclusions, depClose: g.totals.dep.closing,
        bookValue: g.totals.bookValue,
      });
      for (const r of g.rows) {
        out.push({
          item: `${r.code !== "—" ? r.code + " " : ""}${r.name}`,
          status: r.status ? STATUS_LABELS[r.status] ?? r.status : "",
          acq: r.acquisitionDate ?? "—",
          depStart: r.depreciationStart ?? "—",
          method: r.methodLabel ?? "—",
          life: r.lifeYears ? `${Number(r.lifeYears)} سنة${r.rate ? ` / ${Number(r.rate)}%` : ""}` : "—",
          costOpen: r.cost.opening,  costAdd: r.cost.additions,
          costExcl: r.cost.exclusions, costClose: r.cost.closing,
          depOpen: r.dep.opening,    depAdd: r.dep.additions,
          depExcl: r.dep.exclusions, depClose: r.dep.closing,
          bookValue: r.bookValue,
        });
      }
    }
    return out;
  }, [groups]);

  const exportTotalsRow = useMemo(() => totals ? {
    item: "الإجمالي العام",
    status: "", acq: "", depStart: "", method: "", life: "",
    costOpen: totals.cost.opening,  costAdd: totals.cost.additions,
    costExcl: totals.cost.exclusions, costClose: totals.cost.closing,
    depOpen: totals.dep.opening,    depAdd: totals.dep.additions,
    depExcl: totals.dep.exclusions, depClose: totals.dep.closing,
    bookValue: totals.bookValue,
  } : null, [totals]);

  // ── Summary (no-details) variant — mirrors the on-screen COLLAPSED table:
  // one subtotal row per category + the grand total, WITHOUT per-asset rows.
  // Detail-only columns (status/dates/method/life) are dropped entirely so
  // the printed table stays compact and every cell fits on one line.
  const summaryColumns: ExportColumn[] = useMemo(() => [
    { header: "الأصل / البيان",     key: "item", width: 40 },
    { header: "تكلفة — رصيد أول",   key: "costOpen",  numFmt: num },
    { header: "تكلفة — إضافات",     key: "costAdd",   numFmt: num },
    { header: "تكلفة — استبعادات",  key: "costExcl",  numFmt: num },
    { header: "تكلفة — رصيد آخر",   key: "costClose", numFmt: num },
    { header: "إهلاك — رصيد أول",   key: "depOpen",   numFmt: num },
    { header: "إهلاك الفترة",       key: "depAdd",    numFmt: num },
    { header: "إهلاك — استبعادات",  key: "depExcl",   numFmt: num },
    { header: "إهلاك — رصيد آخر",   key: "depClose",  numFmt: num },
    { header: "القيمة الدفترية",    key: "bookValue", numFmt: num },
  ], []);

  const summaryRows = useMemo(() =>
    groups.map((g) => ({
      item: `${g.accountCode} — ${g.accountName} (${g.rows.length} أصل)`,
      costOpen: g.totals.cost.opening,  costAdd: g.totals.cost.additions,
      costExcl: g.totals.cost.exclusions, costClose: g.totals.cost.closing,
      depOpen: g.totals.dep.opening,    depAdd: g.totals.dep.additions,
      depExcl: g.totals.dep.exclusions, depClose: g.totals.dep.closing,
      bookValue: g.totals.bookValue,
    })), [groups]);

  const summaryTotalsRow = useMemo(() => totals ? {
    item: "الإجمالي العام",
    costOpen: totals.cost.opening,  costAdd: totals.cost.additions,
    costExcl: totals.cost.exclusions, costClose: totals.cost.closing,
    depOpen: totals.dep.opening,    depAdd: totals.dep.additions,
    depExcl: totals.dep.exclusions, depClose: totals.dep.closing,
    bookValue: totals.bookValue,
  } : null, [totals]);

  const reportTitle = "جدول الإهلاك وحركة الأصول الثابتة";
  const reportSubtitle = `من ${from} إلى ${to}`;
  const reportFilename = `جدول-الإهلاك_${from}_${to}`;

  // Branded print — same template exportToPDF renders for every other report
  // (company header + logo + styled table), opened in a new tab with
  // window.print() triggered automatically. Two variants:
  //   summary  → category subtotal rows only (same as the collapsed screen)
  //   detailed → category rows + every asset row
  const [printing, setPrinting] = useState(false);
  async function handlePrint(mode: "summary" | "detailed") {
    const rows = mode === "summary" ? summaryRows : exportRows;
    const cols = mode === "summary" ? summaryColumns : exportColumns;
    const totRow = mode === "summary" ? summaryTotalsRow : exportTotalsRow;
    if (!rows.length) return;
    setPrinting(true);
    try {
      const c = user?.company;
      const company: ExportCompanyInfo | null = c ? {
        nameAr: c.nameAr ?? c.name ?? null, nameEn: c.nameEn ?? null,
        crNumber: c.crNumber ?? null, vatNumber: c.vatNumber ?? null,
        phone: c.phone ?? null, buildingNumber: c.buildingNumber ?? null,
        street: c.street ?? null, district: c.district ?? null,
        city: c.city ?? null, postalCode: c.postalCode ?? null,
        logo: c.logo ?? null,
      } : null;
      await exportToPDF(
        rows, cols, reportFilename,
        reportTitle,
        `${reportSubtitle} — ${mode === "summary" ? "إجمالي" : "تفصيلي"}`,
        true, totRow, null, c?.logo ?? null, null, company,
        { fitOneLine: true },
      );
    } finally {
      setPrinting(false);
    }
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
            السنة
            <select
              value={selectedYear}
              onChange={(e) => pickYear(e.target.value)}
              className="block mt-1 h-9 w-24 px-2 rounded-md border border-slate-300 bg-white text-sm"
            >
              <option value="">مخصص</option>
              {yearOptions.map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            من
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 w-36" />
          </label>
          <label className="text-xs text-slate-600">
            إلى
            <DateField value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 w-36" />
          </label>
          <button
            onClick={() => (allExpanded ? collapseAll() : expandAll())}
            disabled={flatCount === 0}
            className="h-9 px-3 rounded-md border border-slate-300 bg-white text-slate-700 text-sm flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
          >
            {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
            {allExpanded ? "طي الكل" : "توسيع الكل"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={flatCount === 0 || printing}
                className="h-9 px-3 rounded-md bg-slate-700 text-white text-sm flex items-center gap-1 hover:bg-slate-800 disabled:opacity-50"
              >
                {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} طباعة
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handlePrint("summary")}>
                <Layers className="h-4 w-4 text-emerald-600" />
                <span>طباعة إجمالية (بدون تفاصيل)</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handlePrint("detailed")}>
                <ListTree className="h-4 w-4 text-sky-600" />
                <span>طباعة تفصيلية (بالأصول)</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ExportButtons
            rows={summaryRows}
            columns={summaryColumns}
            filename={`${reportFilename}_إجمالي`}
            title={reportTitle}
            subtitle={`${reportSubtitle} — إجمالي`}
            totalsRow={summaryTotalsRow}
            disabled={flatCount === 0}
            size="default"
            label="تصدير إجمالي"
            pdfFitOneLine
          />
          <ExportButtons
            rows={exportRows}
            columns={exportColumns}
            filename={`${reportFilename}_تفصيلي`}
            title={reportTitle}
            subtitle={`${reportSubtitle} — تفصيلي`}
            totalsRow={exportTotalsRow}
            disabled={flatCount === 0}
            size="default"
            label="تصدير تفصيلي"
            pdfFitOneLine
          />
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
                <GroupBlock
                  key={g.accountId ?? g.accountCode}
                  g={g}
                  numCell={numCell}
                  expanded={expanded.has(groupKey(g))}
                  onToggle={() => toggleGroup(groupKey(g))}
                />
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

function GroupBlock({
  g, numCell, expanded, onToggle,
}: {
  g: Group; numCell: string; expanded: boolean; onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronLeft;
  return (
    <>
      {/* Category row = clickable header AND subtotal (numbers always visible). */}
      <tr
        className="bg-emerald-100/70 text-emerald-900 font-bold cursor-pointer hover:bg-emerald-200/70 print:cursor-auto"
        onClick={onToggle}
      >
        <td className="px-2 py-1.5 text-right" colSpan={5}>
          <span className="inline-flex items-center gap-1.5">
            <Chevron className="h-4 w-4 shrink-0 text-emerald-700 print:hidden" />
            <span className="font-mono">{g.accountCode}</span>
            <span>— {g.accountName}</span>
            <span className="text-[10px] font-normal text-emerald-700/80">({g.rows.length} أصل)</span>
          </span>
        </td>
        <td className={numCell}>{fmt(g.totals.cost.opening)}</td>
        <td className={numCell}>{fmt(g.totals.cost.additions)}</td>
        <td className={numCell}>{fmt(g.totals.cost.exclusions)}</td>
        <td className={`${numCell} font-bold`}>{fmt(g.totals.cost.closing)}</td>
        <td className={numCell}>{fmt(g.totals.dep.opening)}</td>
        <td className={numCell}>{fmt(g.totals.dep.additions)}</td>
        <td className={numCell}>{fmt(g.totals.dep.exclusions)}</td>
        <td className={`${numCell} font-bold`}>{fmt(g.totals.dep.closing)}</td>
        <td className={`${numCell} font-bold text-sky-800`}>{fmt(g.totals.bookValue)}</td>
      </tr>
      {/* Detail rows: hidden while collapsed on screen, always shown in print. */}
      {g.rows.map((r, i) => (
        <tr
          key={`${r.assetId ?? "u"}-${i}`}
          className={`${r.kind === "unlinked" ? "bg-slate-50 text-slate-600 italic" : "hover:bg-slate-50"} ${expanded ? "" : "hidden print:table-row"}`}
        >
          <td className="py-1 pe-2 ps-7 text-right whitespace-nowrap">
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
            {r.lifeYears ? `${Number(r.lifeYears)} سنة${r.rate ? ` / ${Number(r.rate)}%` : ""}` : "—"}
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
    </>
  );
}
