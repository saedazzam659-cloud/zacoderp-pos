import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi } from "@/lib/cashAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ExportButtons from "@/components/ExportButtons";
import { ArrowDownCircle, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const COLS = [
  { key: "date",             header: "التاريخ",     width: 12 },
  { key: "code",             header: "رقم السند",   width: 14 },
  { key: "paymentTypeLabel", header: "نوع الدفع",   width: 12 },
  { key: "entityTypeLabel",  header: "نوع الجهة",   width: 12 },
  { key: "entityName",       header: "المستلم منه", width: 22 },
  { key: "description",      header: "البيان",      width: 28 },
  { key: "amount",           header: "المبلغ",      width: 16 },
];

export default function ReceiptVouchersReport() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to,   setTo]   = useState(today);
  const [paymentType, setPaymentType] = useState<string>("all");
  const [entityType,  setEntityType]  = useState<string>("all");

  const { data = [], isLoading } = useQuery({
    queryKey: ["receipt-vouchers-report", cid, from, to, paymentType, entityType],
    queryFn: () => cashAnalyticsApi.receipts(cid, {
      from, to,
      paymentType: paymentType === "all" ? undefined : paymentType,
      entityType:  entityType  === "all" ? undefined : entityType,
    }),
  });

  const total = data.reduce((s, r) => s + r.amount, 0);

  const exportRows = data.map(r => ({
    date: r.date, code: r.code,
    paymentTypeLabel: r.paymentTypeLabel,
    entityTypeLabel: r.entityTypeLabel,
    entityName: r.entityName ?? "—",
    description: r.description ?? "—",
    amount: fmt(r.amount),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowDownCircle className="h-6 w-6 text-primary" />تقرير سندات القبض</h1>
          <p className="text-muted-foreground text-sm mt-1">قائمة بكل سندات القبض المعتمدة خلال الفترة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`سندات-القبض-${from}-${to}`}
          title="تقرير سندات القبض"
          subtitle={`${from} → ${to}`}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">الفلاتر</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>نوع الدفع</Label>
            <Select value={paymentType} onValueChange={setPaymentType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="cash">نقدي</SelectItem>
                <SelectItem value="bank">بنكي</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>نوع الجهة</Label>
            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="customer">عميل</SelectItem>
                <SelectItem value="supplier">مورد</SelectItem>
                <SelectItem value="other">أخرى</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">عدد السندات</p>
          <p className="text-xl font-bold tabular-nums mt-1">{data.length}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4 col-span-2">
          <p className="text-xs text-emerald-700">إجمالي المقبوضات</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(total)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">رقم السند</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">نوع الدفع</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">نوع الجهة</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">المستلم منه</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">البيان</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">المبلغ</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : data.length === 0
                ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">لا توجد سندات قبض في الفترة المحددة</td></tr>
                : data.map(r => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.date}</td>
                      <td className="px-4 py-3 text-xs font-mono">{r.code}</td>
                      <td className="px-4 py-3 text-xs">{r.paymentTypeLabel}</td>
                      <td className="px-4 py-3 text-xs">{r.entityTypeLabel}</td>
                      <td className="px-4 py-3 text-xs">{r.entityName ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{r.description ?? "—"}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{fmt(r.amount)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && data.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-xs font-semibold text-muted-foreground">الإجمالي</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
