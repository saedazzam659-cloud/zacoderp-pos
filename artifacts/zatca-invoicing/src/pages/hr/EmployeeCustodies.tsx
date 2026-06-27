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
import { Briefcase, Plus, Trash2, Loader2, CheckCircle2, Banknote, Pencil, Printer, FileDown, FileSpreadsheet, Undo2, ListChecks } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { useAuth } from "@/contexts/AuthContext";
import { printCustodyVoucher, downloadCustodyVoucherPdf, type CustodyVoucherDoc } from "@/lib/custodyVoucherPrint";
import { exportToExcel, type ExportColumn } from "@/lib/export";

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY: any = { employeeId: "", custodyDate: today(), amount: 0, custodyAccountId: "", purpose: "", notes: "" };
const EMPTY_SETTLE: any = { settleDate: today(), amount: 0, expenseAccountId: "", description: "", invoiceNumber: "" };

// ISO (YYYY-MM-DD) → DD/MM/YYYY for read-only display, matching SmartDateInput.
function fmtDmy(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

const num = (v: any): number => Number(v ?? 0) || 0;
const remainingOf = (c: any): number => +(num(c?.amount) - num(c?.settledAmount) - num(c?.returnedAmount)).toFixed(2);

export default function EmployeeCustodies() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.custody.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const STATUS: Record<string, { label: string; cls: string }> = {
    active:    { label: tr("statusActive"),    cls: "bg-amber-50 text-amber-700 border-amber-200" },
    settled:   { label: tr("statusSettled"),   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    cancelled: { label: tr("statusCancelled"), cls: "bg-slate-50 text-slate-600 border-slate-200" },
  };

  const { user } = useAuth();
  const company = (user as any)?.company ?? null;

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<any>(EMPTY);
  const [filter, setFilter] = useState<string>("all");

  // Disburse dialog
  const [disburseFor, setDisburseFor] = useState<any | null>(null);
  const [payMethod, setPayMethod] = useState<"cash" | "bank">("cash");
  const [payAccountId, setPayAccountId] = useState<number | "">("");

  // Settlement dialog (per custody)
  const [settleFor, setSettleFor] = useState<any | null>(null);
  const [settleForm, setSettleForm] = useState<any>(EMPTY_SETTLE);
  const [retMethod, setRetMethod] = useState<"cash" | "bank">("cash");
  const [retAccountId, setRetAccountId] = useState<number | "">("");
  const [retAmount, setRetAmount] = useState<string>("");
  const [retDate, setRetDate] = useState<string>(today());

  const { data: hrSettings } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });
  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: custodies = [], isLoading } = useQuery<any[]>({
    queryKey: ["custodies", filter],
    queryFn: () => employeesApi.custodies(filter === "all" ? {} : { status: filter }),
  });

  const { data: settlements = [], isLoading: settlementsLoading } = useQuery<any[]>({
    queryKey: ["custody-settlements", settleFor?.id],
    queryFn: () => employeesApi.custodySettlements(settleFor!.id),
    enabled: !!settleFor,
  });

  // Expense accounts for the settlement picker (fallback to all posting accounts).
  const expenseAccounts = useMemo(() => {
    const all = (hrSettings?.accounts || []) as any[];
    const exp = all.filter((a) => a.accountType === "expense");
    return exp.length ? exp : all;
  }, [hrSettings]);

  const save = useMutation({
    mutationFn: (d: any) => employeesApi.addCustody(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custodies"] });
      setShowForm(false); setForm(EMPTY);
      toast({ title: tr("toastAdded") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const upd = useMutation({
    mutationFn: ({ id, data }: any) => employeesApi.updateCustody(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custodies"] }); toast({ title: tr("toastUpdated") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteCustody(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custodies"] }); toast({ title: tr("toastDeleted") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const disburseMut = useMutation({
    mutationFn: () => {
      if (!disburseFor) throw new Error(tr("errNoSelected"));
      const payload = payMethod === "cash"
        ? { cashBoxId: payAccountId ? Number(payAccountId) : null, bankAccountId: null }
        : { cashBoxId: null, bankAccountId: payAccountId ? Number(payAccountId) : null };
      return employeesApi.disburseCustody(disburseFor.id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custodies"] });
      setDisburseFor(null); setPayAccountId(""); setPayMethod("cash");
      toast({ title: tr("toastDisbursed") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const addSettlement = useMutation({
    mutationFn: () => {
      if (!settleFor) throw new Error(tr("errNoSelected"));
      return employeesApi.addCustodySettlement(settleFor.id, {
        settleDate: settleForm.settleDate,
        amount: Number(settleForm.amount),
        expenseAccountId: Number(settleForm.expenseAccountId),
        description: settleForm.description || undefined,
        invoiceNumber: settleForm.invoiceNumber || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custody-settlements", settleFor?.id] });
      qc.invalidateQueries({ queryKey: ["custodies"] });
      setSettleForm({ ...EMPTY_SETTLE, settleDate: settleForm.settleDate });
      toast({ title: tr("toastSettled") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const delSettlement = useMutation({
    mutationFn: (sid: number) => employeesApi.deleteCustodySettlement(settleFor!.id, sid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custody-settlements", settleFor?.id] });
      qc.invalidateQueries({ queryKey: ["custodies"] });
      toast({ title: tr("toastDeleted") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const returnMut = useMutation({
    mutationFn: () => {
      if (!settleFor) throw new Error(tr("errNoSelected"));
      const base = retMethod === "cash"
        ? { cashBoxId: retAccountId ? Number(retAccountId) : null, bankAccountId: null }
        : { cashBoxId: null, bankAccountId: retAccountId ? Number(retAccountId) : null };
      return employeesApi.returnCustody(settleFor.id, {
        ...base,
        amount: retAmount ? Number(retAmount) : undefined,
        returnDate: retDate || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custody-settlements", settleFor?.id] });
      qc.invalidateQueries({ queryKey: ["custodies"] });
      setRetAmount(""); setRetAccountId(""); setRetMethod("cash");
      toast({ title: tr("toastReturned") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  function defaultPayAccount(setMethod: (m: "cash" | "bank") => void, setAcct: (id: number | "") => void) {
    const m = hrSettings?.mapping || {};
    if (m.defaultPayCashBoxId) { setMethod("cash"); setAcct(m.defaultPayCashBoxId); }
    else if (m.defaultPayBankAccountId) { setMethod("bank"); setAcct(m.defaultPayBankAccountId); }
  }

  function openDisburse(c: any) {
    setDisburseFor(c);
    defaultPayAccount(setPayMethod, setPayAccountId);
  }

  function openSettle(c: any) {
    setSettleFor(c);
    setSettleForm(EMPTY_SETTLE);
    setRetAmount(""); setRetDate(today());
    defaultPayAccount(setRetMethod, setRetAccountId);
  }

  // Keep the settle dialog's custody summary live as the list refetches.
  const liveSettleFor = settleFor ? (custodies.find((c: any) => c.id === settleFor.id) ?? settleFor) : null;

  const totals = useMemo(() => {
    let totalAmt = 0, totalCleared = 0, totalActive = 0;
    for (const c of custodies) {
      totalAmt += num(c.amount);
      totalCleared += num(c.settledAmount) + num(c.returnedAmount);
      if (c.status === "active") totalActive += remainingOf(c);
    }
    return { totalAmt, totalCleared, totalActive };
  }, [custodies]);

  const editingCustody = editingId ? custodies.find((c: any) => c.id === editingId) : null;
  const lockPrincipal = !!editingCustody && !!editingCustody.disbursementJournalId;

  const selectedEmp = useMemo(
    () => employees.find((e: any) => String(e.id) === String(form.employeeId)) ?? null,
    [employees, form.employeeId],
  );
  const disburseEmp = useMemo(
    () => (disburseFor ? employees.find((e: any) => String(e.id) === String(disburseFor.employeeId)) ?? null : null),
    [employees, disburseFor],
  );

  function resetForm() { setForm(EMPTY); setEditingId(null); setShowForm(false); }
  function openNew() { setForm(EMPTY); setEditingId(null); setShowForm(true); }
  function openEdit(c: any) {
    setEditingId(c.id);
    setForm({
      employeeId: String(c.employeeId ?? ""),
      custodyDate: c.custodyDate || today(),
      amount: c.amount ?? 0,
      custodyAccountId: c.custodyAccountId ? String(c.custodyAccountId) : "",
      purpose: c.purpose || "",
      notes: c.notes || "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    const payload = { ...form };
    if (editingId) { await upd.mutateAsync({ id: editingId, data: payload }); resetForm(); }
    else { save.mutate(payload); }
  }

  function custodyToVoucherDoc(c: any, lines?: any[]): CustodyVoucherDoc {
    const st = STATUS[c.status] || STATUS.active;
    return {
      employeeName: pickName(c.empNameAr, c.empNameEn),
      employeeCode: c.empCode,
      custodyDate: fmtDmy(c.custodyDate),
      amount: c.amount,
      settledAmount: c.settledAmount,
      returnedAmount: c.returnedAmount,
      remaining: remainingOf(c),
      purpose: c.purpose,
      notes: c.notes,
      statusLabel: st.label,
      bankName: c.empBankName,
      bankAccountIban: c.empBankIban,
      settlements: (lines || []).map((s) => ({
        settleDate: fmtDmy(s.settleDate),
        kind: s.kind,
        account: pickName(s.accountNameAr, s.accountNameEn),
        amount: s.amount,
        description: s.description,
        invoiceNumber: s.invoiceNumber,
      })),
    };
  }

  async function printCustody(c: any) {
    let lines: any[] = [];
    try { lines = await employeesApi.custodySettlements(c.id); } catch { /* print without lines */ }
    printCustodyVoucher({
      doc: custodyToVoucherDoc(c, lines),
      company,
      onError: (m) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: m }),
    });
  }

  async function pdfCustody(c: any) {
    try {
      let lines: any[] = [];
      try { lines = await employeesApi.custodySettlements(c.id); } catch { /* pdf without lines */ }
      await downloadCustodyVoucherPdf({ doc: custodyToVoucherDoc(c, lines), company }, `عهدة-${c.empCode || c.id}`);
    } catch (e) {
      toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) });
    }
  }

  function exportExcel() {
    const fmt = "#,##0.00";
    const cols: ExportColumn[] = [
      { key: "employee", header: tr("colEmployee") },
      { key: "code", header: tr("colCode") },
      { key: "date", header: tr("colDate") },
      { key: "amount", header: tr("colAmount"), numFmt: fmt },
      { key: "settled", header: tr("colSettled"), numFmt: fmt },
      { key: "returned", header: tr("colReturned"), numFmt: fmt },
      { key: "remaining", header: tr("colRemaining"), numFmt: fmt },
      { key: "purpose", header: tr("colPurpose") },
      { key: "status", header: tr("colStatus") },
    ];
    const rows = custodies.map((c: any) => ({
      employee: pickName(c.empNameAr, c.empNameEn),
      code: c.empCode || "",
      date: fmtDmy(c.custodyDate),
      amount: num(c.amount),
      settled: num(c.settledAmount),
      returned: num(c.returnedAmount),
      remaining: remainingOf(c),
      purpose: c.purpose || "",
      status: (STATUS[c.status] || STATUS.active).label,
    }));
    exportToExcel(rows, cols, tr("title"), tr("title"));
  }

  const FILTERS: Array<[string, string]> = [
    ["all", tr("filterAll")],
    ["active", tr("filterActive")],
    ["settled", tr("filterSettled")],
    ["cancelled", tr("filterCancelled")],
  ];

  const cashList = (hrSettings?.cashBoxes || []) as any[];
  const bankList = (hrSettings?.bankAccounts || []) as any[];

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-custodies" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Briefcase className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">{tr("title")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportExcel} disabled={custodies.length === 0} data-testid="btn-export-custodies">
            <FileSpreadsheet className="size-4 me-1" /> {tr("exportExcel")}
          </Button>
          <Button onClick={openNew} data-testid="btn-new-custody">
            <Plus className="size-4 me-1" /> {tr("newCustody")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-card">
          <div className="text-xs text-muted-foreground">{tr("totalCustodies")}</div>
          <div className="text-2xl font-semibold tabular-nums">{totals.totalAmt.toFixed(2)} <span className="text-sm text-muted-foreground">{tr("sar")}</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200">
          <div className="text-xs text-emerald-700">{tr("totalCleared")}</div>
          <div className="text-2xl font-semibold text-emerald-700 tabular-nums">{totals.totalCleared.toFixed(2)} <span className="text-sm">{tr("sar")}</span></div>
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
              <div className="md:col-span-3 rounded border bg-muted/30 p-2 text-xs space-y-1" data-testid="custody-bank-info">
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
            <Field label={tr("fieldDate")}>
              <DateField value={form.custodyDate} onChange={e => setForm({ ...form, custodyDate: e.target.value })} disabled={lockPrincipal} data-testid="custody-date" />
            </Field>
            <Field label={tr("fieldAmount")}>
              <Input type="number" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
                disabled={lockPrincipal} data-testid="custody-amount" />
            </Field>
            <Field label={tr("fieldCustodyAccount")} className="md:col-span-3">
              <SearchCombobox
                items={((hrSettings?.accounts || []) as any[]).map((a: any) => ({
                  value: String(a.id), code: a.code, label: pickName(a.nameAr, a.nameEn),
                }))}
                value={form.custodyAccountId ? String(form.custodyAccountId) : ""}
                onValueChange={(v) => setForm({ ...form, custodyAccountId: v })}
                placeholder={tr("chooseCustodyAccount")}
                searchPlaceholder={tr("searchAccountPlaceholder")}
                className="w-full"
                disabled={lockPrincipal}
                data-testid="custody-account"
              />
            </Field>
            <Field label={tr("fieldPurpose")} className="md:col-span-3">
              <Input value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} placeholder={tr("purposePlaceholder")} />
            </Field>
            <Field label={tr("fieldNotes")} className="md:col-span-3">
              <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
            </Field>
          </FormGrid>
          {lockPrincipal && (
            <div className="text-xs text-amber-700 bg-amber-50/60 border border-amber-200 rounded p-2 mt-2">
              {tr("lockNoteDisbursed")}
            </div>
          )}
          <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 mt-2">
            {tr("formNote")}
          </div>
        </FormPanel>
      )}

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">{tr("colEmployee")}</th>
              <th className="p-2">{tr("colDate")}</th>
              <th className="p-2">{tr("colAmount")}</th>
              <th className="p-2">{tr("colSettled")}</th>
              <th className="p-2">{tr("colReturned")}</th>
              <th className="p-2">{tr("colRemaining")}</th>
              <th className="p-2">{tr("colStatus")}</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="p-4"><Skeleton className="h-12" /></td></tr>
            ) : custodies.length === 0 ? (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{tr("noCustodies")}</td></tr>
            ) : custodies.map((c: any) => {
              const remaining = remainingOf(c);
              const st = STATUS[c.status] || STATUS.active;
              const disbursed = !!c.disbursementJournalId;
              return (
                <tr key={c.id} className="border-t" data-testid={`row-custody-${c.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{pickName(c.empNameAr, c.empNameEn)}</div>
                    <div className="text-xs text-muted-foreground">{c.empCode}</div>
                  </td>
                  <td className="p-2 text-xs">{c.custodyDate}</td>
                  <td className="p-2 text-xs tabular-nums">{num(c.amount).toFixed(2)}</td>
                  <td className="p-2 text-xs tabular-nums text-emerald-700">{num(c.settledAmount).toFixed(2)}</td>
                  <td className="p-2 text-xs tabular-nums text-sky-700">{num(c.returnedAmount).toFixed(2)}</td>
                  <td className="p-2 text-xs tabular-nums text-amber-700 font-medium">{remaining.toFixed(2)}</td>
                  <td className="p-2"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                  <td className="p-2 text-end whitespace-nowrap">
                    {!disbursed && c.status !== "cancelled" && (
                      <Button size="sm" variant="ghost" onClick={() => openDisburse(c)} title={tr("disburseTooltip")} data-testid={`btn-disburse-${c.id}`}>
                        <Banknote className="size-3.5 text-emerald-600" />
                      </Button>
                    )}
                    {disbursed && (
                      <Button size="sm" variant="ghost" onClick={() => openSettle(c)} title={tr("settleTooltip")} data-testid={`btn-settle-${c.id}`}>
                        <ListChecks className="size-3.5 text-emerald-600" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)} title={tr("editTooltip")} data-testid={`btn-edit-custody-${c.id}`}>
                      <Pencil className="size-3.5 text-sky-600" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => printCustody(c)} title={tr("printTooltip")} data-testid={`btn-print-custody-${c.id}`}>
                      <Printer className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => pdfCustody(c)} title={tr("pdfTooltip")} data-testid={`btn-pdf-custody-${c.id}`}>
                      <FileDown className="size-3.5 text-rose-600" />
                    </Button>
                    {!disbursed && (
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm(tr("deleteConfirm"))) del.mutate(c.id); }}
                        title={tr("deleteTooltip")} data-testid={`btn-del-custody-${c.id}`}>
                        <Trash2 className="size-3.5 text-rose-600" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Disburse dialog */}
      <Dialog open={!!disburseFor} onOpenChange={(o) => { if (!o) { setDisburseFor(null); setPayAccountId(""); } }}>
        <DialogContent className="max-w-md" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{tr("disburseDialogTitle")}</DialogTitle></DialogHeader>
          {disburseFor && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-3 space-y-1">
                <div><span className="text-muted-foreground">{tr("labelEmployee")}</span> <strong>{pickName(disburseFor.empNameAr, disburseFor.empNameEn)}</strong> ({disburseFor.empCode})</div>
                <div><span className="text-muted-foreground">{tr("labelDate")}</span> {disburseFor.custodyDate}</div>
                <div><span className="text-muted-foreground">{tr("labelAmount")}</span> <strong className="text-emerald-700">{num(disburseFor.amount).toFixed(2)} {tr("sar")}</strong></div>
                {(disburseEmp?.bankName || disburseEmp?.bankAccountIban) && (
                  <>
                    <div><span className="text-muted-foreground">{tr("labelBankName")}</span> {disburseEmp.bankName || "—"}</div>
                    <div><span className="text-muted-foreground">{tr("labelIban")}</span> <span className="tabular-nums" dir="ltr">{disburseEmp.bankAccountIban || "—"}</span></div>
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
                  items={(payMethod === "cash" ? cashList : bankList).map((x: any) => ({ value: String(x.id), label: pickName(x.nameAr, x.nameEn) || `#${x.id}` }))}
                  value={payAccountId ? String(payAccountId) : ""}
                  onValueChange={(v) => setPayAccountId(v ? Number(v) : "")}
                  placeholder={tr("chooseAccount")}
                  className="w-full"
                />
                <div className="text-[11px] text-muted-foreground">{tr("defaultsHint")}</div>
              </div>
              <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2">
                {tr("disburseJournalNote", { amount: num(disburseFor.amount).toFixed(2), methodLabel: payMethod === "cash" ? tr("labelCashBox") : tr("labelBankAccount") })}
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

      {/* Settlement dialog */}
      <Dialog open={!!settleFor} onOpenChange={(o) => { if (!o) { setSettleFor(null); setSettleForm(EMPTY_SETTLE); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{tr("settleDialogTitle")}</DialogTitle></DialogHeader>
          {liveSettleFor && (
            <div className="space-y-4 text-sm">
              <div className="rounded border bg-muted/30 p-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                <div><div className="text-[11px] text-muted-foreground">{tr("labelEmployee")}</div><strong>{pickName(liveSettleFor.empNameAr, liveSettleFor.empNameEn)}</strong></div>
                <div><div className="text-[11px] text-muted-foreground">{tr("colAmount")}</div><strong>{num(liveSettleFor.amount).toFixed(2)}</strong></div>
                <div><div className="text-[11px] text-muted-foreground">{tr("colSettled")}</div><strong className="text-emerald-700">{(num(liveSettleFor.settledAmount) + num(liveSettleFor.returnedAmount)).toFixed(2)}</strong></div>
                <div><div className="text-[11px] text-muted-foreground">{tr("colRemaining")}</div><strong className="text-amber-700">{remainingOf(liveSettleFor).toFixed(2)}</strong></div>
              </div>

              {/* Existing lines */}
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="p-2 text-start">{tr("colDate")}</th>
                      <th className="p-2 text-start">{tr("colKind")}</th>
                      <th className="p-2 text-start">{tr("colAccountOrNote")}</th>
                      <th className="p-2 text-start">{tr("colInvoice")}</th>
                      <th className="p-2">{tr("colAmount")}</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlementsLoading ? (
                      <tr><td colSpan={6} className="p-3"><Skeleton className="h-8" /></td></tr>
                    ) : settlements.length === 0 ? (
                      <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">{tr("noSettlements")}</td></tr>
                    ) : settlements.map((s: any) => (
                      <tr key={s.id} className="border-t" data-testid={`row-settlement-${s.id}`}>
                        <td className="p-2">{fmtDmy(s.settleDate)}</td>
                        <td className="p-2">
                          <Badge variant="outline" className={s.kind === "return" ? "bg-sky-50 text-sky-700 border-sky-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}>
                            {s.kind === "return" ? tr("kindReturn") : tr("kindExpense")}
                          </Badge>
                        </td>
                        <td className="p-2">{pickName(s.accountNameAr, s.accountNameEn) || s.description || "—"}</td>
                        <td className="p-2">{s.invoiceNumber || "—"}</td>
                        <td className="p-2 text-center tabular-nums">{num(s.amount).toFixed(2)}</td>
                        <td className="p-2 text-end">
                          <Button size="sm" variant="ghost" onClick={() => { if (confirm(tr("deleteSettlementConfirm"))) delSettlement.mutate(s.id); }}
                            data-testid={`btn-del-settlement-${s.id}`}>
                            <Trash2 className="size-3.5 text-rose-600" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add expense settlement */}
              {liveSettleFor.status !== "cancelled" && remainingOf(liveSettleFor) > 0.005 && (
                <div className="rounded-lg border p-3 space-y-3 bg-card">
                  <div className="text-sm font-semibold text-emerald-700">{tr("addSettlementTitle")}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Field label={tr("fieldDate")}>
                      <DateField value={settleForm.settleDate} onChange={e => setSettleForm({ ...settleForm, settleDate: e.target.value })} data-testid="settle-date" />
                    </Field>
                    <Field label={tr("fieldAmount")}>
                      <Input type="number" step="0.01" value={settleForm.amount} onChange={e => setSettleForm({ ...settleForm, amount: e.target.value })} data-testid="settle-amount" />
                    </Field>
                    <Field label={tr("fieldExpenseAccount")} className="md:col-span-2">
                      <SearchCombobox
                        items={expenseAccounts.map((a: any) => ({ value: String(a.id), code: a.code, label: pickName(a.nameAr, a.nameEn) }))}
                        value={settleForm.expenseAccountId ? String(settleForm.expenseAccountId) : ""}
                        onValueChange={(v) => setSettleForm({ ...settleForm, expenseAccountId: v })}
                        placeholder={tr("chooseExpenseAccount")}
                        className="w-full"
                      />
                    </Field>
                    <Field label={tr("fieldInvoiceNumber")}>
                      <Input value={settleForm.invoiceNumber} onChange={e => setSettleForm({ ...settleForm, invoiceNumber: e.target.value })} placeholder={tr("invoiceNumberPlaceholder")} data-testid="settle-invoice" />
                    </Field>
                    <Field label={tr("fieldDescription")}>
                      <Input value={settleForm.description} onChange={e => setSettleForm({ ...settleForm, description: e.target.value })} placeholder={tr("descriptionPlaceholder")} data-testid="settle-description" />
                    </Field>
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => addSettlement.mutate()}
                      disabled={addSettlement.isPending || !(Number(settleForm.amount) > 0) || !settleForm.expenseAccountId}
                      data-testid="btn-add-settlement">
                      {addSettlement.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Plus className="size-4 me-1" />}
                      {tr("addSettlement")}
                    </Button>
                  </div>
                </div>
              )}

              {/* Return remaining */}
              {liveSettleFor.status !== "cancelled" && remainingOf(liveSettleFor) > 0.005 && (
                <div className="rounded-lg border p-3 space-y-3 bg-sky-50/40 border-sky-200">
                  <div className="text-sm font-semibold text-sky-700">{tr("returnTitle")}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Field label={tr("fieldReturnAmount")}>
                      <Input type="number" step="0.01" value={retAmount} onChange={e => setRetAmount(e.target.value)}
                        placeholder={remainingOf(liveSettleFor).toFixed(2)} data-testid="return-amount" />
                    </Field>
                    <Field label={tr("fieldDate")}>
                      <DateField value={retDate} onChange={e => setRetDate(e.target.value)} data-testid="return-date" />
                    </Field>
                    <Field label={tr("labelMethod")}>
                      <div className="flex gap-2">
                        <Button type="button" variant={retMethod === "cash" ? "default" : "outline"} size="sm" onClick={() => { setRetMethod("cash"); setRetAccountId(""); }}>{tr("methodCash")}</Button>
                        <Button type="button" variant={retMethod === "bank" ? "default" : "outline"} size="sm" onClick={() => { setRetMethod("bank"); setRetAccountId(""); }}>{tr("methodBank")}</Button>
                      </div>
                    </Field>
                    <Field label={retMethod === "cash" ? tr("labelCashBox") : tr("labelBankAccount")}>
                      <SearchCombobox
                        items={(retMethod === "cash" ? cashList : bankList).map((x: any) => ({ value: String(x.id), label: pickName(x.nameAr, x.nameEn) || `#${x.id}` }))}
                        value={retAccountId ? String(retAccountId) : ""}
                        onValueChange={(v) => setRetAccountId(v ? Number(v) : "")}
                        placeholder={tr("chooseAccount")}
                        className="w-full"
                      />
                    </Field>
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => returnMut.mutate()}
                      disabled={returnMut.isPending || !retAccountId}
                      className="border-sky-300 text-sky-700" data-testid="btn-return">
                      {returnMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Undo2 className="size-4 me-1" />}
                      {tr("confirmReturn")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleFor(null)}>{tr("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
