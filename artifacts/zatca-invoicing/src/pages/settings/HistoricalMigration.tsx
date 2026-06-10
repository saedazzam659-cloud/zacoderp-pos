import { useMemo, useRef, useState, type ReactNode } from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Upload, Database, CheckCircle2, AlertTriangle, X, Loader2,
  CalendarPlus, CalendarCheck, Play, Lock, FileSpreadsheet, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type EntityCatalogItem,
  processImport,
  scanHistorical,
  commitHistorical,
  downloadBlob,
  type HistoricalScanResult,
  type HistoricalCommitResult,
  type ProcessResult,
} from "@/lib/dataIoApi";
import { PeriodClosingWizard } from "@/pages/accounting/PeriodClosingWizard";

const FISCAL_API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Fields we expose in the migration template. Header = field.labelAr so the
// deterministic mapper (labelAr/name match) wires every column without relying
// on the AI analyzer. CustomerCode/SupplierCode are intentionally omitted —
// journal_entry_lines has no party columns, so they cannot be migrated here.
const TEMPLATE_FIELD_NAMES = [
  "docNumber", "entryDate", "description", "currency", "exchangeRate",
  "branchCode", "accountCode", "debit", "credit", "lineDescription", "costCenter",
];

type FiscalYearRow = { id: number; name: string; startDate: string; endDate: string; status: string };
type FiscalPeriodRow = { id: number; name: string; startDate: string; endDate: string; status: "open" | "closed" | "permanently_closed" };

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HistoricalMigration({ entities, cid, token, toast }: {
  entities: EntityCatalogItem[]; cid?: number; token: string | null; toast: any;
}) {
  const entity = useMemo(() => entities.find((e) => e.key === "journalEntries"), [entities]);

  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [processed, setProcessed] = useState<ProcessResult | null>(null);
  const [scan, setScan] = useState<HistoricalScanResult | null>(null);
  const [result, setResult] = useState<HistoricalCommitResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Closing step state ──
  const [years, setYears] = useState<FiscalYearRow[] | null>(null);
  const [yearsLoading, setYearsLoading] = useState(false);
  const [activePeriod, setActivePeriod] = useState<FiscalPeriodRow | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  function reset() {
    setFileName(""); setProcessed(null); setScan(null); setResult(null);
    setYears(null); setActivePeriod(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // ── Template download ──
  function downloadTemplate() {
    if (!entity) return;
    const fields = TEMPLATE_FIELD_NAMES
      .map((n) => entity.fields.find((f) => f.name === n))
      .filter(Boolean) as EntityCatalogItem["fields"];
    const headers = fields.map((f) => f.labelAr);
    // Two illustrative balanced rows of a single entry (#1) so the user sees the
    // "one entry = many lines sharing docNumber" shape.
    const example = [
      { docNumber: "1", entryDate: "2021-01-15", description: "رصيد افتتاحي", currency: "SAR", exchangeRate: 1, branchCode: "", accountCode: "1101", debit: 1000, credit: 0, lineDescription: "نقدية", costCenter: "" },
      { docNumber: "1", entryDate: "2021-01-15", description: "رصيد افتتاحي", currency: "SAR", exchangeRate: 1, branchCode: "", accountCode: "3101", debit: 0, credit: 1000, lineDescription: "رأس المال", costCenter: "" },
    ];
    const aoa = [headers, ...example.map((row) => fields.map((f) => (row as any)[f.name] ?? ""))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "القيود");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "نموذج_الترحيل_التاريخي.xlsx");
  }

  // ── Upload + parse + process (FK resolve) + scan ──
  async function onFile(file: File) {
    if (!entity) { toast({ title: "تعذّر تحميل تعريف القيود", variant: "destructive" }); return; }
    setFileName(file.name);
    setBusy(true);
    setProcessed(null); setScan(null); setResult(null);
    try {
      // 1) Parse the workbook → headers + row objects.
      let parsedHeaders: string[] = [];
      let parsedRows: any[] = [];
      if (file.name.toLowerCase().endsWith(".json")) {
        const json = JSON.parse(await file.text());
        const arr: any[] = Array.isArray(json) ? json : (json?.journalEntries ?? json?.data?.journalEntries ?? []);
        if (arr.length === 0) throw new Error("الملف لا يحتوي على بيانات");
        parsedHeaders = Array.from(arr.reduce<Set<string>>((acc, r) => { if (r && typeof r === "object") Object.keys(r).forEach((k) => acc.add(k)); return acc; }, new Set()));
        parsedRows = arr;
      } else {
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
        if (aoa.length < 2) throw new Error("الملف لا يحتوي على صفوف كافية");
        parsedHeaders = (aoa[0] ?? []).map((h: any, i: number) => (h == null || String(h).trim() === "") ? `عمود ${i + 1}` : String(h).trim());
        parsedRows = aoa.slice(1)
          .filter((r) => r && r.some((c: any) => c != null && String(c).trim() !== ""))
          .map((r) => { const o: any = {}; parsedHeaders.forEach((h, i) => { o[h] = r[i] ?? null; }); return o; });
      }

      // 2) Deterministic mapping: header → field by labelAr or name (no AI dependency).
      const mapping: Record<string, string | null> = {};
      for (const h of parsedHeaders) {
        const f = entity.fields.find((ff) => ff.labelAr === h || ff.name === h || ff.labelEn === h);
        mapping[h] = f ? f.name : null;
      }

      // 3) Process → FK resolution (accountCode→accountId, branchCode→branchId) + normalization.
      const proc = await processImport(token, { companyId: cid, entity: "journalEntries", mapping, rows: parsedRows });
      setProcessed(proc);

      // 4) Scan → per-year preview (no writes).
      const sc = await scanHistorical(token, { companyId: cid, rows: proc.processed });
      setScan(sc);
      toast({ title: `تم فحص ${sc.totals.entries} قيد عبر ${sc.years.length} سنة مالية` });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّرت قراءة الملف", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── Execute migration ──
  async function onMigrate() {
    if (!processed) return;
    setBusy(true);
    try {
      const res = await commitHistorical(token, { companyId: cid, rows: processed.processed, options: { skipErrors: true } });
      setResult(res);
      if (res.aborted) {
        toast({ title: "توقّف الترحيل (الوضع الصارم)", description: res.error, variant: "destructive" });
      } else {
        toast({ title: `تم ترحيل ${res.summary.inserted} سطر — أُنشئت ${res.yearsCreated.length} سنة مالية` });
        loadYears();
      }
    } catch (e: any) {
      toast({ title: e?.message ?? "فشل الترحيل", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── Closing: load fiscal years, then open the existing PeriodClosingWizard ──
  async function loadYears() {
    setYearsLoading(true);
    try {
      const r = await fetch(`${FISCAL_API}/api/fiscal/years`, { headers: authHeaders });
      const data = await r.json().catch(() => []);
      if (!r.ok) throw new Error((data as any)?.error ?? "تعذّر جلب السنوات المالية");
      setYears(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر جلب السنوات المالية", variant: "destructive" });
    } finally {
      setYearsLoading(false);
    }
  }

  async function openClosing(year: FiscalYearRow) {
    setBusy(true);
    try {
      const r = await fetch(`${FISCAL_API}/api/fiscal/years/${year.id}`, { headers: authHeaders });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as any)?.error ?? "تعذّر جلب الفترة");
      const periods: FiscalPeriodRow[] = (data?.periods ?? []);
      const openPeriod = periods.find((p) => p.status === "open") ?? periods[0];
      if (!openPeriod) { toast({ title: "لا توجد فترة لهذه السنة", variant: "destructive" }); return; }
      setActivePeriod(openPeriod);
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر فتح معالج الإقفال", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = (s: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      open: { label: "مفتوحة", cls: "bg-green-50 text-green-700 border-green-200" },
      closed: { label: "مقفلة (ناعم)", cls: "bg-amber-50 text-amber-700 border-amber-200" },
      permanently_closed: { label: "مقفلة نهائياً", cls: "bg-red-50 text-red-700 border-red-200" },
    };
    const m = map[s] ?? { label: s, cls: "bg-slate-50 text-slate-600 border-slate-200" };
    return <Badge variant="outline" className={cn("text-[10px]", m.cls)}>{m.label}</Badge>;
  };

  const procErrors = processed?.stats.errors ?? 0;

  return (
    <div className="space-y-4">
      {/* Intro */}
      <Card className="border-violet-200">
        <CardContent className="p-4 flex items-start gap-3">
          <div className="p-2 rounded-lg bg-violet-100 text-violet-700 flex-shrink-0"><Database className="h-5 w-5" /></div>
          <div className="text-sm space-y-1">
            <h3 className="font-bold text-violet-900">محرك الترحيل التاريخي للقيود</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              لترحيل سنوات سابقة من القيود المحاسبية دفعة واحدة. يستخرج النظام السنة المالية من <strong>تاريخ القيد تلقائياً</strong>،
              يُنشئ السنوات المالية الناقصة (سنة واحدة = فترة سنوية كاملة)، يربط كل قيد بفترته، ويُرحّله <strong>مُرحَّلاً (posted)</strong> ليظهر في التقارير فوراً.
              ثم يمكنك تشغيل دورة الإقفال السنوي لكل سنة من القسم الأخير.
            </p>
            <p className="text-[11px] text-amber-700 flex items-center gap-1 mt-1">
              <Info className="h-3 w-3" />
              ملاحظة: لا يدعم هذا النموذج أعمدة العميل/المورد لأن سطور القيد لا تحتوي حقولاً لهما — استخدم الحساب ومركز التكلفة.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Step 1: template + upload */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">1</div>
            <h3 className="font-semibold text-sm">تحميل النموذج ورفع الملف</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={downloadTemplate} className="gap-1">
              <FileSpreadsheet className="h-4 w-4" /> تنزيل نموذج Excel
            </Button>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls,.json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy} className="gap-1">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} رفع ملف القيود
            </Button>
            {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
            {(processed || scan || result) && (
              <Button size="sm" variant="ghost" onClick={reset} className="gap-1 ml-auto text-muted-foreground">
                <X className="h-4 w-4" /> إعادة تعيين
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step 2: scan preview */}
      {scan && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">2</div>
              <h3 className="font-semibold text-sm">معاينة الترحيل</h3>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="عدد القيود" value={scan.totals.entries} icon={<Database className="h-4 w-4" />} />
              <Stat label="عدد السطور" value={scan.totals.lines} icon={<FileSpreadsheet className="h-4 w-4" />} />
              <Stat label="سنوات ستُنشأ" value={scan.yearsToCreate.length} icon={<CalendarPlus className="h-4 w-4" />} tone="info" />
              <Stat label="غير متوازنة" value={scan.totals.unbalanced} icon={<AlertTriangle className="h-4 w-4" />} tone={scan.totals.unbalanced > 0 ? "error" : "muted"} />
            </div>

            {(scan.totals.unbalanced > 0 || procErrors > 0 || scan.totals.orphans > 0) && (
              <div className="rounded-md p-3 bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                <div className="font-semibold flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> تنبيهات قبل الترحيل</div>
                <ul className="list-disc pr-5 space-y-0.5">
                  {scan.totals.unbalanced > 0 && <li>{scan.totals.unbalanced} قيد غير متوازن سيُتخطّى (المدين ≠ الدائن).</li>}
                  {procErrors > 0 && <li>{procErrors} صف به خطأ في المعالجة (حساب غير معروف مثلاً) سيُتخطّى.</li>}
                  {scan.totals.orphans > 0 && <li>{scan.totals.orphans} صف بدون رقم قيد أو تاريخ صالح سيُتخطّى.</li>}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2 font-semibold">السنة</th>
                    <th className="p-2 font-semibold">قيود</th>
                    <th className="p-2 font-semibold">سطور</th>
                    <th className="p-2 font-semibold">إجمالي مدين</th>
                    <th className="p-2 font-semibold">إجمالي دائن</th>
                    <th className="p-2 font-semibold">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.years.map((y) => (
                    <tr key={y.year} className="border-t">
                      <td className="p-2 font-bold">{y.year}</td>
                      <td className="p-2">{y.entries}</td>
                      <td className="p-2">{y.lines}</td>
                      <td className="p-2" dir="ltr">{fmt(y.totalDebit)}</td>
                      <td className="p-2" dir="ltr">{fmt(y.totalCredit)}</td>
                      <td className="p-2">
                        {y.exists
                          ? <Badge variant="outline" className="text-[10px] bg-slate-50 text-slate-600 border-slate-200">سنة موجودة</Badge>
                          : <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">ستُنشأ</Badge>}
                        {y.unbalanced > 0 && <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 mr-1">{y.unbalanced} غير متوازن</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!result && (
              <Button onClick={onMigrate} disabled={busy || scan.totals.entries === 0} className="gap-1 bg-gradient-to-l from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} تنفيذ الترحيل
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: result */}
      {result && !result.aborted && (
        <Card className="border-green-200">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold">3</div>
              <h3 className="font-semibold text-sm">نتيجة الترحيل</h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="مُرحّلة" value={result.summary.inserted} icon={<CheckCircle2 className="h-4 w-4" />} tone="info" />
              <Stat label="متخطّاة" value={result.summary.skipped} icon={<AlertTriangle className="h-4 w-4" />} tone="warning" />
              <Stat label="أخطاء" value={result.summary.errors} icon={<X className="h-4 w-4" />} tone={result.summary.errors > 0 ? "error" : "muted"} />
              <Stat label="سنوات أُنشئت" value={result.yearsCreated.length} icon={<CalendarCheck className="h-4 w-4" />} tone="info" />
            </div>
            {result.yearsCreated.length > 0 && (
              <p className="text-xs text-muted-foreground">السنوات المالية المُنشأة: <strong dir="ltr">{result.yearsCreated.join(", ")}</strong></p>
            )}
            {result.summary.skipped > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">عرض الصفوف المتخطّاة ({result.summary.skipped})</summary>
                <ul className="list-disc pr-5 mt-1 space-y-0.5 max-h-48 overflow-y-auto">
                  {result.log.filter((l) => l.status !== "inserted").slice(0, 200).map((l, i) => (
                    <li key={i}>صف {l.rowIndex + 1}: {l.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 4: year-end closing (reuses the existing PeriodClosingWizard) */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs font-bold"><Lock className="h-3.5 w-3.5" /></div>
            <h3 className="font-semibold text-sm">الإقفال السنوي للسنوات المُرحّلة</h3>
            <Button size="sm" variant="outline" onClick={loadYears} disabled={yearsLoading} className="ml-auto h-7 text-xs gap-1">
              {yearsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarCheck className="h-3 w-3" />} تحديث السنوات
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            بعد الترحيل، أقفل كل سنة على حدة بالترتيب من الأقدم للأحدث. يفتح معالج الإقفال القياسي: إقفال الإيرادات/المصروفات → ترحيل الأرباح للأرباح المحتجزة → إقفال ناعم → إقفال نهائي.
          </p>
          {years == null ? (
            <p className="text-xs text-muted-foreground">اضغط «تحديث السنوات» لعرض السنوات المالية.</p>
          ) : years.length === 0 ? (
            <p className="text-xs text-muted-foreground">لا توجد سنوات مالية بعد.</p>
          ) : (
            <div className="space-y-1.5">
              {years.map((y) => (
                <div key={y.id} className="flex items-center justify-between gap-2 rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{y.name}</span>
                    <span className="text-[11px] text-muted-foreground" dir="ltr">{y.startDate} → {y.endDate}</span>
                    {statusBadge(y.status)}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => openClosing(y)} disabled={busy} className="h-8 text-xs gap-1">
                    <Lock className="h-3 w-3" /> معالج الإقفال
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {activePeriod && (
        <PeriodClosingWizard
          period={activePeriod}
          onClose={() => setActivePeriod(null)}
          onPeriodUpdated={() => { setActivePeriod(null); loadYears(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, icon, tone = "default" }: { label: string; value: number | string; icon: ReactNode; tone?: "default" | "info" | "warning" | "error" | "muted" }) {
  const tones: Record<string, string> = {
    default: "bg-card border",
    info: "bg-blue-50 border-blue-200 text-blue-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    error: "bg-red-50 border-red-200 text-red-800",
    muted: "bg-muted/40 border text-muted-foreground",
  };
  return (
    <div className={cn("rounded-lg p-3 flex items-center gap-2", tones[tone])}>
      <div className="opacity-70">{icon}</div>
      <div>
        <div className="text-lg font-bold leading-none">{value}</div>
        <div className="text-[10px] opacity-80 mt-0.5">{label}</div>
      </div>
    </div>
  );
}
