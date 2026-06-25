// SuperAdmin — Multi-Domain Management ("إدارة النطاقات"). Maps a company to
// its own domain (one domain → one company). A request arriving on a mapped +
// active domain scopes to that company as a FALLBACK (the main domain keeps
// the multi-company behavior). Direct fetch + Bearer convention (mirrors
// DownloadCodes.tsx), NOT the generated client.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Globe, Plus, Trash2, Pencil, RefreshCw, Search, Activity, Star,
  ShieldCheck, ShieldAlert, Loader2, CheckCircle2, XCircle,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type CheckResult = {
  checkedAt: string;
  reachable: boolean;
  dns: { ok: boolean; addresses?: string[]; error?: string };
  ssl: { ok: boolean; validFrom?: string; validTo?: string; daysRemaining?: number; issuer?: string; error?: string };
} | null;

type Domain = {
  id: number; domain: string;
  companyId: number; companyName: string | null; companyCode: string | null;
  isPrimary: boolean; status: "pending" | "active" | "disabled";
  activatedAt: string | null;
  lastCheckAt: string | null; lastCheckResult: CheckResult;
  notes: string | null; createdAt: string;
};
type Company = { id: number; nameAr: string; code: string };

const STATUS_LABEL: Record<Domain["status"], string> = {
  pending: "قيد الإعداد", active: "مفعّل", disabled: "موقوف",
};
const STATUS_CLS: Record<Domain["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  active: "bg-green-100 text-green-700",
  disabled: "bg-slate-200 text-slate-600",
};

const emptyForm = {
  id: 0, domain: "", companyId: "", status: "pending" as Domain["status"], isPrimary: false, notes: "",
};

