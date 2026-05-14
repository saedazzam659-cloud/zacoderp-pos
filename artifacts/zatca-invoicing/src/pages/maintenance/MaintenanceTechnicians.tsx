import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Search, HardHat, Phone, Mail, Briefcase } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Tech = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  phone: string | null; email: string | null; specialization: string | null;
  hourlyRate: string; isActive: boolean; notes: string | null;
  branchId: number | null;
};

const EMPTY_FORM = {
  code: "", nameAr: "", nameEn: "", phone: "", email: "",
  specialization: "", hourlyRate: "0", isActive: true, branchId: "", notes: "",
};

export default function MaintenanceTechnicians() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Tech | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Tech | null>(null);

  const { data: techs = [], isLoading } = useQuery<Tech[]>({
    queryKey: ["maintenance/technicians", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/technicians?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الفنيين");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const filtered = techs.filter(t => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      t.nameAr?.includes(search) || t.nameEn?.toLowerCase().includes(q) ||
      t.code?.toLowerCase().includes(q) || t.phone?.includes(search) ||
      t.email?.toLowerCase().includes(q) || t.specialization?.includes(search)
    );
  });

  function openNew() { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); }
  function openEdit(t: Tech) {
    setEditing(t);
    setForm({
      code: t.code ?? "", nameAr: t.nameAr ?? "", nameEn: t.nameEn ?? "",
      phone: t.phone ?? "", email: t.email ?? "",
      specialization: t.specialization ?? "",
      hourlyRate: String(t.hourlyRate ?? "0"), isActive: t.isActive,
      branchId: t.branchId ? String(t.branchId) : "", notes: t.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الفني مطلوب");
      const body = { ...form, companyId: cid,
        branchId: form.branchId ? Number(form.branchId) : null,
        hourlyRate: Number(form.hourlyRate) || 0,
      };
      const url = editing ? `${API}/api/maintenance/technicians/${editing.id}` : `${API}/api/maintenance/technicians`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/technicians", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/maintenance/technicians/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/technicians", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HardHat className="h-6 w-6 text-indigo-600" />
            فنيو الصيانة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة فنيي الصيانة وأجور الساعة — {techs.length} فني
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-tech">
          <Plus className="h-4 w-4 ms-2" />
          فني جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الهاتف، التخصص…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {techs.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الفني: ${editing.nameAr}` : "إضافة فني جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات الفني — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الكود</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="تلقائي TECH0001" data-testid="input-code" />
            </div>
            <div>
              <Label>اسم الفني بالعربية *</Label>
              <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} data-testid="input-nameAr" />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            </div>
            <div>
              <Label>التخصص</Label>
              <Input value={form.specialization} onChange={(e) => setForm({ ...form, specialization: e.target.value })} placeholder="كهرباء / ميكانيكا / تكييف…" data-testid="input-specialization" />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="05xxxxxxxx" data-testid="input-phone" />
            </div>
            <div>
              <Label>البريد الإلكتروني</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="input-email" />
            </div>
            <div>
              <Label>أجر الساعة (ر.س)</Label>
              <Input type="number" step="0.01" min="0" value={form.hourlyRate}
                onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} data-testid="input-hourly-rate" />
            </div>
            <div>
              <Label>الفرع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                <option value="">— اختر الفرع —</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.nameAr || b.nameEn}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input id="tech-active" type="checkbox" checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4" data-testid="checkbox-active" />
              <Label htmlFor="tech-active" className="cursor-pointer">الفني نشط</Label>
            </div>
          </div>
        </FormPanel>
      )}

      {/* ─────── MOBILE CARDS (visible < md only) ─────── */}
      <div className="md:hidden space-y-3" data-testid="mobile-cards-techs">
        {isLoading && (
          <div className="text-center py-8 text-muted-foreground bg-white rounded-lg border">جاري التحميل…</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-10 text-muted-foreground bg-white rounded-lg border">
            <HardHat className="h-10 w-10 mx-auto mb-2 opacity-30" />
            لا يوجد فنيون مسجَّلون
          </div>
        )}
        {filtered.map((t) => (
          <div
            key={t.id}
            className="bg-white rounded-xl border border-indigo-100 shadow-sm overflow-hidden"
            data-testid={`mobile-card-tech-${t.id}`}
          >
            <div className="bg-gradient-to-l from-indigo-50 to-indigo-100/50 px-4 py-2.5 flex items-center justify-between border-b border-indigo-100">
              <div className="flex items-center gap-2">
                <HardHat className="h-4 w-4 text-indigo-700" />
                <span className="font-mono font-bold text-sm text-indigo-900">{t.code}</span>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold ${t.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                {t.isActive ? "نشط" : "موقوف"}
              </span>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="font-bold text-sm text-slate-900 leading-tight">
                {t.nameAr}
                {t.nameEn && <span className="block text-[11px] text-muted-foreground font-normal">{t.nameEn}</span>}
              </div>
              {t.specialization && (
                <div className="flex items-center gap-1 text-[11px] text-slate-600">
                  <Briefcase className="h-3 w-3" /> {t.specialization}
                </div>
              )}
              <div className="flex flex-col gap-1.5 text-[11px]">
                {t.phone && (
                  <a href={`tel:${t.phone}`} className="flex items-center gap-1.5 text-emerald-700 active:underline" data-testid={`mobile-call-${t.id}`}>
                    <Phone className="h-3 w-3" /> {t.phone}
                  </a>
                )}
                {t.email && (
                  <a href={`mailto:${t.email}`} className="flex items-center gap-1.5 text-blue-700 active:underline truncate" data-testid={`mobile-email-${t.id}`}>
                    <Mail className="h-3 w-3" /> {t.email}
                  </a>
                )}
              </div>
              <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
                <span className="text-[11px] text-muted-foreground">أجر الساعة</span>
                <span className="font-bold tabular-nums text-indigo-700">
                  {Number(t.hourlyRate).toFixed(2)} <span className="text-[10px] text-muted-foreground">ر.س</span>
                </span>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-slate-50/60 grid grid-cols-2 divide-x divide-slate-100 [direction:ltr]">
              <button type="button" onClick={() => setDel(t)}
                className="py-2.5 text-rose-600 active:bg-rose-100 flex items-center justify-center gap-1 text-xs"
                data-testid={`mobile-btn-delete-${t.id}`}>
                <Trash2 className="h-3.5 w-3.5" /> حذف
              </button>
              <button type="button" onClick={() => openEdit(t)}
                className="py-2.5 text-indigo-700 active:bg-indigo-100 flex items-center justify-center gap-1 text-xs font-medium"
                data-testid={`mobile-btn-edit-${t.id}`}>
                <Pencil className="h-3.5 w-3.5" /> تعديل
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ─────── DESKTOP TABLE (visible md+ only) ─────── */}
      <div className="hidden md:block border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">التخصص</th>
                <th className="px-3 py-2 text-start font-semibold">الهاتف</th>
                <th className="px-3 py-2 text-start font-semibold">البريد</th>
                <th className="px-3 py-2 text-start font-semibold">أجر الساعة</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا يوجد فنيون مسجَّلون</td></tr>}
              {filtered.map((t) => (
                <tr key={t.id} className="hover:bg-indigo-50/40" data-testid={`row-tech-${t.id}`}>
                  <td className="px-3 py-2 font-mono">{t.code}</td>
                  <td className="px-3 py-2 font-semibold">
                    {t.nameAr}
                    {t.nameEn && <span className="block text-[10px] text-muted-foreground font-normal">{t.nameEn}</span>}
                  </td>
                  <td className="px-3 py-2">{t.specialization || "—"}</td>
                  <td className="px-3 py-2">
                    {t.phone ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{t.phone}</span> : "—"}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    {t.email ? <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{t.email}</span> : "—"}
                  </td>
                  <td className="px-3 py-2">{Number(t.hourlyRate).toFixed(2)} ر.س</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${t.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                      {t.isActive ? "نشط" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(t)} data-testid={`btn-edit-${t.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(t)} data-testid={`btn-delete-${t.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الفني</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الفني «{del?.nameAr}» نهائياً؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─────── MOBILE FAB ─────── */}
      <button
        type="button"
        onClick={openNew}
        className="md:hidden fixed bottom-6 end-6 z-40 group"
        data-testid="mobile-fab-new-tech"
        aria-label="فني جديد"
      >
        <span className="absolute inset-0 rounded-full bg-indigo-500 opacity-30 group-active:opacity-0 animate-ping" />
        <span className="relative flex items-center justify-center h-14 w-14 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-lg shadow-indigo-500/40 ring-4 ring-white active:scale-95 transition-transform">
          <Plus className="h-7 w-7" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
