// SuperAdmin — issue / manage activation codes for the protected install
// wizard (/install). A code + a valid user login together unlock the POS
// Desktop MSI download. Direct fetch + Bearer convention (mirrors
// OfflineLicenses.tsx / PosDevices.tsx), NOT the generated client.

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { KeyRound, Plus, Trash2, ShieldOff, ShieldCheck, Copy, RefreshCw, Search } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Code = {
  id: number; code: string; label: string | null;
  companyId: number | null; companyName: string | null;
  maxUses: number | null; usedCount: number;
  expiresAt: string | null; isActive: boolean; notes: string | null; createdAt: string;
};
type Company = { id: number; nameAr: string; code: string };

export default function DownloadCodes() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const listQ = useQuery<Code[]>({
    queryKey: ["download-codes"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/download-codes`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الأكواد");
      return r.json();
    },
  });

  const companiesQ = useQuery<Company[]>({
    queryKey: ["download-codes-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    label: "", code: "", companyId: "", maxUses: "", expiresAt: "", notes: "",
  });
  const [search, setSearch] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (form.label.trim()) body.label = form.label.trim();
      if (form.code.trim()) body.code = form.code.trim();
      if (form.companyId) body.companyId = Number(form.companyId);
      if (form.maxUses) body.maxUses = Number(form.maxUses);
      if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();
      if (form.notes.trim()) body.notes = form.notes.trim();
      const r = await fetch(`${API}/api/admin/download-codes`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل إنشاء الكود");
      return j as Code;
    },
    onSuccess: () => {
      toast({ title: "تم إنشاء الكود بنجاح" });
      setShowCreate(false);
      setForm({ label: "", code: "", companyId: "", maxUses: "", expiresAt: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["download-codes"] });
    },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: async (c: Code) => {
      const r = await fetch(`${API}/api/admin/download-codes/${c.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ isActive: !c.isActive }),
      });
      if (!r.ok) throw new Error("فشل تحديث الحالة");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["download-codes"] }),
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/download-codes/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("فشل حذف الكود");
      return r.json();
    },
    onSuccess: () => { toast({ title: "تم حذف الكود" }); qc.invalidateQueries({ queryKey: ["download-codes"] }); },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const rows = useMemo(() => {
    const list = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      c.code.toLowerCase().includes(q) ||
      (c.label ?? "").toLowerCase().includes(q) ||
      (c.companyName ?? "").toLowerCase().includes(q));
  }, [listQ.data, search]);

  function copyCode(code: string) {
    navigator.clipboard?.writeText(code);
    toast({ title: "تم نسخ الكود", description: code });
  }

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("ar-SA") : "—");

  return (
    <div dir="rtl" className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold">أكواد تثبيت POS</h1>
            <p className="text-sm text-muted-foreground">أكواد التفعيل المطلوبة في معالج التثبيت المحمي (/install)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => listQ.refetch()}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
          <Button onClick={() => setShowCreate(true)}><Plus className="ml-1 h-4 w-4" /> كود جديد</Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالكود أو الوصف أو الشركة" className="pr-9" />
      </div>

      <Card>
        <CardContent className="p-0">
          {listQ.isLoading && <p className="p-6 text-center text-muted-foreground">جاري التحميل...</p>}
          {listQ.isError && <p className="p-6 text-center text-rose-600">تعذر تحميل الأكواد.</p>}
          {!listQ.isLoading && rows.length === 0 && (
            <p className="p-10 text-center text-muted-foreground">لا توجد أكواد بعد. اضغط "كود جديد" لإصدار أول كود.</p>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-muted-foreground">
                  <tr className="text-right">
                    <th className="p-3 font-medium">الكود</th>
                    <th className="p-3 font-medium">الوصف</th>
                    <th className="p-3 font-medium">الشركة</th>
                    <th className="p-3 font-medium">الاستخدام</th>
                    <th className="p-3 font-medium">الانتهاء</th>
                    <th className="p-3 font-medium">الحالة</th>
                    <th className="p-3 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-slate-50/50">
                      <td className="p-3">
                        <button onClick={() => copyCode(c.code)} className="font-mono font-semibold inline-flex items-center gap-1.5 hover:text-blue-600">
                          {c.code} <Copy className="h-3.5 w-3.5 opacity-60" />
                        </button>
                      </td>
                      <td className="p-3">{c.label || "—"}</td>
                      <td className="p-3">{c.companyName || <span className="text-muted-foreground">أي شركة</span>}</td>
                      <td className="p-3">{c.usedCount}{c.maxUses != null ? ` / ${c.maxUses}` : " / ∞"}</td>
                      <td className="p-3">{fmtDate(c.expiresAt)}</td>
                      <td className="p-3">
                        {c.isActive
                          ? <Badge className="bg-green-100 text-green-700">مفعّل</Badge>
                          : <Badge className="bg-slate-200 text-slate-600">موقوف</Badge>}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => toggle.mutate(c)} title={c.isActive ? "إيقاف" : "تفعيل"}>
                            {c.isActive ? <ShieldOff className="h-4 w-4 text-amber-600" /> : <ShieldCheck className="h-4 w-4 text-green-600" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`حذف الكود ${c.code}؟`)) del.mutate(c.id); }} title="حذف">
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

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>إصدار كود تفعيل جديد</DialogTitle>
            <DialogDescription>اترك حقل الكود فارغاً لتوليد كود تلقائي.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>الوصف (اختياري)</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="مثال: عميل مطاعم الرياض" />
            </div>
            <div className="space-y-2">
              <Label>الكود (اختياري — يُولَّد تلقائياً إن تُرك فارغاً)</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="اتركه فارغاً للتوليد التلقائي" className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label>ربط بشركة (اختياري)</Label>
              <Select value={form.companyId || "none"} onValueChange={(v) => setForm({ ...form, companyId: v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="أي شركة" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">أي شركة (غير مقيّد)</SelectItem>
                  {(companiesQ.data ?? []).map((co) => (
                    <SelectItem key={co.id} value={String(co.id)}>{co.nameAr} ({co.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>عدد مرات الاستخدام (اختياري)</Label>
                <Input type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} placeholder="غير محدود" />
              </div>
              <div className="space-y-2">
                <Label>تاريخ الانتهاء (اختياري)</Label>
                <DateField value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>ملاحظات (اختياري)</Label>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>إلغاء</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "جاري الحفظ..." : "إصدار الكود"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
