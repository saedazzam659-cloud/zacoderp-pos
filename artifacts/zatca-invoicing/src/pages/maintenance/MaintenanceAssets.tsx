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
import { Plus, Pencil, Trash2, Search, Boxes } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Asset = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  category: string; serialNumber: string | null; location: string | null;
  manufacturer: string | null; model: string | null;
  purchaseDate: string | null; purchasePrice: string | null;
  warrantyExpiry: string | null; status: string; notes: string | null;
  branchId: number | null;
};

const CATEGORIES = [
  ["vehicle", "مركبة"], ["machine", "ماكينة"], ["equipment", "معدّة"],
  ["tool", "أداة"], ["building", "مبنى"], ["it_hardware", "أجهزة IT"], ["other", "أخرى"],
] as const;

const STATUSES = [
  ["active", "نشط", "bg-emerald-100 text-emerald-800"],
  ["in_repair", "تحت الصيانة", "bg-amber-100 text-amber-800"],
  ["out_of_service", "خارج الخدمة", "bg-rose-100 text-rose-800"],
  ["retired", "مُتقاعَد", "bg-slate-100 text-slate-700"],
] as const;

const EMPTY_FORM = {
  code: "", nameAr: "", nameEn: "", category: "equipment",
  serialNumber: "", location: "", manufacturer: "", model: "",
  purchaseDate: "", purchasePrice: "", warrantyExpiry: "",
  status: "active", branchId: "", notes: "",
};

export default function MaintenanceAssets() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Asset | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Asset | null>(null);

  const { data: assets = [], isLoading } = useQuery<Asset[]>({
    queryKey: ["maintenance/assets", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/assets?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الأصول");
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

  const filtered = assets.filter(a => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      a.nameAr?.includes(search) || a.nameEn?.toLowerCase().includes(q) ||
      a.code?.toLowerCase().includes(q) || a.serialNumber?.toLowerCase().includes(q) ||
      a.location?.toLowerCase().includes(q)
    );
  });

  function openNew() { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); }
  function openEdit(a: Asset) {
    setEditing(a);
    setForm({
      code: a.code ?? "", nameAr: a.nameAr ?? "", nameEn: a.nameEn ?? "",
      category: a.category ?? "equipment",
      serialNumber: a.serialNumber ?? "", location: a.location ?? "",
      manufacturer: a.manufacturer ?? "", model: a.model ?? "",
      purchaseDate: a.purchaseDate ?? "", purchasePrice: a.purchasePrice ?? "",
      warrantyExpiry: a.warrantyExpiry ?? "",
      status: a.status ?? "active", branchId: a.branchId ? String(a.branchId) : "",
      notes: a.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الأصل مطلوب");
      const body = { ...form, companyId: cid,
        branchId: form.branchId ? Number(form.branchId) : null,
        purchaseDate: form.purchaseDate || null,
        warrantyExpiry: form.warrantyExpiry || null,
        purchasePrice: form.purchasePrice || null,
      };
      const url = editing ? `${API}/api/maintenance/assets/${editing.id}` : `${API}/api/maintenance/assets`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/assets", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/maintenance/assets/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/assets", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Boxes className="h-6 w-6 text-orange-600" />
            أصول الصيانة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة الأصول والمعدات — {assets.length} أصل
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-asset">
          <Plus className="h-4 w-4 ms-2" />
          أصل جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الرقم التسلسلي…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {assets.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الأصل: ${editing.nameAr}` : "إضافة أصل جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات الأصل — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الكود</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="تلقائي AST0001" data-testid="input-code" />
            </div>
            <div>
              <Label>اسم الأصل بالعربية *</Label>
              <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} data-testid="input-nameAr" />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} data-testid="input-nameEn" />
            </div>
            <div>
              <Label>الفئة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} data-testid="select-category">
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الرقم التسلسلي</Label>
              <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} data-testid="input-serial" />
            </div>
            <div>
              <Label>الموقع</Label>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="المخزن، المكتب، الفرع…" data-testid="input-location" />
            </div>
            <div>
              <Label>الشركة الصانعة</Label>
              <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} data-testid="input-manufacturer" />
            </div>
            <div>
              <Label>الموديل</Label>
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} data-testid="input-model" />
            </div>
            <div>
              <Label>تاريخ الشراء</Label>
              <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
            </div>
            <div>
              <Label>سعر الشراء (ر.س)</Label>
              <Input type="number" step="0.01" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} />
            </div>
            <div>
              <Label>انتهاء الضمان</Label>
              <Input type="date" value={form.warrantyExpiry} onChange={(e) => setForm({ ...form, warrantyExpiry: e.target.value })} />
            </div>
            <div>
              <Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} data-testid="select-status">
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
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
            <thead className="bg-gradient-to-b from-orange-50 to-orange-100 text-orange-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">الفئة</th>
                <th className="px-3 py-2 text-start font-semibold">الرقم التسلسلي</th>
                <th className="px-3 py-2 text-start font-semibold">الموقع</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد أصول مسجَّلة</td></tr>
              )}
              {filtered.map((a) => {
                const cat = CATEGORIES.find(([v]) => v === a.category)?.[1] ?? a.category;
                const st = STATUSES.find(([v]) => v === a.status);
                return (
                  <tr key={a.id} className="hover:bg-orange-50/40" data-testid={`row-asset-${a.id}`}>
                    <td className="px-3 py-2 font-mono">{a.code}</td>
                    <td className="px-3 py-2 font-semibold">
                      {a.nameAr}
                      {a.nameEn && <span className="block text-[10px] text-muted-foreground font-normal">{a.nameEn}</span>}
                    </td>
                    <td className="px-3 py-2">{cat}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{a.serialNumber || "—"}</td>
                    <td className="px-3 py-2">{a.location || "—"}</td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(a)} data-testid={`btn-edit-${a.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(a)} data-testid={`btn-delete-${a.id}`}>
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
            <AlertDialogTitle>حذف الأصل</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الأصل «{del?.nameAr}» نهائياً؟ لا يمكن التراجع عن هذا الإجراء.
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
