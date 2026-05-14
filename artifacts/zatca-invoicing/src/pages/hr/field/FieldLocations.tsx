import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi, type FieldLocation } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { MapPin, Plus, Trash2, Download, ExternalLink, Crosshair } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  office: "مكتب", branch: "فرع", customer: "عميل", project: "مشروع",
  asset: "أصل", warehouse: "مستودع", supplier: "مورد", other: "أخرى",
};
const TYPE_COLOR: Record<string, string> = {
  office: "bg-blue-500", branch: "bg-cyan-500", customer: "bg-emerald-500",
  project: "bg-violet-500", asset: "bg-amber-500", warehouse: "bg-slate-500",
  supplier: "bg-orange-500", other: "bg-zinc-500",
};

export default function FieldLocations() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filterType, setFilterType] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<FieldLocation>>({ type: "customer", radiusM: 150 });

  const { data, isLoading } = useQuery({
    queryKey: ["fsm-locations", filterType],
    queryFn: () => fieldApi.listLocations({ type: filterType || undefined }),
  });

  const create = useMutation({
    mutationFn: (b: any) => fieldApi.createLocation(b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-locations"] });
      setOpen(false);
      setForm({ type: "customer", radiusM: 150 });
      toast({ title: "تم إضافة الموقع" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: (id: number) => fieldApi.deleteLocation(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fsm-locations"] }); toast({ title: "تم التعطيل" }); },
  });

  const importCust = useMutation({
    mutationFn: () => fieldApi.importCustomers(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["fsm-locations"] });
      toast({ title: `تم استيراد ${r.imported} موقع من ${r.total} عميل` });
    },
  });

  const useCurrentLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm((f) => ({ ...f, lat: String(pos.coords.latitude) as any, lng: String(pos.coords.longitude) as any })),
      (e) => toast({ title: "تعذر الحصول على الموقع", description: e.message, variant: "destructive" }),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = () => {
    if (!form.name || !form.lat || !form.lng) {
      toast({ title: "املأ الاسم والإحداثيات", variant: "destructive" }); return;
    }
    create.mutate({
      ...form,
      lat: Number(form.lat), lng: Number(form.lng),
      radiusM: Number(form.radiusM ?? 150),
    });
  };

  return (
    <div className="p-6 space-y-4" dir="rtl" data-testid="page-field-locations">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><MapPin className="h-6 w-6" /> سجل المواقع الميدانية</h1>
          <p className="text-sm text-muted-foreground mt-1">المكاتب، الفروع، العملاء، المشاريع، الأصول والموردين</p>
        </div>
        <div className="flex gap-2">
          <Select value={filterType || "all"} onValueChange={(v) => setFilterType(v === "all" ? "" : v)}>
            <SelectTrigger className="w-40"><SelectValue placeholder="كل الأنواع" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأنواع</SelectItem>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => importCust.mutate()} disabled={importCust.isPending}>
            <Download className="h-4 w-4 ms-2" /> استيراد من العملاء
          </Button>
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 ms-2" /> موقع جديد</Button>
        </div>
      </div>

      {isLoading ? <div className="text-center text-muted-foreground py-8">جاري التحميل...</div> : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {(data ?? []).map((l) => (
            <Card key={l.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge className={`${TYPE_COLOR[l.type] ?? "bg-zinc-500"} text-white`}>{TYPE_LABEL[l.type] ?? l.type}</Badge>
                    {!l.isActive && <Badge variant="secondary">معطّل</Badge>}
                  </div>
                  <div className="font-semibold truncate">{l.name}</div>
                  {l.address && <div className="text-xs text-muted-foreground truncate">{l.address}</div>}
                  {l.contactPhone && <div className="text-xs text-muted-foreground mt-1">📞 {l.contactPhone}</div>}
                  <div className="text-xs text-muted-foreground mt-1">نصف القطر: {l.radiusM} م</div>
                </div>
                <div className="flex flex-col gap-1">
                  <a href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="ghost"><ExternalLink className="h-4 w-4" /></Button>
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => { if (confirm("تعطيل هذا الموقع؟")) del.mutate(l.id); }}>
                    <Trash2 className="h-4 w-4 text-rose-500" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
          {(data ?? []).length === 0 && <div className="col-span-full text-center text-muted-foreground py-12">لا توجد مواقع — أضف يدوياً أو استورد من العملاء</div>}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>موقع ميداني جديد</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>الاسم</Label><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>النوع</Label>
              <Select value={form.type ?? "customer"} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(TYPE_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>خط العرض (lat)</Label><Input value={(form.lat as any) ?? ""} onChange={(e) => setForm({ ...form, lat: e.target.value as any })} /></div>
              <div><Label>خط الطول (lng)</Label><Input value={(form.lng as any) ?? ""} onChange={(e) => setForm({ ...form, lng: e.target.value as any })} /></div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={useCurrentLocation}>
              <Crosshair className="h-4 w-4 ms-2" /> استخدم موقعي الحالي
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>نصف القطر (متر)</Label><Input type="number" value={form.radiusM ?? 150} onChange={(e) => setForm({ ...form, radiusM: Number(e.target.value) })} /></div>
              <div><Label>المدينة</Label><Input value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
            </div>
            <div><Label>العنوان</Label><Input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>اسم جهة الاتصال</Label><Input value={form.contactPerson ?? ""} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} /></div>
              <div><Label>هاتف</Label><Input value={form.contactPhone ?? ""} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={submit} disabled={create.isPending}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
