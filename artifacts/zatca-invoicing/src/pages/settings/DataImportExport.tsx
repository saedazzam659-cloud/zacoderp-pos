import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Database, Upload, Download, FileSpreadsheet, FileJson, Sparkles, AlertTriangle,
  CheckCircle2, X, Eye, ArrowLeft, ArrowRight, Loader2, FileDown,
} from "lucide-react";
import {
  fetchEntities, exportData, analyzeImport, processImport, commitImport, downloadBlob,
  type EntityCatalogItem, type AnalyzeResult, type ProcessResult, type CommitResult, type RowIssue,
} from "@/lib/dataIoApi";

type Step = "upload" | "analyze" | "review" | "result";

export default function DataImportExport() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const cid: number | undefined = user?.company?.id ?? user?.companyId ?? undefined;

  const { data: entities = [], isLoading: entitiesLoading } = useQuery({
    queryKey: ["data-io-entities"],
    queryFn: () => fetchEntities(token),
    enabled: !!token,
  });

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6" dir="rtl">
      <header className="flex items-center gap-3">
        <Database className="w-7 h-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">مركز استيراد وتصدير البيانات</h1>
          <p className="text-sm text-muted-foreground">تصدير أو استيراد بيانات النظام بأي صيغة، مع تحليل ذكي للأعمدة وحلّ المشاكل تلقائيًا.</p>
        </div>
      </header>

      <Tabs defaultValue="export" dir="rtl">
        <TabsList className="grid grid-cols-2 max-w-md">
          <TabsTrigger value="export"><Download className="w-4 h-4 ml-2" /> تصدير</TabsTrigger>
          <TabsTrigger value="import"><Upload className="w-4 h-4 ml-2" /> استيراد</TabsTrigger>
        </TabsList>

        <TabsContent value="export" className="mt-4">
          <ExportPanel entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} />
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <ImportWizard entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT PANEL
// ════════════════════════════════════════════════════════════════════════════

