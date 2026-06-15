import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi } from "@/lib/fieldServiceApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardList, Plus, Trash2, Search, Eye, X, MapPin, ExternalLink,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";

interface ItemRow { locationId: string; purpose: string; notes: string; }

const PURPOSES = [
  ["site_visit",   "زيارة موقع"],
  ["sales",        "مبيعات"],
  ["delivery",     "تسليم"],
  ["installation", "تركيب"],
  ["maintenance",  "صيانة"],
  ["inspection",   "تفتيش"],
  ["other",        "أخرى"],
] as const;

const STATUSES = [
  ["draft",     "مسودة",  "bg-slate-100 text-slate-700"],
  ["published", "منشورة", "bg-emerald-100 text-emerald-800"],
  ["completed", "مكتملة", "bg-blue-100 text-blue-800"],
  ["cancelled", "ملغاة",  "bg-rose-100 text-rose-800"],
] as const;

const today = () => new Date().toISOString().slice(0, 10);

export default function FieldVisitPlans() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [del, setDel] = useState<{ id: number; employeeName?: string; date: string } | null>(null);
  const [viewingId, setViewingId] = useState<number | null>(null);

  // form state
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(today());
  const [planNotes, setPlanNotes] = useState("");
  const [items, setItems] = useState<ItemRow[]>([{ locationId: "", purpose: "site_visit", notes: "" }]);

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["fsm-plans"],
    queryFn: () => fieldApi.listPlans({}),
  });

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

  const { data: locations } = useQuery({
    queryKey: ["fsm-locations"],
    queryFn: () => fieldApi.listLocations({}),
  });

  const { data: detail } = useQuery({
    queryKey: ["fsm-plan", viewingId],
    queryFn: () => viewingId ? fieldApi.getPlan(viewingId) : Promise.resolve(null),
    enabled: !!viewingId,
  });

  const filtered = useMemo(() => {
    return (plans ?? []).filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        p.employeeName?.toLowerCase().includes(q) ||
        p.date?.includes(q) ||
        p.status?.toLowerCase().includes(q)
      );
    });
  }, [plans, search, statusFilter]);

  function openNew() {
    setEmployeeId("");
    setDate(today());
    setPlanNotes("");
    setItems([{ locationId: "", purpose: "site_visit", notes: "" }]);
    setShowForm(true);
  }

  const createMut = useMutation({
    mutationFn: async () => {
      if (!employeeId) throw new Error("اختر الموظف");
      const validItems = items.filter((i) => i.locationId);
      if (validItems.length === 0) throw new Error("أضف موقعاً واحداً على الأقل");
      return fieldApi.createPlan({
        employeeId: Number(employeeId),
        date,
        status: "published",
        notes: planNotes || undefined,
        items: validItems.map((i, idx) => ({
          sequenceNo: idx + 1,
          locationId: Number(i.locationId),
          purpose: i.purpose,
          notes: i.notes || undefined,
        })),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-plans"] });
      toast({ title: "تم إنشاء الخطة" });
      setShowForm(false);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      return fieldApi.deletePlan(del.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-plans"] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl" data-testid="page-field-plans">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-emerald-600" />
            خطط الزيارات اليومية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            جدول الجولات للمندوبين والفنيين — {plans.length} خطة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-plan">
          <Plus className="h-4 w-4 ms-2" /> خطة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالموظف، التاريخ، الحالة…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="select-status-filter">
          <option value="">جميع الحالات</option>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} من {plans.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={Plus}
          title="خطة زيارات جديدة"
          subtitle="أضف الموظف والتاريخ ثم رتّب المواقع المخططة بالتسلسل"
          width="3xl"
          onClose={() => setShowForm(false)}
          onSave={() => createMut.mutate()}
          saving={createMut.isPending}
          saveLabel="إنشاء الخطة" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الموظف *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} data-testid="select-employee">
                <option value="">— اختر الموظف —</option>
                {(employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>التاريخ *</Label>
              <DateField value={date} onChange={(e) => setDate(e.target.value)} data-testid="input-date" />
            </div>
            <div className="md:col-span-2">
              <Label>ملاحظات (اختياري)</Label>
              <Input value={planNotes} onChange={(e) => setPlanNotes(e.target.value)} />
            </div>

            <div className="md:col-span-2 border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-base">المواقع المخططة *</Label>
                <Button type="button" size="sm" variant="outline"
                  onClick={() => setItems([...items, { locationId: "", purpose: "site_visit", notes: "" }])}
                  data-testid="btn-add-item">
                  <Plus className="h-3 w-3 ms-1" /> إضافة موقع
                </Button>
              </div>
              <div className="space-y-2">
                {items.map((it, idx) => (
                  <div key={idx} className="border rounded-md p-3 bg-muted/20 flex items-start gap-2">
                    <Badge variant="outline" className="mt-1 shrink-0 tabular-nums">{idx + 1}</Badge>
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
                      <select className="h-10 px-3 rounded-md border border-input bg-background text-sm md:col-span-1"
                        value={it.locationId}
                        onChange={(e) => {
                          const next = [...items]; next[idx] = { ...next[idx], locationId: e.target.value }; setItems(next);
                        }}
                        data-testid={`select-location-${idx}`}>
                        <option value="">— اختر الموقع —</option>
                        {(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                      <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                        value={it.purpose}
                        onChange={(e) => {
                          const next = [...items]; next[idx] = { ...next[idx], purpose: e.target.value }; setItems(next);
                        }}>
                        {PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <Input placeholder="ملاحظات (اختياري)" value={it.notes}
                        onChange={(e) => {
                          const next = [...items]; next[idx] = { ...next[idx], notes: e.target.value }; setItems(next);
                        }} />
                    </div>
                    {items.length > 1 && (
                      <Button type="button" size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50 shrink-0"
                        onClick={() => setItems(items.filter((_, i) => i !== idx))}
                        data-testid={`btn-remove-item-${idx}`}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم</th>
                <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
                <th className="px-3 py-2 text-start font-semibold">الموظف</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-start font-semibold">ملاحظات</th>
                <th className="px-3 py-2 text-center font-semibold w-28">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">لا توجد خطط بعد</td></tr>
              )}
              {filtered.map((p) => {
                const st = STATUSES.find(([v]) => v === p.status);
                return (
                  <tr key={p.id} className="hover:bg-emerald-50/40" data-testid={`row-plan-${p.id}`}>
                    <td className="px-3 py-2 font-mono font-bold">#{p.id}</td>
                    <td className="px-3 py-2 tabular-nums">{p.date}</td>
                    <td className="px-3 py-2 font-semibold">{p.employeeName ?? `#${p.employeeId}`}</td>
                    <td className="px-3 py-2">
                      {st
                        ? <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>
                        : <span className="text-muted-foreground">{p.status}</span>}
                    </td>
                    <td className="px-3 py-2 max-w-[260px] truncate" title={p.notes ?? ""}>{p.notes || "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => setViewingId(p.id)} data-testid={`btn-view-${p.id}`} title="عرض">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50"
                          onClick={() => setDel({ id: p.id, employeeName: p.employeeName, date: p.date })}
                          data-testid={`btn-delete-${p.id}`} title="حذف">
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
      {viewingId && detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewingId(null)}>
          <div className="bg-white rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-l from-emerald-600 to-emerald-700 text-white p-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <ClipboardList className="h-5 w-5" />
                  خطة زيارات #{detail.id}
                </h2>
                <p className="text-sm opacity-90 mt-1">
                  {detail.employeeName ?? `#${detail.employeeId}`} — {detail.date}
                  {" — "}
                  {STATUSES.find(s => s[0] === detail.status)?.[1] ?? detail.status}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setViewingId(null)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="p-4 space-y-4">
              {detail.notes && (
                <div className="text-sm">
                  <div className="text-xs text-muted-foreground mb-1">ملاحظات الخطة</div>
                  <p className="whitespace-pre-wrap">{detail.notes}</p>
                </div>
              )}

              <div>
                <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-emerald-600" />
                  المواقع ({detail.items?.length ?? 0})
                </div>
                <div className="border rounded-md overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-2 py-1.5 text-start font-semibold w-10">#</th>
                        <th className="px-2 py-1.5 text-start font-semibold">الموقع</th>
                        <th className="px-2 py-1.5 text-start font-semibold">الغرض</th>
                        <th className="px-2 py-1.5 text-start font-semibold">الحالة</th>
                        <th className="px-2 py-1.5 text-start font-semibold">ملاحظات</th>
                        <th className="px-2 py-1.5 text-center font-semibold w-12"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(detail.items ?? []).map((it) => {
                        const purposeLabel = PURPOSES.find(([v]) => v === it.purpose)?.[1] ?? it.purpose ?? "—";
                        const statusCls =
                          it.status === "done" ? "bg-emerald-100 text-emerald-800"
                          : it.status === "skipped" ? "bg-rose-100 text-rose-800"
                          : "bg-slate-100 text-slate-700";
                        const statusLabel =
                          it.status === "done" ? "تمّت"
                          : it.status === "skipped" ? "تخطّي"
                          : "قيد الانتظار";
                        return (
                          <tr key={it.id} className="hover:bg-slate-50/60">
                            <td className="px-2 py-1.5 font-mono">{it.sequenceNo}</td>
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{it.locationName ?? "—"}</div>
                              {it.address && <div className="text-[10px] text-muted-foreground">{it.address}</div>}
                            </td>
                            <td className="px-2 py-1.5">{purposeLabel}</td>
                            <td className="px-2 py-1.5">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${statusCls}`}>{statusLabel}</span>
                            </td>
                            <td className="px-2 py-1.5 max-w-[160px] truncate" title={it.notes ?? ""}>{it.notes || "—"}</td>
                            <td className="px-2 py-1.5 text-center">
                              {it.lat && it.lng && (
                                <a href={`https://www.google.com/maps?q=${it.lat},${it.lng}`} target="_blank" rel="noreferrer">
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-blue-700">
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {(!detail.items || detail.items.length === 0) && (
                        <tr><td colSpan={6} className="text-center py-4 text-muted-foreground">لا توجد مواقع</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الخطة؟</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف خطة <span className="font-bold">{del?.employeeName ?? "—"}</span> بتاريخ <span className="font-bold">{del?.date}</span> نهائياً.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
