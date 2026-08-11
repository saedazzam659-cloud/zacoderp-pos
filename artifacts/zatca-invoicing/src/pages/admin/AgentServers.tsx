// SuperAdmin — «سيرفرات الوكلاء» (Agent Instances).
// مركز التحكم في نسخ الوكلاء: السيرفر (SSH)، قاعدة البيانات الخارجية،
// الترخيص والتعطيل الفوري، هوية الوكيل (اسم + لوجو) على صفحة دخول دومينه،
// وتنبيهات الأمان (بصمة الداتابيز، دومين غير معروف، محاولات تسجيل...).
// الأسرار (رابط الداتابيز، SSH) تُرسل للحفظ فقط ولا تُعرض بعد الحفظ.
import { useMemo, useState } from "react";
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
  HeartPulse, AlertTriangle, UploadCloud, FileDown,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

type Agent = {
  id: number; name: string; contactPhone: string | null; contactEmail: string | null;
  domain: string; extraDomains: string[] | null;
  status: "active" | "suspended"; mode: "frontend_only" | "full_shell";
  installationId: string; licenseKey: string | null; licenseExpiresAt: string | null;
  maxCompanies: number | null;
  dbUrlSet: boolean; dbStatus: string; dbLastCheckAt: string | null; dbLastError: string | null;
  sshHost: string | null; sshPort: number | null; sshUser: string | null; sshSecretSet: boolean; sshStatus: string; sshLastCheckAt: string | null;
  brandName: string | null; brandLogoUrl: string | null; brandColor: string | null;
  lastHeartbeatAt: string | null; lastSeenIp: string | null; deployedVersion: string | null;
  deployStatus: string; deployLog: string | null; lastDeployAt: string | null;
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

const emptyForm = {
  id: 0, name: "", contactPhone: "", contactEmail: "", domain: "", extraDomainsText: "",
  mode: "frontend_only", maxCompanies: "", licenseExpiresAt: "",
  dbUrl: "", sshHost: "", sshPort: "22", sshUser: "", sshSecret: "",
  brandName: "", brandLogoUrl: "", brandColor: "", notes: "",
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
  const [kitView, setKitView] = useState<{ agent: string; kit: any } | null>(null);
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
        brandName: form.brandName || null, brandLogoUrl: form.brandLogoUrl || null, brandColor: form.brandColor || null,
        sshHost: form.sshHost || null, sshPort: form.sshPort ? Number(form.sshPort) : null, sshUser: form.sshUser || null,
        notes: form.notes || null,
      };
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
                      <Badge variant="outline" className="text-[10px]">{a.mode === "frontend_only" ? "واجهة فقط + API مركزي" : "نسخة قشرة كاملة"}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1" dir="ltr">
                      <Globe className="h-3 w-3" />{a.domain}
                      {(a.extraDomains?.length ?? 0) > 0 && <span className="opacity-60">+{a.extraDomains!.length}</span>}
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
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.dbUrlSet || busy === `init-db-${a.id}`} onClick={() => {
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
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.sshHost || !a.sshSecretSet || !a.licenseKey || busy === `deploy-${a.id}`} onClick={() => deployNow(a)} data-testid={`button-deploy-${a.id}`}>
                      {busy === `deploy-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3 ms-1" />}نشر
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!a.licenseKey || busy === `kit-${a.id}`} onClick={() => openSetupKit(a)} data-testid={`button-kit-${a.id}`}>
                      {busy === `kit-${a.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3 ms-1" />}حزمة التهيئة
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

      {/* ── نموذج إضافة/تعديل ── */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{isEdit ? `تعديل — ${form.name}` : "وكيل جديد"}</DialogTitle></DialogHeader>
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
                  </SelectContent>
                </Select>
              </div>
              <div><label className="text-xs text-muted-foreground block mb-1">أقصى عدد شركات</label><Input inputMode="numeric" dir="ltr" value={form.maxCompanies} onChange={e => set("maxCompanies", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground block mb-1">انتهاء الترخيص</label><DateField value={form.licenseExpiresAt} onChange={v => set("licenseExpiresAt", v)} /></div>
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
              <div><label className="text-xs text-muted-foreground block mb-1">لون أساسي (اختياري)</label><Input dir="ltr" placeholder="#0f766e" value={form.brandColor} onChange={e => set("brandColor", e.target.value)} /></div>
              <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">رابط اللوجو</label><Input dir="ltr" placeholder="https://..." value={form.brandLogoUrl} onChange={e => set("brandLogoUrl", e.target.value)} /></div>
              {form.brandLogoUrl && <img src={form.brandLogoUrl} alt="" className="h-16 rounded border bg-white object-contain p-1" />}
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!form.name.trim() || !form.domain.trim()) { toast({ title: "الاسم والدومين مطلوبان", variant: "destructive" }); return; }
              saveMut.mutate();
            }} disabled={saveMut.isPending} data-testid="button-save-agent">
              {saveMut.isPending && <Loader2 className="h-4 w-4 ms-1 animate-spin" />}حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
