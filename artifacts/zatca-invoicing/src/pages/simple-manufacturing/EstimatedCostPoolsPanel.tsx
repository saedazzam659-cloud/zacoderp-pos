import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchCombobox } from "@/components/ui/search-combobox";
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
  {
    value: "machine_hours",
    label: "ساعات تشغيل الآلات",
    description: "وزّع التكلفة بحسب ساعات تشغيل الآلات في كل أمر.",
    denominatorLabel: "إجمالي ساعات تشغيل الآلات للشهر",
  },
  {
    value: "labor_hours",
    label: "ساعات العمل",
    description: "وزّع التكلفة بحسب ساعات العمل المسجلة لكل أمر.",
    denominatorLabel: "إجمالي ساعات العمل للشهر",
  },
  {
    value: "production_quantity",
    label: "كمية الإنتاج",
    description: "وزّع التكلفة بحسب كمية الإنتاج في كل أمر.",
    denominatorLabel: "إجمالي كمية الإنتاج للشهر",
  },
  {
    value: "area",
    label: "المساحة",
    description: "وزّع التكلفة بحسب مساحة كل أمر مقارنة بإجمالي المساحة.",
    denominatorLabel: "إجمالي المساحة للشهر",
  },
  {
    value: "percentage",
    label: "نسبة من المجمع",
    description: "حدّد نسبة كل أمر مباشرة؛ يجب أن يكتمل مجموع النسب إلى 100٪.",
  },
  {
    value: "equal",
    label: "توزيع متساوٍ",
    description: "وزّع المبلغ بالتساوي؛ أدخل 1 لكل أمر ومقاماً يساوي عدد الأوامر.",
    denominatorLabel: "عدد الأوامر المتوقع للشهر",
  },
  {
    value: "manual",
    label: "مبلغ يدوي لكل أمر",
    description: "حدّد المبلغ مباشرة لكل أمر؛ يجب أن يساوي مجموع المبالغ كامل المجمع.",
  },
] as const;

type PoolPreset = {
  id: string;
  code: string;
  nameAr: string;
  allocationBasis: (typeof BASIS_OPTIONS)[number]["value"];
  description: string;
};

const COMMON_POOL_PRESETS: PoolPreset[] = [
  {
    id: "factory-rent",
    code: "FACTORY_RENT",
    nameAr: "إيجار المصنع",
    allocationBasis: "area",
    description: "استخدم حصة المصنع المخصصة للإنتاج، ووزّعها حسب المساحة.",
  },
  {
    id: "electricity",
    code: "FACTORY_ELECTRICITY",
    nameAr: "كهرباء المصنع",
    allocationBasis: "machine_hours",
    description: "مناسب للتوزيع بحسب ساعات الآلات؛ تجنب تكراره إذا كانت تكلفة الكهرباء محسوبة عبر موارد الآلات.",
  },
  {
    id: "water",
    code: "FACTORY_WATER",
    nameAr: "مياه المصنع",
    allocationBasis: "production_quantity",
    description: "اقتراح مبدئي للتوزيع حسب كمية الإنتاج؛ غيّره إذا كان استهلاك المياه يتبع أساساً آخر.",
  },
  {
    id: "indirect-labor",
    code: "INDIRECT_LABOR",
    nameAr: "أجور العمالة غير المباشرة",
    allocationBasis: "labor_hours",
    description: "للعمالة غير المباشرة فقط؛ لا تكرر رواتب العاملين المحملة من مصدر الرواتب أو موارد المراحل.",
  },
  {
    id: "supervision",
    code: "SUPERVISION",
    nameAr: "إشراف التصنيع",
    allocationBasis: "labor_hours",
    description: "استخدمه فقط إذا لم تكن تكلفة المشرف محملة بالفعل على أمر أو مرحلة إنتاج.",
  },
  {
    id: "machine-depreciation",
    code: "MACHINE_DEPRECIATION",
    nameAr: "إهلاك آلات المصنع",
    allocationBasis: "machine_hours",
    description: "للإهلاك غير المحمل عبر تكلفة موارد الآلات أو الأصل الثابت.",
  },
  {
    id: "machine-maintenance",
    code: "MACHINE_MAINTENANCE",
    nameAr: "صيانة آلات المصنع",
    allocationBasis: "machine_hours",
    description: "اقتراح لتوزيع الصيانة بحسب ساعات تشغيل الآلات.",
  },
  {
    id: "allocated-office-rent",
    code: "OFFICE_RENT_PRODUCTION_SHARE",
    nameAr: "حصة التصنيع من إيجار المكاتب",
    allocationBasis: "area",
    description: "أدخل حصة التصنيع المعتمدة فقط، وليس كامل إيجار المكاتب الإدارية.",
  },
];

