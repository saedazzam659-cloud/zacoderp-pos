import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  Plus, Pencil, Trash2, Play, Repeat, AlertCircle, CheckCircle2,
  CalendarClock, Sparkles, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Adjustment = {
  id: number;
  companyId: number;
  type: "prepaid" | "accrued";
  name: string;
  expenseAccountId: number;
  contraAccountId: number;
  totalAmount: string;
  startDate: string;
  endDate: string;
  monthlyAmount: string;
  autoGenerate: boolean;
  status: "active" | "completed" | "cancelled";
  lastGeneratedDate: string | null;
  notes: string | null;
  createdAt: string;
};

const TYPE_LABELS: Record<Adjustment["type"], string> = {
  prepaid: "مصروف مدفوع مقدمًا",
  accrued: "مصروف مستحق",
};

const STATUS_BADGE: Record<Adjustment["status"], { label: string; cls: string }> = {
  active:    { label: "نشط",   cls: "bg-green-50 text-green-700 border-green-200" },
  completed: { label: "مكتمل", cls: "bg-slate-50 text-slate-700 border-slate-200" },
  cancelled: { label: "ملغى",  cls: "bg-red-50 text-red-700 border-red-200" },
};

const today = () => new Date().toISOString().slice(0, 10);
const plusYear = () => {
  const d = new Date(); d.setFullYear(d.getFullYear() + 1); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const EMPTY_FORM = {
  type: "prepaid" as Adjustment["type"],
  name: "",
  expenseAccountId: "",
  contraAccountId: "",
  totalAmount: "",
  startDate: today(),
  endDate: plusYear(),
  autoGenerate: true,
  notes: "",
};

export default function Adjustments() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Adjustment | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);

  const { data: adjustments = [], isLoading } = useQuery<Adjustment[]>({
    queryKey: ["adjustments", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/adjustments?companyId=${cid}` : `${API}/api/adjustments`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : [];
    },
  });

  const safeJson = async (r: Response, fallback: string) => {
    const ct = r.headers.get("content-type") || "";
    const d = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
    if (!r.ok) throw new Error((d as any)?.error || fallback);
    return d;
  };

  const monthlyPreview = useMemo(() => {
    const total = parseFloat(form.totalAmount || "0");
    if (!form.startDate || !form.endDate || !total) return null;
    const [sy, sm] = form.startDate.split("-").map(Number);
    const [ey, em] = form.endDate.split("-").map(Number);
    const months = (ey - sy) * 12 + (em - sm) + 1;
    if (months <= 0) return null;
    return { months, monthly: total / months };
  }, [form.totalAmount, form.startDate, form.endDate]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (a: Adjustment) => {
    setEditing(a);
    setForm({
      type: a.type,
      name: a.name,
      expenseAccountId: String(a.expenseAccountId),
      contraAccountId:  String(a.contraAccountId),
      totalAmount:      a.totalAmount,
      startDate:        a.startDate,
      endDate:          a.endDate,
      autoGenerate:     a.autoGenerate,
      notes:            a.notes ?? "",
    });
    setShowForm(true);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        ...form,
        companyId: cid,
        expenseAccountId: Number(form.expenseAccountId),
        contraAccountId:  Number(form.contraAccountId),
      };
      const url = editing ? `${API}/api/adjustments/${editing.id}` : `${API}/api/adjustments`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST", headers, body: JSON.stringify(body) });
      return safeJson(r, "تعذر حفظ التسوية");
    },
    onSuccess: () => {
      toast({ title: editing ? "تم تحديث التسوية" : "تم إنشاء التسوية" });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/adjustments/${id}`, { method: "DELETE", headers });
      return safeJson(r, "تعذر الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم حذف التسوية" });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const generateMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/adjustments/${id}/generate`, { method: "POST", headers });
      return safeJson(r, "تعذر توليد القيود");
    },
    onSuccess: (d: any) => {
      const created = d?.created?.length ?? 0;
      const skipped = d?.skipped?.length ?? 0;
      toast({
        title: "تم توليد القيود",
        description: `أُنشئ ${created} قيد${skipped > 0 ? ` — ${skipped} شهر متخطّى` : ""}`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const runDueMut = useMutation({
    mutationFn: async () => {
      const url = cid ? `${API}/api/adjustments/run-due?companyId=${cid}` : `${API}/api/adjustments/run-due`;
      const r = await fetch(url, { method: "POST", headers });
      return safeJson(r, "تعذر تشغيل التسويات المستحقة");
    },
    onSuccess: (d: any) => {
      const total = d?.total ?? 0;
      const processed = Array.isArray(d?.summary) ? d.summary.length : 0;
      toast({
        title: "تم تشغيل التسويات",
        description: `${total} قيد جديد عبر ${processed} تسوية`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const formValid = form.name.trim() && form.expenseAccountId && form.contraAccountId
    && parseFloat(form.totalAmount) > 0
    && form.expenseAccountId !== form.contraAccountId;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-500 text-white shadow-md">
            <CalendarClock className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">تسويات شهرية</h1>
            <p className="text-sm text-muted-foreground">المصاريف المدفوعة مقدماً والمستحقة بقيود توليد آلي</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="lg" variant="outline"
            onClick={() => runDueMut.mutate()}
            disabled={runDueMut.isPending || adjustments.length === 0}
            className="gap-2"
          >
            <Repeat className="h-4 w-4" />
            تشغيل التسويات المستحقة
          </Button>
          <Button
            size="lg"
            onClick={openCreate}
            className="gap-2 bg-gradient-to-l from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 shadow-md"
          >
            <Plus className="h-5 w-5" />
            تسوية جديدة
          </Button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={Sparkles}
          title={editing ? "تعديل التسوية" : "تسوية جديدة"}
          subtitle="ستُولّد قيود الاستهلاك تلقائياً كل شهر بقيمة موزّعة بالتساوي"
          width="2xl"
          onClose={() => setShowForm(false)}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!formValid}
          saveLabel={editing ? "حفظ التغييرات" : "إنشاء"}
        >
          <FormGrid>
            <Field label="نوع التسوية" required>
              <select
                value={form.type}
                onChange={(e) => setForm(p => ({ ...p, type: e.target.value as Adjustment["type"] }))}
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="prepaid">مصروف مدفوع مقدمًا (إيجار، تأمين…)</option>
                <option value="accrued">مصروف مستحق (رواتب، فوائد…)</option>
              </select>
            </Field>
            <Field label="المسمى" required>
              <Input
                placeholder="مثال: إيجار المعرض - السنة 2026"
                value={form.name}
                onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field label={form.type === "prepaid" ? "حساب المصروف (مدين)" : "حساب المصروف (مدين)"} required>
              <AccountCombobox
                value={form.expenseAccountId}
                onValueChange={(v) => setForm(p => ({ ...p, expenseAccountId: v }))}
                filterTypes={["expense"]}
                allowEmpty={false}
                placeholder="— اختر حساب المصروف —"
              />
            </Field>
            <Field
              label={form.type === "prepaid" ? "حساب المصروف المدفوع مقدمًا (دائن)" : "حساب المستحقات الدائنة (دائن)"}
              required
            >
              <AccountCombobox
                value={form.contraAccountId}
                onValueChange={(v) => setForm(p => ({ ...p, contraAccountId: v }))}
                filterTypes={form.type === "prepaid" ? ["asset"] : ["liability"]}
                allowEmpty={false}
                placeholder={form.type === "prepaid" ? "— حساب أصل (مدفوع مقدمًا) —" : "— حساب التزام (مستحق) —"}
              />
            </Field>
            <Field label="المبلغ الإجمالي" required>
              <Input
                type="number" inputMode="decimal" step="0.01" min="0"
                value={form.totalAmount}
                onChange={(e) => setForm(p => ({ ...p, totalAmount: e.target.value }))}
                placeholder="0.00"
              />
            </Field>
            <Field label="القسط الشهري المحسوب">
              <div className="h-10 rounded-md border bg-muted/30 px-3 flex items-center text-sm font-mono">
                {monthlyPreview ? `${monthlyPreview.monthly.toFixed(2)} × ${monthlyPreview.months} شهر` : "—"}
              </div>
            </Field>
            <Field label="تاريخ البداية" required>
              <Input type="date" value={form.startDate} onChange={(e) => setForm(p => ({ ...p, startDate: e.target.value }))} />
            </Field>
            <Field label="تاريخ النهاية" required>
              <Input type="date" value={form.endDate} onChange={(e) => setForm(p => ({ ...p, endDate: e.target.value }))} />
            </Field>
            <Field label="ملاحظات" className="md:col-span-2">
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="اختياري"
              />
            </Field>
            <Field label="" className="md:col-span-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoGenerate}
                  onChange={(e) => setForm(p => ({ ...p, autoGenerate: e.target.checked }))}
                  className="h-4 w-4"
                />
                توليد القيود تلقائياً ضمن «تشغيل التسويات المستحقة»
              </label>
            </Field>
          </FormGrid>

          {form.expenseAccountId && form.expenseAccountId === form.contraAccountId && (
            <div className="rounded-md p-3 mt-3 flex gap-2 text-xs text-red-800 bg-red-50 border border-red-200">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p>حساب المصروف وحساب المقابل لا يمكن أن يكونا الحساب ذاته</p>
            </div>
          )}
        </FormPanel>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : adjustments.length === 0 ? (
        <Card className="p-12 text-center">
          <CalendarClock className="h-16 w-16 mx-auto mb-3 opacity-10" />
          <p className="text-sm font-semibold mb-1">لا توجد تسويات</p>
          <p className="text-xs text-muted-foreground mb-3">أنشئ تسوية لتوزيع مصاريف على عدة أشهر تلقائياً</p>
          <Button size="sm" variant="outline" onClick={openCreate}>
            <Plus className="h-4 w-4 ml-1" />
            تسوية جديدة
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3">
          {adjustments.map(a => {
            const sb = STATUS_BADGE[a.status];
            return (
              <Card key={a.id} className="hover:shadow-md transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-semibold text-base">{a.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {TYPE_LABELS[a.type]}
                        </Badge>
                        <Badge variant="outline" className={cn("text-[10px]", sb.cls)}>
                          {sb.label}
                        </Badge>
                        {a.autoGenerate && (
                          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                            <Repeat className="h-2.5 w-2.5 ml-0.5" />
                            توليد تلقائي
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                        <span>الإجمالي: <strong className="text-foreground">{parseFloat(a.totalAmount).toFixed(2)}</strong></span>
                        <span>الشهري: <strong className="text-foreground">{parseFloat(a.monthlyAmount).toFixed(2)}</strong></span>
                        <span dir="ltr">{a.startDate} — {a.endDate}</span>
                        {a.lastGeneratedDate && (
                          <span className="text-emerald-700">
                            <CheckCircle2 className="h-3 w-3 inline ml-0.5" />
                            آخر توليد: <span dir="ltr">{a.lastGeneratedDate}</span>
                          </span>
                        )}
                      </div>
                      {a.notes && (
                        <div className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                          <FileText className="h-3 w-3 mt-0.5 flex-shrink-0" />
                          <span>{a.notes}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        size="sm" variant="outline"
                        onClick={() => generateMut.mutate(a.id)}
                        disabled={generateMut.isPending || a.status !== "active"}
                        className="h-8 gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                      >
                        <Play className="h-3 w-3" />
                        توليد
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => openEdit(a)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {confirmDelId === a.id ? (
                        <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-1">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelId(null)} className="h-6 px-2 text-[10px]">إلغاء</Button>
                          <Button size="sm" variant="destructive" onClick={() => delMut.mutate(a.id)} className="h-6 px-2 text-[10px]">تأكيد</Button>
                        </div>
                      ) : (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => setConfirmDelId(a.id)}
                          className="h-8 w-8 p-0 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
