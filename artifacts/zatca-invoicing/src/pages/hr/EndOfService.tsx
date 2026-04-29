import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Calculator, Sparkles, Loader2, ScrollText, Printer, Banknote, CheckCircle2 } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export default function EndOfService() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { user } = useAuth() as any;
  const companyLogo: string | null = user?.company?.logo ?? null;
  const companyNameAr: string = user?.company?.nameAr ?? "";
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.endOfService.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const [empId, setEmpId] = useState<number | "">("");
  const [reason, setReason] = useState<"resignation" | "termination">("resignation");
  const [calc, setCalc] = useState<any | null>(null);
  const [explain, setExplain] = useState<string>("");
  const [showPay, setShowPay] = useState(false);
  const [payForm, setPayForm] = useState<any>({
    amount: 0, payDate: new Date().toISOString().slice(0, 10), payMethod: "cash" as "cash" | "bank",
    accountId: "" as number | "", useProvision: false, endEmployment: true, description: "",
  });

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: hrSettings } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });
  const selectedEmp = employees.find((e: any) => e.id === Number(empId));

  const payMut = useMutation({
    mutationFn: () => {
      const payload: any = {
        amount: Number(payForm.amount),
        payDate: payForm.payDate,
        useProvision: payForm.useProvision,
        endEmployment: payForm.endEmployment,
        description: payForm.description || undefined,
        cashBoxId: payForm.payMethod === "cash" && payForm.accountId ? Number(payForm.accountId) : null,
        bankAccountId: payForm.payMethod === "bank" && payForm.accountId ? Number(payForm.accountId) : null,
      };
      return employeesApi.payEos(Number(empId), payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      setShowPay(false);
      toast({ title: tr("toastPaidTitle"), description: payForm.endEmployment ? tr("toastPaidDescEnded") : "" });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  function openPayDialog() {
    if (!calc) return;
    const m = hrSettings?.mapping || {};
    let pm: "cash" | "bank" = "cash"; let acc: number | "" = "";
    if (m.defaultPayCashBoxId) { pm = "cash"; acc = m.defaultPayCashBoxId; }
    else if (m.defaultPayBankAccountId) { pm = "bank"; acc = m.defaultPayBankAccountId; }
    setPayForm({
      amount: Number(calc.netAmount.toFixed(2)),
      payDate: new Date().toISOString().slice(0, 10),
      payMethod: pm, accountId: acc, useProvision: false, endEmployment: true,
      description: tr("payDescriptionPrefix", {
        name: pickName(selectedEmp?.nameAr, selectedEmp?.nameEn),
        code: selectedEmp?.code || "",
      }),
    });
    setShowPay(true);
  }

  const calcMut = useMutation({
    mutationFn: () => employeesApi.endOfService(Number(empId), reason),
    onSuccess: (data) => {
      setCalc(data); setExplain("");
      toast({ title: tr("toastCalcDone") });
    },
    onError: (e) => {
      setCalc(null);
      toast({ variant: "destructive", title: tr("toastErrorCalcTitle"), description: parseError(e) });
    },
  });

  const explainMut = useMutation({
    mutationFn: () => employeesApi.aiExplainEos(calc, selectedEmp),
    onSuccess: (data) => { setExplain(data.explanation); toast({ title: tr("toastExplainDone") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  function printReport() { window.print(); }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-eos" dir={isRtl ? "rtl" : "ltr"}>
      {/*
        Print-only header — hidden on screen (`hidden`) but revealed by
        `print:block` so window.print() captures the company brand at the
        top of every printed EOS settlement.  Mirrors the same logo +
        company-name treatment used by the rest of the system's reports.
      */}
      <div className="hidden print:block text-center border-b-2 border-primary pb-2 mb-2">
        {companyLogo && (
          <img
            src={companyLogo}
            alt=""
            className="mx-auto"
            style={{ maxHeight: 54, maxWidth: 170, objectFit: "contain" }}
          />
        )}
        {companyNameAr && (
          <div className="text-base font-bold text-primary mt-1">{companyNameAr}</div>
        )}
        <div className="text-lg font-semibold mt-1">{tr("title")}</div>
      </div>

      <div className="flex items-center gap-2 print:hidden">
        <Calculator className="size-6 text-primary" />
        <h1 className="text-xl font-semibold">{tr("title")}</h1>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{tr("labelEmployee")}</label>
            <SearchCombobox
              items={employees.map((e: any) => ({
                value: String(e.id), code: e.code, label: pickName(e.nameAr, e.nameEn),
                description: e.hireDate ? `${tr("hireDateLabelPrefix")} ${e.hireDate}` : tr("noHireDate"),
              }))}
              value={empId ? String(empId) : ""}
              onValueChange={(v) => { setEmpId(v ? Number(v) : ""); setCalc(null); setExplain(""); }}
              placeholder={tr("chooseEmployee")}
              searchPlaceholder={tr("searchEmployeePlaceholder")}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{tr("labelReason")}</label>
            <SearchCombobox
              items={[
                { value: "resignation", label: tr("reasonResignation"), description: tr("reasonResignationDesc") },
                { value: "termination", label: tr("reasonTermination"), description: tr("reasonTerminationDesc") },
              ]}
              value={reason}
              onValueChange={(v) => { setReason(v as any); setCalc(null); setExplain(""); }}
              placeholder={tr("labelReason")}
              className="w-full"
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => calcMut.mutate()} disabled={!empId || calcMut.isPending} className="w-full" data-testid="btn-calc-eos">
              {calcMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />}
              {tr("btnCalculate")}
            </Button>
          </div>
        </div>

        {selectedEmp && (
          <div className="rounded border bg-muted/30 p-3 text-sm grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><span className="text-muted-foreground">{tr("empCode")}</span> <strong>{selectedEmp.code}</strong></div>
            <div><span className="text-muted-foreground">{tr("empName")}</span> <strong>{pickName(selectedEmp.nameAr, selectedEmp.nameEn)}</strong></div>
            <div><span className="text-muted-foreground">{tr("empNationality")}</span> <strong>{selectedEmp.nationality || "—"}</strong></div>
            <div><span className="text-muted-foreground">{tr("empJobTitle")}</span> <strong>{pickName(selectedEmp.jobTitle, selectedEmp.jobTitleEn) || "—"}</strong></div>
            <div><span className="text-muted-foreground">{tr("empHireDate")}</span> <strong>{selectedEmp.hireDate || <span className="text-rose-600">{tr("notRegistered")}</span>}</strong></div>
            <div><span className="text-muted-foreground">{tr("empBasic")}</span> <strong>{Number(selectedEmp.basicSalary || 0).toFixed(2)} {tr("step5SuffixSar")}</strong></div>
            <div><span className="text-muted-foreground">{tr("empHousing")}</span> <strong>{Number(selectedEmp.housingAllow || 0).toFixed(2)}</strong></div>
            <div><span className="text-muted-foreground">{tr("empTransport")}</span> <strong>{Number(selectedEmp.transportAllow || 0).toFixed(2)}</strong></div>
          </div>
        )}
      </div>

      {calcMut.isPending && <Skeleton className="h-64" />}

      {calc && (
        <div className="space-y-4" id="eos-report">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label={tr("cardServicePeriod")} value={tr("cardYearsUnit", { years: calc.yearsOfService })} hint={`${calc.hireDate} → ${calc.endDate}`} />
            <Card label={tr("cardMonthlySalary")} value={`${calc.monthlySalary.toFixed(2)}`} hint={tr("cardMonthlySalaryHint")} />
            <Card label={tr("cardGross")} value={`${calc.grossEntitlement.toFixed(2)}`} hint={tr("cardGrossHint")} amber />
            <Card label={tr("cardNet")} value={`${calc.netAmount.toFixed(2)}`} hint={tr("cardNetHint", { percent: (calc.factor * 100).toFixed(0) })} emerald />
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="bg-muted/40 p-3 border-b font-semibold flex items-center gap-2">
              <ScrollText className="size-4" /> {tr("detailsTitle")}
            </div>
            <div className="p-4 space-y-3">
              <Step n="1" title={tr("step1Title")}>
                <span dangerouslySetInnerHTML={{ __html: tr("step1Body", { from: calc.hireDate, to: calc.endDate, years: calc.yearsOfService }) }} />
              </Step>
              <Step n="2" title={tr("step2Title")}>
                <span dangerouslySetInnerHTML={{ __html: tr("step2Body", {
                  basic: calc.basicSalary.toFixed(2),
                  housing: calc.housingAllow.toFixed(2),
                  transport: calc.transportAllow.toFixed(2),
                  monthly: calc.monthlySalary.toFixed(2),
                }) }} />
              </Step>
              <Step n="3" title={tr("step3Title")}>
                <div className="space-y-1">
                  <div dangerouslySetInnerHTML={{ __html: tr("step3FirstFive", { years: calc.breakdown.firstFiveYears, amount: calc.breakdown.firstFiveAmount.toFixed(2) }) }} />
                  {calc.breakdown.afterFiveYears > 0 && (
                    <div dangerouslySetInnerHTML={{ __html: tr("step3AfterFive", { years: calc.breakdown.afterFiveYears, amount: calc.breakdown.afterFiveAmount.toFixed(2) }) }} />
                  )}
                  <div className="pt-1 border-t mt-2" dangerouslySetInnerHTML={{ __html: tr("step3Total", { amount: calc.grossEntitlement.toFixed(2) }) }} />
                </div>
              </Step>
              <Step n="4" title={tr("step4Title")}>
                <div className="bg-blue-50/50 border border-blue-200 rounded p-2 text-blue-900">
                  <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 me-2">{tr("step4FactorBadge", { percent: (calc.factor * 100).toFixed(0) })}</Badge>
                  {calc.factorReason}
                </div>
              </Step>
              <Step n="5" title={tr("step5Title")}>
                <div className="text-2xl font-bold text-emerald-700 tabular-nums">{calc.netAmount.toFixed(2)} {tr("step5SuffixSar")}</div>
                <div className="text-xs text-muted-foreground mt-1">{calc.grossEntitlement.toFixed(2)} × {(calc.factor * 100).toFixed(0)}% = {calc.netAmount.toFixed(2)}</div>
              </Step>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button onClick={openPayDialog} data-testid="btn-pay-eos">
              <Banknote className="size-4 me-1" /> {tr("btnPay")}
            </Button>
            <Button onClick={() => explainMut.mutate()} disabled={explainMut.isPending} variant="outline" data-testid="btn-explain-eos">
              {explainMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Sparkles className="size-4 me-1" />}
              {tr("btnExplainAi")}
            </Button>
            <Button onClick={printReport} variant="outline" data-testid="btn-print-eos">
              <Printer className="size-4 me-1" /> {tr("btnPrint")}
            </Button>
          </div>

          {explain && (
            <div className="rounded-lg border bg-blue-50/30 border-blue-200 p-4">
              <div className="flex items-center gap-2 mb-2 text-blue-900 font-semibold">
                <Sparkles className="size-4" /> {tr("explainTitle")}
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{explain}</pre>
            </div>
          )}
        </div>
      )}

      <Dialog open={showPay} onOpenChange={setShowPay}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle>{tr("payDialogTitle")}</DialogTitle>
          </DialogHeader>
          {calc && selectedEmp && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-3 space-y-1">
                <div><span className="text-muted-foreground">{tr("labelEmpDialog")}</span> <strong>{pickName(selectedEmp.nameAr, selectedEmp.nameEn)}</strong> ({selectedEmp.code})</div>
                <div><span className="text-muted-foreground">{tr("labelCalcNet")}</span> <strong className="text-emerald-700">{calc.netAmount.toFixed(2)} {tr("step5SuffixSar")}</strong></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">{tr("labelAmount")}</label>
                  <Input type="number" step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} data-testid="pay-amount" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">{tr("labelPayDate")}</label>
                  <Input type="date" value={payForm.payDate} onChange={(e) => setPayForm({ ...payForm, payDate: e.target.value })} data-testid="pay-date" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{tr("labelPayMethod")}</label>
                <div className="flex gap-2">
                  <Button type="button" variant={payForm.payMethod === "cash" ? "default" : "outline"} size="sm"
                    onClick={() => setPayForm({ ...payForm, payMethod: "cash", accountId: "" })}>{tr("methodCash")}</Button>
                  <Button type="button" variant={payForm.payMethod === "bank" ? "default" : "outline"} size="sm"
                    onClick={() => setPayForm({ ...payForm, payMethod: "bank", accountId: "" })}>{tr("methodBank")}</Button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{payForm.payMethod === "cash" ? tr("labelCashBox") : tr("labelBankAccount")}</label>
                <SearchCombobox
                  items={(payForm.payMethod === "cash" ? (hrSettings?.cashBoxes || []) : (hrSettings?.bankAccounts || [])).map((x: any) => ({
                    value: String(x.id), label: pickName(x.nameAr, x.nameEn) || `#${x.id}`,
                  }))}
                  value={payForm.accountId ? String(payForm.accountId) : ""}
                  onValueChange={(v) => setPayForm({ ...payForm, accountId: v ? Number(v) : "" })}
                  placeholder={tr("chooseAccount")}
                  className="w-full"
                />
              </div>
              <div className="space-y-2 rounded border bg-muted/20 p-3">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox checked={payForm.useProvision} onCheckedChange={(v) => setPayForm({ ...payForm, useProvision: !!v })} data-testid="use-provision" />
                  <div>
                    <div className="font-medium">{tr("useProvision")}</div>
                    <div className="text-xs text-muted-foreground">{tr("useProvisionDesc")}</div>
                  </div>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox checked={payForm.endEmployment} onCheckedChange={(v) => setPayForm({ ...payForm, endEmployment: !!v })} data-testid="end-employment" />
                  <div>
                    <div className="font-medium">{tr("endEmployment")}</div>
                    <div className="text-xs text-muted-foreground">{tr("endEmploymentDesc")}</div>
                  </div>
                </label>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{tr("labelDescription")}</label>
                <Textarea rows={2} value={payForm.description} onChange={(e) => setPayForm({ ...payForm, description: e.target.value })} />
              </div>
              <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2">
                {tr("journalNote", {
                  debit: payForm.useProvision ? tr("debitProvision") : tr("debitExpense"),
                  credit: payForm.payMethod === "cash" ? tr("creditCash") : tr("creditBank"),
                  amount: Number(payForm.amount || 0).toFixed(2),
                })}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPay(false)}>{tr("cancel")}</Button>
            <Button onClick={() => payMut.mutate()} disabled={payMut.isPending || !payForm.accountId || !(Number(payForm.amount) > 0)} data-testid="btn-confirm-pay">
              {payMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <CheckCircle2 className="size-4 me-1" />}
              {tr("confirmPay")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="text-xs text-muted-foreground bg-amber-50/50 border border-amber-200 rounded p-3 print:hidden">
        <strong>{tr("importantNotesTitle")}</strong>
        <ul className="list-disc list-inside mt-1 space-y-1">
          <li>{tr("importantNote1")}</li>
          <li>{tr("importantNote2")}</li>
          <li>{tr("importantNote3")}</li>
          <li>{tr("importantNote4")}</li>
        </ul>
      </div>
    </div>
  );
}

function Card({ label, value, hint, amber, emerald }: any) {
  return (
    <div className={`rounded-lg border p-3 bg-card ${amber ? "bg-amber-50/50 border-amber-200" : ""} ${emerald ? "bg-emerald-50/50 border-emerald-200" : ""}`}>
      <div className={`text-xs ${amber ? "text-amber-700" : emerald ? "text-emerald-700" : "text-muted-foreground"}`}>{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${amber ? "text-amber-700" : emerald ? "text-emerald-700" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function Step({ n, title, children }: any) {
  return (
    <div className="flex gap-3">
      <div className="size-7 rounded-full bg-primary/10 text-primary font-semibold text-sm flex items-center justify-center shrink-0">{n}</div>
      <div className="flex-1">
        <div className="font-medium text-sm mb-1">{title}</div>
        <div className="text-sm text-slate-700">{children}</div>
      </div>
    </div>
  );
}
