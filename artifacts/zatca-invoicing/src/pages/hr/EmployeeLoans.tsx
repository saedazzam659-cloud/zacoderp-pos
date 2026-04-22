import { useState, useMemo } from "react";
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
import { Wallet, Plus, Trash2, X, Loader2, CheckCircle2 } from "lucide-react";

const TYPES: Record<string, string> = { loan: "سلفة", advance: "عُهدة", penalty: "خصم", other: "أخرى" };
const STATUS: Record<string, { label: string; cls: string }> = {
  active:    { label: "نشطة",    cls: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "مكتملة",  cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelled: { label: "ملغاة",   cls: "bg-slate-50 text-slate-600 border-slate-200" },
};
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY: any = { employeeId: "", loanDate: today(), loanType: "loan", amount: 0, installments: 1, installmentAmt: 0, reason: "", notes: "" };

export default function EmployeeLoans() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>(EMPTY);
  const [filter, setFilter] = useState<string>("all");

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
      toast({ title: "تمت إضافة السلفة" });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const upd = useMutation({
    mutationFn: ({ id, data }: any) => employeesApi.updateLoan(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["loans"] }); toast({ title: "تم التحديث" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteLoan(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["loans"] }); toast({ title: "تم الحذف" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

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

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-loans">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Wallet className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">السلف والعُهد</h1>
        </div>
        <Button onClick={() => { setForm(EMPTY); setShowForm(true); }} data-testid="btn-new-loan">
          <Plus className="size-4 me-1" /> سلفة جديدة
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-card">
          <div className="text-xs text-muted-foreground">إجمالي السلف</div>
          <div className="text-2xl font-semibold tabular-nums">{totals.totalAmt.toFixed(2)} <span className="text-sm text-muted-foreground">ر.س</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200">
          <div className="text-xs text-emerald-700">المسدّد</div>
          <div className="text-2xl font-semibold text-emerald-700 tabular-nums">{totals.totalPaid.toFixed(2)} <span className="text-sm">ر.س</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200">
          <div className="text-xs text-amber-700">المتبقي على الموظفين</div>
          <div className="text-2xl font-semibold text-amber-700 tabular-nums">{totals.totalActive.toFixed(2)} <span className="text-sm">ر.س</span></div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">الحالة:</span>
        {[["all","الكل"],["active","نشطة"],["completed","مكتملة"],["cancelled","ملغاة"]].map(([v,l]) => (
          <Button key={v} variant={filter === v ? "default" : "outline"} size="sm" onClick={() => setFilter(v)} data-testid={`filter-${v}`}>{l}</Button>
        ))}
      </div>

      {showForm && (
        <FormPanel
          title="سلفة جديدة"
          onCancel={() => { setShowForm(false); setForm(EMPTY); }}
          onSubmit={() => save.mutate(form)}
          submitLabel="حفظ"
          isSubmitting={save.isPending}
        >
          <FormGrid>
            <Field label="الموظف *">
              <select value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}
                className="h-9 w-full rounded-md border bg-background px-2" data-testid="loan-emp">
                <option value="">— اختر —</option>
                {employees.filter((e: any) => e.status === "active").map((e: any) => (
                  <option key={e.id} value={e.id}>{e.code} — {e.nameAr}</option>
                ))}
              </select>
            </Field>
            <Field label="نوع *">
              <select value={form.loanType} onChange={e => setForm({ ...form, loanType: e.target.value })}
                className="h-9 w-full rounded-md border bg-background px-2" data-testid="loan-type">
                {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="التاريخ *">
              <Input type="date" value={form.loanDate} onChange={e => setForm({ ...form, loanDate: e.target.value })} data-testid="loan-date" />
            </Field>
            <Field label="المبلغ (ر.س) *">
              <Input type="number" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
                onBlur={autoCalcInstallment} data-testid="loan-amount" />
            </Field>
            <Field label="عدد الأقساط *">
              <Input type="number" min={1} value={form.installments} onChange={e => setForm({ ...form, installments: e.target.value })}
                onBlur={autoCalcInstallment} data-testid="loan-installments" />
            </Field>
            <Field label="قيمة القسط الشهري">
              <Input type="number" step="0.01" value={form.installmentAmt} onChange={e => setForm({ ...form, installmentAmt: e.target.value })} data-testid="loan-installment-amt" />
            </Field>
            <Field label="السبب" className="md:col-span-3">
              <Input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="مثل: ظرف عائلي" />
            </Field>
            <Field label="ملاحظات" className="md:col-span-3">
              <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
            </Field>
          </FormGrid>
          <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 mt-2">
            سيتم خصم قسط شهري بقيمة <strong>{Number(form.installmentAmt || 0).toFixed(2)} ر.س</strong> من راتب الموظف تلقائياً عند تشغيل مسير الرواتب، حتى يكتمل سداد المبلغ.
          </div>
        </FormPanel>
      )}

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2">النوع</th>
              <th className="p-2">التاريخ</th>
              <th className="p-2">المبلغ</th>
              <th className="p-2">الأقساط</th>
              <th className="p-2">القسط الشهري</th>
              <th className="p-2">المسدّد</th>
              <th className="p-2">المتبقي</th>
              <th className="p-2">الحالة</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="p-4"><Skeleton className="h-12" /></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">لا توجد سلف</td></tr>
            ) : loans.map((l: any) => {
              const remaining = +(Number(l.amount) - Number(l.paidAmount)).toFixed(2);
              const st = STATUS[l.status] || STATUS.active;
              return (
                <tr key={l.id} className="border-t" data-testid={`row-loan-${l.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{l.empNameAr}</div>
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
                    {l.status === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => upd.mutate({ id: l.id, data: { status: "cancelled" } })} title="إلغاء"
                        data-testid={`btn-cancel-${l.id}`}>
                        <X className="size-3.5" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف؟")) del.mutate(l.id); }}
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
    </div>
  );
}
