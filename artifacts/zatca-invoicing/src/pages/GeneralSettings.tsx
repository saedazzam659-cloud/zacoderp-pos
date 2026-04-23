import { useTranslation } from "react-i18next";
import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Settings2, Upload, Trash2, CheckCircle2, Image as ImageIcon,
  Hash, Building2, Loader2, Package, Boxes, Download, FileSpreadsheet,
  DatabaseBackup, DatabaseZap, Sparkles, FileJson, AlertTriangle,
  Clock, Repeat, Trash, History, Play
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const DECIMAL_OPTIONS = [
  { value: 0, label: "0",    example: "1,234" },
  { value: 1, label: "0.0",  example: "1,234.5" },
  { value: 2, label: "0.00", example: "1,234.56" },
  { value: 3, label: "0.000",example: "1,234.567" },
  { value: 4, label: "0.0000",example:"1,234.5678" },
];

export default function GeneralSettings() {
  const { t } = useTranslation();
  const { user, token, setUser } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);

  const [logo, setLogo]         = useState<string | null>(user?.company?.logo ?? null);
  const [decimals, setDecimals] = useState<number>(user?.company?.decimalPlaces ?? 2);
  const [dragging, setDragging] = useState(false);
  const [logoError, setLogoError] = useState("");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const saveMutation = useMutation({
    mutationFn: async (payload: { logo?: string | null; decimalPlaces?: number }) => {
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("pages.generalSettings.saveFailed"));
      return json;
    },
    onSuccess: (data) => {
      if (setUser) {
        setUser((u: any) => ({ ...u, company: { ...u.company, logo: data.logo, decimalPlaces: data.decimalPlaces } }));
      }
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: t("pages.generalSettings.saveSuccess") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ─── Logo upload handling ─────────────────────────────────────────────────

  const processFile = useCallback((file: File) => {
    setLogoError("");
    if (!file.type.startsWith("image/")) {
      setLogoError(t("pages.generalSettings.invalidFileType")); return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError(t("pages.generalSettings.fileTooLarge")); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setLogo(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);

  const handleSave = () => {
    saveMutation.mutate({ logo: logo ?? null, decimalPlaces: decimals });
  };

  const isDirty =
    logo !== (user?.company?.logo ?? null) ||
    decimals !== (user?.company?.decimalPlaces ?? 2);

  // ─── Bulk Import (Items + Opening Balances) ─────────────────────────────
  const itemsFileRef    = useRef<HTMLInputElement>(null);
  const balancesFileRef = useRef<HTMLInputElement>(null);
  const [itemsImporting,    setItemsImporting]    = useState(false);
  const [balancesImporting, setBalancesImporting] = useState(false);
  const [itemsReport,    setItemsReport]    = useState<{ created: number; updated: number; total: number; errors: { row: number; error: string }[] } | null>(null);
  const [balancesReport, setBalancesReport] = useState<{ applied: number; total: number; errors: { row: number; error: string }[] } | null>(null);

  function downloadItemsTemplate() {
    const headers = ["code","nameAr","nameEn","barcode","groupCode","unitCode","itemType","costPrice","salePrice","vatRate","reorderLevel","maxLevel","description"];
    const example = [
      ["ITM-001","حليب طازج 1 لتر","Fresh Milk 1L","6281234567890","DAIRY","PCS","stock",4.50,6.00,15,20,500,"حليب بقري طازج"],
      ["ITM-002","خبز توست أبيض","White Toast Bread","6281234567891","BAKERY","PCS","stock",3.20,5.00,15,30,200,""],
      ["SRV-001","رسوم توصيل","Delivery Fee","","SERVICES","SRV","service",0,15,15,0,"",""],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Items");
    XLSX.writeFile(wb, "items_template.xlsx");
  }

  function downloadBalancesTemplate() {
    const headers = ["itemCode","warehouseCode","qty","costPrice"];
    const example = [
      ["ITM-001","WH-MAIN",100,4.50],
      ["ITM-002","WH-MAIN",50,3.20],
      ["ITM-001","WH-SUB",25,4.50],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "OpeningBalances");
    XLSX.writeFile(wb, "opening_balances_template.xlsx");
  }

  async function parseExcelToObjects(file: File): Promise<any[]> {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
  }

  async function handleItemsUpload(file: File) {
    setItemsImporting(true);
    setItemsReport(null);
    try {
      const items = await parseExcelToObjects(file);
      if (!items.length) throw new Error(t("pages.generalSettings.emptyFileError"));
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/inventory/import/items?companyId=${cid}`, {
        method: "POST", headers, body: JSON.stringify({ items }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.importFailed"));
      setItemsReport(j);
      toast({ title: t("pages.generalSettings.itemsImportReport", { created: j.created, updated: j.updated, errors: j.errors?.length || 0 }) });
      qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    } finally {
      setItemsImporting(false);
    }
  }

  async function handleBalancesUpload(file: File) {
    setBalancesImporting(true);
    setBalancesReport(null);
    try {
      const balances = await parseExcelToObjects(file);
      if (!balances.length) throw new Error(t("pages.generalSettings.emptyFileError"));
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/inventory/import/opening-balances?companyId=${cid}`, {
        method: "POST", headers, body: JSON.stringify({ balances }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.importFailed"));
      setBalancesReport(j);
      toast({ title: t("pages.generalSettings.balancesImportReport", { applied: j.applied, errors: j.errors?.length || 0 }) });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    } finally {
      setBalancesImporting(false);
    }
  }

  // ─── Backup Export / Import (with AI analysis) ───────────────────────────
  const backupFileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [uploadedBackup, setUploadedBackup] = useState<any | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiSummary, setAiSummary] = useState<{ summary: string; warnings: string[]; counts: Record<string, number> } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreReport, setRestoreReport] = useState<any | null>(null);

  async function handleBackupExport() {
    setExporting(true);
    try {
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/backup/export?companyId=${cid}`, { headers });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.exportFailed"));
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `backup-${user?.company?.nameAr?.replace(/\s+/g, "_") || "company"}-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const total = Object.values(j.counts || {}).reduce((a: number, b: any) => a + Number(b), 0);
      toast({ title: t("pages.generalSettings.exportSuccess", { count: total }) });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.exportFailed"), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  async function handleBackupFilePicked(file: File) {
    setUploadedBackup(null); setAiSummary(null); setRestoreReport(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed?.data || typeof parsed.data !== "object") {
        throw new Error(t("pages.generalSettings.invalidBackupFile"));
      }
      setUploadedBackup(parsed);
      setAnalyzing(true);
      try {
        const res = await fetch(`${API}/api/backup/ai-analyze`, {
          method: "POST", headers, body: JSON.stringify({ backup: parsed }),
        });
        const j = await res.json();
        if (res.ok) setAiSummary(j);
      } catch {/* non-fatal */} finally { setAnalyzing(false); }
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.invalidBackupFile"), variant: "destructive" });
    }
  }

  async function handleBackupRestore() {
    if (!uploadedBackup) return;
    if (!window.confirm(t("pages.generalSettings.confirmRestore"))) return;
    setRestoring(true);
    try {
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/backup/restore`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId: cid, backup: uploadedBackup }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.restoreFailed"));
      setRestoreReport(j.report);
      const inserted = Object.values(j.report || {}).reduce((a: number, r: any) => a + (r?.inserted || 0), 0);
      toast({ title: t("pages.generalSettings.restoreSuccess", { count: inserted }) });
      qc.invalidateQueries();
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.restoreFailed"), variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-6 w-6 text-primary" />
          {t("pages.generalSettings.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("pages.generalSettings.description")}
        </p>
      </div>

      {/* Company context */}
      {user?.company && (
        <div className="rounded-xl border bg-muted/30 px-4 py-3 flex items-center gap-3">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{user.company.nameAr}</p>
            <p className="text-xs font-mono text-muted-foreground">{user.company.vatNumber}</p>
          </div>
        </div>
      )}

      {/* ─── Tabs Header (3 tabs aligned to top-right in RTL) ───────────────── */}
      <Tabs defaultValue="general" dir="rtl" className="w-full">
        <TabsList className="grid w-full grid-cols-6 h-11 bg-muted/50">
          <TabsTrigger value="general" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Settings2 className="h-4 w-4" />
            {t("pages.generalSettings.general")}
          </TabsTrigger>
          <TabsTrigger value="items" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Package className="h-4 w-4" />
            {t("pages.generalSettings.importItems")}
          </TabsTrigger>
          <TabsTrigger value="balances" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Boxes className="h-4 w-4" />
            {t("pages.generalSettings.openingBalancesTab")}
          </TabsTrigger>
          <TabsTrigger value="decimals" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Hash className="h-4 w-4" />
            {t("pages.generalSettings.decimals")}
          </TabsTrigger>
          <TabsTrigger value="backupExport" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <DatabaseBackup className="h-4 w-4" />
            {t("pages.generalSettings.backupExport")}
          </TabsTrigger>
          <TabsTrigger value="backupImport" className="gap-2 data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <DatabaseZap className="h-4 w-4" />
            {t("pages.generalSettings.backupImport")}
          </TabsTrigger>
        </TabsList>

        {/* ═══ TAB 1: General (Logo + Decimals + Save) ═══════════════════════ */}
        <TabsContent value="general" className="mt-5 space-y-6">

      {/* ─── Logo Section ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          {t("pages.generalSettings.companyLogo")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("pages.generalSettings.logoDescription")}
        </p>

        <div className="flex flex-col sm:flex-row gap-4">
          {/* Drop zone */}
          <div
            ref={dragRef}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all py-8 px-4 text-center min-h-[140px]",
              dragging
                ? "border-primary bg-primary/5 scale-[1.01]"
                : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/40"
            )}
          >
            <Upload className={cn("h-8 w-8 mb-2 transition-colors", dragging ? "text-primary" : "text-muted-foreground/50")} />
            <p className="text-sm font-medium text-muted-foreground">
              {dragging ? t("pages.generalSettings.dropImageHere") : t("pages.generalSettings.dragAndDrop")}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">PNG, JPG, SVG, WebP</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Preview */}
          {logo ? (
            <div className="relative flex-shrink-0 w-full sm:w-48">
              <div className="rounded-xl border bg-muted/20 p-3 flex items-center justify-center h-full min-h-[140px]">
                <img
                  src={logo}
                  alt={t("pages.generalSettings.companyLogo")}
                  className="max-h-28 max-w-full object-contain"
                />
              </div>
              <button
                onClick={() => setLogo(null)}
                className="absolute -top-2 -left-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow hover:scale-110 transition-transform"
                title={t("common.delete")}
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <p className="text-center text-[10px] text-muted-foreground mt-2">{t("pages.generalSettings.logoPreview")}</p>
            </div>
          ) : (
            <div className="flex-shrink-0 w-full sm:w-48 rounded-xl border border-dashed bg-muted/10 flex flex-col items-center justify-center h-full min-h-[140px] gap-2">
              <div className="h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center">
                <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
              </div>
              <p className="text-xs text-muted-foreground/50">{t("pages.generalSettings.noLogo")}</p>
            </div>
          )}
        </div>

        {logoError && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{logoError}</p>
        )}
      </div>

      {/* ─── Save Button (inside General tab — saves logo + decimals together) ─ */}
      <div className="flex items-center justify-between gap-4">
        {isDirty ? (
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
            {t("pages.generalSettings.unsavedChanges")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("pages.generalSettings.allChangesSaved")}</p>
        )}
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          className="gap-2 min-w-36"
        >
          {saveMutation.isPending
            ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</>
            : <><CheckCircle2 className="h-4 w-4" />{t("common.save")}</>
          }
        </Button>
      </div>

        </TabsContent>

        {/* ═══ TAB 2: Items Import ═══════════════════════════════════════════ */}
        <TabsContent value="items" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <Package className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.itemsFile")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">code, nameAr, nameEn, barcode, groupCode, unitCode, itemType, costPrice, salePrice, vatRate, reorderLevel, maxLevel, description</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("pages.generalSettings.itemsImportNote1")} <span className="font-mono" dir="ltr">groupCode</span>, <span className="font-mono" dir="ltr">unitCode</span> {t("pages.generalSettings.itemsImportNote2")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadItemsTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplate")}
            </Button>
            <Button type="button" size="sm" onClick={() => itemsFileRef.current?.click()} disabled={itemsImporting} className="gap-1.5 bg-blue-600 hover:bg-blue-700">
              {itemsImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {itemsImporting ? t("common.loading") : t("pages.generalSettings.uploadItemsFile")}
            </Button>
            <input
              ref={itemsFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleItemsUpload(f); e.target.value = ""; }}
            />
          </div>
          {itemsReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-green-600">{itemsReport.created} {t("pages.generalSettings.added")}</span> · <span className="text-blue-600">{itemsReport.updated} {t("pages.generalSettings.updated")}</span> / {itemsReport.total}
                {itemsReport.errors?.length ? <span className="text-red-600"> · {itemsReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {itemsReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {itemsReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        </TabsContent>

        {/* ═══ TAB 3: Opening Balances Import ════════════════════════════════ */}
        <TabsContent value="balances" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.openingBalancesTitle")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">itemCode, warehouseCode, qty, costPrice</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("pages.generalSettings.balancesImportNote")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadBalancesTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplate")}
            </Button>
            <Button type="button" size="sm" onClick={() => balancesFileRef.current?.click()} disabled={balancesImporting} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
              {balancesImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {balancesImporting ? t("common.loading") : t("pages.generalSettings.uploadBalancesFile")}
            </Button>
            <input
              ref={balancesFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBalancesUpload(f); e.target.value = ""; }}
            />
          </div>
          {balancesReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-emerald-600">{balancesReport.applied} {t("pages.generalSettings.balancesApplied")}</span> / {balancesReport.total}
                {balancesReport.errors?.length ? <span className="text-red-600"> · {balancesReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {balancesReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {balancesReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        </TabsContent>

        {/* ═══ TAB 4: Decimal Places ═════════════════════════════════════════ */}
        <TabsContent value="decimals" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              {t("pages.generalSettings.decimalPrecisionTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("pages.generalSettings.decimalPrecisionNote")}
            </p>

            <div className="grid grid-cols-5 gap-2">
              {DECIMAL_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setDecimals(opt.value)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border-2 px-2 py-3 transition-all",
                    decimals === opt.value
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-muted-foreground/20 hover:border-primary/40 hover:bg-muted/40 text-foreground"
                  )}
                >
                  <span className="font-mono text-base font-bold">{opt.label}</span>
                  <span className="text-[9px] font-mono text-muted-foreground leading-tight text-center">{opt.example}</span>
                  {decimals === opt.value && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              ))}
            </div>

            <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm">
              <span className="text-muted-foreground">{t("pages.generalSettings.example")}: </span>
              <span className="font-mono font-medium">
                {(1234.56789).toFixed(decimals)} {t("common.currency.sar")}
              </span>
            </div>
          </div>

          {/* Save button (also saves logo + decimals together) */}
          <div className="flex items-center justify-between gap-4">
            {isDirty ? (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                {t("pages.generalSettings.unsavedChanges")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("pages.generalSettings.allChangesSaved")}</p>
            )}
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending || !isDirty}
              className="gap-2 min-w-36"
            >
              {saveMutation.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</>
                : <><CheckCircle2 className="h-4 w-4" />{t("common.save")}</>
              }
            </Button>
          </div>
        </TabsContent>

        {/* ═══ TAB 5: Backup Export ══════════════════════════════════════════ */}
        <TabsContent value="backupExport" className="mt-5 space-y-4">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
                <DatabaseBackup className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-sm">{t("pages.generalSettings.backupExportTitle")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("pages.generalSettings.backupExportDesc")}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("pages.generalSettings.backupExportIncludes")}
                </p>
              </div>
            </div>
            <Button
              type="button"
              onClick={handleBackupExport}
              disabled={exporting}
              className="gap-2 bg-indigo-600 hover:bg-indigo-700"
            >
              {exporting
                ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</>
                : <><Download className="h-4 w-4" />{t("pages.generalSettings.downloadBackup")}</>
              }
            </Button>
          </div>
        </TabsContent>

        {/* ═══ TAB 6: Backup Import (with AI analysis) ═══════════════════════ */}
        <TabsContent value="backupImport" className="mt-5 space-y-4">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
                <DatabaseZap className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-sm">{t("pages.generalSettings.backupImportTitle")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("pages.generalSettings.backupImportDesc")}
                </p>
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-2 inline-flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {t("pages.generalSettings.backupImportWarning")}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => backupFileRef.current?.click()}
                disabled={analyzing || restoring}
                className="gap-1.5 bg-violet-600 hover:bg-violet-700"
              >
                <Upload className="h-3.5 w-3.5" />
                {t("pages.generalSettings.pickBackupFile")}
              </Button>
              <input
                ref={backupFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBackupFilePicked(f); e.target.value = ""; }}
              />
            </div>

            {/* File meta + AI summary */}
            {uploadedBackup && (
              <div className="rounded-lg border bg-muted/20 px-3 py-2 space-y-2 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <FileJson className="h-3.5 w-3.5" />
                  <span>{t("pages.generalSettings.backupFileMeta", {
                    date: uploadedBackup.meta?.exportedAt?.slice(0, 16).replace("T", " ") ?? "?",
                    version: uploadedBackup.meta?.schemaVersion ?? "?",
                  })}</span>
                </div>
                {analyzing && (
                  <div className="flex items-center gap-2 text-violet-700">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("pages.generalSettings.aiAnalyzing")}</span>
                  </div>
                )}
                {aiSummary && (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Sparkles className="h-3.5 w-3.5 mt-0.5 text-violet-600 shrink-0" />
                      <p className="whitespace-pre-line leading-relaxed">{aiSummary.summary}</p>
                    </div>
                    {aiSummary.warnings?.length > 0 && (
                      <ul className="text-[11px] text-amber-700 space-y-0.5 pr-4">
                        {aiSummary.warnings.map((w, i) => (
                          <li key={i} className="list-disc list-inside">{w}</li>
                        ))}
                      </ul>
                    )}
                    {aiSummary.counts && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {Object.entries(aiSummary.counts).filter(([, n]) => (n as number) > 0).map(([k, n]) => (
                          <span key={k} className="inline-flex items-center gap-1 rounded-full bg-white border px-2 py-0.5 text-[10px] font-mono">
                            {k}: <b>{n as number}</b>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {uploadedBackup && (
              <Button
                type="button"
                onClick={handleBackupRestore}
                disabled={restoring || analyzing}
                className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              >
                {restoring
                  ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</>
                  : <><CheckCircle2 className="h-4 w-4" />{t("pages.generalSettings.restoreBackup")}</>
                }
              </Button>
            )}

            {restoreReport && (
              <div className="rounded-md border bg-card px-3 py-2 text-xs">
                <p className="font-medium mb-1">{t("pages.generalSettings.restoreReport")}</p>
                <ul className="space-y-0.5 font-mono text-[11px]">
                  {Object.entries(restoreReport).map(([k, r]: any) => (
                    <li key={k}>
                      {k}: <span className="text-green-600">+{r.inserted}</span> · <span className="text-muted-foreground">{r.skipped} {t("pages.generalSettings.skipped")}</span> / {r.received}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

    </div>
  );
}
