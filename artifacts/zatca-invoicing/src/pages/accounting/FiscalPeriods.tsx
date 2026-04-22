import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, CalendarRange, Plus, Trash2, Lock, LockOpen, ShieldOff,
  CheckCircle2, AlertTriangle, Calendar as CalIcon, Hash, X, Sparkles,
  Layers, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Status = "open" | "closed" | "permanently_closed";
type FiscalYear = {
  id: number; companyId: number; name: string;
  startDate: string; endDate: string; status: Status;
};
type FiscalPeriod = {
  id: number; companyId: number; fiscalYearId: number;
  name: string; startDate: string; endDate: string;
  status: Status; sequence: number;
};

const STATUS_META: Record<Status, { label: string; cls: string; icon: any }> = {
  open:                { label: "مفتوحة",      cls: "bg-emerald-100 text-emerald-700 border-emerald-300", icon: LockOpen },
  closed:              { label: "مغلقة",       cls: "bg-amber-100 text-amber-800 border-amber-300",       icon: Lock },
  permanently_closed:  { label: "مغلقة نهائياً", cls: "bg-red-100 text-red-700 border-red-300",            icon: ShieldOff },
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const isISO = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

export default function FiscalPeriods() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  const [showNew, setShowNew] = useState(false);
  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // ─── Queries ───────────────────────────────────────────────
  const { data: years = [], isLoading: yearsLoading } = useQuery<FiscalYear[]>({
    queryKey: ["fiscal-years"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/years`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const effectiveYearId = selectedYearId ?? years[0]?.id ?? null;

  const { data: detail } = useQuery<{ year: FiscalYear; periods: FiscalPeriod[] }>({
    queryKey: ["fiscal-year", effectiveYearId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/years/${effectiveYearId}`, { headers });
      if (!r.ok) throw new Error("not found");
      return r.json();
    },
    enabled: effectiveYearId != null,
  });

  // ─── Mutations ─────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: async (form: { name: string; startDate: string; endDate: string }) => {
      const r = await fetch(`${API}/api/fiscal/years`, {
        method: "POST", headers, body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "فشل الإنشاء");
      return d;
    },
    onSuccess: (d: any) => {
      toast({ title: "تم إنشاء السنة المالية", description: `تم إنشاء ${d.periods?.length ?? 0} فترة شهرية بنجاح` });
      setShowNew(false);
      setSelectedYearId(d.year?.id ?? null);
      qc.invalidateQueries({ queryKey: ["fiscal-years"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const periodStatusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: Status }) => {
      const r = await fetch(`${API}/api/fiscal/periods/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "فشل التحديث");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم تحديث حالة الفترة" });
      qc.invalidateQueries({ queryKey: ["fiscal-year", effectiveYearId] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const yearStatusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: Status }) => {
      const r = await fetch(`${API}/api/fiscal/years/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "فشل التحديث");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم تحديث حالة السنة المالية" });
      qc.invalidateQueries({ queryKey: ["fiscal-years"] });
      qc.invalidateQueries({ queryKey: ["fiscal-year", effectiveYearId] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/fiscal/years/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "فشل الحذف");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم حذف السنة المالية" });
      setConfirmDeleteId(null);
      setSelectedYearId(null);
      qc.invalidateQueries({ queryKey: ["fiscal-years"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-white shadow-md">
            <CalendarRange className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">الفترات المالية</h1>
            <p className="text-sm text-muted-foreground">
              إدارة السنوات المالية وفتراتها الشهرية
            </p>
          </div>
        </div>
        <Button
          size="lg"
          onClick={() => setShowNew(true)}
          className="gap-2 bg-gradient-to-l from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-md"
        >
          <Plus className="h-5 w-5" />
          سنة مالية جديدة
        </Button>
      </div>

      {/* ─── New fiscal year inline form ─── */}
      {showNew && <NewYearForm onSubmit={createMut.mutate} onCancel={() => setShowNew(false)} pending={createMut.isPending} />}

      {/* ─── Empty state ─── */}
      {!yearsLoading && years.length === 0 && !showNew && (
        <Card><CardContent className="py-16 text-center">
          <CalendarRange className="h-16 w-16 mx-auto mb-3 opacity-20" />
          <p className="text-lg font-semibold mb-1">لا توجد سنوات مالية</p>
          <p className="text-sm text-muted-foreground mb-4">ابدأ بإنشاء أول سنة مالية لشركتك</p>
          <Button onClick={() => setShowNew(true)} className="gap-2">
            <Plus className="h-4 w-4" /> إنشاء سنة مالية
          </Button>
        </CardContent></Card>
      )}

      {years.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5">

          {/* ─── Years sidebar ─── */}
          <Card className="h-fit lg:sticky lg:top-4 max-h-[calc(100vh-6rem)] overflow-hidden flex flex-col">
            <div className="p-3 border-b bg-muted/30 flex items-center justify-between">
              <span className="text-sm font-semibold flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                السنوات المالية
              </span>
              <Badge variant="secondary" className="text-xs h-5">{years.length}</Badge>
            </div>
            <div className="overflow-y-auto flex-1 p-2 space-y-1">
              {years.map(y => {
                const isSel = y.id === effectiveYearId;
                const sm = STATUS_META[y.status];
                const SIcon = sm.icon;
                return (
                  <button
                    key={y.id}
                    onClick={() => setSelectedYearId(y.id)}
                    className={cn(
                      "w-full text-right p-2.5 rounded-lg border transition-all",
                      isSel
                        ? "bg-gradient-to-l from-indigo-50 to-purple-50 border-indigo-300 shadow-sm dark:from-indigo-950/40 dark:to-purple-950/40"
                        : "bg-card hover:bg-muted/50 border-transparent",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className={cn("font-semibold text-sm truncate", isSel && "text-indigo-700 dark:text-indigo-400")}>
                          {y.name}
                        </p>
                        <p className="text-[11px] text-muted-foreground font-mono" dir="ltr">
                          {y.startDate} → {y.endDate}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn("shrink-0 text-[10px] h-5 px-1.5 gap-1", sm.cls)}>
                        <SIcon className="h-2.5 w-2.5" /> {sm.label}
                      </Badge>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* ─── Year detail ─── */}
          <div className="space-y-4">
            {detail && <YearDetail
              detail={detail}
              onPeriodStatus={(id, status) => periodStatusMut.mutate({ id, status })}
              onYearStatus={(id, status) => yearStatusMut.mutate({ id, status })}
              onDelete={() => setConfirmDeleteId(detail.year.id)}
              periodPending={periodStatusMut.isPending}
              yearPending={yearStatusMut.isPending}
              confirmDeleteId={confirmDeleteId}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={() => detail && deleteMut.mutate(detail.year.id)}
              deletePending={deleteMut.isPending}
            />}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New year form ────────────────────────────────────────────────────────
function NewYearForm({
  onSubmit, onCancel, pending,
}: {
  onSubmit: (f: { name: string; startDate: string; endDate: string }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({
    name: `السنة المالية ${currentYear}`,
    startDate: `${currentYear}-01-01`,
    endDate: `${currentYear}-12-31`,
  });

  const periodsCount = useMemo(() => {
    if (!isISO(form.startDate) || !isISO(form.endDate)) return 0;
    const s = new Date(form.startDate); const e = new Date(form.endDate);
    if (e <= s) return 0;
    return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
  }, [form.startDate, form.endDate]);

  return (
    <Card className="border-2 border-indigo-300 dark:border-indigo-800">
      <div className="bg-gradient-to-l from-indigo-50 to-purple-50 dark:from-indigo-950/40 dark:to-purple-950/40 p-4 border-b border-indigo-200 dark:border-indigo-900 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h3 className="font-bold">سنة مالية جديدة</h3>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}><X className="h-4 w-4" /></Button>
      </div>
      <CardContent className="p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-3">
            <Label className="flex items-center gap-1 mb-1.5"><Hash className="h-3.5 w-3.5" /> اسم السنة المالية</Label>
            <Input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="مثال: السنة المالية 2026"
            />
          </div>
          <div>
            <Label className="flex items-center gap-1 mb-1.5"><CalIcon className="h-3.5 w-3.5" /> تاريخ البداية</Label>
            <Input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} />
          </div>
          <div>
            <Label className="flex items-center gap-1 mb-1.5"><CalIcon className="h-3.5 w-3.5" /> تاريخ النهاية</Label>
            <Input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <div>
            <Label className="flex items-center gap-1 mb-1.5">عدد الفترات الشهرية</Label>
            <div className="h-10 px-3 rounded-md border bg-muted/30 flex items-center gap-2">
              <Layers className="h-4 w-4 text-indigo-600" />
              <span className="font-bold text-lg">{periodsCount}</span>
              <span className="text-xs text-muted-foreground">فترة</span>
            </div>
          </div>
        </div>

        <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 dark:bg-indigo-950/30 dark:border-indigo-900 dark:text-indigo-300 rounded-md px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            سيتم تقسيم السنة تلقائياً إلى فترات شهرية متتابعة بدون فجوات ولا تداخل، وكل فترة تبدأ بحالة <b>مفتوحة</b>.
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={onCancel}>إلغاء</Button>
          <Button
            onClick={() => onSubmit(form)}
            disabled={pending || !form.name.trim() || !isISO(form.startDate) || !isISO(form.endDate) || periodsCount === 0}
            className="gap-2 bg-gradient-to-l from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            إنشاء وتقسيم تلقائي
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Year detail ──────────────────────────────────────────────────────────
function YearDetail({
  detail, onPeriodStatus, onYearStatus, onDelete, periodPending, yearPending,
  confirmDeleteId, onCancelDelete, onConfirmDelete, deletePending,
}: {
  detail: { year: FiscalYear; periods: FiscalPeriod[] };
  onPeriodStatus: (id: number, status: Status) => void;
  onYearStatus: (id: number, status: Status) => void;
  onDelete: () => void;
  periodPending: boolean; yearPending: boolean;
  confirmDeleteId: number | null;
  onCancelDelete: () => void; onConfirmDelete: () => void; deletePending: boolean;
}) {
  const { year, periods } = detail;
  const sm = STATUS_META[year.status];
  const SIcon = sm.icon;
  const yearLocked = year.status === "permanently_closed";
  const stats = useMemo(() => ({
    open:  periods.filter(p => p.status === "open").length,
    closed: periods.filter(p => p.status === "closed").length,
    perm:  periods.filter(p => p.status === "permanently_closed").length,
  }), [periods]);

  return (
    <>
      {/* Year header */}
      <Card className="overflow-hidden border-2 border-indigo-200 dark:border-indigo-900">
        <div className="bg-gradient-to-l from-indigo-50 via-purple-50 to-pink-50 dark:from-indigo-950/40 dark:via-purple-950/40 dark:to-pink-950/40 p-5 border-b border-indigo-200 dark:border-indigo-900">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-3 rounded-xl bg-white shadow-sm">
                <CalendarRange className="h-6 w-6 text-indigo-600" />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold text-xl truncate">{year.name}</h2>
                <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                  {year.startDate} → {year.endDate}
                </p>
              </div>
            </div>
            <Badge className={cn("text-sm px-3 py-1.5 gap-1.5", sm.cls)}>
              <SIcon className="h-3.5 w-3.5" /> {sm.label}
            </Badge>
          </div>
        </div>

        <CardContent className="p-4">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <StatBox label="فترات مفتوحة" value={stats.open} cls="from-emerald-500 to-green-500 text-emerald-600 bg-emerald-50 border-emerald-200" />
            <StatBox label="فترات مغلقة"  value={stats.closed} cls="from-amber-500 to-orange-500 text-amber-600 bg-amber-50 border-amber-200" />
            <StatBox label="مغلقة نهائياً" value={stats.perm} cls="from-red-500 to-rose-500 text-red-600 bg-red-50 border-red-200" />
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t">
            {!yearLocked && year.status === "open" && (
              <Button size="sm" variant="outline" disabled={yearPending}
                onClick={() => onYearStatus(year.id, "closed")} className="gap-1.5">
                <Lock className="h-3.5 w-3.5" /> إغلاق السنة
              </Button>
            )}
            {!yearLocked && year.status === "closed" && (
              <Button size="sm" variant="outline" disabled={yearPending}
                onClick={() => onYearStatus(year.id, "open")} className="gap-1.5">
                <LockOpen className="h-3.5 w-3.5" /> إعادة فتح السنة
              </Button>
            )}
            {!yearLocked && (
              <Button size="sm" variant="outline" disabled={yearPending}
                onClick={() => onYearStatus(year.id, "permanently_closed")}
                className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50">
                <ShieldOff className="h-3.5 w-3.5" /> إغلاق نهائي
              </Button>
            )}
            <div className="flex-1" />
            {confirmDeleteId === year.id ? (
              <div className="flex items-center gap-2 bg-red-50 border border-red-300 rounded-md px-3 py-1">
                <span className="text-xs text-red-700 font-medium">تأكيد الحذف؟</span>
                <Button size="sm" variant="ghost" onClick={onCancelDelete} className="h-7 px-2">إلغاء</Button>
                <Button size="sm" variant="destructive" onClick={onConfirmDelete} disabled={deletePending} className="h-7 px-2 gap-1">
                  {deletePending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  تأكيد
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={onDelete}
                className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50">
                <Trash2 className="h-3.5 w-3.5" /> حذف السنة
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Periods grid */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-4 w-4 text-indigo-500" />
            <h3 className="font-semibold">الفترات الشهرية</h3>
            <Badge variant="secondary" className="text-xs h-5">{periods.length}</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {periods.map(p => (
              <PeriodCard
                key={p.id}
                period={p}
                disabled={periodPending}
                onChangeStatus={(status) => onPeriodStatus(p.id, status)}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function StatBox({ label, value, cls }: { label: string; value: number; cls: string }) {
  const parts = cls.split(" ");
  return (
    <div className={cn("p-3 rounded-xl border", parts.slice(2).join(" "))}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className={cn("p-1.5 rounded-md bg-gradient-to-br text-white", parts.slice(0, 2).join(" "))}>
          <Hash className="h-3 w-3" />
        </div>
      </div>
      <div className="font-bold text-2xl mt-1">{value}</div>
    </div>
  );
}

function PeriodCard({ period, disabled, onChangeStatus }: {
  period: FiscalPeriod; disabled: boolean;
  onChangeStatus: (status: Status) => void;
}) {
  const sm = STATUS_META[period.status];
  const SIcon = sm.icon;
  const locked = period.status === "permanently_closed";

  return (
    <div className={cn(
      "rounded-xl border p-3 space-y-2 transition-all",
      period.status === "open"   && "bg-emerald-50/40 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-950/20",
      period.status === "closed" && "bg-amber-50/40 border-amber-200 hover:border-amber-300 dark:bg-amber-950/20",
      period.status === "permanently_closed" && "bg-red-50/40 border-red-200 dark:bg-red-950/20 opacity-90",
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md bg-white border flex items-center justify-center text-xs font-bold text-indigo-600 shrink-0">
            {period.sequence}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{period.name}</p>
            <p className="text-[11px] text-muted-foreground font-mono" dir="ltr">
              {period.startDate} → {period.endDate}
            </p>
          </div>
        </div>
        <Badge className={cn("text-[10px] h-5 px-1.5 gap-1 shrink-0", sm.cls)}>
          <SIcon className="h-2.5 w-2.5" /> {sm.label}
        </Badge>
      </div>

      {!locked && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-current/10">
          {period.status === "open" && (
            <Button size="sm" variant="outline" disabled={disabled}
              onClick={() => onChangeStatus("closed")}
              className="h-7 text-xs gap-1 flex-1">
              <Lock className="h-3 w-3" /> إغلاق
            </Button>
          )}
          {period.status === "closed" && (
            <Button size="sm" variant="outline" disabled={disabled}
              onClick={() => onChangeStatus("open")}
              className="h-7 text-xs gap-1 flex-1">
              <LockOpen className="h-3 w-3" /> إعادة فتح
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={disabled}
            onClick={() => onChangeStatus("permanently_closed")}
            className="h-7 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50 flex-1">
            <ShieldOff className="h-3 w-3" /> إغلاق نهائي
          </Button>
        </div>
      )}
      {locked && (
        <div className="flex items-center gap-1 text-[11px] text-red-700 pt-1.5 border-t border-current/10">
          <ShieldOff className="h-3 w-3" />
          <span>لا يمكن التعديل على هذه الفترة</span>
        </div>
      )}
    </div>
  );
}
