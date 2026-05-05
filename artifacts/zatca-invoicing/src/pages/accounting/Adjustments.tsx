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
  CalendarClock, Sparkles, FileText, ArrowRightCircle, Link2,
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
  carryForwardEnabled: boolean;
  parentAdjustmentId: number | null;
  status: "active" | "completed" | "cancelled" | "carried_forward";
  lastGeneratedDate: string | null;
  notes: string | null;
  createdAt: string;
  // computed by server
  recognizedAmount: string;
  remainingAmount:  string;
  runCount: number;
};

const TYPE_LABELS: Record<Adjustment["type"], string> = {
  prepaid: "مصروف مدفوع مقدمًا",
  accrued: "مصروف مستحق",
};

const STATUS_BADGE: Record<Adjustment["status"], { label: string; cls: string }> = {
  active:          { label: "نشط",        cls: "bg-green-50 text-green-700 border-green-200" },
  completed:       { label: "مكتمل",      cls: "bg-slate-50 text-slate-700 border-slate-200" },
  cancelled:       { label: "ملغى",       cls: "bg-red-50 text-red-700 border-red-200" },
  carried_forward: { label: "مُرحَّل",     cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

// Default carry-forward window = next calendar year (Jan 1 → Dec 31)
const defaultCarryDates = (parentEndDate: string) => {
  const [y] = parentEndDate.split("-").map(Number);
  const ny = y + 1;
  return { start: `${ny}-01-01`, end: `${ny}-12-31` };
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
  carryForwardEnabled: true,
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
  const [carryFor, setCarryFor] = useState<Adjustment | null>(null);
  const [carryForm, setCarryForm] = useState({ start: "", end: "" });

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
      carryForwardEnabled: a.carryForwardEnabled,
      notes:            a.notes ?? "",
    });
    setShowForm(true);
  };

  const openCarry = (a: Adjustment) => {
    const d = defaultCarryDates(a.endDate);
    setCarryForm({ start: d.start, end: d.end });
    setCarryFor(a);
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

  const carryMut = useMutation({
    mutationFn: async () => {
      if (!carryFor) throw new Error("لا توجد تسوية محددة");
      const r = await fetch(`${API}/api/adjustments/${carryFor.id}/carry-forward`, {
        method: "POST", headers,
        body: JSON.stringify({ newStartDate: carryForm.start, newEndDate: carryForm.end }),
      });
      return safeJson(r, "تعذر ترحيل المتبقي");
    },
    onSuccess: (d: any) => {
      toast({
        title: "تم ترحيل المتبقي للسنة الجديدة",
        description: `رُحِّل ${d?.summary?.carriedForward ?? "—"} على ${d?.summary?.months ?? "—"} شهر بقسط شهري ${d?.summary?.newMonthly ?? "—"}`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setCarryFor(null);
    },
    onError: (e: any) => toast({ title: "تعذر الترحيل", description: e.message, variant: "destructive" }),
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
            <Field label="" className="md:col-span-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.carryForwardEnabled}
                  onChange={(e) => setForm(p => ({ ...p, carryForwardEnabled: e.target.checked }))}
                  className="h-4 w-4"
                />
                <span>السماح بترحيل المتبقي للسنة الجديدة عند الإقفال
                  <span className="text-muted-foreground text-xs me-1">— يضمن أن الرصيد غير المستحق لا يضيع</span>
                </span>
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
                        {a.parentAdjustmentId && (
                          <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200">
                            <Link2 className="h-2.5 w-2.5 ml-0.5" />
                            مُرحَّل من #{a.parentAdjustmentId}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                        <span>الإجمالي: <strong className="text-foreground">{parseFloat(a.totalAmount).toFixed(2)}</strong></span>
                        <span>الشهري: <strong className="text-foreground">{parseFloat(a.monthlyAmount).toFixed(2)}</strong></span>
                        <span className="text-emerald-700">
                          مُحقّق: <strong>{parseFloat(a.recognizedAmount ?? "0").toFixed(2)}</strong>
                          <span className="text-muted-foreground"> ({a.runCount ?? 0} شهر)</span>
                        </span>
                        <span className={cn(parseFloat(a.remainingAmount ?? "0") > 0.01 ? "text-amber-700 font-semibold" : "text-muted-foreground")}>
                          متبقٍ: <strong>{parseFloat(a.remainingAmount ?? a.totalAmount).toFixed(2)}</strong>
                        </span>
                        <span dir="ltr">{a.startDate} — {a.endDate}</span>
                        {a.lastGeneratedDate && (
                          <span className="text-emerald-700">
                            <CheckCircle2 className="h-3 w-3 inline ml-0.5" />
                            آخر توليد: <span dir="ltr">{a.lastGeneratedDate}</span>
                          </span>
                        )}
                      </div>
                      {/* Progress bar */}
                      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-l from-emerald-500 to-teal-500 transition-all"
                          style={{
                            width: `${Math.min(100, Math.max(0,
                              (parseFloat(a.recognizedAmount ?? "0") / Math.max(0.01, parseFloat(a.totalAmount))) * 100
                            )).toFixed(1)}%`,
                          }}
                        />
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
                      {a.status === "active" && a.carryForwardEnabled && parseFloat(a.remainingAmount ?? "0") > 0.01 && (
                        <Button
                          size="sm" variant="outline"
                          onClick={() => openCarry(a)}
                          className="h-8 gap-1 text-purple-700 border-purple-300 hover:bg-purple-50"
                          title="ترحيل المتبقي للسنة الجديدة"
                        >
                          <ArrowRightCircle className="h-3 w-3" />
                          ترحيل المتبقي
                        </Button>
                      )}
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

      {/* Carry-forward dialog */}
      {carryFor && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="bg-gradient-to-l from-purple-600 to-fuchsia-600 text-white p-4 rounded-t-2xl flex items-center gap-3">
              <div className="p-2 rounded-lg bg-white/15"><ArrowRightCircle className="h-5 w-5" /></div>
              <div className="flex-1">
                <h2 className="text-lg font-bold">ترحيل المتبقي للسنة الجديدة</h2>
                <p className="text-xs opacity-90">{carryFor.name}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setCarryFor(null)} className="text-white hover:bg-white/20 h-8 w-8 p-0">×</Button>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-lg p-3 bg-purple-50 border border-purple-200 text-sm space-y-1.5">
                <div className="flex justify-between"><span>الإجمالي الأصلي:</span><strong>{parseFloat(carryFor.totalAmount).toFixed(2)}</strong></div>
                <div className="flex justify-between text-emerald-700"><span>المُحقّق حتى الآن:</span><strong>{parseFloat(carryFor.recognizedAmount ?? "0").toFixed(2)}</strong></div>
                <div className="flex justify-between text-purple-800 text-base pt-1 border-t border-purple-200">
                  <span>سيُرحَّل:</span><strong>{parseFloat(carryFor.remainingAmount ?? "0").toFixed(2)}</strong>
                </div>
                <p className="text-[11px] text-muted-foreground pt-1">
                  ستُنشأ تسوية فرعية جديدة بنفس الحسابات تستحق المتبقي على الأشهر التي تختارها. التسوية الأصلية ستُختم بحالة «مُرحَّل».
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">تاريخ بداية الترحيل</Label>
                  <Input type="date" value={carryForm.start} onChange={e => setCarryForm(p => ({ ...p, start: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs">تاريخ نهاية الترحيل</Label>
                  <Input type="date" value={carryForm.end} onChange={e => setCarryForm(p => ({ ...p, end: e.target.value }))} />
                </div>
              </div>
              {carryForm.start && carryForm.start <= carryFor.endDate && (
                <div className="rounded-md p-2 text-xs bg-amber-50 border border-amber-200 text-amber-900 flex gap-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  تاريخ البداية يجب أن يكون بعد <span dir="ltr" className="mx-1">{carryFor.endDate}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setCarryFor(null)}>إلغاء</Button>
                <Button
                  onClick={() => carryMut.mutate()}
                  disabled={carryMut.isPending || !carryForm.start || !carryForm.end || carryForm.start <= carryFor.endDate || carryForm.end < carryForm.start}
                  className="bg-gradient-to-l from-purple-600 to-fuchsia-600 hover:from-purple-700 hover:to-fuchsia-700"
                >
                  {carryMut.isPending ? "جاري…" : "تأكيد الترحيل"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
