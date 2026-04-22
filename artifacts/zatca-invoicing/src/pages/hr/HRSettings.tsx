import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Settings2, Save, Loader2, Sparkles, Info } from "lucide-react";

const FIELDS: Array<{
  key: string;
  label: string;
  hint: string;
  filter: "expense" | "liability" | "asset";
}> = [
  { key: "salariesExpense",   label: "حساب مصروف الرواتب",         hint: "يُجعل مديناً (DR) في قيد المسير — افتراضي 5201", filter: "expense" },
  { key: "allowancesExpense", label: "حساب مصروف البدلات والحوافز", hint: "يُجعل مديناً (DR) في قيد المسير — افتراضي 5202", filter: "expense" },
  { key: "gosiExpense",       label: "حساب مصروف التأمينات",        hint: "حصة صاحب العمل في التأمينات — افتراضي 5203",     filter: "expense" },
  { key: "eosExpense",        label: "حساب مصروف نهاية الخدمة",     hint: "يُستخدم عند صرف المكافأة بدون مخصص — افتراضي 5215", filter: "expense" },
  { key: "salariesPayable",   label: "حساب الرواتب المستحقة الدفع",  hint: "يُجعل دائناً بصافي رواتب الموظفين — افتراضي 21051", filter: "liability" },
  { key: "gosiPayable",       label: "حساب التأمينات المستحقة الدفع", hint: "يُجعل دائناً بحصة الموظف من التأمينات — افتراضي 21052", filter: "liability" },
  { key: "otherDeductions",   label: "حساب الاستقطاعات الأخرى",     hint: "خصومات أخرى من الرواتب — افتراضي 21053",        filter: "liability" },
  { key: "employeeLoans",     label: "حساب سلف وعُهد الموظفين",      hint: "أصل: يزيد عند الصرف وينقص عند خصم الأقساط — افتراضي 11081", filter: "asset" },
  { key: "eosProvision",      label: "حساب مخصص نهاية الخدمة",      hint: "خصم: يُستخدم عند الصرف من المخصص بدلاً من المصروف — افتراضي 22021", filter: "liability" },
];

export default function HRSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });
  const [mapping, setMapping] = useState<any>({});

  useEffect(() => {
    if (data?.mapping) setMapping(data.mapping);
  }, [data]);

  const save = useMutation({
    mutationFn: () => employeesApi.updateHrSettings(mapping),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hr-settings"] });
      toast({ title: "تم الحفظ", description: "تم تحديث ربط حسابات الموارد البشرية." });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function autoMap() {
    const codeMap: Record<string, string> = {
      salariesExpense: "5201", allowancesExpense: "5202", gosiExpense: "5203", eosExpense: "5215",
      salariesPayable: "21051", gosiPayable: "21052", otherDeductions: "21053",
      employeeLoans: "11081", eosProvision: "22021",
    };
    const next: any = { ...mapping };
    for (const [k, code] of Object.entries(codeMap)) {
      const found = (data?.accounts ?? []).find((a: any) => a.code === code);
      if (found) next[k] = found.id;
    }
    setMapping(next);
    toast({ title: "تم الربط التلقائي", description: "اضغط حفظ لتطبيق التغييرات." });
  }

  if (isLoading) return <div className="p-4"><Skeleton className="h-96" /></div>;

  const accounts = (data?.accounts ?? []) as any[];
  const cashBoxes = (data?.cashBoxes ?? []) as any[];
  const banks = (data?.bankAccounts ?? []) as any[];

  function accountItems(filter?: string) {
    const list = filter ? accounts.filter((a) => a.accountType === filter) : accounts;
    return list.map((a) => ({
      value: String(a.id),
      label: `${a.code} — ${a.nameAr}`,
      code: a.code,
      description: a.nameEn || undefined,
    }));
  }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-hr-settings">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Settings2 className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">إعدادات حسابات الموارد البشرية</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={autoMap} data-testid="btn-automap">
            <Sparkles className="size-4 me-1" /> ربط تلقائي من الدليل
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="btn-save-hr-settings">
            {save.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
            حفظ
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-blue-50/50 border-blue-200 p-3 text-sm text-blue-900 flex gap-2">
        <Info className="size-4 mt-0.5 shrink-0" />
        <div>
          هذه الإعدادات تحدد الحسابات المحاسبية التي تُستخدم تلقائياً عند اعتماد مسير الرواتب، صرف السلف، أو دفع مكافأة نهاية الخدمة.
          إذا لم تكن قد رتّبت دليل حساباتك بعد، اضغط "ربط تلقائي من الدليل" ليبحث النظام عن الحسابات القياسية ويربطها.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded-lg border bg-card p-3 space-y-1">
            <label className="text-sm font-medium">{f.label}</label>
            <SearchCombobox
              items={accountItems(f.filter)}
              value={mapping[f.key] ? String(mapping[f.key]) : ""}
              onValueChange={(v) => setMapping({ ...mapping, [f.key]: v ? Number(v) : null })}
              placeholder="— اختر حساباً —"
              searchPlaceholder="ابحث بالكود أو الاسم…"
              className="w-full"
            />
            <div className="text-[11px] text-muted-foreground">{f.hint}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-card p-3 space-y-3">
        <div className="text-sm font-semibold">إعدادات الصرف الافتراضية (للسلف ومكافآت نهاية الخدمة)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">الصندوق الافتراضي للسداد</label>
            <SearchCombobox
              items={cashBoxes.map((c: any) => ({ value: String(c.id), label: c.nameAr || c.nameEn || `صندوق #${c.id}` }))}
              value={mapping.defaultPayCashBoxId ? String(mapping.defaultPayCashBoxId) : ""}
              onValueChange={(v) => setMapping({ ...mapping, defaultPayCashBoxId: v ? Number(v) : null })}
              placeholder="— لا شيء —"
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">الحساب البنكي الافتراضي للسداد</label>
            <SearchCombobox
              items={banks.map((b: any) => ({ value: String(b.id), label: b.nameAr || b.nameEn || `بنك #${b.id}` }))}
              value={mapping.defaultPayBankAccountId ? String(mapping.defaultPayBankAccountId) : ""}
              onValueChange={(v) => setMapping({ ...mapping, defaultPayBankAccountId: v ? Number(v) : null })}
              placeholder="— لا شيء —"
              className="w-full"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="text-sm font-semibold mb-2">القيد الافتراضي لمسير الرواتب</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr><th className="p-2 text-start">الحساب</th><th className="p-2">مدين</th><th className="p-2">دائن</th></tr>
            </thead>
            <tbody>
              <tr className="border-t"><td className="p-2">رواتب وأجور (مصروف)</td><td className="p-2 text-center">✓</td><td className="p-2 text-center">—</td></tr>
              <tr className="border-t"><td className="p-2">بدلات وحوافز (مصروف)</td><td className="p-2 text-center">✓</td><td className="p-2 text-center">—</td></tr>
              <tr className="border-t"><td className="p-2">صافي الرواتب المستحقة</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">تأمينات مستحقة (حصة الموظف)</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">سلف الموظفين (استرداد قسط)</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">استقطاعات أخرى</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
