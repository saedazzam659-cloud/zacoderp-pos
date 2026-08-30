// SuperAdmin — «سيرفرات الوكلاء» (Agent Instances).
// مركز التحكم في نسخ الوكلاء: السيرفر (SSH)، قاعدة البيانات الخارجية،
// الترخيص والتعطيل الفوري، هوية الوكيل (اسم + لوجو) على صفحة دخول دومينه،
// وتنبيهات الأمان (بصمة الداتابيز، دومين غير معروف، محاولات تسجيل...).
// الأسرار (رابط الداتابيز، SSH) تُرسل للحفظ فقط ولا تُعرض بعد الحفظ.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DateField } from "@/components/ui/date-field";
import {
  Server, Plus, Pencil, Trash2, Database, KeyRound, ShieldAlert, Globe,
  Plug, Loader2, CheckCircle2, XCircle, Ban, Play, Copy, Palette, RefreshCw,
  HeartPulse, AlertTriangle, UploadCloud, FileDown, Mail, Check, LockKeyhole,
  Zap, Activity, BarChart, ServerCog, Link as LinkIcon
} from "lucide-react";
import { DEFAULT_LOCAL_SUPERADMIN_SCREENS, LOCAL_SUPERADMIN_SCREENS } from "@/lib/localSuperadminScreens";
import { PlatformLinksTopLevel } from "./platform-links/PlatformLinksManagement";
import { LocalAgentLinks } from "./platform-links/LocalAgentLinks";
import { ImportedAgentsList } from "./platform-links/ImportedAgentsList";
import { ZatcaTransferAction } from "./ZatcaTransferWizard";
import { AgentHandoffAction } from "./AgentHandoffWizard";

const API = import.meta.env.VITE_API_URL ?? "";

// جريدة ألوان جاهزة لهوية الوكيل
const BRAND_PALETTE = [
  "#0f766e", "#0e7490", "#1d4ed8", "#4f46e5", "#7c3aed", "#a21caf",
  "#be123c", "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d",
  "#16a34a", "#059669", "#334155", "#111827",
];

// يقرأ ملف صورة ويصغّرها (≤512px) ويرجع data URL — يحافظ على الشفافية.
async function fileToLogoDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error("اختر صورة PNG أو JPG أو WEBP");
  if (file.size > 3 * 1024 * 1024) throw new Error("حجم الصورة يجب ألا يتجاوز 3MB");
  const raw = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("تعذّرت قراءة الملف"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("ملف الصورة غير صالح"));
    i.src = raw;
  });
  const MAX = 512;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

type Agent = {
  id: number; name: string; contactPhone: string | null; contactEmail: string | null;
  domain: string; extraDomains: string[] | null;
  status: "active" | "suspended"; mode: "frontend_only" | "full_shell" | "full";
  packageSource: "central" | "external";
  localSuperadminEnabled: boolean;
  localSuperadminScreens: string[];
  installationId: string; licenseKey: string | null; licenseExpiresAt: string | null;
  maxCompanies: number | null;
  dbUrlSet: boolean; dbStatus: string; dbLastCheckAt: string | null; dbLastError: string | null;
  sshHost: string | null; sshPort: number | null; sshUser: string | null; sshSecretSet: boolean; sshStatus: string; sshLastCheckAt: string | null;
  brandName: string | null; brandLogoUrl: string | null; brandColor: string | null;
  lastHeartbeatAt: string | null; lastSeenIp: string | null; deployedVersion: string | null;
  deployStatus: string; deployLog: string | null; lastDeployAt: string | null;
  operationKind?: "schema" | "provision" | null;
  saUsername: string | null; saEmail: string | null; saPasswordSet: boolean;
  externalPackage: PackageStatus;
  notes: string | null; createdAt: string; updatedAt: string;
  autoDomainSetup: boolean; autoDomainProxyEnabled: boolean;
  autoDomainStatus: "disabled" | "pending" | "checking" | "configuring" | "waiting_dns" | "verifying" | "ready" | "error";
  autoDomainZoneName?: string; autoDomainOriginIp?: string;
  autoDomainLastCheckAt?: string | null; autoDomainLastSuccessAt?: string | null;
  autoDomainLastError?: string | null; autoDomainLog?: string | null;
  cloudflareConnected: boolean;
  invoiceAccelerationMode?: "off" | "trial" | "on";
  invoiceTrialRemaining?: number | null;
  invoiceAccelerationLastError?: string | null;
  invoiceAccelerationUpdatedAt?: string | null;
};

type AutoDomainPreviewResp = {
  ok: boolean;
  confirmationToken: string | null;
  canApplyNow: boolean;
  canUseWithProvision: boolean;
  checkedAt: string;
  cloudflare: {
    connected: boolean;
    zoneName?: string;
    action: "create" | "update" | "noop" | "conflict";
    existingType?: string;
    existingContent?: string;
    existingProxied?: boolean;
    desiredContent: string;
    desiredProxied: boolean;
    conflict?: string;
  };
  server: {
    host: string;
    originIp: string;
    sshAuthenticated: boolean;
    firewall: "ufw" | "firewalld" | "none";
    activeServices: string[];
    caddyManaged: boolean;
    conflicts: string[];
    ports: Array<{ port: 80 | 443; state: "open" | "refused" | "timeout"; ms: number }>;
  };
  warnings: string[];
  error?: string;
  code?: string;
};

type PackageKind = "backend" | "frontend" | "db";
type PackageInfo = {
  filename: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  version: string | null;
  format: "tgz" | "pg_custom" | "sql" | "sql_gzip";
  encrypted: true;
  verified: true;
  origin: "generated" | "uploaded";
};
type PackageStatus = Record<PackageKind, PackageInfo | null>;

type SecEvent = {
  id: number; agentId: number | null; agentName: string | null; eventType: string;
  detail: any; host: string | null; ip: string | null; resolved: boolean; createdAt: string;
};

const EVENT_LABEL: Record<string, string> = {
  db_fingerprint_mismatch: "بصمة قاعدة البيانات غير مطابقة (احتمال نسخ/تلاعب)",
  unknown_domain: "استخدام من دومين غير مسجّل",
  unknown_installation: "محاولة اتصال بمعرّف تركيب غير معروف",
  license_mismatch: "مفتاح ترخيص غير مطابق",
  license_expired: "الترخيص منتهي",
  suspended: "محاولة اتصال ونسخة موقوفة",
  register_blocked: "محاولة إنشاء حساب من دومين وكيل (تم منعها)",
  suspended_by_admin: "تعطيل يدوي من المشرف",
  heartbeat_suspended: "نبض من نسخة موقوفة",
};

type DomainCheckRow = {
  domain: string; ips: string[]; dnsOk: boolean;
  onServer: boolean | null; live: boolean; httpStatus: number | null;
  latencyMs: number | null; error: string | null;
};
type DomainCheckResp = {
  ok: boolean; serverHost: string | null; serverIps: string[];
  results: DomainCheckRow[]; checkedAt: string;
};

const emptyForm = {
  id: 0, name: "", contactPhone: "", contactEmail: "", domain: "", extraDomainsText: "",
  mode: "frontend_only", packageSource: "central", localSuperadminEnabled: false, localSuperadminScreens: [...DEFAULT_LOCAL_SUPERADMIN_SCREENS], maxCompanies: "", licenseExpiresAt: "",
  dbUrl: "", sshHost: "", sshPort: "22", sshUser: "", sshSecret: "",
  brandName: "", brandLogoUrl: "", brandColor: "", notes: "",
  saUsername: "", saEmail: "", saPassword: "",
  autoDomainSetup: false, autoDomainProxyEnabled: false,
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return String(s).slice(0, 16).replace("T", " ");
}