function ExportPanel({ entities, loading, cid, token, toast }: {
  entities: EntityCatalogItem[]; loading: boolean; cid?: number; token: string | null; toast: any;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"json" | "xlsx">("xlsx");
  const [busy, setBusy] = useState(false);

  // Default = all on first load
  useEffect(() => {
    if (entities.length && selected.size === 0) {
      setSelected(new Set(entities.map((e) => e.key)));
    }
  }, [entities]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const selectAll = () => setSelected(new Set(entities.map((e) => e.key)));
  const selectNone = () => setSelected(new Set());

  const onExport = async () => {
    if (!cid) { toast({ title: "لا يوجد معرّف شركة", variant: "destructive" }); return; }
    if (selected.size === 0) { toast({ title: "اختر جدولاً واحدًا على الأقل", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const blob = await exportData(token, { companyId: cid, types: Array.from(selected), format });
      const ext = format === "json" ? "json" : "xlsx";
      downloadBlob(blob, `data-export-${new Date().toISOString().slice(0, 10)}.${ext}`);
      toast({ title: "✓ تم تنزيل ملف التصدير" });
    } catch (e: any) {
      toast({ title: e.message ?? "فشل التصدير", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">اختر البيانات المراد تصديرها</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={selectAll} disabled={loading}>تحديد الكل</Button>
          <Button variant="outline" size="sm" onClick={selectNone} disabled={loading}>إلغاء التحديد</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {loading && <div className="col-span-full text-center text-muted-foreground py-6">جاري التحميل…</div>}
        {entities.map((e) => (
          <label
            key={e.key}
            className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
              selected.has(e.key) ? "bg-primary/5 border-primary" : "hover:bg-muted/40"
            }`}
          >
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={selected.has(e.key)}
              onChange={() => toggle(e.key)}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{e.labelAr}</div>
              <div className="text-xs text-muted-foreground truncate">{e.labelEn}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">الصيغة:</span>
          <button
            onClick={() => setFormat("xlsx")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${format === "xlsx" ? "bg-primary text-primary-foreground border-primary" : ""}`}
          >
            <FileSpreadsheet className="w-4 h-4" /> Excel
          </button>
          <button
            onClick={() => setFormat("json")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${format === "json" ? "bg-primary text-primary-foreground border-primary" : ""}`}
          >
            <FileJson className="w-4 h-4" /> JSON
          </button>
        </div>
        <Button onClick={onExport} disabled={busy || selected.size === 0}>
          {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Download className="w-4 h-4 ml-2" />}
          تنزيل ({selected.size} جدول)
        </Button>
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// IMPORT WIZARD
// ════════════════════════════════════════════════════════════════════════════

function ImportWizard({ entities, loading, cid, token, toast }: {
  entities: EntityCatalogItem[]; loading: boolean; cid?: number; token: string | null; toast: any;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [entityKey, setEntityKey] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [processed, setProcessed] = useState<ProcessResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const entity = entities.find((e) => e.key === entityKey);

  function reset() {
    setStep("upload"); setFileName(""); setHeaders([]); setRows([]);
    setAnalysis(null); setMapping({}); setProcessed(null); setCommitResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(file: File) {
    if (!entityKey) { toast({ title: "اختر نوع البيانات أولاً", variant: "destructive" }); return; }
    setFileName(file.name);
    setBusy(true);
    try {
      const isJson = file.name.toLowerCase().endsWith(".json");
      let parsedHeaders: string[] = [];
      let parsedRows: any[] = [];
      if (isJson) {
        const text = await file.text();
        const json = JSON.parse(text);
        // Support either { data: { entityKey: [...] } } or a direct array
        let arr: any[] = [];
        if (Array.isArray(json)) arr = json;
        else if (json && Array.isArray(json[entityKey])) arr = json[entityKey];
        else if (json?.data && Array.isArray(json.data[entityKey])) arr = json.data[entityKey];
        else if (json?.data && typeof json.data === "object") {
          // best-effort: pick the first array
          const first = Object.values(json.data).find((v) => Array.isArray(v)) as any[] | undefined;
          arr = first ?? [];
        }
        if (arr.length === 0) throw new Error("الملف لا يحتوي على بيانات قابلة للقراءة");
        parsedHeaders = Array.from(arr.reduce<Set<string>>((acc, r) => { if (r && typeof r === "object") Object.keys(r).forEach((k) => acc.add(k)); return acc; }, new Set()));
        parsedRows = arr;
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
        if (aoa.length < 2) throw new Error("الملف لا يحتوي على بيانات كافية");
        parsedHeaders = (aoa[0] ?? []).map((h: any, i: number) => (h == null || String(h).trim() === "") ? `العمود ${i + 1}` : String(h).trim());
        parsedRows = aoa.slice(1).filter((r) => r && r.some((c: any) => c != null && String(c).trim() !== "")).map((r) => {
          const o: any = {};
          parsedHeaders.forEach((h, i) => { o[h] = r[i] ?? null; });
          return o;
        });
      }
      setHeaders(parsedHeaders);
      setRows(parsedRows);

      // Auto-trigger AI analysis
      const result = await analyzeImport(token, { entity: entityKey, headers: parsedHeaders, sampleRows: parsedRows.slice(0, 8) });
      setAnalysis(result);
      const initialMap: Record<string, string | null> = {};
      for (const [src, m] of Object.entries(result.mapping)) initialMap[src] = m.field;
      setMapping(initialMap);
      setStep("analyze");
      toast({ title: `✓ تم تحليل ${parsedRows.length} صف`, description: result.source === "ai" ? "تم استخدام الذكاء الاصطناعي" : "تم استخدام مطابقة تلقائية احتياطية" });
    } catch (e: any) {
      toast({ title: e?.message ?? "فشلت قراءة الملف", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function onProcess() {
    setBusy(true);
    try {
      const result = await processImport(token, { companyId: cid, entity: entityKey, mapping, rows });
      setProcessed(result);
      setStep("review");
    } catch (e: any) {
      toast({ title: e?.message ?? "فشلت المعالجة", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function onCommit() {
    if (!processed) return;
    setBusy(true);
    try {
      const result = await commitImport(token, { companyId: cid, entity: entityKey, rows: processed.processed, options: { skipErrors: true } });
      setCommitResult(result);
      setStep("result");
      toast({ title: `✓ تم: ${result.summary.inserted} جديد، ${result.summary.updated} محدّث، ${result.summary.skipped} متجاوَز` });
    } catch (e: any) {
      toast({ title: e?.message ?? "فشل التنفيذ", variant: "destructive" });
    } finally { setBusy(false); }
  }

  function downloadReport() {
    if (!commitResult || !processed) return;
    const wb = XLSX.utils.book_new();
    // Sheet 1: summary
    const sum = commitResult.summary;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["نوع البيانات", entity?.labelAr ?? entityKey],
      ["تاريخ التنفيذ", commitResult.committedAt],
      [],
      ["الإجمالي", sum.total],
      ["مُدرج", sum.inserted],
      ["مُحدَّث", sum.updated],
      ["متجاوَز", sum.skipped],
      ["أخطاء", sum.errors],
    ]), "ملخص");
    // Sheet 2: per-row log
    const logRows = commitResult.log.map((l) => ({
      "صف الملف": l.rowIndex + 1,
      "الحالة": l.status === "inserted" ? "مُدرج" : l.status === "updated" ? "مُحدَّث" : l.status === "skipped" ? "متجاوَز" : "خطأ",
      "المعرّف": l.id ?? "",
      "السبب/الملاحظة": l.reason ?? "",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows), "سجل التنفيذ");
    // Sheet 3: issues
    const issueRows = processed.issues.map((i) => ({
      "صف الملف": i.rowIndex + 1, "الحقل": i.field ?? "", "النوع": i.type, "الخطورة": i.severity,
      "قبل": String(i.before ?? ""), "بعد": String(i.after ?? ""), "الإجراء": i.action,
      "الثقة": Math.round(i.confidence * 100) + "%", "الرسالة": i.message,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows), "المشاكل");
    XLSX.writeFile(wb, `import-report-${entityKey}-${Date.now()}.xlsx`);
  }

  // Stepper UI
  const StepBadge = ({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) => (
    <div className={`flex items-center gap-2 ${active ? "text-primary font-semibold" : done ? "text-green-600" : "text-muted-foreground"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${
        done ? "bg-green-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted"
      }`}>{done ? "✓" : n}</div>
      <span className="text-sm">{label}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4 justify-between">
          <div className="flex items-center gap-4">
            <StepBadge n={1} label="رفع الملف" active={step === "upload"} done={step !== "upload"} />
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={2} label="ربط الأعمدة" active={step === "analyze"} done={["review", "result"].includes(step)} />
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={3} label="مراجعة" active={step === "review"} done={step === "result"} />
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={4} label="النتيجة" active={step === "result"} done={false} />
          </div>
          {step !== "upload" && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="w-4 h-4 ml-1" /> بدء من جديد
            </Button>
          )}
        </div>
      </Card>

      {step === "upload" && (
        <Card className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">اختر نوع البيانات</label>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {entities.map((e) => (
                <button
                  key={e.key}
                  onClick={() => setEntityKey(e.key)}
                  className={`p-3 border rounded-lg text-right transition-colors ${
                    entityKey === e.key ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium">{e.labelAr}</div>
                  <div className="text-xs opacity-75">{e.labelEn}</div>
                </button>
              ))}
            </div>
          </div>

          <div className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${entityKey ? "hover:border-primary cursor-pointer" : "opacity-50"}`}
               onClick={() => entityKey && fileRef.current?.click()}>
            <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <div className="font-medium">{busy ? "جاري التحليل…" : "اسحب ملفًا هنا أو انقر للاختيار"}</div>
            <div className="text-xs text-muted-foreground mt-1">يدعم: Excel (.xlsx, .xls) — CSV (.csv) — JSON</div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              disabled={busy || !entityKey}
            />
          </div>

          {entity && (
            <div className="bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg text-sm">
              <div className="font-medium mb-1">حقول جدول {entity.labelAr}:</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {entity.fields.map((f, i) => (
                  <span key={f.name}>
                    {f.labelAr}{f.required && <span className="text-red-600">*</span>}
                    {i < entity.fields.length - 1 && " • "}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {step === "analyze" && analysis && entity && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              ربط أعمدة الملف بحقول النظام
            </h3>
            <div className="flex gap-3 text-sm text-muted-foreground">
              <span>{fileName}</span>
              <Badge variant="outline">{rows.length} صف</Badge>
              <Badge variant="outline">{analysis.source === "ai" ? "ذكاء اصطناعي" : "مطابقة احتياطية"}</Badge>
            </div>
          </div>
          {analysis.missingRequired.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 p-3 rounded-lg text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200 mb-1">
                <AlertTriangle className="w-4 h-4" /> حقول مطلوبة لم يتم اكتشافها
              </div>
              <div className="text-amber-700 dark:text-amber-300">
                {analysis.missingRequired.map((m) => m.labelAr).join("، ")}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                اربط هذه الحقول يدويًا أدناه قبل المتابعة، أو سيتم تجاوز الصفوف الناقصة.
              </div>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="p-2 text-right">عمود الملف</th>
                  <th className="p-2 text-right">حقل النظام</th>
                  <th className="p-2 text-right">ثقة</th>
                  <th className="p-2 text-right">عينة</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h} className="border-t">
                    <td className="p-2 font-medium">{h}</td>
                    <td className="p-2">
                      <select
                        className="w-full px-2 py-1 border rounded bg-background"
                        value={mapping[h] ?? ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value || null }))}
                      >
                        <option value="">— تجاهل —</option>
                        {entity.fields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.labelAr} {f.required ? "*" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-muted-foreground text-xs">
                      {Math.round((analysis.mapping[h]?.confidence ?? 0) * 100)}%
                    </td>
                    <td className="p-2 text-muted-foreground text-xs max-w-[280px] truncate">
                      {String(rows[0]?.[h] ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button variant="outline" onClick={() => setStep("upload")}>
              <ArrowRight className="w-4 h-4 ml-2" /> رجوع
            </Button>
            <Button onClick={onProcess} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Eye className="w-4 h-4 ml-2" />}
              معالجة وعرض المشاكل
            </Button>
          </div>
        </Card>
      )}

      {step === "review" && processed && (
        <ReviewPanel processed={processed} entity={entity} setProcessed={setProcessed} onCommit={onCommit} onBack={() => setStep("analyze")} busy={busy} />
      )}

      {step === "result" && commitResult && (
        <ResultPanel result={commitResult} onDownload={downloadReport} onReset={reset} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// REVIEW PANEL
// ════════════════════════════════════════════════════════════════════════════

function ReviewPanel({ processed, entity, setProcessed, onCommit, onBack, busy }: {
  processed: ProcessResult; entity: EntityCatalogItem | undefined; setProcessed: (r: ProcessResult) => void;
  onCommit: () => void; onBack: () => void; busy: boolean;
}) {
  const [filter, setFilter] = useState<"all" | "errors" | "warnings" | "info" | "duplicates">("all");
  const issuesByRow = useMemo(() => {
    const m = new Map<number, RowIssue[]>();
    for (const i of processed.issues) {
      if (!m.has(i.rowIndex)) m.set(i.rowIndex, []);
      m.get(i.rowIndex)!.push(i);
    }
    return m;
  }, [processed.issues]);

  const filteredRows = processed.processed.filter((r) => {
    if (filter === "all") return true;
    const list = issuesByRow.get(r.__rowIndex) ?? [];
    if (filter === "errors")     return list.some((i) => i.severity === "error");
    if (filter === "warnings")   return list.some((i) => i.severity === "warning");
    if (filter === "info")       return list.some((i) => i.severity === "info");
    if (filter === "duplicates") return list.some((i) => i.type === "duplicate");
    return true;
  });

  function updateCell(rowIndex: number, field: string, value: any) {
    const next = { ...processed };
    next.processed = next.processed.map((r) => r.__rowIndex === rowIndex ? { ...r, [field]: value } : r);
    setProcessed(next);
  }

  const cols = entity?.fields.filter((f) => processed.processed.some((r) => f.name in r)) ?? [];

  return (
    <div className="space-y-4">
      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="إجمالي" value={processed.stats.total} icon={<Database />} />
        <StatCard label="أخطاء" value={processed.stats.errors} icon={<X />} tone="error" onClick={() => setFilter("errors")} active={filter === "errors"} />
        <StatCard label="تحذيرات" value={processed.stats.warnings} icon={<AlertTriangle />} tone="warning" onClick={() => setFilter("warnings")} active={filter === "warnings"} />
        <StatCard label="إصلاحات" value={processed.stats.info} icon={<Sparkles />} tone="info" onClick={() => setFilter("info")} active={filter === "info"} />
        <StatCard label="مكررات" value={processed.stats.duplicates} icon={<CheckCircle2 />} tone="muted" onClick={() => setFilter("duplicates")} active={filter === "duplicates"} />
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h3 className="font-semibold">معاينة قبل التنفيذ</h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">عرض:</span>
            <select className="px-2 py-1 text-sm border rounded bg-background" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
              <option value="all">الكل ({processed.processed.length})</option>
              <option value="errors">أخطاء فقط</option>
              <option value="warnings">تحذيرات فقط</option>
              <option value="info">إصلاحات فقط</option>
              <option value="duplicates">مكررات فقط</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded border max-h-[500px]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className="p-2 text-right w-10">#</th>
                <th className="p-2 text-right w-24">الحالة</th>
                {cols.map((c) => <th key={c.name} className="p-2 text-right whitespace-nowrap">{c.labelAr}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 200).map((r) => {
                const list = issuesByRow.get(r.__rowIndex) ?? [];
                const hasError = list.some((i) => i.severity === "error");
                const hasWarn  = list.some((i) => i.severity === "warning");
                return (
                  <tr key={r.__rowIndex} className={`border-t ${hasError ? "bg-red-50 dark:bg-red-950/30" : hasWarn ? "bg-amber-50 dark:bg-amber-950/20" : ""}`}>
                    <td className="p-2 text-xs text-muted-foreground">{r.__rowIndex + 1}</td>
                    <td className="p-2">
                      {hasError ? <Badge variant="destructive">خطأ</Badge>
                        : hasWarn ? <Badge className="bg-amber-500">تحذير</Badge>
                        : list.length ? <Badge variant="secondary">إصلاح</Badge>
                        : <Badge variant="outline">جاهز</Badge>}
                    </td>
                    {cols.map((c) => {
                      const issue = list.find((i) => i.field === c.name);
                      return (
                        <td key={c.name} className={`p-1 ${issue ? "border-r-2 border-amber-400" : ""}`}>
                          <Input
                            className="h-7 text-xs"
                            value={r[c.name] ?? ""}
                            onChange={(e) => updateCell(r.__rowIndex, c.name, e.target.value)}
                            title={issue?.message}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length > 200 && (
            <div className="p-3 text-center text-xs text-muted-foreground bg-muted/20">
              يتم عرض أول 200 صف فقط — التنفيذ سيعالج جميع الصفوف ({filteredRows.length})
            </div>
          )}
        </div>
      </Card>

      {/* issues detail */}
      {processed.issues.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">تقرير المشاكل والإصلاحات</h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className="p-2 text-right">صف</th>
                  <th className="p-2 text-right">الحقل</th>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">قبل</th>
                  <th className="p-2 text-right">بعد</th>
                  <th className="p-2 text-right">الإجراء</th>
                  <th className="p-2 text-right">الثقة</th>
                </tr>
              </thead>
              <tbody>
                {processed.issues.slice(0, 300).map((i, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{i.rowIndex + 1}</td>
                    <td className="p-2">{i.field ?? "—"}</td>
                    <td className="p-2">
                      <Badge variant={i.severity === "error" ? "destructive" : i.severity === "warning" ? "secondary" : "outline"} className="text-[10px]">
                        {i.message}
                      </Badge>
                    </td>
                    <td className="p-2 text-muted-foreground max-w-[140px] truncate">{String(i.before ?? "")}</td>
                    <td className="p-2 max-w-[140px] truncate">{String(i.after ?? "")}</td>
                    <td className="p-2">{i.action}</td>
                    <td className="p-2">{Math.round(i.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex justify-between items-center">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          <ArrowRight className="w-4 h-4 ml-2" /> رجوع للربط
        </Button>
        <Button onClick={onCommit} disabled={busy} size="lg">
          {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 ml-2" />}
          تأكيد وتنفيذ الاستيراد
        </Button>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, tone = "default", onClick, active }: {
  label: string; value: number; icon: React.ReactNode;
  tone?: "default" | "error" | "warning" | "info" | "muted"; onClick?: () => void; active?: boolean;
}) {
  const toneCls =
    tone === "error" ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900"
    : tone === "warning" ? "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900"
    : tone === "info" ? "bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900"
    : tone === "muted" ? "bg-muted/30"
    : "bg-card";
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className={`p-3 border rounded-lg text-right transition-all ${toneCls} ${active ? "ring-2 ring-primary" : ""} ${onClick ? "cursor-pointer hover:shadow" : "cursor-default"}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs">{label}</span>
        <span className="opacity-50">{icon}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RESULT PANEL
// ════════════════════════════════════════════════════════════════════════════

function ResultPanel({ result, onDownload, onReset }: { result: CommitResult; onDownload: () => void; onReset: () => void }) {
  const s = result.summary;
  return (
    <div className="space-y-4">
      <Card className="p-6 text-center bg-gradient-to-b from-green-50 to-card dark:from-green-950/40">
        <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-2" />
        <h3 className="text-xl font-semibold mb-1">تم الاستيراد</h3>
        <p className="text-sm text-muted-foreground">{new Date(result.committedAt).toLocaleString("ar-SA")}</p>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="إجمالي" value={s.total} icon={<Database />} />
        <StatCard label="مُدرج" value={s.inserted} icon={<CheckCircle2 />} tone="info" />
        <StatCard label="مُحدَّث" value={s.updated} icon={<Sparkles />} tone="info" />
        <StatCard label="متجاوَز" value={s.skipped} icon={<AlertTriangle />} tone="warning" />
        <StatCard label="أخطاء" value={s.errors} icon={<X />} tone="error" />
      </div>

      {result.log.some((l) => l.status === "skipped" || l.status === "error") && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" /> الصفوف غير المُنفّذة
          </h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className="p-2 text-right">صف</th>
                  <th className="p-2 text-right">الحالة</th>
                  <th className="p-2 text-right">السبب</th>
                </tr>
              </thead>
              <tbody>
                {result.log.filter((l) => l.status !== "inserted" && l.status !== "updated").map((l, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{l.rowIndex + 1}</td>
                    <td className="p-2">
                      <Badge variant={l.status === "error" ? "destructive" : "secondary"}>{l.status === "skipped" ? "متجاوَز" : "خطأ"}</Badge>
                    </td>
                    <td className="p-2">{l.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex justify-between items-center">
        <Button variant="outline" onClick={onReset}>استيراد ملف آخر</Button>
        <Button onClick={onDownload}>
          <FileDown className="w-4 h-4 ml-2" /> تنزيل تقرير الاستيراد (Excel)
        </Button>
      </div>
    </div>
  );
}
