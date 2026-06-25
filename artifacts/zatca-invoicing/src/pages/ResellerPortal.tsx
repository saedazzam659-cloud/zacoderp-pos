import { useState, useMemo } from "react";
import { Switch, Route, Link, useLocation, Redirect } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Users, PlusCircle, Wallet, LifeBuoy, ClipboardList,
  LogOut, Handshake, RefreshCw, CheckCircle2, Clock, XCircle, Building2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// Reseller (Agent) portal — Task #237.
//
// Self-contained shell (own sidebar + routes, NOT the tenant Layout) rendered
// by App.tsx whenever the authenticated user's role==="reseller". Every screen
// is strictly scoped server-side to the reseller's own client companies; the
// permission grants (resellerPermissions) only HIDE screens the reseller can't
// use — the backend is the real authority (403 on any ungranted action).
// ─────────────────────────────────────────────────────────────────────────

function useHeaders() {
  const token = localStorage.getItem("zatca_token");
  return useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);
}

function fmtMoney(v: any): string {
  const n = Number(v ?? 0);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const EVENT_LABELS: Record<string, string> = {
  new_subscription: "اشتراك جديد",
  renewal: "تجديد",
  addon: "إضافة",
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  suspended: { label: "موقوف", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  pending: { label: "قيد الانتظار", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  approved: { label: "مقبول", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "مرفوض", cls: "bg-red-50 text-red-700 border-red-200" },
  open: { label: "مفتوحة", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  answered: { label: "تم الرد", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  closed: { label: "مغلقة", cls: "bg-slate-50 text-slate-600 border-slate-200" },
};

function Badge({ status }: { status: string }) {
  const b = STATUS_BADGE[status] ?? { label: status, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", b.cls)}>{b.label}</span>;
}

// ─── Dashboard ───────────────────────────────────────────────────────────
function ResellerDashboard() {
  const headers = useHeaders();
  const { data, isLoading } = useQuery({
    queryKey: ["reseller-dashboard"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/dashboard`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const cards = [
    { label: "عدد العملاء", value: data?.clientCount ?? 0, icon: Building2, color: "text-blue-600 bg-blue-50" },
    { label: "عملاء نشطون", value: data?.activeClients ?? 0, icon: CheckCircle2, color: "text-emerald-600 bg-emerald-50" },
    { label: "إجمالي العمولات", value: fmtMoney(data?.commissionTotal), icon: Wallet, color: "text-violet-600 bg-violet-50", money: true },
    { label: "عمولة هذا الشهر", value: fmtMoney(data?.commissionThisMonth), icon: Wallet, color: "text-amber-600 bg-amber-50", money: true },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">لوحة التحكم</h2>
        <p className="text-sm text-slate-500 mt-1">نظرة عامة على شبكة عملائك وعمولاتك (نسبة العمولة: {data?.commissionRate ?? "0"}%)</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={cn("h-11 w-11 rounded-lg flex items-center justify-center shrink-0", c.color)}>
              <c.icon className="h-5 w-5" />
            </div>
            <div>
              {isLoading ? <Skeleton className="h-7 w-20" /> : (
                <p className="text-2xl font-bold tabular-nums">{c.value}{c.money ? <span className="text-sm text-slate-400 mr-1">ر.س</span> : null}</p>
              )}
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </div>
          </div>
        ))}
      </div>
      {(data?.openTickets ?? 0) > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          لديك {data.openTickets} تذكرة دعم مفتوحة بانتظار رد الإدارة.
        </div>
      )}
    </div>
  );
}

// ─── Clients ─────────────────────────────────────────────────────────────
function ResellerClients({ canRenew }: { canRenew: boolean }) {
  const headers = useHeaders();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["reseller-clients"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/clients`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const renew = useMutation({
    mutationFn: async ({ id, months }: { id: number; months: number }) => {
      const r = await fetch(`${API}/api/reseller/clients/${id}/renew`, {
        method: "POST", headers, body: JSON.stringify({ months }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل التجديد"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم تجديد الاشتراك" }); qc.invalidateQueries({ queryKey: ["reseller-clients"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const clients = data?.clients ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">العملاء</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="h-4 w-4" /> تحديث
          </Button>
          <Link href="/reseller/clients/new">
            <Button size="sm" className="gap-2"><PlusCircle className="h-4 w-4" /> عميل جديد</Button>
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : clients.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا يوجد عملاء بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">الكود</th>
                <th className="px-3 py-2 text-right font-medium">الاسم</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">الباقة</th>
                <th className="px-3 py-2 text-right font-medium">انتهاء الاشتراك</th>
                {canRenew && <th className="px-3 py-2 text-right font-medium">إجراءات</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {clients.map((c: any) => (
                <tr key={c.id} data-testid={`row-client-${c.id}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.code}</td>
                  <td className="px-3 py-2 font-medium">{c.nameAr}</td>
                  <td className="px-3 py-2"><Badge status={c.status} /></td>
                  <td className="px-3 py-2">{c.subscription?.plan ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{c.subscription?.endDate ?? "—"}</td>
                  {canRenew && (
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        {[1, 12].map((m) => (
                          <Button key={m} size="sm" variant="outline" disabled={renew.isPending}
                            onClick={() => renew.mutate({ id: c.id, months: m })}
                            data-testid={`button-renew-${c.id}-${m}`}>
                            {m === 12 ? "+ سنة" : "+ شهر"}
                          </Button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Add client ──────────────────────────────────────────────────────────
function ResellerAddClient() {
  const headers = useHeaders();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [form, setForm] = useState({
    nameAr: "", nameEn: "", vatNumber: "", crNumber: "", phone: "", city: "",
    username: "", email: "", password: "", plan: "starter", billingCycle: "monthly",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/reseller/clients`, {
        method: "POST", headers, body: JSON.stringify(form),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإنشاء"); }
      return r.json();
    },
    onSuccess: (d) => {
      toast({ title: "تم إنشاء العميل", description: `كود الشركة: ${d?.companyCode ?? ""}` });
      qc.invalidateQueries({ queryKey: ["reseller-clients"] });
      navigate("/reseller/clients");
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const FIELDS: { k: keyof typeof form; label: string; required?: boolean; type?: string }[] = [
    { k: "nameAr", label: "اسم الشركة (عربي)", required: true },
    { k: "nameEn", label: "اسم الشركة (إنجليزي)" },
    { k: "vatNumber", label: "الرقم الضريبي", required: true },
    { k: "crNumber", label: "السجل التجاري", required: true },
    { k: "phone", label: "الهاتف" },
    { k: "city", label: "المدينة" },
    { k: "username", label: "اسم مستخدم المدير", required: true },
    { k: "email", label: "البريد الإلكتروني" },
    { k: "password", label: "كلمة المرور", required: true, type: "password" },
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-2xl font-bold text-slate-800">إضافة عميل جديد</h2>
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FIELDS.map((f) => (
              <div key={f.k}>
                <Label>{f.label}{f.required && <span className="text-red-500 mr-0.5">*</span>}</Label>
                <Input
                  type={f.type ?? "text"}
                  value={form[f.k]}
                  onChange={(e) => set(f.k, e.target.value)}
                  className="mt-1"
                  data-testid={`input-${f.k}`}
                />
              </div>
            ))}
            <div>
              <Label>الباقة</Label>
              <select value={form.plan} onChange={(e) => set("plan", e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="select-plan">
                <option value="starter">مبتدئ</option>
                <option value="professional">احترافي</option>
                <option value="enterprise">مؤسسي</option>
              </select>
            </div>
            <div>
              <Label>دورة الفوترة</Label>
              <select value={form.billingCycle} onChange={(e) => set("billingCycle", e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="select-cycle">
                <option value="monthly">شهري</option>
                <option value="annual">سنوي</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-create-client">
              {create.isPending ? "جارٍ الحفظ…" : "إنشاء العميل"}
            </Button>
            <Button variant="outline" onClick={() => navigate("/reseller/clients")}>إلغاء</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Commissions ─────────────────────────────────────────────────────────
function ResellerCommissions() {
  const headers = useHeaders();
  const { data, isLoading } = useQuery({
    queryKey: ["reseller-commissions"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/commissions`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const { data: summary } = useQuery({
    queryKey: ["reseller-commissions-summary"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/commissions/summary`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const rows = data?.commissions ?? [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-800">العمولات</h2>
      {summary?.monthly?.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {summary.monthly.slice(0, 3).map((m: any, i: number) => (
            <div key={i} className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{m.periodMonth}/{m.periodYear}</p>
              <p className="text-xl font-bold tabular-nums">{fmtMoney(m.total)} <span className="text-xs text-slate-400">ر.س</span></p>
              <p className="text-xs text-slate-400">{m.count} عملية</p>
            </div>
          ))}
        </div>
      )}
      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا توجد عمولات بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                <th className="px-3 py-2 text-right font-medium">العميل</th>
                <th className="px-3 py-2 text-right font-medium">النوع</th>
                <th className="px-3 py-2 text-right font-medium">الأساس</th>
                <th className="px-3 py-2 text-right font-medium">النسبة</th>
                <th className="px-3 py-2 text-right font-medium">العمولة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((c: any) => (
                <tr key={c.id} data-testid={`row-commission-${c.id}`}>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">{(c.createdAt ?? "").slice(0, 10)}</td>
                  <td className="px-3 py-2">{c.companyName ?? "—"}</td>
                  <td className="px-3 py-2">{EVENT_LABELS[c.eventType] ?? c.eventType}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtMoney(c.baseAmount)}</td>
                  <td className="px-3 py-2 tabular-nums">{c.commissionRate}%</td>
                  <td className="px-3 py-2 tabular-nums font-semibold text-emerald-700">{fmtMoney(c.commissionAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Support tickets ─────────────────────────────────────────────────────
function ResellerTickets() {
  const headers = useHeaders();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["reseller-tickets"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/tickets`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/reseller/tickets`, {
        method: "POST", headers, body: JSON.stringify({ subject, body }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإرسال"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إرسال التذكرة" }); setSubject(""); setBody(""); qc.invalidateQueries({ queryKey: ["reseller-tickets"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const tickets = data?.tickets ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="text-2xl font-bold text-slate-800">الدعم الفني</h2>
      <Card>
        <CardContent className="p-5 space-y-3">
          <div>
            <Label>الموضوع</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1" data-testid="input-ticket-subject" />
          </div>
          <div>
            <Label>التفاصيل</Label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="input-ticket-body" />
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !subject.trim() || !body.trim()} data-testid="button-send-ticket">
            إرسال التذكرة
          </Button>
        </CardContent>
      </Card>

      {isLoading ? <Skeleton className="h-24 w-full" /> : tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed py-10 text-center text-slate-400">لا توجد تذاكر</div>
      ) : (
        <div className="space-y-2">
          {tickets.map((t: any) => (
            <div key={t.id} className="rounded-xl border p-4" data-testid={`row-ticket-${t.id}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{t.subject}</span>
                <Badge status={t.status} />
              </div>
              <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{t.body}</p>
              {t.adminReply && (
                <div className="mt-3 rounded-lg bg-slate-50 border p-3">
                  <p className="text-xs font-semibold text-slate-500 mb-1">رد الإدارة:</p>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{t.adminReply}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Activation requests ─────────────────────────────────────────────────
function ResellerActivationRequests() {
  const headers = useHeaders();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ companyNameAr: "", contactPhone: "", contactEmail: "", plan: "", notes: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const { data, isLoading } = useQuery({
    queryKey: ["reseller-activation-requests"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/reseller/activation-requests`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/reseller/activation-requests`, {
        method: "POST", headers, body: JSON.stringify(form),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error ?? "فشل الإرسال"); }
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم إرسال الطلب" }); setForm({ companyNameAr: "", contactPhone: "", contactEmail: "", plan: "", notes: "" }); qc.invalidateQueries({ queryKey: ["reseller-activation-requests"] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });
  const requests = data?.requests ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="text-2xl font-bold text-slate-800">طلبات التفعيل</h2>
      <p className="text-sm text-slate-500">اطلب من الإدارة تفعيل اشتراك جديد لعميل محتمل.</p>
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>اسم الشركة<span className="text-red-500 mr-0.5">*</span></Label>
              <Input value={form.companyNameAr} onChange={(e) => set("companyNameAr", e.target.value)} className="mt-1" data-testid="input-req-name" /></div>
            <div><Label>الهاتف</Label>
              <Input value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} className="mt-1" data-testid="input-req-phone" /></div>
            <div><Label>البريد الإلكتروني</Label>
              <Input value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className="mt-1" data-testid="input-req-email" /></div>
            <div><Label>الباقة المطلوبة</Label>
              <Input value={form.plan} onChange={(e) => set("plan", e.target.value)} className="mt-1" data-testid="input-req-plan" /></div>
          </div>
          <div><Label>ملاحظات</Label>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="input-req-notes" /></div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !form.companyNameAr.trim()} data-testid="button-send-request">
            إرسال الطلب
          </Button>
        </CardContent>
      </Card>

      {isLoading ? <Skeleton className="h-24 w-full" /> : requests.length === 0 ? (
        <div className="rounded-xl border border-dashed py-10 text-center text-slate-400">لا توجد طلبات</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">الشركة</th>
                <th className="px-3 py-2 text-right font-medium">الباقة</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">رد الإدارة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {requests.map((q: any) => (
                <tr key={q.id} data-testid={`row-request-${q.id}`}>
                  <td className="px-3 py-2 font-medium">{q.companyNameAr}</td>
                  <td className="px-3 py-2">{q.plan ?? "—"}</td>
                  <td className="px-3 py-2"><Badge status={q.status} /></td>
                  <td className="px-3 py-2 text-slate-600">{q.adminNote ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Portal shell ────────────────────────────────────────────────────────
export default function ResellerPortal() {
  const { user, logout } = useAuth() as any;
  const [location] = useLocation();
  const perms: Record<string, boolean> = user?.resellerPermissions ?? {};

  const nav = [
    { href: "/reseller", label: "لوحة التحكم", icon: LayoutDashboard, show: true, exact: true },
    { href: "/reseller/clients", label: "العملاء", icon: Users, show: true },
    { href: "/reseller/commissions", label: "العمولات", icon: Wallet, show: perms.view_reports === true },
    { href: "/reseller/tickets", label: "الدعم الفني", icon: LifeBuoy, show: perms.support === true },
    { href: "/reseller/activation-requests", label: "طلبات التفعيل", icon: ClipboardList, show: true },
  ];

  const isActive = (href: string, exact?: boolean) =>
    exact ? location === href : location === href || location.startsWith(href + "/");

  return (
    <div dir="rtl" className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-l bg-white flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Handshake className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800 leading-tight">بوابة الموزّع</p>
            <p className="text-[11px] text-slate-400 leading-tight">{user?.nameAr ?? user?.username}</p>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.filter((n) => n.show).map((n) => (
            <Link key={n.href} href={n.href} className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive(n.href, n.exact) ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-100"
            )} data-testid={`nav-${n.href.replace(/\//g, "-")}`}>
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t">
          <Button variant="ghost" className="w-full justify-start gap-3 text-slate-600" onClick={() => logout()} data-testid="button-reseller-logout">
            <LogOut className="h-4 w-4" /> تسجيل الخروج
          </Button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        <Switch>
          <Route path="/reseller" component={ResellerDashboard} />
          <Route path="/reseller/clients/new" component={ResellerAddClient} />
          <Route path="/reseller/clients">
            <ResellerClients canRenew={perms.renew_subscriptions === true} />
          </Route>
          <Route path="/reseller/commissions" component={ResellerCommissions} />
          <Route path="/reseller/tickets" component={ResellerTickets} />
          <Route path="/reseller/activation-requests" component={ResellerActivationRequests} />
          <Route><Redirect to="/reseller" /></Route>
        </Switch>
      </main>
    </div>
  );
}
