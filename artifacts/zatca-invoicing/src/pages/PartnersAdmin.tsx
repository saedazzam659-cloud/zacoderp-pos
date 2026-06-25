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
  Boxes, PlusCircle, RefreshCw, Building2, Trash2, X, Link2, Unlink, Search,
  Pencil, ChevronRight, BadgeCheck, FileText, Wallet, Ban, CheckCircle2,
  UploadCloud, ShieldCheck, Sparkles, Package, PenTool, Activity, Loader2,
  AlertTriangle, Hammer, Rocket,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin Developer & Partner Control Center — Phase 1.
//
// Platform-level: onboard developers (extension builders) & partners
// (resellers/integrators) through a governed lifecycle, issue a Partner ID on
// approval, link the companies each serves, and track Zacode commissions.
// Every call hits /api/admin/partners/* (self-guarded by requireSuperAdmin
// server side). Strictly additive — touches only the new partner_* tables and
// READS the reseller network for the consolidated commissions report.
// ─────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = { developer: "مطوّر", partner: "شريك", agent: "وكيل" };

const STATUS_FLOW = ["draft", "documents", "identity_check", "fees", "security_review", "approved"];
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:           { label: "مسجّل",            cls: "bg-slate-50 text-slate-600 border-slate-200" },
  documents:       { label: "المستندات",        cls: "bg-sky-50 text-sky-700 border-sky-200" },
  identity_check:  { label: "التحقق من الهوية",  cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  fees:            { label: "الرسوم",           cls: "bg-amber-50 text-amber-700 border-amber-200" },
  security_review: { label: "المراجعة الأمنية",  cls: "bg-violet-50 text-violet-700 border-violet-200" },
  approved:        { label: "معتمد",            cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  suspended:       { label: "موقوف",            cls: "bg-orange-50 text-orange-700 border-orange-200" },
  rejected:        { label: "مرفوض",            cls: "bg-red-50 text-red-700 border-red-200" },
};

const PERMISSION_LABELS: { key: string; label: string }[] = [
  { key: "publish_extensions", label: "نشر الإضافات" },
  { key: "manage_listings", label: "إدارة العروض" },
  { key: "sell_apps", label: "بيع التطبيقات (عمولة)" },
  { key: "view_reports", label: "عرض التقارير" },
  { key: "support", label: "الدعم" },
];

const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  pending:  { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  verified: { label: "موثّق",        cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "مرفوض",        cls: "bg-red-50 text-red-700 border-red-200" },
};

function fmtMoney(v: any): string {
  return Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const emptyForm = {
  kind: "developer", nameAr: "", nameEn: "", contactName: "", phone: "", email: "",
  address: "", website: "", commissionRate: "10",
  permissions: { view_reports: true, support: true } as Record<string, boolean>,
};

function StatusPill({ s }: { s: string }) {
  const m = STATUS_META[s] ?? { label: s, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", m.cls)}>{m.label}</span>;
}

export default function PartnersAdmin() {
  const { token } = useAuth() as any;
  const qc = useQueryClient();
  const { toast } = useToast();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);

  const [tab, setTab] = useState<"developer" | "partner" | "publish" | "report">("developer");
  const isPartnerList = tab === "developer" || tab === "partner";
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-partners", tab],
    enabled: isPartnerList,
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/partners?kind=${tab}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const partners = data?.partners ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/partners`, { method: "POST", headers, body: JSON.stringify(form) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإنشاء"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إنشاء الكيان" }); setShowCreate(false); setForm({ ...emptyForm }); qc.invalidateQueries({ queryKey: ["admin-partners"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/partners/${id}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الحذف"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["admin-partners"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const advance = useMutation({
    mutationFn: async ({ id, to }: { id: number; to?: string }) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/advance`, { method: "POST", headers, body: JSON.stringify(to ? { to } : {}) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تحديث الحالة" }); qc.invalidateQueries({ queryKey: ["admin-partners"] }); qc.invalidateQueries({ queryKey: ["admin-partner"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const setField = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const togglePerm = (k: string) => setForm((f) => ({ ...f, permissions: { ...f.permissions, [k]: !f.permissions[k] } }));

  return (
    <div dir="rtl" className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Boxes className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">مركز المطوّرين والشركاء</h1>
            <p className="text-sm text-slate-500">إدارة دورة حياة المطوّرين والشركاء وإصدار معرّفات الشراكة وتتبّع العمولات</p>
          </div>
        </div>
        <div className="flex gap-2">
          {isPartnerList && <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2"><RefreshCw className="h-4 w-4" /> تحديث</Button>}
          {isPartnerList && <Button size="sm" onClick={() => { setForm({ ...emptyForm, kind: tab }); setShowCreate(true); }} className="gap-2" data-testid="button-add-partner"><PlusCircle className="h-4 w-4" /> {tab === "partner" ? "شريك جديد" : "مطوّر جديد"}</Button>}
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {([["developer", "المطوّرون"], ["partner", "الشركاء"], ["publish", "النشر"], ["report", "تقرير العمولات"]] as [typeof tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`tab-${k}`}
            className={cn("px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === k ? "border-primary text-primary" : "border-transparent text-slate-500 hover:text-slate-700")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "report" ? <CommissionsReport headers={headers} /> : tab === "publish" ? <PublishCenter headers={headers} /> : (isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : partners.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا يوجد {tab === "partner" ? "شركاء" : "مطوّرون"} بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">معرّف الشراكة</th>
                <th className="px-3 py-2 text-right font-medium">الاسم</th>
                <th className="px-3 py-2 text-right font-medium">النسبة</th>
                <th className="px-3 py-2 text-right font-medium">الشركات</th>
                <th className="px-3 py-2 text-right font-medium">إجمالي العمولات</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {partners.map((r: any) => (
                <tr key={r.id} data-testid={`row-partner-${r.id}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.partnerCode ?? "—"}</td>
                  <td className="px-3 py-2 font-medium">{r.nameAr}</td>
                  <td className="px-3 py-2 tabular-nums">{r.commissionRate}%</td>
                  <td className="px-3 py-2 tabular-nums"><span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-slate-400" />{r.companyCount}</span></td>
                  <td className="px-3 py-2 tabular-nums text-emerald-700">{fmtMoney(r.commissionTotal)}</td>
                  <td className="px-3 py-2"><StatusPill s={r.status} /></td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {STATUS_FLOW.includes(r.status) && r.status !== "approved" && (
                        <Button size="sm" variant="outline" className="gap-1 text-primary" onClick={() => advance.mutate({ id: r.id })} disabled={advance.isPending} data-testid={`button-advance-${r.id}`}>
                          <ChevronRight className="h-3.5 w-3.5" /> تقديم
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => setDetailId(r.id)} data-testid={`button-manage-${r.id}`}>
                        <Pencil className="h-3.5 w-3.5" /> إدارة
                      </Button>
                      <Button size="sm" variant="outline" className="text-red-600" onClick={() => { if (confirm(`حذف ${r.nameAr}؟`)) del.mutate(r.id); }} data-testid={`button-delete-${r.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {showCreate && (
        <Modal title={form.kind === "partner" ? "شريك جديد" : "مطوّر جديد"} onClose={() => setShowCreate(false)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>النوع</Label>
              <select value={form.kind} onChange={(e) => setField("kind", e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="select-kind">
                <option value="developer">مطوّر</option>
                <option value="partner">شريك</option>
              </select></div>
            {([
              ["nameAr", "الاسم (عربي) *"], ["nameEn", "الاسم (إنجليزي)"], ["contactName", "اسم جهة الاتصال"],
              ["phone", "الهاتف"], ["email", "البريد"], ["website", "الموقع"], ["address", "العنوان"],
            ] as [string, string][]).map(([k, label]) => (
              <div key={k}><Label>{label}</Label>
                <Input value={(form as any)[k]} onChange={(e) => setField(k, e.target.value)} className="mt-1" data-testid={`input-${k}`} /></div>
            ))}
            <div><Label>نسبة العمولة (%)</Label>
              <Input type="number" step="0.001" value={form.commissionRate} onChange={(e) => setField("commissionRate", e.target.value)} className="mt-1" data-testid="input-commissionRate" /></div>
          </div>
          <div className="mt-4">
            <Label className="mb-2 block">الصلاحيات</Label>
            <div className="grid grid-cols-2 gap-2">
              {PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={form.permissions[p.key] === true} onCheckedChange={() => togglePerm(p.key)} data-testid={`perm-${p.key}`} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mt-5">
            <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-save-partner">حفظ</Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>إلغاء</Button>
          </div>
        </Modal>
      )}

      {detailId != null && <PartnerDetail id={detailId} headers={headers} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-auto p-6" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Onboarding lifecycle stepper ───────────────────────────────────────────
function Lifecycle({ status, onAdvance, onSet, busy }: { status: string; onAdvance: () => void; onSet: (s: string) => void; busy: boolean }) {
  const idx = STATUS_FLOW.indexOf(status);
  const terminal = status === "suspended" || status === "rejected";
  return (
    <div className="rounded-xl border bg-slate-50/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FLOW.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
              !terminal && i <= idx ? STATUS_META[s].cls : "bg-white text-slate-400 border-slate-200")}>
              {!terminal && i < idx && <CheckCircle2 className="h-3 w-3" />}{STATUS_META[s].label}
            </span>
            {i < STATUS_FLOW.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
          </div>
        ))}
      </div>
      {terminal && <div><StatusPill s={status} /></div>}
      <div className="flex flex-wrap gap-2">
        {STATUS_FLOW.includes(status) && status !== "approved" && (
          <Button size="sm" onClick={onAdvance} disabled={busy} className="gap-1" data-testid="button-detail-advance">
            <ChevronRight className="h-4 w-4" /> تقديم للمرحلة التالية
          </Button>
        )}
        {status !== "suspended" && status !== "rejected" && (
          <>
            <Button size="sm" variant="outline" className="text-orange-600 gap-1" onClick={() => onSet("suspended")} disabled={busy} data-testid="button-suspend">
              <Ban className="h-4 w-4" /> إيقاف
            </Button>
            {status !== "approved" && (
              <Button size="sm" variant="outline" className="text-red-600" onClick={() => onSet("rejected")} disabled={busy} data-testid="button-reject">رفض</Button>
            )}
          </>
        )}
        {(status === "suspended" || status === "rejected") && (
          <Button size="sm" variant="outline" className="text-emerald-600 gap-1" onClick={() => onSet("approved")} disabled={busy} data-testid="button-reactivate">
            <BadgeCheck className="h-4 w-4" /> إعادة التفعيل
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Detail / manage panel ──────────────────────────────────────────────────
function PartnerDetail({ id, headers, onClose }: { id: number; headers: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [docForm, setDocForm] = useState({ docType: "", title: "", fileUrl: "" });
  const [comForm, setComForm] = useState({ eventType: "app_sale", baseAmount: "", commissionRate: "", description: "", extensionId: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["admin-partner", id],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/${id}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const { data: avail } = useQuery({
    queryKey: ["admin-partner-available", id, search],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/${id}/companies/available?search=${encodeURIComponent(search)}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const partner = data?.partner;
  const [rate, setRate] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);
  const effRate = rate ?? partner?.commissionRate ?? "0";
  const effPerms = perms ?? partner?.permissions ?? {};

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-partner", id] });
    qc.invalidateQueries({ queryKey: ["admin-partners"] });
  };
  const mut = (fn: () => Promise<Response>, okMsg?: string, after?: () => void) => async () => {
    const r = await fn();
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast({ title: "خطأ", description: d?.error ?? "فشل", variant: "destructive" }); return; }
    if (okMsg) toast({ title: okMsg });
    after?.();
    invalidate();
  };

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/${id}`, { method: "PUT", headers, body: JSON.stringify({ commissionRate: effRate, permissions: effPerms }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم الحفظ" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const advance = useMutation({
    mutationFn: async (to?: string) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/advance`, { method: "POST", headers, body: JSON.stringify(to ? { to } : {}) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تحديث الحالة" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const link = useMutation({
    mutationFn: async (companyId: number) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/companies`, { method: "POST", headers, body: JSON.stringify({ companyId }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الربط"); }
      return r.json();
    },
    onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ["admin-partner-available"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const unlink = useMutation({
    mutationFn: async (companyId: number) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/companies/${companyId}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ["admin-partner-available"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const addDoc = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/${id}/documents`, { method: "POST", headers, body: JSON.stringify(docForm) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تمت إضافة المستند" }); setDocForm({ docType: "", title: "", fileUrl: "" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const reviewDoc = useMutation({
    mutationFn: async ({ docId, status }: { docId: number; status: string }) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/documents/${docId}`, { method: "PUT", headers, body: JSON.stringify({ status }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const delDoc = useMutation({
    mutationFn: async (docId: number) => {
      const r = await fetch(`${API}/api/admin/partners/${id}/documents/${docId}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const accrue = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/${id}/commissions`, { method: "POST", headers, body: JSON.stringify(comForm) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تسجيل العمولة" }); setComForm({ eventType: "app_sale", baseAmount: "", commissionRate: "", description: "", extensionId: "" }); invalidate(); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const busy = advance.isPending || save.isPending;

  return (
    <Modal title={isLoading ? "…" : `إدارة: ${partner?.nameAr ?? ""} ${partner?.partnerCode ? `(${partner.partnerCode})` : ""}`} onClose={onClose}>
      {isLoading || !partner ? <Skeleton className="h-40 w-full" /> : (
        <div className="space-y-5">
          <Lifecycle status={partner.status} busy={busy} onAdvance={() => advance.mutate(undefined)} onSet={(s) => advance.mutate(s)} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>نسبة العمولة (%)</Label>
              <Input type="number" step="0.001" value={effRate} onChange={(e) => setRate(e.target.value)} className="mt-1" data-testid="input-edit-rate" /></div>
          </div>
          <div>
            <Label className="mb-2 block">الصلاحيات</Label>
            <div className="grid grid-cols-2 gap-2">
              {PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={effPerms[p.key] === true}
                    onCheckedChange={() => setPerms({ ...effPerms, [p.key]: !(effPerms[p.key] === true) })} data-testid={`edit-perm-${p.key}`} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-detail">حفظ التعديلات</Button>

          {/* Documents */}
          <div className="border-t pt-4">
            <Label className="mb-2 block flex items-center gap-1"><FileText className="h-4 w-4" /> المستندات ({data?.documents?.length ?? 0})</Label>
            <div className="space-y-1 mb-3">
              {(data?.documents ?? []).map((dc: any) => {
                const m = DOC_STATUS[dc.status] ?? DOC_STATUS.pending;
                return (
                  <div key={dc.id} className="flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm" data-testid={`doc-${dc.id}`}>
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{dc.docType}</span>
                      {dc.title && <span className="text-xs text-slate-400">{dc.title}</span>}
                      {dc.fileUrl && <a href={dc.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline">عرض</a>}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs", m.cls)}>{m.label}</span>
                      {dc.status !== "verified" && <Button size="sm" variant="ghost" className="h-7 text-emerald-600" onClick={() => reviewDoc.mutate({ docId: dc.id, status: "verified" })}>توثيق</Button>}
                      {dc.status !== "rejected" && <Button size="sm" variant="ghost" className="h-7 text-red-600" onClick={() => reviewDoc.mutate({ docId: dc.id, status: "rejected" })}>رفض</Button>}
                      <Button size="sm" variant="ghost" className="h-7 text-slate-400" onClick={() => delDoc.mutate(dc.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </span>
                  </div>
                );
              })}
              {(data?.documents ?? []).length === 0 && <p className="text-xs text-slate-400">لا توجد مستندات</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input value={docForm.docType} onChange={(e) => setDocForm((s) => ({ ...s, docType: e.target.value }))} placeholder="نوع المستند *" data-testid="input-doc-type" />
              <Input value={docForm.title} onChange={(e) => setDocForm((s) => ({ ...s, title: e.target.value }))} placeholder="العنوان" />
              <div className="flex gap-2">
                <Input value={docForm.fileUrl} onChange={(e) => setDocForm((s) => ({ ...s, fileUrl: e.target.value }))} placeholder="رابط الملف" />
                <Button size="sm" onClick={() => addDoc.mutate()} disabled={addDoc.isPending || !docForm.docType.trim()} data-testid="button-add-doc">إضافة</Button>
              </div>
            </div>
          </div>

          {/* Linked companies */}
          <div className="border-t pt-4">
            <Label className="mb-2 block flex items-center gap-1"><Building2 className="h-4 w-4" /> الشركات المرتبطة ({data?.companies?.length ?? 0})</Label>
            <div className="space-y-1 mb-3">
              {(data?.companies ?? []).map((c: any) => (
                <div key={c.companyId} className="flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm" data-testid={`linked-${c.companyId}`}>
                  <span>{c.nameAr} <span className="text-xs text-slate-400 font-mono">{c.code}</span></span>
                  <Button size="sm" variant="ghost" className="text-red-600 h-7 gap-1" onClick={() => unlink.mutate(c.companyId)}>
                    <Unlink className="h-3.5 w-3.5" /> فك
                  </Button>
                </div>
              ))}
              {(data?.companies ?? []).length === 0 && <p className="text-xs text-slate-400">لا توجد شركات مرتبطة</p>}
            </div>
            <Label className="mb-1 block flex items-center gap-1"><Link2 className="h-4 w-4" /> ربط شركة</Label>
            <div className="relative mb-2">
              <Search className="absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الكود…" className="pr-8" data-testid="input-search-company" />
            </div>
            <div className="max-h-40 overflow-auto space-y-1">
              {(avail?.companies ?? []).map((c: any) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm" data-testid={`available-${c.id}`}>
                  <span>{c.nameAr} <span className="text-xs text-slate-400 font-mono">{c.code}</span></span>
                  <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => link.mutate(c.id)} disabled={link.isPending}>
                    <Link2 className="h-3.5 w-3.5" /> ربط
                  </Button>
                </div>
              ))}
              {(avail?.companies ?? []).length === 0 && <p className="text-xs text-slate-400">لا توجد شركات متاحة</p>}
            </div>
          </div>

          {/* Commission ledger + manual accrue */}
          <div className="border-t pt-4">
            <Label className="mb-2 block flex items-center gap-1"><Wallet className="h-4 w-4" /> سجل العمولات ({data?.commissions?.length ?? 0})</Label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
              <select value={comForm.eventType} onChange={(e) => setComForm((s) => ({ ...s, eventType: e.target.value }))} className="rounded-md border border-input bg-background px-2 py-2 text-sm" data-testid="select-event-type">
                <option value="app_sale">بيع تطبيق</option>
                <option value="app_renewal">تجديد تطبيق</option>
                <option value="subscription">اشتراك</option>
                <option value="adjustment">تسوية</option>
              </select>
              <Input type="number" step="0.01" value={comForm.baseAmount} onChange={(e) => setComForm((s) => ({ ...s, baseAmount: e.target.value }))} placeholder="المبلغ الأساسي *" data-testid="input-base-amount" />
              <Input type="number" step="0.001" value={comForm.commissionRate} onChange={(e) => setComForm((s) => ({ ...s, commissionRate: e.target.value }))} placeholder={`النسبة (${partner.commissionRate}%)`} />
              <Input value={comForm.extensionId} onChange={(e) => setComForm((s) => ({ ...s, extensionId: e.target.value }))} placeholder="معرّف الإضافة" />
              <Button size="sm" onClick={() => accrue.mutate()} disabled={accrue.isPending || !comForm.baseAmount.trim()} data-testid="button-accrue">تسجيل</Button>
            </div>
            <div className="max-h-48 overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="px-2 py-1.5 text-right">الحدث</th><th className="px-2 py-1.5 text-right">الفترة</th>
                  <th className="px-2 py-1.5 text-right">الأساس</th><th className="px-2 py-1.5 text-right">النسبة</th><th className="px-2 py-1.5 text-right">العمولة</th>
                </tr></thead>
                <tbody className="divide-y">
                  {(data?.commissions ?? []).map((c: any) => (
                    <tr key={c.id} data-testid={`commission-${c.id}`}>
                      <td className="px-2 py-1.5">{c.eventType}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.periodMonth}/{c.periodYear}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtMoney(c.baseAmount)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.commissionRate}%</td>
                      <td className="px-2 py-1.5 tabular-nums text-emerald-700">{fmtMoney(c.commissionAmount)}</td>
                    </tr>
                  ))}
                  {(data?.commissions ?? []).length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-slate-400">لا توجد عمولات</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Consolidated commissions report (agents + developers/partners) ─────────
function CommissionsReport({ headers }: { headers: any }) {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-partners-report"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/partners/reports/commissions`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const rows = data?.rows ?? [];
  const totals = data?.totals;

  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["الكيانات", totals?.entities ?? 0],
          ["الشركات", totals?.companies ?? 0],
          ["الأساس", fmtMoney(totals?.baseAmount)],
          ["إجمالي العمولات", fmtMoney(totals?.commissionTotal)],
        ].map(([label, val]) => (
          <div key={label as string} className="rounded-xl border bg-white p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-xl font-bold text-slate-800 tabular-nums mt-1">{val}</p>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 text-right font-medium">النوع</th>
              <th className="px-3 py-2 text-right font-medium">المعرّف</th>
              <th className="px-3 py-2 text-right font-medium">الاسم</th>
              <th className="px-3 py-2 text-right font-medium">الحالة</th>
              <th className="px-3 py-2 text-right font-medium">الشركات</th>
              <th className="px-3 py-2 text-right font-medium">الأساس</th>
              <th className="px-3 py-2 text-right font-medium">العمولات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r: any) => (
              <tr key={`${r.entityType}-${r.id}`} data-testid={`report-${r.entityType}-${r.id}`}>
                <td className="px-3 py-2">{KIND_LABELS[r.entityType] ?? r.entityType}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.code ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2"><StatusPill s={r.status} /></td>
                <td className="px-3 py-2 tabular-nums">{r.companies}</td>
                <td className="px-3 py-2 tabular-nums">{fmtMoney(r.baseAmount)}</td>
                <td className="px-3 py-2 tabular-nums text-emerald-700">{fmtMoney(r.commissionTotal)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-12 text-center text-slate-400">لا توجد بيانات</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 — Publish Engine. A one-click pipeline that runs staged BLOCKING
// gates over a candidate extension manifest: build → security scan → AI review
// → package → digital sign → deploy → monitor. A failing scan/review/sign gate
// blocks deployment with a clear, actionable report. Every run is persisted
// (extension_publishes) and audited. Reads/writes ONLY /api/admin/publish/*.
// ─────────────────────────────────────────────────────────────────────────

const STAGE_META: Record<string, { label: string; Icon: any }> = {
  build:         { label: "البناء",          Icon: Hammer },
  security_scan: { label: "الفحص الأمني",     Icon: ShieldCheck },
  ai_review:     { label: "المراجعة الذكية",  Icon: Sparkles },
  package:       { label: "التحزيم",          Icon: Package },
  sign:          { label: "التوقيع الرقمي",   Icon: PenTool },
  deploy:        { label: "النشر",            Icon: Rocket },
  monitor:       { label: "المراقبة",         Icon: Activity },
};

const GATE_CLS: Record<string, string> = {
  pass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
  skip: "bg-slate-50 text-slate-500 border-slate-200",
};
const GATE_LABEL: Record<string, string> = { pass: "اجتاز", warn: "تنبيه", fail: "فشل", skip: "تخطّي" };

const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  deployed: { label: "تم النشر",  cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  blocked:  { label: "محظور",     cls: "bg-red-50 text-red-700 border-red-200" },
  failed:   { label: "فشل",       cls: "bg-orange-50 text-orange-700 border-orange-200" },
  pending:  { label: "قيد الانتظار", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  running:  { label: "قيد التنفيذ",  cls: "bg-sky-50 text-sky-700 border-sky-200" },
};

function GateCard({ g }: { g: any }) {
  const meta = STAGE_META[g.stage] ?? { label: g.stage, Icon: Boxes };
  const Icon = meta.Icon;
  const cls = GATE_CLS[g.status] ?? GATE_CLS.skip;
  return (
    <div className={cn("rounded-xl border p-3", cls)} data-testid={`gate-${g.stage}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Icon className="h-4 w-4" /> {meta.label}
        </div>
        <span className="inline-flex rounded-full border bg-white/60 px-2 py-0.5 text-xs font-semibold">{GATE_LABEL[g.status] ?? g.status}</span>
      </div>
      <p className="mt-1 text-xs opacity-90">{g.summary}</p>
      {Array.isArray(g.details) && g.details.length > 0 && (
        <ul className="mt-1 list-disc pr-4 space-y-0.5 text-xs opacity-80">
          {g.details.slice(0, 8).map((d: string, i: number) => <li key={i}>{d}</li>)}
        </ul>
      )}
    </div>
  );
}

function PublishCenter({ headers }: { headers: Record<string, string> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [manifestText, setManifestText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  const builtins = useQuery({
    queryKey: ["publish-builtins"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/publish/builtins`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const runs = useQuery({
    queryKey: ["publish-runs"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/publish`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const publish = useMutation({
    mutationFn: async () => {
      let manifest: any;
      try { manifest = JSON.parse(manifestText); }
      catch { throw new Error("صيغة JSON غير صالحة — تحقّق من البيان"); }
      const r = await fetch(`${API}/api/admin/publish`, { method: "POST", headers, body: JSON.stringify({ manifest }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "فشل النشر");
      return d;
    },
    onSuccess: (d) => {
      setResult(d.outcome);
      const st = d.outcome?.status;
      toast({
        title: st === "deployed" ? "تم النشر بنجاح" : st === "blocked" ? "حُظر النشر" : "فشل النشر",
        description: st === "deployed" ? "اجتازت الإضافة جميع البوابات ونُشرت" : "راجع تقرير البوابات أدناه",
        variant: st === "deployed" ? undefined : "destructive",
      });
      qc.invalidateQueries({ queryKey: ["publish-runs"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const loadBuiltin = (id: string) => {
    const b = (builtins.data?.builtins ?? []).find((x: any) => x.extensionId === id);
    if (!b) return;
    setManifestText(JSON.stringify(b.manifest, null, 2));
    setParseError(null);
    setResult(null);
  };

  const validateJson = (txt: string) => {
    setManifestText(txt);
    if (!txt.trim()) { setParseError(null); return; }
    try { JSON.parse(txt); setParseError(null); }
    catch { setParseError("صيغة JSON غير صالحة"); }
  };

  return (
    <div className="space-y-5">
      {/* Pipeline overview strip */}
      <div className="rounded-xl border bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <UploadCloud className="h-4 w-4 text-primary" /> خط النشر — بوابات متتابعة، أي فشل في الفحص/المراجعة/التوقيع يحظر النشر
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {Object.entries(STAGE_META).map(([k, m], i, arr) => {
            const Icon = m.Icon;
            return (
              <div key={k} className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600">
                  <Icon className="h-3.5 w-3.5" /> {m.label}
                </span>
                {i < arr.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-slate-300 rotate-180" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Submit */}
        <div className="rounded-xl border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">إرسال بيان للنشر</h3>
            <div className="flex items-center gap-2">
              <select
                onChange={(e) => { if (e.target.value) loadBuiltin(e.target.value); e.target.value = ""; }}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                data-testid="select-builtin-template"
                defaultValue=""
              >
                <option value="">تحميل قالب…</option>
                {(builtins.data?.builtins ?? []).map((b: any) => (
                  <option key={b.extensionId} value={b.extensionId}>{b.manifest?.name?.ar ?? b.extensionId}</option>
                ))}
              </select>
            </div>
          </div>
          <Label className="text-xs text-slate-500">البيان (JSON)</Label>
          <textarea
            value={manifestText}
            onChange={(e) => validateJson(e.target.value)}
            dir="ltr"
            spellCheck={false}
            placeholder='{ "manifestVersion": 1, "extensionId": "my-ext", ... }'
            className="w-full h-72 rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
            data-testid="input-manifest"
          />
          {parseError && (
            <p className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {parseError}</p>
          )}
          <Button
            onClick={() => publish.mutate()}
            disabled={publish.isPending || !manifestText.trim() || !!parseError}
            className="gap-2 w-full"
            data-testid="button-publish"
          >
            {publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            {publish.isPending ? "جارٍ تشغيل خط النشر…" : "نشر الإضافة"}
          </Button>
        </div>

        {/* Result */}
        <div className="rounded-xl border p-4">
          <h3 className="font-semibold text-slate-800 mb-3">نتيجة البوابات</h3>
          {!result ? (
            <div className="py-12 text-center text-slate-400 text-sm">أرسل بياناً لعرض نتائج البوابات هنا</div>
          ) : (
            <div className="space-y-3" data-testid="publish-result">
              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono text-xs text-slate-500">{result.extensionId}</span>
                  <span className="text-slate-400"> · v{result.version}</span>
                </div>
                <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold", (RUN_STATUS[result.status] ?? RUN_STATUS.failed).cls)}>
                  {(RUN_STATUS[result.status] ?? RUN_STATUS.failed).label}
                </span>
              </div>
              {result.report?.blockedAt && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <div className="font-semibold flex items-center gap-1 mb-1"><Ban className="h-3.5 w-3.5" /> حُظر النشر عند بوابة: {STAGE_META[result.report.blockedAt]?.label ?? result.report.blockedAt}</div>
                  {(result.report.errors ?? []).slice(0, 8).map((e: string, i: number) => <div key={i}>• {e}</div>)}
                </div>
              )}
              {result.status === "deployed" && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> نُشرت الإضافة إلى الكتالوج بتوقيع رقمي {result.publicKeyId ? `(مفتاح ${result.publicKeyId})` : ""}
                </div>
              )}
              <div className="space-y-2">
                {(result.gates ?? []).map((g: any) => <GateCard key={g.stage} g={g} />)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Run history */}
      <div className="rounded-xl border">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h3 className="font-semibold text-slate-800">سجلّ عمليات النشر</h3>
          <Button size="sm" variant="outline" onClick={() => runs.refetch()} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
        </div>
        {runs.isLoading ? (
          <div className="p-4 space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (runs.data?.runs ?? []).length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm">لا توجد عمليات نشر بعد</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">المعرّف</th>
                  <th className="px-3 py-2 text-right font-medium">الإصدار</th>
                  <th className="px-3 py-2 text-right font-medium">الحالة</th>
                  <th className="px-3 py-2 text-right font-medium">آخر مرحلة</th>
                  <th className="px-3 py-2 text-right font-medium">بواسطة</th>
                  <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(runs.data?.runs ?? []).map((r: any) => (
                  <tr key={r.id} data-testid={`run-${r.id}`}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.extensionId}</td>
                    <td className="px-3 py-2 tabular-nums text-xs">v{r.version}</td>
                    <td className="px-3 py-2"><span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", (RUN_STATUS[r.status] ?? RUN_STATUS.failed).cls)}>{(RUN_STATUS[r.status] ?? RUN_STATUS.failed).label}</span></td>
                    <td className="px-3 py-2 text-xs text-slate-500">{STAGE_META[r.currentStage]?.label ?? r.currentStage ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.createdByUsername ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{r.createdAt ? new Date(r.createdAt).toLocaleString("ar") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
