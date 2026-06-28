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
  LogOut, Timer, ShieldCheck, CalendarDays, CalendarClock,
  Users as UsersIcon, Percent, Calculator,
  Wand2, PanelTop, PanelRight, Scale,
  Archive, Cloud, HardDrive, Ban,
  LayoutTemplate, LayoutGrid, LayoutList
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { getIdleLogoutMinutes, setIdleLogoutMinutes } from "@/hooks/useIdleLogout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

// ─── Document-archiving control center ────────────────────────────────────
type ArchiveMode = "local" | "cloud" | "off";

// The screens that expose an "أرشفة مستند" button — keys MUST match the
// `screenKey` prop passed to <JournalScanArchive> in each form.
const ARCHIVE_SCREENS: { key: string; label: string }[] = [
  { key: "journal_entries",  label: "القيود المحاسبية" },
  { key: "sales_invoices",   label: "فواتير المبيعات" },
  { key: "purchase_invoices",label: "فواتير المشتريات" },
  { key: "receipt_vouchers", label: "سندات القبض" },
  { key: "payment_vouchers", label: "سندات الصرف" },
  { key: "customers",        label: "العملاء" },
  { key: "suppliers",        label: "الموردون" },
];

const ARCHIVE_MODES: { value: ArchiveMode; label: string; desc: string; icon: typeof Cloud }[] = [
  { value: "local", label: "محلي",   desc: "تُحفظ الملفات على جهاز المستخدم فقط", icon: HardDrive },
  { value: "cloud", label: "سحابي",  desc: "تُرفع الملفات إلى الخادم لكل الشركة", icon: Cloud },
  { value: "off",   label: "معطّل",  desc: "إخفاء زر الأرشفة في هذه الشاشة", icon: Ban },
];

// Company logos are stored as a base64 data URL inside companies.logo. A raw
// 2 MB upload becomes a ~2.7 MB base64 string, which the production ingress in
// front of the API can reject with an HTML error page (the client then chokes
// on "Unexpected token '<'" while parsing the response as JSON). A logo never
// needs that resolution, so we downscale it to a small canvas before saving —
// the resulting payload is a few tens of KB and passes any body-size limit.
async function downscaleLogo(file: File, maxDim = 512): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(file);
  });
  // SVG is vector + already tiny — rasterising would only hurt quality.
  if (file.type === "image/svg+xml") return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("decode failed"));
      im.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    // Preserve transparency for PNG/WebP; JPEG is smaller for everything else.
    const hasAlpha = file.type === "image/png" || file.type === "image/webp";
    const out = hasAlpha
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.9);
    // Never return something larger than the original (rare for tiny inputs).
    return out.length < dataUrl.length ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