export default function Domains() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const listQ = useQuery<Domain[]>({
    queryKey: ["admin-domains"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/domains`, { headers });
      if (!r.ok) throw new Error("فشل تحميل النطاقات");
      return r.json();
    },
  });

  const companiesQ = useQuery<Company[]>({
    queryKey: ["admin-domains-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [search, setSearch] = useState("");
  const [checking, setChecking] = useState<number | null>(null);

  const isEdit = form.id > 0;

  function openCreate() { setForm({ ...emptyForm }); setShowForm(true); }
  function openEdit(d: Domain) {
    setForm({
      id: d.id, domain: d.domain, companyId: String(d.companyId),
      status: d.status, isPrimary: d.isPrimary, notes: d.notes ?? "",
    });
    setShowForm(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!form.domain.trim()) throw new Error("أدخل النطاق");
      if (!form.companyId) throw new Error("اختر الشركة");
      const body: Record<string, unknown> = {
        domain: form.domain.trim(),
        companyId: Number(form.companyId),
        status: form.status,
        isPrimary: form.isPrimary,
        notes: form.notes.trim() || undefined,
      };
      const url = isEdit ? `${API}/api/admin/domains/${form.id}` : `${API}/api/admin/domains`;
      const r = await fetch(url, {
        method: isEdit ? "PATCH" : "POST", headers, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل حفظ النطاق");
      return j;
    },
    onSuccess: () => {
      toast({ title: isEdit ? "تم تحديث النطاق" : "تم إضافة النطاق" });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["admin-domains"] });
    },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/domains/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("فشل حذف النطاق");
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم حذف النطاق" }); qc.invalidateQueries({ queryKey: ["admin-domains"] }); },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  async function runCheck(d: Domain) {
    setChecking(d.id);
    try {
      const r = await fetch(`${API}/api/admin/domains/${d.id}/check`, { method: "POST", headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل الفحص");
      const reach = j.reachable ? "متاح" : "غير متاح";
      toast({ title: `نتيجة فحص ${d.domain}`, description: `DNS: ${j.dns?.ok ? "✓" : "✗"} · SSL: ${j.ssl?.ok ? "✓" : "✗"} · الخادم: ${reach}` });
      qc.invalidateQueries({ queryKey: ["admin-domains"] });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message || "فشل الفحص", variant: "destructive" });
    } finally {
      setChecking(null);
    }
  }

  const rows = useMemo(() => {
    const list = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((d) =>
      d.domain.toLowerCase().includes(q) ||
      (d.companyName ?? "").toLowerCase().includes(q) ||
      (d.companyCode ?? "").toLowerCase().includes(q));
  }, [listQ.data, search]);

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("ar-SA") : "—");

  function sslBadge(d: Domain) {
    const ssl = d.lastCheckResult?.ssl;
    if (!d.lastCheckResult) return <span className="text-muted-foreground text-xs">لم يُفحص</span>;
    if (ssl?.ok) {
      const days = ssl.daysRemaining;
      return (
        <span className="inline-flex items-center gap-1 text-green-700 text-xs">
          <ShieldCheck className="h-3.5 w-3.5" />
          {days != null ? `${days} يوم` : "صالحة"}
        </span>
      );
    }
    return <span className="inline-flex items-center gap-1 text-rose-600 text-xs"><ShieldAlert className="h-3.5 w-3.5" /> لا يوجد</span>;
  }

  return (
    <div dir="rtl" className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Globe className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold">إدارة النطاقات</h1>
            <p className="text-sm text-muted-foreground">اربط كل شركة بنطاقها الخاص. الطلب القادم من نطاق مُفعّل يُحدد الشركة تلقائياً؛ النطاق الرئيسي يبقى متعدد الشركات.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => listQ.refetch()}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
          <Button onClick={openCreate}><Plus className="ml-1 h-4 w-4" /> نطاق جديد</Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالنطاق أو الشركة" className="pr-9" />
      </div>

      <Card>
        <CardContent className="p-0">
          {listQ.isLoading && <p className="p-6 text-center text-muted-foreground">جاري التحميل...</p>}
          {listQ.isError && <p className="p-6 text-center text-rose-600">تعذر تحميل النطاقات.</p>}
          {!listQ.isLoading && rows.length === 0 && (
            <p className="p-10 text-center text-muted-foreground">لا توجد نطاقات بعد. اضغط "نطاق جديد" لإضافة أول نطاق.</p>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-muted-foreground">
                  <tr className="text-right">
                    <th className="p-3 font-medium">النطاق</th>
                    <th className="p-3 font-medium">الشركة</th>
                    <th className="p-3 font-medium">الرمز</th>
                    <th className="p-3 font-medium">رئيسي</th>
                    <th className="p-3 font-medium">الحالة</th>
                    <th className="p-3 font-medium">تاريخ التفعيل</th>
                    <th className="p-3 font-medium">SSL</th>
                    <th className="p-3 font-medium">آخر فحص</th>
                    <th className="p-3 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className="border-t hover:bg-slate-50/50">
                      <td className="p-3 font-mono font-semibold">{d.domain}</td>
                      <td className="p-3">{d.companyName || <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-3 font-mono text-xs">{d.companyCode || "—"}</td>
                      <td className="p-3">
                        {d.isPrimary
                          ? <Star className="h-4 w-4 text-amber-500 fill-amber-400" />
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="p-3"><Badge className={STATUS_CLS[d.status]}>{STATUS_LABEL[d.status]}</Badge></td>
                      <td className="p-3">{fmtDate(d.activatedAt)}</td>
                      <td className="p-3">{sslBadge(d)}</td>
                      <td className="p-3">
                        {d.lastCheckResult ? (
                          <span className="inline-flex items-center gap-1 text-xs">
                            {d.lastCheckResult.reachable
                              ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                              : <XCircle className="h-3.5 w-3.5 text-rose-600" />}
                            {fmtDate(d.lastCheckAt)}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => runCheck(d)} disabled={checking === d.id} title="فحص النطاق">
                            {checking === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4 text-blue-600" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(d)} title="تعديل">
                            <Pencil className="h-4 w-4 text-slate-600" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`حذف النطاق ${d.domain}؟`)) del.mutate(d.id); }} title="حذف">
                            <Trash2 className="h-4 w-4 text-rose-600" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>{isEdit ? "تعديل نطاق" : "إضافة نطاق"}</DialogTitle>
            <DialogDescription>اربط النطاق بشركة واحدة. عند تفعيل النطاق يُحدد الشركة تلقائياً للطلبات القادمة منه.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>النطاق</Label>
              <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="مثال: company1.com" className="font-mono" dir="ltr" />
            </div>
            <div className="space-y-2">
              <Label>الشركة</Label>
              <Select value={form.companyId || ""} onValueChange={(v) => setForm({ ...form, companyId: v })}>
                <SelectTrigger><SelectValue placeholder="اختر الشركة" /></SelectTrigger>
                <SelectContent>
                  {(companiesQ.data ?? []).map((co) => (
                    <SelectItem key={co.id} value={String(co.id)}>{co.nameAr} ({co.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>الحالة</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Domain["status"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">قيد الإعداد</SelectItem>
                  <SelectItem value="active">مفعّل</SelectItem>
                  <SelectItem value="disabled">موقوف</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">يتم اعتماد توجيه النطاق إلى الشركة فقط عندما تكون الحالة "مفعّل".</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label>النطاق الرئيسي للشركة</Label>
                <p className="text-xs text-muted-foreground">يُلغى أي نطاق رئيسي آخر لنفس الشركة تلقائياً.</p>
              </div>
              <Switch checked={form.isPrimary} onCheckedChange={(v) => setForm({ ...form, isPrimary: v })} />
            </div>
            <div className="space-y-2">
              <Label>ملاحظات (اختياري)</Label>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowForm(false)}>إلغاء</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "جاري الحفظ..." : (isEdit ? "حفظ التعديلات" : "إضافة النطاق")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
