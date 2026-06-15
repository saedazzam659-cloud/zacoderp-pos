import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Wallet, Plus, Trash2, X, Loader2, CheckCircle2, Banknote } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY: any = { employeeId: "", loanDate: today(), loanType: "loan", amount: 0, installments: 1, installmentAmt: 0, reason: "", notes: "" };

export default function EmployeeLoans() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.loans.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const TYPES: Record<string, string> = {
    loan: tr("typeLoan"),
    advance: tr("typeAdvance"),
    penalty: tr("typePenalty"),
    other: tr("typeOther"),
  };
  const STATUS: Record<string, { label: string; cls: string }> = {
    active:    { label: tr("statusActive"),    cls: "bg-amber-50 text-amber-700 border-amber-200" },
    completed: { label: tr("statusCompleted"), cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    cancelled: { label: tr("statusCancelled"), cls: "bg-slate-50 text-slate-600 border-slate-200" },
  };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>(EMPTY);
  const [filter, setFilter] = useState<string>("all");
  const [disburseFor, setDisburseFor] = useState<any | null>(null);
  const [payMethod, setPayMethod] = useState<"cash" | "bank">("cash");
  const [payAccountId, setPayAccountId] = useState<number | "">("");

  const { data: hrSettings } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: loans = [], isLoading } = useQuery<any[]>({
    queryKey: ["loans", filter],
    queryFn: () => employeesApi.loans(filter === "all" ? {} : { status: filter }),
  });

  const save = useMutation({
    mutationFn: (d: any) => employeesApi.addLoan(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loans"] });
      setShowForm(false); setForm(EMPTY);
      toast({ title: tr("toastAdded") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const upd = useMutation({
    mutationFn: ({ id, data }: any) => employeesApi.updateLoan(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["loans"] }); toast({ title: tr("toastUpdated") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteLoan(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["loans"] }); toast({ title: tr("toastDeleted") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const disburseMut = useMutation({
    mutationFn: () => {
      if (!disburseFor) throw new Error(tr("errNoSelectedLoan"));
      const payload = payMethod === "cash"
        ? { cashBoxId: payAccountId ? Number(payAccountId) : null, bankAccountId: null }
        : { cashBoxId: null, bankAccountId: payAccountId ? Number(payAccountId) : null };
      return employeesApi.disburseLoan(disburseFor.id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loans"] });
      setDisburseFor(null); setPayAccountId(""); setPayMethod("cash");
      toast({ title: tr("toastDisbursed") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  function openDisburse(loan: any) {
    setDisburseFor(loan);
    const m = hrSettings?.mapping || {};
    if (m.defaultPayCashBoxId) {
      setPayMethod("cash"); setPayAccountId(m.defaultPayCashBoxId);
    } else if (m.defaultPayBankAccountId) {
      setPayMethod("bank"); setPayAccountId(m.defaultPayBankAccountId);
    }
  }

  const totals = useMemo(() => {
    let totalAmt = 0, totalPaid = 0, totalActive = 0;
    for (const l of loans) {
      totalAmt += Number(l.amount || 0);
      totalPaid += Number(l.paidAmount || 0);
      if (l.status === "active") totalActive += Number(l.amount) - Number(l.paidAmount);
    }
    return { totalAmt, totalPaid, totalActive };
  }, [loans]);

  function autoCalcInstallment() {
    const amt = Number(form.amount), n = Number(form.installments) || 1;
    if (amt > 0 && n > 0) setForm((f: any) => ({ ...f, installmentAmt: +(amt / n).toFixed(2) }));
  }

  const FILTERS: Array<[string, string]> = [
    ["all", tr("filterAll")],
    ["active", tr("filterActive")],
    ["completed", tr("filterCompleted")],
    ["cancelled", tr("filterCancelled")],
  ];

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-loans" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Wallet className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">{tr("title")}</h1>
        </div>
        <Button onClick={() => { setForm(EMPTY); setShowForm(true); }} data-testid="btn-new-loan">
          <Plus className="size-4 me-1" /> {tr("newLoan")}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-card">
          <div className="text-xs text-muted-foreground">{tr("totalLoans")}</div>
          <div className="text-2xl font-semibold tabular-nums">{totals.totalAmt.toFixed(2)} <span className="text-sm text-muted-foreground">{tr("sar")}</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200">
          <div className="text-xs text-emerald-700">{tr("totalPaid")}</div>
          <div className="text-2xl font-semibold text-emerald-700 tabular-nums">{totals.totalPaid.toFixed(2)} <span className="text-sm">{tr("sar")}</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200">
          <div className="text-xs text-amber-700">{tr("totalRemaining")}</div>
          <div className="text-2xl font-semibold text-amber-700 tabular-nums">{totals.totalActive.toFixed(2)} <span className="text-sm">{tr("sar")}</span></div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{tr("filterLabel")}</span>
        {FILTERS.map(([v, l]) => (
          <Button key={v} variant={filter === v ? "default" : "outline"} size="sm" onClick={() => setFilter(v)} data-testid={`filter-${v}`}>{l}</Button>
        ))}
      </div>

      {showForm && (
        <FormPanel
          title={tr("formTitle")}
          onClose={() => { setShowForm(false); setForm(EMPTY); }}
          onSave={() => save.mutate(form)}
          saveLabel={tr("save")}
          saving={save.isPending}
        >
          <FormGrid>
            <Field label={tr("fieldEmployee")}>
              <SearchCombobox
                items={employees.filter((e: any) => e.status === "active").map((e: any) => ({
                  value: String(e.id), code: e.code, label: pickName(e.nameAr, e.nameEn),
                  description: pickName(e.jobTitle, e.jobTitleEn) || pickName(e.department, e.departmentEn) || undefined,
                }))}
                value={form.employeeId ? String(form.employeeId) : ""}
                onValueChange={(v) => setForm({ ...form, employeeId: v })}
                placeholder={tr("chooseEmployee")}
                searchPlaceholder={tr("searchEmployeePlaceholder")}
                className="w-full"
              />
            </Field>
            <Field label={tr("fieldType")}>
              <SearchCombobox
                items={Object.entries(TYPES).map(([k, v]) => ({ value: k, label: v }))}
                value={form.loanType}
                onValueChange={(v) => setForm({ ...form, loanType: v })}
                placeholder={tr("chooseType")}
              />
            </Field>
            <Field label={tr("fieldDate")}>
              <DateField value={form.loanDate} onChange={e => setForm({ ...form, loanDate: e.target.value })} data-testid="loan-date" />
            </Field>
            <Field label={tr("fieldAmount")}>
              <Input type="number" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
                onBlur={autoCalcInstallment} data-testid="loan-amount" />
            </Field>
            <Field label={tr("fieldInstallments")}>
              <Input type="number" min={1} value={form.installments} onChange={e => setForm({ ...form, installments: e.target.value })}
                onBlur={autoCalcInstallment} data-testid="loan-installments" />
            </Field>
            <Field label={tr("fieldMonthlyInstallment")}>
              <Input type="number" step="0.01" value={form.installmentAmt} onChange={e => setForm({ ...form, installmentAmt: e.target.value })} data-testid="loan-installment-amt" />
            </Field>
            <Field label={tr("fieldReason")} className="md:col-span-3">
              <Input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder={tr("reasonPlaceholder")} />
            </Field>
            <Field label={tr("fieldNotes")} className="md:col-span-3">
              <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
            </Field>
          </FormGrid>
          <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 mt-2"
            dangerouslySetInnerHTML={{ __html: tr("formNote", { amount: Number(form.installmentAmt || 0).toFixed(2) }) }}
          />
        </FormPanel>
      )}

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">{tr("colEmployee")}</th>
              <th className="p-2">{tr("colType")}</th>
              <th className="p-2">{tr("colDate")}</th>
              <th className="p-2">{tr("colAmount")}</th>
              <th className="p-2">{tr("colInstallments")}</th>
              <th className="p-2">{tr("colMonthlyInstallment")}</th>
              <th className="p-2">{tr("colPaid")}</th>
              <th className="p-2">{tr("colRemaining")}</th>
              <th className="p-2">{tr("colStatus")}</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="p-4"><Skeleton className="h-12" /></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{tr("noLoans")}</td></tr>
            ) : loans.map((l: any) => {
              const remaining = +(Number(l.amount) - Number(l.paidAmount)).toFixed(2);
              const st = STATUS[l.status] || STATUS.active;
              return (
                <tr key={l.id} className="border-t" data-testid={`row-loan-${l.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{pickName(l.empNameAr, l.empNameEn)}</div>
                    <div className="text-xs text-muted-foreground">{l.empCode}</div>
                  </td>
                  <td className="p-2 text-xs">{TYPES[l.loanType] || l.loanType}</td>
                  <td className="p-2 text-xs">{l.loanDate}</td>
                  <td className="p-2 text-xs tabular-nums">{Number(l.amount).toFixed(2)}</td>
                  <td className="p-2 text-center text-xs">{l.installments}</td>
                  <td className="p-2 text-xs tabular-nums">{Number(l.installmentAmt).toFixed(2)}</td>
                  <td className="p-2 text-xs tabular-nums text-emerald-700">{Number(l.paidAmount).toFixed(2)}</td>
                  <td className="p-2 text-xs tabular-nums text-amber-700 font-medium">{remaining.toFixed(2)}</td>
                  <td className="p-2"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                  <td className="p-2 text-end whitespace-nowrap">
                    {l.status === "active" && !(l.notes || "").includes("JE#") && (
                      <Button size="sm" variant="ghost" onClick={() => openDisburse(l)} title={tr("disburseTooltip")} data-testid={`btn-disburse-${l.id}`}>
                        <Banknote className="size-3.5 text-emerald-600" />
                      </Button>
                    )}
                    {l.status === "active" && (l.notes || "").includes("JE#") && (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">{tr("disbursedBadge")}</Badge>
                    )}
                    {l.status === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => upd.mutate({ id: l.id, data: { status: "cancelled" } })} title={tr("cancelTooltip")}
                        data-testid={`btn-cancel-${l.id}`}>
                        <X className="size-3.5" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm(tr("deleteConfirm"))) del.mutate(l.id); }}
                      data-testid={`btn-del-loan-${l.id}`}>
                      <Trash2 className="size-3.5 text-rose-600" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={!!disburseFor} onOpenChange={(o) => { if (!o) { setDisburseFor(null); setPayAccountId(""); } }}>
        <DialogContent className="max-w-md" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle>{tr("disburseDialogTitle")}</DialogTitle>
          </DialogHeader>
          {disburseFor && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-3 space-y-1">
                <div><span className="text-muted-foreground">{tr("labelEmployee")}</span> <strong>{pickName(disburseFor.empNameAr, disburseFor.empNameEn)}</strong> ({disburseFor.empCode})</div>
                <div><span className="text-muted-foreground">{tr("labelDate")}</span> {disburseFor.loanDate}</div>
                <div><span className="text-muted-foreground">{tr("labelAmount")}</span> <strong className="text-emerald-700">{Number(disburseFor.amount).toFixed(2)} {tr("sar")}</strong></div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{tr("labelMethod")}</label>
                <div className="flex gap-2">
                  <Button type="button" variant={payMethod === "cash" ? "default" : "outline"} size="sm" onClick={() => { setPayMethod("cash"); setPayAccountId(""); }} data-testid="pay-cash">{tr("methodCash")}</Button>
                  <Button type="button" variant={payMethod === "bank" ? "default" : "outline"} size="sm" onClick={() => { setPayMethod("bank"); setPayAccountId(""); }} data-testid="pay-bank">{tr("methodBank")}</Button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{payMethod === "cash" ? tr("labelCashBox") : tr("labelBankAccount")}</label>
                <SearchCombobox
                  items={(payMethod === "cash" ? (hrSettings?.cashBoxes || []) : (hrSettings?.bankAccounts || [])).map((x: any) => ({
                    value: String(x.id), label: pickName(x.nameAr, x.nameEn) || `#${x.id}`,
                  }))}
                  value={payAccountId ? String(payAccountId) : ""}
                  onValueChange={(v) => setPayAccountId(v ? Number(v) : "")}
                  placeholder={tr("chooseAccount")}
                  className="w-full"
                />
                <div className="text-[11px] text-muted-foreground">{tr("defaultsHint")}</div>
              </div>
              <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2">
                {tr("journalNote", {
                  amount: Number(disburseFor.amount).toFixed(2),
                  methodLabel: payMethod === "cash" ? tr("labelCashBox") : tr("labelBankAccount"),
                })}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisburseFor(null)}>{tr("cancel")}</Button>
            <Button onClick={() => disburseMut.mutate()} disabled={disburseMut.isPending || !payAccountId} data-testid="btn-confirm-disburse">
              {disburseMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <CheckCircle2 className="size-4 me-1" />}
              {tr("confirmDisburse")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
