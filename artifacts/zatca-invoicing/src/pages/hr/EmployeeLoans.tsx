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
import { Wallet, Plus, Trash2, X, Loader2, CheckCircle2, Banknote, Pencil, Printer, FileDown, FileSpreadsheet } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { useAuth } from "@/contexts/AuthContext";
import { printLoanVoucher, downloadLoanVoucherPdf, type LoanVoucherDoc } from "@/lib/loanVoucherPrint";
import { exportToExcel, type ExportColumn } from "@/lib/export";

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY: any = { employeeId: "", loanDate: today(), loanType: "loan", amount: 0, installments: 1, installmentAmt: 0, installmentStartDate: "", loanAccountId: "", reason: "", notes: "" };

// Add `months` whole months to an ISO date (YYYY-MM-DD), clamping the day to
// the target month's last day (e.g. Jan-31 + 1 month → Feb-28/29).
function addMonths(iso: string, months: number): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

// ISO (YYYY-MM-DD) → DD/MM/YYYY for read-only display, matching SmartDateInput.
function fmtDmy(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

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

  const { user } = useAuth();
  const company = (user as any)?.company ?? null;

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
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

  // Which loan is currently open in the edit form, and what is frozen.
  // Mirrors the backend integrity guard in PUT /loans/:id: disbursed loans lock
  // their JE-relevant fields (amount/employee/date/type); closed loans lock the
  // whole schedule too.
  const editingLoan = editingId ? loans.find((l: any) => l.id === editingId) : null;
  const isClosedLoan = !!editingLoan && (editingLoan.status === "cancelled" || editingLoan.status === "completed");
  const lockPrincipal = !!editingLoan && ((editingLoan.notes || "").includes("JE#") || isClosedLoan);
  const lockSchedule = isClosedLoan;

  // Selected employee → surface their bank details (read-only) in the form.
  const selectedEmp = useMemo(
    () => employees.find((e: any) => String(e.id) === String(form.employeeId)) ?? null,
    [employees, form.employeeId],
  );

  // Auto-derived end date = start date + (number of installments) months.
  const installmentEndDate = useMemo(
    () => (form.installmentStartDate ? addMonths(form.installmentStartDate, Math.max(1, Number(form.installments) || 1)) : ""),
    [form.installmentStartDate, form.installments],
  );

  function resetForm() { setForm(EMPTY); setEditingId(null); setShowForm(false); }

  function openNew() { setForm(EMPTY); setEditingId(null); setShowForm(true); }

  function openEdit(l: any) {
    setEditingId(l.id);
    setForm({
      employeeId: String(l.employeeId ?? ""),
      loanDate: l.loanDate || today(),
      loanType: l.loanType || "loan",
      amount: l.amount ?? 0,
      installments: l.installments ?? 1,
      installmentAmt: l.installmentAmt ?? 0,
      installmentStartDate: l.installmentStartDate || "",
      loanAccountId: l.loanAccountId ? String(l.loanAccountId) : "",
      reason: l.reason || "",
      notes: l.notes || "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    const payload = {
      ...form,
      installmentStartDate: form.installmentStartDate || null,
      installmentEndDate: installmentEndDate || null,
    };
    if (editingId) {
      await upd.mutateAsync({ id: editingId, data: payload });
      resetForm();
    } else {
      save.mutate(payload);
    }
  }

  function loanToVoucherDoc(l: any): LoanVoucherDoc {
    const st = STATUS[l.status] || STATUS.active;
    return {
      typeLabel: TYPES[l.loanType] || l.loanType,
      employeeName: pickName(l.empNameAr, l.empNameEn),
      employeeCode: l.empCode,
      loanDate: fmtDmy(l.loanDate),
      amount: l.amount,
      installments: l.installments,
      installmentAmt: l.installmentAmt,
      installmentStartDate: fmtDmy(l.installmentStartDate),
      installmentEndDate: fmtDmy(l.installmentEndDate),
      reason: l.reason,
      statusLabel: st.label,
      paidAmount: l.paidAmount,
    };
  }

  function printLoan(l: any) {
    printLoanVoucher({
      doc: loanToVoucherDoc(l),
      company,
      onError: (m) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: m }),
    });
  }

  async function pdfLoan(l: any) {
    try {
      await downloadLoanVoucherPdf({ doc: loanToVoucherDoc(l), company }, `سلفة-${l.empCode || l.id}`);
    } catch (e) {
      toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) });
    }
  }

  function exportExcel() {
    const num = "#,##0.00";
    const cols: ExportColumn[] = [
      { key: "employee", header: tr("colEmployee") },
      { key: "code", header: tr("colCode") },
      { key: "type", header: tr("colType") },
      { key: "date", header: tr("colDate") },
      { key: "amount", header: tr("colAmount"), numFmt: num },
      { key: "installments", header: tr("colInstallments") },
      { key: "monthly", header: tr("colMonthlyInstallment"), numFmt: num },
      { key: "start", header: tr("fieldInstallmentStartDate") },
      { key: "end", header: tr("fieldInstallmentEndDate") },
      { key: "paid", header: tr("colPaid"), numFmt: num },
      { key: "remaining", header: tr("colRemaining"), numFmt: num },
      { key: "status", header: tr("colStatus") },
    ];
    const rows = loans.map((l: any) => ({
      employee: pickName(l.empNameAr, l.empNameEn),
      code: l.empCode || "",
      type: TYPES[l.loanType] || l.loanType,
      date: fmtDmy(l.loanDate),
      amount: Number(l.amount || 0),
      installments: l.installments,
      monthly: Number(l.installmentAmt || 0),
      start: fmtDmy(l.installmentStartDate),
      end: fmtDmy(l.installmentEndDate),
      paid: Number(l.paidAmount || 0),
      remaining: +(Number(l.amount) - Number(l.paidAmount)).toFixed(2),
      status: (STATUS[l.status] || STATUS.active).label,
    }));
    exportToExcel(rows, cols, tr("title"), tr("title"));
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
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportExcel} disabled={loans.length === 0} data-testid="btn-export-loans">
            <FileSpreadsheet className="size-4 me-1" /> {tr("exportExcel")}
          </Button>
          <Button onClick={openNew} data-testid="btn-new-loan">
            <Plus className="size-4 me-1" /> {tr("newLoan")}
          </Button>
        </div>
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
          title={editingId ? tr("editTitle") : tr("formTitle")}
          onClose={resetForm}
          onSave={handleSave}
          saveLabel={tr("save")}
          saving={save.isPending || upd.isPending}
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
                disabled={lockPrincipal}
              />
            </Field>
            {selectedEmp && (
              <div className="md:col-span-3 rounded border bg-muted/30 p-2 text-xs space-y-1" data-testid="loan-bank-info">
                <div className="font-medium text-muted-foreground">{tr("bankInfoTitle")}</div>
                {(selectedEmp.bankName || selectedEmp.bankAccountIban) ? (
                  <>
                    <div><span className="text-muted-foreground">{tr("labelBankName")}</span> {selectedEmp.bankName || "—"}</div>
                    <div><span className="text-muted-foreground">{tr("labelIban")}</span> <span className="tabular-nums" dir="ltr">{selectedEmp.bankAccountIban || "—"}</span></div>
                  </>
                ) : (
                  <div className="text-amber-700">{tr("bankInfoEmpty")}</div>
                )}
              </div>
            )}
            <Field label={tr("fieldType")}>
              <SearchCombobox
                items={Object.entries(TYPES).filter(([k]) => k !== "advance").map(([k, v]) => ({ value: k, label: v }))}
                value={form.loanType}
                onValueChange={(v) => setForm({ ...form, loanType: v })}
                placeholder={tr("chooseType")}
                disabled={lockPrincipal}
              />
            </Field>
            <Field label={tr("fieldDate")}>
              <DateField value={form.loanDate} onChange={e => setForm({ ...form, loanDate: e.target.value })} disabled={lockPrincipal} data-testid="loan-date" />
            </Field>
            <Field label={tr("fieldAmount")}>
              <Input type="number" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
                onBlur={autoCalcInstallment} disabled={lockPrincipal} data-testid="loan-amount" />
            </Field>
            <Field label={tr("fieldInstallments")}>
              <Input type="number" min={1} value={form.installments} onChange={e => setForm({ ...form, installments: e.target.value })}
                onBlur={autoCalcInstallment} disabled={lockSchedule} data-testid="loan-installments" />
            </Field>
            <Field label={tr("fieldMonthlyInstallment")}>
              <Input type="number" step="0.01" value={form.installmentAmt} onChange={e => setForm({ ...form, installmentAmt: e.target.value })} disabled={lockSchedule} data-testid="loan-installment-amt" />
            </Field>
            <Field label={tr("fieldInstallmentStartDate")}>
              <DateField value={form.installmentStartDate} onChange={e => setForm({ ...form, installmentStartDate: e.target.value })} disabled={lockSchedule} data-testid="loan-installment-start" />
            </Field>
            <Field label={tr("fieldInstallmentEndDate")}>
              <Input value={fmtDmy(installmentEndDate)} readOnly disabled placeholder="—" data-testid="loan-installment-end" />
            </Field>
            <Field label={tr("fieldLoanAccount")} className="md:col-span-3">
              <SearchCombobox
                items={((hrSettings?.accounts || []) as any[]).map((a: any) => ({
                  value: String(a.id), code: a.code, label: pickName(a.nameAr, a.nameEn),
                }))}
                value={form.loanAccountId ? String(form.loanAccountId) : ""}
                onValueChange={(v) => setForm({ ...form, loanAccountId: v })}
                placeholder={tr("chooseLoanAccount")}
                searchPlaceholder={tr("searchAccountPlaceholder")}
                className="w-full"
                disabled={lockPrincipal}
                data-testid="loan-account"
              />
            </Field>
            <Field label={tr("fieldReason")} className="md:col-span-3">
              <Input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder={tr("reasonPlaceholder")} />
            </Field>
            <Field label={tr("fieldNotes")} className="md:col-span-3">
              <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
            </Field>
          </FormGrid>
          {lockPrincipal && (
            <div className="text-xs text-amber-700 bg-amber-50/60 border border-amber-200 rounded p-2 mt-2">
              {isClosedLoan ? tr("lockNoteClosed") : tr("lockNoteDisbursed")}
            </div>
          )}
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
                    <Button size="sm" variant="ghost" onClick={() => openEdit(l)} title={tr("editTooltip")} data-testid={`btn-edit-loan-${l.id}`}>
                      <Pencil className="size-3.5 text-sky-600" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => printLoan(l)} title={tr("printTooltip")} data-testid={`btn-print-loan-${l.id}`}>
                      <Printer className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => pdfLoan(l)} title={tr("pdfTooltip")} data-testid={`btn-pdf-loan-${l.id}`}>
                      <FileDown className="size-3.5 text-rose-600" />
                    </Button>
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
                {(disburseFor.empBankName || disburseFor.empBankIban) && (
                  <>
                    <div><span className="text-muted-foreground">{tr("labelBankName")}</span> {disburseFor.empBankName || "—"}</div>
                    <div><span className="text-muted-foreground">{tr("labelIban")}</span> <span className="tabular-nums" dir="ltr">{disburseFor.empBankIban || "—"}</span></div>
                  </>
                )}
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
