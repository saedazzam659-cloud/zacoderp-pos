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
import { Plus, Pencil, Trash2, Search, BedDouble } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Room = {
  id: number; hotelId: number; hotelName?: string | null;
  roomNumber: string; roomType: string; basePrice: string;
  status: string; capacity: number; floor: string | null;
  features: string | null; notes: string | null;
};

const ROOM_TYPES = [
  ["single", "مفردة"], ["double", "مزدوجة"], ["twin", "توأمية"],
  ["triple", "ثلاثية"], ["suite", "جناح"], ["deluxe", "ديلوكس"], ["family", "عائلية"],
] as const;

const STATUSES = [
  ["available",      "متاحة",         "bg-emerald-100 text-emerald-800"],
  ["occupied",       "مشغولة",        "bg-rose-100 text-rose-800"],
  ["reserved",       "محجوزة",        "bg-amber-100 text-amber-800"],
  ["cleaning",       "تنظيف",         "bg-cyan-100 text-cyan-800"],
  ["maintenance",    "صيانة",         "bg-orange-100 text-orange-800"],
  ["out_of_service", "خارج الخدمة",  "bg-slate-200 text-slate-800"],
] as const;

const EMPTY_FORM = {
  hotelId: "", roomNumber: "", roomType: "double",
  basePrice: "0", status: "available",
  capacity: "2", floor: "", features: "", notes: "",
};

export default function HotelRooms() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [filterHotel, setFilterHotel] = useState<string>("");
  const [editing, setEditing] = useState<Room | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Room | null>(null);

  const { data: rooms = [], isLoading } = useQuery<Room[]>({
    queryKey: ["hotel/rooms", cid, filterHotel],
    queryFn: async () => {
      const url = filterHotel
        ? `${API}/api/hotel/rooms?companyId=${cid}&hotelId=${filterHotel}`
        : `${API}/api/hotel/rooms?companyId=${cid}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error("فشل تحميل الغرف");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: hotels = [] } = useQuery<any[]>({
    queryKey: ["hotel/hotels", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel/hotels?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const filtered = rooms.filter(r => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return r.roomNumber?.toLowerCase().includes(q) || r.floor?.toLowerCase().includes(q);
  });

  function openNew() { setEditing(null); setForm({ ...EMPTY_FORM, hotelId: filterHotel || "" }); setShowForm(true); }
  function openEdit(r: Room) {
    setEditing(r);
    setForm({
      hotelId: String(r.hotelId), roomNumber: r.roomNumber ?? "",
      roomType: r.roomType ?? "double", basePrice: r.basePrice ?? "0",
      status: r.status ?? "available", capacity: String(r.capacity ?? 2),
      floor: r.floor ?? "", features: r.features ?? "", notes: r.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.hotelId)    throw new Error("الفندق مطلوب");
      if (!form.roomNumber.trim()) throw new Error("رقم الغرفة مطلوب");
      const body = { ...form, companyId: cid,
        hotelId: Number(form.hotelId),
        capacity: Number(form.capacity || 2),
        basePrice: form.basePrice || "0",
      };
      const url = editing ? `${API}/api/hotel/rooms/${editing.id}` : `${API}/api/hotel/rooms`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/rooms", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hotel/rooms/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/rooms", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BedDouble className="h-6 w-6 text-cyan-600" />
            الغرف
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة الغرف والأسعار — {rooms.length} غرفة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-room" className="bg-cyan-600 hover:bg-cyan-700">
          <Plus className="h-4 w-4 ms-2" />
          غرفة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم الغرفة، الطابق…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          value={filterHotel} onChange={(e) => setFilterHotel(e.target.value)} data-testid="filter-hotel">
          <option value="">— كل الفنادق —</option>
          {hotels.map((h: any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rooms.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الغرفة: ${editing.roomNumber}` : "إضافة غرفة جديدة"}
          subtitle={editing ? `معرّف: ${editing.id}` : "املأ بيانات الغرفة"}
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
                value={form.hotelId} onChange={(e) => setForm({ ...form, hotelId: e.target.value })} data-testid="select-hotel">
                <option value="">— اختر الفندق —</option>
                {hotels.map((h: any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>رقم الغرفة *</Label>
              <Input value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} data-testid="input-roomNumber" placeholder="مثل 101" />
            </div>
            <div>
              <Label>نوع الغرفة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value })}>
                {ROOM_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>السعر الأساسي / ليلة (ر.س)</Label>
              <Input type="number" step="0.01" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: e.target.value })} />
            </div>
            <div>
              <Label>السعة (أشخاص)</Label>
              <Input type="number" min="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            </div>
            <div>
              <Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الطابق</Label>
              <Input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />
            </div>
            <div>
              <Label>المميزات</Label>
              <Input value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder="إطلالة بحرية، شرفة، واي فاي…" />
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
            <thead className="bg-gradient-to-b from-cyan-50 to-cyan-100 text-cyan-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم الغرفة</th>
                <th className="px-3 py-2 text-start font-semibold">الفندق</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">السعة</th>
                <th className="px-3 py-2 text-start font-semibold">السعر/ليلة</th>
                <th className="px-3 py-2 text-start font-semibold">الطابق</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد غرف</td></tr>}
              {filtered.map((r) => {
                const st = STATUSES.find(([v]) => v === r.status);
                const tp = ROOM_TYPES.find(([v]) => v === r.roomType)?.[1] ?? r.roomType;
                return (
                  <tr key={r.id} className="hover:bg-cyan-50/40" data-testid={`row-room-${r.id}`}>
                    <td className="px-3 py-2 font-mono font-bold">{r.roomNumber}</td>
                    <td className="px-3 py-2">{r.hotelName ?? "—"}</td>
                    <td className="px-3 py-2">{tp}</td>
                    <td className="px-3 py-2">{r.capacity}</td>
                    <td className="px-3 py-2 font-mono">{Number(r.basePrice).toLocaleString("ar-SA")} ر.س</td>
                    <td className="px-3 py-2">{r.floor || "—"}</td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(r)} data-testid={`btn-edit-${r.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(r)} data-testid={`btn-delete-${r.id}`}>
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
            <AlertDialogTitle>حذف الغرفة</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الغرفة «{del?.roomNumber}» نهائياً؟
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
