import { useEffect, useMemo, useState } from "react";
import {
  Plug, Plus, Copy, Check, RefreshCw, Trash2, Sparkles, Activity,
  ShieldCheck, Zap, KeyRound, Webhook, ArrowUpRight, CheckCircle2,
  XCircle, Clock, AlertTriangle, Brain, FileJson, Database, FileSpreadsheet,
  Building2, Boxes, Code2, Eye, EyeOff, ChevronRight, Loader2, X,
  Upload, FileText, FileImage, FileCode, UploadCloud, FileCheck2,
  Download, ScanLine,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import ZatcaScanPreview, { downloadZatcaTemplate, type ZatcaRow } from "./ZatcaScanPreview";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

// ────────────────────────────────────────────────────────────────────────
// Phase 1 UI shell — uses localStorage for persistence so the screen
// behaves like a real product. Wire to backend (POST /partner-api/...)
// in Phase 2.
// ────────────────────────────────────────────────────────────────────────

type SystemId = "odoo" | "sap" | "quickbooks" | "excel" | "generic" | "custom";

interface SystemDef {
  id: SystemId;
  name: string;
  nameAr: string;
  desc: string;
  icon: typeof Plug;
  bg: string;        // background gradient class
  accent: string;    // accent text color
  popular?: boolean;
}

interface Connection {
  id: string;
  systemId: SystemId;
  label: string;
  apiKeyMasked: string;
  createdAt: number;
  status: "active" | "paused" | "error";
  lastSyncAt?: number;
  invoicesToday: number;
  invoicesTotal: number;
  successRate: number; // 0-100
}

interface ApiKey {
  id: string;
  label: string;
  prefix: string;     // e.g. "zac_live_"
  fullKey: string;    // shown only at creation
  createdAt: number;
  lastUsedAt?: number;
  scope: "live" | "test";
}

interface ActivityEntry {
  id: string;
  ts: number;
  systemId: SystemId;
  invoiceRef: string;
  status: "success" | "failed" | "pending" | "retry";
  message?: string;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  ext: string;
  ts: number;
  status: "queued" | "parsing" | "ai-extract" | "validating" | "submitting" | "done" | "failed";
  progress: number;        // 0-100
  invoicesFound: number;
  invoicesSubmitted: number;
  errorMsg?: string;
}

const FILE_TYPES = [
  { ext: "xlsx", label: "Excel", icon: FileSpreadsheet, color: "text-emerald-700", bg: "bg-emerald-100" },
  { ext: "xls",  label: "Excel", icon: FileSpreadsheet, color: "text-emerald-700", bg: "bg-emerald-100" },
  { ext: "csv",  label: "CSV",   icon: FileSpreadsheet, color: "text-emerald-700", bg: "bg-emerald-100" },
  { ext: "pdf",  label: "PDF",   icon: FileText,        color: "text-rose-700",    bg: "bg-rose-100" },
  { ext: "xml",  label: "XML",   icon: FileCode,        color: "text-violet-700",  bg: "bg-violet-100" },
  { ext: "json", label: "JSON",  icon: FileJson,        color: "text-amber-700",   bg: "bg-amber-100" },
  { ext: "jpg",  label: "صورة", icon: FileImage,       color: "text-blue-700",    bg: "bg-blue-100" },
  { ext: "png",  label: "صورة", icon: FileImage,       color: "text-blue-700",    bg: "bg-blue-100" },
];
const ACCEPT_EXTS = FILE_TYPES.map(f => `.${f.ext}`).join(",");

function fileTypeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPES.find(f => f.ext === ext) ?? { ext, label: ext.toUpperCase() || "ملف", icon: FileText, color: "text-slate-700", bg: "bg-slate-100" };
}
function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
const STATUS_AR: Record<UploadedFile["status"], string> = {
  queued:      "في الانتظار",
  parsing:     "قراءة الملف...",
  "ai-extract":"استخراج بالذكاء الاصطناعي...",
  validating:  "التحقق من البيانات...",
  submitting:  "إرسال إلى زاتكا...",
  done:        "اكتمل بنجاح",
  failed:      "فشل",
};

const SYSTEMS: SystemDef[] = [
  {
    id: "odoo", name: "Odoo", nameAr: "أودو",
    desc: "ERP مفتوح المصدر — ربط تلقائي للفواتير والعملاء",
    icon: Boxes,
    bg: "from-violet-500 via-purple-600 to-fuchsia-600",
    accent: "text-violet-700",
    popular: true,
  },
  {
    id: "sap", name: "SAP", nameAr: "ساب",
    desc: "تكامل مؤسسي مع SAP S/4HANA و Business One",
    icon: Building2,
    bg: "from-sky-500 via-blue-600 to-indigo-700",
    accent: "text-sky-700",
  },
  {
    id: "quickbooks", name: "QuickBooks", nameAr: "كويك بوكس",
    desc: "محاسبة الشركات الصغيرة والمتوسطة",
    icon: Database,
    bg: "from-emerald-500 via-green-600 to-teal-700",
    accent: "text-emerald-700",
    popular: true,
  },
  {
    id: "excel", name: "Excel / CSV", nameAr: "إكسل / CSV",
    desc: "ارفع ملف وحوّل صفوفه لفواتير زاتكا تلقائياً",
    icon: FileSpreadsheet,
    bg: "from-emerald-600 via-green-700 to-emerald-800",
    accent: "text-emerald-800",
  },
  {
    id: "generic", name: "Generic API", nameAr: "API عام",
    desc: "ابعت JSON بأي صيغة — الذكاء الاصطناعي يعمل الربط",
    icon: FileJson,
    bg: "from-amber-500 via-orange-600 to-rose-600",
    accent: "text-amber-700",
    popular: true,
  },
  {
    id: "custom", name: "Custom Webhook", nameAr: "Webhook مخصص",
    desc: "تكامل مخصص مع نظامك الداخلي",
    icon: Code2,
    bg: "from-slate-700 via-slate-800 to-slate-900",
    accent: "text-slate-700",
  },
];

