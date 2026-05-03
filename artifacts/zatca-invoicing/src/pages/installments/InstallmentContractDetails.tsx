import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel } from "@/components/FormPanel";
import {
  CreditCard, ArrowRight, Wallet, Calendar, Phone, ShieldCheck,
  CheckCircle2, AlertTriangle, Sparkles, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function fmt(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ROW_TONE: Record<string, string> = {
  paid: "bg-emerald-50",
  partial: "bg-amber-50",
  overdue: "bg-rose-50",
  pending: "",
};
const ROW_LABEL: Record<string, string> = {
  paid: "مسدد", partial: "جزئي", overdue: "متأخر", pending: "معلق",
};

export default function InstallmentContractDetails() {
  const [, params] = useRoute("/installments/contracts/:id");
  const id = Number(params?.id);
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [showPay, setShowPay] = useState(false);
  const [payForm, setPayForm] = useState({
    installmentId: "" as string,
    amount: "0",
    paymentMethod: "cash" as "cash" | "transfer" | "card" | "wallet",
    reference: "",
    notes: "",
  });

  const { data, isLoading } = useQuery<any>({
    queryKey: ["installment-contract", id, cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/contracts/${id}?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل العقد");
      return r.json();
    },
    enabled: !!id && !!cid,
  });

  const payMut = useMutation({
    mutationFn: async () => {
      const amt = Number(payForm.amount);
      if (!(amt > 0)) throw new Error("قيمة الدفعة يجب أن تكون أكبر من صفر");
      const r = await fetch(`${API}/api/installments/contracts/${id}/payments?companyId=${cid}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          installmentId: payForm.installmentId ? Number(payForm.installmentId) : null,
          amount: amt,
          paymentMethod: payForm.paymentMethod,
          reference: payForm.reference || null,
          notes: payForm.notes || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر تسجيل الدفعة");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-contract", id, cid] });
      qc.invalidateQueries({ queryKey: ["installment-contracts", cid] });
      toast({ title: "تم تسجيل الدفعة" });
      setShowPay(false);
      setPayForm({ installmentId: "", amount: "0", paymentMethod: "cash", reference: "", notes: "" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-64" /></div>;
  if (!data) return <div className="p-6 text-center">العقد غير موجود</div>;

  const totalCollected = (data.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const outstanding = Number(data.totalAmount ?? 0) - totalCollected;
  const paidCount = (data.schedule ?? []).filter((s: any) => s.status === "paid").length;
  const overdueCount = (data.schedule ?? []).filter((s: any) => s.status === "overdue").length;

  function startPayment(installmentId?: number, amount?: number) {
    setPayForm({
      installmentId: installmentId ? String(installmentId) : "",
      amount: amount ? String(amount) : "0",
      paymentMethod: "cash",
      reference: "",
      notes: "",
    });
    setShowPay(true);
  }

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/installments/contracts" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <ArrowRight className="h-4 w-4" /> رجوع للعقود
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2 mt-1">
            <CreditCard className="h-6 w-6 text-indigo-600" />
            العقد {data.contractNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.customerName} {data.phone && <><Phone className="inline h-3 w-3 mx-1" />{data.phone}</>}
          </p>
        </div>
        {data.status === "active" && (
          <Button onClick={() => startPayment()} data-testid="btn-pay">
            <Wallet className="h-4 w-4 ms-2" /> تسجيل دفعة
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="المبلغ المموَّل" value={fmt(data.financedAmount)} />
        <Card label="إجمالي العقد" value={fmt(data.totalAmount)} tone="indigo" />
        <Card label="المحصَّل" value={fmt(totalCollected)} tone="emerald" />
        <Card label="المتبقي" value={fmt(outstanding)} tone="amber" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-muted-foreground">قيمة القسط</div>
          <div className="text-xl font-bold mt-1">{fmt(data.installmentAmount)}</div>
          <div className="text-xs text-muted-foreground mt-1">{data.installmentCount} قسط شهري</div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-muted-foreground">تقدم السداد</div>
          <div className="text-xl font-bold mt-1">{paidCount} / {data.installmentCount}</div>
          <div className="w-full h-2 bg-slate-200 rounded mt-2 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${(paidCount / Math.max(1, data.installmentCount)) * 100}%` }} />
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-indigo-600" /> درجة الائتمان
          </div>
          <div className={cn("text-xl font-bold mt-1",
            (data.creditScore ?? 0) >= 75 ? "text-emerald-600" :
            (data.creditScore ?? 0) >= 55 ? "text-amber-600" : "text-rose-600")}>
            {data.creditScore ?? "—"} / 100
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            مخاطر: {data.riskLevel === "low" ? "منخفضة" : data.riskLevel === "medium" ? "متوسطة" : "عالية"}
            {" "}— احتمال تعثر {data.defaultProbability}%
          </div>
        </div>
      </div>

      {overdueCount > 0 && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 flex items-center gap-2 text-rose-800">
          <AlertTriangle className="h-5 w-5" />
          <span className="text-sm font-medium">يوجد {overdueCount} قسط متأخر — يُنصح بالتواصل مع العميل.</span>
        </div>
      )}

      <div className="rounded-lg border bg-white overflow-hidden shadow-sm">
        <div className="px-3 py-2 bg-slate-100 border-b font-bold text-sm flex items-center gap-2">
          <Calendar className="h-4 w-4" /> جدول الأقساط
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-start">#</th>
                <th className="p-2 text-start">تاريخ الاستحقاق</th>
                <th className="p-2 text-end">المبلغ</th>
                <th className="p-2 text-end">المسدد</th>
                <th className="p-2 text-end">المتبقي</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {(data.schedule ?? []).map((s: any) => {
                const remaining = Number(s.amount) - Number(s.paidAmount);
                return (
                  <tr key={s.id} className={cn("border-t", ROW_TONE[s.status] ?? "")}>
                    <td className="p-2">{s.installmentNumber}</td>
                    <td className="p-2">{s.dueDate}</td>
                    <td className="p-2 text-end">{fmt(s.amount)}</td>
                    <td className="p-2 text-end text-emerald-700">{fmt(s.paidAmount)}</td>
                    <td className="p-2 text-end font-medium">{fmt(remaining)}</td>
                    <td className="p-2 text-center">
                      {s.status === "paid" && <CheckCircle2 className="h-4 w-4 text-emerald-600 inline" />}
                      {s.status === "overdue" && <AlertTriangle className="h-4 w-4 text-rose-600 inline" />}
                      {s.status === "pending" && <Clock className="h-4 w-4 text-slate-400 inline" />}
                      <span className="ms-1">{ROW_LABEL[s.status]}</span>
                    </td>
                    <td className="p-2 text-center">
                      {s.status !== "paid" && data.status === "active" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs"
                          onClick={() => startPayment(s.id, remaining)}>
                          سداد
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(data.payments ?? []).length > 0 && (
        <div className="rounded-lg border bg-white overflow-hidden shadow-sm">
          <div className="px-3 py-2 bg-slate-100 border-b font-bold text-sm flex items-center gap-2">
            <Wallet className="h-4 w-4" /> سجل المدفوعات ({data.payments.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" dir="rtl">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-start">التاريخ</th>
                  <th className="p-2 text-end">المبلغ</th>
                  <th className="p-2 text-start">الطريقة</th>
                  <th className="p-2 text-start">المرجع</th>
                  <th className="p-2 text-start">المستلم</th>
                  <th className="p-2 text-start">ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p: any) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2">{new Date(p.paidAt).toLocaleString("ar-SA")}</td>
                    <td className="p-2 text-end font-medium text-emerald-700">{fmt(p.amount)}</td>
                    <td className="p-2">
                      {{cash: "نقد", transfer: "تحويل", card: "بطاقة", wallet: "محفظة"}[p.paymentMethod as string]}
                    </td>
                    <td className="p-2">{p.reference ?? "—"}</td>
                    <td className="p-2">{p.receivedBy ?? "—"}</td>
                    <td className="p-2">{p.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showPay && (
        <FormPanel
          icon={Wallet}
          title="تسجيل دفعة"
          subtitle={`العقد ${data.contractNumber} — ${data.customerName}`}
          width="lg"
          onClose={() => setShowPay(false)}
          onSave={() => payMut.mutate()}
          saving={payMut.isPending}
          saveLabel="تأكيد الدفعة"
          cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label>القسط المُسدَّد عنه</Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={payForm.installmentId}
                onChange={e => setPayForm({...payForm, installmentId: e.target.value})}
              >
                <option value="">— تلقائي (أول قسط غير مسدد) —</option>
                {(data.schedule ?? []).filter((s: any) => s.status !== "paid").map((s: any) => (
                  <option key={s.id} value={s.id}>
                    قسط #{s.installmentNumber} — استحقاق {s.dueDate} — متبقي {fmt(Number(s.amount) - Number(s.paidAmount))} ر.س
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>المبلغ (ر.س) *</Label>
              <Input type="number" step="0.01" min="0.01" value={payForm.amount}
                onChange={e => setPayForm({...payForm, amount: e.target.value})} data-testid="input-pay-amount" />
            </div>
            <div>
              <Label>طريقة الدفع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={payForm.paymentMethod}
                onChange={e => setPayForm({...payForm, paymentMethod: e.target.value as any})}>
                <option value="cash">نقد</option>
                <option value="transfer">تحويل بنكي</option>
                <option value="card">بطاقة</option>
                <option value="wallet">محفظة إلكترونية</option>
              </select>
            </div>
            <div>
              <Label>المرجع / رقم العملية</Label>
              <Input value={payForm.reference} onChange={e => setPayForm({...payForm, reference: e.target.value})} />
            </div>
            <div>
              <Label>ملاحظات</Label>
              <Input value={payForm.notes} onChange={e => setPayForm({...payForm, notes: e.target.value})} />
            </div>
          </div>
        </FormPanel>
      )}
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: "indigo" | "emerald" | "amber" }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-bold mt-1",
        tone === "indigo" && "text-indigo-700",
        tone === "emerald" && "text-emerald-700",
        tone === "amber" && "text-amber-700")}>{value} <span className="text-xs text-muted-foreground">ر.س</span></div>
    </div>
  );
}
