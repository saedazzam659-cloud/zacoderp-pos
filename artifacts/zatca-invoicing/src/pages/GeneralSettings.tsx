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
  Clock, Repeat, Trash, History, Play, Zap, Hand, Printer, Save,
  LogOut, Timer, ShieldCheck
} from "lucide-react";
import { getIdleLogoutMinutes, setIdleLogoutMinutes } from "@/hooks/useIdleLogout";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getPreferredPrinter, setPreferredPrinter, openPrinterTestSheet, detectUsbPrinter, isWebUsbSupported } from "@/lib/preferredPrinter";
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
  const autoPostingEnabled = user?.company?.autoPostingEnabled !== false;
  const [postingSaving, setPostingSaving] = useState(false);
  // Per-doc-type auto-posting flags. We treat `undefined` (legacy rows
  // before the columns existed) and `true` the same — only an explicit
  // `false` disables auto-posting for that document type. This mirrors
  // how each form reads its own flag with a global-fallback.
  const docTypeFlag = (key: string): boolean => {
    const v = user?.company?.[key];
    if (v === undefined || v === null) return autoPostingEnabled;
    return v !== false;
  };
  // Doc-type catalog rendered as a list of toggles. The label/desc come
  // from i18n with sensible Arabic fallbacks so this works even before
  // the translations are added.
  const POST_DOC_TYPES: { key: string; label: string; desc: string }[] = [
    { key: "autoPostSales",        label: "فواتير المبيعات",          desc: "ترحيل قيد فاتورة المبيعات تلقائياً عند الحفظ" },
    { key: "autoPostPurchase",     label: "فواتير المشتريات",         desc: "ترحيل قيد فاتورة الشراء تلقائياً عند الحفظ" },
    { key: "autoPostReceipt",      label: "سندات القبض",              desc: "ترحيل قيد سند القبض تلقائياً عند الحفظ" },
    { key: "autoPostPayment",      label: "سندات الصرف",              desc: "ترحيل قيد سند الصرف تلقائياً عند الحفظ" },
    { key: "autoPostFinancial",    label: "العمليات المالية",         desc: "ترحيل قيد العملية المالية تلقائياً عند الحفظ" },
    { key: "autoPostCashTransfer", label: "تحويلات الخزائن والبنوك",  desc: "ترحيل قيد تحويل النقدية تلقائياً عند الحفظ" },
    { key: "autoPostPayroll",      label: "الرواتب",                  desc: "ترحيل قيد الراتب تلقائياً عند الاحتساب" },
  ];

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

  // ─── Auto-posting toggle (saves immediately on toggle) ────────────────────
  // Generic patcher: accepts ANY subset of the posting flags and PATCHes
  // them to the server in one request. Used by both the master switch
  // (autoPostingEnabled) and the per-doc-type toggles below so we keep a
  // single network/error path.
  async function togglePostingMode(payload: Record<string, boolean>) {
    const cid = user?.company?.id ?? user?.companyId;
    if (!cid || postingSaving) return;
    setPostingSaving(true);
    try {
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("pages.generalSettings.saveFailed"));
      if (setUser) {
        // Merge ONLY the fields the server actually echoed back, preserving
        // any other company props (logo, decimals, …) on the local copy.
        setUser((u: any) => {
          if (!u) return u;
          const merged: Record<string, any> = { ...u.company };
          for (const k of Object.keys(payload)) {
            if (data[k] !== undefined) merged[k] = data[k];
          }
          return { ...u, company: merged };
        });
      }
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: t("pages.generalSettings.postingModeSaved") });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setPostingSaving(false);
    }
  }

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

      {/* ─── Tabs Header — modern wrap-pill layout (RTL-aware, no text overlap) ─ */}
      <Tabs defaultValue="general" dir="rtl" className="w-full">
        <TabsList className="flex flex-wrap h-auto w-full justify-start gap-1.5 bg-muted/40 border border-border/50 p-1.5 rounded-xl shadow-sm">
          <TabsTrigger
            value="general"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Settings2 className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.general")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="items"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Package className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.importItems")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="balances"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Boxes className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.openingBalancesTab")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="decimals"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Hash className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.decimals")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="backupExport"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <DatabaseBackup className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.backupExport")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="backupImport"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <DatabaseZap className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.backupImport")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="printText"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Printer className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.printText")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="printPrefs"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Printer className="h-4 w-4 shrink-0" />
            <span className="truncate">إعدادات الطباعة</span>
          </TabsTrigger>
          <TabsTrigger
            value="autoLogout"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className="truncate">تسجيل الخروج التلقائي</span>
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

      {/* ─── Posting Mode Section (per-doc-type toggles) ──────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" />
          {t("pages.generalSettings.postingMode", { defaultValue: "وضع الترحيل" })}
        </h2>
        <p className="text-xs text-muted-foreground">
          اختر طريقة ترحيل القيود لكل نوع مستند على حدة. <span className="font-medium text-foreground">تلقائي</span> = ترحيل القيد فور الحفظ.
          {" "}<span className="font-medium text-foreground">يدوي</span> = حفظ كمسودة فقط، يتم الترحيل لاحقاً من مركز الترحيل.
        </p>

        {/* ── Master switch (legacy global flag — still respected as fallback) ── */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn(
              "h-7 w-7 rounded-md flex items-center justify-center shrink-0",
              autoPostingEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}>
              {autoPostingEnabled ? <Zap className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">المفتاح العام للترحيل التلقائي</p>
              <p className="text-[11px] text-muted-foreground truncate">يُستخدم كقيمة افتراضية للأنواع التي لم تُضبط بشكل مستقل</p>
            </div>
          </div>
          <Switch
            checked={autoPostingEnabled}
            disabled={postingSaving}
            onCheckedChange={(v) => togglePostingMode({ autoPostingEnabled: !!v })}
            data-testid="toggle-auto-posting-master"
          />
        </div>

        {/* ── Per-document-type rows ─────────────────────────────────────── */}
        <div className="rounded-lg border divide-y bg-card">
          {POST_DOC_TYPES.map((dt) => {
            const on = docTypeFlag(dt.key);
            return (
              <div key={dt.key} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={cn(
                    "h-7 w-7 rounded-md flex items-center justify-center shrink-0",
                    on ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                  )}>
                    {on ? <Zap className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{dt.label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{dt.desc}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn(
                    "text-[10.5px] font-semibold rounded px-1.5 py-0.5 border",
                    on
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                  )}>
                    {on ? "تلقائي" : "يدوي"}
                  </span>
                  <Switch
                    checked={on}
                    disabled={postingSaving}
                    onCheckedChange={(v) => togglePostingMode({ [dt.key]: !!v })}
                    data-testid={`toggle-${dt.key}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {postingSaving && (
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("common.loading")}
          </p>
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
                {(1234.56789).toFixed(decimals)} {t("common.currencySAR")}
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

        {/* ═══ TAB 7: Print Footer Text ═══════════════════════════════════════ */}
        <TabsContent value="printText" className="mt-5 space-y-6">
          <PrintFooterTab user={user} token={token} setUser={setUser} />
        </TabsContent>

        <TabsContent value="printPrefs" className="mt-5 space-y-6">
          <PrintPreferencesTab user={user} token={token} setUser={setUser} />
        </TabsContent>

        {/* ═══ TAB 9: Auto Logout (idle timeout) ═══════════════════════════ */}
        <TabsContent value="autoLogout" className="mt-5 space-y-6">
          <AutoLogoutTab />
        </TabsContent>
      </Tabs>

    </div>
  );
}

// ─── Sub-component: Print Footer customization tab ────────────────────────
function PrintFooterTab({ user, token, setUser }: { user: any; token: string; setUser: any }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.company?.id ?? user?.companyId;
  const company = user?.company ?? {};
  const isAr = i18n.language?.startsWith("ar");

  const DEFAULT_INVOICE = t("pages.generalSettings.printFooterDefaultInvoice");
  const DEFAULT_RETURN  = t("pages.generalSettings.printFooterDefaultReturn");

  const [invoiceFooter, setInvoiceFooter] = useState<string>(company.printFooterInvoice ?? DEFAULT_INVOICE);
  const [returnFooter,  setReturnFooter]  = useState<string>(company.printFooterReturn  ?? DEFAULT_RETURN);
  const [showTimestamp, setShowTimestamp] = useState<boolean>(company.printShowTimestamp !== false);
  const [showZatca,     setShowZatca]     = useState<boolean>(company.printShowZatcaBrand !== false);

  useEffect(() => {
    setInvoiceFooter(company.printFooterInvoice ?? DEFAULT_INVOICE);
    setReturnFooter(company.printFooterReturn ?? DEFAULT_RETURN);
    setShowTimestamp(company.printShowTimestamp !== false);
    setShowZatca(company.printShowZatcaBrand !== false);
  }, [company.printFooterInvoice, company.printFooterReturn, company.printShowTimestamp, company.printShowZatcaBrand, DEFAULT_INVOICE, DEFAULT_RETURN]);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          printFooterInvoice: invoiceFooter.trim(),
          printFooterReturn:  returnFooter.trim(),
          printShowTimestamp: showTimestamp,
          printShowZatcaBrand: showZatca,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("pages.generalSettings.printFooterSaveError"));
      return json;
    },
    onSuccess: (data) => {
      if (setUser) {
        setUser((u: any) => ({
          ...u,
          company: {
            ...u.company,
            printFooterInvoice:   data.printFooterInvoice,
            printFooterReturn:    data.printFooterReturn,
            printShowTimestamp:   data.printShowTimestamp,
            printShowZatcaBrand:  data.printShowZatcaBrand,
          },
        }));
      }
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: t("pages.generalSettings.printFooterSaveSuccess") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function resetToDefault() {
    setInvoiceFooter(DEFAULT_INVOICE);
    setReturnFooter(DEFAULT_RETURN);
    setShowTimestamp(true);
    setShowZatca(true);
  }

  const invoiceLen = invoiceFooter.length;
  const returnLen  = returnFooter.length;
  const overLimit  = invoiceLen > 200 || returnLen > 200;
  const previewLocale = isAr ? "ar-SA" : "en-US";

  return (
    <>
      <div className="rounded-xl border bg-card p-5 space-y-2">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Printer className="h-4 w-4 text-muted-foreground" />
          {t("pages.generalSettings.printFooterTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("pages.generalSettings.printFooterDescLine1")}{" "}
          {t("pages.generalSettings.printFooterDescLine2")}
        </p>
      </div>

      <div className="rounded-xl border bg-card p-5 space-y-5">
        {/* Invoice footer */}
        <div className="space-y-2">
          <Label htmlFor="invoice-footer" className="font-medium">
            {t("pages.generalSettings.printFooterInvoiceLabel")}
          </Label>
          <Input
            id="invoice-footer"
            value={invoiceFooter}
            maxLength={220}
            onChange={(e) => setInvoiceFooter(e.target.value)}
            placeholder={DEFAULT_INVOICE}
            dir="rtl"
            className={cn(invoiceLen > 200 && "border-destructive")}
          />
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t("pages.generalSettings.printFooterInvoiceHint")}</span>
            <span className={cn(invoiceLen > 200 ? "text-destructive font-medium" : "text-muted-foreground")}>
              {invoiceLen} / 200
            </span>
          </div>
        </div>

        {/* Return footer */}
        <div className="space-y-2">
          <Label htmlFor="return-footer" className="font-medium">
            {t("pages.generalSettings.printFooterReturnLabel")}
          </Label>
          <Input
            id="return-footer"
            value={returnFooter}
            maxLength={220}
            onChange={(e) => setReturnFooter(e.target.value)}
            placeholder={DEFAULT_RETURN}
            dir="rtl"
            className={cn(returnLen > 200 && "border-destructive")}
          />
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t("pages.generalSettings.printFooterReturnHint")}</span>
            <span className={cn(returnLen > 200 ? "text-destructive font-medium" : "text-muted-foreground")}>
              {returnLen} / 200
            </span>
          </div>
        </div>

        {/* Toggles */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="font-medium text-sm flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                {t("pages.generalSettings.printFooterShowTimestamp")}
              </div>
              <p className="text-xs text-muted-foreground">{t("pages.generalSettings.printFooterShowTimestampHint")}</p>
            </div>
            <Switch checked={showTimestamp} onCheckedChange={setShowTimestamp} />
          </div>

          <div className="border-t pt-4 flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="font-medium text-sm flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                {t("pages.generalSettings.printFooterShowZatca")}
              </div>
              <p className="text-xs text-muted-foreground">{t("pages.generalSettings.printFooterShowZatcaHint")}</p>
            </div>
            <Switch checked={showZatca} onCheckedChange={setShowZatca} />
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h3 className="font-medium text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {t("pages.generalSettings.printFooterPreviewTitle")}
        </h3>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-lg border bg-white p-4 text-center" dir="rtl" style={{ fontFamily: "'Courier New', monospace" }}>
            <div className="text-xs text-muted-foreground mb-2 font-sans">📄 {t("pages.generalSettings.printFooterPreviewInvoice")}</div>
            <div className="border-t-2 border-black pt-2 text-xs space-y-1 text-black">
              <div className="font-semibold">{invoiceFooter || DEFAULT_INVOICE}</div>
              {showTimestamp && <div className="text-[11px]">{t("pages.generalSettings.printFooterPrintedAt", { date: new Date().toLocaleString(previewLocale) })}</div>}
              {showZatca && <div className="text-[10px] opacity-70">ZATCA e-Invoicing</div>}
            </div>
          </div>
          <div className="rounded-lg border bg-white p-4 text-center" dir="rtl" style={{ fontFamily: "'Courier New', monospace" }}>
            <div className="text-xs text-muted-foreground mb-2 font-sans">↩️ {t("pages.generalSettings.printFooterPreviewReturn")}</div>
            <div className="border-t-2 border-red-700 pt-2 text-xs space-y-1 text-black">
              <div className="font-semibold">{returnFooter || DEFAULT_RETURN}</div>
              {showTimestamp && <div className="text-[11px]">{t("pages.generalSettings.printFooterPrintedAt", { date: new Date().toLocaleString(previewLocale) })}</div>}
              {showZatca && <div className="text-[10px] opacity-70">ZATCA e-Invoicing</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={resetToDefault} disabled={saveMut.isPending}>
          <Repeat className="h-4 w-4 ml-2" />
          {t("pages.generalSettings.printFooterRestoreDefault")}
        </Button>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || overLimit}>
          {saveMut.isPending
            ? <><Loader2 className="h-4 w-4 ml-2 animate-spin" />{t("pages.generalSettings.printFooterSaving")}</>
            : <><Save className="h-4 w-4 ml-2" />{t("pages.generalSettings.printFooterSave")}</>}
        </Button>
      </div>
    </>
  );
}

// ─── Sub-component: Print Preferences tab ─────────────────────────────────
// Per-doc-type preferences for "auto-print after save" + "A4 vs thermal".
// Covers four surfaces: sales invoices, customer receipt vouchers,
// supplier payment vouchers, and journal entries. Each row has its
// own toggle + template select; one save button pushes the whole set.
function PrintPreferencesTab({ user, token, setUser }: { user: any; token: string; setUser: any }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.company?.id ?? user?.companyId;
  const company = user?.company ?? {};

  type PrefRow = {
    autoKey: "printAutoAfterSaveSales" | "printAutoAfterSaveReceipt" | "printAutoAfterSavePayment" | "printAutoAfterSaveJournal";
    tplKey:  "printTemplateSales"     | "printTemplateReceipt"     | "printTemplatePayment"     | "printTemplateJournal";
    label: string;
    hint:  string;
  };
  const ROWS: PrefRow[] = [
    { autoKey: "printAutoAfterSaveSales",   tplKey: "printTemplateSales",   label: "فواتير المبيعات",       hint: "تنطبق على الفواتير الصادرة من شاشة المبيعات" },
    { autoKey: "printAutoAfterSaveReceipt", tplKey: "printTemplateReceipt", label: "سند القبض (تحصيل العملاء)", hint: "ينطبق على إيصالات تحصيل العملاء" },
    { autoKey: "printAutoAfterSavePayment", tplKey: "printTemplatePayment", label: "سند الصرف (تسديد الموردين)", hint: "ينطبق على إيصالات تسديد الموردين" },
    { autoKey: "printAutoAfterSaveJournal", tplKey: "printTemplateJournal", label: "القيود المحاسبية",      hint: "ينطبق على شاشة إنشاء/تعديل القيد" },
  ];

  // Local form state, seeded from the user's company. We update the
  // local copy on every toggle/select change and only PATCH on Save.
  const [form, setForm] = useState<Record<string, any>>({
    printAutoAfterSaveSales:   !!company.printAutoAfterSaveSales,
    printAutoAfterSaveReceipt: !!company.printAutoAfterSaveReceipt,
    printAutoAfterSavePayment: !!company.printAutoAfterSavePayment,
    printAutoAfterSaveJournal: !!company.printAutoAfterSaveJournal,
    printTemplateSales:    company.printTemplateSales   ?? "a4",
    printTemplateReceipt:  company.printTemplateReceipt ?? "a4",
    printTemplatePayment:  company.printTemplatePayment ?? "a4",
    printTemplateJournal:  company.printTemplateJournal ?? "a4",
  });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "تعذر الحفظ");
      return j;
    },
    onSuccess: (data) => {
      if (setUser) {
        setUser((u: any) =>
          u
            ? {
                ...u,
                company: {
                  ...u.company,
                  printAutoAfterSaveSales:   data.printAutoAfterSaveSales,
                  printAutoAfterSaveReceipt: data.printAutoAfterSaveReceipt,
                  printAutoAfterSavePayment: data.printAutoAfterSavePayment,
                  printAutoAfterSaveJournal: data.printAutoAfterSaveJournal,
                  printTemplateSales:   data.printTemplateSales,
                  printTemplateReceipt: data.printTemplateReceipt,
                  printTemplatePayment: data.printTemplatePayment,
                  printTemplateJournal: data.printTemplateJournal,
                },
              }
            : u,
        );
      }
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: "تم حفظ إعدادات الطباعة" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <>
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base flex items-center gap-2">
            <Printer className="h-4 w-4 text-muted-foreground" />
            إعدادات الطباعة لكل مستند
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            اختر لكل نوع مستند ما إذا كنت تريد فتح نافذة الطباعة تلقائياً بعد الحفظ، وحدد نموذج الطباعة (ورقة A4 أو طابعة حرارية 80 ملم).
            عند تعطيل الطباعة التلقائية، تبقى الطباعة متاحة من زر منفصل في الشاشة المعنية.
          </p>
        </div>

        <div className="space-y-3">
          {ROWS.map((row) => (
            <div
              key={row.autoKey}
              className="grid grid-cols-1 md:grid-cols-[1fr_auto_220px] gap-4 items-center rounded-lg border bg-muted/30 p-4"
            >
              <div>
                <div className="font-semibold text-sm">{row.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{row.hint}</div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <span className="text-sm">طباعة تلقائية بعد الحفظ</span>
                <Switch
                  checked={!!form[row.autoKey]}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, [row.autoKey]: !!v }))}
                />
              </label>

              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">نموذج الطباعة</Label>
                <select
                  value={form[row.tplKey]}
                  onChange={(e) => setForm((p) => ({ ...p, [row.tplKey]: e.target.value }))}
                  className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="a4">ورقة A4</option>
                  <option value="thermal">طابعة حرارية 80 مم</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>

      <LocalPrinterCard />

      <div className="flex justify-end">
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? (
            <>
              <Loader2 className="h-4 w-4 ml-2 animate-spin" />
              جاري الحفظ...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 ml-2" />
              حفظ إعدادات الطباعة
            </>
          )}
        </Button>
      </div>
    </>
  );
}

// Per-device "preferred printer" card. The printer name is stored in
// localStorage, so it travels with the *machine* the user is on, not
// with the user account — letting the same admin run the front desk
// laptop and a back-office PC with two different printers. Browsers
// can't read the OS printer list directly (security), so the field is
// a hint that surfaces in pre-print toasts; the actual printer is
// chosen in the system print dialog when window.print() runs.
function LocalPrinterCard() {
  const { toast } = useToast();
  const [printer, setPrinter] = useState<string>(() => getPreferredPrinter());
  const [saved, setSaved] = useState<string>(() => getPreferredPrinter());
  const [detecting, setDetecting] = useState(false);
  const usbSupported = isWebUsbSupported();
  const dirty = printer.trim() !== saved.trim();

  function handleSave() {
    setPreferredPrinter(printer);
    setSaved(printer.trim());
    toast({
      title: printer.trim()
        ? `تم حفظ الطابعة "${printer.trim()}" لهذا الجهاز`
        : "تمت إزالة الطابعة المفضلة من هذا الجهاز",
    });
  }

  function handleTest() {
    const w = openPrinterTestSheet(saved || printer);
    if (!w) {
      toast({
        title: "تم منع النوافذ المنبثقة",
        description: "اسمح بفتح النوافذ المنبثقة من هذا الموقع لإجراء اختبار الطباعة.",
        variant: "destructive",
      });
    }
  }

  // Trigger the browser's USB-device chooser (filtered to printer
  // class) and pre-fill the input with the picked printer's name. We
  // do NOT auto-save — the user can review the suggested name and
  // hit "حفظ الطابعة" to commit it.
  async function handleAutoDetect() {
    if (!usbSupported) {
      toast({
        title: "هذا المتصفح لا يدعم الاكتشاف التلقائي",
        description: "ميزة الاكتشاف التلقائي تتطلب متصفح Chrome أو Edge أو Opera. يمكنك إدخال اسم الطابعة يدوياً.",
        variant: "destructive",
      });
      return;
    }
    setDetecting(true);
    try {
      const r = await detectUsbPrinter();
      if (r.ok) {
        setPrinter(r.name);
        toast({
          title: `تم اكتشاف الطابعة: ${r.name}`,
          description: "اضغط \"حفظ الطابعة\" لتثبيت الاسم لهذا الجهاز.",
        });
      } else if (r.reason === "cancelled") {
        // User closed the chooser; stay quiet.
      } else if (r.reason === "no-name") {
        toast({
          title: "تم اختيار الطابعة لكن دون اسم قابل للقراءة",
          description: "بعض الطابعات لا ترسل اسماً عبر USB. الرجاء إدخال الاسم يدوياً.",
          variant: "destructive",
        });
      } else if (r.reason === "unsupported") {
        toast({
          title: "هذا المتصفح لا يدعم الاكتشاف التلقائي",
          variant: "destructive",
        });
      } else {
        toast({
          title: "تعذّر اكتشاف الطابعة",
          description: r.message || "حدث خطأ غير متوقع. الرجاء إدخال الاسم يدوياً.",
          variant: "destructive",
        });
      }
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Printer className="h-4 w-4 text-muted-foreground" />
          الطابعة الافتراضية على هذا الجهاز
        </h2>
        <p className="text-xs text-muted-foreground mt-1 leading-6">
          سجِّل اسم الطابعة المتصلة بهذا الجهاز ليظهر كتذكير قبل كل عملية طباعة.
          يمكنك الضغط على <b>"اكتشاف تلقائي"</b> ليقوم المتصفح بقراءة اسم الطابعة
          الموصولة عبر USB (يتطلب موافقتك في نافذة المتصفح، ويعمل في Chrome/Edge/Opera
          ولا يلتقط الطابعات الشبكية)، أو أدخل الاسم يدوياً كما يظهر في نظام التشغيل.
          هذا الإعداد محفوظ على هذا الجهاز فقط، ولكل جهاز طابعته الخاصة.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">اسم الطابعة (كما يظهر في نظام التشغيل)</Label>
          <Input
            value={printer}
            onChange={(e) => setPrinter(e.target.value)}
            placeholder="مثال: HP LaserJet M1136 / EPSON TM-T20"
            dir="auto"
          />
        </div>
        <Button
          variant="secondary"
          onClick={handleAutoDetect}
          disabled={detecting || !usbSupported}
          className="gap-1.5"
          title={usbSupported
            ? "اكتشاف الطابعة المتصلة عبر USB"
            : "غير مدعوم في هذا المتصفح"}
        >
          <Zap className="h-4 w-4" />
          {detecting ? "جارٍ الاكتشاف..." : "اكتشاف تلقائي"}
        </Button>
        <Button onClick={handleSave} disabled={!dirty} className="gap-1.5">
          <Save className="h-4 w-4" />
          حفظ الطابعة
        </Button>
        <Button variant="outline" onClick={handleTest} className="gap-1.5">
          <Printer className="h-4 w-4" />
          اختبار الطباعة
        </Button>
      </div>

      {saved && (
        <div className="text-xs text-muted-foreground border-t pt-3">
          الطابعة المحفوظة لهذا الجهاز:{" "}
          <span className="font-semibold text-foreground">{saved}</span>
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Auto-Logout (idle timeout) tab ────────────────────────
//
// Lets the user enable an idle-timeout that automatically signs them out of
// the system after a configurable number of minutes with no activity. The
// setting is stored in localStorage (per-browser, per-device) so each
// workstation can have its own policy — a cashier on a shared POS machine
// can use 5 minutes while an accountant on a private laptop can disable it.
//
// The actual timer logic lives in `useIdleLogout` which is mounted in the
// global Layout. This component only edits the setting and previews how it
// will behave.
const PRESETS = [5, 10, 15, 30, 60, 120];

function AutoLogoutTab() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean>(() => getIdleLogoutMinutes() > 0);
  const [minutes, setMinutes] = useState<number>(() => {
    const m = getIdleLogoutMinutes();
    return m > 0 ? m : 15;
  });
  const [savedMinutes, setSavedMinutes] = useState<number>(() => getIdleLogoutMinutes());

  const onSave = () => {
    if (!enabled) {
      setIdleLogoutMinutes(0);
      setSavedMinutes(0);
      toast({ title: "تم الحفظ", description: "تم تعطيل تسجيل الخروج التلقائي." });
      return;
    }
    const m = Math.max(1, Math.min(720, Math.floor(Number(minutes) || 0)));
    setIdleLogoutMinutes(m);
    setMinutes(m);
    setSavedMinutes(m);
    toast({
      title: "تم الحفظ",
      description: `سيتم تسجيل خروجك تلقائياً بعد ${m} دقيقة من عدم النشاط.`,
    });
  };

  const isActive = savedMinutes > 0;

  return (
    <div className="space-y-6">
      {/* ─── Hero / Status card ──────────────────────────────────────────── */}
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border p-6 shadow-sm transition-colors",
          isActive
            ? "bg-gradient-to-br from-emerald-50 via-emerald-50/40 to-transparent border-emerald-200 dark:from-emerald-950/40 dark:via-emerald-950/20 dark:border-emerald-900/60"
            : "bg-gradient-to-br from-muted/40 to-transparent",
        )}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "h-12 w-12 rounded-xl flex items-center justify-center shrink-0 shadow-inner",
                isActive ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
              )}
            >
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h2 className="font-semibold text-lg leading-tight">تسجيل الخروج التلقائي عند عدم النشاط</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                أداة أمان تُسجّل خروجك تلقائياً من النظام عند عدم استخدام الفأرة أو لوحة المفاتيح لمدة محددة،
                لحماية بياناتك إذا تركت الجهاز مفتوحاً.
              </p>
              <div className="mt-3 inline-flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium",
                    isActive
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", isActive ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50")} />
                  {isActive ? `مفعّل — كل ${savedMinutes} دقيقة` : "معطّل"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="idle-toggle" className="text-sm font-medium">
              {enabled ? "مفعّل" : "معطّل"}
            </Label>
            <Switch id="idle-toggle" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
      </div>

      {/* ─── Configuration card ──────────────────────────────────────────── */}
      <div
        className={cn(
          "rounded-xl border bg-card p-5 space-y-5 transition-opacity",
          !enabled && "opacity-60 pointer-events-none",
        )}
      >
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-base">مدة عدم النشاط قبل تسجيل الخروج</h3>
        </div>

        {/* Quick presets */}
        <div>
          <Label className="text-xs text-muted-foreground mb-2 block">اختر مدة سريعة</Label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const selected = minutes === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setMinutes(p)}
                  className={cn(
                    "px-4 py-2 rounded-lg border text-sm font-medium transition-all",
                    selected
                      ? "bg-primary text-primary-foreground border-primary shadow-sm scale-[1.03]"
                      : "bg-background hover:bg-muted/60 border-border",
                  )}
                >
                  {p} دقيقة
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom input */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <Label htmlFor="idle-minutes" className="text-xs text-muted-foreground mb-1.5 block">
              أو أدخل مدة مخصّصة (بالدقائق، من 1 إلى 720)
            </Label>
            <div className="relative">
              <Input
                id="idle-minutes"
                type="number"
                min={1}
                max={720}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Math.min(720, Math.floor(Number(e.target.value) || 0))))}
                className="pe-20"
              />
              <span className="absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground pointer-events-none">
                دقيقة
              </span>
            </div>
          </div>
        </div>

        {/* Info notice */}
        <div className="flex gap-3 items-start text-xs text-muted-foreground bg-muted/40 rounded-lg p-3">
          <Clock className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>سيظهر لك تنبيه قبل 30 ثانية من تسجيل الخروج لمنحك فرصة للاستمرار.</p>
            <p>الإعداد يُحفظ على هذا الجهاز/المتصفح فقط، ويمكن لكل موظف ضبط مدة مختلفة على جهازه.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setEnabled(false);
            setIdleLogoutMinutes(0);
            setSavedMinutes(0);
            toast({ title: "تم الإلغاء", description: "تم تعطيل تسجيل الخروج التلقائي." });
          }}
        >
          تعطيل
        </Button>
        <Button onClick={onSave} className="gap-2">
          <Save className="h-4 w-4" />
          حفظ الإعداد
        </Button>
      </div>
    </div>
  );
}