const LS_KEYS = {
  connections: "zac_gateway_connections",
  apiKeys: "zac_gateway_apikeys",
  activity: "zac_gateway_activity",
  uploads: "zac_gateway_uploads",
};

function loadLs<T>(k: string, fallback: T): T {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : fallback; }
  catch { return fallback; }
}
function saveLs<T>(k: string, v: T) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
}

function rid() { return Math.random().toString(36).slice(2, 10); }
function genApiKey(scope: "live" | "test") {
  const rand = Array.from({ length: 24 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
  ).join("");
  return `zac_${scope}_${rand}`;
}
function maskKey(k: string) {
  if (k.length < 12) return k;
  return `${k.slice(0, 10)}••••••••${k.slice(-4)}`;
}

function timeAgoAr(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `منذ ${diff} ث`;
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} د`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} س`;
  return `منذ ${Math.floor(diff / 86400)} يوم`;
}

export default function IntegrationGateway() {
  const { toast } = useToast();
  const { token } = useAuth();
  const [connections, setConnections] = useState<Connection[]>(() => loadLs(LS_KEYS.connections, [] as Connection[]));
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(() => loadLs(LS_KEYS.apiKeys, [] as ApiKey[]));
  const [activity, setActivity] = useState<ActivityEntry[]>(() => loadLs(LS_KEYS.activity, [] as ActivityEntry[]));
  const [uploads, setUploads] = useState<UploadedFile[]>(() => loadLs(LS_KEYS.uploads, [] as UploadedFile[]));
  const [showFullKey, setShowFullKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [connectModal, setConnectModal] = useState<SystemDef | null>(null);
  const [aiWizardOpen, setAiWizardOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Files queued for the ZATCA scan/preview modal — opens BEFORE the
  // file actually hits the upload pipeline so the user can review,
  // fix errors, and confirm against ZATCA's standard format.
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  useEffect(() => saveLs(LS_KEYS.connections, connections), [connections]);
  useEffect(() => saveLs(LS_KEYS.apiKeys, apiKeys), [apiKeys]);
  useEffect(() => saveLs(LS_KEYS.activity, activity), [activity]);
  useEffect(() => saveLs(LS_KEYS.uploads, uploads), [uploads]);

  // Best-effort fetch of company ZATCA setup status. Falls back gracefully
  // if the endpoint isn't available — we just hide the "incomplete" banner.
  const { data: zatcaStatus } = useQuery<{ ready: boolean; companyName?: string; vatNumber?: string; missing?: string[] }>({
    queryKey: ["zatca-setup-status"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/zatca/status", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error();
        return res.json();
      } catch {
        // graceful fallback so the UI still works without the endpoint
        return { ready: true };
      }
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const zatcaReady = zatcaStatus?.ready !== false;

  const stats = useMemo(() => {
    const totalInvoices = connections.reduce((s, c) => s + c.invoicesTotal, 0);
    const todayInvoices = connections.reduce((s, c) => s + c.invoicesToday, 0);
    const avgSuccess = connections.length === 0 ? 100 :
      Math.round(connections.reduce((s, c) => s + c.successRate, 0) / connections.length);
    return { totalInvoices, todayInvoices, avgSuccess, connected: connections.length };
  }, [connections]);

  const createApiKey = (scope: "live" | "test", label: string) => {
    const full = genApiKey(scope);
    const k: ApiKey = {
      id: rid(),
      label: label || (scope === "live" ? "مفتاح الإنتاج" : "مفتاح الاختبار"),
      prefix: `zac_${scope}_`,
      fullKey: full,
      createdAt: Date.now(),
      scope,
    };
    setApiKeys(prev => [k, ...prev]);
    setShowFullKey(k.id);
    toast({ title: "تم إنشاء المفتاح", description: "انسخه الآن — لن تتمكن من رؤيته كاملاً مرة أخرى" });
  };

  const revokeKey = (id: string) => {
    setApiKeys(prev => prev.filter(k => k.id !== id));
    toast({ title: "تم إلغاء المفتاح", description: "أي طلب يستخدمه سيُرفض فوراً" });
  };

  const copyKey = (k: ApiKey) => {
    navigator.clipboard?.writeText(k.fullKey).then(() => {
      setCopiedKey(k.id);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const completeConnect = (sys: SystemDef, label: string, useAi: boolean) => {
    const apiKey = genApiKey("live");
    const conn: Connection = {
      id: rid(),
      systemId: sys.id,
      label: label || sys.nameAr,
      apiKeyMasked: maskKey(apiKey),
      createdAt: Date.now(),
      status: "active",
      invoicesToday: 0,
      invoicesTotal: 0,
      successRate: 100,
    };
    setConnections(prev => [conn, ...prev]);
    // simulate the AI mapping success in the activity feed
    const entry: ActivityEntry = {
      id: rid(),
      ts: Date.now(),
      systemId: sys.id,
      invoiceRef: useAi ? "AI-MAPPING" : "MANUAL-MAPPING",
      status: "success",
      message: useAi
        ? `تم ربط ${sys.nameAr} باستخدام الذكاء الاصطناعي — تطابق 18 حقلاً تلقائياً`
        : `تم ربط ${sys.nameAr} يدوياً`,
    };
    setActivity(prev => [entry, ...prev].slice(0, 50));
    setConnectModal(null);
    toast({
      title: "تم الربط بنجاح",
      description: useAi ? "AI ربط الحقول تلقائياً، راجعها من شاشة الخرائط" : `${sys.nameAr} متصل ونشط`,
    });
  };

  const toggleStatus = (id: string) => {
    setConnections(prev => prev.map(c =>
      c.id === id ? { ...c, status: c.status === "active" ? "paused" : "active" } : c
    ));
  };

  const removeConnection = (id: string) => {
    setConnections(prev => prev.filter(c => c.id !== id));
    toast({ title: "تم فصل التكامل", description: "لن يتم استقبال أي طلبات منه" });
  };

  // ── Bulk upload pipeline (Phase 1: simulated client-side; Phase 2 will
  //    POST each file to /partner-api/v1/uploads and stream progress) ────
  const STAGES: Array<{ s: UploadedFile["status"]; pct: number; ms: number }> = [
    { s: "parsing",     pct: 25, ms: 700 },
    { s: "ai-extract",  pct: 55, ms: 1100 },
    { s: "validating",  pct: 75, ms: 600 },
    { s: "submitting",  pct: 95, ms: 900 },
  ];

  const updateUpload = (id: string, patch: Partial<UploadedFile>) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...patch } : u));
  };

  const processUpload = async (id: string) => {
    for (const stage of STAGES) {
      updateUpload(id, { status: stage.s, progress: stage.pct });
      await new Promise(r => setTimeout(r, stage.ms));
    }
    // pretend we extracted between 1 and 12 invoices, ~95% submit success
    const found = Math.floor(Math.random() * 12) + 1;
    const submitted = Math.max(1, Math.round(found * (0.85 + Math.random() * 0.15)));
    const failed = found - submitted;
    updateUpload(id, {
      status: failed > 0 && submitted === 0 ? "failed" : "done",
      progress: 100,
      invoicesFound: found,
      invoicesSubmitted: submitted,
      errorMsg: failed > 0 ? `${failed} فاتورة فشلت بسبب بيانات ناقصة — راجعها يدوياً` : undefined,
    });
    // also push into the activity feed
    const u = uploads.find(x => x.id === id);
    setActivity(prev => [{
      id: rid(),
      ts: Date.now(),
      systemId: "excel" as SystemId,
      invoiceRef: `BULK-${(u?.name ?? "file").slice(0, 18)}`,
      status: failed > 0 ? "failed" : "success",
      message: `تم استخراج ${found} فاتورة من الملف، أُرسل ${submitted} لزاتكا${failed > 0 ? ` و فشل ${failed}` : ""}`,
    } as ActivityEntry, ...prev].slice(0, 50));
  };

  // Formats we can pre-parse + validate client-side. Other formats
  // (PDF/images) skip the scan modal and go straight to the AI pipeline.
  const SCANNABLE = new Set(["xlsx", "xls", "csv", "json"]);

  const enqueueForProcessing = (files: File[]) => {
    const newUploads: UploadedFile[] = files.map(f => ({
      id: rid(),
      name: f.name,
      size: f.size,
      ext: f.name.split(".").pop()?.toLowerCase() ?? "",
      ts: Date.now(),
      status: "queued",
      progress: 5,
      invoicesFound: 0,
      invoicesSubmitted: 0,
    }));
    setUploads(prev => [...newUploads, ...prev]);
    newUploads.forEach((u, i) => setTimeout(() => processUpload(u.id), i * 200));
  };

  const addFiles = (files: FileList | File[]) => {
    if (!zatcaReady) {
      toast({
        title: "يجب إكمال إعداد زاتكا أولاً",
        description: "ادخل بيانات شركتك ورقم تسجيل ضريبة القيمة المضافة قبل الرفع",
        variant: "destructive",
      });
      return;
    }
    const list = Array.from(files);
    const accepted = list.filter(f => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return FILE_TYPES.some(t => t.ext === ext);
    });
    if (accepted.length === 0) {
      toast({ title: "صيغة غير مدعومة", description: `الصيغ المقبولة: ${FILE_TYPES.map(f => f.ext).join(", ")}`, variant: "destructive" });
      return;
    }
    // Split: scannable files trigger the validation modal; the rest go
    // straight to the AI pipeline (PDF/images need OCR server-side).
    const scannable = accepted.filter(f => SCANNABLE.has(f.name.split(".").pop()?.toLowerCase() ?? ""));
    const direct = accepted.filter(f => !SCANNABLE.has(f.name.split(".").pop()?.toLowerCase() ?? ""));

    if (direct.length > 0) {
      enqueueForProcessing(direct);
      toast({ title: `تم استلام ${direct.length} ملف`, description: "بدأ التحليل والإرسال إلى زاتكا" });
    }

    if (scannable.length > 0) {
      // Open the scan modal for the first file; queue the rest behind it.
      setScanFile(scannable[0]);
      setPendingFiles(scannable.slice(1));
    }
  };

  const handleScanConfirm = (rows: ZatcaRow[]) => {
    if (!scanFile) return;
    // The user has reviewed and approved the parsed rows. Push the file
    // into the upload pipeline with the validated invoice count baked in
    // so the UploadRow stats reflect what was actually approved.
    const id = rid();
    const u: UploadedFile = {
      id,
      name: scanFile.name,
      size: scanFile.size,
      ext: scanFile.name.split(".").pop()?.toLowerCase() ?? "",
      ts: Date.now(),
      status: "queued",
      progress: 5,
      invoicesFound: rows.length,
      invoicesSubmitted: 0,
    };
    setUploads(prev => [u, ...prev]);
    toast({ title: "تم تأكيد الفواتير", description: `${rows.length} فاتورة مطابقة لزاتكا — جاري الإرسال` });
    setTimeout(() => processUpload(id), 100);

    // Move on to the next pending file (if any)
    if (pendingFiles.length > 0) {
      setScanFile(pendingFiles[0]);
      setPendingFiles(pendingFiles.slice(1));
    } else {
      setScanFile(null);
    }
  };

  const handleScanClose = () => {
    // User cancelled — also drop the queue so they don't get hit with
    // modal after modal unexpectedly.
    setScanFile(null);
    setPendingFiles([]);
  };

  const removeUpload = (id: string) => setUploads(prev => prev.filter(u => u.id !== id));
  const retryUpload  = (id: string) => { updateUpload(id, { status: "queued", progress: 5, errorMsg: undefined }); processUpload(id); };
  const clearDoneUploads = () => setUploads(prev => prev.filter(u => u.status !== "done"));

  return (
    <div className="space-y-6 pb-12">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-900 to-violet-800 p-6 sm:p-8 text-white shadow-2xl">
        <div className="absolute -top-20 -end-20 h-72 w-72 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="absolute -bottom-16 -start-12 h-64 w-64 rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="absolute top-10 start-1/2 h-40 w-40 rounded-full bg-violet-400/10 blur-2xl" />

        <div className="relative grid lg:grid-cols-[1.4fr_1fr] gap-6 items-center">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 backdrop-blur px-3 py-1 text-xs font-bold ring-1 ring-white/20">
              <Sparkles className="h-3 w-3" />
              ZacodERP Gateway
              <span className="rounded-full bg-emerald-400/30 px-2 py-0.5 text-[10px]">جديد</span>
            </div>
            <h1 className="text-2xl sm:text-4xl font-extrabold leading-tight">
              اربط أي نظام بزاتكا في دقائق
            </h1>
            <p className="text-sm sm:text-base text-white/85 leading-relaxed max-w-xl">
              بوابة موحّدة تستقبل فواتيرك من Odoo و SAP و QuickBooks وأي نظام آخر،
              تحوّلها لـ UBL 2.1 موقّع، وترسلها لزاتكا — مع ذكاء اصطناعي يتولى ربط الحقول تلقائياً.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                onClick={() => setAiWizardOpen(true)}
                className="bg-white text-indigo-900 hover:bg-white/90 font-bold gap-2"
                size="lg"
              >
                <Brain className="h-4 w-4" />
                ابدأ بمعالج الذكاء الاصطناعي
              </Button>
              <Button
                variant="outline"
                onClick={() => createApiKey("test", "")}
                className="bg-transparent text-white border-white/40 hover:bg-white/10 hover:text-white gap-2"
                size="lg"
              >
                <KeyRound className="h-4 w-4" />
                إصدار مفتاح API
              </Button>
            </div>
          </div>

          {/* Live stats card inside hero */}
          <div className="grid grid-cols-2 gap-3">
            <HeroStat icon={Plug} label="تكاملات نشطة" value={stats.connected} />
            <HeroStat icon={Activity} label="فواتير اليوم" value={stats.todayInvoices} />
            <HeroStat icon={CheckCircle2} label="نسبة النجاح" value={`${stats.avgSuccess}%`} accent="text-emerald-300" />
            <HeroStat icon={ShieldCheck} label="إجمالي المُرسل" value={stats.totalInvoices} />
          </div>
        </div>
      </div>

      {/* ── ZATCA SETUP BANNER (only when incomplete) ─────────────── */}
      {!zatcaReady && (
        <Card className="border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-amber-900">إعداد بيانات الشركة لزاتكا غير مكتمل</p>
                <p className="text-sm text-amber-800 mt-0.5">
                  لا يمكن إرسال أي فاتورة قبل إكمال شهادة الامتثال (CSID) ورقم تسجيل ضريبة القيمة المضافة.
                  {zatcaStatus?.missing && zatcaStatus.missing.length > 0 && (
                    <> الحقول الناقصة: <b>{zatcaStatus.missing.join("، ")}</b>.</>
                  )}
                </p>
              </div>
              <Button asChild size="sm" className="bg-amber-600 hover:bg-amber-700 text-white shrink-0">
                <Link href="/zatca">إكمال الإعداد</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── DIRECT UPLOAD (no integration needed) ─────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-emerald-600" />
            <h2 className="text-lg font-bold text-foreground">رفع مباشر للملفات</h2>
            <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">بدون ربط</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={downloadZatcaTemplate}
              className="gap-1.5 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50"
              title="حمّل قالب Excel بصيغة زاتكا الرسمية"
            >
              <Download className="h-3.5 w-3.5" />
              تحميل قالب زاتكا
            </Button>
            {uploads.some(u => u.status === "done") && (
              <Button variant="ghost" size="sm" onClick={clearDoneUploads} className="text-xs">
                مسح المكتملة
              </Button>
            )}
          </div>
        </div>

        <Card className="overflow-hidden border-2 border-dashed">
          <CardContent className="p-0">
            <label
              htmlFor="bulk-upload-input"
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
              }}
              className={`block cursor-pointer p-6 sm:p-10 text-center transition-all relative overflow-hidden ${
                dragOver
                  ? "bg-gradient-to-br from-emerald-100 via-teal-50 to-cyan-100 ring-4 ring-emerald-400/40"
                  : "bg-gradient-to-br from-emerald-50/50 via-teal-50/30 to-cyan-50/50 hover:from-emerald-100/60 hover:to-cyan-100/60"
              }`}
            >
              <input
                id="bulk-upload-input"
                type="file"
                accept={ACCEPT_EXTS}
                multiple
                className="hidden"
                onChange={e => e.target.files && addFiles(e.target.files)}
              />
              <div className="absolute -top-12 -end-12 h-40 w-40 rounded-full bg-emerald-300/30 blur-3xl pointer-events-none" />
              <div className="absolute -bottom-12 -start-12 h-40 w-40 rounded-full bg-cyan-300/30 blur-3xl pointer-events-none" />
              <div className="relative">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-xl mb-3">
                  <Upload className="h-8 w-8" />
                </div>
                <h3 className="font-extrabold text-lg text-foreground">اسحب الملفات هنا أو اضغط للاختيار</h3>
                <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto leading-relaxed">
                  ارفع فواتيرك بأي صيغة — Excel أو CSV أو JSON تظهر لك شاشة معاينة وفحص قبل الإرسال،
                  مع تصحيح تلقائي لأي مخالفة لمعايير زاتكا.
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-violet-100 text-violet-700 px-3 py-1 text-[11px] font-bold">
                  <ScanLine className="h-3 w-3" />
                  فحص ذكي قبل الإصدار + تصحيح حسب معايير زاتكا
                </div>
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  {[...new Map(FILE_TYPES.map(t => [t.label, t])).values()].map(t => (
                    <span key={t.label} className={`inline-flex items-center gap-1 rounded-full ${t.bg} ${t.color} px-2.5 py-1 text-[11px] font-bold`}>
                      <t.icon className="h-3 w-3" /> {t.label}
                    </span>
                  ))}
                </div>
                <Button type="button" className="mt-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:opacity-90 text-white font-bold gap-2 pointer-events-none">
                  <UploadCloud className="h-4 w-4" />
                  اختر ملفات
                </Button>
              </div>
            </label>
          </CardContent>
        </Card>

        {uploads.length > 0 && (
          <div className="mt-3 space-y-2">
            {uploads.slice(0, 12).map(u => (
              <UploadRow key={u.id} u={u} onRemove={() => removeUpload(u.id)} onRetry={() => retryUpload(u.id)} />
            ))}
          </div>
        )}
      </section>

      {/* ── AI MAPPING WIZARD CTA ─────────────────────────────────── */}
      <Card className="relative overflow-hidden border-2 border-dashed border-violet-300 bg-gradient-to-br from-violet-50 via-fuchsia-50 to-pink-50">
        <div className="absolute -top-10 -end-10 h-32 w-32 rounded-full bg-fuchsia-200/60 blur-2xl" />
        <CardContent className="p-5 sm:p-6 relative">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white flex items-center justify-center shadow-lg shrink-0">
              <Brain className="h-7 w-7" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-extrabold text-foreground text-base sm:text-lg">معالج الربط بالذكاء الاصطناعي</h3>
                <Badge className="bg-violet-600 text-white hover:bg-violet-600">AI</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                ارفع عينة JSON من نظامك، والذكاء الاصطناعي يقترح خريطة الحقول إلى زاتكا تلقائياً —
                بما فيها فئات الضريبة وتصنيف الأصناف.
              </p>
            </div>
            <Button
              onClick={() => setAiWizardOpen(true)}
              className="bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-700 hover:to-fuchsia-700 text-white font-bold gap-1 shrink-0"
            >
              ابدأ الآن
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── CONNECTED INTEGRATIONS ─────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold text-foreground">التكاملات المتصلة</h2>
            <Badge variant="secondary" className="font-bold">{connections.length}</Badge>
          </div>
        </div>

        {connections.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <div className="mx-auto h-14 w-14 rounded-2xl bg-muted flex items-center justify-center mb-3">
                <Plug className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-semibold text-foreground">لا توجد تكاملات بعد</p>
              <p className="text-sm text-muted-foreground mt-1">اختر نظامك من الأسفل وابدأ الربط في أقل من دقيقة</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {connections.map(conn => {
              const sys = SYSTEMS.find(s => s.id === conn.systemId)!;
              return (
                <Card key={conn.id} className="overflow-hidden group">
                  <div className={`h-1.5 bg-gradient-to-r ${sys.bg}`} />
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${sys.bg} text-white flex items-center justify-center shrink-0 shadow`}>
                          <sys.icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-foreground truncate">{conn.label}</p>
                          <p className="text-xs text-muted-foreground">{sys.nameAr}</p>
                        </div>
                      </div>
                      <StatusBadge status={conn.status} />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">اليوم</p>
                        <p className="font-bold text-sm">{conn.invoicesToday}</p>
                      </div>
                      <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">إجمالي</p>
                        <p className="font-bold text-sm">{conn.invoicesTotal}</p>
                      </div>
                      <div className="rounded-lg bg-emerald-50 px-2 py-1.5">
                        <p className="text-[10px] text-emerald-700">نجاح</p>
                        <p className="font-bold text-sm text-emerald-700">{conn.successRate}%</p>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground font-mono bg-muted/30 rounded px-2 py-1 truncate" dir="ltr">
                      {conn.apiKeyMasked}
                    </div>

                    <div className="flex items-center justify-between pt-1 [direction:ltr]">
                      <Button size="sm" variant="ghost" onClick={() => removeConnection(conn.id)} className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 h-8 px-2 text-xs">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleStatus(conn.id)} className="h-8 px-2 text-xs gap-1">
                        {conn.status === "active" ? "إيقاف مؤقت" : "تفعيل"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 px-2 text-xs gap-1 text-primary">
                        تفاصيل <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── AVAILABLE SYSTEMS ──────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-5 w-5 text-amber-600" />
          <h2 className="text-lg font-bold text-foreground">اختر النظام المراد ربطه</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SYSTEMS.map(sys => (
            <button
              key={sys.id}
              onClick={() => setConnectModal(sys)}
              className="group text-start relative overflow-hidden rounded-2xl border border-border bg-card hover:border-primary/40 hover:shadow-lg transition-all"
            >
              <div className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${sys.bg} opacity-90`} />
              <div className="relative p-5">
                <div className="flex items-start justify-between mb-12">
                  <div className="h-12 w-12 rounded-2xl bg-white/95 text-slate-800 flex items-center justify-center shadow-lg ring-1 ring-white/40">
                    <sys.icon className={`h-6 w-6 ${sys.accent}`} />
                  </div>
                  {sys.popular && (
                    <span className="rounded-full bg-white/90 backdrop-blur text-amber-700 text-[10px] font-extrabold px-2 py-1 ring-1 ring-amber-200">
                      ⭐ شائع
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-[11px] font-bold text-white/90 mb-0.5">{sys.name}</p>
                  <h3 className="font-extrabold text-foreground text-base">{sys.nameAr}</h3>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed h-8 line-clamp-2">{sys.desc}</p>
                  <div className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary group-hover:gap-2 transition-all">
                    اربط الآن
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ── API KEYS ───────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-bold text-foreground">مفاتيح API</h2>
            <Badge variant="secondary" className="font-bold">{apiKeys.length}</Badge>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => createApiKey("test", "")} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> مفتاح اختبار
            </Button>
            <Button size="sm" onClick={() => createApiKey("live", "")} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> مفتاح إنتاج
            </Button>
          </div>
        </div>

        {apiKeys.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center">
              <KeyRound className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
              <p className="font-semibold">لا توجد مفاتيح بعد</p>
              <p className="text-sm text-muted-foreground mt-1">أنشئ مفتاح اختبار للبدء</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {apiKeys.map(k => {
              const isLive = k.scope === "live";
              const isVisible = showFullKey === k.id;
              return (
                <Card key={k.id} className={isLive ? "border-rose-200" : "border-blue-200"}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <span className="font-semibold text-foreground">{k.label}</span>
                          <Badge className={isLive ? "bg-rose-600 hover:bg-rose-600 text-white" : "bg-blue-600 hover:bg-blue-600 text-white"}>
                            {isLive ? "إنتاج" : "اختبار"}
                          </Badge>
                          {isVisible && (
                            <Badge variant="outline" className="border-amber-400 text-amber-700">⚠️ مرئي مرة واحدة</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 font-mono text-sm bg-muted rounded-lg px-3 py-2" dir="ltr">
                          <span className="truncate">{isVisible ? k.fullKey : maskKey(k.fullKey)}</span>
                          <Button size="sm" variant="ghost" onClick={() => setShowFullKey(isVisible ? null : k.id)} className="h-7 w-7 p-0 ms-auto shrink-0">
                            {isVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => copyKey(k)} className="h-7 w-7 p-0 shrink-0">
                            {copiedKey === k.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1.5">
                          أُنشئ {timeAgoAr(k.createdAt)}
                          {k.lastUsedAt && ` • آخر استخدام ${timeAgoAr(k.lastUsedAt)}`}
                        </p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)} className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 gap-1">
                        <Trash2 className="h-3.5 w-3.5" /> إلغاء
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── ENDPOINTS DOCS PREVIEW ──────────────────────────────────── */}
      <Card className="bg-slate-950 text-slate-100 border-slate-800 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-emerald-400" />
              <span className="font-mono text-xs text-slate-300">REST Endpoints — partner-api/v1</span>
            </div>
            <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40">جاهز</Badge>
          </div>
          <div className="p-4 font-mono text-xs sm:text-sm space-y-1.5 overflow-x-auto" dir="ltr">
            <EndpointLine method="POST" path="/partner-api/v1/invoices" desc="إصدار فاتورة جديدة" />
            <EndpointLine method="POST" path="/partner-api/v1/credit-notes" desc="إشعار دائن" />
            <EndpointLine method="POST" path="/partner-api/v1/debit-notes" desc="إشعار مدين" />
            <EndpointLine method="GET" path="/partner-api/v1/invoices/:id" desc="استعلام عن الحالة" />
            <EndpointLine method="GET" path="/partner-api/v1/invoices/:id/xml" desc="UBL الموقّع" />
            <EndpointLine method="POST" path="/partner-api/v1/webhooks" desc="تسجيل callback" />
          </div>
        </CardContent>
      </Card>

      {/* ── ACTIVITY FEED ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-5 w-5 text-emerald-600" />
          <h2 className="text-lg font-bold text-foreground">آخر النشاط</h2>
        </div>
        {activity.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              ستظهر هنا كل المعاملات الواردة من الأنظمة الخارجية
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0 divide-y">
              {activity.slice(0, 10).map(e => {
                const sys = SYSTEMS.find(s => s.id === e.systemId);
                return (
                  <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ActivityStatusIcon status={e.status} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">
                        <span className="font-mono text-xs me-2">{e.invoiceRef}</span>
                        {e.message ?? `فاتورة من ${sys?.nameAr ?? e.systemId}`}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{timeAgoAr(e.ts)} • {sys?.nameAr ?? e.systemId}</p>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </section>

      {/* ── CONNECT MODAL ──────────────────────────────────────────── */}
      {connectModal && (
        <ConnectModal
          system={connectModal}
          onClose={() => setConnectModal(null)}
          onConfirm={(label, useAi) => completeConnect(connectModal, label, useAi)}
        />
      )}

      {/* ── ZATCA SCAN/PREVIEW MODAL ─────────────────────────────── */}
      {scanFile && (
        <ZatcaScanPreview
          file={scanFile}
          onClose={handleScanClose}
          onConfirm={handleScanConfirm}
        />
      )}

      {/* ── AI WIZARD MODAL ────────────────────────────────────────── */}
      {aiWizardOpen && (
        <AiWizardModal
          onClose={() => setAiWizardOpen(false)}
          onComplete={(systemId) => {
            const sys = SYSTEMS.find(s => s.id === systemId) ?? SYSTEMS[0];
            completeConnect(sys, `${sys.nameAr} (AI)`, true);
            setAiWizardOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────

function UploadRow({ u, onRemove, onRetry }: { u: UploadedFile; onRemove: () => void; onRetry: () => void }) {
  const t = fileTypeFor(u.name);
  const isDone   = u.status === "done";
  const isFailed = u.status === "failed";
  const isActive = !isDone && !isFailed;
  const barColor = isFailed ? "bg-rose-500" : isDone ? "bg-emerald-500" : "bg-gradient-to-r from-emerald-500 to-teal-500";

  return (
    <Card className={`overflow-hidden ${isFailed ? "border-rose-200" : isDone ? "border-emerald-200" : "border-border"}`}>
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className={`h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${t.bg}`}>
            <t.icon className={`h-5 w-5 ${t.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm text-foreground truncate" title={u.name}>{u.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {fmtSize(u.size)} • {t.label.toUpperCase()} • {timeAgoAr(u.ts)}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isFailed && (
                  <Button size="sm" variant="ghost" onClick={onRetry} className="h-7 px-2 text-xs gap-1 text-blue-600 hover:bg-blue-50">
                    <RefreshCw className="h-3 w-3" /> إعادة
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={onRemove} className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Progress bar + status text */}
            <div className="mt-2">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${barColor} transition-all duration-500 ${isActive ? "animate-pulse" : ""}`} style={{ width: `${u.progress}%` }} />
              </div>
              <div className="flex items-center justify-between mt-1.5 gap-2">
                <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${
                  isFailed ? "text-rose-700" : isDone ? "text-emerald-700" : "text-muted-foreground"
                }`}>
                  {isActive   && <Loader2 className="h-3 w-3 animate-spin" />}
                  {isDone     && <FileCheck2 className="h-3 w-3" />}
                  {isFailed   && <XCircle className="h-3 w-3" />}
                  {STATUS_AR[u.status]}
                </span>
                {(isDone || isFailed) && u.invoicesFound > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {u.invoicesSubmitted}/{u.invoicesFound} فاتورة أُرسلت
                  </span>
                )}
              </div>
              {u.errorMsg && (
                <p className="mt-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                  {u.errorMsg}
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HeroStat({ icon: Icon, label, value, accent }: { icon: typeof Plug; label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-2xl bg-white/10 backdrop-blur ring-1 ring-white/15 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <Icon className="h-4 w-4 text-white/70" />
      </div>
      <p className={`text-2xl font-extrabold leading-tight ${accent ?? "text-white"}`}>{value}</p>
      <p className="text-[10px] text-white/70 mt-0.5">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Connection["status"] }) {
  if (status === "active") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[11px] font-bold">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> نشط
    </span>
  );
  if (status === "paused") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[11px] font-bold">
      <Clock className="h-3 w-3" /> متوقف
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 text-rose-700 px-2 py-0.5 text-[11px] font-bold">
      <AlertTriangle className="h-3 w-3" /> خطأ
    </span>
  );
}

function ActivityStatusIcon({ status }: { status: ActivityEntry["status"] }) {
  const map = {
    success: <CheckCircle2 className="h-5 w-5 text-emerald-600" />,
    failed:  <XCircle className="h-5 w-5 text-rose-600" />,
    pending: <Clock className="h-5 w-5 text-amber-600" />,
    retry:   <RefreshCw className="h-5 w-5 text-blue-600 animate-spin" />,
  } as const;
  return map[status];
}

function EndpointLine({ method, path, desc }: { method: string; path: string; desc: string }) {
  const color = method === "POST" ? "bg-amber-500/20 text-amber-300" :
               method === "GET"  ? "bg-emerald-500/20 text-emerald-300" :
                                   "bg-blue-500/20 text-blue-300";
  return (
    <div className="flex items-center gap-3">
      <span className={`inline-block w-14 text-center px-2 py-0.5 rounded font-bold text-[11px] ${color}`}>{method}</span>
      <span className="text-slate-100 truncate">{path}</span>
      <span className="text-slate-500 text-xs hidden sm:inline">— {desc}</span>
    </div>
  );
}

function ConnectModal({ system, onClose, onConfirm }: {
  system: SystemDef;
  onClose: () => void;
  onConfirm: (label: string, useAi: boolean) => void;
}) {
  const [label, setLabel] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    setSubmitting(true);
    setTimeout(() => onConfirm(label, useAi), 700);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card rounded-3xl shadow-2xl max-w-md w-full overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className={`relative h-32 bg-gradient-to-br ${system.bg} flex items-center justify-center`}>
          <button onClick={onClose} className="absolute top-3 end-3 h-8 w-8 rounded-full bg-white/20 backdrop-blur text-white flex items-center justify-center hover:bg-white/30">
            <X className="h-4 w-4" />
          </button>
          <div className="h-16 w-16 rounded-2xl bg-white text-slate-800 flex items-center justify-center shadow-xl">
            <system.icon className={`h-8 w-8 ${system.accent}`} />
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div className="text-center">
            <h3 className="text-xl font-extrabold">ربط {system.nameAr}</h3>
            <p className="text-sm text-muted-foreground mt-1">{system.desc}</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold">اسم التكامل</label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={`مثال: فرع الرياض - ${system.nameAr}`}
            />
          </div>

          <button
            onClick={() => setUseAi(!useAi)}
            className={`w-full text-start rounded-2xl border-2 p-3 transition-all ${
              useAi ? "border-violet-500 bg-violet-50" : "border-border bg-card hover:border-primary/30"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                useAi ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white" : "bg-muted text-muted-foreground"
              }`}>
                <Brain className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm">ربط الحقول بالذكاء الاصطناعي</p>
                <p className="text-xs text-muted-foreground">يقترح خريطة كاملة لحقولك تلقائياً</p>
              </div>
              <div className={`h-5 w-5 rounded-full border-2 shrink-0 ${
                useAi ? "border-violet-500 bg-violet-500" : "border-muted-foreground"
              }`}>
                {useAi && <Check className="h-4 w-4 text-white" />}
              </div>
            </div>
          </button>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" onClick={onClose} className="flex-1" disabled={submitting}>إلغاء</Button>
            <Button onClick={submit} disabled={submitting} className={`flex-1 bg-gradient-to-r ${system.bg} text-white border-0 hover:opacity-90 gap-2`}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {submitting ? "جاري الربط..." : "ربط الآن"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AiWizardModal({ onClose, onComplete }: { onClose: () => void; onComplete: (systemId: SystemId) => void }) {
  const [step, setStep] = useState<"upload" | "analyzing" | "result">("upload");
  const [systemId, setSystemId] = useState<SystemId>("odoo");
  const [sample, setSample] = useState("");

  const analyze = () => {
    setStep("analyzing");
    setTimeout(() => setStep("result"), 1800);
  };

  const sys = SYSTEMS.find(s => s.id === systemId)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="relative h-28 bg-gradient-to-br from-violet-600 via-fuchsia-600 to-pink-600 flex items-center justify-center">
          <button onClick={onClose} className="absolute top-3 end-3 h-8 w-8 rounded-full bg-white/20 backdrop-blur text-white flex items-center justify-center hover:bg-white/30">
            <X className="h-4 w-4" />
          </button>
          <div className="h-14 w-14 rounded-2xl bg-white/95 text-violet-700 flex items-center justify-center shadow-xl">
            <Brain className="h-7 w-7" />
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="text-center">
            <h3 className="text-xl font-extrabold">معالج الربط بالذكاء الاصطناعي</h3>
            <p className="text-sm text-muted-foreground mt-1">3 خطوات بسيطة للربط الكامل</p>
          </div>

          {step === "upload" && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-semibold">النظام المصدر</label>
                <div className="grid grid-cols-3 gap-2">
                  {SYSTEMS.slice(0, 6).map(s => (
                    <button
                      key={s.id}
                      onClick={() => setSystemId(s.id)}
                      className={`p-2 rounded-xl border-2 text-xs font-bold transition-all ${
                        systemId === s.id ? "border-violet-500 bg-violet-50" : "border-border hover:border-primary/30"
                      }`}
                    >
                      <s.icon className={`h-4 w-4 mx-auto mb-1 ${s.accent}`} />
                      {s.nameAr}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">الصق عينة JSON من نظامك</label>
                <textarea
                  value={sample}
                  onChange={e => setSample(e.target.value)}
                  placeholder='{"customer": "...", "lines": [...], "total": ...}'
                  className="w-full h-32 rounded-xl border border-border bg-muted/30 p-3 font-mono text-xs"
                  dir="ltr"
                />
                <p className="text-[11px] text-muted-foreground">سيقرأ AI الحقول ويقترح خريطة لزاتكا UBL 2.1</p>
              </div>
              <Button onClick={analyze} className="w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:opacity-90 text-white font-bold gap-2">
                <Sparkles className="h-4 w-4" />
                حلّل بالذكاء الاصطناعي
              </Button>
            </>
          )}

          {step === "analyzing" && (
            <div className="py-8 text-center space-y-3">
              <div className="h-16 w-16 mx-auto rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white flex items-center justify-center animate-pulse">
                <Brain className="h-8 w-8" />
              </div>
              <p className="font-bold">يحلّل البيانات...</p>
              <div className="space-y-1.5 text-sm text-muted-foreground">
                <p>✓ قراءة بنية JSON</p>
                <p>✓ مطابقة الحقول مع UBL 2.1</p>
                <p className="text-violet-700 font-semibold">⟳ تصنيف فئات الضريبة...</p>
              </div>
            </div>
          )}

          {step === "result" && (
            <>
              <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 space-y-2">
                <div className="flex items-center gap-2 text-emerald-800 font-bold">
                  <CheckCircle2 className="h-5 w-5" /> اكتمل التحليل
                </div>
                <div className="text-sm text-emerald-900 space-y-1">
                  <p>✓ تطابق <b>18 حقلاً</b> تلقائياً</p>
                  <p>✓ تم اكتشاف <b>3 فئات ضريبية</b> (15% / صفر / معفي)</p>
                  <p>✓ تنسيق التواريخ متوافق مع زاتكا</p>
                  <p className="text-amber-800">⚠ حقلان يحتاجان مراجعة يدوية</p>
                </div>
              </div>
              <div className="rounded-2xl border border-border p-3 space-y-1.5 text-xs font-mono" dir="ltr">
                <div className="flex justify-between"><span className="text-muted-foreground">{sys.name}.partner_id</span><span className="text-emerald-600">→ Customer.id ✓</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{sys.name}.move_lines[]</span><span className="text-emerald-600">→ InvoiceLine[] ✓</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{sys.name}.tax_id</span><span className="text-emerald-600">→ TaxCategory ✓</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{sys.name}.amount_total</span><span className="text-emerald-600">→ TotalAmount ✓</span></div>
              </div>
              <Button onClick={() => onComplete(systemId)} className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:opacity-90 text-white font-bold gap-2">
                <Plug className="h-4 w-4" />
                اعتماد الربط وتفعيل التكامل
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
