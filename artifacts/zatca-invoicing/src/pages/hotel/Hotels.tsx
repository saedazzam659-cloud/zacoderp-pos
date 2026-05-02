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
import { Plus, Pencil, Trash2, Search, Building2, Star } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Hotel = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  location: string | null; rating: number; status: string;
  contactPhone: string | null; contactEmail: string | null;
  branchId: number | null; notes: string | null;
};

const STATUSES = [
  ["active",            "نشط",          "bg-emerald-100 text-emerald-800"],
  ["inactive",          "غير نشط",      "bg-slate-100 text-slate-700"],
  ["under_renovation",  "تحت التجديد",  "bg-amber-100 text-amber-800"],
] as const;

const EMPTY_FORM = {
  code: "", nameAr: "", nameEn: "", location: "",
  rating: "3", status: "active",
  contactPhone: "", contactEmail: "", branchId: "", notes: "",
};

export default function Hotels() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Hotel | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Hotel | null>(null);

  const { data: hotels = [], isLoading } = useQuery<Hotel[]>({
    queryKey: ["hotel/hotels", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel/hotels?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الفنادق");
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

  const filtered = hotels.filter(h => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      h.nameAr?.includes(search) || h.nameEn?.toLowerCase().includes(q) ||
      h.code?.toLowerCase().includes(q) || h.location?.toLowerCase().includes(q)
    );
  });

  function openNew() { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); }
  function openEdit(h: Hotel) {
    setEditing(h);
    setForm({
      code: h.code ?? "", nameAr: h.nameAr ?? "", nameEn: h.nameEn ?? "",
      location: h.location ?? "", rating: String(h.rating ?? 3),
      status: h.status ?? "active",
      contactPhone: h.contactPhone ?? "", contactEmail: h.contactEmail ?? "",
      branchId: h.branchId ? String(h.branchId) : "",
      notes: h.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الفندق مطلوب");
      const body = { ...form, companyId: cid,
        rating: Number(form.rating || 3),
        branchId: form.branchId ? Number(form.branchId) : null,
      };
      const url = editing ? `${API}/api/hotel/hotels/${editing.id}` : `${API}/api/hotel/hotels`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/hotels", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hotel/hotels/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/hotels", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-teal-600" />
            الفنادق
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة الفنادق والفروع — {hotels.length} فندق
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-hotel" className="bg-teal-600 hover:bg-teal-700">
          <Plus className="h-4 w-4 ms-2" />
          فندق جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الموقع…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {hotels.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الفندق: ${editing.nameAr}` : "إضافة فندق جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات الفندق — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الكود</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="تلقائي HOT0001" data-testid="input-code" />
            </div>
            <div>
              <Label>اسم الفندق بالعربية *</Label>
              <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} data-testid="input-nameAr" />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            </div>
            <div>
              <Label>الموقع</Label>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="الرياض، جدة…" />
            </div>
            <div>
              <Label>التصنيف (نجوم)</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })}>
                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} ★</option>)}
              </select>
            </div>
            <div>
              <Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>هاتف</Label>
              <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </div>
            <div>
              <Label>بريد إلكتروني</Label>
              <Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
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
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-teal-50 to-teal-100 text-teal-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">اسم الفندق</th>
                <th className="px-3 py-2 text-start font-semibold">الموقع</th>
                <th className="px-3 py-2 text-start font-semibold">التصنيف</th>
                <th className="px-3 py-2 text-start font-semibold">الهاتف</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد فنادق مسجَّلة</td></tr>
              )}
              {filtered.map((h) => {
                const st = STATUSES.find(([v]) => v === h.status);
                return (
                  <tr key={h.id} className="hover:bg-teal-50/40" data-testid={`row-hotel-${h.id}`}>
                    <td className="px-3 py-2 font-mono">{h.code}</td>
                    <td className="px-3 py-2 font-semibold">
                      {h.nameAr}
                      {h.nameEn && <span className="block text-[10px] text-muted-foreground font-normal">{h.nameEn}</span>}
                    </td>
                    <td className="px-3 py-2">{h.location || "—"}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-0.5 text-amber-500">
                        {Array.from({ length: h.rating }, (_, i) => <Star key={i} className="h-3 w-3 fill-current" />)}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{h.contactPhone || "—"}</td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(h)} data-testid={`btn-edit-${h.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(h)} data-testid={`btn-delete-${h.id}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الفندق</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الفندق «{del?.nameAr}» نهائياً؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
