import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFormatters } from "@/lib/format";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { SearchCombobox } from "@/components/ui/search-combobox";

export default function ProvisionSettlements() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { fmt } = useFormatters();
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const ar = i18n.language === "ar";
  const text = (arabic: string, english: string) => ar ? arabic : english;
  const employeeName = (row: any) => (ar ? row.employeeName : row.nameEn || row.employeeName) || `#${row.employeeId}`;
  const [selected, setSelected] = useState<any>(null);
  const [ticketSource, setTicketSource] = useState("payment_voucher");
  const [leaveId, setLeaveId] = useState("");
  const [voucherId, setVoucherId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const balances = useQuery<any[]>({
    queryKey: ["employee-provision-balances", user?.companyId, user?.id],
    queryFn: () => employeesApi.provisionBalances(),
  });
  const readiness = useQuery<any>({
    queryKey: ["hr", "settings", user?.companyId, user?.id],
    queryFn: employeesApi.hrSettings,
  });
  const ready = readiness.data?.provisionSettlementsReady === true;
  const history = useQuery<any[]>({
    queryKey: ["employee-provision-settlements", user?.companyId, user?.id],
    queryFn: () => employeesApi.provisionSettlements(),
  });
  const leaveQuery = useQuery<any[]>({
    queryKey: ["employee-provision-leaves", user?.companyId, user?.id, selected?.employeeId],
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
      sourceType: selected.provisionType === "annual_leave" ? "employee_leave" : ticketSource,
      sourceRecordId: Number(selected.provisionType === "annual_leave" ? leaveId : voucherId),
      settlementDate: date,
      amount: Number(amount),
      notes,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-provision-balances"] });
      qc.invalidateQueries({ queryKey: ["employee-provision-settlements"] });
      setSelected(null); setAmount(""); setNotes(""); setLeaveId(""); setVoucherId("");
      toast({ title: text("تم ترحيل تسوية المخصص", "Provision settlement posted") });
    },
    onError: e => toast({ variant: "destructive", title: text("تعذّر ترحيل التسوية", "Settlement could not be posted"), description: parseError(e) }),
  });
  const reverseMutation = useMutation({
    mutationFn: (id: number) => employeesApi.reverseProvisionSettlement(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-provision-balances"] });
      qc.invalidateQueries({ queryKey: ["employee-provision-settlements"] });
      toast({ title: text("تم عكس التسوية بقيد مقابل", "Settlement reversed with a compensating entry") });
    },
    onError: e => toast({ variant: "destructive", title: text("تعذّر عكس التسوية", "Settlement could not be reversed"), description: parseError(e) }),
  });

  return <div className="space-y-4">
    {!ready && <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      {text("تسويات المخصصات قيد التحقق. الترحيل والتفعيل الجديد مغلقان حتى اكتمال دورة التسوية.", "Provision settlements are being verified. New activation and posting remain disabled.")}
    </p>}
    <div className="rounded-md border p-4 text-sm">
      <h3 className="mb-2 font-semibold">{text("تسوية مخصص الإجازات وتذاكر السفر", "Leave and travel-ticket provision settlements")}</h3>
      <p className="text-muted-foreground">{text("تخفض التسوية الالتزام دون إنشاء دفعة نقدية أو مصروف مكرر. مصدر الإجازة سنوي مدفوع ومعتمد؛ ومصدر التذكرة سند مصروف أو فاتورة شراء بقيد مصروف تذاكر مرحّل بالريال السعودي.", "Settlements reduce the liability without creating another cash payment or duplicate expense. Leave must be approved and paid; tickets require a payment voucher or purchase invoice with posted SAR ticket expense.")}</p>
    </div>
    {balances.isLoading ? <p className="p-4 text-sm">{text("جارٍ تحميل الأرصدة…", "Loading balances…")}</p>
      : balances.isError ? <p className="p-4 text-sm text-destructive">{text("تعذّر تحميل أرصدة المخصصات.", "Could not load provision balances.")}</p>
      : <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50"><tr>{(ar ? ["الموظف", "الفترة", "المخصص", "المضاف", "المسوّى", "المتاح", ""] : ["Employee", "Period", "Provision", "Accrued", "Settled", "Available", ""]).map(x =>
            <th key={x} className="p-2 text-start font-medium">{x}</th>)}</tr></thead>
          <tbody>{(balances.data ?? []).map(row => <tr key={`${row.employeeId}:${row.provisionType}:${row.period}`} className="border-t">
            <td className="p-2">{employeeName(row)}</td>
            <td className="p-2" dir="ltr">{row.period}</td>
            <td className="p-2">{row.provisionType === "annual_leave" ? text("إجازة سنوية", "Annual leave") : text("تذكرة سفر", "Travel ticket")}</td>
            <td className="p-2">{fmt(Number(row.accrued))}</td><td className="p-2">{fmt(Number(row.settled))}</td>
            <td className="p-2 font-semibold">{fmt(Number(row.balance))}</td>
            <td className="p-2"><Button size="sm" variant="outline" disabled={!ready || Number(row.balance) <= 0}
              onClick={() => { setSelected(row); setLeaveId(""); setVoucherId(""); setAmount(""); setNotes(""); setTicketSource("payment_voucher"); }}>{text("تسوية", "Settle")}</Button></td>
          </tr>)}</tbody>
        </table>
        {!balances.data?.length && <p className="p-4 text-center text-sm text-muted-foreground">{text("لا توجد مخصصات مرحّلة للتسوية.", "No posted provisions are available.")}</p>}
      </div>}
    {selected && <div className="space-y-3 rounded-md border p-4">
      <h4 className="font-semibold">{employeeName(selected)} · {selected.period} · {selected.provisionType === "annual_leave" ? text("إجازة سنوية", "Annual leave") : text("تذكرة سفر", "Travel ticket")}</h4>
      {selected.provisionType === "annual_leave"
        ? <label className="block space-y-1 text-sm">{text("إجازة سنوية معتمدة ومدفوعة", "Approved paid annual leave")}
          <SearchCombobox value={leaveId} onValueChange={setLeaveId}
            placeholder={text("اختر الإجازة", "Select leave")}
            items={leaves.map(l => ({ value: String(l.id), label: `#${l.id} · ${l.startDate} — ${l.endDate} · ${l.days} ${text("يوم", "days")}` }))} />
          {leaveQuery.isError && <span className="text-destructive">{text("تعذّر تحميل الإجازات.", "Could not load leave records.")}</span>}
        </label>
        : <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">{text("مصدر مصروف التذكرة", "Ticket expense source")}
            <SearchCombobox value={ticketSource} onValueChange={v => { setTicketSource(v); setVoucherId(""); }}
              items={[{ value: "payment_voucher", label: text("سند مصروف مرحّل", "Posted payment voucher") },
                { value: "purchase_invoice", label: text("فاتورة شراء مرحّلة", "Posted purchase invoice") }]} />
          </label>
          <label className="block space-y-1 text-sm">{text("المعرّف الداخلي للمستند", "Document internal ID")}
            <Input type="number" min="1" step="1" value={voucherId} onChange={e => setVoucherId(e.target.value)} />
          </label>
        </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">{text("تاريخ التسوية", "Settlement date")}<Input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="space-y-1 text-sm">{text("المبلغ · المتاح", "Amount · Available")} {fmt(Number(selected.balance))}
          <Input type="number" min="0.01" max={selected.balance} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="block space-y-1 text-sm">{text("ملاحظات", "Notes")}<Input maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="flex gap-2">
        <Button disabled={!ready || mutation.isPending || !date || !amount || Number(amount) <= 0 ||
          Number(amount) > Number(selected.balance) || (selected.provisionType === "annual_leave" ? !leaveId : !voucherId)}
          onClick={() => mutation.mutate()}>{mutation.isPending ? text("جارٍ الترحيل…", "Posting…") : text("ترحيل التسوية", "Post settlement")}</Button>
        <Button variant="outline" onClick={() => setSelected(null)}>{text("إلغاء", "Cancel")}</Button>
      </div>
    </div>}
    <div className="overflow-x-auto rounded-md border">
      <h4 className="p-3 font-semibold">{text("سجل التسويات", "Settlement history")}</h4>
      <table className="w-full min-w-[680px] text-sm">
        <thead className="bg-muted/50"><tr>{(ar ? ["الموظف", "النوع", "الفترة", "المصدر", "المبلغ", "الحالة", ""] : ["Employee", "Type", "Period", "Source", "Amount", "Status", ""]).map(x =>
          <th key={x} className="p-2 text-start font-medium">{x}</th>)}</tr></thead>
        <tbody>{(history.data ?? []).map(row => <tr key={row.id} className="border-t">
          <td className="p-2">{employeeName(row)}</td>
          <td className="p-2">{row.provisionType === "annual_leave" ? text("إجازة", "Leave") : text("تذكرة", "Ticket")}</td>
          <td className="p-2" dir="ltr">{row.provisionPeriod}</td>
          <td className="p-2">{row.sourceType === "employee_leave" ? text("إجازة", "Leave") : row.sourceType === "purchase_invoice" ? text("فاتورة شراء", "Purchase invoice") : text("سند مصروف", "Payment voucher")} #{row.sourceRecordId}</td>
          <td className="p-2">{fmt(Number(row.amount))}</td>
          <td className="p-2">{row.status === "posted" ? text("مرحّلة", "Posted") : text("معكوسة", "Reversed")}</td>
          <td className="p-2">{row.status === "posted" && <Button size="sm" variant="outline"
            disabled={reverseMutation.isPending} onClick={() => {
              if (window.confirm(text("عكس هذه التسوية بقيد مقابل؟ لا يتم حذف القيد الأصلي.", "Reverse this settlement with a compensating entry? The original entry will be retained.")))
                reverseMutation.mutate(row.id);
            }}>{text("عكس", "Reverse")}</Button>}</td>
        </tr>)}</tbody>
      </table>
      {history.isLoading && <p className="p-4 text-sm">{text("جارٍ تحميل السجل…", "Loading history…")}</p>}
      {history.isError && <p className="p-4 text-sm text-destructive">{text("تعذّر تحميل سجل التسويات.", "Could not load settlement history.")}</p>}
      {!history.isLoading && !history.isError && !history.data?.length && <p className="p-4 text-center text-sm text-muted-foreground">{text("لا توجد تسويات سابقة.", "No previous settlements.")}</p>}
    </div>
  </div>;
}
