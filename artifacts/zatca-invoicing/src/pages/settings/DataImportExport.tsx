import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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

function entityLabel(e: EntityCatalogItem | undefined, isAr: boolean): string {
  if (!e) return "";
  return isAr ? (e.labelAr ?? e.labelEn ?? e.key) : (e.labelEn ?? e.labelAr ?? e.key);
}
function fieldLabel(f: { labelAr?: string; labelEn?: string; name: string }, isAr: boolean): string {
  return isAr ? (f.labelAr ?? f.labelEn ?? f.name) : (f.labelEn ?? f.labelAr ?? f.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nested-bundle adapters
// ─────────────────────────────────────────────────────────────────────────────
// Real-world Saudi/Arabic ERPs (e.g. exports labelled "exported_data") often
// ship a single multi-table JSON bundle keyed by their internal table names
// (AccountingEntry, AccountingEntryDetailes, Account, Currency, Branch, …)
// instead of the flat `journalEntries: [...]` shape our importer expects.
//
// `adaptNestedBundle` recognises those bundles and flattens them into the
// canonical row shape for the chosen entity. Only journalEntries is supported
// for now; add more branches as we encounter additional real-world exports.
//
// Returns `null` when the bundle is not recognised → caller falls back to the
// existing direct/loose shape detection.
function adaptNestedBundle(json: any, entityKey: string): any[] | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  if (entityKey === "journalEntries"
      && Array.isArray(json.AccountingEntry)
      && Array.isArray(json.AccountingEntryDetailes)) {
    // ── Defensive: support tables may be present as non-array shapes (e.g.
    //    a single object or null sentinel). Coerce to [] before iterating so
    //    the adapter never throws "X is not iterable" on adversarial input.
    const liveOf = (v: any): any[] => Array.isArray(v) ? v : [];

    // Build lookup maps from the supporting tables.
    const accountById = new Map<number, string>();
    for (const a of liveOf(json.Account)) {
      if (a?.IsDeleted) continue;
      if (a?.AccountID != null && a?.code != null) {
        accountById.set(Number(a.AccountID), String(a.code));
      }
    }
    const branchById = new Map<number, string>();
    for (const b of liveOf(json.Branch)) {
      if (b?.IsDeleted) continue;
      if (b?.branch_id != null && b?.code != null) {
        branchById.set(Number(b.branch_id), String(b.code));
      }
    }
    const currencyById = new Map<number, { code: string; basic: boolean }>();
    for (const c of liveOf(json.Currency)) {
      if (c?.IsDeleted) continue;
      if (c?.currence_id != null) {
        currencyById.set(Number(c.currence_id), {
          code: String(c.code ?? ""),
          basic: !!c.basic_currency,
        });
      }
    }
    const headerById = new Map<number, any>();
    for (const h of json.AccountingEntry) {
      if (h?.IsDeleted) continue;
      if (h?.AccountingEntryID != null) {
        headerById.set(Number(h.AccountingEntryID), h);
      }
    }

    // ── Disambiguate docNumber: the backend importer groups lines by
    //    docNumber alone, so two different AccountingEntryIDs that happen to
    //    share the same SerialNumberValue would otherwise be merged into one
    //    journal entry (silent corruption). Pre-scan serials and force the
    //    AE-<id> form for any serial that isn't unique across live headers.
    const serialCounts = new Map<string, number>();
    for (const h of headerById.values()) {
      const raw = h?.SerialNumberValue;
      if (raw != null && String(raw).trim() !== "") {
        const s = String(raw).trim();
        serialCounts.set(s, (serialCounts.get(s) ?? 0) + 1);
      }
    }
    const docNumberFor = (h: any): string => {
      const raw = h?.SerialNumberValue;
      const s = raw != null ? String(raw).trim() : "";
      if (!s || (serialCounts.get(s) ?? 0) > 1) return `AE-${h.AccountingEntryID}`;
      return s;
    };

    const out: any[] = [];
    for (const ln of json.AccountingEntryDetailes) {
      if (ln?.IsDeleted) continue;
      if (ln?.AccountingEntryID == null) continue;
      const h = headerById.get(Number(ln.AccountingEntryID));
      if (!h) continue; // orphan or soft-deleted header
      const accCode = ln.AccountID != null ? accountById.get(Number(ln.AccountID)) : undefined;
      if (!accCode) continue; // can't post a line without a known account code

      const cur = h.CurrencyID != null ? currencyById.get(Number(h.CurrencyID)) : null;
      // The source's basic_currency row represents SAR in 99% of Saudi data
      // dumps regardless of its `code` field (often "1"). Preserve non-basic
      // currency codes verbatim so multi-currency entries still resolve.
      const currency = cur ? (cur.basic ? "SAR" : (cur.code || "SAR")) : "SAR";
      const branchCode = h.branch_id != null ? (branchById.get(Number(h.branch_id)) ?? null) : null;
      const dateStr = h.Date ? String(h.Date).slice(0, 10) : null;

      out.push({
        docNumber: docNumberFor(h),
        entryDate: dateStr,
        description: h.Description ?? null,
        currency,
        exchangeRate: h.ExchangeRate ?? 1,
        entryType: "general",
        branchCode,
        status: "draft",
        accountCode: accCode,
        debit: ln.DR ?? 0,
        credit: ln.CR ?? 0,
        lineDescription: ln.Description ?? null,
        costCenter: null,
      });
    }
    return out;
  }

  return null;
}

export default function DataImportExport() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const cid: number | undefined = user?.company?.id ?? user?.companyId ?? undefined;

  const { data: entities = [], isLoading: entitiesLoading } = useQuery({
    queryKey: ["data-io-entities"],
    queryFn: () => fetchEntities(token),
    enabled: !!token,
  });

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6" dir={isAr ? "rtl" : "ltr"}>
      <header className="flex items-center gap-3">
        <Database className="w-7 h-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{t("dataIO.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dataIO.subtitle")}</p>
        </div>
      </header>

      <Tabs defaultValue="export" dir={isAr ? "rtl" : "ltr"}>
        <TabsList className="grid grid-cols-2 max-w-md">
          <TabsTrigger value="export"><Download className="w-4 h-4 ml-2" /> {t("dataIO.tabExport")}</TabsTrigger>
          <TabsTrigger value="import"><Upload className="w-4 h-4 ml-2" /> {t("dataIO.tabImport")}</TabsTrigger>
        </TabsList>

        <TabsContent value="export" className="mt-4">
          <ExportPanel entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} />
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <ImportWizard entities={entities} loading={entitiesLoading} cid={cid} token={token} toast={toast} isAr={isAr} />
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
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"json" | "xlsx">("xlsx");
  const [busy, setBusy] = useState(false);

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
    if (!cid) { toast({ title: t("dataIO.noCompany"), variant: "destructive" }); return; }
    if (selected.size === 0) { toast({ title: t("dataIO.selectAtLeastOne"), variant: "destructive" }); return; }
    setBusy(true);
    try {
      const blob = await exportData(token, { companyId: cid, types: Array.from(selected), format });
      const ext = format === "json" ? "json" : "xlsx";
      downloadBlob(blob, `data-export-${new Date().toISOString().slice(0, 10)}.${ext}`);
      toast({ title: t("dataIO.downloadSuccess") });
    } catch (e: any) {
      toast({ title: e.message ?? t("dataIO.exportFailed"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("dataIO.exportChooseTitle")}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={selectAll} disabled={loading}>{t("dataIO.selectAll")}</Button>
          <Button variant="outline" size="sm" onClick={selectNone} disabled={loading}>{t("dataIO.selectNone")}</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {loading && <div className="col-span-full text-center text-muted-foreground py-6">{t("dataIO.loading")}</div>}
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
              <div className="font-medium truncate">{entityLabel(e, isAr)}</div>
              <div className="text-xs text-muted-foreground truncate">{isAr ? (e.labelEn ?? "") : (e.labelAr ?? "")}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{t("dataIO.formatLabel")}</span>
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
          {t("dataIO.downloadCount", { count: selected.size })}
        </Button>
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// IMPORT WIZARD
// ════════════════════════════════════════════════════════════════════════════

function ImportWizard({ entities, loading, cid, token, toast, isAr }: {
  entities: EntityCatalogItem[]; loading: boolean; cid?: number; token: string | null; toast: any; isAr: boolean;
}) {
  const { t } = useTranslation();
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
    if (!entityKey) { toast({ title: t("dataIO.chooseTypeFirst"), variant: "destructive" }); return; }
    setFileName(file.name);
    setBusy(true);
    try {
      const isJson = file.name.toLowerCase().endsWith(".json");
      let parsedHeaders: string[] = [];
      let parsedRows: any[] = [];
      let bundleAdaptedCount = 0;
      if (isJson) {
        const text = await file.text();
        const json = JSON.parse(text);
        let arr: any[] = [];
        if (Array.isArray(json)) arr = json;
        else if (json && Array.isArray(json[entityKey])) arr = json[entityKey];
        else if (json?.data && Array.isArray(json.data[entityKey])) arr = json.data[entityKey];
        // If the direct branch matched but yielded zero rows, the file may
        // still be a multi-table bundle that *also* happens to ship an empty
        // entityKey array. Fall through to the adapter rather than failing.
        if (arr.length === 0) {
          const adapted = adaptNestedBundle(json, entityKey);
          if (adapted && adapted.length > 0) {
            arr = adapted;
            bundleAdaptedCount = adapted.length;
          } else if (json?.data && typeof json.data === "object") {
            const first = Object.values(json.data).find((v) => Array.isArray(v)) as any[] | undefined;
            arr = first ?? [];
          }
        }
        if (arr.length === 0) throw new Error(t("dataIO.fileNoData"));
        parsedHeaders = Array.from(arr.reduce<Set<string>>((acc, r) => { if (r && typeof r === "object") Object.keys(r).forEach((k) => acc.add(k)); return acc; }, new Set()));
        parsedRows = arr;
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
        if (aoa.length < 2) throw new Error(t("dataIO.fileNotEnough"));
        parsedHeaders = (aoa[0] ?? []).map((h: any, i: number) => (h == null || String(h).trim() === "") ? t("dataIO.defaultColumn", { n: i + 1 }) : String(h).trim());
        parsedRows = aoa.slice(1).filter((r) => r && r.some((c: any) => c != null && String(c).trim() !== "")).map((r) => {
          const o: any = {};
          parsedHeaders.forEach((h, i) => { o[h] = r[i] ?? null; });
          return o;
        });
      }
      setHeaders(parsedHeaders);
      setRows(parsedRows);

      const result = await analyzeImport(token, { entity: entityKey, headers: parsedHeaders, sampleRows: parsedRows.slice(0, 8) });
      setAnalysis(result);
      const initialMap: Record<string, string | null> = {};
      for (const [src, m] of Object.entries(result.mapping)) initialMap[src] = m.field;
      setMapping(initialMap);
      setStep("analyze");
      const baseDesc = result.source === "ai" ? t("dataIO.analyzeAiDesc") : t("dataIO.analyzeFallbackDesc");
      toast({
        title: t("dataIO.analyzeSuccess", { count: parsedRows.length }),
        description: bundleAdaptedCount > 0
          ? `${t("dataIO.bundleAdapted", { count: bundleAdaptedCount })} — ${baseDesc}`
          : baseDesc,
      });
    } catch (e: any) {
      toast({ title: e?.message ?? t("dataIO.readFailed"), variant: "destructive" });
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
      toast({ title: e?.message ?? t("dataIO.processFailed"), variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function onCommit() {
    if (!processed) return;
    setBusy(true);
    try {
      const result = await commitImport(token, { companyId: cid, entity: entityKey, rows: processed.processed, options: { skipErrors: true } });
      setCommitResult(result);
      setStep("result");
      toast({ title: t("dataIO.commitSuccess", { inserted: result.summary.inserted, updated: result.summary.updated, skipped: result.summary.skipped }) });
    } catch (e: any) {
      toast({ title: e?.message ?? t("dataIO.commitFailed"), variant: "destructive" });
    } finally { setBusy(false); }
  }

  function downloadReport() {
    if (!commitResult || !processed) return;
    const wb = XLSX.utils.book_new();
    const sum = commitResult.summary;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      [t("dataIO.sheetDataType"), entityLabel(entity, isAr) || entityKey],
      [t("dataIO.sheetExecutedAt"), commitResult.committedAt],
      [],
      [t("dataIO.sheetTotal"), sum.total],
      [t("dataIO.sheetInserted"), sum.inserted],
      [t("dataIO.sheetUpdated"), sum.updated],
      [t("dataIO.sheetSkipped"), sum.skipped],
      [t("dataIO.sheetErrors"), sum.errors],
    ]), t("dataIO.summarySheetName"));
    const logRows = commitResult.log.map((l) => ({
      [t("dataIO.excelFileRow")]: l.rowIndex + 1,
      [t("dataIO.excelStatus")]: l.status === "inserted" ? t("dataIO.statusInserted")
        : l.status === "updated" ? t("dataIO.statusUpdated")
        : l.status === "skipped" ? t("dataIO.statusSkipped") : t("dataIO.statusError"),
      [t("dataIO.excelId")]: l.id ?? "",
      [t("dataIO.excelReason")]: l.reason ?? "",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows), t("dataIO.executionLogSheet"));
    const issueRows = processed.issues.map((i) => ({
      [t("dataIO.excelFileRow")]: i.rowIndex + 1, [t("dataIO.excelField")]: i.field ?? "",
      [t("dataIO.excelType")]: i.type, [t("dataIO.excelSeverity")]: i.severity,
      [t("dataIO.excelBefore")]: String(i.before ?? ""), [t("dataIO.excelAfter")]: String(i.after ?? ""),
      [t("dataIO.excelAction")]: i.action,
      [t("dataIO.excelConfidence")]: Math.round(i.confidence * 100) + "%",
      [t("dataIO.excelMessage")]: i.message,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows), t("dataIO.issuesSheet"));
    XLSX.writeFile(wb, `import-report-${entityKey}-${Date.now()}.xlsx`);
  }

  const StepBadge = ({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) => (
    <div className={`flex items-center gap-2 ${active ? "text-primary font-semibold" : done ? "text-green-600" : "text-muted-foreground"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${
        done ? "bg-green-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted"
      }`}>{done ? "✓" : n}</div>
      <span className="text-sm">{label}</span>
    </div>
  );

  const ArrowIcon = isAr ? ArrowLeft : ArrowRight;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4 justify-between">
          <div className="flex items-center gap-4">
            <StepBadge n={1} label={t("dataIO.stepUpload")} active={step === "upload"} done={step !== "upload"} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={2} label={t("dataIO.stepMap")} active={step === "analyze"} done={["review", "result"].includes(step)} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={3} label={t("dataIO.stepReview")} active={step === "review"} done={step === "result"} />
            <ArrowIcon className="w-4 h-4 text-muted-foreground" />
            <StepBadge n={4} label={t("dataIO.stepResult")} active={step === "result"} done={false} />
          </div>
          {step !== "upload" && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="w-4 h-4 ml-1" /> {t("dataIO.restart")}
            </Button>
          )}
        </div>
      </Card>

      {step === "upload" && (
        <Card className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">{t("dataIO.chooseDataType")}</label>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {entities.map((e) => (
                <button
                  key={e.key}
                  onClick={() => setEntityKey(e.key)}
                  className={`p-3 border rounded-lg ${isAr ? "text-right" : "text-left"} transition-colors ${
                    entityKey === e.key ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium">{entityLabel(e, isAr)}</div>
                  <div className="text-xs opacity-75">{isAr ? (e.labelEn ?? "") : (e.labelAr ?? "")}</div>
                </button>
              ))}
            </div>
          </div>

          <div className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${entityKey ? "hover:border-primary cursor-pointer" : "opacity-50"}`}
               onClick={() => entityKey && fileRef.current?.click()}>
            <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <div className="font-medium">{busy ? t("dataIO.dropAnalyzing") : t("dataIO.dropIdle")}</div>
            <div className="text-xs text-muted-foreground mt-1">{t("dataIO.supportedFormats")}</div>
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
              <div className="font-medium mb-1">{t("dataIO.fieldsHeader", { name: entityLabel(entity, isAr) })}</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {entity.fields.map((f, i) => (
                  <span key={f.name}>
                    {fieldLabel(f, isAr)}{f.required && <span className="text-red-600">*</span>}
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
              {t("dataIO.mappingTitle")}
            </h3>
            <div className="flex gap-3 text-sm text-muted-foreground">
              <span>{fileName}</span>
              <Badge variant="outline">{t("dataIO.rowsCount", { count: rows.length })}</Badge>
              <Badge variant="outline">{analysis.source === "ai" ? t("dataIO.sourceAi") : t("dataIO.sourceFallback")}</Badge>
            </div>
          </div>
          {analysis.missingRequired.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 p-3 rounded-lg text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200 mb-1">
                <AlertTriangle className="w-4 h-4" /> {t("dataIO.missingRequired")}
              </div>
              <div className="text-amber-700 dark:text-amber-300">
                {analysis.missingRequired.map((m) => isAr ? (m.labelAr || m.field) : m.field).join(isAr ? "، " : ", ")}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                {t("dataIO.missingRequiredHelp")}
              </div>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.fileColumn")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.systemField")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.confidenceCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.sampleCol")}</th>
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
                        <option value="">{t("dataIO.ignoreOpt")}</option>
                        {entity.fields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {fieldLabel(f, isAr)} {f.required ? "*" : ""}
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
              <ArrowIcon className="w-4 h-4 ml-2 rotate-180" /> {t("dataIO.back")}
            </Button>
            <Button onClick={onProcess} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Eye className="w-4 h-4 ml-2" />}
              {t("dataIO.processBtn")}
            </Button>
          </div>
        </Card>
      )}

      {step === "review" && processed && (
        <ReviewPanel processed={processed} entity={entity} setProcessed={setProcessed} onCommit={onCommit} onBack={() => setStep("analyze")} busy={busy} isAr={isAr} ArrowIcon={ArrowIcon} />
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

function ReviewPanel({ processed, entity, setProcessed, onCommit, onBack, busy, isAr, ArrowIcon }: {
  processed: ProcessResult; entity: EntityCatalogItem | undefined; setProcessed: (r: ProcessResult) => void;
  onCommit: () => void; onBack: () => void; busy: boolean; isAr: boolean; ArrowIcon: typeof ArrowLeft;
}) {
  const { t } = useTranslation();
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
  const align = isAr ? "text-right" : "text-left";

  return (
    <div className="space-y-4">
      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label={t("dataIO.statTotal")}      value={processed.stats.total}     icon={<Database />} />
        <StatCard label={t("dataIO.statErrors")}     value={processed.stats.errors}    icon={<X />} tone="error"   onClick={() => setFilter("errors")}     active={filter === "errors"} />
        <StatCard label={t("dataIO.statWarnings")}   value={processed.stats.warnings}  icon={<AlertTriangle />} tone="warning" onClick={() => setFilter("warnings")}   active={filter === "warnings"} />
        <StatCard label={t("dataIO.statFixes")}      value={processed.stats.info}      icon={<Sparkles />} tone="info"   onClick={() => setFilter("info")}        active={filter === "info"} />
        <StatCard label={t("dataIO.statDuplicates")} value={processed.stats.duplicates} icon={<CheckCircle2 />} tone="muted" onClick={() => setFilter("duplicates")} active={filter === "duplicates"} />
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h3 className="font-semibold">{t("dataIO.previewTitle")}</h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("dataIO.viewLabel")}</span>
            <select className="px-2 py-1 text-sm border rounded bg-background" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
              <option value="all">{t("dataIO.filterAll", { count: processed.processed.length })}</option>
              <option value="errors">{t("dataIO.filterErrors")}</option>
              <option value="warnings">{t("dataIO.filterWarnings")}</option>
              <option value="info">{t("dataIO.filterFixes")}</option>
              <option value="duplicates">{t("dataIO.filterDuplicates")}</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded border max-h-[500px]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className={`p-2 ${align} w-10`}>#</th>
                <th className={`p-2 ${align} w-24`}>{t("dataIO.statusCol")}</th>
                {cols.map((c) => <th key={c.name} className={`p-2 ${align} whitespace-nowrap`}>{fieldLabel(c, isAr)}</th>)}
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
                      {hasError ? <Badge variant="destructive">{t("dataIO.rowError")}</Badge>
                        : hasWarn ? <Badge className="bg-amber-500">{t("dataIO.rowWarning")}</Badge>
                        : list.length ? <Badge variant="secondary">{t("dataIO.rowFix")}</Badge>
                        : <Badge variant="outline">{t("dataIO.rowReady")}</Badge>}
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
              {t("dataIO.showing200", { count: filteredRows.length })}
            </div>
          )}
        </div>
      </Card>

      {/* issues detail */}
      {processed.issues.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">{t("dataIO.issuesTitle")}</h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className={`p-2 ${align}`}>{t("dataIO.rowCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.fieldCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.typeCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.beforeCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.afterCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.actionCol")}</th>
                  <th className={`p-2 ${align}`}>{t("dataIO.confidenceCol")}</th>
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
          <ArrowIcon className="w-4 h-4 ml-2 rotate-180" /> {t("dataIO.backToMap")}
        </Button>
        <Button onClick={onCommit} disabled={busy} size="lg">
          {busy ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 ml-2" />}
          {t("dataIO.commitBtn")}
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
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const dateLocale = isAr ? "ar-SA" : "en-US";
  const s = result.summary;
  return (
    <div className="space-y-4">
      <Card className="p-6 text-center bg-gradient-to-b from-green-50 to-card dark:from-green-950/40">
        <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-2" />
        <h3 className="text-xl font-semibold mb-1">{t("dataIO.completedTitle")}</h3>
        <p className="text-sm text-muted-foreground">{new Date(result.committedAt).toLocaleString(dateLocale)}</p>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label={t("dataIO.statTotal")}      value={s.total}    icon={<Database />} />
        <StatCard label={t("dataIO.statusInserted")} value={s.inserted} icon={<CheckCircle2 />} tone="info" />
        <StatCard label={t("dataIO.statusUpdated")}  value={s.updated}  icon={<Sparkles />} tone="info" />
        <StatCard label={t("dataIO.statusSkipped")}  value={s.skipped}  icon={<AlertTriangle />} tone="warning" />
        <StatCard label={t("dataIO.statErrors")}     value={s.errors}   icon={<X />} tone="error" />
      </div>

      {result.log.some((l) => l.status === "skipped" || l.status === "error") && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" /> {t("dataIO.failedRowsTitle")}
          </h3>
          <div className="overflow-x-auto rounded border max-h-[300px]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.rowCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.statusCol")}</th>
                  <th className={`p-2 ${isAr ? "text-right" : "text-left"}`}>{t("dataIO.excelReason")}</th>
                </tr>
              </thead>
              <tbody>
                {result.log.filter((l) => l.status !== "inserted" && l.status !== "updated").map((l, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{l.rowIndex + 1}</td>
                    <td className="p-2">
                      <Badge variant={l.status === "error" ? "destructive" : "secondary"}>{l.status === "skipped" ? t("dataIO.statusSkipped") : t("dataIO.statusError")}</Badge>
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
        <Button variant="outline" onClick={onReset}>{t("dataIO.importAnotherBtn")}</Button>
        <Button onClick={onDownload}>
          <FileDown className="w-4 h-4 ml-2" /> {t("dataIO.downloadReportBtn")}
        </Button>
      </div>
    </div>
  );
}
