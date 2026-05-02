import { useState, useMemo } from "react";
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
import { Plus, Pencil, Trash2, Search, CalendarRange, Sparkles, LogIn, LogOut } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Booking = {
  id: number; docNumber: string;
  hotelId: number; hotelName?: string | null;
  roomId: number; roomNumber?: string | null;
  guestId: number; guestName?: string | null; guestPhone?: string | null;
  checkIn: string; checkOut: string;
  status: string; nightlyRate: string; nightsCount: number;
  totalPrice: string; aiSuggestedPrice: string | null;
  paidAmount: string; guestsCount: number;
  specialRequests: string | null; notes: string | null;
};

const STATUSES = [
  ["pending",      "قيد الانتظار",  "bg-amber-100 text-amber-800"],
  ["confirmed",    "مؤكَّد",         "bg-blue-100 text-blue-800"],
  ["checked_in",   "تم الدخول",     "bg-emerald-100 text-emerald-800"],
  ["checked_out",  "تم الخروج",     "bg-slate-100 text-slate-700"],
  ["cancelled",    "ملغي",          "bg-rose-100 text-rose-800"],
  ["no_show",      "لم يحضر",       "bg-rose-100 text-rose-800"],
] as const;

const EMPTY_FORM = {
  hotelId: "", guestId: "", roomId: "",
  checkIn: "", checkOut: "",
  status: "pending", nightlyRate: "0", totalPrice: "",
  paidAmount: "0", guestsCount: "1",
  specialRequests: "", notes: "",
};

