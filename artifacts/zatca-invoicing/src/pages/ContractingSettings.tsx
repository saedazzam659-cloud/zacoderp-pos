import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Save, ShieldCheck, SlidersHorizontal, WalletCards } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ADJUSTMENT_TYPES = [
  { key: "advance_recovery", label: "استرداد الدفعة المقدمة" },
  { key: "retention", label: "المحتجزات" },
  { key: "material_deduction", label: "خصم المواد" },
  { key: "penalty", label: "الغرامات" },
  { key: "addition", label: "الإضافات" },
  { key: "other_deduction", label: "استقطاعات أخرى" },
] as const;

const ACCOUNT_FIELDS = [
  { key: "advanceRecoveryAccountId", label: "حساب استرداد الدفعة المقدمة" },
  { key: "retentionAccountId", label: "حساب المحتجزات" },
  { key: "materialDeductionAccountId", label: "حساب خصم المواد" },
  { key: "penaltyAccountId", label: "حساب الغرامات" },
  { key: "additionAccountId", label: "حساب الإضافات" },
  { key: "otherDeductionAccountId", label: "حساب الاستقطاعات الأخرى" },
] as const;

type Settings = {
  defaultAdvanceRecoveryEnabled: boolean;
  defaultAdvanceRecoveryPercent: string | number;
  defaultAdvanceRecoveryStartProgressPercent: string | number;
  defaultRetentionEnabled: boolean;
  defaultRetentionPercent: string | number;
  defaultRetentionCapPercent: string | number;
  adjustmentTypes: string[];
  adjustmentAccountMappings: Record<string, number>;
  advanceRecoveryAccountId: number | null;
  retentionAccountId: number | null;
  materialDeductionAccountId: number | null;
  penaltyAccountId: number | null;
  additionAccountId: number | null;
  otherDeductionAccountId: number | null;
  overrideApprovalRequired: boolean;
  overrideApproverRoles: string[];
};

const EMPTY: Settings = {
  defaultAdvanceRecoveryEnabled: false,
  defaultAdvanceRecoveryPercent: "0",
  defaultAdvanceRecoveryStartProgressPercent: "0",
  defaultRetentionEnabled: true,
  defaultRetentionPercent: "5",
  defaultRetentionCapPercent: "100",
  adjustmentTypes: ADJUSTMENT_TYPES.map((item) => item.key),
  adjustmentAccountMappings: {},
  advanceRecoveryAccountId: null,
  retentionAccountId: null,
  materialDeductionAccountId: null,
  penaltyAccountId: null,
  additionAccountId: null,
  otherDeductionAccountId: null,
  overrideApprovalRequired: true,
  overrideApproverRoles: ["admin", "user", "cashier"],
};

function errorMessage(response: Response, fallback: string): Promise<string> {
  return response.json()
    .then((body) => String(body?.error ?? fallback))
    .catch(() => fallback);
}