function AgentAccelerationCard({ agent, invalidate }: { agent: Agent; invalidate: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [showDiag, setShowDiag] = useState(false);
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  if (agent.mode === "full") {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-900/30 text-xs text-muted-foreground flex items-start gap-2">
        <ServerCog className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="space-y-1">
          <div className="font-semibold text-slate-700 dark:text-slate-300">تسريع الفواتير (غير متاح)</div>
          <p>تسريع الفواتير غير متاح: النسخة تعمل محليًا بالكامل وتتطلب تعديلات مباشرة على الخادم الوسيط (Caddy) و(Proxy).</p>
        </div>
      </div>
    );
  }

  const mode = agent.invoiceAccelerationMode || "off";

  async function loadDiagnostics() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agent.id}/invoice-acceleration/diagnostics`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل جلب التشخيص");
      setDiagnostics(j);
      setShowDiag(true);
    } catch (e: any) {
      toast({ title: "فشل فحص التسريع", description: String(e.message || e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function setTrial() {
    if (!confirm("هل أنت متأكد من بدء تجربة تسريع الفواتير لهذا الوكيل؟\nستبقى البيانات في قاعدة الوكيل نفسها، وستُستخدم خوارزمية القراءات المتوازية لخمس عمليات حفظ ناجحة.")) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agent.id}/invoice-acceleration/trial`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: true })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل بدء التجربة");
      toast({ title: "تم بدء التجربة بنجاح" });
      invalidate();
    } catch (e: any) {
      toast({ title: "خطأ", description: String(e.message || e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!confirm("إيقاف تسريع الفواتير والعودة للوضع القياسي؟")) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agent.id}/invoice-acceleration/off`, {
        method: "POST",
        headers
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل الإيقاف");
      toast({ title: "تم الإيقاف بنجاح" });
      invalidate();
    } catch (e: any) {
      toast({ title: "خطأ", description: String(e.message || e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="border border-indigo-100 dark:border-indigo-900/50 rounded-lg p-3 bg-indigo-50/30 dark:bg-indigo-950/10" data-testid={`acceleration-card-${agent.id}`}>
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-md ${mode === 'on' ? 'bg-indigo-100 text-indigo-700' : mode === 'trial' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
              <Zap className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs font-semibold flex items-center gap-1.5">
                تسريع الفواتير
                {mode === "on" ? <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-indigo-50 text-indigo-700 border-indigo-200">مفعّل</Badge>
                : mode === "trial" ? <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-amber-50 text-amber-700 border-amber-200">تجربة ({agent.invoiceTrialRemaining ?? 0} متبقية)</Badge>
                : <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200">متوقف</Badge>}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                الخادم المركزي لا يزال يكتب إلى قاعدة الوكيل فقط. لا يتم تعديل ملفات السيرفر أو (SSH).
              </div>
              {agent.invoiceAccelerationLastError && (
                <div className="text-[10px] text-rose-600 mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {agent.invoiceAccelerationLastError}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={loadDiagnostics} disabled={busy} data-testid={`btn-diag-${agent.id}`}>
              {busy ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <Activity className="h-3 w-3 ms-1" />}
              فحص وتشخيص
            </Button>
            {mode === "off" && (
              <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={setTrial} disabled={busy} data-testid={`btn-trial-${agent.id}`}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin ms-1" /> : <Play className="h-3 w-3 ms-1" />}
                بدء تجربة
              </Button>
            )}
            {(mode === "trial" || mode === "on") && (
              <Button variant="outline" size="sm" className="h-7 text-xs text-rose-600 border-rose-200 hover:bg-rose-50" onClick={turnOff} disabled={busy} data-testid={`btn-off-${agent.id}`}>
                إيقاف
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={showDiag} onOpenChange={setShowDiag}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-600" />
              تشخيص تسريع الفواتير — {agent.name}
            </DialogTitle>
          </DialogHeader>

          {diagnostics ? (
            <div className="space-y-4 py-2 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div className="border rounded-md p-3 space-y-2">
                  <div className="font-semibold text-xs text-muted-foreground mb-1 flex items-center gap-1"><Globe className="h-4 w-4" /> الشبكة</div>
                  <div className="flex justify-between">
                    <span>DNS:</span>
                    <span dir="ltr" className={diagnostics.dnsProbe?.ok ? "text-emerald-600" : "text-rose-600"}>
                      {diagnostics.dnsProbe?.ok ? diagnostics.dnsProbe.ips?.join(", ") || "OK" : "Failed"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>HTTPS:</span>
                    <span dir="ltr">{diagnostics.httpsProbe?.latencyMs != null ? `${diagnostics.httpsProbe.latencyMs} ms` : "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Status:</span>
                    <span dir="ltr" className={diagnostics.httpsProbe?.ok ? "text-emerald-600" : "text-rose-600"}>
                      {diagnostics.httpsProbe?.statusCode ?? "—"}
                    </span>
                  </div>
                  {(diagnostics.dnsProbe?.error || diagnostics.httpsProbe?.error) && (
                    <div className="text-xs text-rose-600 mt-1">
                      {diagnostics.dnsProbe?.error || diagnostics.httpsProbe?.error}
                    </div>
                  )}
                </div>

                <div className="border rounded-md p-3 space-y-2">
                  <div className="font-semibold text-xs text-muted-foreground mb-1 flex items-center gap-1"><Database className="h-4 w-4" /> قاعدة البيانات</div>
                  <div className="flex justify-between">
                    <span>عينات SELECT 1:</span>
                    <span dir="ltr">{diagnostics.dbProbe?.samples?.map((s: any) => s.ok ? `${s.ms}ms` : "failed").join(" / ") || "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Pool:</span>
                    <span dir="ltr" className="text-xs">
                      {diagnostics.dbProbe?.poolStats
                        ? `${diagnostics.dbProbe.poolStats.idle}/${diagnostics.dbProbe.poolStats.total} idle`
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="border rounded-md overflow-hidden">
                <div className="bg-slate-50 dark:bg-slate-900 px-3 py-2 border-b text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <BarChart className="h-4 w-4" /> مقارنة الأداء (حفظ الفاتورة)
                </div>
                <div className="grid grid-cols-2 divide-x divide-x-reverse divide-border">
                  <div className="p-3 space-y-2">
                    <div className="text-xs font-semibold mb-2">الأداء القياسي (Baseline)</div>
                    <div className="flex justify-between text-xs"><span>العينة:</span> <span dir="ltr">{diagnostics.sampleStats?.baseline?.count ?? 0}</span></div>
                    <div className="flex justify-between text-xs"><span>Avg:</span> <span dir="ltr">{diagnostics.sampleStats?.baseline?.avg ? `${diagnostics.sampleStats.baseline.avg} ms` : "—"}</span></div>
                    <div className="flex justify-between text-xs"><span>P95:</span> <span dir="ltr">{diagnostics.sampleStats?.baseline?.p95 ? `${diagnostics.sampleStats.baseline.p95} ms` : "—"}</span></div>
                  </div>
                  <div className="p-3 space-y-2 bg-indigo-50/30">
                    <div className="text-xs font-semibold mb-2 text-indigo-800">الأداء المسرّع (Accelerated)</div>
                    <div className="flex justify-between text-xs"><span>العينة:</span> <span dir="ltr">{diagnostics.sampleStats?.accelerated?.count ?? 0}</span></div>
                    <div className="flex justify-between text-xs"><span>Avg:</span> <span dir="ltr">{diagnostics.sampleStats?.accelerated?.avg ? `${diagnostics.sampleStats.accelerated.avg} ms` : "—"}</span></div>
                    <div className="flex justify-between text-xs">
                      <span>P95:</span>
                      <span dir="ltr" className={diagnostics.sampleStats?.accelerated?.p95 > 0 && diagnostics.sampleStats.accelerated.p95 < 1000 ? "text-emerald-600 font-semibold" : ""}>
                        {diagnostics.sampleStats?.accelerated?.p95 ? `${diagnostics.sampleStats.accelerated.p95} ms` : "—"}
                      </span>
                    </div>
                    {diagnostics.sampleStats?.improvementPct != null && (
                      <div className="flex justify-between text-xs mt-1 pt-1 border-t border-indigo-100">
                        <span>نسبة التحسن:</span>
                        <span dir="ltr" className={diagnostics.sampleStats.improvementPct > 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                          {diagnostics.sampleStats.improvementPct}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {!diagnostics.eligibility?.eligible && diagnostics.eligibility?.reason && (
                <div className="bg-rose-50 text-rose-700 p-3 rounded-md text-xs flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold mb-0.5">غير مؤهل للتسريع</div>
                    <p>{diagnostics.eligibility.reason}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDiag(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}


export default function AgentServers() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const listQ = useQuery<Agent[]>({
    queryKey: ["agent-instances"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
  });
  const eventsQ = useQuery<SecEvent[]>({
    queryKey: ["agent-security-events"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/security-events`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [formPackageFiles, setFormPackageFiles] = useState<Record<PackageKind, File | null>>({ backend: null, frontend: null, db: null });
  const [formPackageProgress, setFormPackageProgress] = useState<string | null>(null);
  const [smtpRepair, setSmtpRepair] = useState({
    host: "smtp.gmail.com",
    port: "587",
    user: "",
    password: "",
    from: "",
  });
  const [busy, setBusy] = useState<string | null>(null); // "<action>-<id>"
  const [logView, setLogView] = useState<{ title: string; text: string } | null>(null);
  const [showLogoDialog, setShowLogoDialog] = useState(false);
  const [logoDrag, setLogoDrag] = useState(false);
  const [emailPkg, setEmailPkg] = useState<{ agent: Agent; email: string } | null>(null);
  const [kitView, setKitView] = useState<{ agent: string; kit: any } | null>(null);
  // فحص النطاقات — نتائج DNS + HTTPS لكل نطاقات الوكيل (إضافة قراءة فقط).
  const [domainCheck, setDomainCheck] = useState<{ agent: Agent; loading: boolean; data?: DomainCheckResp } | null>(null);
  // فحص الحظر — هل سيرفر الوكيل حاظر عنوان المنصة (fail2ban)؟
  const [banCheck, setBanCheck] = useState<{ agent: Agent; loading: boolean; data?: any } | null>(null);

  // إعداد النطاق التلقائي (Cloudflare)
  const [previewAgent, setPreviewAgent] = useState<Agent | null>(null);
  const [previewData, setPreviewData] = useState<AutoDomainPreviewResp | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [pendingProvisionAgent, setPendingProvisionAgent] = useState<Agent | null>(null);

  const isEdit = form.id > 0;
  const editingAgent = (listQ.data ?? []).find(x => x.id === form.id) ?? null;
  const set = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agent-instances"] });
    qc.invalidateQueries({ queryKey: ["agent-security-events"] });
    qc.invalidateQueries({ queryKey: ["controller-links"] });
    qc.invalidateQueries({ queryKey: ["imported-controller-links"] });
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const wasEdit = form.id > 0;
      const wantsExternal = form.mode === "full" && form.packageSource === "external";
      const payload: any = {
        name: form.name, domain: form.domain,
        contactPhone: form.contactPhone || null, contactEmail: form.contactEmail || null,
        extraDomains: form.extraDomainsText.split(/[\n,،]+/).map(s => s.trim()).filter(Boolean),
        mode: form.mode,
        packageSource: wantsExternal && editingAgent?.packageSource === "external" ? "external" : "central",
        maxCompanies: form.maxCompanies ? Number(form.maxCompanies) : null,
        licenseExpiresAt: form.licenseExpiresAt || null,
        brandName: form.brandName || null, brandColor: form.brandColor || null,
        sshHost: form.sshHost || null, sshPort: form.sshPort ? Number(form.sshPort) : null, sshUser: form.sshUser || null,
        notes: form.notes || null,
        autoDomainSetup: form.autoDomainSetup,
        autoDomainProxyEnabled: form.autoDomainProxyEnabled,
      };
      // Existing agents save their Super Admin policy through its dedicated
      // button. The general/package save must never submit password fields:
      // browser password managers can autofill hidden tabs unexpectedly.
      if (!wasEdit) {
        payload.localSuperadminEnabled = form.mode === "full" && form.localSuperadminEnabled;
        payload.localSuperadminScreens = form.mode === "full" && form.localSuperadminEnabled ? form.localSuperadminScreens : [];
      }
      if (!wasEdit && form.mode === "full" && form.localSuperadminEnabled) {
        payload.saUsername = form.saUsername.trim() || null;
        payload.saEmail = form.saEmail.trim() || null;
        if (form.saPassword.trim()) payload.saPassword = form.saPassword.trim();
      }
      // اللوجو: الـ WAF في الإنتاج يمنع data: URIs داخل جسم الطلب — نرسل
      // base64 + mime منفصلين ويعيد السيرفر بناء الرابط.
      const logo = form.brandLogoUrl.trim();
      if (logo.startsWith("data:")) {
        const m = logo.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (m) { payload.brandLogoMime = m[1]; payload.brandLogoB64 = m[2]; }
      } else {
        payload.brandLogoUrl = logo || null;
      }
      // Secrets: send ONLY when a new value was typed (never echo back).
      if (form.dbUrl.trim()) payload.dbUrl = form.dbUrl.trim();
      if (form.sshSecret.trim()) payload.sshSecret = form.sshSecret.trim();
      let createdId: number | null = null;
      const rollbackKinds: PackageKind[] = [];
      try {
        // When creating an external edition, first create its identity as a
        // normal full agent. This gives the encrypted package an installation-
        // specific key; packageSource is flipped only after all three verify.
        const r = await fetch(`${API}/api/admin/agent-instances${wasEdit ? `/${form.id}` : ""}`, {
          method: wasEdit ? "PUT" : "POST", headers, body: JSON.stringify(payload),
        });
        const initial = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(initial.error ?? "فشل الحفظ");
        const agentId = Number(initial.id ?? form.id);
        if (!wasEdit) createdId = agentId;
        if (!wantsExternal) return initial;

        const allKinds: PackageKind[] = ["backend", "frontend", "db"];
        const selected = allKinds.filter(kind => !!formPackageFiles[kind]);
        const missingAfterSelection = allKinds.filter(kind =>
          !formPackageFiles[kind] && !editingAgent?.externalPackage?.[kind],
        );
        if (selected.length > 0) {
          if (missingAfterSelection.length > 0) {
            throw new Error(`أكمل ملفات النسخة الخارجية: ${missingAfterSelection.map(packageLabel).join("، ")}`);
          }
          for (const kind of selected) {
            setFormPackageProgress(`رفع ${packageLabel(kind)}`);
            await uploadPackageOrThrow(agentId, kind, formPackageFiles[kind]!);
            if (!editingAgent?.externalPackage?.[kind]) rollbackKinds.push(kind);
          }
        } else {
          const existingReady = (["backend", "frontend", "db"] as PackageKind[])
            .every(kind => !!editingAgent?.externalPackage?.[kind]);
          if (existingReady) {
            // Existing verified package can be adopted without rebuilding.
          } else {
          setFormPackageProgress("تجهيز الحزمة المشفّرة من قاعدة بيانات الوكيل");
          const prep = await fetch(`${API}/api/admin/agent-instances/${agentId}/external-package/prepare`, { method: "POST", headers });
          const prepJson = await prep.json().catch(() => ({}));
          if (!prep.ok) throw new Error(prepJson.error ?? "فشل تجهيز الحزمة الخارجية");
          }
        }

        setFormPackageProgress("اعتماد النسخة الخارجية");
        const finalize = await fetch(`${API}/api/admin/agent-instances/${agentId}`, {
          method: "PUT", headers, body: JSON.stringify({
            packageSource: "external",
            mode: "full",
          }),
        });
        const finalJson = await finalize.json().catch(() => ({}));
        if (!finalize.ok) throw new Error(finalJson.error ?? "فشل اعتماد النسخة الخارجية");
        return finalJson;
      } catch (error) {
        // A failed multi-step create must not leave a half-created agent.
        if (createdId) {
          await fetch(`${API}/api/admin/agent-instances/${createdId}`, { method: "DELETE", headers }).catch(() => {});
        } else if (editingAgent?.packageSource !== "external") {
          await Promise.all(rollbackKinds.map(kind =>
            fetch(`${API}/api/admin/agent-instances/${form.id}/custom-package/${kind}`, {
              method: "DELETE",
              headers,
            }).catch(() => null),
          ));
        }
        throw error;
      } finally {
        setFormPackageProgress(null);
      }
    },
    onSuccess: () => {
      invalidate();
      setFormPackageFiles({ backend: null, frontend: null, db: null });
      setShowForm(false);
      toast({ title: "تم الحفظ", description: form.packageSource === "external" ? "النسخة الخارجية مكتملة ومشفّرة وجاهزة للتسطيب" : undefined });
    },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }),
  });

  async function action(id: number, path: string, label: string, body?: any) {
    setBusy(`${path}-${id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${id}/${path}`, {
        method: "POST", headers, body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل");
      invalidate();
      toast({ title: `${label}: تم بنجاح`, description: j.version ?? (j.licenseKey ? `المفتاح: ${j.licenseKey}` : undefined) });
    } catch (e: any) {
      toast({ title: `${label}: فشل`, description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function saveSshCredentials() {
    if (!form.id) return;
    setBusy(`ssh-save-${form.id}`);
    try {
      const payload: Record<string, unknown> = {
        sshHost: form.sshHost.trim(),
        sshPort: Number(form.sshPort || 22),
        sshUser: form.sshUser.trim(),
      };
      if (form.sshSecret.trim()) payload.sshSecret = form.sshSecret.trim();
      const r = await fetch(`${API}/api/admin/agent-instances/${form.id}/ssh-credentials`, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل حفظ بيانات SSH");
      set("sshSecret", "");
      invalidate();
      toast({
        title: "تم حفظ بيانات SSH",
        description: "تم الحفظ بشكل مستقل عن إعدادات Super Admin والحزمة الخارجية",
      });
    } catch (e: any) {
      toast({ title: "فشل حفظ بيانات SSH", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function repairAgentEmail() {
    if (!form.id) return;
    setBusy(`repair-email-${form.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${form.id}/repair-email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          host: smtpRepair.host.trim(),
          port: Number(smtpRepair.port || 587),
          user: smtpRepair.user.trim(),
          password: smtpRepair.password,
          from: smtpRepair.from.trim() || smtpRepair.user.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل إصلاح البريد");
      toast({
        title: "تم إصلاح بريد الوكيل",
        description: j.note ?? "تم إرسال رسالة اختبار. اطلب رمز OTP جديدًا بعد وصولها.",
      });
      setSmtpRepair(p => ({ ...p, password: "" }));
    } catch (e: any) {
      toast({ title: "فشل إصلاح بريد الوكيل", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function saveLocalSuperadminSettings() {
    if (!form.id) return;
    const existingPassword = editingAgent?.saPasswordSet;
    if (form.localSuperadminEnabled
      && (!form.saUsername.trim() || !form.saEmail.trim() || (!existingPassword && !form.saPassword.trim()))) {
      toast({ title: "أكمل بيانات السوبر أدمن المحلي: اسم المستخدم وكلمة المرور وإيميل OTP", variant: "destructive" });
      return;
    }
    if (form.localSuperadminEnabled && form.localSuperadminScreens.length === 0) {
      toast({ title: "اختر شاشة واحدة على الأقل للوحة Super Admin", variant: "destructive" });
      return;
    }
    setBusy(`save-local-sa-${form.id}`);
    try {
      const payload: Record<string, unknown> = {
        localSuperadminEnabled: form.localSuperadminEnabled,
        localSuperadminScreens: form.localSuperadminEnabled ? form.localSuperadminScreens : [],
      };
      if (form.localSuperadminEnabled) {
        payload.saUsername = form.saUsername.trim();
        payload.saEmail = form.saEmail.trim();
        if (form.saPassword.trim()) payload.saPassword = form.saPassword.trim();
      }
      const r = await fetch(`${API}/api/admin/agent-instances/${form.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل حفظ إعدادات Super Admin");
      set("saPassword", "");
      invalidate();
      toast({
        title: "تم حفظ إعدادات Super Admin فقط",
        description: existingPassword && !form.saPassword.trim()
          ? "تم الإبقاء على كلمة المرور المشفّرة الحالية."
          : undefined,
      });
    } catch (e: any) {
      toast({ title: "فشل حفظ إعدادات Super Admin", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function checkDomains(a: Agent) {
    setDomainCheck({ agent: a, loading: true });
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/check-domains`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل الفحص");
      setDomainCheck({ agent: a, loading: false, data: j });
    } catch (e: any) {
      setDomainCheck(null);
      toast({ title: "فحص النطاقات: فشل", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  async function checkBan(a: Agent) {
    setBanCheck({ agent: a, loading: true });
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/check-ban`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل الفحص");
      setBanCheck({ agent: a, loading: false, data: j });
    } catch (e: any) {
      setBanCheck(null);
      toast({ title: "فحص الحظر: فشل", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  // فك الحظر بضغطة زر — ينفّذ fail2ban unban --all على سيرفر الوكيل عبر SSH
  // ويضيف عنوان المنصة لقائمة التجاهل حتى لا يتكرر الحظر.
  async function unban(a: Agent) {
    if (!confirm(`فك كل الحظر على سيرفر «${a.name}» وإضافة عنوان المنصة لقائمة التجاهل؟`)) return;
    setBusy(`unban-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/unban`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل");
      invalidate();
      toast({ title: "فك الحظر: تم", description: j.note });
    } catch (e: any) {
      toast({ title: "فك الحظر: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function openSetupKit(a: Agent) {
    setBusy(`kit-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/setup-kit`, { headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل");
      setKitView({ agent: a.name, kit: j });
    } catch (e: any) {
      toast({ title: "حزمة التهيئة: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function deployNow(a: Agent) {
    if (!confirm(`نشر التهيئة على سيرفر «${a.name}» عبر SSH؟\nسيتم تثبيت الوكيل العكسي (Caddy) ونبض الترخيص وربط الدومين بالمنصة.`)) return;
    setBusy(`deploy-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/deploy`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      invalidate();
      if (!r.ok) {
        setLogView({ title: `سجل النشر — ${a.name}`, text: j.log ?? j.detail ?? j.error ?? "فشل" });
        throw new Error(j.error ?? "فشل النشر");
      }
      setLogView({ title: `سجل النشر — ${a.name}`, text: j.log ?? "" });
      toast({ title: "تم النشر بنجاح" });
    } catch (e: any) {
      toast({ title: "النشر: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  // ── الحذف الكامل من سيرفر الوكيل (حماية الملكية الفكرية) ──
  const [wipeAgent, setWipeAgent] = useState<Agent | null>(null);
  async function wipeNow(a: Agent) {
    setWipeAgent(null);
    setBusy(`wipe-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/wipe`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل");
      invalidate();
      setLogView({ title: `سجل الحذف الكامل — ${a.name}`, text: j.log ?? "" });
      toast(j.wiped
        ? { title: "تم الحذف الكامل من السيرفر", description: "أُزيلت كل برامج وملفات zacoderp وأُلغي الترخيص." }
        : { title: "تم إلغاء الترخيص وتعطيل النسخة", description: "تعذّر الوصول للسيرفر عبر SSH — النسخة ستتوقف تلقائيًا مع أول نبض.", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "الحذف الكامل: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  // ── التسطيب الكامل بضغطة واحدة ──
  const [provisionAgentId, setProvisionAgentId] = useState<number | null>(null);
  const [operationViewKind, setOperationViewKind] = useState<"provision" | "schema">("provision");
  const [schemaUpgradeAgent, setSchemaUpgradeAgent] = useState<Agent | null>(null);
  // نافذة اختيار طريقة التسطيب: كامل / بدون قاعدة بيانات / برفع ملفات (+ تشفير)
  const [installDlg, setInstallDlg] = useState<{ agentId: number; variant: "full" | "no_db" | "upload" | "upload_no_db"; encrypt: boolean; autoDomainToken?: string } | null>(null);
  const installAgent = (listQ.data ?? []).find(x => x.id === installDlg?.agentId) ?? null;
  const [pkgStatus, setPkgStatus] = useState<PackageStatus | null>(null);
  const [pkgBusy, setPkgBusy] = useState<string | null>(null);

  function packageLabel(kind: PackageKind): string {
    return kind === "backend" ? "Backend" : kind === "frontend" ? "Frontend" : "قاعدة البيانات";
  }

  async function refreshPkgStatus(agentId: number) {
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package`, { headers });
      setPkgStatus(r.ok ? await r.json() : null);
    } catch { setPkgStatus(null); }
  }
  useEffect(() => {
    if (installDlg?.variant === "upload") void refreshPkgStatus(installDlg.agentId);
  }, [installDlg?.agentId, installDlg?.variant]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadPackageOrThrow(agentId: number, kind: PackageKind, f: File): Promise<PackageInfo> {
    if (f.size <= 0 || f.size > 800 * 1024 * 1024) throw new Error("حجم الملف يجب أن يكون بين 1 بايت و800MB");
    const init = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}/upload-url`, {
      method: "POST", headers, body: JSON.stringify({ filename: f.name, sizeBytes: f.size }),
    });
    const target = await init.json().catch(() => ({}));
    if (!init.ok) throw new Error(target.error ?? "تعذّر بدء الرفع المباشر");
    const put = await fetch(target.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: f,
    });
    if (!put.ok) throw new Error(`فشل الرفع المباشر إلى التخزين (${put.status})`);
    const complete = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}/complete`, {
      method: "POST", headers, body: JSON.stringify({
        objectPath: target.objectPath,
        filename: f.name,
        sizeBytes: f.size,
      }),
    });
    const verified = await complete.json().catch(() => ({}));
    if (!complete.ok) throw new Error(verified.error ?? "فشل التحقق من الملف أو تشفير الحزمة");
    return verified as PackageInfo;
  }

  async function uploadPkg(agentId: number, kind: PackageKind, f: File) {
    setPkgBusy(kind);
    try {
      const verified = await uploadPackageOrThrow(agentId, kind, f);
      toast({ title: "تم الرفع المباشر والتشفير والتحقق", description: `${f.name} · ${String(verified.sha256 ?? "").slice(0, 12)}…` });
      await refreshPkgStatus(agentId);
      invalidate();
    } catch (e: any) {
      toast({ title: "فشل رفع الملف", description: String(e.message ?? e), variant: "destructive" });
    } finally { setPkgBusy(null); }
  }
  async function deletePkg(agentId: number, kind: "backend" | "frontend" | "db") {
    setPkgBusy(kind);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}`, { method: "DELETE", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل الحذف");
      await refreshPkgStatus(agentId);
      invalidate();
    } catch (e: any) {
      toast({ title: "فشل حذف الحزمة", description: String(e.message ?? e), variant: "destructive" });
    } finally { setPkgBusy(null); }
  }

  async function prepareExternalPackage(a: Agent) {
    setPkgBusy("prepare");
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/external-package/prepare`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل تجهيز الحزمة");
      await refreshPkgStatus(a.id);
      invalidate();
      toast({ title: "تم تجهيز النسخة الخارجية", description: `الإصدار ${j.version} — الملفات الثلاثة مشفّرة ومتحقق منها` });
    } catch (e: any) {
      toast({ title: "فشل تجهيز النسخة الخارجية", description: String(e.message ?? e), variant: "destructive" });
    } finally { setPkgBusy(null); }
  }

  async function downloadPkg(agentId: number, kind: PackageKind) {
    setPkgBusy(`download-${kind}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}/download`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل التنزيل");
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") ?? "";
      const filename = cd.match(/filename="([^"]+)"/)?.[1] ?? `${kind}.zacpkg.enc`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      toast({ title: "فشل تنزيل الحزمة", description: String(e.message ?? e), variant: "destructive" });
    } finally { setPkgBusy(null); }
  }
  const provisionAgent = (listQ.data ?? []).find(x => x.id === provisionAgentId) ?? null;
  const operationIsSchema = provisionAgent?.operationKind === "schema" || operationViewKind === "schema";
  const anyDeploying = (listQ.data ?? []).some(x =>
    x.deployStatus === "deploying" ||
    ["checking", "configuring", "waiting_dns", "verifying"].includes(x.autoDomainStatus)
  );
  // سجل حي: أثناء أي تسطيب جارٍ حدّث القائمة كل 3 ثوانٍ.
  useEffect(() => {
    if (!anyDeploying) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["agent-instances"] }), 3000);
    return () => clearInterval(t);
  }, [anyDeploying, qc]);

  function isAutoDomainBusy(a: Agent) {
    return ["checking", "configuring", "waiting_dns", "verifying"].includes(a.autoDomainStatus);
  }

  function isOperationStale(a: Agent) {
    return a.deployStatus === "deploying"
      && Date.now() - new Date(a.updatedAt).getTime() >= 3 * 60_000;
  }

  async function recoverOperation(a: Agent) {
    if (!confirm(`محاولة استعادة العملية المعلّقة على «${a.name}»؟\nلن يُفتح القفل إلا بعد إثبات توقف السكربت البعيد عبر SSH.`)) return;
    setBusy(`recover-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/operation/recover`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "تعذّرت الاستعادة");
      invalidate();
      toast({ title: "تم تحرير العملية المعلّقة بأمان", description: j.message });
    } catch (e: any) {
      toast({ title: "لم يتم تحرير القفل", description: String(e.message ?? e), variant: "destructive" });
      invalidate();
    } finally {
      setBusy(null);
    }
  }

  async function upgradeAgentDatabase(a: Agent) {
    setSchemaUpgradeAgent(null);
    setBusy(`schema-upgrade-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/schema-upgrade`, {
        method: "POST", headers, body: JSON.stringify({ confirm: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "تعذّر بدء ترقية قاعدة البيانات");
      setOperationViewKind("schema");
      setProvisionAgentId(a.id);
      invalidate();
      toast({
        title: "بدأت ترقية قاعدة بيانات الوكيل",
        description: "سيتم إنشاء نسخة أمان أولًا، ولن تُستبدل قاعدة البيانات الحالية.",
      });
    } catch (e: any) {
      toast({ title: "فشل بدء ترقية القاعدة", description: String(e.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function loadPreview(a: Agent) {
    setPreviewAgent(a);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);
    setPreviewConfirmed(false);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/auto-domain/preview`, {
        method: "POST", headers, body: JSON.stringify({})
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل التحضير");
      setPreviewData(j);
    } catch (e: any) {
      setPreviewError(String(e.message ?? e));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function applyAutoDomain(id: number, token: string) {
    setBusy(`apply-domain-${id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${id}/auto-domain/apply`, {
        method: "POST", headers, body: JSON.stringify({ confirmationToken: token })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل التطبيق");
      toast({ title: "تم بدء إعداد النطاق التلقائي" });
      setPreviewAgent(null);
      invalidate();
    } catch (e: any) {
      toast({ title: "فشل التطبيق", description: String(e.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  function handlePreviewConfirm() {
    if (!previewData?.confirmationToken || !previewConfirmed) return;

    if (pendingProvisionAgent) {
      setInstallDlg({ agentId: pendingProvisionAgent.id, variant: "full", encrypt: true, autoDomainToken: previewData.confirmationToken });
      setPreviewAgent(null);
      setPendingProvisionAgent(null);
    } else if (previewAgent) {
      applyAutoDomain(previewAgent.id, previewData.confirmationToken);
    }
  }

  function handleProvisionClick(a: Agent, isExternalReady: boolean) {
    if (a.packageSource === "external" && !isExternalReady) return;
    if (a.autoDomainSetup) {
      setPendingProvisionAgent(a);
      loadPreview(a);
    } else {
      setInstallDlg({ agentId: a.id, variant: "full", encrypt: true });
    }
  }

  async function provisionNow(a: Agent, opts: { variant: "full" | "no_db" | "upload" | "upload_no_db"; encryptBundle: boolean; autoDomainConfirmationToken?: string }) {
    setBusy(`provision-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/provision`, {
        method: "POST", headers, body: JSON.stringify(opts),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل");
      setInstallDlg(null);
      setOperationViewKind("provision");
      setProvisionAgentId(a.id);
      invalidate();
    } catch (e: any) {
      toast({ title: "التسطيب الكامل: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  function openCreate() {
    setForm({ ...emptyForm });
    setFormPackageFiles({ backend: null, frontend: null, db: null });
    setShowForm(true);
  }
  function openEdit(a: Agent) {
    setForm({
      id: a.id, name: a.name, contactPhone: a.contactPhone ?? "", contactEmail: a.contactEmail ?? "",
      domain: a.domain, extraDomainsText: (a.extraDomains ?? []).join("\n"),
      mode: a.mode, packageSource: a.packageSource ?? "central",
      localSuperadminEnabled: a.mode === "full" && a.localSuperadminEnabled !== false,
      localSuperadminScreens: Array.isArray(a.localSuperadminScreens)
        ? a.localSuperadminScreens
        : [...DEFAULT_LOCAL_SUPERADMIN_SCREENS],
      maxCompanies: a.maxCompanies != null ? String(a.maxCompanies) : "",
      licenseExpiresAt: a.licenseExpiresAt ? String(a.licenseExpiresAt).slice(0, 10) : "",
      dbUrl: "", sshHost: a.sshHost ?? "", sshPort: a.sshPort != null ? String(a.sshPort) : "22",
      sshUser: a.sshUser ?? "", sshSecret: "",
      brandName: a.brandName ?? "", brandLogoUrl: a.brandLogoUrl ?? "", brandColor: a.brandColor ?? "",
      notes: a.notes ?? "",
      saUsername: a.saUsername ?? "", saEmail: a.saEmail ?? "", saPassword: "",
      autoDomainSetup: a.autoDomainSetup ?? false,
      autoDomainProxyEnabled: a.autoDomainProxyEnabled ?? false,
    });
    setFormPackageFiles({ backend: null, frontend: null, db: null });
    setShowForm(true);
  }

  const agents = listQ.data ?? [];
  const events = eventsQ.data ?? [];
  const unresolvedCount = useMemo(() => events.filter(e => !e.resolved).length, [events]);

  const statusPill = (ok: boolean | null, okText: string, badText: string, naText = "لم يُفحص") =>
    ok == null
      ? <Badge variant="outline" className="bg-slate-50 text-slate-500">{naText}</Badge>
      : ok
        ? <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200"><CheckCircle2 className="h-3 w-3 ms-1" />{okText}</Badge>
        : <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200"><XCircle className="h-3 w-3 ms-1" />{badText}</Badge>;

  return (
    <div className="p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><Server className="h-5 w-5" />سيرفرات الوكلاء</h1>
          <p className="text-sm text-muted-foreground mt-1">
            نسخ الوكلاء على دوميناتهم وسيرفراتهم — قاعدة بيانات خارجية، ترخيص موقّع، هوية خاصة، وحماية من التلاعب.
            تدعم الواجهة المركزية والنسخة الكاملة الخارجية المشفّرة.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-add-agent"><Plus className="h-4 w-4 ms-1" />وكيل جديد</Button>
      </div>

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents"><Server className="h-3.5 w-3.5 ms-1" />الوكلاء ({agents.length})</TabsTrigger>
          <TabsTrigger value="platform-links" data-testid="tab-platform-links">
            <LinkIcon className="h-3.5 w-3.5 ms-1" />الربط الآمن
          </TabsTrigger>
          <TabsTrigger value="security" data-testid="tab-security-events">
            <ShieldAlert className="h-3.5 w-3.5 ms-1" />تنبيهات الأمان
            {unresolvedCount > 0 && <Badge variant="destructive" className="ms-1 h-5 px-1.5 text-[10px]">{unresolvedCount}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="platform-links" className="mt-4">
          <PlatformLinksTopLevel />
          <div className="mt-8 border-t pt-6">
            <div className="flex items-center gap-2 mb-4 text-muted-foreground">
              <Server className="h-5 w-5" />
              <h3 className="font-semibold text-foreground">الوكلاء المستوردون (التحكم الخارجي)</h3>
            </div>
            <ImportedAgentsList />
          </div>
        </TabsContent>

        {/* ── الوكلاء ── */}
        <TabsContent value="agents" className="mt-4 space-y-3">
          {listQ.isLoading ? <Skeleton className="h-40 w-full" /> : agents.length === 0 ? (
            <div className="border rounded-xl p-10 text-center text-muted-foreground">
              <Server className="h-10 w-10 mx-auto mb-3 opacity-30" />
              لا يوجد وكلاء بعد — أضف أول وكيل لتسجيل دومينه وسيرفره وقاعدة بياناته
            </div>
          ) : agents.map(a => (
            <div key={a.id} className={`border rounded-xl p-4 space-y-3 ${a.status === "suspended" ? "bg-rose-50/40 border-rose-200" : "bg-card"}`} data-testid={`card-agent-${a.id}`}>
              {/* Header row */}
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  {a.brandLogoUrl
                    ? <img src={a.brandLogoUrl} alt="" className="h-10 w-10 rounded-lg object-contain border bg-white" />
                    : <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center"><Server className="h-5 w-5 text-primary" /></div>}
                  <div>
                    <div className="font-semibold flex items-center gap-2">
                      {a.name}
                      {a.status === "active"
                        ? <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">نشط</Badge>
                        : <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200"><Ban className="h-3 w-3 ms-1" />موقوف</Badge>}
                      <Badge variant="outline" className="text-[10px]">
                        {a.mode === "full"
                          ? a.packageSource === "external" ? "نسخة كاملة خارجية" : "نسخة كاملة (إصدار مركزي)"
                          : a.mode === "frontend_only" ? "واجهة فقط + API مركزي" : "نسخة قشرة كاملة"}
                      </Badge>
                      {a.mode === "full" && (
                        <Badge variant="outline" className={`text-[10px] ${
                          a.localSuperadminEnabled
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-slate-50 text-slate-600 border-slate-200"
                        }`} data-testid={`badge-agent-local-sa-${a.id}`}>
                          {a.localSuperadminEnabled ? "مع لوحة Super Admin" : "بدون لوحة Super Admin"}
                        </Badge>
                      )}
                      {a.mode === "full" && a.localSuperadminEnabled && (
                        <span className="text-[10px] text-muted-foreground">
                          {a.localSuperadminScreens.length} شاشة محددة
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1" dir="ltr">
                      <Globe className="h-3 w-3" />{a.domain}
                      {(a.extraDomains?.length ?? 0) > 0 && <span className="opacity-60">+{a.extraDomains!.length}</span>}
                      <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 ms-2"
                        disabled={domainCheck?.loading && domainCheck.agent.id === a.id}
                        onClick={() => checkDomains(a)} data-testid={`button-check-domains-${a.id}`}>
                        {domainCheck?.loading && domainCheck.agent.id === a.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Plug className="h-3 w-3 ms-1" />}
                        فحص النطاقات
                      </Button>
                      <Button variant="outline" size="sm" className="h-6 text-[11px] px-2"
                        disabled={!a.sshHost || (banCheck?.loading && banCheck.agent.id === a.id)}
                        onClick={() => checkBan(a)} data-testid={`button-check-ban-${a.id}`}>
                        {banCheck?.loading && banCheck.agent.id === a.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Ban className="h-3 w-3 ms-1" />}
                        فحص الحظر
                      </Button>
                      <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 text-emerald-700"
                        disabled={!a.sshHost || !a.sshSecretSet || busy === `unban-${a.id}`}
                        onClick={() => unban(a)} data-testid={`button-unban-${a.id}`}>
                        {busy === `unban-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3 ms-1" />}
                        فك الحظر
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" disabled={a.deployStatus === "deploying"} onClick={() => openEdit(a)} data-testid={`button-edit-agent-${a.id}`}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-600" disabled={a.deployStatus === "deploying"} onClick={async () => {
                    if (!confirm(`حذف الوكيل «${a.name}» نهائيًا؟ ستُحذف كل تنبيهاته أيضًا.`)) return;
                    const r = await fetch(`${API}/api/admin/agent-instances/${a.id}`, { method: "DELETE", headers });
                    if (r.ok) { invalidate(); toast({ title: "تم الحذف" }); } else toast({ title: "فشل الحذف", variant: "destructive" });
                  }}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>

              {/* Status grid */}
              <div className="grid md:grid-cols-4 gap-3 text-sm">
                <div className="border rounded-lg p-3 space-y-1.5">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><Database className="h-3.5 w-3.5" />قاعدة البيانات الخارجية</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {a.dbStatus === "initialized" ? statusPill(true, "مهيأة + بصمة", "")
                      : a.dbStatus === "ok" ? statusPill(true, "متصلة", "")
                      : a.dbStatus === "error" ? statusPill(false, "", "خطأ")
                      : statusPill(null, "", "", a.dbUrlSet ? "لم تُفحص" : "غير مُدخلة")}
                  </div>
                  {a.dbLastError && <div className="text-[11px] text-rose-600 truncate" title={a.dbLastError}>{a.dbLastError}</div>}
                  <div className="text-[11px] text-muted-foreground">آخر فحص: {fmtDate(a.dbLastCheckAt)}</div>
                  <div className="flex gap-1 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.dbUrlSet || busy === `test-db-${a.id}`} onClick={() => action(a.id, "test-db", "فحص الاتصال")}>
                      {busy === `test-db-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3 ms-1" />}اختبار
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.dbUrlSet || busy === `init-db-${a.id}` || a.deployStatus === "deploying"} onClick={() => {
                      if (confirm("تهيئة قاعدة بيانات الوكيل وزرع بصمة التركيب؟")) action(a.id, "init-db", "التهيئة");
                    }}>
                      {busy === `init-db-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 ms-1" />}تهيئة + بصمة
                    </Button>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-1.5">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><Server className="h-3.5 w-3.5" />السيرفر (SSH)</div>
                  <div dir="ltr" className="text-xs">{a.sshHost ? `${a.sshUser ?? "?"}@${a.sshHost}:${a.sshPort ?? 22}` : "—"}</div>
                  {a.sshStatus === "ok" ? statusPill(true, "يمكن الوصول", "") : a.sshStatus === "error" ? statusPill(false, "", "غير متاح") : statusPill(null, "", "")}
                  <div className="text-[11px]">
                    النشر: {a.deployStatus === "ok" ? <Badge className="text-[10px] h-4 px-1 bg-emerald-600">ناجح</Badge>
                      : a.deployStatus === "error" ? <Badge variant="destructive" className="text-[10px] h-4 px-1">فشل</Badge>
                      : a.deployStatus === "deploying" ? <Badge variant={isOperationStale(a) ? "destructive" : "secondary"} className="text-[10px] h-4 px-1">{isOperationStale(a) ? "معلّقة" : "جارٍ…"}</Badge>
                      : <span className="text-muted-foreground">لم يُنشر</span>}
                    {a.lastDeployAt && <span className="text-muted-foreground ms-1">{fmtDate(a.lastDeployAt)}</span>}
                  </div>
                  {a.autoDomainSetup && (
                    <div className="text-[11px] space-y-1 pt-1 border-t border-border mt-1">
                      <div className="flex items-center flex-wrap gap-2">
                        <span className="font-semibold text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" /> النطاق التلقائي:</span>
                        <div className="flex items-center gap-1" data-testid={`status-auto-domain-${a.id}`}>
                          {a.autoDomainStatus === 'disabled' && <Badge variant="outline" className="text-[10px] h-4 px-1">معطل</Badge>}
                          {a.autoDomainStatus === 'pending' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-blue-50 text-blue-700 border-blue-200">قيد الانتظار</Badge>}
                          {a.autoDomainStatus === 'checking' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-yellow-50 text-yellow-700 border-yellow-200"><Loader2 className="h-2.5 w-2.5 animate-spin ms-1 inline" /> فحص</Badge>}
                          {a.autoDomainStatus === 'configuring' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-blue-50 text-blue-700 border-blue-200"><Loader2 className="h-2.5 w-2.5 animate-spin ms-1 inline" /> إعداد</Badge>}
                          {a.autoDomainStatus === 'waiting_dns' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-orange-50 text-orange-700 border-orange-200"><Loader2 className="h-2.5 w-2.5 animate-spin ms-1 inline" /> انتظار DNS</Badge>}
                          {a.autoDomainStatus === 'verifying' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-purple-50 text-purple-700 border-purple-200"><Loader2 className="h-2.5 w-2.5 animate-spin ms-1 inline" /> تحقق</Badge>}
                          {a.autoDomainStatus === 'ready' && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-green-50 text-green-700 border-green-200"><CheckCircle2 className="h-2.5 w-2.5 ms-1 inline" /> جاهز</Badge>}
                          {a.autoDomainStatus === 'error' && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 bg-red-50 hover:bg-red-100 text-red-700 border-red-200 cursor-pointer transition-colors" onClick={() => loadPreview(a)} data-testid={`button-retry-domain-${a.id}`}>
                              <XCircle className="h-2.5 w-2.5 ms-1 inline" /> خطأ (إعادة المحاولة)
                            </Badge>
                          )}
                        </div>
                        <span className={a.cloudflareConnected ? "text-emerald-700" : "text-rose-600"}>
                          Cloudflare: {a.cloudflareConnected ? "متصل" : "غير مهيأ"}
                        </span>
                      </div>
                      {(a.autoDomainZoneName || a.autoDomainOriginIp) && (
                        <div className="text-muted-foreground truncate" dir="ltr">
                          {a.autoDomainZoneName ?? "—"} · {a.autoDomainOriginIp ?? "—"}
                        </div>
                      )}
                      {a.autoDomainLastError && (
                        <div className="text-rose-600 line-clamp-2" title={a.autoDomainLastError} data-testid={`error-auto-domain-${a.id}`}>
                          {a.autoDomainLastError}
                        </div>
                      )}
                      {a.autoDomainLog && (
                        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setLogView({ title: `سجل الدومين — ${a.name}`, text: a.autoDomainLog! })}>
                          عرض سجل الدومين
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.sshHost || busy === `test-ssh-${a.id}`} onClick={() => action(a.id, "test-ssh", "فحص السيرفر")}>
                      {busy === `test-ssh-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3 ms-1" />}اختبار الوصول
                    </Button>
                    <Button size="sm" className="h-7 text-xs" disabled={!a.sshHost || !a.sshSecretSet || busy === `provision-${a.id}` || a.deployStatus === "deploying" || isAutoDomainBusy(a)} onClick={() => handleProvisionClick(a, true)} data-testid={`button-provision-${a.id}`}>
                      {busy === `provision-${a.id}` || a.deployStatus === "deploying" ? <Loader2 className="h-3 w-3 animate-spin ms-1" /> : <UploadCloud className="h-3 w-3 ms-1" />}تسطيب كامل
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.sshHost || !a.sshSecretSet || !a.licenseKey || busy === `deploy-${a.id}` || a.deployStatus === "deploying" || isAutoDomainBusy(a)} onClick={() => deployNow(a)} data-testid={`button-deploy-${a.id}`}>
                      {busy === `deploy-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3 ms-1" />}نشر
                    </Button>
                    {a.mode === "full" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                        disabled={!a.dbUrlSet || !a.sshHost || !a.sshSecretSet || busy === `schema-upgrade-${a.id}` || a.deployStatus === "deploying" || isAutoDomainBusy(a)}
                        onClick={() => setSchemaUpgradeAgent(a)}
                        data-testid={`button-schema-upgrade-${a.id}`}
                      >
                        {busy === `schema-upgrade-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin ms-1" /> : <Database className="h-3 w-3 ms-1" />}
                        ترقية قاعدة البيانات
                      </Button>
                    )}
                    {a.autoDomainSetup && a.deployStatus === "ok" && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy != null || isAutoDomainBusy(a)} onClick={() => loadPreview(a)} data-testid={`button-preview-domain-${a.id}`}>
                        <Globe className="h-3 w-3 ms-1" />إعداد النطاق
                      </Button>
                    )}
                    {isOperationStale(a) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs border-amber-400 text-amber-800"
                        disabled={busy === `recover-${a.id}`}
                        onClick={() => recoverOperation(a)}
                        data-testid={`button-recover-operation-${a.id}`}
                      >
                        {busy === `recover-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin ms-1" /> : <RefreshCw className="h-3 w-3 ms-1" />}
                        استعادة العملية
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.licenseKey || busy === `kit-${a.id}`} onClick={() => openSetupKit(a)} data-testid={`button-kit-${a.id}`}>
                      {busy === `kit-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3 ms-1" />}حزمة التهيئة
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.licenseKey} onClick={() => setEmailPkg({ agent: a, email: a.contactEmail ?? "" })} data-testid={`button-email-pkg-${a.id}`}>
                      <Mail className="h-3 w-3 ms-1" />إرسال بالإيميل
                    </Button>
                    {a.deployLog && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLogView({ title: `سجل النشر — ${a.name}`, text: a.deployLog! })}>السجل</Button>
                    )}
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-1.5">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />الترخيص</div>
                  {a.licenseKey ? (
                    <div className="flex items-center gap-1">
                      <code className="text-[11px] bg-muted rounded px-1.5 py-0.5" dir="ltr">{a.licenseKey}</code>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { navigator.clipboard.writeText(a.licenseKey!); toast({ title: "نُسخ المفتاح" }); }}><Copy className="h-3 w-3" /></Button>
                    </div>
                  ) : <span className="text-xs">—</span>}
                  <div className="text-[11px] text-muted-foreground">
                    ينتهي: {a.licenseExpiresAt ? String(a.licenseExpiresAt).slice(0, 10) : "غير محدد"}
                    {a.licenseExpiresAt && new Date(a.licenseExpiresAt) < new Date() && <Badge variant="destructive" className="ms-1 text-[10px] h-4 px-1">منتهي</Badge>}
                  </div>
                  <div className="flex gap-1 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy === `license-${a.id}` || a.deployStatus === "deploying"} onClick={() => {
                      if (confirm("إصدار مفتاح ترخيص جديد؟ المفتاح القديم سيتوقف عن العمل.")) action(a.id, "license", "إصدار الترخيص");
                    }}><KeyRound className="h-3 w-3 ms-1" />إصدار مفتاح</Button>
                    {a.status === "active"
                      ? <Button variant="outline" size="sm" className="h-7 text-xs text-rose-600" disabled={busy === `suspend-${a.id}`} onClick={() => {
                          if (confirm(`تعطيل «${a.name}» فورًا؟ ستتوقف نسخته عن العمل.`)) action(a.id, "suspend", "التعطيل");
                        }}><Ban className="h-3 w-3 ms-1" />تعطيل</Button>
                      : <Button variant="outline" size="sm" className="h-7 text-xs text-emerald-700" disabled={busy === `activate-${a.id}`} onClick={() => action(a.id, "activate", "التفعيل")}>
                          <Play className="h-3 w-3 ms-1" />تفعيل</Button>}
                    <Button variant="destructive" size="sm" className="h-7 text-xs"
                      disabled={busy === `wipe-${a.id}` || a.deployStatus === "deploying"}
                      onClick={() => setWipeAgent(a)} data-testid={`button-wipe-${a.id}`}>
                      {busy === `wipe-${a.id}` ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <Trash2 className="h-3 w-3 ms-1" />}حذف التسطيب
                    </Button>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-1.5">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><HeartPulse className="h-3.5 w-3.5" />الحالة الحية</div>
                  <div className="text-[11px]">آخر نبض: {fmtDate(a.lastHeartbeatAt)}</div>
                  <div className="text-[11px] text-muted-foreground" dir="ltr">{a.lastSeenIp ?? ""}</div>
                  {a.deployedVersion && <div className="text-[11px]" dir="ltr">v{a.deployedVersion}</div>}
                  {a.brandName && <div className="text-[11px] flex items-center gap-1"><Palette className="h-3 w-3" />{a.brandName}</div>}
                  <div className="text-[11px] text-muted-foreground" dir="ltr">ID: {a.installationId.slice(0, 8)}…</div>
                </div>
              </div>

              <AgentAccelerationCard agent={a} invalidate={invalidate} />
              <LocalAgentLinks agentId={a.id} />

              {a.mode === "full" && a.packageSource === "external" && (
                <div className="border rounded-lg p-3 bg-slate-50/70 dark:bg-slate-950/20 space-y-2" data-testid={`external-package-${a.id}`}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-xs font-semibold flex items-center gap-1.5"><LockKeyhole className="h-3.5 w-3.5" />حزمة النسخة الكاملة الخارجية</div>
                      <div className="text-[11px] text-muted-foreground">تُخزّن مشفّرة في التخزين الخاص؛ التنزيل والتسطيب يتحققان من البصمة والتوقيع.</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ZatcaTransferAction agentId={a.id} agentName={a.name} agentDomain={a.domain} onComplete={invalidate} />
                      <AgentHandoffAction agentId={a.id} agentName={a.name} agentDomain={a.domain} onComplete={invalidate} />
                      <Button variant="outline" size="sm" className="h-7 text-xs"
                        disabled={!a.dbUrlSet || pkgBusy === "prepare" || a.deployStatus === "deploying"}
                        onClick={() => prepareExternalPackage(a)} data-testid={`button-prepare-external-${a.id}`}>
                        {pkgBusy === "prepare" ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <RefreshCw className="h-3 w-3 ms-1" />}
                        تجهيز إصدار جديد
                      </Button>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-3 gap-2">
                    {(["backend", "frontend", "db"] as PackageKind[]).map(kind => {
                      const info = a.externalPackage?.[kind] ?? null;
                      return (
                        <div key={kind} className="border rounded-md bg-card p-2 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium">{packageLabel(kind)}</span>
                            {info
                              ? <Badge variant="outline" className="h-5 px-1.5 text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200">مشفّر ✓</Badge>
                              : <Badge variant="destructive" className="h-5 px-1.5 text-[9px]">ناقص</Badge>}
                          </div>
                          {info ? (
                            <>
                              <div className="mt-1 text-[10px] text-muted-foreground truncate" dir="ltr" title={info.filename}>{info.filename}</div>
                              <div className="text-[10px] font-mono text-muted-foreground" dir="ltr">SHA {info.sha256.slice(0, 12)}…</div>
                              <Button variant="ghost" size="sm" className="h-6 mt-1 px-1.5 text-[10px]"
                                disabled={pkgBusy === `download-${kind}`}
                                onClick={() => downloadPkg(a.id, kind)}>
                                {pkgBusy === `download-${kind}` ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <FileDown className="h-3 w-3 ms-1" />}
                                تنزيل
                              </Button>
                            </>
                          ) : <div className="mt-1 text-[10px] text-rose-600">لا يمكن بدء التسطيب قبل اكتمال الملفات الثلاثة.</div>}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    الإصدارات المركزية اللاحقة تظهر داخل النسخة المثبتة، ولا تُثبّت إلا بعد موافقة السوبر أدمن المحلي؛ لا توجد إعادة تشغيل تلقائية.
                  </div>
                </div>
              )}
            </div>
          ))}
        </TabsContent>

        {/* ── تنبيهات الأمان ── */}
        <TabsContent value="security" className="mt-4">
          {eventsQ.isLoading ? <Skeleton className="h-40 w-full" /> : events.length === 0 ? (
            <div className="border rounded-xl p-10 text-center text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-400" />
              لا توجد تنبيهات — لم تُرصد أي محاولات تلاعب
            </div>
          ) : (
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-start p-2.5 font-medium">الوقت</th>
                    <th className="text-start p-2.5 font-medium">الوكيل</th>
                    <th className="text-start p-2.5 font-medium">الحدث</th>
                    <th className="text-start p-2.5 font-medium">الدومين / IP</th>
                    <th className="text-center p-2.5 font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id} className={`border-t ${!e.resolved ? "bg-amber-50/40" : ""}`}>
                      <td className="p-2.5 whitespace-nowrap text-xs">{fmtDate(e.createdAt)}</td>
                      <td className="p-2.5">{e.agentName ?? <span className="text-muted-foreground">غير معروف</span>}</td>
                      <td className="p-2.5">
                        <div className="flex items-center gap-1.5">
                          <AlertTriangle className={`h-3.5 w-3.5 ${e.resolved ? "text-slate-400" : "text-amber-500"}`} />
                          <span className="text-xs">{EVENT_LABEL[e.eventType] ?? e.eventType}</span>
                        </div>
                      </td>
                      <td className="p-2.5 text-xs" dir="ltr">{[e.host, e.ip].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="p-2.5 text-center">
                        {e.resolved ? <Badge variant="outline" className="text-[10px]">تمت المعالجة</Badge> : (
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={async () => {
                            await fetch(`${API}/api/admin/agent-instances/security-events/${e.id}/resolve`, { method: "POST", headers });
                            invalidate();
                          }}>وضع علامة معالج</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── سجل النشر ── */}
      <Dialog open={!!logView} onOpenChange={(o) => !o && setLogView(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{logView?.title}</DialogTitle></DialogHeader>
          <pre dir="ltr" className="text-[11px] bg-muted rounded-lg p-3 whitespace-pre-wrap break-all max-h-[60vh] overflow-y-auto">{logView?.text || "—"}</pre>
        </DialogContent>
      </Dialog>

      {/* ── تأكيد ترقية قاعدة الوكيل الحالية ── */}
      <Dialog open={!!schemaUpgradeAgent} onOpenChange={(o) => !o && setSchemaUpgradeAgent(null)}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-emerald-700" />
              ترقية قاعدة البيانات — {schemaUpgradeAgent?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              ستتم ترقية قاعدة الوكيل الحالية على <b dir="ltr">{schemaUpgradeAgent?.domain}</b> في مكانها.
            </div>
            <ul className="list-disc pr-5 text-xs text-muted-foreground space-y-1">
              <li>تُنشأ نسخة أمان كاملة على سيرفر الوكيل قبل أي تعديل.</li>
              <li>تُضاف عناصر المخطط الناقصة فقط؛ لا تُستعاد قاعدة التطوير.</li>
              <li>لا تُحذف بيانات العملاء أو الفواتير أو المرفقات.</li>
              <li>لن تظهر العملية ناجحة إلا بعد فحص الأعمدة الحرجة وإصدار التطبيق.</li>
            </ul>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSchemaUpgradeAgent(null)}>إلغاء</Button>
            <Button
              className="bg-emerald-700 hover:bg-emerald-800"
              onClick={() => schemaUpgradeAgent && upgradeAgentDatabase(schemaUpgradeAgent)}
              data-testid="button-schema-upgrade-confirm"
            >
              <Database className="h-4 w-4 ms-1" />
              إنشاء نسخة أمان ثم الترقية
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── تأكيد الحذف الكامل من سيرفر الوكيل ── */}
      <Dialog open={!!wipeAgent} onOpenChange={(o) => !o && setWipeAgent(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" />هل تريد حذف كامل البيانات؟
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>سيتم حذف <b>كل ما تم تسطيبه</b> على سيرفر «{wipeAgent?.name}» نهائيًا:</p>
            <ul className="list-disc pr-5 text-xs text-muted-foreground space-y-1">
              <li>التطبيق الكامل وخدمته (zacod-app) وكل الملفات في /opt/zacod</li>
              <li>الوكيل العكسي (Caddy) وإعداداته</li>
              <li>نبض الترخيص والمحدّث التلقائي (cron)</li>
              <li>قاعدة البيانات والدور اللذان أنشأهما التسطيب</li>
            </ul>
            <p className="text-xs font-semibold text-destructive">
              يُلغى الترخيص فورًا — وحتى لو غيّر الوكيل بيانات الدخول للسيرفر وتعذّر الاتصال، ستتوقف نسخته تلقائيًا مع أول نبض قادم (حماية للملكية الفكرية).
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setWipeAgent(null)} data-testid="button-wipe-cancel">إلغاء</Button>
            <Button variant="destructive" onClick={() => wipeAgent && wipeNow(wipeAgent)} data-testid="button-wipe-confirm">
              <Trash2 className="h-4 w-4 ms-1" />موافق — احذف الكل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── التسطيب الكامل — سجل حي ── */}
      <Dialog open={!!provisionAgent} onOpenChange={(o) => !o && setProvisionAgentId(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {provisionAgent?.deployStatus === "deploying" && <Loader2 className="h-4 w-4 animate-spin" />}
              {operationIsSchema ? "ترقية قاعدة البيانات" : "التسطيب الكامل"} — {provisionAgent?.name}
              {provisionAgent?.deployStatus === "ok" && <Badge className="bg-emerald-600">اكتمل ✔</Badge>}
              {provisionAgent?.deployStatus === "error" && <Badge variant="destructive">فشل</Badge>}
            </DialogTitle>
          </DialogHeader>
          {(() => {
            const logText = provisionAgent?.deployLog || "";
            const status = provisionAgent?.deployStatus;
            // العناوين الافتراضية للخطوات الست (تُستبدل بما يصل فعليًا من السجل)
            const defaults = operationIsSchema
              ? ["إنشاء نسخة الأمان", "تطبيق ترقية المخطط", "فحص الأعمدة والإصدار"]
              : [
                  "فحص السيرفر",
                  "قاعدة البيانات PostgreSQL",
                  "بوابة الدخول والنبض (Caddy)",
                  "تهيئة قاعدة البيانات (السكيما + البصمة)",
                  "تثبيت التطبيق",
                  "الفحص النهائي",
                ];
            // اجمع علامات الخطوات "■ n/6 عنوان" من السجل
            const markers = Array.from(logText.matchAll(/■\s*(\d+)\/(\d+)\s*([^\n]*)/g));
            const total = markers.length ? Math.max(...markers.map(m => Number(m[2]))) : defaults.length;
            const titles: string[] = Array.from({ length: total }, (_, i) => defaults[i] ?? `الخطوة ${i + 1}`);
            for (const m of markers) titles[Number(m[1]) - 1] = m[3].replace(/^\d+\/\d+\s*/, "").trim() || titles[Number(m[1]) - 1];
            const lastIdx = markers.length ? Math.max(...markers.map(m => Number(m[1]))) - 1 : -1;
            const stateOf = (i: number): "done" | "active" | "error" | "pending" => {
              if (i < lastIdx) return "done";
              if (i === lastIdx) {
                if (status === "deploying") return "active";
                if (status === "error") return "error";
                return "done";
              }
              return status === "ok" ? "done" : "pending";
            };
            const pct = status === "ok" ? 100
              : lastIdx < 0 ? 4
              : Math.round(((lastIdx + (status === "deploying" ? 0.5 : 1)) / total) * 100);
            return (
              <div className="space-y-4">
                {/* شريط التقدم */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{status === "ok"
                      ? operationIsSchema ? "اكتملت ترقية القاعدة بنجاح" : "اكتمل التسطيب بنجاح"
                      : status === "error"
                        ? operationIsSchema ? "توقفت ترقية القاعدة عند خطأ" : "توقف التسطيب عند خطأ"
                        : operationIsSchema ? "جارٍ ترقية قاعدة بيانات الوكيل…" : "جارٍ التسطيب على سيرفر الوكيل…"}</span>
                    <span className="tabular-nums font-semibold">{pct}%</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${status === "error" ? "bg-red-500" : status === "ok" ? "bg-emerald-500" : "bg-gradient-to-l from-sky-400 via-blue-500 to-indigo-500 animate-pulse"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                {/* الخطوات */}
                <div className="space-y-0.5">
                  {titles.map((t, i) => {
                    const st = stateOf(i);
                    return (
                      <div key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${st === "active" ? "bg-blue-50 dark:bg-blue-950/40" : st === "error" ? "bg-red-50 dark:bg-red-950/40" : ""}`} data-testid={`provision-step-${i + 1}`}>
                        <div className={`h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold
                          ${st === "done" ? "bg-emerald-500 text-white" : st === "active" ? "bg-blue-500 text-white" : st === "error" ? "bg-red-500 text-white" : "bg-muted text-muted-foreground"}`}>
                          {st === "done" ? <Check className="h-3.5 w-3.5" /> : st === "active" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : st === "error" ? "!" : i + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-sm ${st === "active" ? "font-semibold text-blue-700 dark:text-blue-300" : st === "error" ? "font-semibold text-red-700 dark:text-red-300" : st === "done" ? "text-foreground" : "text-muted-foreground"}`}>{t}</div>
                          {st === "active" && <div className="text-[11px] text-muted-foreground">جارٍ التنفيذ الآن…</div>}
                        </div>
                        {st === "done" && <span className="text-[11px] text-emerald-600 shrink-0">تم ✔</span>}
                      </div>
                    );
                  })}
                </div>
                {/* آخر سطر من السجل أثناء التنفيذ */}
                {status === "deploying" && (() => {
                  const lines = logText.split("\n").map(s => s.trim()).filter(Boolean);
                  const last = lines[lines.length - 1];
                  return last ? <div className="text-[11px] text-muted-foreground bg-muted rounded-md px-3 py-1.5 truncate" dir="rtl">{last}</div> : null;
                })()}
                {/* السجل الكامل قابل للطي */}
                <details className="group" open={status === "error"}>
                  <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">عرض السجل الكامل</summary>
                  <pre dir="rtl" className="mt-2 text-[11px] bg-muted rounded-lg p-3 whitespace-pre-wrap break-all max-h-[38vh] overflow-y-auto">{logText || "جارٍ البدء…"}</pre>
                </details>
                {status === "deploying" && (
                  <p className="text-xs text-muted-foreground">قد تستغرق العملية عدة دقائق (تثبيت PostgreSQL/Node لأول مرة). يمكنك إغلاق النافذة والعودة لاحقًا — السجل محفوظ.</p>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── حزمة التهيئة ── */}
      <Dialog open={!!kitView} onOpenChange={(o) => !o && setKitView(null)}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader><DialogTitle>حزمة التهيئة — {kitView?.agent}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            للتركيب اليدوي: نزّل سكربت التثبيت وشغّله كـ root على سيرفر الوكيل — يثبّت الوكيل العكسي (Caddy)، يربط الدومين بالمنصة، ويفعّل نبض الترخيص كل 5 دقائق. زر «نشر» ينفّذ نفس السكربت تلقائيًا عبر SSH.
          </p>
          {kitView && (
            <div className="space-y-3">
              {[
                { name: "install.sh", label: "سكربت التثبيت (شغّله كـ root)", text: kitView.kit.installScript },
                { name: "config.json", label: "ملف الإعدادات", text: JSON.stringify(kitView.kit.config, null, 2) },
                { name: "Caddyfile", label: "إعداد الوكيل العكسي", text: kitView.kit.caddyfile },
              ].map((f) => (
                <div key={f.name} className="border rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold">{f.label} <code className="text-[10px] text-muted-foreground" dir="ltr">{f.name}</code></div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => { navigator.clipboard.writeText(f.text); toast({ title: "نُسخ" }); }}><Copy className="h-3 w-3 ms-1" />نسخ</Button>
                      <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => {
                        const url = URL.createObjectURL(new Blob([f.text], { type: "text/plain" }));
                        const el = document.createElement("a"); el.href = url; el.download = f.name; el.click(); URL.revokeObjectURL(url);
                      }}><FileDown className="h-3 w-3 ms-1" />تنزيل</Button>
                    </div>
                  </div>
                  <pre dir="ltr" className="text-[10px] bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{f.text}</pre>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── فحص النطاقات ── */}
      <Dialog open={!!domainCheck} onOpenChange={(o) => !o && setDomainCheck(null)}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader><DialogTitle>فحص النطاقات — {domainCheck?.agent.name}</DialogTitle></DialogHeader>
          {domainCheck?.loading ? (
            <div className="py-10 text-center text-muted-foreground">
              <Loader2 className="h-8 w-8 mx-auto mb-3 animate-spin" />
              جارٍ فحص النطاقات (DNS + HTTPS)…
            </div>
          ) : domainCheck?.data ? (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground" dir="rtl">
                سيرفر الوكيل: <span dir="ltr">{domainCheck.data.serverHost ?? "غير مُدخل"}</span>
                {domainCheck.data.serverIps.length > 0 && <span dir="ltr" className="ms-1">({domainCheck.data.serverIps.join(", ")})</span>}
              </div>
              {domainCheck.data.results.map((r) => (
                <div key={r.domain} className="border rounded-lg p-3 space-y-2" data-testid={`domain-check-${r.domain}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="font-medium text-sm flex items-center gap-1.5" dir="ltr"><Globe className="h-3.5 w-3.5" />{r.domain}</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {r.live
                        ? <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="h-3 w-3 ms-1" />مفعل</Badge>
                        : <Badge variant="destructive"><XCircle className="h-3 w-3 ms-1" />غير مفعل</Badge>}
                      {r.onServer === true && <Badge className="bg-emerald-600 text-white">على سيرفر الوكيل</Badge>}
                      {r.onServer === false && <Badge variant="destructive">خارج سيرفر الوكيل</Badge>}
                      {r.onServer === null && <Badge variant="secondary">السيرفر غير محدد</Badge>}
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap" dir="ltr">
                    {r.ips.length > 0 && <span>IP: {r.ips.join(", ")}</span>}
                    {r.latencyMs != null && r.live && (
                      <span className={r.latencyMs < 500 ? "text-emerald-600" : r.latencyMs < 2000 ? "text-amber-600" : "text-rose-600"}>
                        ⏱ {r.latencyMs} ms
                      </span>
                    )}
                    {r.httpStatus != null && <span>HTTP {r.httpStatus}</span>}
                  </div>
                  {r.error && <div className="text-[11px] text-rose-600">{r.error}</div>}
                  {!r.dnsOk && !r.error && <div className="text-[11px] text-rose-600">النطاق غير مسجّل في DNS</div>}
                </div>
              ))}
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">آخر فحص: {fmtDate(domainCheck.data.checkedAt)}</div>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => checkDomains(domainCheck.agent)}>
                  <RefreshCw className="h-3 w-3 ms-1" />إعادة الفحص
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewAgent} onOpenChange={(o) => { if (!o) { setPreviewAgent(null); setPendingProvisionAgent(null); setPreviewConfirmed(false); } }}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>تأكيد إعداد النطاق التلقائي</DialogTitle>
          </DialogHeader>
          {previewLoading ? (
            <div className="p-8 flex flex-col items-center justify-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-muted-foreground font-semibold">جاري فحص حالة النطاق والخادم...</span>
            </div>
          ) : previewError ? (
            <div className="space-y-4">
              <div className="p-4 bg-destructive/10 text-destructive border border-destructive/20 rounded-md space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <AlertTriangle className="h-5 w-5" />
                  <span>تعذّرت المعاينة الآمنة</span>
                </div>
                <p className="text-sm">{previewError}</p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setPreviewAgent(null); setPendingProvisionAgent(null); }}>إغلاق</Button>
                <Button onClick={() => previewAgent && loadPreview(previewAgent)} data-testid="button-retry-domain-preview">
                  <RefreshCw className="h-4 w-4 ms-1" />إعادة الفحص
                </Button>
              </DialogFooter>
            </div>
          ) : previewData ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-border rounded-md p-4 space-y-3 bg-card shadow-sm">
                  <div className="flex items-center gap-2 text-primary font-bold border-b border-border pb-2">
                    <Globe className="h-4 w-4" />
                    <span>إجراء Cloudflare</span>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">نوع الإجراء:</span>
                      <span className="font-mono">
                        {previewData.cloudflare.action === 'create' && <Badge className="bg-green-600 border-green-600 text-white">إنشاء سجل جديد</Badge>}
                        {previewData.cloudflare.action === 'update' && <Badge className="bg-blue-600 border-blue-600 text-white">تحديث سجل موجود</Badge>}
                        {previewData.cloudflare.action === 'noop' && <Badge variant="outline">لا تغيير مطلوب</Badge>}
                        {previewData.cloudflare.action === 'conflict' && <Badge variant="destructive">يوجد تعارض</Badge>}
                      </span>
                    </div>

                    {previewData.cloudflare.zoneName && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">المنطقة (Zone):</span>
                        <span className="font-semibold" dir="ltr">{previewData.cloudflare.zoneName}</span>
                      </div>
                    )}

                    <div className="flex justify-between items-center gap-3">
                      <span className="text-muted-foreground">السجل الرئيسي:</span>
                      <span className="font-semibold truncate" dir="ltr">{previewAgent?.domain}</span>
                    </div>

                    {previewData.cloudflare.existingContent && (
                      <div className="flex justify-between items-center gap-3">
                        <span className="text-muted-foreground">القيمة الحالية:</span>
                        <span className="font-mono text-xs truncate" dir="ltr">
                          {previewData.cloudflare.existingType ?? "A"} · {previewData.cloudflare.existingContent}
                          {previewData.cloudflare.existingProxied ? " · Proxy" : ""}
                        </span>
                      </div>
                    )}

                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">الوجهة (Content):</span>
                      <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border border-border" dir="ltr">{previewData.cloudflare.desiredContent}</span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">حالة البروكسي:</span>
                      <span>{previewData.cloudflare.desiredProxied ? <Badge variant="outline" className="border-orange-500 text-orange-600 bg-orange-50">مفعل (برتقالي)</Badge> : <Badge variant="outline" className="text-muted-foreground">معطل (رمادي)</Badge>}</span>
                    </div>

                    {previewData.cloudflare.conflict && (
                      <div className="mt-2 p-2 bg-destructive/10 text-destructive text-xs rounded border border-destructive/20">
                        <span className="font-bold">تعارض: </span> {previewData.cloudflare.conflict}
                      </div>
                    )}
                  </div>
                </div>

                <div className="border border-border rounded-md p-4 space-y-3 bg-card shadow-sm">
                   <div className="flex items-center gap-2 text-primary font-bold border-b border-border pb-2">
                     <Server className="h-4 w-4" />
                     <span>حالة الخادم الوجهة</span>
                   </div>
                   <div className="space-y-2 text-sm">
                     <div className="flex justify-between items-center">
                       <span className="text-muted-foreground">عنوان IP:</span>
                       <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border border-border" dir="ltr">{previewData.server.originIp}</span>
                     </div>

                     <div className="flex justify-between items-center gap-3">
                       <span className="text-muted-foreground">الخدمات النشطة:</span>
                       <span className="text-xs text-end">
                         {previewData.server.activeServices.length
                           ? previewData.server.activeServices.join("، ")
                           : "لا توجد خدمة ويب متعارضة"}
                       </span>
                     </div>

                     <div className="flex justify-between items-center">
                       <span className="text-muted-foreground">اتصال SSH:</span>
                       {previewData.server.sshAuthenticated ? (
                         <span className="text-green-600 flex items-center gap-1 font-semibold"><CheckCircle2 className="h-3 w-3"/> ناجح</span>
                       ) : (
                         <span className="text-destructive flex items-center gap-1 font-semibold"><XCircle className="h-3 w-3"/> فشل</span>
                       )}
                     </div>

                     <div className="flex justify-between items-center">
                       <span className="text-muted-foreground">جدار الحماية:</span>
                       <span className="font-mono font-semibold">{previewData.server.firewall.toUpperCase()}</span>
                     </div>

                     <div className="pt-1">
                       <span className="text-muted-foreground text-xs block mb-1">منافذ الويب:</span>
                       <div className="flex flex-wrap gap-1" dir="ltr">
                         {previewData.server.ports.map(p => (
                           <Badge key={p.port} variant={p.state === 'open' ? 'outline' : 'destructive'} className={p.state === 'open' ? 'border-green-600 text-green-600 bg-green-50' : ''}>
                             {p.port} ({p.state})
                           </Badge>
                         ))}
                       </div>
                     </div>
                   </div>
                </div>
              </div>

              {previewData.warnings && previewData.warnings.length > 0 && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-md p-3 space-y-1">
                  <div className="text-sm font-bold text-yellow-800 dark:text-yellow-400 flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4" /> تحذيرات
                  </div>
                  <ul className="list-disc list-inside text-xs text-yellow-700 dark:text-yellow-500 pr-4">
                    {previewData.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {previewData.server.conflicts.length > 0 && (
                <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800 rounded-md p-3">
                  <div className="text-sm font-bold text-rose-800 dark:text-rose-300 flex items-center gap-1">
                    <XCircle className="h-4 w-4" />تعارض يمنع التنفيذ
                  </div>
                  <ul className="list-disc list-inside text-xs text-rose-700 dark:text-rose-400 mt-1">
                    {previewData.server.conflicts.map((conflict, i) => <li key={i}>{conflict}</li>)}
                  </ul>
                </div>
              )}

              {!!previewData.confirmationToken && (
                <label className="flex items-start gap-2 rounded-md border border-primary/25 bg-primary/5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-0.5 accent-primary"
                    checked={previewConfirmed}
                    onChange={e => setPreviewConfirmed(e.target.checked)}
                    data-testid="checkbox-confirm-auto-domain-plan"
                  />
                  <span className="text-xs leading-relaxed">
                    أؤكد تنفيذ الخطة المعروضة على <b>الدومين الرئيسي فقط</b>. لن تُحذف سجلات DNS أخرى،
                    ولن تُوقف خدمات Nginx أو Apache القائمة تلقائيًا.
                  </span>
                </label>
              )}

              <DialogFooter className="gap-2 sm:gap-0 mt-4 border-t border-border pt-4">
                <Button variant="outline" onClick={() => { setPreviewAgent(null); setPendingProvisionAgent(null); }} data-testid="button-cancel-preview">
                  إلغاء
                </Button>
                <Button
                  className="bg-primary hover:bg-primary/90 text-white"
                  disabled={
                    !previewConfirmed
                    || !previewData.confirmationToken
                    || previewData.cloudflare.action === "conflict"
                    || previewData.server.conflicts.length > 0
                    || (pendingProvisionAgent ? !previewData.canUseWithProvision : !previewData.canApplyNow)
                    || busy != null
                  }
                  onClick={handlePreviewConfirm}
                  data-testid="button-confirm-preview"
                >
                   {busy != null ? <Loader2 className="h-4 w-4 animate-spin" /> :
                     (!previewData.confirmationToken || previewData.cloudflare.action === 'conflict'
                       ? "لا يمكن التطبيق لوجود تعارض"
                       : pendingProvisionAgent
                         ? "تأكيد ومتابعة التسطيب"
                         : "تأكيد وتطبيق الآن")}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── فحص الحظر ── */}
      <Dialog open={!!banCheck} onOpenChange={(o) => !o && setBanCheck(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>فحص الحظر — {banCheck?.agent.name}</DialogTitle></DialogHeader>
          {banCheck?.loading ? (
            <div className="py-10 text-center text-muted-foreground">
              <Loader2 className="h-8 w-8 mx-auto mb-3 animate-spin" />
              جارٍ فحص منافذ السيرفر (SSH + الويب)…
            </div>
          ) : banCheck?.data ? (
            <div className="space-y-3" data-testid="ban-check-result">
              <div className={`border rounded-lg p-3 ${banCheck.data.verdict === "no_ban" ? "bg-emerald-50 border-emerald-200" : banCheck.data.verdict === "likely_ban" ? "bg-amber-50 border-amber-300" : "bg-rose-50 border-rose-200"}`}>
                <div className="font-medium text-sm flex items-center gap-1.5">
                  {banCheck.data.verdict === "no_ban"
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    : banCheck.data.verdict === "likely_ban"
                      ? <Ban className="h-4 w-4 text-amber-600" />
                      : <XCircle className="h-4 w-4 text-rose-600" />}
                  {banCheck.data.title}
                </div>
                <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{banCheck.data.detail}</div>
                {banCheck.data.unbanHint && (
                  <div className="text-[11px] mt-2 p-2 rounded bg-white border font-mono" dir="ltr">{banCheck.data.unbanHint}</div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {banCheck.data.probes?.map((p: any) => (
                  <div key={p.label} className="border rounded-lg p-2">
                    <div className="text-[11px] text-muted-foreground" dir="ltr">{p.label}</div>
                    <div className="text-xs font-medium mt-0.5">
                      {p.state === "open" ? <span className="text-emerald-600">مفتوح</span>
                        : p.state === "refused" ? <span className="text-amber-600">يرفض</span>
                        : <span className="text-rose-600">صمت (مهلة)</span>}
                    </div>
                    <div className="text-[10px] text-muted-foreground" dir="ltr">{p.ms} ms</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">آخر فحص: {fmtDate(banCheck.data.checkedAt)}</div>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => checkBan(banCheck.agent)}>
                  <RefreshCw className="h-3 w-3 ms-1" />إعادة الفحص
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── إرسال حزمة التسطيب بالإيميل ── */}
      <Dialog open={!!emailPkg} onOpenChange={(o) => !o && setEmailPkg(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>إرسال حزمة التسطيب — {emailPkg?.agent.name}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            تُرسل رسالة إلى إيميل الوكيل تحتوي: سكربت التثبيت + الإعدادات + إعداد الوكيل العكسي + نبض الترخيص + مفتاح الترخيص وأكواد التسطيب{emailPkg?.agent.mode === "full_shell" ? " + نسخة قاعدة البيانات الابتدائية (هيكل بدون بيانات)" : ""}. الملفات مربوطة بدومين الوكيل ولا تعمل على غيره.
          </p>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">إيميل الوكيل</label>
            <Input dir="ltr" type="email" placeholder="agent@example.com" value={emailPkg?.email ?? ""} onChange={e => setEmailPkg(p => p ? { ...p, email: e.target.value } : p)} data-testid="input-pkg-email" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailPkg(null)}>إلغاء</Button>
            <Button disabled={!emailPkg?.email.trim() || busy === `emailpkg-${emailPkg?.agent.id}`} onClick={async () => {
              if (!emailPkg) return;
              const target = emailPkg.email.trim().toLowerCase();
              const storedEmail = (emailPkg.agent.contactEmail ?? "").trim().toLowerCase();
              let confirmOverride = false;
              if (storedEmail && target !== storedEmail) {
                if (!confirm(`الإيميل مختلف عن إيميل الوكيل المسجّل (${storedEmail}).\nالحزمة تحتوي مفاتيح سرية خاصة بالوكيل — تأكيد الإرسال إلى ${target}؟ سيُحدَّث الإيميل المسجّل أيضًا.`)) return;
                confirmOverride = true;
              }
              setBusy(`emailpkg-${emailPkg.agent.id}`);
              try {
                const r = await fetch(`${API}/api/admin/agent-instances/${emailPkg.agent.id}/email-package`, {
                  method: "POST", headers, body: JSON.stringify({ email: target, confirmOverride }),
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error ?? "فشل الإرسال");
                toast({ title: "تم الإرسال", description: `أُرسلت الحزمة إلى ${j.sentTo}` });
                setEmailPkg(null); invalidate();
              } catch (e: any) {
                toast({ title: "فشل الإرسال", description: String(e.message ?? e), variant: "destructive" });
              } finally { setBusy(null); }
            }} data-testid="button-send-pkg-email">
              {busy === `emailpkg-${emailPkg?.agent.id}` && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}
              <Mail className="h-4 w-4 ms-1" />إرسال
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── رفع اللوجو ── */}
      <Dialog open={showLogoDialog} onOpenChange={setShowLogoDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>رفع لوجو الوكيل</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">يظهر اللوجو على صفحة الدخول عند دومين الوكيل. تُصغَّر الصورة تلقائيًا (بحد أقصى 512px).</p>
          <label
            onDragOver={e => { e.preventDefault(); setLogoDrag(true); }}
            onDragLeave={() => setLogoDrag(false)}
            onDrop={async e => {
              e.preventDefault(); setLogoDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (!f) return;
              try { set("brandLogoUrl", await fileToLogoDataUrl(f)); setShowLogoDialog(false); }
              catch (err: any) { toast({ title: "فشل رفع اللوجو", description: String(err.message ?? err), variant: "destructive" }); }
            }}
            className={`block border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${logoDrag ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"}`}
            data-testid="dropzone-logo"
          >
            <UploadCloud className="h-8 w-8 mx-auto mb-2 text-muted-foreground/60" />
            <div className="text-sm">اسحب الصورة هنا أو اضغط للاختيار</div>
            <div className="text-[11px] text-muted-foreground mt-1">PNG / JPG / WEBP — حتى 3MB</div>
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async e => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try { set("brandLogoUrl", await fileToLogoDataUrl(f)); setShowLogoDialog(false); }
              catch (err: any) { toast({ title: "فشل رفع اللوجو", description: String(err.message ?? err), variant: "destructive" }); }
            }} data-testid="input-logo-file" />
          </label>
          {form.brandLogoUrl && <img src={form.brandLogoUrl} alt="" className="h-16 mx-auto rounded border bg-white object-contain p-1" />}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">أو رابط مباشر للوجو</label>
            <Input dir="ltr" placeholder="https://..." value={form.brandLogoUrl.startsWith("data:") ? "" : form.brandLogoUrl} onChange={e => set("brandLogoUrl", e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLogoDialog(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── نافذة اختيار طريقة التسطيب ── */}
      <Dialog open={!!installDlg} onOpenChange={(o) => { if (!o) setInstallDlg(null); }}>
        <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><UploadCloud className="h-5 w-5" />تسطيب كامل — {installAgent?.name}</DialogTitle></DialogHeader>
          {installDlg && installAgent && (
            <div className="space-y-3">
              {([
                { v: "full" as const, title: "تسطيب كامل (الافتراضي)", desc: "فحص السيرفر، تثبيت PostgreSQL وإنشاء قاعدة البيانات، Caddy والنبض، السكيما والبصمة" + (installAgent.mode === "full" ? "، وتثبيت التطبيق الكامل كخدمة مع محدّث تلقائي." : ".") },
                { v: "no_db" as const, title: "تسطيب بدون قاعدة بيانات", desc: "يستخدم رابط قاعدة البيانات المسجّل في بيانات الوكيل كما هو — لا يثبّت PostgreSQL ولا ينشئ قاعدة جديدة. يفشل برسالة واضحة إذا لم يكن الرابط مُدخلًا." },
                {
                  v: "upload" as const,
                  title: installAgent.packageSource === "external" ? "تسطيب النسخة الكاملة الخارجية" : "تسطيب برفع ملفات",
                  desc: installAgent.packageSource === "external"
                    ? "يثبّت Backend وFrontend وقاعدة البيانات من الحزم المشفّرة والموقّعة الخاصة بهذا الوكيل. تبقى تحديثات المنصة متاحة لاحقًا، لكن تثبيتها يتطلب موافقة المسؤول المحلي ولا توجد إعادة تشغيل تلقائية."
                    : "ترفع ملفات Backend وFrontend وقاعدة البيانات مباشرة إلى التخزين الخاص؛ يتحقق الخادم منها ويحوّلها إلى حزم مشفّرة قبل اعتمادها (للنسخة الكاملة فقط).",
                },
                {
                  v: "upload_no_db" as const,
                  title: "تحديث Backend وFrontend فقط",
                  desc: "يثبّت أحدث حزم التطبيق الخارجية على قاعدة البيانات الحالية، بدون تنزيل أو استعادة ملف قاعدة البيانات وبدون حذف بياناتها.",
                },
              ]).filter(opt => installAgent.packageSource !== "external"
                ? opt.v !== "upload_no_db"
                : opt.v === "upload" || opt.v === "upload_no_db").map(opt => (
                <button key={opt.v} type="button" onClick={() => setInstallDlg(p => p && { ...p, variant: opt.v })}
                  className={`w-full text-start border rounded-xl p-3 transition-colors ${installDlg.variant === opt.v ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:border-primary/40"}`}
                  data-testid={`install-variant-${opt.v}`}>
                  <div className="font-medium text-sm flex items-center gap-2">
                    <span className={`h-3.5 w-3.5 rounded-full border-2 ${installDlg.variant === opt.v ? "border-primary bg-primary" : "border-muted-foreground/40"}`} />
                    {opt.title}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed pr-5">{opt.desc}</div>
                </button>
              ))}

              {(installDlg.variant === "upload" || installDlg.variant === "upload_no_db") && (
                <div className="border rounded-xl p-3 space-y-2 bg-muted/30">
                  <div className="text-xs font-medium">ملفات التسطيب</div>
                    {([
                    { k: "backend" as const, label: "ملف Backend (tar.gz)", required: true, accept: ".tgz,.tar.gz,.gz" },
                    { k: "frontend" as const, label: "ملف Frontend (tar.gz)", required: installAgent.packageSource === "external", accept: ".tgz,.tar.gz,.gz" },
                     { k: "db" as const, label: "نسخة قاعدة البيانات", required: installAgent.packageSource === "external" && installDlg.variant === "upload", accept: ".dump,.backup,.sql,.gz" },
                  ]).map(row => {
                    const st = pkgStatus?.[row.k] ?? null;
                    return (
                      <div key={row.k} className="flex items-center justify-between gap-2 border rounded-lg bg-card p-2">
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium">{row.label}{row.required && <span className="text-rose-600"> *</span>}</div>
                          {st
                            ? <div className="text-[11px] text-emerald-700 truncate" dir="ltr">✓ {st.filename} ({Math.max(1, Math.round(st.sizeBytes / 1024 / 1024))}MB) · SHA {st.sha256.slice(0, 10)}…</div>
                            : <div className="text-[11px] text-muted-foreground">لم يُرفع</div>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <label className="inline-flex">
                            <input type="file" accept={row.accept} className="hidden" onChange={e => {
                              const f = e.target.files?.[0]; e.target.value = "";
                              if (f) void uploadPkg(installDlg.agentId, row.k, f);
                            }} data-testid={`input-pkg-${row.k}`} />
                            <span className="h-7 px-2 text-[11px] inline-flex items-center rounded-md border cursor-pointer hover:bg-accent">
                              {pkgBusy === row.k ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3 ms-1" />}رفع
                            </span>
                          </label>
                          {st && installAgent.packageSource !== "external" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600" disabled={pkgBusy === row.k} onClick={() => void deletePkg(installDlg.agentId, row.k)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {installAgent.autoDomainSetup && (
                <div className={`rounded-xl border p-3 text-xs ${
                  installDlg.autoDomainToken
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
                    : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
                }`} data-testid="provision-auto-domain-confirmation">
                  <div className="font-semibold flex items-center gap-1">
                    {installDlg.autoDomainToken
                      ? <><CheckCircle2 className="h-4 w-4" />تم تأكيد خطة الدومين وSSL لهذه العملية</>
                      : <><AlertTriangle className="h-4 w-4" />يلزم معاينة الدومين وتأكيد خطته قبل التسطيب</>}
                  </div>
                  <div className="mt-1 opacity-80" dir="ltr">{installAgent.domain}</div>
                </div>
              )}

              <label className={`flex items-center gap-2 border rounded-xl p-3 text-sm ${installDlg.variant === "upload" || installDlg.variant === "upload_no_db" ? "cursor-not-allowed bg-muted/40" : "cursor-pointer"}`}>
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={installDlg.encrypt}
                  disabled={installDlg.variant === "upload" || installDlg.variant === "upload_no_db"}
                  onChange={e => setInstallDlg(p => p && { ...p, encrypt: e.target.checked })} data-testid="checkbox-encrypt-bundle" />
                <span>
                  إرسال الحزمة <b>مشفّرة</b> (AES-256)
                  <span className="block text-[11px] text-muted-foreground">{installDlg.variant === "upload" || installDlg.variant === "upload_no_db" ? "إلزامي للحزم الخارجية: مخزنة ومنقولة مشفّرة، ويُسلّم مفتاح الفك عبر جلسة SSH فقط دون حفظه." : "تُنقل الحزمة مشفّرة ويفكّها سيرفر الوكيل بمفتاح يُسلَّم عبر SSH فقط."}</span>
                </span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallDlg(null)}>إلغاء</Button>
            <Button
              disabled={!installAgent
                || busy === `provision-${installDlg?.agentId}`
                || (!!installAgent?.autoDomainSetup && !installDlg?.autoDomainToken)
                || ((installDlg?.variant === "upload" || installDlg?.variant === "upload_no_db") && !pkgStatus?.backend)
                || (installAgent?.packageSource === "external" && (!pkgStatus?.backend || !pkgStatus?.frontend || (installDlg?.variant === "upload" && !pkgStatus?.db)))}
              onClick={() => installAgent && installDlg && provisionNow(installAgent, {
                variant: installDlg.variant,
                encryptBundle: installDlg.encrypt,
                ...(installDlg.autoDomainToken ? { autoDomainConfirmationToken: installDlg.autoDomainToken } : {}),
              })}
              data-testid="button-start-provision">
              {busy === `provision-${installDlg?.agentId}` ? <Loader2 className="h-4 w-4 ms-1 animate-spin" /> : <UploadCloud className="h-4 w-4 ms-1" />}
              بدء التسطيب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── نموذج إضافة/تعديل — صفحة كاملة (بنمط نموذج الفاتورة) ── */}
      {showForm && (
      <div className="fixed inset-0 z-50 bg-background overflow-y-auto" dir="rtl">
        <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2 border-b pb-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center"><Server className="h-5 w-5 text-primary" /></div>
              <div>
                <h1 className="text-lg font-bold">{isEdit ? `تعديل وكيل — ${form.name || "بدون اسم"}` : "وكيل جديد"}</h1>
                <p className="text-xs text-muted-foreground">البيانات الأساسية، قاعدة البيانات، السيرفر، والهوية — كلها في صفحة واحدة.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowForm(false)} data-testid="button-cancel-agent-form">إلغاء</Button>
              <Button onClick={() => {
                if (!form.name.trim() || !form.domain.trim()) { toast({ title: "الاسم والدومين مطلوبان", variant: "destructive" }); return; }
                const existingPassword = agents.find(x => x.id === form.id)?.saPasswordSet;
                if (!isEdit && form.mode === "full" && form.localSuperadminEnabled
                  && (!form.saUsername.trim() || !form.saEmail.trim() || (!existingPassword && !form.saPassword.trim()))) {
                  toast({ title: "أكمل بيانات السوبر أدمن المحلي: اسم المستخدم وكلمة المرور وإيميل OTP", variant: "destructive" });
                  return;
                }
                if (!isEdit && form.mode === "full" && form.localSuperadminEnabled && form.localSuperadminScreens.length === 0) {
                  toast({ title: "اختر شاشة واحدة على الأقل للوحة Super Admin", variant: "destructive" });
                  return;
                }
                saveMut.mutate();
              }} disabled={saveMut.isPending} data-testid="button-save-agent">
                {saveMut.isPending && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}
                {formPackageProgress ?? "حفظ"}
              </Button>
            </div>
          </div>
          <div className="border rounded-xl bg-card p-4">
          <Tabs defaultValue="basic">
            <TabsList className="w-full flex-wrap h-auto">
              <TabsTrigger value="basic">البيانات</TabsTrigger>
              <TabsTrigger value="db">قاعدة البيانات</TabsTrigger>
              <TabsTrigger value="server">السيرفر</TabsTrigger>
              <TabsTrigger value="brand">الهوية</TabsTrigger>
              {form.mode === "full" && form.packageSource === "external" && <TabsTrigger value="packages">الحزمة الخارجية</TabsTrigger>}
            </TabsList>

            <TabsContent value="basic" className="mt-3 grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground block mb-1">اسم الوكيل *</label><Input value={form.name} onChange={e => set("name", e.target.value)} data-testid="input-agent-name" /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">الدومين الرئيسي *</label><Input dir="ltr" placeholder="erp.agent.com" value={form.domain} onChange={e => set("domain", e.target.value)} data-testid="input-agent-domain" /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">الهاتف</label><Input dir="ltr" value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">البريد</label><Input dir="ltr" value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} /></div>
              <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">دومينات إضافية (سطر لكل دومين)</label>
                <Textarea dir="ltr" rows={2} value={form.extraDomainsText} onChange={e => set("extraDomainsText", e.target.value)} /></div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">نوع النسخة</label>
                <Select
                  value={form.mode === "full" && form.packageSource === "external" ? "full_external" : form.mode}
                  onValueChange={v => setForm(p => {
                    const nextFull = v === "full" || v === "full_external";
                    return v === "full_external"
                      ? { ...p, mode: "full", packageSource: "external", localSuperadminEnabled: p.mode === "full" ? p.localSuperadminEnabled : true, localSuperadminScreens: p.mode === "full" ? p.localSuperadminScreens : [...DEFAULT_LOCAL_SUPERADMIN_SCREENS] }
                      : { ...p, mode: v, packageSource: "central", localSuperadminEnabled: nextFull ? (p.mode === "full" ? p.localSuperadminEnabled : true) : false, localSuperadminScreens: nextFull ? (p.mode === "full" ? p.localSuperadminScreens : [...DEFAULT_LOCAL_SUPERADMIN_SCREENS]) : [] };
                  })}
                >
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="frontend_only">واجهة فقط + API مركزي (موصى به)</SelectItem>
                    <SelectItem value="full_shell">نسخة قشرة كاملة (فرونت + باك قشرة)</SelectItem>
                    <SelectItem value="full">نسخة كاملة — إصدار مركزي</SelectItem>
                    <SelectItem value="full_external">نسخة كاملة خارجية</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">لوحة Super Admin المحلية</label>
                <Select
                  value={form.localSuperadminEnabled ? "enabled" : "disabled"}
                  disabled={form.mode !== "full"}
                  onValueChange={v => set("localSuperadminEnabled", v === "enabled")}
                >
                  <SelectTrigger className="h-9" data-testid="select-agent-local-sa"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="enabled">نسخة مع لوحة التحكم Super Admin</SelectItem>
                    <SelectItem value="disabled">نسخة بدون لوحة التحكم Super Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">أقصى عدد شركات</label><Input inputMode="numeric" dir="ltr" value={form.maxCompanies} onChange={e => set("maxCompanies", e.target.value)} /></div>
              {form.mode === "full" && form.localSuperadminEnabled && (
                <div className="col-span-2 border rounded-lg p-3 bg-muted/30 space-y-3">
                  <div className="text-xs font-medium">حساب السوبر أدمن للنسخة الكاملة <span className="text-muted-foreground font-normal">— يُزرع في قاعدة بيانات الوكيل عند التسطيب ليدخل به الوكيل للوحة التحكم</span></div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="text-xs text-muted-foreground block mb-1">اسم المستخدم</label>
                      <Input dir="ltr" placeholder="admin" value={form.saUsername} onChange={e => set("saUsername", e.target.value)} data-testid="input-agent-sa-username" /></div>
                    <div><label className="text-xs text-muted-foreground block mb-1">كلمة المرور {isEdit && agents.find(x => x.id === form.id)?.saPasswordSet && <span className="opacity-70">(محفوظة — فارغ = الإبقاء)</span>}</label>
                      <Input dir="ltr" type="password" autoComplete="new-password" name={`agent-sa-password-${form.id || "new"}`} placeholder="10 أحرف فأكثر (أحرف وأرقام)" value={form.saPassword} onChange={e => set("saPassword", e.target.value)} data-testid="input-agent-sa-password" /></div>
                    <div><label className="text-xs text-muted-foreground block mb-1">إيميل استقبال OTP</label>
                      <Input dir="ltr" placeholder="owner@agent.com" value={form.saEmail} onChange={e => set("saEmail", e.target.value)} data-testid="input-agent-sa-email" /></div>
                  </div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">كلمة المرور تُحفظ مشفّرة ولا تُعرض بعد الحفظ. عند الدخول للوحة تحكم نسخة الوكيل يصل رمز التحقق (OTP) إلى هذا الإيميل. إذا كانت النسخة مسطّبة، يطبّق الحفظ التغيير مباشرةً على إعداد السيرفر والحساب والجلسات.</div>
                  {isEdit && (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy === `save-local-sa-${form.id}`}
                        onClick={saveLocalSuperadminSettings}
                        data-testid="button-save-local-superadmin-only"
                      >
                        {busy === `save-local-sa-${form.id}` && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}
                        حفظ إعدادات Super Admin فقط
                      </Button>
                      <span className="text-[11px] text-muted-foreground">لا تُرسل هذه البيانات عند حفظ الحزمة أو السيرفر أو الهوية.</span>
                    </div>
                  )}
                </div>
              )}
              {form.mode === "full" && form.localSuperadminEnabled && (
                <div className="col-span-2 border rounded-lg p-3 space-y-3" data-testid="local-superadmin-screens">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-xs font-medium">شاشات لوحة Super Admin للوكيل</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">تظهر فقط الشاشات المحددة، والرابط المباشر للشاشة غير المحددة يعرض صفحة غير موجودة.</div>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() =>
                      set("localSuperadminScreens", form.localSuperadminScreens.length === DEFAULT_LOCAL_SUPERADMIN_SCREENS.length
                        ? []
                        : [...DEFAULT_LOCAL_SUPERADMIN_SCREENS])}
                      data-testid="button-toggle-all-local-sa-screens">
                      {form.localSuperadminScreens.length === DEFAULT_LOCAL_SUPERADMIN_SCREENS.length ? "إلغاء تحديد الكل" : "تحديد الكل"}
                    </Button>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
                    {LOCAL_SUPERADMIN_SCREENS.map(screen => {
                      const selected = form.localSuperadminScreens.includes(screen.id);
                      return (
                        <label key={screen.id} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={selected}
                            onChange={e => set("localSuperadminScreens", e.target.checked
                              ? [...form.localSuperadminScreens, screen.id]
                              : form.localSuperadminScreens.filter(id => id !== screen.id))}
                            data-testid={`checkbox-local-sa-screen-${screen.id}`} />
                          <span>{screen.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* إعداد النطاق التلقائي */}
              <div className="col-span-2 border border-border rounded-md p-4 space-y-4 bg-muted/30">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 cursor-pointer w-fit">
                      <input
                        type="checkbox"
                        className="accent-primary w-4 h-4"
                        checked={form.autoDomainSetup}
                        onChange={e => set("autoDomainSetup", e.target.checked)}
                        data-testid="toggle-auto-domain"
                      />
                      <span className="text-sm font-semibold">إعداد النطاق التلقائي (Cloudflare)</span>
                    </label>
                    <div className="text-xs text-muted-foreground mr-6">
                      اختياري ومتوقف افتراضيًا. بعد الحفظ تُعرض خطة دقيقة لسجل A الرئيسي و80/443 وCaddy قبل أي تغيير.
                      الدومينات الإضافية والسجلات الأخرى والمسار اليدوي لا تتغير.
                    </div>
                  </div>
                </div>
                {form.autoDomainSetup && (
                  <div className="pt-3 border-t border-border flex flex-col gap-4 mr-6">
                    <label className="flex items-start gap-2 cursor-pointer w-fit">
                      <input
                        type="checkbox"
                        className="accent-primary w-4 h-4 mt-1"
                        checked={form.autoDomainProxyEnabled}
                        onChange={e => set("autoDomainProxyEnabled", e.target.checked)}
                        data-testid="toggle-auto-domain-proxy"
                      />
                      <div className="space-y-0.5">
                        <span className="text-sm font-semibold block">تفعيل البروكسي (Proxy)</span>
                        <span className="text-xs text-muted-foreground block max-w-lg">
                          إخفاء عنوان الخادم واستخدام حماية Cloudflare (علامة السحابة البرتقالية).
                          يتطلب أن يكون الدومين مضافاً في حسابك على Cloudflare.
                        </span>
                      </div>
                    </label>
                    {isEdit && (
                      <div className="flex items-center gap-2 text-sm mt-2 border border-border w-max px-3 py-1.5 rounded-md bg-card">
                        <span className="text-muted-foreground">حالة اتصال Cloudflare:</span>
                        {agents.find(x => x.id === form.id)?.cloudflareConnected ? (
                           <span className="text-green-600 flex items-center gap-1 font-semibold"><CheckCircle2 className="h-4 w-4" /> متصل</span>
                        ) : (
                           <span className="text-destructive flex items-center gap-1 font-semibold"><XCircle className="h-4 w-4" /> غير متصل</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div><label className="text-xs text-muted-foreground block mb-1">انتهاء الترخيص</label><DateField value={form.licenseExpiresAt} onChange={e => set("licenseExpiresAt", e.target.value)} /></div>
              <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">ملاحظات</label><Textarea rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} /></div>
            </TabsContent>

            <TabsContent value="db" className="mt-3 space-y-3">
              <div className="text-xs text-muted-foreground bg-muted/40 border rounded-lg p-3 leading-relaxed">
                رابط PostgreSQL على سيرفر الوكيل. يُحفظ <b>مشفّرًا</b> ولا يُعرض بعد الحفظ — اتركه فارغًا للإبقاء على الحالي.
                بعد الحفظ استخدم «اختبار» ثم «تهيئة + بصمة» من بطاقة الوكيل.
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  رابط الاتصال {isEdit && form.id > 0 && <span className="opacity-70">(محفوظ حاليًا: {agents.find(x => x.id === form.id)?.dbUrlSet ? "نعم — مشفّر" : "لا"})</span>}
                </label>
                <Input dir="ltr" type="password" placeholder="postgresql://user:pass@host:5432/dbname?sslmode=require" value={form.dbUrl} onChange={e => set("dbUrl", e.target.value)} data-testid="input-agent-dburl" />
              </div>
            </TabsContent>

            {form.mode === "full" && form.packageSource === "external" && (
              <TabsContent value="packages" className="mt-3 space-y-3">
                <div className="text-xs bg-sky-50 text-sky-900 border border-sky-200 rounded-lg p-3 leading-relaxed">
                  <div className="font-semibold flex items-center gap-1.5 mb-1"><LockKeyhole className="h-3.5 w-3.5" />نسخة كاملة خارجية مشفّرة</div>
                  تُخزّن ملفات Backend وFrontend وقاعدة البيانات في التخزين الخاص فقط، بصيغة AES-256 مع بصمة SHA-256 وتوقيع تحقق.
                  عند التسطيب يُرسل مفتاح الفك خلال جلسة SSH ولا يُحفظ داخل إعدادات التطبيق.
                  الرفع الكبير يذهب مباشرةً إلى مساحة خاصة مؤقتة، ثم يتحقق الخادم من الملف ويشفّره قبل اعتماده ويحذف النسخة المؤقتة.
                </div>

                <div className="grid gap-2">
                  {([
                    { kind: "backend" as const, hint: "ملف tar.gz خام يحتوي index.mjs؛ سيُشفّر بعد الرفع" },
                    { kind: "frontend" as const, hint: "ملف tar.gz خام يحتوي index.html؛ سيُشفّر بعد الرفع" },
                    { kind: "db" as const, hint: "PostgreSQL dump أو SQL أو SQL.gz؛ سيُشفّر بعد الرفع" },
                  ]).map(row => {
                    const existing = editingAgent?.externalPackage?.[row.kind] ?? null;
                    const selected = formPackageFiles[row.kind];
                    return (
                      <div key={row.kind} className="border rounded-lg p-3 bg-card" data-testid={`form-package-${row.kind}`}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold">{packageLabel(row.kind)} <span className="text-rose-600">*</span></div>
                            <div className="text-[10px] text-muted-foreground">{row.hint}</div>
                            {selected ? (
                              <div className="text-[11px] text-blue-700 truncate mt-1" dir="ltr">جاهز للرفع عند الحفظ: {selected.name} ({Math.max(1, Math.round(selected.size / 1024 / 1024))}MB)</div>
                            ) : existing ? (
                              <>
                                <div className="text-[11px] text-emerald-700 truncate mt-1" dir="ltr">✓ {existing.filename} ({Math.max(1, Math.round(existing.sizeBytes / 1024 / 1024))}MB)</div>
                                <div className="text-[10px] font-mono text-muted-foreground" dir="ltr">SHA-256 {existing.sha256.slice(0, 16)}…</div>
                              </>
                            ) : <div className="text-[11px] text-rose-600 mt-1">غير موجود</div>}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <label className="inline-flex">
                              <input
                                type="file"
                                accept={row.kind === "db" ? ".dump,.backup,.sql,.gz" : ".tgz,.tar.gz,.gz"}
                                className="hidden"
                                onChange={e => {
                                  const file = e.target.files?.[0] ?? null;
                                  e.target.value = "";
                                  if (file) setFormPackageFiles(p => ({ ...p, [row.kind]: file }));
                                }}
                                data-testid={`input-form-package-${row.kind}`}
                              />
                              <span className="h-8 px-2.5 text-[11px] inline-flex items-center rounded-md border cursor-pointer hover:bg-accent">
                                <UploadCloud className="h-3.5 w-3.5 ms-1" />{existing ? "استبدال بملف خام" : "اختيار ملف خام"}
                              </span>
                            </label>
                            {selected && (
                              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-rose-600"
                                onClick={() => setFormPackageFiles(p => ({ ...p, [row.kind]: null }))}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {existing && (
                              <Button type="button" variant="ghost" size="sm" className="h-8 text-[11px]"
                                disabled={pkgBusy === `download-${row.kind}`}
                                onClick={() => downloadPkg(form.id, row.kind)}>
                                <FileDown className="h-3.5 w-3.5 ms-1" />تنزيل
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                  <div className="text-xs font-medium">أو جهّز الملفات الثلاثة من المنصة</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    يُستخدم إصدار Backend/Frontend المنشور حاليًا، وتُؤخذ نسخة كاملة من <b>قاعدة بيانات الوكيل الخارجية</b> المسجّلة.
                    لا تُنسخ هوية المنصة المركزية أو جلسات السوبر أدمن، وتُعاد هوية هذا الوكيل وبصمته بعد الاستعادة.
                    {!isEdit && " عند إنشاء الوكيل ستتم هذه الخطوة تلقائيًا إذا لم تختر ملفات."}
                  </div>
                  {isEdit && (
                    <Button type="button" variant="outline" size="sm"
                      disabled={!editingAgent?.dbUrlSet || editingAgent?.mode !== "full" || pkgBusy === "prepare"}
                      onClick={() => editingAgent && prepareExternalPackage(editingAgent)}
                      data-testid="button-prepare-external-form">
                      {pkgBusy === "prepare" ? <Loader2 className="h-3.5 w-3.5 ms-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 ms-1" />}
                      تجهيز Backend + Frontend + Database
                    </Button>
                  )}
                  {isEdit && editingAgent?.mode !== "full" && (
                    <div className="text-[10px] text-amber-700">احفظ الوكيل أولًا كنسخة كاملة؛ بعدها يمكن تجهيز الحزمة من قاعدة بياناته.</div>
                  )}
                </div>

                <div className="text-[11px] text-muted-foreground border-s-2 border-emerald-400 ps-3">
                  بعد التثبيت تظل الإصدارات المركزية الجديدة قابلة للتثبيت يدويًا من داخل السيرفر الخارجي. يلزم تأكيد السوبر أدمن المحلي، ويُجرى فحص صحة ورجوع تلقائي عند الفشل، ولا يُعاد تشغيل السيرفر دون الموافقة.
                </div>
              </TabsContent>
            )}

            <TabsContent value="server" className="mt-3 grid grid-cols-2 gap-3">
              <div className="col-span-2 text-xs text-muted-foreground bg-muted/40 border rounded-lg p-3">
                بيانات SSH لسيرفر الوكيل — تُستخدم لاحقًا للنشر الآلي. كلمة المرور/المفتاح يُحفظ مشفّرًا ولا يُعرض.
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">Host / IP</label><Input dir="ltr" value={form.sshHost} onChange={e => set("sshHost", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المنفذ</label><Input dir="ltr" inputMode="numeric" value={form.sshPort} onChange={e => set("sshPort", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المستخدم</label><Input dir="ltr" value={form.sshUser} onChange={e => set("sshUser", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">كلمة المرور / المفتاح</label><Input dir="ltr" type="password" placeholder={isEdit ? "اتركه فارغًا للإبقاء" : ""} value={form.sshSecret} onChange={e => set("sshSecret", e.target.value)} /></div>
              {isEdit && (
                <div className="col-span-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy === `ssh-save-${form.id}` || !form.sshHost.trim() || !form.sshUser.trim()}
                    onClick={saveSshCredentials}
                    data-testid="button-save-agent-ssh-only"
                  >
                    {busy === `ssh-save-${form.id}` && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}
                    حفظ بيانات SSH فقط
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    لا يتأثر بإعدادات Super Admin أو نوع النسخة.
                  </span>
                </div>
              )}
              {isEdit && form.mode === "full" && (
                <div className="col-span-2 border-t pt-3 space-y-3">
                  <div className="text-xs font-medium flex items-center gap-1.5">
                    <Mail className="h-4 w-4" />
                    بريد OTP المستقل للوكيل
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    أدخل حساب الإرسال وكلمة مرور التطبيق. تُرسل مباشرة إلى السيرفر المشفّر ولا تُحفظ في المتصفح أو سجل التسطيب.
                    لحساب Gmail فعّل التحقق بخطوتين وأنشئ <b>App Password</b>؛ لا تستخدم كلمة مرور Gmail العادية.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground block mb-1">خادم SMTP</label>
                      <Input dir="ltr" value={smtpRepair.host} onChange={e => setSmtpRepair(p => ({ ...p, host: e.target.value }))} placeholder="smtp.gmail.com" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground block mb-1">المنفذ</label>
                      <Input dir="ltr" inputMode="numeric" value={smtpRepair.port} onChange={e => setSmtpRepair(p => ({ ...p, port: e.target.value }))} placeholder="587" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground block mb-1">بريد الإرسال</label>
                      <Input dir="ltr" type="email" value={smtpRepair.user} onChange={e => setSmtpRepair(p => ({ ...p, user: e.target.value, from: e.target.value }))} placeholder="sender@gmail.com" autoComplete="off" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground block mb-1">كلمة مرور التطبيق</label>
                      <Input dir="ltr" type="password" value={smtpRepair.password} onChange={e => setSmtpRepair(p => ({ ...p, password: e.target.value }))} placeholder="App Password" autoComplete="new-password" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        busy === `repair-email-${form.id}` ||
                        !editingAgent?.sshSecretSet ||
                        !editingAgent?.saEmail ||
                        !smtpRepair.host.trim() ||
                        !smtpRepair.user.trim() ||
                        !smtpRepair.password
                      }
                      onClick={repairAgentEmail}
                      data-testid="button-repair-agent-email"
                    >
                      {busy === `repair-email-${form.id}` ? <Loader2 className="h-4 w-4 ms-1 animate-spin" /> : <Mail className="h-4 w-4 ms-1" />}
                      حفظ SMTP وإرسال اختبار
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      بدون إعادة التسطيب أو استعادة قاعدة البيانات.
                    </span>
                  </div>
                </div>
              )}
              {isEdit && (
                <div className="col-span-2">
                  <StandbyServers agentId={form.id} agentMode={form.mode} headers={headers} toast={toast} />
                </div>
              )}
            </TabsContent>

            <TabsContent value="brand" className="mt-3 grid grid-cols-2 gap-3">
              <div className="col-span-2 text-xs text-muted-foreground bg-muted/40 border rounded-lg p-3">
                تظهر على صفحة الدخول عند دومين الوكيل بدل هوية النظام الرئيسية — وصفحة دخوله تعرض <b>تسجيل الدخول فقط</b> (إنشاء الحساب ممنوع من دومين الوكيل تلقائيًا).
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">اسم النظام عند الوكيل</label><Input value={form.brandName} onChange={e => set("brandName", e.target.value)} data-testid="input-agent-brandname" /></div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">لون أساسي (اختياري)</label>
                <div className="flex items-center gap-2">
                  <input type="color" className="h-9 w-10 rounded border cursor-pointer bg-white p-0.5" value={/^#[0-9a-fA-F]{6}$/.test(form.brandColor) ? form.brandColor : "#0f766e"} onChange={e => set("brandColor", e.target.value)} data-testid="input-agent-color-picker" />
                  <Input dir="ltr" placeholder="#0f766e" value={form.brandColor} onChange={e => set("brandColor", e.target.value)} />
                </div>
                {/* جريدة ألوان جاهزة */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {BRAND_PALETTE.map(c => (
                    <button key={c} type="button" title={c} onClick={() => set("brandColor", c)}
                      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${form.brandColor.toLowerCase() === c ? "border-slate-900 ring-2 ring-offset-1 ring-slate-400" : "border-white shadow"}`}
                      style={{ backgroundColor: c }} data-testid={`swatch-${c.slice(1)}`} />
                  ))}
                </div>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-muted-foreground block mb-1">اللوجو</label>
                <div className="flex items-center gap-3">
                  {form.brandLogoUrl
                    ? <img src={form.brandLogoUrl} alt="" className="h-16 w-16 rounded-lg border bg-white object-contain p-1" />
                    : <div className="h-16 w-16 rounded-lg border border-dashed flex items-center justify-center text-muted-foreground"><UploadCloud className="h-6 w-6 opacity-40" /></div>}
                  <div className="space-y-1.5">
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowLogoDialog(true)} data-testid="button-upload-logo">
                      <UploadCloud className="h-4 w-4 ms-1" />{form.brandLogoUrl ? "تغيير اللوجو" : "رفع لوجو"}
                    </Button>
                    {form.brandLogoUrl && (
                      <Button type="button" variant="ghost" size="sm" className="text-rose-600 h-7" onClick={() => set("brandLogoUrl", "")}>
                        <Trash2 className="h-3.5 w-3.5 ms-1" />إزالة
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
          </div>
          <div className="flex justify-end gap-2 pb-8">
            <Button variant="outline" onClick={() => setShowForm(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!form.name.trim() || !form.domain.trim()) { toast({ title: "الاسم والدومين مطلوبان", variant: "destructive" }); return; }
              saveMut.mutate();
            }} disabled={saveMut.isPending} data-testid="button-save-agent-bottom">
              {saveMut.isPending && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}
              {formPackageProgress ?? "حفظ"}
            </Button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ── السيرفرات الاحتياطية (تعدد السيرفرات لكل وكيل) ──────────────────────────
type StandbySrv = {
  id: number; label: string; role: string;
  sshHost: string | null; sshPort: number | null; sshUser: string | null; sshSecretSet: boolean;
  sshStatus: string; sshLastCheckAt: string | null;
  deployStatus: string; deployLog: string | null; lastDeployAt: string | null;
  lastHeartbeatAt: string | null; lastSeenIp: string | null; deployedVersion: string | null;
  notes: string | null;
};

const emptySrvForm = { id: 0, label: "", sshHost: "", sshPort: "22", sshUser: "root", sshSecret: "" };

function StandbyServers({ agentId, agentMode, headers, toast }: {
  agentId: number; agentMode: string;
  headers: Record<string, string>;
  toast: (o: { title: string; description?: string; variant?: "destructive" }) => void;
}) {
  const qc = useQueryClient();
  const base = `${API}/api/admin/agent-instances/${agentId}/servers`;
  const listQ = useQuery<StandbySrv[]>({
    queryKey: ["agent-servers", agentId],
    queryFn: async () => {
      const r = await fetch(base, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    refetchInterval: (q) => (q.state.data ?? []).some(s => s.deployStatus === "deploying") ? 3000 : 30_000,
  });
  const [srvForm, setSrvForm] = useState<typeof emptySrvForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logView, setLogView] = useState<{ title: string; text: string } | null>(null);
  const [promoteSrv, setPromoteSrv] = useState<StandbySrv | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["agent-servers", agentId] });

  async function call(path: string, method: string, body?: any, key?: string) {
    if (key) setBusy(key);
    try {
      const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل");
      refresh();
      return j;
    } finally { if (key) setBusy(null); }
  }

  async function saveSrv() {
    const f = srvForm!;
    if (!f.label.trim()) { toast({ title: "أدخل اسمًا للسيرفر", variant: "destructive" }); return; }
    const payload: any = {
      label: f.label.trim(),
      sshHost: f.sshHost.trim() || null,
      sshPort: f.sshPort ? Number(f.sshPort) : null,
      sshUser: f.sshUser.trim() || null,
    };
    if (f.sshSecret.trim()) payload.sshSecret = f.sshSecret.trim();
    try {
      await call(f.id ? `${base}/${f.id}` : base, f.id ? "PUT" : "POST", payload, "save");
      setSrvForm(null);
      toast({ title: "تم الحفظ" });
    } catch (e: any) { toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }); }
  }

  const hbBadge = (s: StandbySrv) => {
    if (!s.lastHeartbeatAt) return <Badge variant="outline" className="text-[10px] h-4 px-1">لا نبض بعد</Badge>;
    const ageMin = (Date.now() - new Date(s.lastHeartbeatAt).getTime()) / 60_000;
    return ageMin <= 12
      ? <Badge className="text-[10px] h-4 px-1 bg-emerald-600">نبض حي</Badge>
      : <Badge variant="destructive" className="text-[10px] h-4 px-1">نبض متوقف ({Math.round(ageMin)} د)</Badge>;
  };

  const servers = listQ.data ?? [];
  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/20" data-testid="standby-servers-block">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-1.5">
          <Server className="h-4 w-4" />سيرفرات احتياطية ({servers.length})
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
          onClick={() => setSrvForm({ ...emptySrvForm })} data-testid="button-add-standby">
          + إضافة سيرفر
        </Button>
      </div>
      <div className="text-[11px] text-muted-foreground leading-relaxed">
        عند تعطل السيرفر الرئيسي: سطّب بوابة الدخول على السيرفر الاحتياطي مسبقًا، وعند الحاجة اضغط «ترقية إلى رئيسي» ثم وجّه DNS للدومين إلى عنوانه. اجعل TTL للدومين منخفضًا (60-300 ثانية) ليكون التحويل سريعًا.
        {agentMode === "full" && <span className="text-amber-700 block mt-1">تنبيه: النسخة الكاملة تعمل محليًا بقاعدة بياناتها — التسطيب الاحتياطي متاح حاليًا لوضع البوابة فقط.</span>}
      </div>

      {servers.map(s => (
        <div key={s.id} className="border rounded-lg p-2.5 bg-background space-y-1.5" data-testid={`standby-row-${s.id}`}>
          <div className="flex items-center justify-between flex-wrap gap-1.5">
            <div className="text-xs font-medium">{s.label}</div>
            <div className="flex items-center gap-1.5">{hbBadge(s)}
              {s.deployStatus === "ok" ? <Badge className="text-[10px] h-4 px-1 bg-emerald-600">مسطّب</Badge>
                : s.deployStatus === "deploying" ? <Badge variant="secondary" className="text-[10px] h-4 px-1">تسطيب جارٍ…</Badge>
                : s.deployStatus === "error" ? <Badge variant="destructive" className="text-[10px] h-4 px-1">فشل التسطيب</Badge>
                : <Badge variant="outline" className="text-[10px] h-4 px-1">غير مسطّب</Badge>}
            </div>
          </div>
          <div dir="ltr" className="text-[11px] text-muted-foreground">{s.sshHost ? `${s.sshUser ?? "?"}@${s.sshHost}:${s.sshPort ?? 22}` : "—"}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]" disabled={!s.sshHost || busy === `test-${s.id}`}
              onClick={async () => {
                try { const j = await call(`${base}/${s.id}/test-ssh`, "POST", undefined, `test-${s.id}`); toast({ title: "فحص السيرفر: تم بنجاح", description: j.note }); }
                catch (e: any) { toast({ title: "فحص السيرفر: فشل", description: String(e.message ?? e), variant: "destructive" }); }
              }} data-testid={`button-standby-test-${s.id}`}>
              {busy === `test-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : "اختبار SSH"}
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]"
              disabled={agentMode === "full" || !s.sshHost || !s.sshSecretSet || s.deployStatus === "deploying" || busy === `deploy-${s.id}`}
              onClick={async () => {
                try { await call(`${base}/${s.id}/deploy`, "POST", undefined, `deploy-${s.id}`); toast({ title: "تم تسطيب بوابة الدخول على السيرفر الاحتياطي" }); }
                catch (e: any) { toast({ title: "فشل التسطيب", description: String(e.message ?? e), variant: "destructive" }); }
              }} data-testid={`button-standby-deploy-${s.id}`}>
              {busy === `deploy-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : "تسطيب البوابة"}
            </Button>
            <Button type="button" size="sm" className="h-6 text-[11px]" disabled={s.deployStatus !== "ok" || busy === `promote-${s.id}`}
              onClick={() => setPromoteSrv(s)} data-testid={`button-standby-promote-${s.id}`}>
              ترقية إلى رئيسي
            </Button>
            {s.deployLog && (
              <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => setLogView({ title: `سجل التسطيب — ${s.label}`, text: s.deployLog! })}>
                السجل
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => setSrvForm({ id: s.id, label: s.label, sshHost: s.sshHost ?? "", sshPort: s.sshPort != null ? String(s.sshPort) : "22", sshUser: s.sshUser ?? "", sshSecret: "" })}>
              تعديل
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px] text-rose-600" disabled={busy === `del-${s.id}`}
              onClick={async () => {
                try { await call(`${base}/${s.id}`, "DELETE", undefined, `del-${s.id}`); toast({ title: "تم حذف السيرفر" }); }
                catch (e: any) { toast({ title: "فشل الحذف", description: String(e.message ?? e), variant: "destructive" }); }
              }} data-testid={`button-standby-delete-${s.id}`}>
              حذف
            </Button>
          </div>
        </div>
      ))}
      {!servers.length && !listQ.isLoading && (
        <div className="text-[11px] text-muted-foreground text-center py-2">لا توجد سيرفرات احتياطية بعد</div>
      )}

      {/* نموذج إضافة/تعديل سيرفر احتياطي */}
      <Dialog open={!!srvForm} onOpenChange={(o) => !o && setSrvForm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{srvForm?.id ? "تعديل سيرفر احتياطي" : "إضافة سيرفر احتياطي"}</DialogTitle></DialogHeader>
          {srvForm && (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">الاسم</label>
                <Input placeholder="مثال: السيرفر الاحتياطي" value={srvForm.label} onChange={e => setSrvForm(p => p && { ...p, label: e.target.value })} data-testid="input-standby-label" /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">Host / IP</label>
                <Input dir="ltr" value={srvForm.sshHost} onChange={e => setSrvForm(p => p && { ...p, sshHost: e.target.value })} data-testid="input-standby-host" /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المنفذ</label>
                <Input dir="ltr" inputMode="numeric" value={srvForm.sshPort} onChange={e => setSrvForm(p => p && { ...p, sshPort: e.target.value })} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المستخدم</label>
                <Input dir="ltr" value={srvForm.sshUser} onChange={e => setSrvForm(p => p && { ...p, sshUser: e.target.value })} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">كلمة المرور / المفتاح</label>
                <Input dir="ltr" type="password" placeholder={srvForm.id ? "اتركه فارغًا للإبقاء" : ""} value={srvForm.sshSecret} onChange={e => setSrvForm(p => p && { ...p, sshSecret: e.target.value })} data-testid="input-standby-secret" /></div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSrvForm(null)}>إلغاء</Button>
            <Button onClick={saveSrv} disabled={busy === "save"} data-testid="button-standby-save">
              {busy === "save" && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* تأكيد الترقية */}
      <Dialog open={!!promoteSrv} onOpenChange={(o) => !o && setPromoteSrv(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>ترقية «{promoteSrv?.label}» إلى سيرفر رئيسي؟</DialogTitle></DialogHeader>
          <div className="text-xs text-muted-foreground space-y-2 leading-relaxed">
            <p>سيتم تبادل بيانات السيرفرين: هذا السيرفر يصبح <b>الرئيسي</b> (كل عمليات النشر وفك الحظر والفحص عليه)، والرئيسي الحالي يصبح احتياطيًا.</p>
            <p className="text-amber-700 font-medium">بعد الترقية يجب توجيه سجل DNS للدومين إلى عنوان السيرفر الجديد <span dir="ltr">({promoteSrv?.sshHost})</span> — التحويل الفعلي للزوار يتم عبر DNS.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPromoteSrv(null)}>إلغاء</Button>
            <Button disabled={busy === `promote-${promoteSrv?.id}`} onClick={async () => {
              const s = promoteSrv!;
              try {
                const j = await call(`${base}/${s.id}/promote`, "POST", undefined, `promote-${s.id}`);
                qc.invalidateQueries({ queryKey: ["agent-instances"] });
                setPromoteSrv(null);
                toast({ title: "تمت الترقية", description: j.note });
              } catch (e: any) { toast({ title: "فشلت الترقية", description: String(e.message ?? e), variant: "destructive" }); }
            }} data-testid="button-standby-promote-confirm">
              {busy === `promote-${promoteSrv?.id}` && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}تأكيد الترقية
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* عرض السجل */}
      <Dialog open={!!logView} onOpenChange={(o) => !o && setLogView(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{logView?.title}</DialogTitle></DialogHeader>
          <pre dir="ltr" className="text-[11px] bg-muted rounded-lg p-3 whitespace-pre-wrap break-all max-h-[60vh] overflow-y-auto">{logView?.text || "—"}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
