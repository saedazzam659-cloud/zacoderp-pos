import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Search, Pencil, Trash2, FileText, CreditCard,
  Sparkles, Loader2, CheckCircle2, XCircle, Eye, Calendar, Phone,
  TrendingUp, ShieldCheck, ShieldAlert, ShieldX, Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Contract = {
  id: number;
  contractNumber: string;
  customerName: string;
  nationalId: string | null;
  phone: string | null;
  productDescription: string;
  cashPrice: string;
  downPayment: string;
  financedAmount: string;
  installmentCount: number;
  installmentAmount: string;
  totalAmount: string;
  totalInterest: string;
  interestRate: string;
  firstInstallmentDate: string;
  creditScore: number | null;
  riskLevel: "low" | "medium" | "high";
  defaultProbability: string | null;
  aiAnalysis: string | null;
  status: "draft" | "pending" | "approved" | "rejected" | "active" | "completed" | "defaulted" | "cancelled";
  monthlyIncome: string;
  monthlyObligations: string;
  occupation: string | null;
  age: number | null;
  address: string | null;
  notes: string | null;
};

const EMPTY_FORM = {
  customerName: "",
  nationalId: "",
  phone: "",
  address: "",
  occupation: "",
  age: "",
  monthlyIncome: "0",
  monthlyObligations: "0",
  productDescription: "",
  cashPrice: "0",
  downPayment: "0",
  interestRate: "12",
  installmentCount: "12",
  firstInstallmentDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  notes: "",
};

const STATUS_LABEL: Record<Contract["status"], string> = {
  draft: "مسودة", pending: "بانتظار الموافقة", approved: "معتمد",
  rejected: "مرفوض", active: "نشط", completed: "مكتمل",
  defaulted: "متعثر", cancelled: "ملغي",
};
const STATUS_TONE: Record<Contract["status"], string> = {
  draft: "bg-slate-100 text-slate-700",
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-blue-100 text-blue-800",
  rejected: "bg-rose-100 text-rose-800",
  active: "bg-emerald-100 text-emerald-800",
  completed: "bg-teal-100 text-teal-800",
  defaulted: "bg-rose-200 text-rose-900",
  cancelled: "bg-slate-200 text-slate-600",
};