export default function ContractingSettings() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const companyId = user?.companyId ?? user?.company?.id;
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [form, setForm] = useState<Settings>(EMPTY);

  const settingsQuery = useQuery<Settings>({
    queryKey: ["contracting-settings", companyId],
    queryFn: async () => {
      const response = await fetch(`${API}/api/contracting/settings`, { headers });
      if (!response.ok) throw new Error(await errorMessage(response, "تعذر تحميل إعدادات المقاولات"));
      return response.json();
    },
    enabled: Boolean(token && companyId),
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setForm({
        ...EMPTY,
        ...settingsQuery.data,
        adjustmentTypes: Array.isArray(settingsQuery.data.adjustmentTypes)
          ? settingsQuery.data.adjustmentTypes
          : EMPTY.adjustmentTypes,
        overrideApproverRoles: Array.isArray(settingsQuery.data.overrideApproverRoles)
          ? settingsQuery.data.overrideApproverRoles
          : EMPTY.overrideApproverRoles,
      });
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (next: Settings) => {
      const response = await fetch(`${API}/api/contracting/settings`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...next,
          defaultAdvanceRecoveryPercent: Number(next.defaultAdvanceRecoveryPercent),
          defaultAdvanceRecoveryStartProgressPercent: Number(next.defaultAdvanceRecoveryStartProgressPercent),
          defaultRetentionPercent: Number(next.defaultRetentionPercent),
          defaultRetentionCapPercent: Number(next.defaultRetentionCapPercent),
          adjustmentTypes: next.adjustmentTypes,
          adjustmentAccountMappings: next.adjustmentAccountMappings,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "تعذر حفظ إعدادات المقاولات"));
      return response.json() as Promise<Settings>;
    },
    onSuccess: (saved) => {
      setForm({ ...EMPTY, ...saved });
      queryClient.setQueryData(["contracting-settings", companyId], saved);
      toast({ title: "تم حفظ إعدادات المقاولات" });
    },
    onError: (error: Error) => toast({
      title: "تعذر حفظ الإعدادات",
      description: error.message,
      variant: "destructive",
    }),
  });

  const setField = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleType = (key: string, checked: boolean) => {
    const current = new Set(form.adjustmentTypes);
    if (checked) current.add(key);
    else current.delete(key);
    setField("adjustmentTypes", [...current]);
  };

  const toggleRole = (key: string, checked: boolean) => {
    const current = new Set(form.overrideApproverRoles);
    if (checked) current.add(key);
    else current.delete(key);
    setField("overrideApproverRoles", [...current]);
  };

  if (settingsQuery.isLoading) {
    return <div className="p-6 text-sm text-slate-500">جارٍ تحميل إعدادات المقاولات…</div>;
  }
  if (settingsQuery.isError) {
    return <div className="p-6 text-sm text-red-600">{(settingsQuery.error as Error).message}</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">إعدادات المقاولات</h1>
          <p className="mt-1 text-sm text-slate-500">
            اضبط السياسات الافتراضية والربط المحاسبي قبل إنشاء العقود والمستخلصات.
          </p>
        </div>
        <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}>
          <Save className="ml-2 h-4 w-4" />
          {saveMutation.isPending ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <WalletCards className="h-5 w-5 text-emerald-600" />
            الإعداد الافتراضي لاسترداد الدفعة المقدمة
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-3">
          <div className="flex items-center justify-between rounded-lg border bg-slate-50 p-3 md:col-span-3">
            <div>
              <Label>تفعيل الاسترداد للعقود الجديدة</Label>
              <p className="mt-1 text-xs text-slate-500">يمكن تعديل هذه القيم على مستوى كل عقد دون تغيير العقود السابقة.</p>
            </div>
            <Switch
              checked={form.defaultAdvanceRecoveryEnabled}
              onCheckedChange={(value) => setField("defaultAdvanceRecoveryEnabled", value)}
            />
          </div>
          <div>
            <Label htmlFor="advance-recovery-percent">نسبة الاسترداد الافتراضية (%)</Label>
            <Input
              id="advance-recovery-percent"
              className="mt-2"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.defaultAdvanceRecoveryPercent}
              disabled={!form.defaultAdvanceRecoveryEnabled}
              onChange={(event) => setField("defaultAdvanceRecoveryPercent", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="advance-recovery-start">بدء الاسترداد عند إنجاز (%)</Label>
            <Input
              id="advance-recovery-start"
              className="mt-2"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.defaultAdvanceRecoveryStartProgressPercent}
              disabled={!form.defaultAdvanceRecoveryEnabled}
              onChange={(event) => setField("defaultAdvanceRecoveryStartProgressPercent", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <WalletCards className="h-5 w-5 text-amber-600" />
            سياسة المحتجزات الافتراضية
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-3">
          <div className="flex items-center justify-between rounded-lg border bg-slate-50 p-3 md:col-span-3">
            <div>
              <Label>تفعيل المحتجزات للعقود الجديدة</Label>
              <p className="mt-1 text-xs text-slate-500">تُحفظ السياسة على العقد ولا تتأثر العقود السابقة بتغيير إعدادات الشركة.</p>
            </div>
            <Switch
              checked={form.defaultRetentionEnabled}
              onCheckedChange={(value) => setField("defaultRetentionEnabled", value)}
            />
          </div>
          <div>
            <Label htmlFor="retention-percent">نسبة المحتجزات الافتراضية (%)</Label>
            <Input
              id="retention-percent"
              className="mt-2"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.defaultRetentionPercent}
              disabled={!form.defaultRetentionEnabled}
              onChange={(event) => setField("defaultRetentionPercent", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="retention-cap-percent">سقف المحتجزات من قيمة العقد المعدلة (%)</Label>
            <Input
              id="retention-cap-percent"
              className="mt-2"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.defaultRetentionCapPercent}
              disabled={!form.defaultRetentionEnabled}
              onChange={(event) => setField("defaultRetentionCapPercent", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-5 w-5 text-blue-600" />
            أنواع التسويات والربط المحاسبي
          </CardTitle>
          <p className="text-sm text-slate-500">الحسابات يجب أن تكون حسابات ترحيل نشطة من نفس الشركة.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ADJUSTMENT_TYPES.map((item) => (
              <label key={item.key} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.adjustmentTypes.includes(item.key)}
                  onChange={(event) => toggleType(item.key, event.target.checked)}
                  className="h-4 w-4 accent-blue-600"
                />
                {item.label}
              </label>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {ACCOUNT_FIELDS.map((item) => (
              <div key={item.key}>
                <Label>{item.label}</Label>
                <div className="mt-2">
                  <AccountCombobox
                    companyId={companyId}
                    value={form[item.key] == null ? "" : String(form[item.key])}
                    onValueChange={(value) => setField(item.key, value ? Number(value) : null)}
                    allowEmpty
                    emptyLabel="بدون حساب محدد"
                    filterTypes={["asset", "liability", "equity", "revenue", "expense"]}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
            اعتماد تجاوز الكميات والقيم
          </CardTitle>
          <p className="text-sm text-slate-500">
            لا يغني هذا الإعداد عن صلاحية contracting:overrun؛ يجب توفر الصلاحية للمستخدم أيضاً.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label>طلب اعتماد وسبب عند تجاوز السقف</Label>
            <Switch
              checked={form.overrideApprovalRequired}
              onCheckedChange={(value) => setField("overrideApprovalRequired", value)}
            />
          </div>
          <div>
            <Label>الأدوار المسموح لها بالاعتماد</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {[
                ["admin", "مدير الشركة"],
                ["user", "مستخدم"],
                ["cashier", "أمين صندوق"],
              ].map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.overrideApproverRoles.includes(key)}
                    onChange={(event) => toggleRole(key, event.target.checked)}
                    className="h-4 w-4 accent-amber-600"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}>
          <Save className="ml-2 h-4 w-4" />
          حفظ الإعدادات
        </Button>
      </div>
    </div>
  );
}