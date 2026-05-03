import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Wallet, Phone, Calendar, AlertTriangle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function fmt(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Row = {
  id: number; contractId: number; installmentNumber: number; dueDate: string;
  amount: string; paidAmount: string; status: string;
  contractNumber: string; customerName: string; phone: string | null;
};

export default function InstallmentCollection() {
  const { user, token } = useAuth() as any;
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<"due" | "overdue">("overdue");

  const { data: due = [], isLoading: loadingDue } = useQuery<Row[]>({
    queryKey: ["installments-due", cid, days],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/reports/due?companyId=${cid}&days=${days}`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    enabled: !!cid,
  });
  const { data: overdue = [], isLoading: loadingOverdue } = useQuery<Row[]>({
    queryKey: ["installments-overdue", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/reports/overdue?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    enabled: !!cid,
  });

  const rows = tab === "due" ? due : overdue;
  const isLoading = tab === "due" ? loadingDue : loadingOverdue;
  const totalAmount = rows.reduce((s, r) => s + (Number(r.amount) - Number(r.paidAmount)), 0);

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wallet className="h-6 w-6 text-emerald-600" />
          شاشة التحصيل
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          الأقساط المستحقة والمتأخرة — تواصل مع العملاء وسجّل المدفوعات.
        </p>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <div className="flex rounded-lg border overflow-hidden">
          <button
            className={cn("px-4 py-2 text-sm font-medium transition-colors",
              tab === "overdue" ? "bg-rose-600 text-white" : "bg-white hover:bg-slate-50")}
            onClick={() => setTab("overdue")}
          >
            <AlertTriangle className="h-4 w-4 inline ms-1" />
            متأخرة ({overdue.length})
          </button>
          <button
            className={cn("px-4 py-2 text-sm font-medium border-s transition-colors",
              tab === "due" ? "bg-amber-500 text-white" : "bg-white hover:bg-slate-50")}
            onClick={() => setTab("due")}
          >
            <Calendar className="h-4 w-4 inline ms-1" />
            مستحقة قريباً ({due.length})
          </button>
        </div>
        {tab === "due" && (
          <div className="flex items-center gap-1 text-sm">
            <span>خلال</span>
            <Input type="number" min="1" max="365" value={days}
              onChange={e => setDays(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 h-9 text-center" />
            <span>يوم</span>
          </div>
        )}
        <div className="flex-1" />
        <div className="text-sm">
          <span className="text-muted-foreground">إجمالي المتبقي: </span>
          <span className="font-bold text-rose-700">{fmt(totalAmount)} ر.س</span>
        </div>
      </div>

      <div className="rounded-lg border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className={cn("bg-gradient-to-b text-white",
              tab === "overdue" ? "from-rose-600 to-rose-700" : "from-amber-500 to-amber-600")}>
              <tr>
                <th className="p-2 text-start">العقد</th>
                <th className="p-2 text-start">العميل</th>
                <th className="p-2 text-start">الهاتف</th>
                <th className="p-2 text-center">قسط #</th>
                <th className="p-2 text-start">الاستحقاق</th>
                <th className="p-2 text-end">المبلغ</th>
                <th className="p-2 text-end">المتبقي</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={8} className="p-8"><Skeleton className="h-12" /></td></tr>}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">
                  {tab === "overdue" ? "لا توجد أقساط متأخرة — أحسنت!" : "لا توجد أقساط مستحقة في الفترة المحددة"}
                </td></tr>
              )}
              {rows.map(r => {
                const remaining = Number(r.amount) - Number(r.paidAmount);
                return (
                  <tr key={r.id} className={cn("border-t hover:bg-slate-50",
                    tab === "overdue" ? "bg-rose-50/40" : "")}>
                    <td className="p-2 font-mono">{r.contractNumber}</td>
                    <td className="p-2 font-medium">{r.customerName}</td>
                    <td className="p-2">
                      {r.phone ? (
                        <a href={`tel:${r.phone}`} className="text-indigo-600 hover:underline flex items-center gap-1">
                          <Phone className="h-3 w-3" />{r.phone}
                        </a>
                      ) : "—"}
                    </td>
                    <td className="p-2 text-center">{r.installmentNumber}</td>
                    <td className="p-2">{r.dueDate}</td>
                    <td className="p-2 text-end">{fmt(r.amount)}</td>
                    <td className="p-2 text-end font-bold text-rose-700">{fmt(remaining)}</td>
                    <td className="p-2 text-center">
                      <Link href={`/installments/contracts/${r.contractId}`}>
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          <ExternalLink className="h-3 w-3 ms-1" /> فتح العقد
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
