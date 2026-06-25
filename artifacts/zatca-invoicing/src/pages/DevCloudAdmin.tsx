import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Cloud, PlusCircle, RefreshCw, Building2, Trash2, X, Search, ChevronRight,
  Users, Rocket, Server, GitBranch, Database, FlaskConical, Ban, CheckCircle2,
  PlayCircle, ShieldCheck,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin Developer Cloud (Workspaces) — Phase 5.
//
// Each partner COMPANY gets one isolated workspace (sandbox + git + storage +
// test env) on a managed provider, multi-role developer seats with
// least-privilege permissions, and Publish-engine-only deployments. Every call
// hits /api/admin/dev-cloud/* (self-guarded by requireSuperAdmin server-side).
// No server credentials / SSH / RDP / DB access is ever stored or shown.
// ─────────────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending:      { label: "بانتظار التهيئة", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  provisioning: { label: "جارٍ التهيئة",     cls: "bg-sky-50 text-sky-700 border-sky-200" },
  active:       { label: "نشطة",            cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  suspended:    { label: "موقوفة",          cls: "bg-orange-50 text-orange-700 border-orange-200" },
  archived:     { label: "مؤرشفة",          cls: "bg-zinc-100 text-zinc-600 border-zinc-300" },
  error:        { label: "خطأ",             cls: "bg-red-50 text-red-700 border-red-200" },
};

const ROLE_LABELS: Record<string, string> = {
  pm: "مدير مشروع", backend: "خلفية", frontend: "واجهة", mobile: "جوال", qa: "اختبار", devops: "DevOps",
};

const PERMISSION_LABELS: { key: string; label: string }[] = [
  { key: "edit_code", label: "تعديل الكود" },
  { key: "run_sandbox", label: "تشغيل البيئة" },
  { key: "manage_git", label: "إدارة Git" },
  { key: "manage_storage", label: "إدارة التخزين" },
  { key: "run_tests", label: "تشغيل الاختبارات" },
  { key: "trigger_publish", label: "النشر (محرك النشر)" },
  { key: "manage_seats", label: "إدارة المقاعد" },
  { key: "view_logs", label: "عرض السجلّات" },
];