export default function HotelBookings() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Booking | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Booking | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<{ price: number; explanation: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const { data: bookings = [], isLoading } = useQuery<Booking[]>({
    queryKey: ["hotel/bookings", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel/bookings?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الحجوزات");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: hotels = [] }  = useQuery<any[]>({
    queryKey: ["hotel/hotels", cid],
    queryFn: async () => (await fetch(`${API}/api/hotel/hotels?companyId=${cid}`, { headers })).json(),
    enabled: !!cid, staleTime: 60_000,
  });
  const { data: rooms = [] }   = useQuery<any[]>({
    queryKey: ["hotel/rooms", cid, form.hotelId],
    queryFn: async () => {
      const url = form.hotelId
        ? `${API}/api/hotel/rooms?companyId=${cid}&hotelId=${form.hotelId}`
        : `${API}/api/hotel/rooms?companyId=${cid}`;
      return (await fetch(url, { headers })).json();
    },
    enabled: !!cid, staleTime: 30_000,
  });
  const { data: guests = [] }  = useQuery<any[]>({
    queryKey: ["hotel/guests", cid],
    queryFn: async () => (await fetch(`${API}/api/hotel/guests?companyId=${cid}`, { headers })).json(),
    enabled: !!cid, staleTime: 30_000,
  });

  const filtered = bookings.filter(b => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      b.docNumber?.toLowerCase().includes(q) ||
      b.guestName?.includes(search) ||
      b.guestPhone?.includes(search) ||
      b.roomNumber?.toLowerCase().includes(q)
    );
  });

  const nights = useMemo(() => {
    if (!form.checkIn || !form.checkOut) return 0;
    const d = (new Date(form.checkOut).getTime() - new Date(form.checkIn).getTime()) / 86400000;
    return Math.max(0, Math.round(d));
  }, [form.checkIn, form.checkOut]);

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setAiSuggestion(null);
    setShowForm(true);
  }
  function openEdit(b: Booking) {
    setEditing(b);
    setForm({
      hotelId: String(b.hotelId), guestId: String(b.guestId), roomId: String(b.roomId),
      checkIn: b.checkIn, checkOut: b.checkOut,
      status: b.status, nightlyRate: b.nightlyRate ?? "0", totalPrice: b.totalPrice ?? "",
      paidAmount: b.paidAmount ?? "0", guestsCount: String(b.guestsCount ?? 1),
      specialRequests: b.specialRequests ?? "", notes: b.notes ?? "",
    });
    setAiSuggestion(b.aiSuggestedPrice ? { price: Number(b.aiSuggestedPrice), explanation: "" } : null);
    setShowForm(true);
  }

  async function fetchAiPrice() {
    if (!form.roomId || !form.checkIn || !form.checkOut) {
      toast({ title: "اختر الغرفة وحدد التواريخ أولاً", variant: "destructive" });
      return;
    }
    setAiLoading(true);
    try {
      const r = await fetch(`${API}/api/hotel-ai/dynamic-price`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: cid, roomId: Number(form.roomId),
          checkIn: form.checkIn, checkOut: form.checkOut,
        }),
      });
      if (!r.ok) throw new Error("فشل احتساب السعر");
      const data = await r.json();
      setAiSuggestion({ price: data.suggestedPrice, explanation: data.explanation || "" });
      setForm(f => ({
        ...f,
        nightlyRate: String(data.suggestedPrice),
        totalPrice: String(data.totalForStay ?? data.suggestedPrice * nights),
      }));
      toast({ title: "تم احتساب السعر بالذكاء الاصطناعي", description: `${data.suggestedPrice} ر.س / ليلة` });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.hotelId) throw new Error("الفندق مطلوب");
      if (!form.guestId) throw new Error("النزيل مطلوب");
      if (!form.roomId)  throw new Error("الغرفة مطلوبة");
      if (!form.checkIn || !form.checkOut) throw new Error("تاريخ الدخول والخروج مطلوبان");
      const body: any = { ...form, companyId: cid,
        hotelId: Number(form.hotelId), guestId: Number(form.guestId), roomId: Number(form.roomId),
        guestsCount: Number(form.guestsCount || 1),
        nightlyRate: form.nightlyRate || "0",
        paidAmount:  form.paidAmount  || "0",
        totalPrice:  form.totalPrice  || String(Number(form.nightlyRate || 0) * nights),
      };
      if (aiSuggestion) body.aiSuggestedPrice = aiSuggestion.price;
      const url = editing ? `${API}/api/hotel/bookings/${editing.id}` : `${API}/api/hotel/bookings`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/bookings", cid] });
      qc.invalidateQueries({ queryKey: ["hotel/rooms", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM); setAiSuggestion(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hotel/bookings/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotel/bookings", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  async function checkAction(b: Booking, kind: "checkin" | "checkout") {
    try {
      const r = await fetch(`${API}/api/hotel/bookings/${b.id}/${kind}?companyId=${cid}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل العملية"); }
      qc.invalidateQueries({ queryKey: ["hotel/bookings", cid] });
      qc.invalidateQueries({ queryKey: ["hotel/rooms", cid] });
      qc.invalidateQueries({ queryKey: ["hotel/housekeeping", cid] });
      toast({ title: kind === "checkin" ? "تم تسجيل الدخول" : "تم تسجيل الخروج" });
    } catch (e: any) { toast({ title: "خطأ", description: e?.message, variant: "destructive" }); }
  }

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-emerald-600" />
            الحجوزات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة الحجوزات وتسعير ديناميكي بالذكاء الاصطناعي — {bookings.length} حجز
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-booking" className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="h-4 w-4 ms-2" />
          حجز جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم الحجز، النزيل، الغرفة…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {bookings.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الحجز: ${editing.docNumber}` : "إضافة حجز جديد"}
          subtitle={editing ? `حالة: ${STATUSES.find(s => s[0] === editing.status)?.[1] ?? editing.status}` : "املأ بيانات الحجز — رقم الحجز يُولَّد تلقائياً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); setAiSuggestion(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الفندق *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.hotelId} onChange={(e) => setForm({ ...form, hotelId: e.target.value, roomId: "" })} data-testid="select-hotel">
                <option value="">— اختر الفندق —</option>
                {hotels.map((h: any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>النزيل *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.guestId} onChange={(e) => setForm({ ...form, guestId: e.target.value })} data-testid="select-guest">
                <option value="">— اختر النزيل —</option>
                {guests.map((g: any) => <option key={g.id} value={g.id}>{g.fullNameAr} {g.phone ? `(${g.phone})` : ""}</option>)}
              </select>
            </div>
            <div>
              <Label>الغرفة *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.roomId} onChange={(e) => {
                  const room = rooms.find((r: any) => String(r.id) === e.target.value);
                  setForm(f => ({
                    ...f, roomId: e.target.value,
                    nightlyRate: room ? String(room.basePrice) : f.nightlyRate,
                  }));
                }} data-testid="select-room">
                <option value="">— اختر الغرفة —</option>
                {rooms.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.roomNumber} ({r.roomType}) — {Number(r.basePrice).toLocaleString()} ر.س
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>عدد الضيوف</Label>
              <Input type="number" min="1" value={form.guestsCount} onChange={(e) => setForm({ ...form, guestsCount: e.target.value })} />
            </div>
            <div>
              <Label>تاريخ الدخول *</Label>
              <Input type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} data-testid="input-checkIn" />
            </div>
            <div>
              <Label>تاريخ الخروج *</Label>
              <Input type="date" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} data-testid="input-checkOut" />
            </div>
            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-2">
                <Label>السعر / ليلة (ر.س)</Label>
                <Button type="button" size="sm" variant="outline" disabled={aiLoading}
                  onClick={fetchAiPrice}
                  className="border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-700"
                  data-testid="btn-ai-price">
                  <Sparkles className="h-3.5 w-3.5 ms-1" />
                  {aiLoading ? "جارٍ احتساب…" : "احتسب بالذكاء الاصطناعي"}
                </Button>
              </div>
              <Input type="number" step="0.01" value={form.nightlyRate}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm(f => ({ ...f, nightlyRate: v, totalPrice: String(Number(v || 0) * nights) }));
                }} />
              {aiSuggestion && (
                <div className="mt-2 p-2 rounded bg-violet-50 border border-violet-200 text-[12px] text-violet-900">
                  <strong>اقتراح الذكاء الاصطناعي:</strong> {aiSuggestion.price.toLocaleString()} ر.س / ليلة
                  {aiSuggestion.explanation && <p className="mt-1 text-violet-800">{aiSuggestion.explanation}</p>}
                </div>
              )}
            </div>
            <div>
              <Label>عدد الليالي</Label>
              <Input value={String(nights)} readOnly className="bg-muted" />
            </div>
            <div>
              <Label>الإجمالي (ر.س)</Label>
              <Input type="number" step="0.01" value={form.totalPrice}
                onChange={(e) => setForm({ ...form, totalPrice: e.target.value })}
                placeholder={String(Number(form.nightlyRate || 0) * nights)} />
            </div>
            <div>
              <Label>المدفوع (ر.س)</Label>
              <Input type="number" step="0.01" value={form.paidAmount} onChange={(e) => setForm({ ...form, paidAmount: e.target.value })} />
            </div>
            <div>
              <Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>طلبات خاصة</Label>
              <Input value={form.specialRequests} onChange={(e) => setForm({ ...form, specialRequests: e.target.value })} />
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
                <th className="px-3 py-2 text-start font-semibold">رقم الحجز</th>
                <th className="px-3 py-2 text-start font-semibold">النزيل</th>
                <th className="px-3 py-2 text-start font-semibold">الفندق / الغرفة</th>
                <th className="px-3 py-2 text-start font-semibold">دخول</th>
                <th className="px-3 py-2 text-start font-semibold">خروج</th>
                <th className="px-3 py-2 text-start font-semibold">ليالي</th>
                <th className="px-3 py-2 text-start font-semibold">الإجمالي</th>
                <th className="px-3 py-2 text-start font-semibold">المدفوع</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-40">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">لا توجد حجوزات</td></tr>}
              {filtered.map((b) => {
                const st = STATUSES.find(([v]) => v === b.status);
                return (
                  <tr key={b.id} className="hover:bg-emerald-50/40" data-testid={`row-booking-${b.id}`}>
                    <td className="px-3 py-2 font-mono">{b.docNumber}</td>
                    <td className="px-3 py-2">
                      {b.guestName || "—"}
                      {b.guestPhone && <span className="block text-[10px] text-muted-foreground">{b.guestPhone}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {b.hotelName || "—"}
                      {b.roomNumber && <span className="block text-[10px] text-muted-foreground">غرفة {b.roomNumber}</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{b.checkIn}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{b.checkOut}</td>
                    <td className="px-3 py-2 text-center">{b.nightsCount}</td>
                    <td className="px-3 py-2 font-mono">{Number(b.totalPrice).toLocaleString("ar-SA")}</td>
                    <td className="px-3 py-2 font-mono">{Number(b.paidAmount).toLocaleString("ar-SA")}</td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        {b.status === "confirmed" || b.status === "pending" ? (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700 hover:bg-emerald-50" title="تسجيل دخول" onClick={() => checkAction(b, "checkin")}>
                            <LogIn className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                        {b.status === "checked_in" && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-700 hover:bg-blue-50" title="تسجيل خروج" onClick={() => checkAction(b, "checkout")}>
                            <LogOut className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(b)} data-testid={`btn-edit-${b.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(b)} data-testid={`btn-delete-${b.id}`}>
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
            <AlertDialogTitle>حذف الحجز</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الحجز «{del?.docNumber}» نهائياً؟
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