function fmt(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function InstallmentContracts() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Contract | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteRow, setDeleteRow] = useState<Contract | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreResult, setScoreResult] = useState<null | {
    score: number; defaultProbability: number; risk: "low"|"medium"|"high";
    reasons: string[]; decision: "approve"|"review"|"reject";
    thresholds: { approve: number; review: number };
  }>(null);
  const [preview, setPreview] = useState<null | {
    financedAmount: number; totalAmount: number; totalInterest: number;
    installmentAmount: number;
    schedule: { dueDate: string; amount: number }[];
  }>(null);

  const { data: contracts = [], isLoading } = useQuery<Contract[]>({
    queryKey: ["installment-contracts", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/contracts?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل العقود");
      return r.json();
    },
    enabled: !!user,
  });

  const filtered = useMemo(() => contracts.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      c.customerName?.includes(search) ||
      c.contractNumber?.toLowerCase().includes(q) ||
      c.nationalId?.includes(search) ||
      c.phone?.includes(search) ||
      c.productDescription?.includes(search)
    );
  }), [contracts, search]);

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setScoreResult(null);
    setPreview(null);
    setShowForm(true);
  }

  function openEdit(c: Contract) {
    setEditing(c);
    setForm({
      customerName: c.customerName ?? "",
      nationalId: c.nationalId ?? "",
      phone: c.phone ?? "",
      address: c.address ?? "",
      occupation: c.occupation ?? "",
      age: c.age != null ? String(c.age) : "",
      monthlyIncome: String(c.monthlyIncome ?? "0"),
      monthlyObligations: String(c.monthlyObligations ?? "0"),
      productDescription: c.productDescription ?? "",
      cashPrice: String(c.cashPrice ?? "0"),
      downPayment: String(c.downPayment ?? "0"),
      interestRate: String(c.interestRate ?? "0"),
      installmentCount: String(c.installmentCount ?? 1),
      firstInstallmentDate: c.firstInstallmentDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      notes: c.notes ?? "",
    });
    setScoreResult(c.creditScore ? {
      score: c.creditScore,
      defaultProbability: Number(c.defaultProbability ?? 0),
      risk: c.riskLevel,
      reasons: (c.aiAnalysis ?? "").split(" • ").filter(Boolean),
      decision: c.creditScore >= 80 ? "approve" : c.creditScore >= 60 ? "review" : "reject",
      thresholds: { approve: 80, review: 60 },
    } : null);
    setPreview(null);
    setShowForm(true);
  }

  // Auto-refresh schedule preview when key terms change.
  useEffect(() => {
    if (!showForm) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/installments/schedule-preview?companyId=${cid}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            cashPrice: Number(form.cashPrice) || 0,
            downPayment: Number(form.downPayment) || 0,
            interestRate: Number(form.interestRate) || 0,
            installmentCount: Number(form.installmentCount) || 1,
            firstInstallmentDate: form.firstInstallmentDate,
          }),
        });
        if (r.ok) setPreview(await r.json());
      } catch {/* silent */}
    }, 250);
    return () => clearTimeout(t);
  }, [showForm, form.cashPrice, form.downPayment, form.interestRate, form.installmentCount, form.firstInstallmentDate]);

  async function runAiScore() {
    setScoring(true);
    try {
      const r = await fetch(`${API}/api/installments/score?companyId=${cid}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyIncome: Number(form.monthlyIncome) || 0,
          monthlyObligations: Number(form.monthlyObligations) || 0,
          installmentAmount: preview?.installmentAmount ?? 0,
          age: form.age ? Number(form.age) : null,
          occupation: form.occupation,
          installmentCount: Number(form.installmentCount) || 1,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "فشل التقييم");
      setScoreResult(j);
    } catch (e: any) {
      toast({ title: "تعذّر التقييم", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setScoring(false);
    }
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.customerName.trim()) throw new Error("اسم العميل مطلوب");
      if (!form.productDescription.trim()) throw new Error("وصف المنتج مطلوب");
      const body: any = {
        companyId: cid,
        customerName: form.customerName.trim(),
        nationalId: form.nationalId.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        occupation: form.occupation.trim() || null,
        age: form.age ? Number(form.age) : null,
        monthlyIncome: Number(form.monthlyIncome) || 0,
        monthlyObligations: Number(form.monthlyObligations) || 0,
        productDescription: form.productDescription.trim(),
        cashPrice: Number(form.cashPrice) || 0,
        downPayment: Number(form.downPayment) || 0,
        interestRate: Number(form.interestRate) || 0,
        installmentCount: Number(form.installmentCount) || 1,
        firstInstallmentDate: form.firstInstallmentDate,
        notes: form.notes.trim() || null,
      };
      const url = editing
        ? `${API}/api/installments/contracts/${editing.id}`
        : `${API}/api/installments/contracts`;
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-contracts", cid] });
      toast({ title: editing ? "تم التحديث" : "تم إنشاء العقد" });
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      setScoreResult(null);
      setPreview(null);
    },
    onError: (e: any) => {
      toast({ title: "خطأ", description: e?.message || "فشل الحفظ", variant: "destructive" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!deleteRow) return;
      const r = await fetch(`${API}/api/installments/contracts/${deleteRow.id}?companyId=${cid}`, {
        method: "DELETE", headers,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحذف");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-contracts", cid] });
      toast({ title: "تم الحذف" });
      setDeleteRow(null);
    },
    onError: (e: any) => {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
      setDeleteRow(null);
    },
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/installments/contracts/${id}/approve?companyId=${cid}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الاعتماد");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-contracts", cid] });
      toast({ title: "تم اعتماد العقد وتفعيله" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const r = await fetch(`${API}/api/installments/contracts/${id}/reject?companyId=${cid}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) throw new Error("تعذّر الرفض");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-contracts", cid] });
      toast({ title: "تم رفض العقد" });
    },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-indigo-600" />
            عقود البيع بالتقسيط
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة عقود التقسيط مع التقييم الذكي للعملاء — {contracts.length} عقد
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-contract">
          <Plus className="h-4 w-4 ms-2" />
          عقد جديد
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="بحث بالعميل، رقم العقد، الهوية، الهاتف…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pe-9"
            data-testid="input-search"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filtered.length} / {contracts.length}
        </span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل العقد: ${editing.contractNumber}` : "عقد تقسيط جديد"}
          subtitle={editing ? `العميل: ${editing.customerName}` : "املأ بيانات العميل والشروط — رقم العقد يُولَّد تلقائياً"}
          width="5xl"
          onClose={() => { setShowForm(false); setEditing(null); setScoreResult(null); setPreview(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel={editing ? "حفظ التعديلات" : "حفظ العقد"}
          cancelLabel="إلغاء"
        >
          <div className="space-y-6">
            <section className="rounded-lg border bg-slate-50/50 p-4">
              <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4" /> بيانات العميل
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label>اسم العميل *</Label>
                  <Input value={form.customerName} onChange={e => setForm({...form, customerName: e.target.value})} data-testid="input-customer-name" />
                </div>
                <div>
                  <Label>رقم الهوية</Label>
                  <Input value={form.nationalId} onChange={e => setForm({...form, nationalId: e.target.value})} placeholder="1xxxxxxxxx" data-testid="input-national-id" />
                </div>
                <div>
                  <Label>الهاتف</Label>
                  <Input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="05xxxxxxxx" data-testid="input-phone" />
                </div>
                <div>
                  <Label>العمر</Label>
                  <Input type="number" min="18" max="100" value={form.age} onChange={e => setForm({...form, age: e.target.value})} data-testid="input-age" />
                </div>
                <div>
                  <Label>المهنة</Label>
                  <Input value={form.occupation} onChange={e => setForm({...form, occupation: e.target.value})} placeholder="موظف حكومي / خاص / حر…" data-testid="input-occupation" />
                </div>
                <div>
                  <Label>العنوان</Label>
                  <Input value={form.address} onChange={e => setForm({...form, address: e.target.value})} data-testid="input-address" />
                </div>
                <div>
                  <Label>الدخل الشهري (ر.س)</Label>
                  <Input type="number" step="0.01" min="0" value={form.monthlyIncome} onChange={e => setForm({...form, monthlyIncome: e.target.value})} data-testid="input-monthly-income" />
                </div>
                <div>
                  <Label>الالتزامات الشهرية الأخرى (ر.س)</Label>
                  <Input type="number" step="0.01" min="0" value={form.monthlyObligations} onChange={e => setForm({...form, monthlyObligations: e.target.value})} data-testid="input-monthly-obligations" />
                </div>
              </div>
            </section>

            <section className="rounded-lg border bg-slate-50/50 p-4">
              <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
                <CreditCard className="h-4 w-4" /> شروط البيع والتقسيط
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-3">
                  <Label>وصف المنتج / الخدمة *</Label>
                  <Input value={form.productDescription} onChange={e => setForm({...form, productDescription: e.target.value})} placeholder="جوال آيفون 15 برو 256 جيجا" data-testid="input-product" />
                </div>
                <div>
                  <Label>السعر النقدي (ر.س)</Label>
                  <Input type="number" step="0.01" min="0" value={form.cashPrice} onChange={e => setForm({...form, cashPrice: e.target.value})} data-testid="input-cash-price" />
                </div>
                <div>
                  <Label>الدفعة الأولى (ر.س)</Label>
                  <Input type="number" step="0.01" min="0" value={form.downPayment} onChange={e => setForm({...form, downPayment: e.target.value})} data-testid="input-down-payment" />
                </div>
                <div>
                  <Label>نسبة الفائدة السنوية %</Label>
                  <Input type="number" step="0.01" min="0" max="100" value={form.interestRate} onChange={e => setForm({...form, interestRate: e.target.value})} data-testid="input-interest" />
                </div>
                <div>
                  <Label>عدد الأقساط (شهري)</Label>
                  <Input type="number" min="1" max="84" value={form.installmentCount} onChange={e => setForm({...form, installmentCount: e.target.value})} data-testid="input-count" />
                </div>
                <div>
                  <Label>تاريخ أول قسط</Label>
                  <Input type="date" value={form.firstInstallmentDate} onChange={e => setForm({...form, firstInstallmentDate: e.target.value})} data-testid="input-first-date" />
                </div>
                <div>
                  <Label>ملاحظات</Label>
                  <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} data-testid="input-notes" />
                </div>
              </div>

              {preview && (
                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                  <div className="rounded bg-white border p-3">
                    <div className="text-xs text-muted-foreground">المبلغ المموَّل</div>
                    <div className="font-bold text-base mt-1">{fmt(preview.financedAmount)}</div>
                  </div>
                  <div className="rounded bg-white border p-3">
                    <div className="text-xs text-muted-foreground">قيمة القسط الشهري</div>
                    <div className="font-bold text-base mt-1 text-indigo-700">{fmt(preview.installmentAmount)}</div>
                  </div>
                  <div className="rounded bg-white border p-3">
                    <div className="text-xs text-muted-foreground">إجمالي الفائدة</div>
                    <div className="font-bold text-base mt-1 text-amber-700">{fmt(preview.totalInterest)}</div>
                  </div>
                  <div className="rounded bg-white border p-3">
                    <div className="text-xs text-muted-foreground">الإجمالي بعد التقسيط</div>
                    <div className="font-bold text-base mt-1 text-emerald-700">{fmt(preview.totalAmount)}</div>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-lg border bg-gradient-to-br from-indigo-50 to-blue-50 p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h3 className="text-sm font-bold text-indigo-900 flex items-center gap-2">
                  <Sparkles className="h-4 w-4" /> التقييم الذكي للملاءة الائتمانية
                </h3>
                <Button type="button" size="sm" variant="default" onClick={runAiScore} disabled={scoring} data-testid="btn-ai-score">
                  {scoring ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <Sparkles className="h-4 w-4 ms-2" />}
                  احسب درجة الائتمان
                </Button>
              </div>
              {scoreResult ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded bg-white border p-3 text-center">
                    <div className="text-xs text-muted-foreground">درجة الائتمان</div>
                    <div className={cn("text-3xl font-extrabold mt-1",
                      scoreResult.score >= scoreResult.thresholds.approve ? "text-emerald-600" :
                      scoreResult.score >= scoreResult.thresholds.review ? "text-amber-600" : "text-rose-600")}>
                      {scoreResult.score}<span className="text-sm text-muted-foreground">/100</span>
                    </div>
                  </div>
                  <div className="rounded bg-white border p-3 text-center">
                    <div className="text-xs text-muted-foreground">احتمال التعثر</div>
                    <div className="text-2xl font-bold mt-1 text-rose-600">{scoreResult.defaultProbability}%</div>
                    <div className={cn("text-xs mt-1 inline-block px-2 py-0.5 rounded-full",
                      scoreResult.risk === "low" ? "bg-emerald-100 text-emerald-800" :
                      scoreResult.risk === "medium" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800")}>
                      مستوى المخاطر: {scoreResult.risk === "low" ? "منخفض" : scoreResult.risk === "medium" ? "متوسط" : "عالي"}
                    </div>
                  </div>
                  <div className="rounded bg-white border p-3 text-center flex flex-col items-center justify-center">
                    <div className="text-xs text-muted-foreground">القرار المقترح</div>
                    {scoreResult.decision === "approve" && (
                      <div className="text-emerald-700 font-bold mt-1 flex items-center gap-1">
                        <ShieldCheck className="h-5 w-5" /> اعتماد تلقائي
                      </div>
                    )}
                    {scoreResult.decision === "review" && (
                      <div className="text-amber-700 font-bold mt-1 flex items-center gap-1">
                        <ShieldAlert className="h-5 w-5" /> مراجعة يدوية
                      </div>
                    )}
                    {scoreResult.decision === "reject" && (
                      <div className="text-rose-700 font-bold mt-1 flex items-center gap-1">
                        <ShieldX className="h-5 w-5" /> رفض مقترح
                      </div>
                    )}
                  </div>
                  {scoreResult.reasons.length > 0 && (
                    <div className="md:col-span-3 rounded bg-white border p-3">
                      <div className="text-xs text-muted-foreground mb-2">العوامل المؤثرة:</div>
                      <ul className="text-sm space-y-1">
                        {scoreResult.reasons.map((r, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-indigo-600">•</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  اضغط الزر أعلاه بعد إدخال بيانات الدخل والشروط لاحتساب درجة العميل.
                </p>
              )}
            </section>

            {preview && preview.schedule.length > 0 && (
              <section className="rounded-lg border p-4">
                <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
                  <Calendar className="h-4 w-4" /> جدول الأقساط (معاينة)
                </h3>
                <div className="overflow-auto max-h-64 border rounded">
                  <table className="w-full text-xs" dir="rtl">
                    <thead className="bg-slate-100 sticky top-0">
                      <tr><th className="p-2 text-start">القسط #</th><th className="p-2 text-start">تاريخ الاستحقاق</th><th className="p-2 text-end">المبلغ (ر.س)</th></tr>
                    </thead>
                    <tbody>
                      {preview.schedule.map((s, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">{i + 1}</td>
                          <td className="p-2">{s.dueDate}</td>
                          <td className="p-2 text-end font-medium">{fmt(s.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </FormPanel>
      )}

      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
              <tr>
                <th className="p-2 text-start">رقم العقد</th>
                <th className="p-2 text-start">العميل</th>
                <th className="p-2 text-start">المنتج</th>
                <th className="p-2 text-end">المموَّل</th>
                <th className="p-2 text-end">القسط</th>
                <th className="p-2 text-center">عدد</th>
                <th className="p-2 text-center">الدرجة</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={9} className="p-8"><Skeleton className="h-12" /></td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">لا توجد عقود — أنشئ أول عقد بزر "عقد جديد"</td></tr>
              )}
              {filtered.map((c) => (
                <tr key={c.id} className="border-t hover:bg-slate-50">
                  <td className="p-2 font-mono font-medium">{c.contractNumber}</td>
                  <td className="p-2">
                    <div className="font-medium">{c.customerName}</div>
                    {c.phone && <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</div>}
                  </td>
                  <td className="p-2 max-w-[16rem] truncate" title={c.productDescription}>{c.productDescription}</td>
                  <td className="p-2 text-end">{fmt(c.financedAmount)}</td>
                  <td className="p-2 text-end font-medium text-indigo-700">{fmt(c.installmentAmount)}</td>
                  <td className="p-2 text-center">{c.installmentCount}</td>
                  <td className="p-2 text-center">
                    <span className={cn("inline-block min-w-[2.5rem] py-0.5 rounded font-bold",
                      (c.creditScore ?? 0) >= 75 ? "bg-emerald-100 text-emerald-800" :
                      (c.creditScore ?? 0) >= 55 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800")}>
                      {c.creditScore ?? "—"}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <span className={cn("inline-block px-2 py-0.5 rounded-full text-[10px] font-medium", STATUS_TONE[c.status])}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center justify-center gap-1">
                      <Link href={`/installments/contracts/${c.id}`}>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="عرض الجدول">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </Link>
                      {(c.status === "draft" || c.status === "pending") && (
                        <>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700"
                            onClick={() => approveMut.mutate(c.id)} title="اعتماد">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-700"
                            onClick={() => {
                              const reason = window.prompt("سبب الرفض:") ?? "";
                              if (reason) rejectMut.mutate({ id: c.id, reason });
                            }} title="رفض">
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(c)} title="تعديل">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-700"
                            onClick={() => setDeleteRow(c)} title="حذف">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد حذف العقد</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف العقد <b>{deleteRow?.contractNumber}</b> نهائياً؟ لا يمكن التراجع.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMut.mutate()} className="bg-rose-600 hover:bg-rose-700">
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
