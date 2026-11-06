import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Printer, RefreshCw, Search, UserRoundCheck, Plus, Trash2, Save } from "lucide-react";
import { api, type PosSession, type PosShiftSettings } from "@/lib/api";
import {
  openPosShiftPrintWindow,
  printPosShiftReport,
  type PosShiftCashReport,
  type PosShiftDetail,
} from "@/lib/posShiftPrint";

type ManagedShift = PosSession & {
  user?: { id: number; username?: string | null; nameAr?: string | null } | null;
  branch?: { id: number; nameAr?: string | null } | null;
  cashBox?: { id: number; nameAr?: string | null } | null;
  totalSales?: number;
  invoiceCount?: number;
};

const money = (value: unknown) => `${Number(value || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
const defaultPolicy: PosShiftSettings = {
  enabled: false,
  enforceSchedule: false,
  graceMinutes: 15,
  allowOutsideSchedule: false,
  timeZone: "Asia/Riyadh",
  shifts: [],
  openUserIds: [],
  closeUserIds: [],
};
type UserOption = { id: number; username: string; nameAr?: string | null; role: string; isActive?: boolean };

export default function ShiftManagementTab({ companyId }: { companyId: number }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"all" | "open" | "closed">("open");
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [language] = useState<"ar" | "en">("ar");
  const [policyDraft, setPolicyDraft] = useState<PosShiftSettings>(defaultPolicy);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyFeedback, setPolicyFeedback] = useState("");

  const policyQ = useQuery({
    queryKey: ["pos-shift-policy", companyId],
    queryFn: async () => (await api.getPosSettings(companyId)).posShiftSettings ?? defaultPolicy,
    enabled: companyId > 0,
  });
  const usersQ = useQuery({
    queryKey: ["pos-shift-policy-users", companyId],
    queryFn: () => api.request<UserOption[]>("GET", `/api/users?companyId=${companyId}`),
    enabled: companyId > 0,
  });
  useEffect(() => {
    if (policyQ.data) setPolicyDraft({ ...defaultPolicy, ...policyQ.data });
  }, [policyQ.data]);

  const shiftsQ = useQuery({
    queryKey: ["pos-shift-management", companyId, status, branchId, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ companyId: String(companyId) });
      if (status !== "all") params.set("status", status);
      if (branchId) params.set("branchId", branchId);
      if (from) params.set("from", `${from}T00:00:00`);
      if (to) params.set("to", to);
      return api.request<ManagedShift[]>("GET", `/api/pos-sessions?${params}`);
    },
    enabled: companyId > 0,
    staleTime: 10_000,
  });

  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (shiftsQ.data ?? []).filter(row => {
      if (!q) return true;
      return [row.user?.nameAr, row.user?.username, row.branch?.nameAr, row.cashBox?.nameAr, String(row.id)]
        .some(value => String(value ?? "").toLocaleLowerCase().includes(q));
    });
  }, [shiftsQ.data, query]);

  const totals = useMemo(() => rows.reduce((sum, row) => ({
    sales: sum.sales + Number(row.totalSales || 0),
    invoices: sum.invoices + Number(row.invoiceCount || 0),
  }), { sales: 0, invoices: 0 }), [rows]);

  const savePolicy = async () => {
    setPolicyBusy(true);
    setPolicyFeedback("");
    try {
      const saved = await api.request<{ posShiftSettings: PosShiftSettings }>(
        "PATCH", `/api/companies/${companyId}/pos-settings`, { posShiftSettings: policyDraft },
      );
      setPolicyDraft({ ...defaultPolicy, ...saved.posShiftSettings });
      await qc.invalidateQueries({ queryKey: ["pos-shift-policy", companyId] });
      setPolicyFeedback("تم حفظ إعدادات الورديات.");
    } catch (cause: any) {
      setPolicyFeedback(cause?.message || "تعذّر حفظ إعدادات الورديات.");
    } finally {
      setPolicyBusy(false);
    }
  };

  const toggleUser = (key: "openUserIds" | "closeUserIds", id: number, checked: boolean) => {
    setPolicyDraft(current => ({
      ...current,
      [key]: checked
        ? [...new Set([...current[key], id])]
        : current[key].filter(userId => userId !== id),
    }));
  };

  const openReport = async (shift: ManagedShift) => {
    const printWindow = openPosShiftPrintWindow(language);
    if (!printWindow) {
      setError("اسمح بفتح النوافذ المنبثقة لعرض تقرير الوردية.");
      return;
    }
    try {
      const [detail, cash] = await Promise.all([
        api.request<PosShiftDetail>("GET", `/api/pos-sessions/${shift.id}`),
        api.request<PosShiftCashReport>("GET", `/api/pos-sessions/${shift.id}/cash-movements`),
      ]);
      printPosShiftReport(printWindow, detail, cash, language);
    } catch (cause: any) {
      printWindow.close();
      setError(cause?.message || "تعذّر تحميل تقرير الوردية.");
    }
  };

  const closeForCashier = async (shift: ManagedShift) => {
    if (!window.confirm(`إغلاق وردية ${shift.user?.nameAr || shift.user?.username || `#${shift.userId}`}؟ سيتم تسجيلها كإغلاق إداري.`)) return;
    setError("");
    setNotice("");
    setBusyId(shift.id);
    const printWindow = openPosShiftPrintWindow(language);
    if (!printWindow) {
      setBusyId(null);
      setError("اسمح بفتح النوافذ المنبثقة لإغلاق الوردية وطباعة تقريرها.");
      return;
    }
    try {
      const cash = await api.request<PosShiftCashReport>("GET", `/api/pos-sessions/${shift.id}/cash-movements`);
      const rawCount = window.prompt(
        `الوردية #${shift.id} — النقد المتوقع ${cash.expectedCash.toFixed(2)} ر.س\nأدخل النقد الفعلي بعد الجرد:`,
        cash.expectedCash.toFixed(2),
      );
      if (rawCount === null) {
        printWindow.close();
        return;
      }
      const countedCash = Number(rawCount);
      if (!Number.isFinite(countedCash) || countedCash < 0 ||
          Math.abs(countedCash * 100 - Math.round(countedCash * 100)) > 0.000001) {
        printWindow.close();
        setError("أدخل مبلغًا صحيحًا لا يقل عن صفر وبحد أقصى منزلتين عشريتين.");
        return;
      }
      const closed = await api.closePosSession(shift.id, {
        closingCash: countedCash,
        notes: "إغلاق إداري لوردية موظف آخر",
      });
      const detail = await api.request<PosShiftDetail>("GET", `/api/pos-sessions/${shift.id}`);
      printPosShiftReport(printWindow, {
        ...detail,
        closedAt: closed.closedAt,
        closingCash: closed.closingCash,
        difference: closed.difference,
      }, cash, language);
      setNotice(`تم إغلاق الوردية #${shift.id} وطباعة تقرير التسوية.`);
      await qc.invalidateQueries({ queryKey: ["pos-shift-management"] });
    } catch (cause: any) {
      printWindow.close();
      setError(cause?.message || "تعذّر إغلاق الوردية.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-4" dir="rtl" aria-label="إدارة الورديات">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4" aria-labelledby="pos-shift-policy-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="pos-shift-policy-title" className="font-black">إعدادات الورديات</h2><p className="mt-1 text-xs text-muted-foreground">القيود الجديدة اختيارية، ولا تغيّر سلوك الشركات قبل تفعيلها.</p></div>
          <button type="button" disabled={policyBusy || policyQ.isLoading} onClick={() => void savePolicy()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50"><Save className="size-4" />{policyBusy ? "جارٍ الحفظ..." : "حفظ الإعدادات"}</button>
        </div>
        {policyQ.isError && <p role="alert" className="text-sm text-destructive">تعذّر تحميل إعدادات الورديات. أعد المحاولة.</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm font-bold"><input type="checkbox" checked={policyDraft.enabled} onChange={e => setPolicyDraft(p => ({ ...p, enabled: e.target.checked }))} /> تفعيل إعدادات الورديات</label>
          <label className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm font-bold"><input type="checkbox" checked={policyDraft.enforceSchedule} onChange={e => setPolicyDraft(p => ({ ...p, enforceSchedule: e.target.checked }))} /> تقييد الفتح بالمواعيد</label>
          <label className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm font-bold"><input type="checkbox" checked={policyDraft.allowOutsideSchedule} onChange={e => setPolicyDraft(p => ({ ...p, allowOutsideSchedule: e.target.checked }))} /> السماح للمدير بالفتح خارج الموعد</label>
          <label className="text-xs font-bold">فترة السماح (دقيقة)<input type="number" min="0" max="180" value={policyDraft.graceMinutes} onChange={e => setPolicyDraft(p => ({ ...p, graceMinutes: Math.max(0, Math.min(180, Number(e.target.value) || 0)) }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
          <label className="text-xs font-bold">المنطقة الزمنية
            <select value={policyDraft.timeZone} onChange={e => setPolicyDraft(p => ({ ...p, timeZone: e.target.value }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
              <option value="Asia/Riyadh">السعودية — الرياض</option><option value="Africa/Cairo">مصر — القاهرة</option>
            </select>
          </label>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-sm font-black">مواعيد الورديات (حتى ٨)</h3><button type="button" disabled={policyDraft.shifts.length >= 8} onClick={() => setPolicyDraft(p => ({ ...p, shifts: [...p.shifts, { id: `shift-${Date.now()}`, nameAr: `وردية ${p.shifts.length + 1}`, startTime: "08:00", endTime: "16:00" }] }))} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-bold disabled:opacity-50"><Plus className="size-4" /> إضافة وردية</button></div>
          {policyDraft.shifts.length === 0 ? <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">لم تُضف مواعيد. أضف وردية قبل تفعيل تقييد المواعيد.</p> : policyDraft.shifts.map((shift, index) => (
            <div key={shift.id} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <label className="text-xs font-bold">اسم الوردية<input value={shift.nameAr} maxLength={80} onChange={e => setPolicyDraft(p => ({ ...p, shifts: p.shifts.map((item, i) => i === index ? { ...item, nameAr: e.target.value } : item) }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              <label className="text-xs font-bold">البداية<input type="time" value={shift.startTime} onChange={e => setPolicyDraft(p => ({ ...p, shifts: p.shifts.map((item, i) => i === index ? { ...item, startTime: e.target.value } : item) }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              <label className="text-xs font-bold">النهاية<input type="time" value={shift.endTime} onChange={e => setPolicyDraft(p => ({ ...p, shifts: p.shifts.map((item, i) => i === index ? { ...item, endTime: e.target.value } : item) }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
              <button type="button" aria-label="حذف الوردية" onClick={() => setPolicyDraft(p => ({ ...p, shifts: p.shifts.filter((_, i) => i !== index) }))} className="self-end rounded-lg p-2 text-destructive hover:bg-destructive/10"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(["openUserIds", "closeUserIds"] as const).map((key) => (
            <fieldset key={key} className="space-y-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-black">{key === "openUserIds" ? "المخولون بفتح الوردية" : "المخولون بإغلاق الوردية"}</legend>
              <p className="text-[11px] text-muted-foreground">عدم تحديد مستخدمين يعني السماح لجميع المستخدمين حسب صلاحياتهم المعتادة.</p>
              {usersQ.isLoading ? <Loader2 className="size-4 animate-spin" /> : (usersQ.data ?? []).filter(user => user.isActive !== false).map(user => (
                <label key={user.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policyDraft[key].includes(user.id)} onChange={e => toggleUser(key, user.id, e.target.checked)} />{user.nameAr || user.username} · {user.role}</label>
              ))}
            </fieldset>
          ))}
        </div>
        {policyFeedback && <p role="status" className="text-sm text-primary">{policyFeedback}</p>}
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        <Summary label="عدد الورديات" value={String(rows.length)} />
        <Summary label="الفواتير المرحلة" value={String(totals.invoices)} />
        <Summary label="إجمالي المبيعات" value={money(totals.sales)} />
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3">
        <label className="min-w-36 flex-1 text-xs font-bold">الحالة
          <select value={status} onChange={event => setStatus(event.target.value as typeof status)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
            <option value="open">مفتوحة</option><option value="closed">مغلقة</option><option value="all">الكل</option>
          </select>
        </label>
        <label className="min-w-36 flex-1 text-xs font-bold">رقم الفرع
          <input value={branchId} onChange={event => setBranchId(event.target.value.replace(/\D/g, ""))} placeholder="كل الفروع" className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" />
        </label>
        <label className="min-w-36 flex-1 text-xs font-bold">من تاريخ
          <input type="date" value={from} onChange={event => setFrom(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" />
        </label>
        <label className="min-w-36 flex-1 text-xs font-bold">إلى تاريخ
          <input type="date" value={to} onChange={event => setTo(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" />
        </label>
        <label className="min-w-48 flex-[2] text-xs font-bold">بحث
          <span className="relative mt-1 block"><Search className="absolute right-3 top-3 size-4 text-muted-foreground" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="الكاشير أو الخزنة أو رقم الوردية" className="h-10 w-full rounded-lg border border-border bg-background pr-9 pl-3 text-sm" /></span>
        </label>
        <button type="button" onClick={() => void shiftsQ.refetch()} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-bold hover:bg-muted"><RefreshCw className="size-4" /> تحديث</button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-800">{notice}</p>}
      {shiftsQ.isLoading ? <div className="flex justify-center p-10"><Loader2 className="size-6 animate-spin" /></div> : shiftsQ.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">تعذّر تحميل الورديات. تحقق من صلاحياتك ثم أعد المحاولة.</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">لا توجد ورديات مطابقة للفلاتر.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[850px] text-right text-sm">
            <thead className="bg-muted/60 text-xs"><tr>{["رقم", "الحالة", "اسم الوردية", "الكاشير", "الفرع", "الخزنة", "بداية الوردية", "الفواتير", "المبيعات", "إجراءات"].map(label => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-3 py-3 font-mono font-bold">#{row.id}</td>
                  <td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${row.status === "open" ? "bg-amber-500/15 text-amber-800" : "bg-emerald-500/15 text-emerald-800"}`}>{row.status === "open" ? "مفتوحة" : row.status === "force_closed" ? "إغلاق إداري" : "مغلقة"}</span></td>
                  <td className="px-3 py-3">{row.shiftName || "—"}</td>
                  <td className="px-3 py-3">{row.user?.nameAr || row.user?.username || `مستخدم ${row.userId}`}</td>
                  <td className="px-3 py-3">{row.branch?.nameAr || "—"}</td>
                  <td className="px-3 py-3">{row.cashBox?.nameAr || "—"}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{new Date(row.openedAt).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-3">{row.invoiceCount ?? 0}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{money(row.totalSales)}</td>
                  <td className="px-3 py-3"><div className="flex gap-2">
                    <button type="button" onClick={() => void openReport(row)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-bold"><Printer className="size-3.5" /> تقرير</button>
                    {row.status === "open" && <button type="button" disabled={busyId === row.id} onClick={() => void closeForCashier(row)} className="inline-flex items-center gap-1 rounded-lg bg-primary px-2 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-60">{busyId === row.id ? <Loader2 className="size-3.5 animate-spin" /> : <UserRoundCheck className="size-3.5" />} إغلاق</button>}
                    <button type="button" onClick={() => void openReport(row)} aria-label={`عرض تقرير الوردية ${row.id}`} className="grid size-8 place-items-center rounded-lg hover:bg-muted"><Eye className="size-4" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><strong className="mt-1 block text-lg">{value}</strong></div>;
}
