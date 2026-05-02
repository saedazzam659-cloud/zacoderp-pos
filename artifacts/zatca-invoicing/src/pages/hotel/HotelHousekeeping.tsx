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
import { Plus, Pencil, Trash2, Search, BrushCleaning } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Task = {
  id: number; docNumber: string;
  hotelId: number; hotelName?: string | null;
  roomId: number | null; roomNumber?: string | null;
  taskType: string; status: string; priority: string;
  assignedTo: string | null;
  scheduledAt: string | null; completedAt: string | null;
  notes: string | null;
};

const TASK_TYPES = [
  ["cleaning", "تنظيف"], ["linen_change", "تغيير الفُرش"],
  ["deep_clean", "تنظيف عميق"], ["inspection", "فحص"],
  ["restock", "إعادة تخزين"], ["other", "أخرى"],
] as const;

const STATUSES = [
  ["pending",     "قيد الانتظار", "bg-amber-100 text-amber-800"],
  ["in_progress", "قيد التنفيذ",  "bg-blue-100 text-blue-800"],
  ["done",        "مكتملة",       "bg-emerald-100 text-emerald-800"],
  ["skipped",     "متجاهَلة",      "bg-slate-100 text-slate-700"],
] as const;

const PRIORITIES = [
  ["low",    "منخفضة",  "bg-slate-100 text-slate-700"],
  ["medium", "متوسطة",  "bg-blue-100 text-blue-800"],
  ["high",   "عالية",   "bg-amber-100 text-amber-800"],
  ["urgent", "عاجلة",   "bg-rose-100 text-rose-800"],
] as const;

const EMPTY_FORM = {
  hotelId: "", roomId: "",
  taskType: "cleaning", status: "pending", priority: "medium",
  assignedTo: "", scheduledAt: "", notes: "",
};

export default function HotelHousekeeping() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Task | null>(null);

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ["hotel/housekeeping", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel/housekeeping?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المهام");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: hotels = [] } = useQuery<any[]>({
    queryKey: ["hotel/hotels", cid],
    queryFn: async () => (await fetch(`${API}/api/hotel/hotels?companyId=${cid}`, { headers })).json(),
    enabled: !!cid, staleTime: 60_000,
  });

  const { data: rooms = [] } = useQuery<any[]>({
    queryKey: ["hotel/rooms", cid, form.hotelId],
    queryFn: async () => {
      const url = form.hotelId
        ? `${API}/api/hotel/rooms?companyId=${cid}&hotelId=${form.hotelId}`
        : `${API}/api/hotel/rooms?companyId=${cid}`;
      return (await fetch(url, { headers })).json();
    },
    enabled: !!cid, staleTime: 30_000,
  });

  const filtered = tasks.filter(t => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      t.docNumber?.toLowerCase().includes(q) ||
      t.assignedTo?.toLowerCase().includes(q) ||
      t.roomNumber?.toLowerCase().includes(q)
    );
  });

  function openNew() { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); }
  function openEdit(t: Task) {
    setEditing(t);
    setForm({
      hotelId: String(t.hotelId), roomId: t.roomId ? String(t.roomId) : "",
      taskType: t.taskType, status: t.status, priority: t.priority,
      assignedTo: t.assignedTo ?? "",
      scheduledAt: t.scheduledAt ? t.scheduledAt.slice(0, 16) : "",
      notes: t.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.hotelId) throw new Error("الفندق مطلوب");
      const body: any = { ...form, companyId: cid,
        hotelId: Number(form.hotelId),
        roomId:  form.roomId ? Number(form.roomId) : null,
        scheduledAt: form.scheduledAt || null,
      };
      const url = editing ? `${API}/api/hotel/housekeeping/${editing.id}` : `${API}/api/hotel/housekeeping`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/housekeeping", cid] });
      qc.invalidateQueries({ queryKey: ["hotel/rooms", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hotel/housekeeping/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/housekeeping", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BrushCleaning className="h-6 w-6 text-amber-600" />
            خدمة الغرف والتدبير
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مهام التنظيف والصيانة اليومية — {tasks.length} مهمة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-task" className="bg-amber-600 hover:bg-amber-700">
          <Plus className="h-4 w-4 ms-2" />
          مهمة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم المهمة، الموظف، الغرفة…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {tasks.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل المهمة: ${editing.docNumber}` : "إضافة مهمة جديدة"}
          subtitle={editing ? `حالة: ${STATUSES.find(s => s[0] === editing.status)?.[1] ?? editing.status}` : "املأ بيانات المهمة"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الفندق *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.hotelId} onChange={(e) => setForm({ ...form, hotelId: e.target.value, roomId: "" })}>
                <option value="">— اختر الفندق —</option>
                {hotels.map((h: any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>الغرفة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                <option value="">— بدون غرفة محددة —</option>
                {rooms.map((r: any) => <option key={r.id} value={r.id}>{r.roomNumber} ({r.roomType})</option>)}
              </select>
            </div>
            <div>
              <Label>نوع المهمة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value })}>
                {TASK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الأولوية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
              <Label>الموظف المعيَّن</Label>
              <Input value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })} placeholder="اسم الموظف" />
            </div>
            <div>
              <Label>الموعد المجدول</Label>
              <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
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
            <thead className="bg-gradient-to-b from-amber-50 to-amber-100 text-amber-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم المهمة</th>
                <th className="px-3 py-2 text-start font-semibold">الفندق</th>
                <th className="px-3 py-2 text-start font-semibold">الغرفة</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">الأولوية</th>
                <th className="px-3 py-2 text-start font-semibold">الموظف</th>
                <th className="px-3 py-2 text-start font-semibold">الموعد</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد مهام</td></tr>}
              {filtered.map((t) => {
                const st = STATUSES.find(([v]) => v === t.status);
                const pr = PRIORITIES.find(([v]) => v === t.priority);
                const tt = TASK_TYPES.find(([v]) => v === t.taskType)?.[1] ?? t.taskType;
                return (
                  <tr key={t.id} className="hover:bg-amber-50/40" data-testid={`row-task-${t.id}`}>
                    <td className="px-3 py-2 font-mono">{t.docNumber}</td>
                    <td className="px-3 py-2">{t.hotelName || "—"}</td>
                    <td className="px-3 py-2 font-mono">{t.roomNumber || "—"}</td>
                    <td className="px-3 py-2">{tt}</td>
                    <td className="px-3 py-2">
                      {pr && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${pr[2]}`}>{pr[1]}</span>}
                    </td>
                    <td className="px-3 py-2">{t.assignedTo || "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{t.scheduledAt ? new Date(t.scheduledAt).toLocaleString("ar-SA") : "—"}</td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المهمة</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف المهمة «{del?.docNumber}» نهائياً؟
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
