import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Clock3, Loader2, Plus, Users, X } from "lucide-react";
import { api, type Branch, type RRestaurantReservation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function localDateTime(value = new Date()) {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function statusText(status: RRestaurantReservation["status"]) {
  return ({
    confirmed: "مؤكد",
    waiting: "بانتظار التسكين",
    seated: "تم التسكين",
    cancelled: "ملغي",
    no_show: "لم يحضر",
  })[status];
}

export default function RestaurantReservationsTab({ branches }: { branches: Branch[] }) {
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState("");
  const [kind, setKind] = useState<"reservation" | "waitlist">("reservation");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [guestCount, setGuestCount] = useState(2);
  const [scheduledAt, setScheduledAt] = useState(() => localDateTime(new Date(Date.now() + 60 * 60_000)));
  const [durationMinutes, setDurationMinutes] = useState(90);
  const [tableId, setTableId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const selectedBranch = Number(branchId) || undefined;

  useEffect(() => {
    if (!branchId && branches.length) setBranchId(String(branches[0].id));
  }, [branchId, branches]);

  const reservationsQ = useQuery({
    queryKey: ["r-reservations", selectedBranch],
    queryFn: () => api.rReservations(selectedBranch),
    enabled: !!selectedBranch,
    refetchInterval: 15_000,
  });
  const tablesQ = useQuery({
    queryKey: ["r-tables", "reservations", selectedBranch],
    queryFn: () => api.rTables(),
    enabled: !!selectedBranch,
  });
  const create = useMutation({
    mutationFn: () => api.rCreateReservation({
      branchId: selectedBranch!,
      kind,
      tableId: tableId ? Number(tableId) : null,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim() || undefined,
      guestCount,
      scheduledAt: new Date(scheduledAt).toISOString(),
      durationMinutes: kind === "reservation" ? durationMinutes : 30,
      notes: notes.trim() || undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["r-reservations"] });
      setCustomerName("");
      setCustomerPhone("");
      setNotes("");
      setTableId("");
      setError("");
    },
    onError: (err: Error) => setError(err.message || "تعذّر حفظ السجل"),
  });
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "seated" | "cancelled" | "no_show" }) =>
      api.rUpdateReservationStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["r-reservations"] }),
  });

  const activeRows = (reservationsQ.data ?? [])
    .filter(row => ["confirmed", "waiting"].includes(row.status))
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const tables = (tablesQ.data ?? []).filter(table => table.branchId === selectedBranch && table.isActive);

  function submit() {
    setError("");
    if (!selectedBranch || !customerName.trim() || !scheduledAt || guestCount < 1 || guestCount > 50) {
      setError("أدخل الفرع والاسم والموعد وعدد الضيوف بشكل صحيح.");
      return;
    }
    create.mutate();
  }

  return (
    <section className="space-y-5" aria-label="الحجوزات وقائمة الانتظار">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">الحجوزات وقائمة الانتظار</h2>
          <p className="mt-1 text-sm text-muted-foreground">سجّل الحجز أو أضف الضيف لقائمة الانتظار دون فتح طلب أو فاتورة.</p>
        </div>
        <label className="min-w-48 text-sm font-bold">الفرع
          <select value={branchId} onChange={e => setBranchId(e.target.value)} className="mt-1 block h-10 w-full rounded-xl border border-input bg-background px-3">
            {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.nameAr}</option>)}
          </select>
        </label>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-4 flex gap-2">
            <Button type="button" variant={kind === "reservation" ? "default" : "outline"} onClick={() => setKind("reservation")} className="flex-1">حجز مسبق</Button>
            <Button type="button" variant={kind === "waitlist" ? "default" : "outline"} onClick={() => { setKind("waitlist"); setScheduledAt(localDateTime()); setTableId(""); }} className="flex-1">قائمة انتظار</Button>
          </div>
          <div className="space-y-3">
            <label className="block text-sm font-bold">اسم العميل<Input value={customerName} onChange={e => setCustomerName(e.target.value)} maxLength={150} className="mt-1 h-10" /></label>
            <label className="block text-sm font-bold">رقم التواصل (اختياري)<Input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} inputMode="tel" maxLength={40} className="mt-1 h-10" /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-bold">عدد الضيوف<Input type="number" min={1} max={50} value={guestCount} onChange={e => setGuestCount(Number(e.target.value))} className="mt-1 h-10" /></label>
              <label className="block text-sm font-bold">الطاولة (اختياري)
                <select value={tableId} onChange={e => setTableId(e.target.value)} className="mt-1 block h-10 w-full rounded-xl border border-input bg-background px-3">
                  <option value="">تحديد لاحقاً</option>
                  {tables.filter(table => table.capacity >= guestCount).map(table => <option key={table.id} value={table.id}>{table.nameAr} · {table.code}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-sm font-bold">{kind === "waitlist" ? "وقت الوصول المتوقع" : "موعد الحجز"}
              <Input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} className="mt-1 h-10" />
            </label>
            {kind === "reservation" && <label className="block text-sm font-bold">مدة الحجز بالدقائق
              <Input type="number" min={15} max={360} step={15} value={durationMinutes} onChange={e => setDurationMinutes(Number(e.target.value))} className="mt-1 h-10" />
            </label>}
            <label className="block text-sm font-bold">ملاحظات (اختياري)<textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} className="mt-1 min-h-20 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm font-normal" /></label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="button" onClick={submit} disabled={create.isPending || !selectedBranch} className="w-full font-bold">
              {create.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Plus className="me-2 h-4 w-4" />}
              {kind === "waitlist" ? "إضافة لقائمة الانتظار" : "حفظ الحجز"}
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="border-b border-border p-4 font-black">السجلات النشطة <span className="text-sm font-semibold text-muted-foreground">({activeRows.length})</span></div>
          {updateStatus.isError && <p role="alert" className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">تعذّر تحديث الحالة. أعد المحاولة.</p>}
          {reservationsQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div> :
            reservationsQ.isError ? <div role="alert" className="p-6 text-sm text-destructive">تعذّر تحميل السجلات. <button className="underline" onClick={() => reservationsQ.refetch()}>أعد المحاولة</button></div> :
            activeRows.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">لا توجد حجوزات أو أسماء في قائمة الانتظار.</div> :
            <div className="divide-y divide-border">
              {activeRows.map(row => (
                <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 font-bold">
                      <span>{row.customerName}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${row.kind === "waitlist" ? "bg-amber-100 text-amber-800" : "bg-primary/10 text-primary"}`}>{row.kind === "waitlist" ? "انتظار" : "حجز"}</span>
                      <span className="text-xs text-muted-foreground">{statusText(row.status)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" />{new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.scheduledAt))}</span>
                      <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{row.guestCount}</span>
                      {row.customerPhone && <span>{row.customerPhone}</span>}
                      {row.tableId && <span>طاولة #{row.tableId}</span>}
                    </div>
                    {row.notes && <p className="mt-1 truncate text-xs text-muted-foreground">{row.notes}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="outline" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ id: row.id, status: "seated" })} aria-label="تسجيل وصول العميل"><Check className="h-4 w-4" /> تم التسكين</Button>
                    {row.kind === "reservation" && <Button type="button" size="sm" variant="ghost" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ id: row.id, status: "no_show" })} aria-label="تسجيل عدم الحضور"><Clock3 className="h-4 w-4" /></Button>}
                    <Button type="button" size="sm" variant="ghost" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ id: row.id, status: "cancelled" })} aria-label="إلغاء السجل"><X className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </article>
              ))}
            </div>}
        </div>
      </div>
    </section>
  );
}