// The production edge WAF rejects (403 + HTML page) any request body that
// contains a "data:<mime>;base64,<blob>" data-URI. Raw base64 WITHOUT the
// "data:" prefix passes through fine, so we split the data URL and send the
// raw base64 + mime separately; the server rebuilds the data URL before
// storing it, keeping the on-disk format (companies.logo) unchanged.
function splitDataUrl(dataUrl: string): { b64: string; mime: string } | null {
  const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png";
  const isB64 = !!m[2];
  try {
    const b64 = isB64 ? m[3] : btoa(unescape(decodeURIComponent(m[3])));
    return { b64, mime };
  } catch {
    return null;
  }
}

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
    { key: "autoPostJournalEntry", label: "القيود المحاسبية",         desc: "ترحيل القيد اليدوي تلقائياً عند الحفظ (إن كان متوازناً)" },
    { key: "autoPostSales",        label: "فواتير المبيعات",          desc: "ترحيل قيد فاتورة المبيعات تلقائياً عند الحفظ" },
    { key: "autoPostPurchase",     label: "فواتير المشتريات",         desc: "ترحيل قيد فاتورة الشراء تلقائياً عند الحفظ" },
    { key: "autoPostReceipt",      label: "سندات القبض",              desc: "ترحيل قيد سند القبض تلقائياً عند الحفظ" },
    { key: "autoPostPayment",      label: "سندات الصرف",              desc: "ترحيل قيد سند الصرف تلقائياً عند الحفظ" },
    { key: "autoPostFinancial",    label: "العمليات المالية",         desc: "ترحيل قيد العملية المالية تلقائياً عند الحفظ" },
    { key: "autoPostCashTransfer", label: "تحويلات الخزائن والبنوك",  desc: "ترحيل قيد تحويل النقدية تلقائياً عند الحفظ" },
    { key: "autoPostPayroll",      label: "الرواتب",                  desc: "ترحيل قيد الراتب تلقائياً عند الاحتساب" },
    // ─── Phase-1 additions: every other JE-producing module ─────────────
    { key: "autoPostProduction",    label: "أوامر الإنتاج",            desc: "ترحيل قيود الصرف للإنتاج وقيد إنتاج التام تلقائياً" },
    { key: "autoPostStockMovement", label: "حركات المخزون",            desc: "ترحيل قيود التحويلات والتسويات المخزنية تلقائياً" },
    { key: "autoPostGoodsReceipt",  label: "إذونات الاستلام (GRN)",     desc: "ترحيل قيد استلام البضاعة من المورد تلقائياً" },
    { key: "autoPostGoodsDelivery", label: "إذونات التسليم",           desc: "ترحيل قيد تكلفة البضاعة المباعة عند التسليم تلقائياً" },
    { key: "autoPostAdjustment",    label: "التسويات الشهرية",         desc: "ترحيل قيود التسويات (مصروف مقدم/مستحق) تلقائياً" },
    { key: "autoPostFaAcquisition", label: "اقتناء الأصول الثابتة",     desc: "ترحيل قيد اقتناء الأصل (مدين أصل/دائن نقدية أو مورد) تلقائياً" },
    { key: "autoPostFaDepreciation", label: "إهلاك الأصول الثابتة",      desc: "ترحيل قيد الإهلاك الشهري (مدين مصروف إهلاك/دائن مجمع إهلاك) تلقائياً" },
    { key: "autoPostFaDisposal",    label: "استبعاد الأصول الثابتة",   desc: "ترحيل قيد البيع/التخريد مع الربح/الخسارة الرأسمالية تلقائياً" },
    // ─── Phase-3 additions: Contracting (IFRS 15) ───────────────────────
    { key: "autoPostCtgOutgoingBill", label: "مستخلصات العملاء (مقاولات)", desc: "ترحيل قيد إيراد المستخلص للمالك مع المحتجزات وضريبة المخرجات تلقائياً عند الاعتماد" },
    { key: "autoPostCtgIncomingBill", label: "مستخلصات الباطن (مقاولات)",  desc: "ترحيل قيد تكلفة مستخلص الباطن مع المحتجزات وضريبة المدخلات تلقائياً عند الاعتماد" },
  ];

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const saveMutation = useMutation({
    mutationFn: async (payload: { logo?: string | null; decimalPlaces?: number }) => {
      const cid = user?.company?.id ?? user?.companyId;
      // Send the logo as raw base64 (+ mime) rather than a "data:" URL so the
      // production edge WAF doesn't reject the request with a 403 HTML page.
      const body: Record<string, any> = { decimalPlaces: payload.decimalPlaces };
      if (payload.logo === null) {
        body.logoBase64 = null;
      } else if (typeof payload.logo === "string") {
        const parts = splitDataUrl(payload.logo);
        if (parts) {
          body.logoBase64 = parts.b64;
          body.logoMime = parts.mime;
        } else {
          // Unexpected non-data-URL value — preserve it via the legacy `logo`
          // field rather than silently clearing the logo.
          body.logo = payload.logo;
        }
      }
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      // The server may return a non-JSON error page (e.g. the ingress rejecting
      // an oversized body with an HTML 413). Read text first so we surface a
      // clear message instead of a cryptic "Unexpected token '<'".
      const raw = await res.text();
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(
          res.ok
            ? t("pages.generalSettings.saveFailed")
            : `تعذّر حفظ الإعدادات: ردّ الخادم برمز ${res.status}. قد يكون حجم الشعار كبيراً جداً — جرّب صورة أصغر.`,
        );
      }
      if (!res.ok) throw new Error(json?.error ?? t("pages.generalSettings.saveFailed"));
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

  const processFile = useCallback(async (file: File) => {
    setLogoError("");
    if (!file.type.startsWith("image/")) {
      setLogoError(t("pages.generalSettings.invalidFileType")); return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError(t("pages.generalSettings.fileTooLarge")); return;
    }
    try {
      setLogo(await downscaleLogo(file));
    } catch {
      setLogoError(t("pages.generalSettings.invalidFileType"));
    }
  }, [t]);

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
    // Final guard regardless of how the logo was produced (downscale fallback,
    // raw SVG passthrough, restored value). Keeps the saved base64 well under
    // any ingress body limit so the save never bounces with an HTML error page.
    if (logo && logo.length > 700_000) {
      setLogoError(t("pages.generalSettings.fileTooLarge"));
      toast({ title: t("pages.generalSettings.fileTooLarge"), variant: "destructive" });
      return;
    }
    saveMutation.mutate({ logo: logo ?? null, decimalPlaces: decimals });
  };

  // ─── Auto-posting toggle (saves immediately on toggle) ────────────────────
  // Generic patcher: accepts ANY subset of the posting flags and PATCHes
  // them to the server in one request. Used by both the master switch
  // (autoPostingEnabled) and the per-doc-type toggles below so we keep a
  // single network/error path.
  async function togglePostingMode(payload: Record<string, any>) {
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

  // ─── Document-archiving control center state ──────────────────────────────
  const isArchiveAdmin = user?.role === "admin" || user?.role === "superadmin";
  const archiveKey = JSON.stringify(user?.company?.archiveSettings ?? null);
  const [archiveDefaultMode, setArchiveDefaultMode] = useState<ArchiveMode>("local");
  const [archiveScreens, setArchiveScreens] = useState<Record<string, ArchiveMode>>({});
  const [archiveAllowed, setArchiveAllowed] = useState<number[]>([]);
  // Re-hydrate the editable copy whenever the persisted settings change
  // (initial load AND after a successful save, which echoes the new row).
  useEffect(() => {
    const s = (user?.company?.archiveSettings ?? {}) as {
      defaultMode?: ArchiveMode; screens?: Record<string, ArchiveMode>; allowedUserIds?: number[];
    };
    setArchiveDefaultMode(s.defaultMode ?? "local");
    setArchiveScreens(s.screens && typeof s.screens === "object" ? s.screens : {});
    setArchiveAllowed(Array.isArray(s.allowedUserIds) ? s.allowedUserIds : []);
  }, [archiveKey]);
  const { data: archiveUsers = [] } = useQuery<any[]>({
    queryKey: ["users", "archive-allowed"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/users`, { headers });
      if (!res.ok) return [];
      const d = await res.json();
      return Array.isArray(d) ? d : [];
    },
    enabled: isArchiveAdmin,
  });
  const archiveBaseline = (user?.company?.archiveSettings ?? {}) as {
    defaultMode?: ArchiveMode; screens?: Record<string, ArchiveMode>; allowedUserIds?: number[];
  };
  const sortNums = (a: number[]) => [...a].sort((x, y) => x - y);
  const archiveDirty =
    archiveDefaultMode !== (archiveBaseline.defaultMode ?? "local") ||
    JSON.stringify(archiveScreens) !== JSON.stringify(archiveBaseline.screens ?? {}) ||
    JSON.stringify(sortNums(archiveAllowed)) !==
      JSON.stringify(sortNums(Array.isArray(archiveBaseline.allowedUserIds) ? archiveBaseline.allowedUserIds : []));

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
      {
        const errCount = j.errors?.length || 0;
        const key = errCount > 0 ? "pages.generalSettings.itemsImportReportWithErrors" : "pages.generalSettings.itemsImportReport";
        toast({ title: t(key, { created: j.created, updated: j.updated, errors: errCount }) });
      }
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
      {
        const errCount = j.errors?.length || 0;
        const key = errCount > 0 ? "pages.generalSettings.balancesImportReportWithErrors" : "pages.generalSettings.balancesImportReport";
        toast({ title: t(key, { applied: j.applied, errors: errCount }) });
      }
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    } finally {
      setBalancesImporting(false);
    }
  }

  // ─── Party Master Data (Customers + Suppliers) ───────────────────────────
  const custDataFileRef = useRef<HTMLInputElement>(null);
  const suppDataFileRef = useRef<HTMLInputElement>(null);
  const [custDataImporting, setCustDataImporting] = useState(false);
  const [custAllowDuplicates, setCustAllowDuplicates] = useState(false);
  const [suppDataImporting, setSuppDataImporting] = useState(false);
  type DataReport = { created: number; updated: number; total: number; errors: { row: number; error: string }[] } | null;
  const [custDataReport, setCustDataReport] = useState<DataReport>(null);
  const [suppDataReport, setSuppDataReport] = useState<DataReport>(null);

  function downloadCustomersDataTemplate() {
    const headers = ["nameAr","nameEn","vatNumber","crNumber","email","phone","city","district","street","buildingNumber","postalCode","country","creditLimit","paymentTermsDays","branch","accountNumber"];
    const example = [
      ["شركة الأفق التجارية","Horizon Trading Co","300000000000003","1010000000","info@horizon.sa","0501234567","الرياض","العليا","طريق الملك فهد","1234","12345","SA",50000,30,"الفرع الرئيسي","10005"],
      ["مؤسسة النور","Al Noor Est","","","sales@noor.sa","0559876543","جدة","","","","","SA","",0,"فرع جدة",""],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customers");
    XLSX.writeFile(wb, "customers_data_template.xlsx");
  }

  function downloadSuppliersDataTemplate() {
    const headers = ["code","nameAr","nameEn","vatNumber","crNumber","email","phone","city","district","street","buildingNumber","postalCode","country","currencyCode","creditLimit","accountNumber"];
    const example = [
      ["SUP-001","شركة الإمداد","Supply Co","310000000000003","2050000000","po@supply.sa","0501112222","الدمام","","","","","SA","SAR",100000,"21010"],
      ["SUP-002","مصنع الرواد","Pioneers Factory","","","","","الرياض","","","","","SA","SAR","",""],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Suppliers");
    XLSX.writeFile(wb, "suppliers_data_template.xlsx");
  }

  async function handlePartyDataUpload(party: "customer" | "supplier", file: File) {
    const setImporting = party === "customer" ? setCustDataImporting : setSuppDataImporting;
    const setReport    = party === "customer" ? setCustDataReport : setSuppDataReport;
    setImporting(true);
    setReport(null);
    try {
      const rows = await parseExcelToObjects(file);
      if (!rows.length) throw new Error(t("pages.generalSettings.emptyFileError"));
      const cid = user?.company?.id ?? user?.companyId;
      const url = party === "customer"
        ? `${API}/api/customers/import?companyId=${cid}`
        : `${API}/api/suppliers/import?companyId=${cid}`;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ rows, allowDuplicates: party === "customer" ? custAllowDuplicates : false }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.importFailed"));
      setReport(j);
      const errCount = j.errors?.length || 0;
      const key = errCount > 0 ? "pages.generalSettings.itemsImportReportWithErrors" : "pages.generalSettings.itemsImportReport";
      toast({ title: t(key, { created: j.created, updated: j.updated, errors: errCount }) });
      qc.invalidateQueries({ queryKey: [party === "customer" ? "customers" : "suppliers"] });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  // ─── Party Opening Balances (Customers + Suppliers) ──────────────────────
  const custOBFileRef = useRef<HTMLInputElement>(null);
  const suppOBFileRef = useRef<HTMLInputElement>(null);
  const [custOBImporting, setCustOBImporting] = useState(false);
  const [suppOBImporting, setSuppOBImporting] = useState(false);
  type OBReport = { applied: number; total: number; errors: { row: number; error: string }[]; docNumber?: string | null } | null;
  const [custOBReport, setCustOBReport] = useState<OBReport>(null);
  const [suppOBReport, setSuppOBReport] = useState<OBReport>(null);

  function coerceList(j: any): any[] {
    if (Array.isArray(j)) return j;
    return j?.items ?? j?.rows ?? j?.data ?? [];
  }

  async function downloadPartyOBTemplate(party: "customer" | "supplier") {
    try {
      const cid = user?.company?.id ?? user?.companyId;
      const url = party === "customer" ? `${API}/api/customers?companyId=${cid}` : `${API}/api/suppliers?companyId=${cid}`;
      const res = await fetch(url, { headers });
      const list = coerceList(await res.json().catch(() => []));
      const defType = party === "customer" ? "مدين" : "دائن";
      const head = ["id", "name", "balance", "type"];
      const body = list.map((p: any) => [p.id, p.nameAr ?? p.name ?? "", "", defType]);
      const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
      ws["!cols"] = [{ wch: 8 }, { wch: 32 }, { wch: 14 }, { wch: 10 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, party === "customer" ? "Customers" : "Suppliers");
      XLSX.writeFile(wb, party === "customer" ? "customers_opening_balances.xlsx" : "suppliers_opening_balances.xlsx");
    } catch (e: any) {
      toast({ title: e?.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    }
  }

  async function handlePartyOBUpload(party: "customer" | "supplier", file: File) {
    const setImporting = party === "customer" ? setCustOBImporting : setSuppOBImporting;
    const setReport = party === "customer" ? setCustOBReport : setSuppOBReport;
    setImporting(true);
    setReport(null);
    try {
      const rows = await parseExcelToObjects(file);
      if (!rows.length) throw new Error(t("pages.generalSettings.emptyFileError"));
      const cid = user?.company?.id ?? user?.companyId;
      const endpoint = party === "customer"
        ? `${API}/api/customers/import/opening-balances?companyId=${cid}`
        : `${API}/api/suppliers/import/opening-balances?companyId=${cid}`;
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ rows }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t("pages.generalSettings.importFailed"));
      setReport(j);
      {
        const errCount = j.errors?.length || 0;
        const key = errCount > 0 ? "pages.generalSettings.partyOBReportWithErrors" : "pages.generalSettings.partyOBReport";
        toast({ title: t(key, { applied: j.applied, errors: errCount }) });
      }
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      qc.invalidateQueries({ queryKey: [party === "customer" ? "customers" : "suppliers"] });
    } catch (e: any) {
      toast({ title: e.message || t("pages.generalSettings.importFailed"), variant: "destructive" });
    } finally {
      setImporting(false);
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
    <div className="space-y-6 w-full max-w-6xl mx-auto" dir="rtl">

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
            value="customersOB"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <UsersIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.customersOBTab")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="suppliersOB"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Building2 className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.suppliersOBTab")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="customersData"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <UsersIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.customersDataTab")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="suppliersData"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Building2 className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("pages.generalSettings.suppliersDataTab")}</span>
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
          <TabsTrigger
            value="journalEntryMode"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Save className="h-4 w-4 shrink-0" />
            <span className="truncate">نظام إدخال القيود</span>
          </TabsTrigger>
          <TabsTrigger
            value="sequenceDate"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <CalendarDays className="h-4 w-4 shrink-0" />
            <span className="truncate">تاريخ المسلسل</span>
          </TabsTrigger>
          <TabsTrigger
            value="taxMode"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Percent className="h-4 w-4 shrink-0" />
            <span className="truncate">طريقة حساب الضريبة</span>
          </TabsTrigger>
          <TabsTrigger
            value="salesReturnsRules"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Repeat className="h-4 w-4 shrink-0" />
            <span className="truncate">إعدادات مرتجعات المبيعات</span>
          </TabsTrigger>
          <TabsTrigger
            value="smartJournal"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <Wand2 className="h-4 w-4 shrink-0" />
            <span className="truncate">شكل القيد النموذجي</span>
          </TabsTrigger>
          <TabsTrigger
            value="menuLayout"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <PanelTop className="h-4 w-4 shrink-0" />
            <span className="truncate">موضع القوائم</span>
          </TabsTrigger>
          <TabsTrigger
            value="invoiceFormLayout"
            className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
          >
            <LayoutTemplate className="h-4 w-4 shrink-0" />
            <span className="truncate">طريقة عرض الفواتير</span>
          </TabsTrigger>
          {isArchiveAdmin && (
            <TabsTrigger
              value="documentArchive"
              className="flex-1 min-w-[150px] h-10 gap-2 px-4 rounded-lg text-sm font-medium transition-all hover:bg-background/70 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.02]"
            >
              <Archive className="h-4 w-4 shrink-0" />
              <span className="truncate">أرشفة المستندات</span>
            </TabsTrigger>
          )}
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
            onCheckedChange={(v) => {
              // Cascade: the master switch acts as a "select all / unselect all"
              // for every per-doc-type flag so the user doesn't have to flip
              // 18 toggles one-by-one. ON unblocks every module from posting,
              // OFF blocks every module — exactly how the user described it.
              const next = !!v;
              const payload: Record<string, boolean> = { autoPostingEnabled: next };
              for (const dt of POST_DOC_TYPES) payload[dt.key] = next;
              togglePostingMode(payload);
            }}
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

      {/* ── سياسة حفظ فواتير المبيعات (السماح بالحفظ كمسودة بدون مستودع) ── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Calculator className="h-4 w-4 text-muted-foreground" />
          سياسة حفظ فواتير المبيعات
        </h2>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">
              {user?.company?.allowDraftWithoutWarehouse === true
                ? "السماح بالحفظ كمسودة بدون مستودع"
                : "إلزام تحديد المستودع (الوضع الافتراضي)"}
            </Label>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-prose">
              عند التفعيل، يمكن حفظ فاتورة المبيعات كـ«مسودة» حتى لو لم يُحدَّد
              مستودع لأصنافها، ولن يتم ترحيلها تلقائياً — يظهر تنبيه بأنها حُفظت
              كمسودة. لترحيلها لاحقاً اختر المستودع ثم احفظ الفاتورة مرة أخرى.
              عند الإيقاف (الوضع الافتراضي) يبقى السلوك كما هو: المستودع مطلوب
              لترحيل الفاتورة.
            </p>
          </div>
          <Switch
            checked={user?.company?.allowDraftWithoutWarehouse === true}
            disabled={postingSaving}
            onCheckedChange={(v) => togglePostingMode({ allowDraftWithoutWarehouse: v })}
          />
        </div>
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

        {/* ═══ TAB: Customers Opening Balances ═══════════════════════════════ */}
        <TabsContent value="customersOB" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
              <UsersIcon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.customersOBTitle")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">id, name, balance, type</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.partyOBNote")}</p>
              <p className="text-[11px] text-amber-700 dark:text-amber-500 mt-1 flex items-start gap-1">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{t("pages.generalSettings.partyOBReplaceNote")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => downloadPartyOBTemplate("customer")} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplateWithData")}
            </Button>
            <Button type="button" size="sm" onClick={() => custOBFileRef.current?.click()} disabled={custOBImporting} className="gap-1.5 bg-indigo-600 hover:bg-indigo-700">
              {custOBImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {custOBImporting ? t("common.loading") : t("pages.generalSettings.uploadCustomersOB")}
            </Button>
            <input
              ref={custOBFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePartyOBUpload("customer", f); e.target.value = ""; }}
            />
          </div>
          {custOBReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-indigo-600">{custOBReport.applied} {t("pages.generalSettings.partyOBApplied")}</span> / {custOBReport.total}
                {custOBReport.docNumber ? <span className="text-muted-foreground"> · {t("pages.generalSettings.partyOBEntryNo")}: <span className="font-mono" dir="ltr">{custOBReport.docNumber}</span></span> : null}
                {custOBReport.errors?.length ? <span className="text-red-600"> · {custOBReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {custOBReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {custOBReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        </TabsContent>

        {/* ═══ TAB: Suppliers Opening Balances ═══════════════════════════════ */}
        <TabsContent value="suppliersOB" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.suppliersOBTitle")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">id, name, balance, type</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.partyOBNote")}</p>
              <p className="text-[11px] text-amber-700 dark:text-amber-500 mt-1 flex items-start gap-1">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{t("pages.generalSettings.partyOBReplaceNote")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => downloadPartyOBTemplate("supplier")} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplateWithData")}
            </Button>
            <Button type="button" size="sm" onClick={() => suppOBFileRef.current?.click()} disabled={suppOBImporting} className="gap-1.5 bg-rose-600 hover:bg-rose-700">
              {suppOBImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {suppOBImporting ? t("common.loading") : t("pages.generalSettings.uploadSuppliersOB")}
            </Button>
            <input
              ref={suppOBFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePartyOBUpload("supplier", f); e.target.value = ""; }}
            />
          </div>
          {suppOBReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-rose-600">{suppOBReport.applied} {t("pages.generalSettings.partyOBApplied")}</span> / {suppOBReport.total}
                {suppOBReport.docNumber ? <span className="text-muted-foreground"> · {t("pages.generalSettings.partyOBEntryNo")}: <span className="font-mono" dir="ltr">{suppOBReport.docNumber}</span></span> : null}
                {suppOBReport.errors?.length ? <span className="text-red-600"> · {suppOBReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {suppOBReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {suppOBReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        </TabsContent>

        {/* ═══ TAB: Customers Master Data ════════════════════════════════════ */}
        <TabsContent value="customersData" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
              <UsersIcon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.customersDataTitle")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">nameAr, nameEn, vatNumber, crNumber, email, phone, city, district, street, buildingNumber, postalCode, country, creditLimit, paymentTermsDays, branch, accountNumber</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.partyDataNote")}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.customerAccountNote")}</p>
            </div>
          </div>
          <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">{t("pages.generalSettings.dupModeTitle")}</p>
            <div className="grid sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCustAllowDuplicates(false)}
                className={cn("text-start p-2.5 border rounded-lg transition-all", !custAllowDuplicates ? "ring-2 ring-indigo-500 border-indigo-500 bg-indigo-50" : "hover:bg-muted/40")}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-medium">{t("pages.generalSettings.dupModePreventTitle")}</span>
                  {!custAllowDuplicates && <CheckCircle2 className="h-3.5 w-3.5 text-indigo-600 shrink-0" />}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("pages.generalSettings.dupModePreventDesc")}</p>
              </button>
              <button
                type="button"
                onClick={() => setCustAllowDuplicates(true)}
                className={cn("text-start p-2.5 border rounded-lg transition-all", custAllowDuplicates ? "ring-2 ring-indigo-500 border-indigo-500 bg-indigo-50" : "hover:bg-muted/40")}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-medium">{t("pages.generalSettings.dupModeAllowTitle")}</span>
                  {custAllowDuplicates && <CheckCircle2 className="h-3.5 w-3.5 text-indigo-600 shrink-0" />}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("pages.generalSettings.dupModeAllowDesc")}</p>
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadCustomersDataTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplate")}
            </Button>
            <Button type="button" size="sm" onClick={() => custDataFileRef.current?.click()} disabled={custDataImporting} className="gap-1.5 bg-indigo-600 hover:bg-indigo-700">
              {custDataImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {custDataImporting ? t("common.loading") : t("pages.generalSettings.uploadCustomersDataFile")}
            </Button>
            <input
              ref={custDataFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePartyDataUpload("customer", f); e.target.value = ""; }}
            />
          </div>
          {custDataReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-green-600">{custDataReport.created} {t("pages.generalSettings.added")}</span> · <span className="text-blue-600">{custDataReport.updated} {t("pages.generalSettings.updated")}</span> / {custDataReport.total}
                {custDataReport.errors?.length ? <span className="text-red-600"> · {custDataReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {custDataReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {custDataReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        </TabsContent>

        {/* ═══ TAB: Suppliers Master Data ════════════════════════════════════ */}
        <TabsContent value="suppliersData" className="mt-5">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">{t("pages.generalSettings.suppliersDataTitle")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("pages.generalSettings.columns")}: <span className="font-mono" dir="ltr">code, nameAr, nameEn, vatNumber, crNumber, email, phone, city, district, street, buildingNumber, postalCode, country, currencyCode, creditLimit, accountNumber</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.partyDataNote")}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t("pages.generalSettings.supplierAccountNote")}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadSuppliersDataTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{t("pages.generalSettings.downloadTemplate")}
            </Button>
            <Button type="button" size="sm" onClick={() => suppDataFileRef.current?.click()} disabled={suppDataImporting} className="gap-1.5 bg-amber-600 hover:bg-amber-700">
              {suppDataImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {suppDataImporting ? t("common.loading") : t("pages.generalSettings.uploadSuppliersDataFile")}
            </Button>
            <input
              ref={suppDataFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePartyDataUpload("supplier", f); e.target.value = ""; }}
            />
          </div>
          {suppDataReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {t("pages.generalSettings.result")}: <span className="text-green-600">{suppDataReport.created} {t("pages.generalSettings.added")}</span> · <span className="text-blue-600">{suppDataReport.updated} {t("pages.generalSettings.updated")}</span> / {suppDataReport.total}
                {suppDataReport.errors?.length ? <span className="text-red-600"> · {suppDataReport.errors.length} {t("pages.generalSettings.error")}</span> : null}
              </p>
              {suppDataReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {suppDataReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>{t("pages.generalSettings.line")} {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        </TabsContent>

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

          {/* ── إظهار/إخفاء الصفر في حقول الإدخال الرقمية (عرض فقط) ── */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Calculator className="h-4 w-4 text-muted-foreground" />
              إظهار الصفر في حقول الإدخال
            </h2>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  {user?.company?.showZeros === true ? "عرض الصفر" : "إخفاء الصفر"}
                </Label>
                <p className="text-xs text-muted-foreground leading-relaxed max-w-prose">
                  عند الإيقاف (الوضع الافتراضي) تظهر الحقول الرقمية التي قيمتها صفر فارغةً
                  مع علامة <span className="font-mono text-muted-foreground/70">0</span> باهتة
                  بدلاً من إظهار الرقم «0». هذا تغيير شكلي فقط — لا يؤثر على القيم المحفوظة
                  أو الحسابات أو التقارير إطلاقاً.
                </p>
              </div>
              <Switch
                checked={user?.company?.showZeros === true}
                disabled={postingSaving}
                onCheckedChange={(v) => togglePostingMode({ showZeros: v })}
              />
            </div>
            <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm flex items-center gap-3">
              <span className="text-muted-foreground">مثال:</span>
              <span className="font-mono">الكمية</span>
              {user?.company?.showZeros === true ? (
                <span className="inline-flex h-9 w-28 items-center rounded-md border bg-transparent px-3 font-mono">0</span>
              ) : (
                <span className="inline-flex h-9 w-28 items-center rounded-md border bg-transparent px-3 font-mono text-muted-foreground/50">0</span>
              )}
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

        {/* ═══ TAB 10: Journal-Entry Form Mode (Auto vs Manual) ═════════════ */}
        <TabsContent value="journalEntryMode" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Save className="h-4 w-4 text-muted-foreground" />
              نظام إدخال القيود المحاسبية
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              تحكّم في سلوك شاشة "قيد جديد" بعد حفظ القيد بنجاح.
              {" "}<span className="font-medium text-foreground">آلي (الافتراضي):</span> تبقى الشاشة مفتوحة وتُجهَّز تلقائياً لإدخال القيد التالي بأسرع ما يمكن.
              {" "}<span className="font-medium text-foreground">يدوي (النظام القديم):</span> تُغلق الشاشة تلقائياً وترجع لقائمة القيود المحاسبية بعد كل حفظ.
            </p>

            {(() => {
              const mode = (user?.company?.journalEntryFormMode === "manual") ? "manual" : "auto";
              const isAuto = mode === "auto";
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* AUTO card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ journalEntryFormMode: "auto" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        isAuto
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-journal-mode-auto"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          isAuto ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <Zap className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">آلي (الحالي)</span>
                        {isAuto && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        تبقى شاشة القيد مفتوحة بعد الحفظ، وتُفرَّغ الحقول تلقائياً مع حجز الرقم التسلسلي التالي — مثالي للإدخال المتسلسل السريع.
                      </p>
                    </button>

                    {/* MANUAL card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ journalEntryFormMode: "manual" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        !isAuto
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-journal-mode-manual"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          !isAuto ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <Hand className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">يدوي (النظام القديم)</span>
                        {!isAuto && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-amber-50 text-amber-700 border-amber-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        تُغلق شاشة القيد بعد الحفظ مباشرة وترجع لقائمة القيود المحاسبية — السلوك القديم قبل التحديث.
                      </p>
                    </button>
                  </div>

                  {postingSaving && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      جارٍ الحفظ…
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB 11: Sequence Date Source (System vs Document) ═════════════ */}
        <TabsContent value="sequenceDate" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              مصدر التاريخ في الأرقام التسلسلية للمستندات
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              يحدّد هذا الإعداد من أين يقرأ الـ <code className="font-mono text-[11px]">{"{MM}"}</code> /
              {" "}<code className="font-mono text-[11px]">{"{YY}"}</code> /
              {" "}<code className="font-mono text-[11px]">{"{YYYY}"}</code> في نمط المسلسل عند إصدار رقم مستند جديد
              (قيد محاسبي، فاتورة بيع/شراء، سند قبض/صرف، إذن تسليم/استلام…).
              {" "}<span className="font-medium text-foreground">تاريخ النظام (الافتراضي):</span> يستخدم تاريخ اليوم وقت الحفظ.
              {" "}<span className="font-medium text-foreground">تاريخ المستند:</span> يستخدم التاريخ الذي أدخله المستخدم على المستند نفسه — لذا قيد بتاريخ 1-1-2026 يصدر برقم شهر <span className="font-mono">01</span> حتى لو حُفظ في مايو.
            </p>

            {(() => {
              const src = (user?.company?.sequenceDateSource === "document") ? "document" : "system";
              const isSystem = src === "system";
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* SYSTEM card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ sequenceDateSource: "system" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        isSystem
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-sequence-date-system"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          isSystem ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <CalendarClock className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">تاريخ النظام (الافتراضي)</span>
                        {isSystem && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        يقرأ شهر وسنة الرقم التسلسلي من تاريخ اليوم الحالي وقت الحفظ — السلوك التقليدي.
                      </p>
                    </button>

                    {/* DOCUMENT card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ sequenceDateSource: "document" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        !isSystem
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-sequence-date-document"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          !isSystem ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <CalendarDays className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">تاريخ المستند</span>
                        {!isSystem && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-amber-50 text-amber-700 border-amber-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        يقرأ شهر وسنة الرقم من التاريخ المُدخل على المستند — مفيد للقيود الرجعية ومستندات الفترات السابقة.
                      </p>
                    </button>
                  </div>

                  {postingSaving && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      جارٍ الحفظ…
                    </p>
                  )}

                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900 leading-relaxed">
                    <strong>ملاحظة:</strong> يؤثّر هذا الإعداد فقط على المسلسلات التي تحتوي نمطها على
                    {" "}<code className="font-mono">{"{MM}"}</code> أو
                    {" "}<code className="font-mono">{"{YY}"}</code> /
                    {" "}<code className="font-mono">{"{YYYY}"}</code>.
                    العدّاد الرقمي نفسه لا يُعاد تصفيره شهرياً — يبقى يتصاعد كما هو معرّف في إعدادات المسلسلات.
                  </div>
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB: Sales-Returns rules (informational, always-on) ═══════ */}
        <TabsContent value="salesReturnsRules" className="mt-5 space-y-6">
          <SalesReturnsUserFilterCard user={user} token={token} />
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Repeat className="h-4 w-4 text-muted-foreground" />
              قواعد مرتجعات المبيعات
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              القواعد التالية مفعَّلة افتراضياً على جميع مرتجعات المبيعات في النظام لضمان دقة المخزون والمحاسبة.
              لا توجد إعدادات قابلة للتعديل حالياً — هذا التاب محجوز لإعدادات مستقبلية يمكن للشركة تخصيصها.
            </p>
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-start gap-2.5 rounded-lg border bg-background p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">الشرح (الملاحظات) إلزامي</p>
                  <p className="text-xs text-muted-foreground">لا يمكن حفظ مرتجع بدون شرح يوضح سبب الإرجاع.</p>
                </div>
              </li>
              <li className="flex items-start gap-2.5 rounded-lg border bg-background p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">سقف كمية المرتجع = كمية البيع</p>
                  <p className="text-xs text-muted-foreground">عند ربط المرتجع بفاتورة مصدر، لا يمكن إرجاع كمية تتجاوز ما تم بيعه فعلياً لكل صنف (مع احتساب المرتجعات السابقة).</p>
                </div>
              </li>
              <li className="flex items-start gap-2.5 rounded-lg border bg-background p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">الكمية والوحدة الرئيسية إلزاميتان</p>
                  <p className="text-xs text-muted-foreground">يجب أن يحتوي كل سطر على كمية أكبر من صفر ووحدة رئيسية محدّدة قبل الحفظ.</p>
                </div>
              </li>
              <li className="flex items-start gap-2.5 rounded-lg border bg-background p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">اختيار جزئي للأصناف من الفاتورة المصدر</p>
                  <p className="text-xs text-muted-foreground">عند تحميل فاتورة مصدر، تُعرض نافذة لاختيار الأصناف المراد إرجاعها فقط بدلاً من نسخ كل أسطر الفاتورة تلقائياً.</p>
                </div>
              </li>
            </ul>
          </div>
        </TabsContent>

        {/* ═══ TAB: Tax Calculation Mode (before/after discount) ════════════ */}
        <TabsContent value="taxMode" className="mt-5 space-y-6">
          <TaxCalculationModeCard
            current={(user?.company?.taxCalculationMode as ("before_discount" | "after_discount" | undefined)) ?? "after_discount"}
            saving={postingSaving}
            onChange={(v) => togglePostingMode({ taxCalculationMode: v })}
          />
        </TabsContent>

        {/* ═══ TAB: Smart "Model" Journal-Entry Form ════════════════════════ */}
        <TabsContent value="smartJournal" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-muted-foreground" />
              شكل القيد النموذجي
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              عند التفعيل، تعمل شاشة "قيد جديد" بأسلوب ذكي: عند إضافة سطر جديد يقوم النظام تلقائياً
              بملء الطرف المقابل (مدين/دائن) بقيمة الفرق المتبقي ليبقى القيد متوازناً —
              مع مؤشر فرق لحظي وزر "موازنة تلقائية" وزر إضافة سطر إضافي أسفل الجدول.
              تبقى كل القيم قابلة للتعديل يدوياً.
            </p>

            {(() => {
              const on = !!user?.company?.journalSmartForm;
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* ON card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ journalSmartForm: true })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        on
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-smart-journal-on"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <Wand2 className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">مفعَّل (الشكل النموذجي الذكي)</span>
                        {on && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        إدخال أسرع للقيود — يملأ النظام الطرف المقابل تلقائياً بقيمة الفرق ليبقى القيد متوازناً، مع زر موازنة تلقائية ومؤشر فرق لحظي.
                      </p>
                    </button>

                    {/* OFF card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ journalSmartForm: false })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        !on
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-smart-journal-off"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          !on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <Hand className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">معطَّل (الشكل العادي)</span>
                        {!on && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-amber-50 text-amber-700 border-amber-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        شاشة القيد العادية بدون موازنة تلقائية — تُدخل قيم المدين والدائن يدوياً في كل سطر.
                      </p>
                    </button>
                  </div>

                  {postingSaving && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      جارٍ الحفظ…
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB: Menu Placement (sidebar vs top horizontal nav) ══════════ */}
        <TabsContent value="menuLayout" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <PanelTop className="h-4 w-4 text-muted-foreground" />
              موضع القوائم
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              اختر طريقة عرض القوائم: شريط جانبي على اليمين (الافتراضي) أو شريط أفقي علوي.
              نفس القوائم ونفس الصلاحيات — يتغيّر العرض فقط. يُطبَّق على كل مستخدمي الشركة.
            </p>

            {(() => {
              const layout = (user?.company?.menuLayout === "topnav") ? "topnav" : "sidebar";
              const isSidebar = layout === "sidebar";
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* SIDEBAR card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ menuLayout: "sidebar" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        isSidebar
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-menu-layout-sidebar"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          isSidebar ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <PanelRight className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">شريط جانبي (الافتراضي)</span>
                        {isSidebar && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        القوائم في شريط رأسي ثابت على يمين الشاشة — السلوك الحالي.
                      </p>
                    </button>

                    {/* TOPNAV card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ menuLayout: "topnav" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        !isSidebar
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-menu-layout-topnav"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          !isSidebar ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <PanelTop className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">شريط علوي أفقي</span>
                        {!isSidebar && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-amber-50 text-amber-700 border-amber-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        القوائم في شريط أفقي أعلى الشاشة مع قوائم منسدلة — يوفّر مساحة أفقية أكبر للمحتوى.
                      </p>
                    </button>
                  </div>

                  {postingSaving && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      جارٍ الحفظ…
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB: Invoice/document entry-form layout ═══════════════════════ */}
        <TabsContent value="invoiceFormLayout" className="mt-5 space-y-6">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
              طريقة عرض الفواتير
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              اختر شكل شاشات إدخال المستندات (فاتورة المبيعات، عرض السعر، أمر البيع، أمر الشراء):
              نموذج <span className="font-semibold">بالتبويبات</span> على طريقة SAP (البيانات الأساسية ←
              الأصناف ← التفاصيل) وهو الافتراضي، أو النموذج <span className="font-semibold">الكلاسيكي</span>
              القديم بصفحة واحدة. لا يتغيّر أي سلوك للحفظ أو الترحيل أو التحقق — يتغيّر العرض فقط.
              يُطبَّق على كل مستخدمي الشركة.
            </p>

            {(() => {
              const layout = (user?.company?.invoiceFormLayout === "classic") ? "classic" : "tabbed";
              const isTabbed = layout === "tabbed";
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* TABBED card (default) */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ invoiceFormLayout: "tabbed" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        isTabbed
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-invoice-layout-tabbed"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          isTabbed ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <LayoutGrid className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">بالتبويبات (الافتراضي)</span>
                        {isTabbed && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        ثلاثة تبويبات متتابعة: البيانات الأساسية ثم الأصناف ثم التفاصيل (القيد المحاسبي
                        وسندات القبض/الدفع والعمليات المرتبطة) — على طريقة SAP.
                      </p>
                    </button>

                    {/* CLASSIC card */}
                    <button
                      type="button"
                      disabled={postingSaving}
                      onClick={() => togglePostingMode({ invoiceFormLayout: "classic" })}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-right transition-all",
                        !isTabbed
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid="card-invoice-layout-classic"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-8 w-8 rounded-md flex items-center justify-center",
                          !isTabbed ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <LayoutList className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">كلاسيكي (صفحة واحدة)</span>
                        {!isTabbed && (
                          <span className="ms-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5 border bg-amber-50 text-amber-700 border-amber-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        كل الحقول في صفحة واحدة (بطاقة الرأس + الأصناف + أزرار الحفظ أسفل الشاشة) —
                        السلوك القديم المعتاد.
                      </p>
                    </button>
                  </div>

                  {postingSaving && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      جارٍ الحفظ…
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB: Document-archiving control center ════════════════════════ */}
        {isArchiveAdmin && (
        <TabsContent value="documentArchive" className="mt-5 space-y-6">
          {/* Intro + default mode */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              أرشفة المستندات
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              تحكَّم في طريقة تخزين المستندات المرفقة عبر زر «أرشفة مستند» لكل شاشة على حدة:
              <span className="font-semibold"> محلي</span> على جهاز المستخدم،
              أو <span className="font-semibold">سحابي</span> على الخادم،
              أو <span className="font-semibold">معطّل</span>. كما يمكنك تحديد المستخدمين المسموح لهم بالأرشفة.
            </p>

            <div>
              <Label className="text-sm font-semibold mb-2 block">الوضع الافتراضي لكل الشاشات</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {ARCHIVE_MODES.map((m) => {
                  const active = archiveDefaultMode === m.value;
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setArchiveDefaultMode(m.value)}
                      className={cn(
                        "flex flex-col items-start gap-1.5 rounded-xl border-2 p-3 text-right transition-all",
                        active ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-background hover:border-primary/40"
                      )}
                      data-testid={`card-archive-default-${m.value}`}
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div className={cn(
                          "h-7 w-7 rounded-md flex items-center justify-center",
                          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-sm">{m.label}</span>
                        {active && (
                          <span className="ms-auto text-[10px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">
                            مفعَّل
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{m.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Per-screen overrides */}
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <h3 className="font-semibold text-sm">إعداد كل شاشة على حدة</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              اختر «افتراضي» لتتبع الوضع الافتراضي أعلاه، أو حدِّد وضعاً مختلفاً لهذه الشاشة.
            </p>
            <div className="space-y-2">
              {ARCHIVE_SCREENS.map((sc) => {
                const cur = archiveScreens[sc.key];
                const options: { value: ArchiveMode | "default"; label: string }[] = [
                  { value: "default", label: "افتراضي" },
                  { value: "local", label: "محلي" },
                  { value: "cloud", label: "سحابي" },
                  { value: "off", label: "معطّل" },
                ];
                return (
                  <div key={sc.key} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
                    <span className="text-sm font-medium">{sc.label}</span>
                    <div className="flex items-center gap-1">
                      {options.map((o) => {
                        const active = (o.value === "default" && cur == null) || o.value === cur;
                        return (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => setArchiveScreens((prev) => {
                              const next = { ...prev };
                              if (o.value === "default") delete next[sc.key];
                              else next[sc.key] = o.value;
                              return next;
                            })}
                            className={cn(
                              "h-7 px-2.5 rounded-md text-xs font-medium border transition-colors",
                              active
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-background text-muted-foreground border-border hover:border-primary/40"
                            )}
                            data-testid={`btn-archive-${sc.key}-${o.value}`}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Allowed users */}
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <UsersIcon className="h-4 w-4 text-muted-foreground" />
              المستخدمون المسموح لهم بالأرشفة
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              إذا لم تُحدِّد أحداً، يُسمح لجميع المستخدمين. المدير والمدير العام مسموح لهما دائماً.
              سيُخفى زر الأرشفة عمَّن ليس لديه صلاحية.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[260px] overflow-y-auto">
              {archiveUsers
                .filter((u: any) => u.role !== "superadmin")
                .map((u: any) => {
                  const checked = archiveAllowed.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 cursor-pointer hover:border-primary/40 transition-colors"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setArchiveAllowed((prev) =>
                            v ? Array.from(new Set([...prev, u.id])) : prev.filter((x) => x !== u.id)
                          )
                        }
                      />
                      <span className="text-sm">{u.nameAr || u.username}</span>
                      {u.role === "admin" && (
                        <span className="ms-auto text-[10px] text-muted-foreground">(مدير)</span>
                      )}
                    </label>
                  );
                })}
              {archiveUsers.length === 0 && (
                <p className="text-xs text-muted-foreground">لا يوجد مستخدمون.</p>
              )}
            </div>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={postingSaving || !archiveDirty}
              onClick={() =>
                togglePostingMode({
                  archiveSettings: {
                    defaultMode: archiveDefaultMode,
                    screens: archiveScreens,
                    allowedUserIds: archiveAllowed,
                  },
                })
              }
              className="gap-2"
              data-testid="btn-save-archive-settings"
            >
              {postingSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              حفظ إعدادات الأرشفة
            </Button>
            {archiveDirty && <span className="text-xs text-amber-600">تغييرات غير محفوظة</span>}
          </div>
        </TabsContent>
        )}
      </Tabs>

    </div>
  );
}

// ─── Sub-component: Tax Calculation Mode card ────────────────────────────
// Renders two large radio-style cards letting the admin choose whether VAT
// is computed BEFORE or AFTER the line discount. Saves on click via the
// shared `togglePostingMode` patcher so there is no separate "Save" button
// (consistent with the other instant-save toggles in this page).
function TaxCalculationModeCard({
  current,
  saving,
  onChange,
}: {
  current: "before_discount" | "after_discount";
  saving: boolean;
  onChange: (v: "before_discount" | "after_discount") => void;
}) {
  const options: {
    value: "before_discount" | "after_discount";
    title: string;
    subtitle: string;
    formula: string;
    example: string;
    note: string;
    accent: string;
  }[] = [
    {
      value: "after_discount",
      title: "احتساب الضريبة بعد الخصم",
      subtitle: "الوضع الافتراضي — موصى به ومتوافق مع زاتكا",
      formula: "الضريبة = (السعر − الخصم) × النسبة",
      example: "مثال: 100 ر.س − 10 خصم = 90 ر.س ثم 15% ضريبة = 13.50 ر.س — الإجمالي 103.50",
      note: "الخصم يقلّل الوعاء الضريبي قبل احتساب الضريبة (السلوك القياسي للفواتير الضريبية).",
      accent: "emerald",
    },
    {
      value: "before_discount",
      title: "احتساب الضريبة قبل الخصم",
      subtitle: "تُحسب الضريبة على السعر الكامل ثم يُخصم الخصم من الإجمالي",
      formula: "الضريبة = السعر × النسبة ثم الإجمالي = السعر + الضريبة − الخصم",
      example: "مثال: 100 × 15% = 15 ر.س ضريبة ثم 100 + 15 − 10 خصم = 105 ر.س",
      note: "يفيد عند تطبيق خصومات تحفيزية بعد إصدار الفاتورة (كوبونات/عروض ترويجية).",
      accent: "amber",
    },
  ];

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Calculator className="h-5 w-5 text-primary mt-0.5" />
        <div className="flex-1">
          <h2 className="font-semibold text-base">طريقة حساب الضريبة</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            اختر متى تُحتسب الضريبة بالنسبة لخصم السطر. يسري الإعداد على جميع الشاشات التي تحتوي على ضرائب
            (فواتير المبيعات، عروض الأسعار، أوامر البيع، مرتجعات المبيعات، فواتير الشراء، مرتجعات الشراء، نقاط البيع، الأصول الثابتة).
            يؤثر الإعداد فقط على السطور الجديدة المُدخلة بعد التغيير — الفواتير المحفوظة تحتفظ بقيم الضريبة المحسوبة وقت حفظها.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {options.map((opt) => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={saving || active}
              onClick={() => onChange(opt.value)}
              className={cn(
                "text-right rounded-xl border-2 p-4 transition-all flex flex-col gap-3 group disabled:cursor-not-allowed",
                active
                  ? `border-${opt.accent}-500 bg-${opt.accent}-50/50 shadow-md ring-2 ring-${opt.accent}-200`
                  : "border-border bg-background hover:border-primary/40 hover:bg-muted/40 hover:shadow-sm",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className={cn(
                    "font-semibold text-sm flex items-center gap-2",
                    active && `text-${opt.accent}-700`,
                  )}>
                    {opt.title}
                    {active && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full bg-${opt.accent}-100 text-${opt.accent}-700 font-medium`}>
                        مفعَّل
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">{opt.subtitle}</p>
                </div>
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 shrink-0 transition-all flex items-center justify-center",
                  active ? `border-${opt.accent}-500 bg-${opt.accent}-500` : "border-muted-foreground/30 group-hover:border-primary/60",
                )}>
                  {active && <CheckCircle2 className="h-3 w-3 text-white" />}
                </div>
              </div>

              <div className="rounded-lg bg-muted/40 border border-border/50 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">الصيغة</span>
                  <code className="text-xs font-mono text-foreground/90 leading-relaxed" dir="ltr">{opt.formula}</code>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{opt.example}</p>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed border-r-2 border-primary/30 pr-2">
                {opt.note}
              </p>
            </button>
          );
        })}
      </div>

      {saving && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          جاري حفظ الإعداد…
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Sales-Returns user-filter card ────────────────────────
// Lets the admin pick which users' returns appear on /sales/returns.
// Empty selection = "all users" (default — legacy behavior preserved).
// Selection persists in localStorage (`zatca_sr_user_filter_<cid>`) and the
// SalesReturns page listens for a `zatca-sr-user-filter-changed` event.
function SalesReturnsUserFilterCard({ user, token }: { user: any; token: string }) {
  // For superadmin, fall back to the acting company id so the filter key
  // stays tenant-scoped and doesn't collapse across companies. Matches the
  // logic in SalesReturns.tsx.
  const rawCid = user?.role === "superadmin" ? undefined : (user?.company?.id ?? user?.companyId);
  const actingCid = (() => {
    try { const v = localStorage.getItem("zatca_acting_company_id"); return v ? Number(v) : null; }
    catch { return null; }
  })();
  const effectiveCid: number | null = rawCid ?? actingCid ?? null;
  const storageKey = effectiveCid != null ? `zatca_sr_user_filter_${effectiveCid}` : null;
  const authH: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");

  const readInitial = (): Set<number> => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map((n: any) => Number(n)).filter((n) => Number.isFinite(n)));
    } catch { return new Set(); }
  };
  const [selected, setSelected] = useState<Set<number>>(readInitial);

  useEffect(() => { setSelected(readInitial()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storageKey]);

  const persist = (next: Set<number>) => {
    if (!storageKey) return;
    setSelected(next);
    try {
      if (next.size === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify([...next]));
      window.dispatchEvent(new Event("zatca-sr-user-filter-changed"));
    } catch { /* noop */ }
  };

  // Same scope as the storage key — when there is no effective tenant
  // (superadmin not impersonating), fetch nothing rather than a global list
  // that could mix tenants.
  const { data: usersList = [] } = useQuery<any[]>({
    queryKey: ["users-for-sr-filter", effectiveCid],
    enabled: !!user && effectiveCid != null,
    queryFn: async () => {
      const r = await fetch(`${API}/api/users?companyId=${effectiveCid}`, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const sortedUsers = (usersList as any[]).slice().sort((a, b) => {
    const ai = (a.role === "admin" || a.role === "superadmin") ? 0 : 1;
    const bi = (b.role === "admin" || b.role === "superadmin") ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return String(a.nameAr || a.username || "").localeCompare(String(b.nameAr || b.username || ""));
  });

  const labelFor = (u: any) => u.nameAr || u.nameEn || u.username || u.email || `#${u.id}`;
  const selectedLabel =
    selected.size === 0
      ? "كل المستخدمين (الافتراضي)"
      : selected.size === 1
        ? (labelFor(sortedUsers.find((u: any) => Number(u.id) === [...selected][0]) ?? { id: [...selected][0] }))
        : `${selected.size} مستخدمين محدّدين`;

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <h2 className="font-semibold text-base flex items-center gap-2">
        <UsersIcon className="h-4 w-4 text-muted-foreground" />
        فلتر مرتجعات المبيعات حسب المستخدم
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        اختياري — حدِّد المستخدمين الذين تريد عرض مرتجعاتهم في شاشة <strong>مرتجعات المبيعات</strong>.
        إذا لم تختر أحداً، تعمل الشاشة بالسلوك الافتراضي وتعرض جميع المرتجعات (بما فيها القديمة قبل التعديل).
        المرتجعات القديمة التي لا تحمل مستخدم منشئ تظهر فقط في الوضع الافتراضي.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button" variant="outline"
              className={cn(
                "h-9 px-3 text-sm gap-2 border-slate-300",
                selected.size > 0 && "bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground",
              )}
            >
              <UsersIcon className="h-4 w-4" />
              {selectedLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start" dir="rtl">
            <div className="px-3 py-2 border-b bg-slate-50 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">اختيار المستخدمين</span>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => persist(new Set())}
                  className="text-[11px] text-rose-600 hover:underline"
                >
                  مسح التحديد
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-auto p-1">
              <button
                type="button"
                onClick={() => persist(new Set())}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-slate-100 text-start",
                  selected.size === 0 && "bg-primary/10 text-primary font-medium",
                )}
              >
                <Checkbox checked={selected.size === 0} className="pointer-events-none" />
                <span>كل المستخدمين (بما فيهم مدير الشركة) — افتراضي</span>
              </button>
              <div className="h-px bg-slate-200 my-1" />
              {sortedUsers.length === 0 ? (
                <div className="px-2 py-3 text-[11px] text-slate-500 text-center">لا يوجد مستخدمون</div>
              ) : (
                sortedUsers.map((u: any) => {
                  const uid = Number(u.id);
                  const checked = selected.has(uid);
                  const isAdmin = u.role === "admin" || u.role === "superadmin";
                  return (
                    <button
                      key={uid}
                      type="button"
                      onClick={() => {
                        const next = new Set(selected);
                        if (next.has(uid)) next.delete(uid); else next.add(uid);
                        persist(next);
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-slate-100 text-start",
                        checked && "bg-primary/10",
                      )}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span className="flex-1 truncate">{labelFor(u)}</span>
                      {isAdmin && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-medium">
                          مدير
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>

        {selected.size > 0 && (
          <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
            الفلتر مُفعَّل — شاشة المرتجعات تعرض المستخدمين المحدَّدين فقط
          </span>
        )}
      </div>
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
  const [bankAccountText, setBankAccountText] = useState<string>(company.bankAccountText ?? "");

  // ─── Template visibility / default selection ─────────────────────────
  // The full catalog mirrors SalesPrintModal.TEMPLATES (kept in sync by
  // template id — names/colors are display-only). NULL on the company
  // row means "show all".
  const TEMPLATE_CATALOG: { id: number; name: string; desc: string; color: string; thermal: boolean }[] = [
    { id: 14, name: "الأصلي",         desc: "نموذج مرتب بشعار وسط وبيانات شركة/عميل جانبية", color: "#b88a2a", thermal: false },
    { id: 1,  name: "كلاسيكي",       desc: "حدود وجداول تقليدية",       color: "#2563eb", thermal: false },
    { id: 2,  name: "حديث",          desc: "تصميم نظيف بهيدر أخضر",     color: "#059669", thermal: false },
    { id: 3,  name: "مؤسسي",         desc: "هيدر داكن احترافي",         color: "#1e3a5f", thermal: false },
    { id: 4,  name: "ملوّن",         desc: "ألوان دافئة مع تدرج",       color: "#d97706", thermal: false },
    { id: 5,  name: "ZATCA رسمي",    desc: "النموذج الحكومي مع QR",     color: "#1a6e3d", thermal: false },
    { id: 8,  name: "نقي أنيق",      desc: "أبيض وأسود ولمسة ذهبية",    color: "#0f172a", thermal: false },
    { id: 9,  name: "ذهبي فاخر",     desc: "خلفية داكنة ولمسات ذهبية",  color: "#1c1917", thermal: false },
    { id: 10, name: "بحري عميق",     desc: "تدرج أزرق مع موجة سفلية",   color: "#0e7490", thermal: false },
    { id: 11, name: "حيوي",          desc: "تدرجات بنفسجية ووردية",     color: "#a855f7", thermal: false },
    { id: 12, name: "تنفيذي",        desc: "شريط جانبي ببيانات الشركة", color: "#0f172a", thermal: false },
    { id: 6,  name: "حراري كلاسيكي", desc: "إيصال 80mm أبيض/أسود",      color: "#111111", thermal: true  },
    { id: 7,  name: "حراري عصري",    desc: "إيصال 80mm ملوّن",           color: "#0f766e", thermal: true  },
  ];
  const ALL_IDS = TEMPLATE_CATALOG.map(t => t.id);

  // null = "show all" (default behavior). Storing as a Set for cheap toggles.
  const initialEnabled: Set<number> = (() => {
    const raw = company.printEnabledTemplates;
    if (Array.isArray(raw) && raw.length > 0) return new Set(raw.filter((n: any) => ALL_IDS.includes(Number(n))).map(Number));
    return new Set(ALL_IDS);
  })();
  const [enabledIds, setEnabledIds] = useState<Set<number>>(initialEnabled);
  const [defaultTplId, setDefaultTplId] = useState<number>(
    Number.isInteger(company.printDefaultTemplate) ? Number(company.printDefaultTemplate) : 1,
  );

  useEffect(() => {
    setInvoiceFooter(company.printFooterInvoice ?? DEFAULT_INVOICE);
    setReturnFooter(company.printFooterReturn ?? DEFAULT_RETURN);
    setShowTimestamp(company.printShowTimestamp !== false);
    setShowZatca(company.printShowZatcaBrand !== false);
    setBankAccountText(company.bankAccountText ?? "");
    const raw = company.printEnabledTemplates;
    setEnabledIds(Array.isArray(raw) && raw.length > 0
      ? new Set(raw.filter((n: any) => ALL_IDS.includes(Number(n))).map(Number))
      : new Set(ALL_IDS));
    setDefaultTplId(Number.isInteger(company.printDefaultTemplate) ? Number(company.printDefaultTemplate) : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.printFooterInvoice, company.printFooterReturn, company.printShowTimestamp, company.printShowZatcaBrand, company.printEnabledTemplates, company.printDefaultTemplate, DEFAULT_INVOICE, DEFAULT_RETURN]);

  function toggleTemplate(id: number) {
    setEnabledIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Never let the user disable the last visible template — they
        // must always have at least one to print with.
        if (next.size <= 1) return prev;
        next.delete(id);
        // If they disabled the current default, fall back to the first
        // remaining enabled id so the saved default is always valid.
        if (id === defaultTplId) {
          const first = Array.from(next).sort((a, b) => a - b)[0];
          if (first !== undefined) setDefaultTplId(first);
        }
      } else {
        next.add(id);
      }
      return next;
    });
  }
  function selectAllTemplates() { setEnabledIds(new Set(ALL_IDS)); }
  function selectOnlyDefault()  { setEnabledIds(new Set([defaultTplId])); }

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
          bankAccountText: bankAccountText.trim() || null,
          // Send `null` when all templates are enabled so we don't bloat
          // the row with a long array that means the same as the default.
          printEnabledTemplates: enabledIds.size === ALL_IDS.length ? null : Array.from(enabledIds).sort((a,b)=>a-b),
          printDefaultTemplate: defaultTplId,
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
            printFooterInvoice:    data.printFooterInvoice,
            printFooterReturn:     data.printFooterReturn,
            printShowTimestamp:    data.printShowTimestamp,
            printShowZatcaBrand:   data.printShowZatcaBrand,
            bankAccountText:       data.bankAccountText,
            printEnabledTemplates: data.printEnabledTemplates,
            printDefaultTemplate:  data.printDefaultTemplate,
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
    setBankAccountText("");
    setEnabledIds(new Set(ALL_IDS));
    setDefaultTplId(1);
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

        {/* Bank account details — printed under the QR on the "الأصلي" template */}
        <div className="space-y-2">
          <Label htmlFor="bank-account-text" className="font-medium">
            بيانات الحساب البنكي (تظهر تحت رمز QR في الفاتورة المطبوعة)
          </Label>
          <Textarea
            id="bank-account-text"
            value={bankAccountText}
            maxLength={500}
            rows={4}
            onChange={(e) => setBankAccountText(e.target.value)}
            placeholder={"مثال:\nاسم الحساب: شركة أكاونت إنترناشونال\nالبنك: مصرف الراجحي\nرقم الآيبان: SA00 0000 0000 0000 0000 0000"}
            dir="rtl"
          />
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">اتركه فارغاً لإخفاء المربع من الفاتورة. يدعم عدّة أسطر.</span>
            <span className="text-muted-foreground">{bankAccountText.length} / 500</span>
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

      {/* ── النماذج المتاحة للطباعة ─────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <h3 className="font-semibold text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              النماذج المتاحة للطباعة
            </h3>
            <p className="text-xs text-muted-foreground leading-6">
              اختر النماذج التي ستظهر للمستخدمين عند طباعة الفاتورة، وحدّد النموذج الافتراضي الذي يُفتح أوّلاً. النماذج التي تُلغى لن تظهر في نافذة الطباعة.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Button type="button" variant="outline" size="sm" onClick={selectAllTemplates}>
              تفعيل الكل ({ALL_IDS.length})
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={selectOnlyDefault}>
              نموذج واحد فقط
            </Button>
            <span className="rounded-full bg-muted px-2 py-1 font-medium">
              {enabledIds.size} / {ALL_IDS.length}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {TEMPLATE_CATALOG.map((tpl) => {
            const isOn = enabledIds.has(tpl.id);
            const isDefault = defaultTplId === tpl.id;
            return (
              <div
                key={tpl.id}
                onClick={() => toggleTemplate(tpl.id)}
                className={cn(
                  "relative cursor-pointer rounded-xl border-2 p-3 transition-all overflow-hidden group select-none",
                  isOn
                    ? "border-primary/70 bg-primary/5 shadow-sm hover:shadow-md"
                    : "border-border bg-muted/30 opacity-60 hover:opacity-90",
                )}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTemplate(tpl.id); } }}
              >
                {/* Color stripe */}
                <div
                  className="absolute inset-x-0 top-0 h-1.5"
                  style={{ background: tpl.color }}
                />
                {/* Check / cross indicator */}
                <div className="absolute top-2 left-2">
                  {isOn ? (
                    <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary text-primary-foreground shadow">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted-foreground/30 text-background">
                      <span className="h-2 w-2 rounded-full bg-background" />
                    </span>
                  )}
                </div>
                {/* Default badge */}
                {isDefault && (
                  <span className="absolute top-2 right-2 text-[10px] font-bold rounded-full bg-amber-500 text-white px-2 py-0.5 shadow">
                    افتراضي
                  </span>
                )}

                {/* Body */}
                <div className="pt-4 space-y-2" dir="rtl">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg text-white text-sm font-bold shadow-sm"
                      style={{ background: tpl.color }}
                    >
                      {tpl.id}
                    </span>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">{tpl.name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {tpl.thermal ? "حراري 80mm" : "A4"}
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-5 line-clamp-2 min-h-[2.5rem]">
                    {tpl.desc}
                  </p>

                  {/* Default toggle */}
                  <Button
                    type="button"
                    variant={isDefault ? "default" : "outline"}
                    size="sm"
                    disabled={!isOn}
                    onClick={(e) => { e.stopPropagation(); if (isOn) setDefaultTplId(tpl.id); }}
                    className="w-full h-7 text-[11px]"
                  >
                    {isDefault ? "النموذج الافتراضي ✓" : "اجعله الافتراضي"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {enabledIds.size <= 1 && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            ⚠ يجب أن يبقى نموذج واحد على الأقل مفعّلاً حتى يتمكّن المستخدمون من الطباعة.
          </p>
        )}
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
    invoicePrintLanguage:  company.invoicePrintLanguage ?? "ar",
    printShowItemsSummary: company.printShowItemsSummary !== false,
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
                  invoicePrintLanguage: data.invoicePrintLanguage,
                  printShowItemsSummary: data.printShowItemsSummary,
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

      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base flex items-center gap-2">
            <Printer className="h-4 w-4 text-muted-foreground" />
            لغة طباعة الفاتورة (نموذج «الأصلي»)
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            تحدد اللغة الافتراضية عند طباعة الفاتورة بنموذج «الأصلي». في الوضع الإنجليزي تُطبع الفاتورة من اليسار لليمين بعناوين وأسماء أصناف بالإنجليزية (تُجلب أسماء الأصناف الإنجليزية مباشرةً من بطاقة الصنف). يمكن تجاوز هذا الاختيار لكل عملية طباعة من نافذة الطباعة نفسها.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">اللغة الافتراضية</Label>
          <select
            value={form.invoicePrintLanguage}
            onChange={(e) => setForm((p) => ({ ...p, invoicePrintLanguage: e.target.value }))}
            className="h-9 w-[220px] rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="ar">العربية (افتراضي)</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base flex items-center gap-2">
            <Printer className="h-4 w-4 text-muted-foreground" />
            محتوى الفاتورة المطبوعة (نموذج «الأصلي»)
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            تحكّم في إظهار صندوق ملخّص الأصناف والكميات (إجمالي أصناف الفاتورة وإجمالي الكميات) أسفل الإجماليات في الفاتورة المطبوعة.
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4">
          <div className="space-y-0.5">
            <div className="font-medium text-sm">إظهار ملخّص الأصناف والكميات</div>
            <p className="text-xs text-muted-foreground">عند الإيقاف يختفي صندوق «إجمالي أصناف الفاتورة / إجمالي الكميات» من الفاتورة المطبوعة.</p>
          </div>
          <Switch
            checked={form.printShowItemsSummary !== false}
            onCheckedChange={(v) => setForm((p) => ({ ...p, printShowItemsSummary: !!v }))}
          />
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
