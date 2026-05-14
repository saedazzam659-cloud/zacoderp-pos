import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi, type FieldLocation } from "@/lib/fieldServiceApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  MapPin, Plus, Pencil, Trash2, Search, Download, ExternalLink, Crosshair, Eye,
} from "lucide-react";

const TYPES = [
  ["office",    "مكتب",    "bg-blue-100 text-blue-800"],
  ["branch",    "فرع",     "bg-cyan-100 text-cyan-800"],
  ["customer",  "عميل",    "bg-emerald-100 text-emerald-800"],
  ["project",   "مشروع",   "bg-violet-100 text-violet-800"],
  ["asset",     "أصل",     "bg-amber-100 text-amber-800"],
  ["warehouse", "مستودع",  "bg-slate-100 text-slate-700"],
  ["supplier",  "مورد",    "bg-orange-100 text-orange-800"],
  ["other",     "أخرى",    "bg-zinc-100 text-zinc-700"],
] as const;

const EMPTY_FORM = {
  name: "", type: "customer",
  lat: "", lng: "", radiusM: "150",
  city: "", address: "",
  contactPerson: "", contactPhone: "",
  notes: "",
};

export default function FieldLocations() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<FieldLocation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<FieldLocation | null>(null);
  const [viewing, setViewing] = useState<FieldLocation | null>(null);

  const { data: locations = [], isLoading } = useQuery({
    queryKey: ["fsm-locations"],
    queryFn: () => fieldApi.listLocations({ includeInactive: true }),
  });

  const filtered = useMemo(() => {
    return (locations ?? []).filter((l) => {
      if (typeFilter && l.type !== typeFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        l.name?.toLowerCase().includes(q) ||
        l.city?.toLowerCase().includes(q) ||
        l.address?.toLowerCase().includes(q) ||
        l.contactPerson?.toLowerCase().includes(q) ||
        l.contactPhone?.toLowerCase().includes(q)
      );
    });
  }, [locations, search, typeFilter]);

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(l: FieldLocation) {
    setEditing(l);
    setForm({
      name: l.name ?? "",
      type: l.type ?? "customer",
      lat: String(l.lat ?? ""),
      lng: String(l.lng ?? ""),
      radiusM: String(l.radiusM ?? 150),
      city: l.city ?? "",
      address: l.address ?? "",
      contactPerson: l.contactPerson ?? "",
      contactPhone: l.contactPhone ?? "",
      notes: l.notes ?? "",
    });
    setShowForm(true);
  }

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      toast({ title: "المتصفح لا يدعم تحديد الموقع", variant: "destructive" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm((f) => ({ ...f, lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) })),
      (e) => toast({ title: "تعذر الحصول على الموقع", description: e.message, variant: "destructive" }),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("الاسم مطلوب");
      if (!form.lat || !form.lng) throw new Error("الإحداثيات مطلوبة");
      const body = {
        name: form.name.trim(),
        type: form.type,
        lat: Number(form.lat),
        lng: Number(form.lng),
        radiusM: Number(form.radiusM) || 150,
        city: form.city || null,
        address: form.address || null,
        contactPerson: form.contactPerson || null,
        contactPhone: form.contactPhone || null,
        notes: form.notes || null,
      };
      return editing
        ? fieldApi.updateLocation(editing.id, body as any)
        : fieldApi.createLocation(body as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-locations"] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      return fieldApi.deleteLocation(del.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-locations"] });
      toast({ title: "تم التعطيل" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر التعطيل", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  const importCust = useMutation({
    mutationFn: () => fieldApi.importCustomers(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["fsm-locations"] });
      toast({ title: `تم استيراد ${r.imported} موقع من ${r.total} عميل` });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 p-4" dir="rtl" data-testid="page-field-locations">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6 text-emerald-600" />
            سجل المواقع الميدانية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            المكاتب، الفروع، العملاء، المشاريع، الأصول والموردين — {locations.length} موقع
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => importCust.mutate()} disabled={importCust.isPending} data-testid="btn-import-customers">
            <Download className="h-4 w-4 ms-2" /> استيراد من العملاء
          </Button>
          <Button onClick={openNew} data-testid="btn-new-location">
            <Plus className="h-4 w-4 ms-2" /> موقع جديد
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، المدينة، العنوان، جهة الاتصال…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} data-testid="select-type-filter">
          <option value="">جميع الأنواع</option>
          {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} من {locations.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الموقع: ${editing.name}` : "موقع ميداني جديد"}
          subtitle={editing ? `النوع: ${TYPES.find(t => t[0] === editing.type)?.[1] ?? editing.type}` : "املأ بيانات الموقع — يمكنك التقاط الإحداثيات من جهازك"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الاسم *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-name" />
            </div>
            <div>
              <Label>النوع *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} data-testid="select-type">
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>خط العرض (lat) *</Label>
              <Input value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} data-testid="input-lat" />
            </div>
            <div>
              <Label>خط الطول (lng) *</Label>
              <Input value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} data-testid="input-lng" />
            </div>
            <div className="md:col-span-2">
              <Button type="button" variant="outline" size="sm" onClick={useCurrentLocation} data-testid="btn-current-location">
                <Crosshair className="h-4 w-4 ms-2" /> استخدم موقعي الحالي
              </Button>
            </div>
            <div>
              <Label>نصف القطر (متر)</Label>
              <Input type="number" min="10" value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} />
            </div>
            <div>
              <Label>المدينة</Label>
              <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <Label>العنوان</Label>
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <Label>اسم جهة الاتصال</Label>
              <Input value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
            </div>
            <div>
              <Label>هاتف</Label>
              <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
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
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">المدينة</th>
                <th className="px-3 py-2 text-start font-semibold">العنوان</th>
                <th className="px-3 py-2 text-start font-semibold">جهة الاتصال</th>
                <th className="px-3 py-2 text-start font-semibold">الإحداثيات</th>
                <th className="px-3 py-2 text-start font-semibold">نصف القطر</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-36">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد مواقع — أضف يدوياً أو استورد من العملاء</td></tr>
              )}
              {filtered.map((l) => {
                const tp = TYPES.find(([v]) => v === l.type);
                return (
                  <tr key={l.id} className="hover:bg-emerald-50/40" data-testid={`row-location-${l.id}`}>
                    <td className="px-3 py-2 font-semibold">{l.name}</td>
                    <td className="px-3 py-2">
                      {tp && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${tp[2]}`}>{tp[1]}</span>}
                    </td>
                    <td className="px-3 py-2">{l.city || "—"}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={l.address ?? ""}>{l.address || "—"}</td>
                    <td className="px-3 py-2">
                      {l.contactPerson || l.contactPhone ? (
                        <div>
                          {l.contactPerson && <div className="font-medium">{l.contactPerson}</div>}
                          {l.contactPhone && <div className="text-[10px] text-muted-foreground font-mono">{l.contactPhone}</div>}
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] tabular-nums">
                      {Number(l.lat).toFixed(5)}, {Number(l.lng).toFixed(5)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{l.radiusM} م</td>
                    <td className="px-3 py-2">
                      {l.isActive
                        ? <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800">نشط</span>
                        : <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600">معطّل</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => setViewing(l)} data-testid={`btn-view-${l.id}`} title="عرض">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <a href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noreferrer">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-700 hover:bg-blue-50" title="افتح في الخرائط">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                          onClick={() => openEdit(l)} data-testid={`btn-edit-${l.id}`} title="تعديل">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50"
                          onClick={() => setDel(l)} data-testid={`btn-delete-${l.id}`} title="تعطيل">
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

      {/* Detail viewer */}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-l from-emerald-600 to-emerald-700 text-white p-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  {viewing.name}
                </h2>
                <p className="text-sm opacity-90 mt-1">
                  {TYPES.find(t => t[0] === viewing.type)?.[1] ?? viewing.type}
                  {viewing.city ? ` — ${viewing.city}` : ""}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setViewing(null)}>
                إغلاق
              </Button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-4 text-sm">
              <div><div className="text-xs text-muted-foreground">العنوان</div><div className="font-medium">{viewing.address || "—"}</div></div>
              <div><div className="text-xs text-muted-foreground">الإحداثيات</div><div className="font-mono tabular-nums">{Number(viewing.lat).toFixed(6)}, {Number(viewing.lng).toFixed(6)}</div></div>
              <div><div className="text-xs text-muted-foreground">نصف القطر</div><div className="tabular-nums">{viewing.radiusM} متر</div></div>
              <div><div className="text-xs text-muted-foreground">الحالة</div><div>{viewing.isActive ? "نشط" : "معطّل"}</div></div>
              <div><div className="text-xs text-muted-foreground">جهة الاتصال</div><div>{viewing.contactPerson || "—"}</div></div>
              <div><div className="text-xs text-muted-foreground">الهاتف</div><div className="font-mono">{viewing.contactPhone || "—"}</div></div>
              {viewing.notes && (
                <div className="col-span-2"><div className="text-xs text-muted-foreground">ملاحظات</div><div>{viewing.notes}</div></div>
              )}
              <div className="col-span-2 pt-2 border-t flex gap-2">
                <a href={`https://www.google.com/maps?q=${viewing.lat},${viewing.lng}`} target="_blank" rel="noreferrer" className="flex-1">
                  <Button variant="outline" className="w-full">
                    <ExternalLink className="h-4 w-4 ms-2" /> افتح في خرائط Google
                  </Button>
                </a>
                <Button onClick={() => { setViewing(null); openEdit(viewing); }}>
                  <Pencil className="h-4 w-4 ms-2" /> تعديل
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تعطيل الموقع؟</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم تعطيل الموقع <span className="font-bold">{del?.name}</span> ولن يظهر في القوائم النشطة. يمكن إعادة تفعيله لاحقاً.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">
              تعطيل
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
