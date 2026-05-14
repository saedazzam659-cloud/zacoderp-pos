import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ClipboardList, Plus, Trash2, MapPin, X } from "lucide-react";

interface ItemRow { locationId: string; purpose: string; notes: string; }

export default function FieldVisitPlans() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const { data: plans, isLoading } = useQuery({ queryKey: ["fsm-plans"], queryFn: () => fieldApi.listPlans({}) });
  const { data: employees } = useQuery<Array<{ id: number; nameAr: string }>>({
    queryKey: ["fsm-employees-all"],
    queryFn: async () => {
      const session = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const r = await fetch("/api/employees?status=active", {
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session}` } : {}),
          ...(acting ? { "x-acting-company-id": acting } : {}),
        },
      });
      return r.ok ? r.json() : [];
    },
  });
  const { data: locations } = useQuery({ queryKey: ["fsm-locations"], queryFn: () => fieldApi.listLocations({}) });

  const [employeeId, setEmployeeId] = useState<string>("");
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<ItemRow[]>([{ locationId: "", purpose: "site_visit", notes: "" }]);

  const create = useMutation({
    mutationFn: () => fieldApi.createPlan({
      employeeId: Number(employeeId),
      date,
      status: "published",
      items: items.filter((i) => i.locationId).map((i, idx) => ({
        sequenceNo: idx + 1,
        locationId: Number(i.locationId),
        purpose: i.purpose,
        notes: i.notes || undefined,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-plans"] });
      setOpen(false); setEmployeeId(""); setItems([{ locationId: "", purpose: "site_visit", notes: "" }]);
      toast({ title: "تم إنشاء الخطة" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: (id: number) => fieldApi.deletePlan(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fsm-plans"] }); toast({ title: "تم الحذف" }); },
  });

  return (
    <div className="p-6 space-y-4" dir="rtl" data-testid="page-field-plans">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ClipboardList className="h-6 w-6" /> خطط الزيارات اليومية</h1>
          <p className="text-sm text-muted-foreground mt-1">جدول الجولات للمندوبين والفنيين</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 ms-2" /> خطة جديدة</Button>
      </div>

      {isLoading ? <div className="text-center text-muted-foreground py-8">جاري التحميل...</div> : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {(plans ?? []).map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <Badge variant="outline" className="mb-1">{p.date}</Badge>
                  <div className="font-semibold">{p.employeeName}</div>
                  <Badge variant={p.status === "published" ? "default" : "secondary"} className="mt-1">{p.status}</Badge>
                </div>
                <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف الخطة؟")) del.mutate(p.id); }}>
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </Button>
              </div>
            </Card>
          ))}
          {(plans ?? []).length === 0 && <div className="col-span-full text-center text-muted-foreground py-12">لا توجد خطط بعد</div>}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>خطة زيارات جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div><Label>الموظف</Label>
                <Select value={employeeId} onValueChange={setEmployeeId}>
                  <SelectTrigger><SelectValue placeholder="اختر الموظف" /></SelectTrigger>
                  <SelectContent>
                    {(employees ?? []).map((e) => <SelectItem key={e.id} value={String(e.id)}>{e.nameAr}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>التاريخ</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>المواقع المخططة</Label>
                <Button size="sm" variant="outline" onClick={() => setItems([...items, { locationId: "", purpose: "site_visit", notes: "" }])}>
                  <Plus className="h-3 w-3 ms-1" /> إضافة موقع
                </Button>
              </div>
              {items.map((it, idx) => (
                <Card key={idx} className="p-3">
                  <div className="flex items-start gap-2">
                    <Badge variant="outline">{idx + 1}</Badge>
                    <div className="flex-1 space-y-2">
                      <Select value={it.locationId} onValueChange={(v) => {
                        const next = [...items]; next[idx] = { ...next[idx], locationId: v }; setItems(next);
                      }}>
                        <SelectTrigger><SelectValue placeholder="اختر الموقع" /></SelectTrigger>
                        <SelectContent>
                          {(locations ?? []).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input placeholder="ملاحظات (اختياري)" value={it.notes} onChange={(e) => {
                        const next = [...items]; next[idx] = { ...next[idx], notes: e.target.value }; setItems(next);
                      }} />
                    </div>
                    {items.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, i) => i !== idx))}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => create.mutate()} disabled={!employeeId || create.isPending}>إنشاء الخطة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
