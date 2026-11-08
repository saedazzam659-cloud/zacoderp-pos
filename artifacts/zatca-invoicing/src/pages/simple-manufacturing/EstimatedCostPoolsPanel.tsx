import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type Account = {
  id: number;
  code?: string | null;
  accountCode?: string | null;
  nameAr?: string | null;
  name?: string | null;
  accountType?: string | null;
  isActive?: boolean;
  isPosting?: boolean;
};

type Props = {
  accounts: Account[];
  canManageCompanyPools: boolean;
  request: (path: string, init?: RequestInit) => Promise<any>;
};

const BASIS_OPTIONS = [
  { value: "machine_hours", label: "ساعات تشغيل الآلات" },
  { value: "labor_hours", label: "ساعات العمل" },
  { value: "production_quantity", label: "كمية الإنتاج" },
  { value: "area", label: "المساحة" },
  { value: "percentage", label: "نسبة من المجمع" },
  { value: "equal", label: "توزيع متساوٍ" },
  { value: "manual", label: "مبلغ يدوي لكل أمر" },
] as const;

function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

function accountLabel(account: Account): string {
  const code = account.code ?? account.accountCode ?? String(account.id);
  const name = account.nameAr ?? account.name ?? "";
  return `${code} — ${name}`;
}

export function EstimatedCostPoolsPanel({ accounts, canManageCompanyPools, request }: Props) {
  const { toast } = useToast();
  const [period, setPeriod] = useState(monthNow);
  const [pools, setPools] = useState<any[]>([]);
  const [closures, setClosures] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [poolInputs, setPoolInputs] = useState<Record<number, {
    actualAmount: string;
    sourceReference: string;
    confirmed: boolean;
  }>>({});
  const [form, setForm] = useState({
    code: "",
    nameAr: "",
    estimatedAmount: "",
    allocationBasis: "machine_hours",
    monthlyDenominator: "",
    actualExpenseAccountId: "",
    absorbedAccountId: "",
    varianceAccountId: "",
  });

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.isActive !== false && account.isPosting !== false),
    [accounts],
  );
  const expenseAccounts = useMemo(
    () => activeAccounts.filter((account) => account.accountType === "expense"),
    [activeAccounts],
  );
  const liabilityAccounts = useMemo(
    () => activeAccounts.filter((account) => account.accountType === "liability"),
    [activeAccounts],
  );
  const usesDenominator = !["percentage", "manual"].includes(form.allocationBasis);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      actualExpenseAccountId: current.actualExpenseAccountId ||
        String(expenseAccounts[0]?.id ?? ""),
      varianceAccountId: current.varianceAccountId ||
        String(expenseAccounts.find((account) => account.id !== Number(current.actualExpenseAccountId))?.id ?? ""),
      absorbedAccountId: current.absorbedAccountId || String(liabilityAccounts[0]?.id ?? ""),
    }));
  }, [expenseAccounts, liabilityAccounts]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!period) return;
    setLoading(true);
    try {
      const [poolResult, closureResult] = await Promise.all([
        request(`/api/simple-manufacturing/estimated-costing/pools?period=${encodeURIComponent(period)}`, { signal }),
        request(`/api/simple-manufacturing/estimated-costing/closures?period=${encodeURIComponent(period)}`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (!Array.isArray(poolResult?.pools) || !Array.isArray(closureResult?.closures))
        throw new Error("استجابة مجمعات التكلفة غير صالحة");
      setPools(poolResult.pools);
      setClosures(closureResult.closures);
      setPoolInputs((current) => {
        const next = { ...current };
        for (const pool of poolResult.pools) {
          next[Number(pool.id)] ??= {
            actualAmount: String(pool.actualAmount ?? ""),
            sourceReference: String(pool.actualSourceReference ?? ""),
            confirmed: pool.actualPostedConfirmed === true,
          };
        }
        return next;
      });
    } catch (error: any) {
      if (error?.name !== "AbortError" && !signal?.aborted) {
        toast({
          title: "تعذر تحميل مجمعات التكلفة",
          description: error?.message || "حدث خطأ أثناء قراءة بيانات الفترة.",
          variant: "destructive",
        });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [period, request, toast]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [refresh, refreshKey]);

  const savePool = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.code.trim() || !form.nameAr.trim() || !(Number(form.estimatedAmount) > 0)) {
      toast({ title: "بيانات المجمع ناقصة", description: "أدخل الرمز والاسم والمبلغ التقديري.", variant: "destructive" });
      return;
    }
    if (!form.actualExpenseAccountId || !form.absorbedAccountId || !form.varianceAccountId) {
      toast({ title: "الحسابات ناقصة", description: "اختر حساب المصروف والامتصاص والفروق.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await request("/api/simple-manufacturing/estimated-costing/pools", {
        method: "POST",
        body: JSON.stringify({
          period,
          code: form.code.trim(),
          nameAr: form.nameAr.trim(),
          estimatedAmount: Number(form.estimatedAmount),
          allocationBasis: form.allocationBasis,
          monthlyDenominator: usesDenominator ? Number(form.monthlyDenominator) : null,
          scopeType: "company",
          actualExpenseAccountId: Number(form.actualExpenseAccountId),
          absorbedAccountId: Number(form.absorbedAccountId),
          varianceAccountId: Number(form.varianceAccountId),
        }),
      });
      setForm((current) => ({
        ...current,
        code: "",
        nameAr: "",
        estimatedAmount: "",
        monthlyDenominator: "",
      }));
      setRefreshKey((value) => value + 1);
      toast({ title: "تم إنشاء مجمع التكلفة" });
    } catch (error: any) {
      toast({ title: error?.message || "تعذر إنشاء مجمع التكلفة", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveActual = async (pool: any) => {
    const values = poolInputs[Number(pool.id)] ?? {
      actualAmount: "",
      sourceReference: "",
      confirmed: false,
    };
    if (!values.confirmed || !values.sourceReference.trim() || values.actualAmount === "") {
      toast({
        title: "بيانات الفعلي ناقصة",
        description: "أدخل المبلغ والمرجع، وأكد أن المصروف مرحّل مسبقاً.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const result = await request(
        `/api/simple-manufacturing/estimated-costing/pools/${Number(pool.id)}/actual`,
        {
          method: "PUT",
          body: JSON.stringify({
            actualAmount: Number(values.actualAmount),
            sourceReference: values.sourceReference.trim(),
            confirmAlreadyPosted: true,
          }),
        },
      );
      setRefreshKey((value) => value + 1);
      toast({
        title: result?.closure ? "أُنشئت مسودة إقفال التكلفة" : "تم حفظ الفعلي",
        description: result?.readiness || "لم يُنشأ أي مصروف جديد؛ الإقفال يعيد تصنيف التكلفة فقط.",
      });
    } catch (error: any) {
      toast({ title: error?.message || "تعذر حفظ الفعلي", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const actOnClosure = async (closure: any, action: "post" | "reverse") => {
    setSaving(true);
    try {
      await request(
        `/api/simple-manufacturing/estimated-costing/closures/${Number(closure.id)}/${action}`,
        {
          method: "POST",
          body: action === "reverse"
            ? JSON.stringify({ reversalDate: new Date().toISOString().slice(0, 10) })
            : JSON.stringify({}),
        },
      );
      setRefreshKey((value) => value + 1);
      toast({ title: action === "post" ? "تم ترحيل مسودة الإقفال" : "تم عكس الإقفال" });
    } catch (error: any) {
      toast({
        title: error?.message || (action === "post" ? "تعذر ترحيل الإقفال" : "تعذر عكس الإقفال"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6 space-y-5 rounded-2xl border border-teal-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">مجمعات التكلفة التقديرية الشهرية</h2>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
            تُجمّد حصة كل أمر عند بدء الإنتاج. أدخل الفعلي بعد ترحيله في حساب المصروف المعتاد؛ هذا الإقفال لا ينشئ المصروف مرة ثانية.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="estimated-cost-period">الفترة</Label>
            <Input
              id="estimated-cost-period"
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="w-44"
            />
          </div>
          <Button type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            تحديث
          </Button>
        </div>
      </div>

      {!canManageCompanyPools && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          إنشاء مجمع على مستوى الشركة وإدخال فعليه وترحيل إقفاله يتطلب صلاحية جميع الفروع.
        </p>
      )}
      <form onSubmit={savePool}>
       <fieldset disabled={!canManageCompanyPools || saving} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1">
          <Label>رمز المجمع</Label>
          <Input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={64} required />
        </div>
        <div className="space-y-1">
          <Label>اسم بند التكلفة</Label>
          <Input value={form.nameAr} onChange={(event) => setForm({ ...form, nameAr: event.target.value })} maxLength={160} required />
        </div>
        <div className="space-y-1">
          <Label>المبلغ التقديري</Label>
          <Input type="number" min="0.01" step="0.01" value={form.estimatedAmount} onChange={(event) => setForm({ ...form, estimatedAmount: event.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label>أساس التوزيع</Label>
          <select
            value={form.allocationBasis}
            onChange={(event) => setForm({ ...form, allocationBasis: event.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {BASIS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        {usesDenominator && (
          <div className="space-y-1">
            <Label>المقام الشهري اليدوي</Label>
            <Input
              type="number"
              min="0.000001"
              step="0.000001"
              value={form.monthlyDenominator}
              onChange={(event) => setForm({ ...form, monthlyDenominator: event.target.value })}
              required
            />
          </div>
        )}
        <div className="space-y-1">
          <Label>حساب المصروف الفعلي</Label>
          <select
            value={form.actualExpenseAccountId}
            onChange={(event) => setForm({ ...form, actualExpenseAccountId: event.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            required
          >
            <option value="">اختر حساب مصروف</option>
            {expenseAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label>حساب امتصاص التكلفة</Label>
          <select
            value={form.absorbedAccountId}
            onChange={(event) => setForm({ ...form, absorbedAccountId: event.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            required
          >
            <option value="">اختر حساب التزام</option>
            {liabilityAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label>حساب فروق التصنيع</Label>
          <select
            value={form.varianceAccountId}
            onChange={(event) => setForm({ ...form, varianceAccountId: event.target.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            required
          >
            <option value="">اختر حساب فروق</option>
            {expenseAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </div>
        <div className="flex items-end xl:col-span-4">
          <Button type="submit" disabled={saving || !period || !expenseAccounts.length || !liabilityAccounts.length}>
            {saving ? "جاري الحفظ..." : "إنشاء مجمع للشهر"}
          </Button>
        </div>
       </fieldset>
      </form>

      <div className="space-y-3">
        <h3 className="font-semibold text-slate-900">بنود الفترة {period}</h3>
        {loading && <p className="text-sm text-slate-500">جاري تحميل المجمعات...</p>}
        {!loading && pools.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">لا توجد مجمعات مسجلة لهذه الفترة.</p>
        )}
        {pools.map((pool) => {
          const values = poolInputs[Number(pool.id)] ?? {
            actualAmount: String(pool.actualAmount ?? ""),
            sourceReference: String(pool.actualSourceReference ?? ""),
            confirmed: pool.actualPostedConfirmed === true,
          };
          const globalPoolReadOnly = pool.branchId == null && !canManageCompanyPools;
          return (
            <article key={pool.id} className="grid gap-4 rounded-xl border border-slate-200 p-4 xl:grid-cols-[1fr_1.5fr]">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-slate-900">{pool.nameAr} <span className="text-xs font-normal text-slate-500">({pool.code})</span></h4>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${pool.status === "closed" ? "bg-slate-100 text-slate-700" : "bg-teal-100 text-teal-800"}`}>
                    {pool.status === "closed" ? "مغلق" : pool.status === "actual_entered" ? "تم إدخال الفعلي" : "مفتوح"}
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  تقديري: {Number(pool.estimatedAmount).toLocaleString("ar-EG", { minimumFractionDigits: 2 })} ر.س
                  {" · "}الموزع: {Number(pool.appliedAmount ?? 0).toLocaleString("ar-EG", { minimumFractionDigits: 2 })} ر.س
                  {" · "}الأوامر: {Number(pool.orderCount ?? 0)}
                </p>
                {pool.actualSourceReference && <p className="text-xs text-slate-500">مرجع الفعلي: {pool.actualSourceReference}</p>}
              </div>
              <div className="space-y-3 rounded-lg bg-slate-50 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>المبلغ الفعلي المرحّل</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={values.actualAmount}
                      disabled={pool.status === "closed" || saving || globalPoolReadOnly}
                      onChange={(event) => setPoolInputs((current) => ({
                        ...current,
                        [Number(pool.id)]: { ...values, actualAmount: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>مرجع قيد أو مستند المصروف</Label>
                    <Input
                      value={values.sourceReference}
                      maxLength={200}
                      disabled={pool.status === "closed" || saving || globalPoolReadOnly}
                      onChange={(event) => setPoolInputs((current) => ({
                        ...current,
                        [Number(pool.id)]: { ...values, sourceReference: event.target.value },
                      }))}
                      placeholder="رقم القيد أو المستند"
                    />
                  </div>
                </div>
                <label className="flex items-start gap-2 text-xs leading-5 text-amber-900">
                  <input
                    type="checkbox"
                    checked={values.confirmed}
                    disabled={pool.status === "closed" || saving || globalPoolReadOnly}
                    onChange={(event) => setPoolInputs((current) => ({
                      ...current,
                      [Number(pool.id)]: { ...values, confirmed: event.target.checked },
                    }))}
                    className="mt-1"
                  />
                  <span>أؤكد أن المبلغ الفعلي مرحّل مسبقاً في حساب المصروف المحدد، وأن الإقفال لن يسجل مصروفاً مكرراً.</span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving || pool.status === "closed" || globalPoolReadOnly}
                  onClick={() => void saveActual(pool)}
                >
                  تسجيل الفعلي ومحاولة إعداد المسودة
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="space-y-3">
        <h3 className="font-semibold text-slate-900">مسودات وتسويات الفترة</h3>
        {closures.length === 0 && <p className="text-sm text-slate-500">لا توجد مسودات إقفال لهذه الفترة.</p>}
        {closures.map((closure) => (
          <article key={closure.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4">
            <div>
              <p className="font-semibold text-slate-900">
                {closure.status === "draft" ? "مسودة للمراجعة" : closure.status === "posted" ? "مرحّل" : "معكوس"}
                <span className="mr-2 text-xs font-normal text-slate-500">#{closure.id}</span>
              </p>
              <p className="mt-1 text-sm text-slate-600">
                الفعلي {Number(closure.actualAmount).toLocaleString("ar-EG", { minimumFractionDigits: 2 })} ر.س
                {" · "}المحمّل {Number(closure.appliedAmount).toLocaleString("ar-EG", { minimumFractionDigits: 2 })} ر.س
                {" · "}الفرق {Number(closure.varianceAmount).toLocaleString("ar-EG", { minimumFractionDigits: 2 })} ر.س
              </p>
            </div>
            <div className="flex gap-2">
              {closure.status === "draft" && (
                <Button type="button" size="sm" disabled={saving || (!canManageCompanyPools && closure.branchId == null)} onClick={() => void actOnClosure(closure, "post")}>
                  مراجعة وترحيل
                </Button>
              )}
              {["draft", "posted"].includes(String(closure.status)) && (
                <Button type="button" size="sm" variant="outline" disabled={saving || (!canManageCompanyPools && closure.branchId == null)} onClick={() => void actOnClosure(closure, "reverse")}>
                  {closure.status === "draft" ? "إلغاء المسودة" : "عكس التسوية"}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