function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

function previousMonth(period: string): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function EstimatedCostPoolsPanel({ accounts, canManageCompanyPools, request }: Props) {
  const { toast } = useToast();
  const [period, setPeriod] = useState(monthNow);
  const [pools, setPools] = useState<any[]>([]);
  const [closures, setClosures] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [previousPools, setPreviousPools] = useState<any[]>([]);
  const [templateValue, setTemplateValue] = useState("");
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
  const selectedBasis = BASIS_OPTIONS.find((option) => option.value === form.allocationBasis) ?? BASIS_OPTIONS[0];
  const basisItems = BASIS_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));
  const accountItems = (rows: Account[], excludedId = "") => rows.map((account) => ({
    value: String(account.id),
    code: account.code ?? account.accountCode ?? String(account.id),
    label: account.nameAr ?? account.name ?? String(account.id),
    disabled: String(account.id) === excludedId,
    disabledReason: String(account.id) === excludedId ? "اختر حساباً مختلفاً لهذا الدور" : undefined,
  }));
  const templateItems = useMemo(() => [
    ...COMMON_POOL_PRESETS.map((preset) => ({
      value: `preset:${preset.id}`,
      code: preset.code,
      label: preset.nameAr,
      description: preset.description,
      group: "بنود جاهزة",
    })),
    ...previousPools.map((pool) => ({
      value: `previous:${pool.id}`,
      code: String(pool.code ?? ""),
      label: `${pool.nameAr} — ${pool.code}`,
      description: `نسخ أساس التوزيع والمقام والحسابات من ${previousMonth(period) ?? "الشهر السابق"}.`,
      group: "إعدادات الشهر السابق",
    })),
  ], [period, previousPools]);

  useEffect(() => {
    const sourcePeriod = previousMonth(period);
    if (!sourcePeriod) {
      setPreviousPools([]);
      return;
    }
    const controller = new AbortController();
    void request(
      `/api/simple-manufacturing/estimated-costing/pools?period=${encodeURIComponent(sourcePeriod)}`,
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      setPreviousPools(Array.isArray(result?.pools)
        ? result.pools.filter((pool: any) => pool.branchId == null)
        : []);
    }).catch((error: any) => {
      if (error?.name !== "AbortError" && !controller.signal.aborted) setPreviousPools([]);
    });
    return () => controller.abort();
  }, [period, request]);

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
    if (new Set([
      form.actualExpenseAccountId,
      form.absorbedAccountId,
      form.varianceAccountId,
    ]).size !== 3) {
      toast({
        title: "الحسابات يجب أن تكون مختلفة",
        description: "اختر حساباً مستقلاً للمصروف الفعلي، وحساب الامتصاص، وحساب فروق التصنيع.",
        variant: "destructive",
      });
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
      setTemplateValue("");
      setRefreshKey((value) => value + 1);
      toast({ title: "تم إنشاء مجمع التكلفة" });
    } catch (error: any) {
      toast({ title: error?.message || "تعذر إنشاء مجمع التكلفة", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = (value: string) => {
    setTemplateValue(value);
    if (!value) return;
    if (value.startsWith("preset:")) {
      const preset = COMMON_POOL_PRESETS.find((row) => `preset:${row.id}` === value);
      if (!preset) return;
      setForm((current) => ({
        ...current,
        code: preset.code,
        nameAr: preset.nameAr,
        allocationBasis: preset.allocationBasis,
        monthlyDenominator: "",
        actualExpenseAccountId: "",
        absorbedAccountId: "",
        varianceAccountId: "",
      }));
      return;
    }

    const poolId = Number(value.slice("previous:".length));
    const pool = previousPools.find((row) => Number(row.id) === poolId);
    if (!pool) return;
    const activeExpenseIds = new Set(expenseAccounts.map((account) => String(account.id)));
    const activeLiabilityIds = new Set(liabilityAccounts.map((account) => String(account.id)));
    const previousActualAccountId = String(pool.actualExpenseAccountId ?? "");
    const previousAbsorbedAccountId = String(pool.absorbedAccountId ?? "");
    const previousVarianceAccountId = String(pool.varianceAccountId ?? "");
    setForm((current) => ({
      ...current,
      code: String(pool.code ?? ""),
      nameAr: String(pool.nameAr ?? ""),
      allocationBasis: String(pool.allocationBasis ?? "machine_hours"),
      monthlyDenominator: pool.monthlyDenominator == null ? "" : String(pool.monthlyDenominator),
      actualExpenseAccountId: activeExpenseIds.has(previousActualAccountId)
        ? previousActualAccountId : "",
      absorbedAccountId: activeLiabilityIds.has(previousAbsorbedAccountId)
        ? previousAbsorbedAccountId : "",
      varianceAccountId: activeExpenseIds.has(previousVarianceAccountId)
        ? previousVarianceAccountId : "",
    }));
    toast({
      title: "تم نسخ إعداد الشهر السابق",
      description: "راجع المقام والحسابات، ثم أدخل المبلغ التقديري الجديد.",
    });
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
            وزّع التكلفة المتوقعة على أوامر الشهر، ثم قارنها بالفعلي بعد ترحيله. تُثبّت حصة الأمر عند بدء الإنتاج، ولا ينشئ الإقفال مصروفاً مكرراً.
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

      <div className="grid gap-3 md:grid-cols-3" aria-label="خطوات استخدام مجمعات التكلفة">
        {[
          {
            number: "١",
            title: "أنشئ المجمع",
            detail: "اختر الشهر، بند التكلفة، المبلغ التقديري، وطريقة التوزيع.",
          },
          {
            number: "٢",
            title: "وزّع على الأوامر",
            detail: "أدخل قيمة كل أمر؛ تظهر حصته التقديرية قبل بدء الإنتاج.",
          },
          {
            number: "٣",
            title: "سوِّ الفعلي",
            detail: "بعد ترحيل المصروف، أدخل مبلغه ومرجعه ثم راجع مسودة الإقفال.",
          },
        ].map((step) => (
          <div key={step.number} className="flex gap-3 rounded-xl border border-teal-100 bg-gradient-to-br from-teal-50 to-white p-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">
              {step.number}
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">{step.title}</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {!canManageCompanyPools && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          إنشاء مجمع على مستوى الشركة وإدخال فعليه وترحيل إقفاله يتطلب صلاحية جميع الفروع.
        </p>
      )}
      <form onSubmit={savePool}>
       <fieldset disabled={!canManageCompanyPools || saving} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4">
         <div className="space-y-1 xl:col-span-4">
           <Label>قالب إعداد المجمع</Label>
           <SearchCombobox
             value={templateValue}
             onValueChange={applyTemplate}
             items={templateItems}
             grouped
             placeholder="اختر بنداً جاهزاً أو انسخ إعداد الشهر السابق"
             searchPlaceholder="ابحث باسم البند أو رمزه..."
             emptyText="لا توجد قوالب مطابقة"
             className="h-10 bg-white"
             openOnFocus={false}
             testId="estimated-pool-template"
           />
           <p className="text-[11px] leading-4 text-slate-500">
             القالب يملأ بيانات البداية فقط ولا ينشئ المجمع. اختر حسابات شركتك عند أول استخدام؛ نسخ الشهر السابق ينقل الحسابات المتاحة وأساس التوزيع والمقام.
           </p>
         </div>
        <div className="space-y-1">
          <Label>رمز المجمع</Label>
          <Input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={64} required />
           <p className="text-[11px] leading-4 text-slate-500">يتعبأ من القالب ويمكن تعديله؛ يجب ألا يتكرر في الفترة نفسها.</p>
        </div>
        <div className="space-y-1">
          <Label>اسم بند التكلفة</Label>
          <Input value={form.nameAr} onChange={(event) => setForm({ ...form, nameAr: event.target.value })} maxLength={160} required />
           <p className="text-[11px] leading-4 text-slate-500">يتعبأ من القالب ويمكن تخصيصه حسب بند التكلفة.</p>
        </div>
        <div className="space-y-1">
          <Label>المبلغ التقديري</Label>
          <Input type="number" min="0.01" step="0.01" value={form.estimatedAmount} onChange={(event) => setForm({ ...form, estimatedAmount: event.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label>أساس التوزيع</Label>
           <SearchCombobox
            value={form.allocationBasis}
             onValueChange={(value) => setForm((current) => ({ ...current, allocationBasis: value }))}
             items={basisItems}
             placeholder="اختر أساس التوزيع"
             searchPlaceholder="ابحث عن طريقة التوزيع..."
             emptyText="لا توجد طريقة مطابقة"
             className="h-10"
             openOnFocus={false}
             testId="estimated-pool-allocation-basis"
           />
        </div>
         <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-3 text-xs leading-5 text-teal-950 md:col-span-2 xl:col-span-4">
           <p className="font-semibold">{selectedBasis.label}</p>
           <p className="mt-1">{selectedBasis.description}</p>
           {usesDenominator ? (
             <p className="mt-1 text-teal-800">
               الحصة التقديرية للأمر = مبلغ المجمع × قيمة أساس الأمر ÷ إجمالي أساس الشهر. يجب أن يطابق مجموع قيم الأوامر المقام الشهري.
             </p>
           ) : form.allocationBasis === "percentage" ? (
             <p className="mt-1 text-teal-800">لا يحتاج إلى مقام شهري؛ أكمل توزيع المجمع بنسبة 100٪ على الأوامر.</p>
           ) : (
             <p className="mt-1 text-teal-800">لا يحتاج إلى مقام شهري؛ يجب أن يساوي مجموع المبالغ المخصصة للأوامر مبلغ المجمع.</p>
           )}
         </div>
        {usesDenominator && (
          <div className="space-y-1">
            <Label>{"denominatorLabel" in selectedBasis ? selectedBasis.denominatorLabel : "المقام الشهري اليدوي"}</Label>
            <Input
              type="number"
              min="0.000001"
              step="0.000001"
              value={form.monthlyDenominator}
              onChange={(event) => setForm({ ...form, monthlyDenominator: event.target.value })}
              required
            />
            <p className="text-[11px] leading-4 text-slate-500">
              أدخل الإجمالي المتوقع للشهر على أساس التوزيع المختار؛ لن يحسبه النظام تلقائياً.
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label>حساب المصروف الفعلي</Label>
           <SearchCombobox
            value={form.actualExpenseAccountId}
             onValueChange={(value) => setForm((current) => ({ ...current, actualExpenseAccountId: value }))}
             items={accountItems(expenseAccounts, form.varianceAccountId)}
             placeholder="اختر حساب مصروف"
             searchPlaceholder="ابحث بالكود أو اسم الحساب..."
             emptyText="لا توجد حسابات مصروف مطابقة"
             className="h-10"
             openOnFocus={false}
             testId="estimated-pool-actual-expense-account"
           />
           <p className="text-[11px] leading-4 text-slate-500">الحساب الذي رُحّل عليه المصروف الفعلي مسبقاً.</p>
        </div>
        <div className="space-y-1">
          <Label>حساب امتصاص التكلفة</Label>
           <SearchCombobox
            value={form.absorbedAccountId}
             onValueChange={(value) => setForm((current) => ({ ...current, absorbedAccountId: value }))}
             items={accountItems(liabilityAccounts)}
             placeholder="اختر حساب التزام"
             searchPlaceholder="ابحث بالكود أو اسم الحساب..."
             emptyText="لا توجد حسابات التزام مطابقة"
             className="h-10"
             openOnFocus={false}
             testId="estimated-pool-absorbed-account"
           />
           <p className="text-[11px] leading-4 text-slate-500">حساب امتصاص تكلفة التصنيع الذي ستُراجع تسويته.</p>
        </div>
        <div className="space-y-1">
          <Label>حساب فروق التصنيع</Label>
           <SearchCombobox
            value={form.varianceAccountId}
             onValueChange={(value) => setForm((current) => ({ ...current, varianceAccountId: value }))}
             items={accountItems(expenseAccounts, form.actualExpenseAccountId)}
             placeholder="اختر حساب فروق"
             searchPlaceholder="ابحث بالكود أو اسم الحساب..."
             emptyText="لا توجد حسابات مصروف مطابقة"
             className="h-10"
             openOnFocus={false}
             testId="estimated-pool-variance-account"
           />
           <p className="text-[11px] leading-4 text-slate-500">حساب فرق التكلفة بين المبلغ المحمّل والفعلي؛ يجب أن يختلف عن حساب المصروف الفعلي.</p>
        </div>
         {expenseAccounts.length < 2 && (
           <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 md:col-span-2 xl:col-span-4">
             يلزم وجود حسابَي مصروف مختلفين وحساب التزام نشط وقابل للترحيل قبل إنشاء المجمع.
           </p>
         )}
        <div className="flex items-end xl:col-span-4">
           <Button type="submit" disabled={saving || !period || expenseAccounts.length < 2 || !liabilityAccounts.length ||
             !form.actualExpenseAccountId || !form.absorbedAccountId || !form.varianceAccountId ||
             new Set([form.actualExpenseAccountId, form.absorbedAccountId, form.varianceAccountId]).size !== 3 ||
             (usesDenominator && !(Number(form.monthlyDenominator) > 0))}>
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
          const estimateAmount = Number(pool.estimatedAmount ?? 0);
          const appliedAmount = Number(pool.appliedAmount ?? 0);
          const allocationProgress = estimateAmount > 0
            ? Math.min(100, Math.max(0, (appliedAmount / estimateAmount) * 100))
            : 0;
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
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>اكتمال التوزيع</span>
                    <span className="font-semibold tabular-nums text-teal-800">{allocationProgress.toFixed(0)}٪</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100" dir="rtl">
                    <div
                      className="h-full rounded-full bg-teal-600 transition-[width]"
                      style={{ width: `${allocationProgress}%` }}
                      role="progressbar"
                      aria-label={`اكتمال توزيع مجمع ${pool.nameAr}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(allocationProgress)}
                    />
                  </div>
                </div>
                {pool.actualSourceReference && <p className="text-xs text-slate-500">مرجع الفعلي: {pool.actualSourceReference}</p>}
              </div>
              <div className="space-y-3 rounded-lg bg-slate-50 p-3">
                <p className="text-xs leading-5 text-slate-600">
                  سجّل هنا المبلغ الفعلي بعد ترحيله في حساب المصروف، وأدخل رقم القيد أو مستند المصروف للمراجعة.
                </p>
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
