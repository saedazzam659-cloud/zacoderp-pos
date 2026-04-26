import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Settings2, Save, Loader2, Sparkles, Info } from "lucide-react";

const FIELD_KEYS: Array<{
  key: string;
  labelKey: string;
  hintKey: string;
  filter: "expense" | "liability" | "asset";
}> = [
  { key: "salariesExpense",   labelKey: "fldSalariesExpense",   hintKey: "fldSalariesExpenseHint",   filter: "expense"   },
  { key: "allowancesExpense", labelKey: "fldAllowancesExpense", hintKey: "fldAllowancesExpenseHint", filter: "expense"   },
  { key: "gosiExpense",       labelKey: "fldGosiExpense",       hintKey: "fldGosiExpenseHint",       filter: "expense"   },
  { key: "eosExpense",        labelKey: "fldEosExpense",        hintKey: "fldEosExpenseHint",        filter: "expense"   },
  { key: "salariesPayable",   labelKey: "fldSalariesPayable",   hintKey: "fldSalariesPayableHint",   filter: "liability" },
  { key: "gosiPayable",       labelKey: "fldGosiPayable",       hintKey: "fldGosiPayableHint",       filter: "liability" },
  { key: "otherDeductions",   labelKey: "fldOtherDeductions",   hintKey: "fldOtherDeductionsHint",   filter: "liability" },
  { key: "employeeLoans",     labelKey: "fldEmployeeLoans",     hintKey: "fldEmployeeLoansHint",     filter: "asset"     },
  { key: "eosProvision",      labelKey: "fldEosProvision",      hintKey: "fldEosProvisionHint",      filter: "liability" },
];

export default function HRSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.settings.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { data, isLoading } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });
  const [mapping, setMapping] = useState<any>({});

  useEffect(() => {
    if (data?.mapping) setMapping(data.mapping);
  }, [data]);

  const save = useMutation({
    mutationFn: () => employeesApi.updateHrSettings(mapping),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hr-settings"] });
      toast({ title: tr("toastSavedTitle"), description: tr("toastSavedDesc") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
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
    toast({ title: tr("toastAutoMappedTitle"), description: tr("toastAutoMappedDesc") });
  }

  if (isLoading) return <div className="p-4" dir={isRtl ? "rtl" : "ltr"}><Skeleton className="h-96" /></div>;

  const accounts = (data?.accounts ?? []) as any[];
  const cashBoxes = (data?.cashBoxes ?? []) as any[];
  const banks = (data?.bankAccounts ?? []) as any[];

  function accountItems(filter?: string) {
    const list = filter ? accounts.filter((a) => a.accountType === filter) : accounts;
    return list.map((a) => ({
      value: String(a.id),
      label: `${a.code} — ${pickName(a.nameAr, a.nameEn)}`,
      code: a.code,
      description: (isRtl ? a.nameEn : a.nameAr) || undefined,
    }));
  }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-hr-settings" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Settings2 className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">{tr("title")}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={autoMap} data-testid="btn-automap">
            <Sparkles className="size-4 me-1" /> {tr("btnAutoMap")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="btn-save-hr-settings">
            {save.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
            {tr("btnSave")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-blue-50/50 border-blue-200 p-3 text-sm text-blue-900 flex gap-2">
        <Info className="size-4 mt-0.5 shrink-0" />
        <div>
          {tr("infoNote")}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIELD_KEYS.map((f) => (
          <div key={f.key} className="rounded-lg border bg-card p-3 space-y-1">
            <label className="text-sm font-medium">{tr(f.labelKey)}</label>
            <SearchCombobox
              items={accountItems(f.filter)}
              value={mapping[f.key] ? String(mapping[f.key]) : ""}
              onValueChange={(v) => setMapping({ ...mapping, [f.key]: v ? Number(v) : null })}
              placeholder={tr("accChooseAccount")}
              searchPlaceholder={tr("accSearchPlaceholder")}
              className="w-full"
            />
            <div className="text-[11px] text-muted-foreground">{tr(f.hintKey)}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-card p-3 space-y-3">
        <div className="text-sm font-semibold">{tr("defaultsTitle")}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{tr("defaultCashBoxLabel")}</label>
            <SearchCombobox
              items={cashBoxes.map((c: any) => ({ value: String(c.id), label: pickName(c.nameAr, c.nameEn) || tr("defaultsCashFallback", { id: c.id }) }))}
              value={mapping.defaultPayCashBoxId ? String(mapping.defaultPayCashBoxId) : ""}
              onValueChange={(v) => setMapping({ ...mapping, defaultPayCashBoxId: v ? Number(v) : null })}
              placeholder={tr("defaultsNone")}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{tr("defaultBankLabel")}</label>
            <SearchCombobox
              items={banks.map((b: any) => ({ value: String(b.id), label: pickName(b.nameAr, b.nameEn) || tr("defaultsBankFallback", { id: b.id }) }))}
              value={mapping.defaultPayBankAccountId ? String(mapping.defaultPayBankAccountId) : ""}
              onValueChange={(v) => setMapping({ ...mapping, defaultPayBankAccountId: v ? Number(v) : null })}
              placeholder={tr("defaultsNone")}
              className="w-full"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="text-sm font-semibold mb-2">{tr("defaultPayrollEntryTitle")}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className={`p-2 ${isRtl ? "text-start" : "text-start"}`}>{tr("tblColAccount")}</th>
                <th className="p-2">{tr("tblColDebit")}</th>
                <th className="p-2">{tr("tblColCredit")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t"><td className="p-2">{tr("rowSalariesExpense")}</td><td className="p-2 text-center">✓</td><td className="p-2 text-center">—</td></tr>
              <tr className="border-t"><td className="p-2">{tr("rowAllowancesExpense")}</td><td className="p-2 text-center">✓</td><td className="p-2 text-center">—</td></tr>
              <tr className="border-t"><td className="p-2">{tr("rowSalariesPayable")}</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">{tr("rowGosiPayable")}</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">{tr("rowEmployeeLoans")}</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
              <tr className="border-t"><td className="p-2">{tr("rowOtherDeductions")}</td><td className="p-2 text-center">—</td><td className="p-2 text-center">✓</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
