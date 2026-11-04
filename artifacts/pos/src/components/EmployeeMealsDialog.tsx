import { useEffect, useMemo, useState } from "react";
import { Loader2, Utensils, X } from "lucide-react";
import { api, type AuthUser } from "@/lib/api";

type Employee = { id: number; code: string; nameAr: string; department?: string | null; jobTitle?: string | null };
type Account = { id: number; code: string; nameAr: string; accountType: string; isPosting?: boolean; isActive?: boolean };
type Settings = { dailyLimit: number; unitCost: string; expenseAccountId: number; clearingAccountId: number };
type Meal = { id: number; mealDate: string; mealType: string; count: number; unitCost: string; totalCost: string; journalEntryId: number | null; employee: Employee; creator?: { nameAr?: string | null; username?: string | null } | null };
type Props = { open: boolean; onClose: () => void; companyId: number; user: AuthUser | null };
const today = () => new Date().toISOString().slice(0, 10);

export default function EmployeeMealsDialog({ open, onClose, companyId, user }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [mealType, setMealType] = useState("غداء");
  const [count, setCount] = useState("1");
  const [date, setDate] = useState(today());
  const [dailyLimit, setDailyLimit] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [clearingAccountId, setClearingAccountId] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  const mealTypes = ["إفطار", "غداء", "عشاء", "وجبة إضافية"];
  const mealTotal = useMemo(() => meals.reduce((sum, row) => sum + Number(row.totalCost || 0), 0), [meals]);

  const loadMeals = async (start = from, end = to) => {
    const rows = await api.request<Meal[]>("GET", `/api/pos-employee-meals?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`);
    setMeals(rows);
  };

  useEffect(() => {
    if (!open || !companyId) return;
    let active = true;
    setError(""); setNotice("");
    void Promise.all([
      api.request<Employee[]>("GET", "/api/pos-employee-meals/employees"),
      api.request<Settings | null>("GET", "/api/pos-employee-meals/settings"),
      api.request<Account[]>("GET", `/api/accounts?companyId=${companyId}`),
      api.request<Meal[]>("GET", `/api/pos-employee-meals?from=${today()}&to=${today()}`),
    ]).then(([employeeRows, config, accountRows, mealRows]) => {
      if (!active) return;
      setEmployees(employeeRows); setSettings(config); setAccounts(accountRows);
      setMeals(mealRows);
      if (config) {
        setDailyLimit(String(config.dailyLimit)); setUnitCost(String(config.unitCost));
        setExpenseAccountId(String(config.expenseAccountId)); setClearingAccountId(String(config.clearingAccountId));
      }
    }).catch((e: any) => { if (active) setError(e?.message || "تعذّر تحميل بيانات الوجبات."); });
    return () => { active = false; };
  }, [open, companyId]);

  if (!open) return null;

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.request<Settings>("PUT", "/api/pos-employee-meals/settings", {
        dailyLimit: Number(dailyLimit), unitCost: Number(unitCost),
        expenseAccountId: Number(expenseAccountId), clearingAccountId: Number(clearingAccountId),
      });
      setSettings(saved); setNotice("تم حفظ إعدادات الوجبات.");
    } catch (e: any) { setError(e?.message || "تعذّر حفظ الإعدادات."); }
    finally { setBusy(false); }
  };

  const issueMeal = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await api.request("POST", "/api/pos-employee-meals", {
        employeeId: Number(employeeId), date, mealType, count: Number(count),
      });
      setNotice("تم تسجيل الوجبة وإنشاء قيد مسودة لمراجعته وترحيله وفق صلاحيات المحاسبة.");
      await loadMeals(date, date);
      setFrom(date); setTo(date); setCount("1");
    } catch (e: any) { setError(e?.message || "تعذّر تسجيل الوجبة."); }
    finally { setBusy(false); }
  };

  const activeAccounts = accounts.filter((account) => account.isPosting !== false && account.isActive !== false);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-3" dir="rtl" role="dialog" aria-modal="true" aria-label="وجبات الموظفين">
      <section className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-5 py-4">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Utensils className="size-5" /></span><div><h2 className="text-lg font-black">وجبات الموظفين</h2><p className="text-xs text-muted-foreground">تسجيل الكمية والتكلفة دون خصم مخزون أو نقدية</p></div></div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="grid size-9 place-items-center rounded-lg hover:bg-muted"><X className="size-4" /></button>
        </header>
        <div className="grid gap-5 p-5 lg:grid-cols-2">
          <form onSubmit={issueMeal} className="space-y-3 rounded-xl border border-border p-4">
            <h3 className="font-bold">تسجيل صرف وجبة</h3>
            <label className="block text-xs font-bold">الموظف<select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="">اختر الموظف</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.nameAr} — {employee.code}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-bold">نوع الوجبة<select value={mealType} onChange={(e) => setMealType(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">{mealTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label className="block text-xs font-bold">العدد<input type="number" min="1" max="20" step="1" required value={count} onChange={(e) => setCount(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
            </div>
            <label className="block text-xs font-bold">التاريخ<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
            <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">التكلفة الحالية: {settings ? `${Number(settings.unitCost).toFixed(2)} × ${Number(count) || 0}` : "اضبط التكلفة أولاً"} · الحد اليومي: {settings?.dailyLimit ?? "—"}</p>
            <button disabled={busy || !settings || employees.length === 0} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">{busy && <Loader2 className="size-4 animate-spin" />}تسجيل الوجبة</button>
          </form>
          {isAdmin && <form onSubmit={saveSettings} className="space-y-3 rounded-xl border border-border p-4">
            <h3 className="font-bold">إعداد التكلفة والحد</h3>
            <label className="block text-xs font-bold">الحد اليومي لكل موظف<input type="number" min="1" max="20" step="1" required value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
            <label className="block text-xs font-bold">التكلفة الثابتة للوجبة<input type="number" min="0.01" step="0.01" required value={unitCost} onChange={(e) => setUnitCost(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
            <label className="block text-xs font-bold">حساب مصروف الوجبات<select required value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="">اختر حساب المصروف</option>{activeAccounts.filter((a) => a.accountType === "expense").map((a) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}</select></label>
            <label className="block text-xs font-bold">حساب التسوية<select required value={clearingAccountId} onChange={(e) => setClearingAccountId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="">اختر حساب التسوية</option>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}</select></label>
            <button disabled={busy} className="h-10 w-full rounded-lg border border-primary/30 font-bold text-primary disabled:opacity-50">حفظ الإعدادات</button>
          </form>}
          <section className="space-y-3 lg:col-span-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs font-bold">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9 rounded-lg border border-border bg-background px-2" /></label>
              <label className="text-xs font-bold">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9 rounded-lg border border-border bg-background px-2" /></label>
              <button type="button" onClick={() => void loadMeals(from, to).catch((e: any) => setError(e.message))} className="h-9 rounded-lg border border-border px-3 text-xs font-bold">عرض التقرير</button>
              <strong className="mr-auto text-sm">إجمالي التكلفة: {mealTotal.toFixed(2)}</strong>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[650px] text-right text-xs"><thead className="bg-muted/60"><tr>{["التاريخ","الموظف","الوجبة","العدد","تكلفة الوحدة","الإجمالي","المسجل","القيد"].map((x) => <th key={x} className="p-3 font-bold">{x}</th>)}</tr></thead><tbody>
                {meals.map((meal) => <tr key={meal.id} className="border-t border-border"><td className="p-3">{meal.mealDate}</td><td className="p-3">{meal.employee.nameAr}</td><td className="p-3">{meal.mealType}</td><td className="p-3">{meal.count}</td><td className="p-3">{Number(meal.unitCost).toFixed(2)}</td><td className="p-3">{Number(meal.totalCost).toFixed(2)}</td><td className="p-3">{meal.creator?.nameAr || meal.creator?.username || "—"}</td><td className="p-3">{meal.journalEntryId ? `مسودة #${meal.journalEntryId}` : "—"}</td></tr>)}
                {!meals.length && <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا توجد وجبات في المدة المحددة.</td></tr>}
              </tbody></table>
            </div>
          </section>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive lg:col-span-2">{error}</p>}
          {notice && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm text-primary lg:col-span-2">{notice}</p>}
        </div>
      </section>
    </div>
  );
}
