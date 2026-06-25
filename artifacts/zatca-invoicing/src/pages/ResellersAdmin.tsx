import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Handshake, PlusCircle, RefreshCw, Users, Wallet, Trash2, KeyRound,
  X, Link2, Unlink, Search, Pencil, Inbox, MessageSquare, CheckCircle2, XCircle,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin reseller (Agent) management — Task #237.
//
// Platform-level: onboard distributors, set their commission rate + granular
// capability grants, and link/unlink the companies each one manages. Every
// call hits /api/admin/resellers/* (self-guarded by requireSuperAdmin server
// side). Strictly additive — touches only the new reseller_* tables.
// ─────────────────────────────────────────────────────────────────────────

const PERMISSION_LABELS: { key: string; label: string }[] = [
  { key: "add_companies", label: "إضافة شركات (عملاء)" },
  { key: "renew_subscriptions", label: "تجديد الاشتراكات" },
  { key: "view_reports", label: "عرض تقارير العمولات" },
  { key: "support", label: "فتح تذاكر الدعم" },
];

function fmtMoney(v: any): string {
  return Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const emptyForm = {
  code: "", nameAr: "", nameEn: "", phone: "", email: "", address: "",
  username: "", password: "", commissionRate: "10",
  permissions: { add_companies: true, renew_subscriptions: true, view_reports: true, support: true } as Record<string, boolean>,
};

export default function ResellersAdmin() {
  const { token } = useAuth() as any;
  const qc = useQueryClient();
  const { toast } = useToast();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [detailId, setDetailId] = useState<number | null>(null);
  const [tab, setTab] = useState<"resellers" | "inbox">("resellers");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-resellers"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const resellers = data?.resellers ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers`, { method: "POST", headers, body: JSON.stringify(form) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإنشاء"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إنشاء الموزّع" }); setShowCreate(false); setForm({ ...emptyForm }); qc.invalidateQueries({ queryKey: ["admin-resellers"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/resellers/${id}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الحذف"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم حذف الموزّع" }); qc.invalidateQueries({ queryKey: ["admin-resellers"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const setField = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const togglePerm = (k: string) => setForm((f) => ({ ...f, permissions: { ...f.permissions, [k]: !f.permissions[k] } }));

  return (
    <div dir="rtl" className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Handshake className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">إدارة الموزّعين</h1>
            <p className="text-sm text-slate-500">الوكلاء والموزّعون الذين يديرون عملاءهم على المنصة</p>
          </div>
        </div>
        <div className="flex gap-2">
          {tab === "resellers" && <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2"><RefreshCw className="h-4 w-4" /> تحديث</Button>}
          {tab === "resellers" && <Button size="sm" onClick={() => setShowCreate(true)} className="gap-2" data-testid="button-add-reseller"><PlusCircle className="h-4 w-4" /> موزّع جديد</Button>}
        </div>
      </div>

      <div className="flex gap-1 border-b">
        <button onClick={() => setTab("resellers")} data-testid="tab-resellers"
          className={cn("px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "resellers" ? "border-primary text-primary" : "border-transparent text-slate-500 hover:text-slate-700")}>
          <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" /> الموزّعون</span>
        </button>
        <button onClick={() => setTab("inbox")} data-testid="tab-inbox"
          className={cn("px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "inbox" ? "border-primary text-primary" : "border-transparent text-slate-500 hover:text-slate-700")}>
          <span className="inline-flex items-center gap-1.5"><Inbox className="h-4 w-4" /> الوارد</span>
        </button>
      </div>

      {tab === "inbox" && <ResellerInbox headers={headers} />}

      {tab === "resellers" && (isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : resellers.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا يوجد موزّعون بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">الكود</th>
                <th className="px-3 py-2 text-right font-medium">الاسم</th>
                <th className="px-3 py-2 text-right font-medium">اسم المستخدم</th>
                <th className="px-3 py-2 text-right font-medium">النسبة</th>
                <th className="px-3 py-2 text-right font-medium">العملاء</th>
                <th className="px-3 py-2 text-right font-medium">إجمالي العمولات</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {resellers.map((r: any) => (
                <tr key={r.id} data-testid={`row-reseller-${r.id}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.code}</td>
                  <td className="px-3 py-2 font-medium">{r.nameAr}</td>
                  <td className="px-3 py-2">{r.username}</td>
                  <td className="px-3 py-2 tabular-nums">{r.commissionRate}%</td>
                  <td className="px-3 py-2 tabular-nums"><span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5 text-slate-400" />{r.clientCount}</span></td>
                  <td className="px-3 py-2 tabular-nums text-emerald-700">{fmtMoney(r.commissionTotal)}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                      r.status === "active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200")}>
                      {r.status === "active" ? "نشط" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => setDetailId(r.id)} data-testid={`button-manage-${r.id}`}>
                        <Pencil className="h-3.5 w-3.5" /> إدارة
                      </Button>
                      <Button size="sm" variant="outline" className="text-red-600" onClick={() => { if (confirm(`حذف الموزّع ${r.nameAr}؟`)) del.mutate(r.id); }} data-testid={`button-delete-${r.id}`}>
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

      {/* Create modal */}
      {showCreate && (
        <Modal title="موزّع جديد" onClose={() => setShowCreate(false)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              ["code", "الكود *"], ["nameAr", "الاسم (عربي) *"], ["nameEn", "الاسم (إنجليزي)"],
              ["phone", "الهاتف"], ["email", "البريد"], ["address", "العنوان"],
              ["username", "اسم المستخدم *"],
            ] as [string, string][]).map(([k, label]) => (
              <div key={k}><Label>{label}</Label>
                <Input value={(form as any)[k]} onChange={(e) => setField(k, e.target.value)} className="mt-1" data-testid={`input-${k}`} /></div>
            ))}
            <div><Label>كلمة المرور *</Label>
              <Input type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} className="mt-1" data-testid="input-password" /></div>
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
            <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-save-reseller">حفظ</Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>إلغاء</Button>
          </div>
        </Modal>
      )}

      {detailId != null && (
        <ResellerDetail id={detailId} headers={headers} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto p-6" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Detail / manage panel (profile, permissions, linked companies) ──────
function ResellerDetail({ id, headers, onClose }: { id: number; headers: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-reseller", id],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/${id}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const { data: avail } = useQuery({
    queryKey: ["admin-reseller-available", search],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/companies/available?search=${encodeURIComponent(search)}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const reseller = data?.reseller;
  const [rate, setRate] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const effRate = rate ?? reseller?.commissionRate ?? "0";
  const effPerms = perms ?? reseller?.permissions ?? {};
  const effStatus = status ?? reseller?.status ?? "active";

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/${id}`, {
        method: "PUT", headers, body: JSON.stringify({ commissionRate: effRate, permissions: effPerms, status: effStatus }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم الحفظ" }); qc.invalidateQueries({ queryKey: ["admin-reseller", id] }); qc.invalidateQueries({ queryKey: ["admin-resellers"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const resetPw = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/${id}/reset-password`, { method: "POST", headers, body: JSON.stringify({ password: newPassword }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تغيير كلمة المرور" }); setNewPassword(""); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const link = useMutation({
    mutationFn: async (companyId: number) => {
      const r = await fetch(`${API}/api/admin/resellers/${id}/companies`, { method: "POST", headers, body: JSON.stringify({ companyId }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الربط"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-reseller", id] }); qc.invalidateQueries({ queryKey: ["admin-reseller-available"] }); qc.invalidateQueries({ queryKey: ["admin-resellers"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const unlink = useMutation({
    mutationFn: async (companyId: number) => {
      const r = await fetch(`${API}/api/admin/resellers/${id}/companies/${companyId}`, { method: "DELETE", headers });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-reseller", id] }); qc.invalidateQueries({ queryKey: ["admin-reseller-available"] }); qc.invalidateQueries({ queryKey: ["admin-resellers"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <Modal title={isLoading ? "…" : `إدارة الموزّع: ${reseller?.nameAr ?? ""}`} onClose={onClose}>
      {isLoading || !reseller ? <Skeleton className="h-40 w-full" /> : (
        <div className="space-y-5">
          {/* Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>نسبة العمولة (%)</Label>
              <Input type="number" step="0.001" value={effRate} onChange={(e) => setRate(e.target.value)} className="mt-1" data-testid="input-edit-rate" /></div>
            <div><Label>الحالة</Label>
              <select value={effStatus} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="select-status">
                <option value="active">نشط</option>
                <option value="suspended">موقوف</option>
              </select></div>
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

          {/* Reset password */}
          <div className="border-t pt-4">
            <Label className="mb-1 block flex items-center gap-1"><KeyRound className="h-4 w-4" /> إعادة تعيين كلمة المرور</Label>
            <div className="flex gap-2">
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="كلمة مرور جديدة" data-testid="input-new-password" />
              <Button variant="outline" onClick={() => resetPw.mutate()} disabled={resetPw.isPending || newPassword.length < 6}>تغيير</Button>
            </div>
          </div>

          {/* Linked companies */}
          <div className="border-t pt-4">
            <Label className="mb-2 block">الشركات المرتبطة ({data?.companies?.length ?? 0})</Label>
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
        </div>
      )}
    </Modal>
  );
}

// ─── Inbox: support tickets + activation requests from resellers ─────────
function ResellerInbox({ headers }: { headers: any }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});

  const { data: ticketData, isLoading: ticketsLoading } = useQuery({
    queryKey: ["admin-reseller-tickets"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/inbox/tickets`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const { data: reqData, isLoading: reqLoading } = useQuery({
    queryKey: ["admin-reseller-requests"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/resellers/inbox/activation-requests`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const reply = useMutation({
    mutationFn: async ({ id, text }: { id: number; text: string }) => {
      const r = await fetch(`${API}/api/admin/resellers/inbox/tickets/${id}/reply`, {
        method: "POST", headers, body: JSON.stringify({ reply: text }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الرد"); }
      return r.json();
    },
    onSuccess: (_d, v) => { toast({ title: "تم إرسال الرد" }); setReplies((s) => ({ ...s, [v.id]: "" })); qc.invalidateQueries({ queryKey: ["admin-reseller-tickets"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const resolve = useMutation({
    mutationFn: async ({ id, decision, adminNote }: { id: number; decision: string; adminNote: string }) => {
      const r = await fetch(`${API}/api/admin/resellers/inbox/activation-requests/${id}/resolve`, {
        method: "POST", headers, body: JSON.stringify({ decision, adminNote }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تحديث الطلب" }); qc.invalidateQueries({ queryKey: ["admin-reseller-requests"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const tickets = ticketData?.tickets ?? [];
  const requests = reqData?.requests ?? [];

  const STATUS: Record<string, { label: string; cls: string }> = {
    open: { label: "مفتوحة", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    answered: { label: "تم الرد", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    closed: { label: "مغلقة", cls: "bg-slate-50 text-slate-600 border-slate-200" },
    pending: { label: "قيد الانتظار", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    approved: { label: "مقبول", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    rejected: { label: "مرفوض", cls: "bg-red-50 text-red-700 border-red-200" },
  };
  const StatusPill = ({ s }: { s: string }) => {
    const b = STATUS[s] ?? { label: s, cls: "bg-slate-50 text-slate-600 border-slate-200" };
    return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", b.cls)}>{b.label}</span>;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Tickets */}
      <div className="space-y-3">
        <h3 className="font-semibold text-slate-700 flex items-center gap-1.5"><MessageSquare className="h-4 w-4" /> تذاكر الدعم</h3>
        {ticketsLoading ? <Skeleton className="h-24 w-full" /> : tickets.length === 0 ? (
          <div className="rounded-xl border border-dashed py-8 text-center text-slate-400">لا توجد تذاكر</div>
        ) : tickets.map((t: any) => (
          <Card key={t.id} data-testid={`admin-ticket-${t.id}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{t.subject}</span>
                <StatusPill s={t.status} />
              </div>
              <p className="text-xs text-slate-400">{t.resellerName}</p>
              <p className="text-sm text-slate-600 whitespace-pre-wrap">{t.body}</p>
              {t.adminReply && (
                <div className="rounded-lg bg-slate-50 border p-2 text-sm text-slate-700 whitespace-pre-wrap">{t.adminReply}</div>
              )}
              {t.status !== "closed" && (
                <div className="flex gap-2 pt-1">
                  <Input value={replies[t.id] ?? ""} onChange={(e) => setReplies((s) => ({ ...s, [t.id]: e.target.value }))}
                    placeholder="اكتب رداً…" data-testid={`reply-input-${t.id}`} />
                  <Button size="sm" disabled={reply.isPending || !(replies[t.id] ?? "").trim()}
                    onClick={() => reply.mutate({ id: t.id, text: replies[t.id] })} data-testid={`reply-send-${t.id}`}>إرسال</Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Activation requests */}
      <div className="space-y-3">
        <h3 className="font-semibold text-slate-700 flex items-center gap-1.5"><Inbox className="h-4 w-4" /> طلبات التفعيل</h3>
        {reqLoading ? <Skeleton className="h-24 w-full" /> : requests.length === 0 ? (
          <div className="rounded-xl border border-dashed py-8 text-center text-slate-400">لا توجد طلبات</div>
        ) : requests.map((q: any) => (
          <Card key={q.id} data-testid={`admin-request-${q.id}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{q.companyNameAr}</span>
                <StatusPill s={q.status} />
              </div>
              <p className="text-xs text-slate-400">{q.resellerName} · {q.plan ?? "—"}</p>
              {(q.contactPhone || q.contactEmail) && <p className="text-xs text-slate-500">{q.contactPhone} {q.contactEmail}</p>}
              {q.notes && <p className="text-sm text-slate-600 whitespace-pre-wrap">{q.notes}</p>}
              {q.adminNote && <div className="rounded-lg bg-slate-50 border p-2 text-sm text-slate-700">{q.adminNote}</div>}
              {q.status === "pending" && (
                <div className="space-y-2 pt-1">
                  <Input value={notes[q.id] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [q.id]: e.target.value }))}
                    placeholder="ملاحظة (اختياري)…" data-testid={`note-input-${q.id}`} />
                  <div className="flex gap-2">
                    <Button size="sm" className="gap-1" disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: q.id, decision: "approved", adminNote: notes[q.id] ?? "" })} data-testid={`approve-${q.id}`}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> قبول
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600 gap-1" disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: q.id, decision: "rejected", adminNote: notes[q.id] ?? "" })} data-testid={`reject-${q.id}`}>
                      <XCircle className="h-3.5 w-3.5" /> رفض
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
