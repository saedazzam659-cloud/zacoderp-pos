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
  HeartPulse, AlertTriangle, UploadCloud, FileDown, Mail, Check,
} from "lucide-react";

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
  installationId: string; licenseKey: string | null; licenseExpiresAt: string | null;
  maxCompanies: number | null;
  dbUrlSet: boolean; dbStatus: string; dbLastCheckAt: string | null; dbLastError: string | null;
  sshHost: string | null; sshPort: number | null; sshUser: string | null; sshSecretSet: boolean; sshStatus: string; sshLastCheckAt: string | null;
  brandName: string | null; brandLogoUrl: string | null; brandColor: string | null;
  lastHeartbeatAt: string | null; lastSeenIp: string | null; deployedVersion: string | null;
  deployStatus: string; deployLog: string | null; lastDeployAt: string | null;
  saUsername: string | null; saEmail: string | null; saPasswordSet: boolean;
  notes: string | null; createdAt: string;
};

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
  mode: "frontend_only", maxCompanies: "", licenseExpiresAt: "",
  dbUrl: "", sshHost: "", sshPort: "22", sshUser: "", sshSecret: "",
  brandName: "", brandLogoUrl: "", brandColor: "", notes: "",
  saUsername: "", saEmail: "", saPassword: "",
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return String(s).slice(0, 16).replace("T", " ");
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
  const isEdit = form.id > 0;
  const set = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agent-instances"] });
    qc.invalidateQueries({ queryKey: ["agent-security-events"] });
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload: any = {
        name: form.name, domain: form.domain,
        contactPhone: form.contactPhone || null, contactEmail: form.contactEmail || null,
        extraDomains: form.extraDomainsText.split(/[\n,،]+/).map(s => s.trim()).filter(Boolean),
        mode: form.mode,
        maxCompanies: form.maxCompanies ? Number(form.maxCompanies) : null,
        licenseExpiresAt: form.licenseExpiresAt || null,
        brandName: form.brandName || null, brandColor: form.brandColor || null,
        sshHost: form.sshHost || null, sshPort: form.sshPort ? Number(form.sshPort) : null, sshUser: form.sshUser || null,
        notes: form.notes || null,
        saUsername: form.saUsername.trim() || null,
        saEmail: form.saEmail.trim() || null,
      };
      // كلمة مرور السوبر أدمن: تُرسل فقط عند إدخال قيمة جديدة (فارغ = الإبقاء).
      if (form.saPassword.trim()) payload.saPassword = form.saPassword.trim();
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
      const r = await fetch(`${API}/api/admin/agent-instances${isEdit ? `/${form.id}` : ""}`, {
        method: isEdit ? "PUT" : "POST", headers, body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل الحفظ");
      return r.json();
    },
    onSuccess: () => { invalidate(); setShowForm(false); toast({ title: "تم الحفظ" }); },
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
  // نافذة اختيار طريقة التسطيب: كامل / بدون قاعدة بيانات / برفع ملفات (+ تشفير)
  const [installDlg, setInstallDlg] = useState<{ agentId: number; variant: "full" | "no_db" | "upload"; encrypt: boolean } | null>(null);
  const installAgent = (listQ.data ?? []).find(x => x.id === installDlg?.agentId) ?? null;
  const [pkgStatus, setPkgStatus] = useState<Record<string, { filename: string; sizeBytes: number; uploadedAt: string } | null> | null>(null);
  const [pkgBusy, setPkgBusy] = useState<string | null>(null);

  async function refreshPkgStatus(agentId: number) {
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package`, { headers });
      setPkgStatus(r.ok ? await r.json() : null);
    } catch { setPkgStatus(null); }
  }
  useEffect(() => {
    if (installDlg?.variant === "upload") void refreshPkgStatus(installDlg.agentId);
  }, [installDlg?.agentId, installDlg?.variant]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadPkg(agentId: number, kind: "backend" | "frontend" | "db", f: File) {
    setPkgBusy(kind);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}?filename=${encodeURIComponent(f.name)}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: f,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "فشل الرفع");
      toast({ title: "تم رفع الملف", description: f.name });
      await refreshPkgStatus(agentId);
    } catch (e: any) {
      toast({ title: "فشل رفع الملف", description: String(e.message ?? e), variant: "destructive" });
    } finally { setPkgBusy(null); }
  }
  async function deletePkg(agentId: number, kind: "backend" | "frontend" | "db") {
    setPkgBusy(kind);
    try {
      await fetch(`${API}/api/admin/agent-instances/${agentId}/custom-package/${kind}`, { method: "DELETE", headers });
      await refreshPkgStatus(agentId);
    } finally { setPkgBusy(null); }
  }
  const provisionAgent = (listQ.data ?? []).find(x => x.id === provisionAgentId) ?? null;
  const anyDeploying = (listQ.data ?? []).some(x => x.deployStatus === "deploying");
  // سجل حي: أثناء أي تسطيب جارٍ حدّث القائمة كل 3 ثوانٍ.
  useEffect(() => {
    if (!anyDeploying) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["agent-instances"] }), 3000);
    return () => clearInterval(t);
  }, [anyDeploying, qc]);

  async function provisionNow(a: Agent, opts: { variant: "full" | "no_db" | "upload"; encryptBundle: boolean }) {
    setBusy(`provision-${a.id}`);
    try {
      const r = await fetch(`${API}/api/admin/agent-instances/${a.id}/provision`, {
        method: "POST", headers, body: JSON.stringify(opts),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? "فشل");
      setInstallDlg(null);
      setProvisionAgentId(a.id);
      invalidate();
    } catch (e: any) {
      toast({ title: "التسطيب الكامل: فشل", description: String(e.message ?? e), variant: "destructive" });
    } finally { setBusy(null); }
  }

  function openCreate() { setForm({ ...emptyForm }); setShowForm(true); }
  function openEdit(a: Agent) {
    setForm({
      id: a.id, name: a.name, contactPhone: a.contactPhone ?? "", contactEmail: a.contactEmail ?? "",
      domain: a.domain, extraDomainsText: (a.extraDomains ?? []).join("\n"),
      mode: a.mode, maxCompanies: a.maxCompanies != null ? String(a.maxCompanies) : "",
      licenseExpiresAt: a.licenseExpiresAt ? String(a.licenseExpiresAt).slice(0, 10) : "",
      dbUrl: "", sshHost: a.sshHost ?? "", sshPort: a.sshPort != null ? String(a.sshPort) : "22",
      sshUser: a.sshUser ?? "", sshSecret: "",
      brandName: a.brandName ?? "", brandLogoUrl: a.brandLogoUrl ?? "", brandColor: a.brandColor ?? "",
      notes: a.notes ?? "",
      saUsername: a.saUsername ?? "", saEmail: a.saEmail ?? "", saPassword: "",
    });
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
            الباك اند والمنطق يبقيان مركزيين هنا.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-add-agent"><Plus className="h-4 w-4 ms-1" />وكيل جديد</Button>
      </div>

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents"><Server className="h-3.5 w-3.5 ms-1" />الوكلاء ({agents.length})</TabsTrigger>
          <TabsTrigger value="security" data-testid="tab-security-events">
            <ShieldAlert className="h-3.5 w-3.5 ms-1" />تنبيهات الأمان
            {unresolvedCount > 0 && <Badge variant="destructive" className="ms-1 h-5 px-1.5 text-[10px]">{unresolvedCount}</Badge>}
          </TabsTrigger>
        </TabsList>

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
                      <Badge variant="outline" className="text-[10px]">{a.mode === "full" ? "نسخة كاملة (مستقلة)" : a.mode === "frontend_only" ? "واجهة فقط + API مركزي" : "نسخة قشرة كاملة"}</Badge>
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
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(a)} data-testid={`button-edit-agent-${a.id}`}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-600" onClick={async () => {
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
                      : a.deployStatus === "deploying" ? <Badge variant="secondary" className="text-[10px] h-4 px-1">جارٍ…</Badge>
                      : <span className="text-muted-foreground">لم يُنشر</span>}
                    {a.lastDeployAt && <span className="text-muted-foreground ms-1">{fmtDate(a.lastDeployAt)}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.sshHost || busy === `test-ssh-${a.id}`} onClick={() => action(a.id, "test-ssh", "فحص السيرفر")}>
                      {busy === `test-ssh-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3 ms-1" />}اختبار الوصول
                    </Button>
                    <Button size="sm" className="h-7 text-xs" disabled={!a.sshHost || !a.sshSecretSet || busy === `provision-${a.id}` || a.deployStatus === "deploying"} onClick={() => setInstallDlg({ agentId: a.id, variant: "full", encrypt: false })} data-testid={`button-provision-${a.id}`}>
                      {busy === `provision-${a.id}` || a.deployStatus === "deploying" ? <Loader2 className="h-3 w-3 animate-spin ms-1" /> : <UploadCloud className="h-3 w-3 ms-1" />}تسطيب كامل
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.sshHost || !a.sshSecretSet || !a.licenseKey || busy === `deploy-${a.id}` || a.deployStatus === "deploying"} onClick={() => deployNow(a)} data-testid={`button-deploy-${a.id}`}>
                      {busy === `deploy-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3 ms-1" />}نشر
                    </Button>
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
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy === `license-${a.id}`} onClick={() => {
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
              التسطيب الكامل — {provisionAgent?.name}
              {provisionAgent?.deployStatus === "ok" && <Badge className="bg-emerald-600">اكتمل ✔</Badge>}
              {provisionAgent?.deployStatus === "error" && <Badge variant="destructive">فشل</Badge>}
            </DialogTitle>
          </DialogHeader>
          {(() => {
            const logText = provisionAgent?.deployLog || "";
            const status = provisionAgent?.deployStatus;
            // العناوين الافتراضية للخطوات الست (تُستبدل بما يصل فعليًا من السجل)
            const defaults = [
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
                    <span>{status === "ok" ? "اكتمل التسطيب بنجاح" : status === "error" ? "توقف التسطيب عند خطأ" : "جارٍ التسطيب على سيرفر الوكيل…"}</span>
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
                { v: "upload" as const, title: "تسطيب برفع ملفات", desc: "يثبّت حزمة Backend وFrontend ونسخة قاعدة بيانات ترفعها أنت بدل حزمة المنصة (النسخة الكاملة فقط، بدون تحديث تلقائي)." },
              ]).map(opt => (
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

              {installDlg.variant === "upload" && (
                <div className="border rounded-xl p-3 space-y-2 bg-muted/30">
                  <div className="text-xs font-medium">ملفات التسطيب</div>
                  {([
                    { k: "backend" as const, label: "حزمة Backend (tar.gz — يجب أن تحتوي index.mjs)", required: true, accept: ".tgz,.tar.gz,.gz" },
                    { k: "frontend" as const, label: "حزمة Frontend (tar.gz — تُفك داخل public/)", required: false, accept: ".tgz,.tar.gz,.gz" },
                    { k: "db" as const, label: "نسخة قاعدة البيانات (.sql / .sql.gz / .dump)", required: false, accept: ".sql,.gz,.dump,.backup" },
                  ]).map(row => {
                    const st = pkgStatus?.[row.k] ?? null;
                    return (
                      <div key={row.k} className="flex items-center justify-between gap-2 border rounded-lg bg-card p-2">
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium">{row.label}{row.required && <span className="text-rose-600"> *</span>}</div>
                          {st
                            ? <div className="text-[11px] text-emerald-700 truncate" dir="ltr">✓ {st.filename} ({Math.max(1, Math.round(st.sizeBytes / 1024 / 1024))}MB)</div>
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
                          {st && (
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

              <label className="flex items-center gap-2 border rounded-xl p-3 cursor-pointer text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={installDlg.encrypt}
                  onChange={e => setInstallDlg(p => p && { ...p, encrypt: e.target.checked })} data-testid="checkbox-encrypt-bundle" />
                <span>
                  إرسال الحزمة <b>مشفّرة</b> (AES-256)
                  <span className="block text-[11px] text-muted-foreground">تُنقل الحزمة مشفّرة ويفكّها سيرفر الوكيل بمفتاح يُسلَّم عبر SSH فقط.</span>
                </span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallDlg(null)}>إلغاء</Button>
            <Button
              disabled={!installAgent || busy === `provision-${installDlg?.agentId}` || (installDlg?.variant === "upload" && !pkgStatus?.backend)}
              onClick={() => installAgent && installDlg && provisionNow(installAgent, { variant: installDlg.variant, encryptBundle: installDlg.encrypt })}
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
                saveMut.mutate();
              }} disabled={saveMut.isPending} data-testid="button-save-agent">
                {saveMut.isPending && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}حفظ
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
                <Select value={form.mode} onValueChange={v => set("mode", v)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="frontend_only">واجهة فقط + API مركزي (موصى به)</SelectItem>
                    <SelectItem value="full_shell">نسخة قشرة كاملة (فرونت + باك قشرة)</SelectItem>
                    <SelectItem value="full">نسخة كاملة — تعمل بدون API المركزي (تحديث تلقائي مع كل نشر)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">أقصى عدد شركات</label><Input inputMode="numeric" dir="ltr" value={form.maxCompanies} onChange={e => set("maxCompanies", e.target.value)} /></div>
              {form.mode === "full" && (
                <div className="col-span-2 border rounded-lg p-3 bg-muted/30 space-y-3">
                  <div className="text-xs font-medium">حساب السوبر أدمن للنسخة الكاملة <span className="text-muted-foreground font-normal">— يُزرع في قاعدة بيانات الوكيل عند التسطيب ليدخل به الوكيل للوحة التحكم</span></div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="text-xs text-muted-foreground block mb-1">اسم المستخدم</label>
                      <Input dir="ltr" placeholder="admin" value={form.saUsername} onChange={e => set("saUsername", e.target.value)} data-testid="input-agent-sa-username" /></div>
                    <div><label className="text-xs text-muted-foreground block mb-1">كلمة المرور {isEdit && agents.find(x => x.id === form.id)?.saPasswordSet && <span className="opacity-70">(محفوظة — فارغ = الإبقاء)</span>}</label>
                      <Input dir="ltr" type="password" placeholder="10 أحرف فأكثر (أحرف وأرقام)" value={form.saPassword} onChange={e => set("saPassword", e.target.value)} data-testid="input-agent-sa-password" /></div>
                    <div><label className="text-xs text-muted-foreground block mb-1">إيميل استقبال OTP</label>
                      <Input dir="ltr" placeholder="owner@agent.com" value={form.saEmail} onChange={e => set("saEmail", e.target.value)} data-testid="input-agent-sa-email" /></div>
                  </div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">كلمة المرور تُحفظ مشفّرة ولا تُعرض بعد الحفظ. عند الدخول للوحة تحكم نسخة الوكيل يصل رمز التحقق (OTP) إلى هذا الإيميل. لو كانت النسخة مسطّبة بالفعل: عدّل البيانات هنا ثم أعد «تسطيب كامل» لتطبيقها.</div>
                </div>
              )}
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

            <TabsContent value="server" className="mt-3 grid grid-cols-2 gap-3">
              <div className="col-span-2 text-xs text-muted-foreground bg-muted/40 border rounded-lg p-3">
                بيانات SSH لسيرفر الوكيل — تُستخدم لاحقًا للنشر الآلي. كلمة المرور/المفتاح يُحفظ مشفّرًا ولا يُعرض.
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">Host / IP</label><Input dir="ltr" value={form.sshHost} onChange={e => set("sshHost", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المنفذ</label><Input dir="ltr" inputMode="numeric" value={form.sshPort} onChange={e => set("sshPort", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">المستخدم</label><Input dir="ltr" value={form.sshUser} onChange={e => set("sshUser", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">كلمة المرور / المفتاح</label><Input dir="ltr" type="password" placeholder={isEdit ? "اتركه فارغًا للإبقاء" : ""} value={form.sshSecret} onChange={e => set("sshSecret", e.target.value)} /></div>
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
              {saveMut.isPending && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}حفظ
            </Button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
