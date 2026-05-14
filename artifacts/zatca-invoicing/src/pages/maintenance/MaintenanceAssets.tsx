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
import { Plus, Pencil, Trash2, Search, Boxes, MapPin, Tag, Hash } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { fieldApi } from "@/lib/fieldServiceApi";

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
  const [visitsAsset, setVisitsAsset] = useState<Asset | null>(null);

  const { data: assetHistory, isLoading: loadingHistory } = useQuery({
    queryKey: ["asset-field-history", visitsAsset?.id],
    queryFn: () => visitsAsset ? fieldApi.byAsset(visitsAsset.id) : Promise.resolve(null),
    enabled: !!visitsAsset,
  });

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

      {/* ─────── MOBILE CARDS (visible < md only) ─────── */}
      <div className="md:hidden space-y-3" data-testid="mobile-cards-assets">
        {isLoading && (
          <div className="text-center py-8 text-muted-foreground bg-white rounded-lg border">جاري التحميل…</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-10 text-muted-foreground bg-white rounded-lg border">
            <Boxes className="h-10 w-10 mx-auto mb-2 opacity-30" />
            لا توجد أصول مسجَّلة
          </div>
        )}
        {filtered.map((a) => {
          const cat = CATEGORIES.find(([v]) => v === a.category)?.[1] ?? a.category;
          const st = STATUSES.find(([v]) => v === a.status);
          return (
            <div
              key={a.id}
              className="bg-white rounded-xl border border-orange-100 shadow-sm overflow-hidden"
              data-testid={`mobile-card-asset-${a.id}`}
            >
              <div className="bg-gradient-to-l from-orange-50 to-orange-100/50 px-4 py-2.5 flex items-center justify-between border-b border-orange-100">
                <div className="flex items-center gap-2">
                  <Boxes className="h-4 w-4 text-orange-700" />
                  <span className="font-mono font-bold text-sm text-orange-900">{a.code}</span>
                </div>
                {st && (
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold ${st[2]}`}>{st[1]}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setVisitsAsset(a)}
                className="w-full text-start px-4 py-3 space-y-2"
                data-testid={`mobile-open-asset-${a.id}`}
              >
                <div className="font-bold text-sm text-slate-900 leading-tight">
                  {a.nameAr}
                  {a.nameEn && <span className="block text-[11px] text-muted-foreground font-normal">{a.nameEn}</span>}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-600 flex-wrap">
                  <span className="flex items-center gap-1"><Tag className="h-3 w-3" /> {cat}</span>
                  {a.serialNumber && <span className="flex items-center gap-1 font-mono"><Hash className="h-3 w-3" /> {a.serialNumber}</span>}
                </div>
                {a.location && (
                  <div className="flex items-center gap-1 text-[11px] text-slate-600">
                    <MapPin className="h-3 w-3" /> {a.location}
                  </div>
                )}
              </button>
              <div className="border-t border-slate-100 bg-slate-50/60 grid grid-cols-3 divide-x divide-slate-100 [direction:ltr]">
                <button type="button" onClick={() => setDel(a)}
                  className="py-2.5 text-rose-600 active:bg-rose-100 flex items-center justify-center gap-1 text-xs"
                  data-testid={`mobile-btn-delete-${a.id}`}>
                  <Trash2 className="h-3.5 w-3.5" /> حذف
                </button>
                <button type="button" onClick={() => openEdit(a)}
                  className="py-2.5 text-slate-700 active:bg-slate-200 flex items-center justify-center gap-1 text-xs"
                  data-testid={`mobile-btn-edit-${a.id}`}>
                  <Pencil className="h-3.5 w-3.5" /> تعديل
                </button>
                <button type="button" onClick={() => setVisitsAsset(a)}
                  className="py-2.5 text-blue-700 active:bg-blue-100 flex items-center justify-center gap-1 text-xs font-medium"
                  data-testid={`mobile-btn-visits-${a.id}`}>
                  <MapPin className="h-3.5 w-3.5" /> النشاط
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─────── DESKTOP TABLE (visible md+ only) ─────── */}
      <div className="hidden md:block border rounded-lg bg-white overflow-hidden shadow-sm">
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
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-600 hover:bg-blue-50"
                          title="الزيارات الميدانية والتذاكر"
                          onClick={() => setVisitsAsset(a)} data-testid={`btn-visits-${a.id}`}>
                          <MapPin className="h-3.5 w-3.5" />
                        </Button>
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

      <Dialog open={!!visitsAsset} onOpenChange={(o) => !o && setVisitsAsset(null)}>
        <DialogContent dir="rtl" className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-blue-600" />
              النشاط الميداني — {visitsAsset?.code} — {visitsAsset?.nameAr}
            </DialogTitle>
          </DialogHeader>
          {loadingHistory && <div className="text-center py-8 text-muted-foreground">جاري التحميل…</div>}
          {assetHistory && (
            <div className="space-y-4 text-sm">
              <div>
                <h4 className="font-semibold mb-2">تذاكر الخدمة الميدانية ({assetHistory.tickets.length})</h4>
                {assetHistory.tickets.length === 0 ? (
                  <p className="text-muted-foreground text-xs">لا توجد تذاكر مرتبطة بهذا الأصل</p>
                ) : (
                  <div className="border rounded overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50"><tr>
                        <th className="text-right p-2">رقم</th><th className="text-right p-2">العنوان</th>
                        <th className="text-right p-2">الأولوية</th><th className="text-right p-2">الحالة</th>
                        <th className="text-right p-2">فُتحت</th>
                      </tr></thead>
                      <tbody>
                        {assetHistory.tickets.map((t) => (
                          <tr key={t.id} className="border-t">
                            <td className="p-2 font-mono">{t.ticketNo}</td>
                            <td className="p-2">{t.title}</td>
                            <td className="p-2"><Badge variant="outline">{t.priority}</Badge></td>
                            <td className="p-2">{t.status}</td>
                            <td className="p-2">{new Date(t.openedAt).toLocaleDateString("ar-SA")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div>
                <h4 className="font-semibold mb-2">الزيارات الميدانية ({assetHistory.visits.length})</h4>
                {assetHistory.visits.length === 0 ? (
                  <p className="text-muted-foreground text-xs">لا توجد زيارات مسجلة</p>
                ) : (
                  <div className="border rounded overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50"><tr>
                        <th className="text-right p-2">الفني</th><th className="text-right p-2">الموقع</th>
                        <th className="text-right p-2">الوصول</th><th className="text-right p-2">الانصراف</th>
                        <th className="text-right p-2">المدة</th><th className="text-right p-2">النتيجة</th>
                      </tr></thead>
                      <tbody>
                        {assetHistory.visits.map((v: any) => (
                          <tr key={v.id} className="border-t">
                            <td className="p-2">{v.employeeName ?? "—"}</td>
                            <td className="p-2">{v.locationName ?? "—"}</td>
                            <td className="p-2">{new Date(v.arrivedAt).toLocaleString("ar-SA")}</td>
                            <td className="p-2">{v.leftAt ? new Date(v.leftAt).toLocaleString("ar-SA") : "—"}</td>
                            <td className="p-2">{v.durationMin ? `${v.durationMin} د` : "—"}</td>
                            <td className="p-2">{v.outcome ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="flex justify-end pt-2 border-t">
                <a href="/hr/field/tickets" className="text-xs text-blue-600 hover:underline">
                  فتح وحدة الخدمة الميدانية ←
                </a>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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

      {/* ─────── MOBILE FAB ─────── */}
      <button
        type="button"
        onClick={openNew}
        className="md:hidden fixed bottom-6 end-6 z-40 group"
        data-testid="mobile-fab-new-asset"
        aria-label="أصل جديد"
      >
        <span className="absolute inset-0 rounded-full bg-orange-500 opacity-30 group-active:opacity-0 animate-ping" />
        <span className="relative flex items-center justify-center h-14 w-14 rounded-full bg-gradient-to-br from-orange-500 to-orange-700 text-white shadow-lg shadow-orange-500/40 ring-4 ring-white active:scale-95 transition-transform">
          <Plus className="h-7 w-7" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
