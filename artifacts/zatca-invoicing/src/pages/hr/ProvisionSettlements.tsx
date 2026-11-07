import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFormatters } from "@/lib/format";

export default function ProvisionSettlements() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { fmt } = useFormatters();
  const [selected, setSelected] = useState<any>(null);
  const [leaveId, setLeaveId] = useState("");
  const [voucherId, setVoucherId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const balances = useQuery<any[]>({
    queryKey: ["employee-provision-balances"],
    queryFn: () => employeesApi.provisionBalances(),
  });
  const history = useQuery<any[]>({
    queryKey: ["employee-provision-settlements"],
    queryFn: () => employeesApi.provisionSettlements(),
  });
  const leaveQuery = useQuery<any[]>({
    queryKey: ["employee-provision-leaves", selected?.employeeId],
    queryFn: () => employeesApi.leaves(selected.employeeId),
    enabled: selected?.provisionType === "annual_leave",
  });
  const leaves = (leaveQuery.data ?? []).filter(l =>
    l.leaveType === "annual" && l.paid === true && l.status === "approved",
  );
  const mutation = useMutation({
    mutationFn: () => employeesApi.settleProvision({
      employeeId: selected.employeeId,
      provisionType: selected.provisionType,
      provisionPeriod: selected.period,
      sourceType: selected.provisionType === "annual_leave" ? "employee_leave" : "payment_voucher",
      sourceRecordId: Number(selected.provisionType === "annual_leave" ? leaveId : voucherId),
      settlementDate: date,
      amount: Number(amount),
      notes,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-provision-balances"] });
      setSelected(null); setAmount(""); setNotes(""); setLeaveId(""); setVoucherId("");
      toast({ title: "تم ترحيل تسوية المخصص" });
    },
    onError: e => toast({ variant: "destructive", title: "تعذّر ترحيل التسوية", description: parseError(e) }),
  });
  const reverseMutation = useMutation({
    mutationFn: (id: number) => employeesApi.reverseProvisionSettlement(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-provision-balances"] });
      qc.invalidateQueries({ queryKey: ["employee-provision-settlements"] });
      toast({ title: "تم عكس التسوية بقيد مقابل" });
    },
    onError: e => toast({ variant: "destructive", title: "تعذّر عكس التسوية", description: parseError(e) }),
  });

  return <div className="space-y-4">
    <div className="rounded-md border p-4 text-sm">
      <h3 className="mb-2 font-semibold">تسوية مخصص الإجازات وتذاكر السفر</h3>
      <p className="text-muted-foreground">تخفض التسوية الالتزام وتقيد مقابله دائنًا على المصروف الحالي دون إضافة تكلفة مكررة. الإجازة سنوية مدفوعة ومعتمدة؛ وسند التذكرة مرحّل على حساب مصروف التذاكر.</p>
    </div>
    {balances.isLoading ? <p className="p-4 text-sm">جارٍ تحميل الأرصدة…</p>
      : balances.isError ? <p className="p-4 text-sm text-destructive">تعذّر تحميل أرصدة المخصصات.</p>
      : <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50"><tr>{["الموظف", "الفترة", "المخصص", "المضاف", "المسوّى", "المتاح", ""].map(x =>
            <th key={x} className="p-2 text-right font-medium">{x}</th>)}</tr></thead>
          <tbody>{(balances.data ?? []).map(row => <tr key={`${row.employeeId}:${row.provisionType}:${row.period}`} className="border-t">
            <td className="p-2">{row.employeeName || row.nameEn || `#${row.employeeId}`}</td>
            <td className="p-2" dir="ltr">{row.period}</td>
            <td className="p-2">{row.provisionType === "annual_leave" ? "إجازة سنوية" : "تذكرة سفر"}</td>
            <td className="p-2">{fmt(Number(row.accrued))}</td><td className="p-2">{fmt(Number(row.settled))}</td>
            <td className="p-2 font-semibold">{fmt(Number(row.balance))}</td>
            <td className="p-2"><Button size="sm" variant="outline" disabled={Number(row.balance) <= 0}
              onClick={() => { setSelected(row); setLeaveId(""); setVoucherId(""); setAmount(""); }}>تسوية</Button></td>
          </tr>)}</tbody>
        </table>
        {!balances.data?.length && <p className="p-4 text-center text-sm text-muted-foreground">لا توجد مخصصات مرحّلة للتسوية.</p>}
      </div>}
    {selected && <div className="space-y-3 rounded-md border p-4">
      <h4 className="font-semibold">{selected.employeeName || `#${selected.employeeId}`} · {selected.period} · {selected.provisionType === "annual_leave" ? "إجازة سنوية" : "تذكرة سفر"}</h4>
      {selected.provisionType === "annual_leave"
        ? <label className="block space-y-1 text-sm">إجازة سنوية معتمدة ومدفوعة
          <select className="h-9 w-full rounded-md border bg-background px-2" value={leaveId} onChange={e => setLeaveId(e.target.value)}>
            <option value="">اختر الإجازة</option>{leaves.map(l => <option key={l.id} value={l.id}>#{l.id} · {l.startDate} — {l.endDate} · {l.days} يوم</option>)}
          </select>
        </label>
        : <label className="block space-y-1 text-sm">رقم سند مصروف التذكرة المرحّل
          <Input type="number" min="1" value={voucherId} onChange={e => setVoucherId(e.target.value)} />
        </label>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">تاريخ التسوية<Input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="space-y-1 text-sm">المبلغ · المتاح {fmt(Number(selected.balance))}
          <Input type="number" min="0.01" max={selected.balance} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="block space-y-1 text-sm">ملاحظات<Input maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="flex gap-2">
        <Button disabled={mutation.isPending || !date || !amount || Number(amount) <= 0 ||
          Number(amount) > Number(selected.balance) || (selected.provisionType === "annual_leave" ? !leaveId : !voucherId)}
          onClick={() => mutation.mutate()}>{mutation.isPending ? "جارٍ الترحيل…" : "ترحيل التسوية"}</Button>
        <Button variant="outline" onClick={() => setSelected(null)}>إلغاء</Button>
      </div>
    </div>}
    <div className="overflow-x-auto rounded-md border">
      <h4 className="p-3 font-semibold">سجل التسويات</h4>
      <table className="w-full min-w-[680px] text-sm">
        <thead className="bg-muted/50"><tr>{["الموظف", "النوع", "الفترة", "المصدر", "المبلغ", "الحالة", ""].map(x =>
          <th key={x} className="p-2 text-right font-medium">{x}</th>)}</tr></thead>
        <tbody>{(history.data ?? []).map(row => <tr key={row.id} className="border-t">
          <td className="p-2">{row.employeeName || `#${row.employeeId}`}</td>
          <td className="p-2">{row.provisionType === "annual_leave" ? "إجازة" : "تذكرة"}</td>
          <td className="p-2" dir="ltr">{row.provisionPeriod}</td>
          <td className="p-2">{row.sourceType === "employee_leave" ? `إجازة #${row.sourceRecordId}` : `سند #${row.sourceRecordId}`}</td>
          <td className="p-2">{fmt(Number(row.amount))}</td>
          <td className="p-2">{row.status === "posted" ? "مرحّلة" : "معكوسة"}</td>
          <td className="p-2">{row.status === "posted" && <Button size="sm" variant="outline"
            disabled={reverseMutation.isPending} onClick={() => reverseMutation.mutate(row.id)}>عكس</Button>}</td>
        </tr>)}</tbody>
      </table>
      {!history.isLoading && !history.data?.length && <p className="p-4 text-center text-sm text-muted-foreground">لا توجد تسويات سابقة.</p>}
    </div>
  </div>;
}