const DEPLOY_STATUS_META: Record<string, { label: string; cls: string }> = {
  queued:    { label: "في الطابور", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  building:  { label: "قيد البناء",  cls: "bg-sky-50 text-sky-700 border-sky-200" },
  published: { label: "منشور",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed:    { label: "فشل",        cls: "bg-red-50 text-red-700 border-red-200" },
};

const PROVIDER_LABELS: Record<string, string> = {
  replit: "Replit", codesandbox: "CodeSandbox", gitpod: "Gitpod", github_codespaces: "GitHub Codespaces",
};

function StatusPill({ s }: { s: string }) {
  const m = STATUS_META[s] ?? { label: s, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", m.cls)}>{m.label}</span>;
}

const emptyWs = { companyId: 0, provider: "replit", region: "", tier: "standard", notes: "" };
const emptySeat = { name: "", email: "", role: "backend", permissions: {} as Record<string, boolean> };

export default function DevCloudAdmin() {
  const { token } = useAuth() as any;
  const qc = useQueryClient();
  const { toast } = useToast();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyWs });
  const [companySearch, setCompanySearch] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["dev-cloud"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const workspaces = data?.workspaces ?? [];

  const { data: avail } = useQuery({
    queryKey: ["dev-cloud-available", companySearch],
    enabled: showCreate,
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud/companies/available?search=${encodeURIComponent(companySearch)}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud`, { method: "POST", headers, body: JSON.stringify(form) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإنشاء"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إنشاء مساحة العمل" }); setShowCreate(false); setForm({ ...emptyWs }); qc.invalidateQueries({ queryKey: ["dev-cloud"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الحذف"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم الحذف" }); setDetailId(null); qc.invalidateQueries({ queryKey: ["dev-cloud"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6" dir="rtl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <Cloud className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">سحابة المطورين</h1>
            <p className="text-sm text-slate-500">مساحة عمل معزولة لكل شركة شريكة + مقاعد فرق التطوير + النشر عبر محرك النشر فقط</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
          <Button onClick={() => { setForm({ ...emptyWs }); setCompanySearch(""); setShowCreate(true); }}>
            <PlusCircle className="ml-1 h-4 w-4" /> مساحة عمل جديدة
          </Button>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>لا يتم تخزين أو عرض أي بيانات اعتماد للخوادم أو SSH أو RDP أو الوصول المباشر لقاعدة البيانات. النشر يتم حصراً عبر محرك النشر.</span>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          لا توجد مساحات عمل بعد. أنشئ أول مساحة عمل لشركة شريكة.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-3 text-right font-medium">الشركة</th>
                <th className="p-3 text-right font-medium">المزوّد</th>
                <th className="p-3 text-right font-medium">الحالة</th>
                <th className="p-3 text-center font-medium">المقاعد</th>
                <th className="p-3 text-center font-medium">عمليات النشر</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {workspaces.map((w: any) => (
                <tr key={w.id} className="hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-medium text-slate-800">{w.companyNameAr ?? w.companyNameEn ?? `#${w.companyId}`}</div>
                    {w.companyCode && <div className="text-xs text-slate-400">{w.companyCode}</div>}
                  </td>
                  <td className="p-3 text-slate-600">{PROVIDER_LABELS[w.provider] ?? w.provider}</td>
                  <td className="p-3"><StatusPill s={w.status} /></td>
                  <td className="p-3 text-center text-slate-600">{w.seatCount}</td>
                  <td className="p-3 text-center text-slate-600">{w.deploymentCount}</td>
                  <td className="p-3 text-left">
                    <Button variant="ghost" size="sm" onClick={() => setDetailId(w.id)}>
                      التفاصيل <ChevronRight className="mr-1 h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-800">مساحة عمل جديدة</h2>
              <button onClick={() => setShowCreate(false)}><X className="h-5 w-5 text-slate-400" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <Label>الشركة الشريكة</Label>
                <div className="relative mt-1">
                  <Search className="absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
                  <Input className="pr-8" placeholder="بحث عن شركة…" value={companySearch} onChange={(e) => setCompanySearch(e.target.value)} />
                </div>
                <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200">
                  {(avail?.companies ?? []).map((c: any) => (
                    <button key={c.id} onClick={() => setForm((f) => ({ ...f, companyId: c.id }))}
                      className={cn("flex w-full items-center gap-2 px-3 py-2 text-right text-sm hover:bg-slate-50",
                        form.companyId === c.id && "bg-indigo-50")}>
                      <Building2 className="h-4 w-4 text-slate-400" />
                      <span className="flex-1">{c.nameAr ?? c.nameEn}</span>
                      {form.companyId === c.id && <CheckCircle2 className="h-4 w-4 text-indigo-600" />}
                    </button>
                  ))}
                  {(avail?.companies ?? []).length === 0 && <div className="px-3 py-4 text-center text-xs text-slate-400">لا توجد شركات متاحة</div>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>المزوّد</Label>
                  <select className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                    value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}>
                    {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <Label>المنطقة</Label>
                  <Input className="mt-1" value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} placeholder="me-central-1" />
                </div>
              </div>
              <div>
                <Label>ملاحظات</Label>
                <Input className="mt-1" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>إلغاء</Button>
              <Button disabled={!form.companyId || create.isPending} onClick={() => create.mutate()}>إنشاء</Button>
            </div>
          </div>
        </div>
      )}

      {detailId != null && (
        <WorkspaceDetail id={detailId} headers={headers} onClose={() => setDetailId(null)}
          onDelete={() => del.mutate(detailId)} meta={data?.meta} />
      )}
    </div>
  );
}

function WorkspaceDetail({ id, headers, onClose, onDelete, meta }: {
  id: number; headers: any; onClose: () => void; onDelete: () => void; meta: any;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [seatForm, setSeatForm] = useState({ ...emptySeat });
  const [showSeat, setShowSeat] = useState(false);
  const [deployForm, setDeployForm] = useState({ environment: "test", ref: "", seatId: "", notes: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["dev-cloud", id],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const ws = data?.workspace;
  const seats = data?.seats ?? [];
  const deployments = data?.deployments ?? [];
  const roleDefaults: Record<string, string[]> = meta?.roleDefaults ?? {};

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["dev-cloud", id] }); qc.invalidateQueries({ queryKey: ["dev-cloud"] }); };

  const provision = useMutation({
    mutationFn: async (body: any) => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/provision`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تحديث التهيئة" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: async (to: string) => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/status`, { method: "POST", headers, body: JSON.stringify({ to }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تحديث الحالة" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const addSeat = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/seats`, { method: "POST", headers, body: JSON.stringify(seatForm) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تمت إضافة المقعد" }); setShowSeat(false); setSeatForm({ ...emptySeat }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const updateSeat = useMutation({
    mutationFn: async ({ seatId, body }: { seatId: number; body: any }) => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/seats/${seatId}`, { method: "PUT", headers, body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const delSeat = useMutation({
    mutationFn: async (seatId: number) => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/seats/${seatId}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم حذف المقعد" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deploy = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/dev-cloud/${id}/deployments`, { method: "POST", headers, body: JSON.stringify(deployForm) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إنشاء طلب النشر عبر محرك النشر" }); setDeployForm({ environment: "test", ref: "", seatId: "", notes: "" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-start bg-black/40" onClick={onClose} dir="rtl">
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-slate-50 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {isLoading || !ws ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-800">{ws.companyNameAr ?? ws.companyNameEn ?? `#${ws.companyId}`}</h2>
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                  <StatusPill s={ws.status} />
                  <span>{PROVIDER_LABELS[ws.provider] ?? ws.provider}</span>
                  {ws.region && <span>· {ws.region}</span>}
                </div>
              </div>
              <button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button>
            </div>

            {/* Isolated resources */}
            <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 font-semibold text-slate-700"><Server className="h-4 w-4" /> الموارد المعزولة</h3>
                <div className="flex gap-2">
                  {ws.status !== "archived" && (
                    <Button size="sm" variant="outline" onClick={() => provision.mutate({
                      sandboxId: ws.sandboxId, gitRepoUrl: ws.gitRepoUrl, storageBucket: ws.storageBucket, testEnvUrl: ws.testEnvUrl,
                    })}>
                      <PlayCircle className="ml-1 h-4 w-4" /> تأكيد التهيئة
                    </Button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ResourceField icon={<FlaskConical className="h-4 w-4" />} label="معرّف البيئة (Sandbox)"
                  value={ws.sandboxId} onSave={(v) => provision.mutate({ sandboxId: v })} />
                <ResourceField icon={<GitBranch className="h-4 w-4" />} label="مستودع Git"
                  value={ws.gitRepoUrl} onSave={(v) => provision.mutate({ gitRepoUrl: v })} />
                <ResourceField icon={<Database className="h-4 w-4" />} label="حاوية التخزين"
                  value={ws.storageBucket} onSave={(v) => provision.mutate({ storageBucket: v })} />
                <ResourceField icon={<FlaskConical className="h-4 w-4" />} label="بيئة الاختبار"
                  value={ws.testEnvUrl} onSave={(v) => provision.mutate({ testEnvUrl: v })} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {ws.status === "active" && <Button size="sm" variant="outline" onClick={() => setStatus.mutate("suspended")}><Ban className="ml-1 h-4 w-4" /> إيقاف</Button>}
                {ws.status === "suspended" && <Button size="sm" variant="outline" onClick={() => setStatus.mutate("active")}><CheckCircle2 className="ml-1 h-4 w-4" /> تفعيل</Button>}
                {ws.status !== "archived" && <Button size="sm" variant="outline" onClick={() => setStatus.mutate("archived")}>أرشفة</Button>}
                <Button size="sm" variant="outline" className="text-red-600" onClick={onDelete}><Trash2 className="ml-1 h-4 w-4" /> حذف المساحة</Button>
              </div>
            </div>

            {/* Seats */}
            <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 font-semibold text-slate-700"><Users className="h-4 w-4" /> مقاعد فريق التطوير</h3>
                <Button size="sm" onClick={() => { setSeatForm({ ...emptySeat }); setShowSeat(true); }}><PlusCircle className="ml-1 h-4 w-4" /> مقعد</Button>
              </div>
              {seats.length === 0 ? (
                <div className="py-4 text-center text-sm text-slate-400">لا توجد مقاعد</div>
              ) : (
                <div className="space-y-2">
                  {seats.map((s: any) => (
                    <div key={s.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-slate-800">{s.name}</span>
                          <span className="mr-2 text-xs text-slate-400">{s.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <select className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                            value={s.role} onChange={(e) => updateSeat.mutate({ seatId: s.id, body: { role: e.target.value } })}>
                            {(meta?.roles ?? Object.keys(ROLE_LABELS)).map((r: string) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
                          </select>
                          <button onClick={() => updateSeat.mutate({ seatId: s.id, body: { status: s.status === "active" ? "suspended" : "active" } })}
                            className={cn("rounded-full border px-2 py-0.5 text-xs", s.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-orange-200 bg-orange-50 text-orange-700")}>
                            {s.status === "active" ? "نشط" : "موقوف"}
                          </button>
                          <button onClick={() => delSeat.mutate(s.id)}><Trash2 className="h-4 w-4 text-red-400" /></button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {PERMISSION_LABELS.filter((p) => s.permissions?.[p.key]).map((p) => (
                          <span key={p.key} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{p.label}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Deployments */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-700"><Rocket className="h-4 w-4" /> النشر (عبر محرك النشر فقط)</h3>
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
                <select className="rounded-md border border-slate-300 px-2 py-2 text-sm"
                  value={deployForm.environment} onChange={(e) => setDeployForm((f) => ({ ...f, environment: e.target.value }))}>
                  <option value="test">بيئة الاختبار</option>
                  <option value="production">الإنتاج</option>
                </select>
                <Input placeholder="المرجع/الإصدار" value={deployForm.ref} onChange={(e) => setDeployForm((f) => ({ ...f, ref: e.target.value }))} />
                <select className="rounded-md border border-slate-300 px-2 py-2 text-sm"
                  value={deployForm.seatId} onChange={(e) => setDeployForm((f) => ({ ...f, seatId: e.target.value }))}>
                  <option value="">— المقعد المُطلِق —</option>
                  {seats.filter((s: any) => s.permissions?.trigger_publish && s.status === "active").map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <Button disabled={ws.status !== "active" || deploy.isPending} onClick={() => deploy.mutate()}>
                  <Rocket className="ml-1 h-4 w-4" /> نشر
                </Button>
              </div>
              {ws.status !== "active" && <p className="mb-2 text-xs text-amber-600">يجب أن تكون مساحة العمل نشطة قبل النشر.</p>}
              {deployments.length === 0 ? (
                <div className="py-3 text-center text-sm text-slate-400">لا توجد عمليات نشر</div>
              ) : (
                <div className="space-y-1.5">
                  {deployments.map((d: any) => {
                    const m = DEPLOY_STATUS_META[d.status] ?? { label: d.status, cls: "" };
                    return (
                      <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", m.cls)}>{m.label}</span>
                          <span className="text-slate-600">{d.environment === "production" ? "الإنتاج" : "الاختبار"}</span>
                          {d.ref && <span className="text-xs text-slate-400">{d.ref}</span>}
                        </div>
                        <span className="text-[11px] text-slate-400">{new Date(d.createdAt).toLocaleString("ar")}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {showSeat && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowSeat(false)}>
            <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-800">مقعد مطوّر جديد</h2>
                <button onClick={() => setShowSeat(false)}><X className="h-5 w-5 text-slate-400" /></button>
              </div>
              <div className="space-y-3">
                <div><Label>الاسم</Label><Input className="mt-1" value={seatForm.name} onChange={(e) => setSeatForm((f) => ({ ...f, name: e.target.value }))} /></div>
                <div><Label>البريد الإلكتروني</Label><Input className="mt-1" type="email" value={seatForm.email} onChange={(e) => setSeatForm((f) => ({ ...f, email: e.target.value }))} /></div>
                <div>
                  <Label>الدور</Label>
                  <select className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                    value={seatForm.role}
                    onChange={(e) => {
                      const role = e.target.value;
                      const defaults = roleDefaults[role] ?? [];
                      const perms: Record<string, boolean> = {};
                      for (const k of defaults) perms[k] = true;
                      setSeatForm((f) => ({ ...f, role, permissions: perms }));
                    }}>
                    {(meta?.roles ?? Object.keys(ROLE_LABELS)).map((r: string) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
                  </select>
                  <p className="mt-1 text-xs text-slate-400">يُطبَّق الحد الأدنى من الصلاحيات للدور تلقائياً — يمكنك التعديل أدناه.</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {PERMISSION_LABELS.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={!!seatForm.permissions[p.key]}
                        onCheckedChange={(v) => setSeatForm((f) => ({ ...f, permissions: { ...f.permissions, [p.key]: !!v } }))} />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowSeat(false)}>إلغاء</Button>
                <Button disabled={!seatForm.name || !seatForm.email || addSeat.isPending} onClick={() => addSeat.mutate()}>إضافة</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceField({ icon, label, value, onSave }: {
  icon: React.ReactNode; label: string; value: string | null; onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-500">{icon} {label}</div>
      {editing ? (
        <div className="flex gap-1">
          <Input className="h-8 text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <Button size="sm" className="h-8" onClick={() => { onSave(draft.trim()); setEditing(false); }}>حفظ</Button>
        </div>
      ) : (
        <button className="block w-full truncate text-right text-sm text-slate-700 hover:text-indigo-600"
          onClick={() => { setDraft(value ?? ""); setEditing(true); }}>
          {value || <span className="text-slate-300">— انقر للإضافة —</span>}
        </button>
      )}
    </div>
  );
}
