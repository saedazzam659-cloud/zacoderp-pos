import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Calculator, Sparkles, Loader2, ScrollText, Printer, Banknote, CheckCircle2 } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";

export default function EndOfService() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [empId, setEmpId] = useState<number | "">("");
  const [reason, setReason] = useState<"resignation" | "termination">("resignation");
  const [calc, setCalc] = useState<any | null>(null);
  const [explain, setExplain] = useState<string>("");
  const [showPay, setShowPay] = useState(false);
  const [payForm, setPayForm] = useState<any>({
    amount: 0, payDate: new Date().toISOString().slice(0, 10), payMethod: "cash" as "cash" | "bank",
    accountId: "" as number | "", useProvision: false, endEmployment: true, description: "",
  });

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: hrSettings } = useQuery<any>({ queryKey: ["hr-settings"], queryFn: () => employeesApi.hrSettings() });
  const selectedEmp = employees.find((e: any) => e.id === Number(empId));

  const payMut = useMutation({
    mutationFn: () => {
      const payload: any = {
        amount: Number(payForm.amount),
        payDate: payForm.payDate,
        useProvision: payForm.useProvision,
        endEmployment: payForm.endEmployment,
        description: payForm.description || undefined,
        cashBoxId: payForm.payMethod === "cash" && payForm.accountId ? Number(payForm.accountId) : null,
        bankAccountId: payForm.payMethod === "bank" && payForm.accountId ? Number(payForm.accountId) : null,
      };
      return employeesApi.payEos(Number(empId), payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      setShowPay(false);
      toast({ title: "تم صرف المكافأة وإنشاء القيد المحاسبي", description: payForm.endEmployment ? "تم تحديث حالة الموظف إلى منتهي الخدمة." : "" });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function openPayDialog() {
    if (!calc) return;
    const m = hrSettings?.mapping || {};
    let pm: "cash" | "bank" = "cash"; let acc: number | "" = "";
    if (m.defaultPayCashBoxId) { pm = "cash"; acc = m.defaultPayCashBoxId; }
    else if (m.defaultPayBankAccountId) { pm = "bank"; acc = m.defaultPayBankAccountId; }
    setPayForm({
      amount: Number(calc.netAmount.toFixed(2)),
      payDate: new Date().toISOString().slice(0, 10),
      payMethod: pm, accountId: acc, useProvision: false, endEmployment: true,
      description: `صرف مكافأة نهاية الخدمة — ${selectedEmp?.nameAr || ""} (${selectedEmp?.code || ""})`,
    });
    setShowPay(true);
  }

  const calcMut = useMutation({
    mutationFn: () => employeesApi.endOfService(Number(empId), reason),
    onSuccess: (data) => {
      setCalc(data); setExplain("");
      toast({ title: "تم احتساب المكافأة" });
    },
    onError: (e) => {
      setCalc(null);
      toast({ variant: "destructive", title: "تعذّر الاحتساب", description: parseError(e) });
    },
  });

  const explainMut = useMutation({
    mutationFn: () => employeesApi.aiExplainEos(calc, selectedEmp),
    onSuccess: (data) => { setExplain(data.explanation); toast({ title: "تم توليد الشرح" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function printReport() { window.print(); }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-eos">
      <div className="flex items-center gap-2">
        <Calculator className="size-6 text-primary" />
        <h1 className="text-xl font-semibold">حاسبة مكافأة نهاية الخدمة</h1>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">الموظف</label>
            <SearchCombobox
              items={employees.map((e: any) => ({
                value: String(e.id), code: e.code, label: e.nameAr,
                description: e.hireDate ? `تاريخ التعيين: ${e.hireDate}` : "⚠ لا يوجد تاريخ تعيين",
              }))}
              value={empId ? String(empId) : ""}
              onValueChange={(v) => { setEmpId(v ? Number(v) : ""); setCalc(null); setExplain(""); }}
              placeholder="— اختر موظفاً —"
              searchPlaceholder="ابحث بالاسم أو الكود…"
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">سبب إنهاء الخدمة</label>
            <SearchCombobox
              items={[
                { value: "resignation", label: "استقالة الموظف", description: "تطبيق المادة 85 — نسبة جزئية" },
                { value: "termination", label: "إنهاء من صاحب العمل", description: "تطبيق المادة 84 — مكافأة كاملة" },
              ]}
              value={reason}
              onValueChange={(v) => { setReason(v as any); setCalc(null); setExplain(""); }}
              placeholder="اختر السبب"
              className="w-full"
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => calcMut.mutate()} disabled={!empId || calcMut.isPending} className="w-full" data-testid="btn-calc-eos">
              {calcMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />}
              احتساب
            </Button>
          </div>
        </div>

        {selectedEmp && (
          <div className="rounded border bg-muted/30 p-3 text-sm grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><span className="text-muted-foreground">الكود:</span> <strong>{selectedEmp.code}</strong></div>
            <div><span className="text-muted-foreground">الاسم:</span> <strong>{selectedEmp.nameAr}</strong></div>
            <div><span className="text-muted-foreground">الجنسية:</span> <strong>{selectedEmp.nationality || "—"}</strong></div>
            <div><span className="text-muted-foreground">الوظيفة:</span> <strong>{selectedEmp.jobTitle || "—"}</strong></div>
            <div><span className="text-muted-foreground">تاريخ التعيين:</span> <strong>{selectedEmp.hireDate || <span className="text-rose-600">غير مسجّل</span>}</strong></div>
            <div><span className="text-muted-foreground">الراتب الأساسي:</span> <strong>{Number(selectedEmp.basicSalary || 0).toFixed(2)} ر.س</strong></div>
            <div><span className="text-muted-foreground">بدل سكن:</span> <strong>{Number(selectedEmp.housingAllow || 0).toFixed(2)}</strong></div>
            <div><span className="text-muted-foreground">بدل انتقال:</span> <strong>{Number(selectedEmp.transportAllow || 0).toFixed(2)}</strong></div>
          </div>
        )}
      </div>

      {calcMut.isPending && <Skeleton className="h-64" />}

      {calc && (
        <div className="space-y-4" id="eos-report">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="مدة الخدمة" value={`${calc.yearsOfService} سنة`} hint={`${calc.hireDate} → ${calc.endDate}`} />
            <Card label="الأجر الشامل/شهر" value={`${calc.monthlySalary.toFixed(2)}`} hint="أساسي + سكن + انتقال" />
            <Card label="المكافأة الكاملة" value={`${calc.grossEntitlement.toFixed(2)}`} hint="قبل تطبيق نسبة الاستحقاق" amber />
            <Card label="الصافي للصرف" value={`${calc.netAmount.toFixed(2)}`} hint={`نسبة الاستحقاق ${(calc.factor * 100).toFixed(0)}%`} emerald />
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="bg-muted/40 p-3 border-b font-semibold flex items-center gap-2">
              <ScrollText className="size-4" /> تفاصيل الاحتساب وفق نظام العمل السعودي
            </div>
            <div className="p-4 space-y-3">
              <Step n="1" title="مدة الخدمة">
                من <strong>{calc.hireDate}</strong> إلى <strong>{calc.endDate}</strong> = <strong>{calc.yearsOfService} سنة</strong>.
              </Step>
              <Step n="2" title="الأجر المعتمد للاحتساب (الأجر الشامل)">
                الأساسي ({calc.basicSalary.toFixed(2)}) + بدل السكن ({calc.housingAllow.toFixed(2)}) + بدل الانتقال ({calc.transportAllow.toFixed(2)}) = <strong>{calc.monthlySalary.toFixed(2)} ر.س/شهر</strong>.
              </Step>
              <Step n="3" title="تطبيق المادة (84)">
                <div className="space-y-1">
                  <div>• السنوات الخمس الأولى ({calc.breakdown.firstFiveYears} سنة) × ½ شهر = <strong className="text-amber-700">{calc.breakdown.firstFiveAmount.toFixed(2)} ر.س</strong></div>
                  {calc.breakdown.afterFiveYears > 0 && (
                    <div>• ما بعد الخمس سنوات ({calc.breakdown.afterFiveYears} سنة) × شهر كامل = <strong className="text-amber-700">{calc.breakdown.afterFiveAmount.toFixed(2)} ر.س</strong></div>
                  )}
                  <div className="pt-1 border-t mt-2">المكافأة الكاملة = <strong>{calc.grossEntitlement.toFixed(2)} ر.س</strong></div>
                </div>
              </Step>
              <Step n="4" title="نسبة الاستحقاق">
                <div className="bg-blue-50/50 border border-blue-200 rounded p-2 text-blue-900">
                  <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 me-2">المعامل: {(calc.factor * 100).toFixed(0)}%</Badge>
                  {calc.factorReason}
                </div>
              </Step>
              <Step n="5" title="الصافي المستحق">
                <div className="text-2xl font-bold text-emerald-700 tabular-nums">{calc.netAmount.toFixed(2)} ر.س</div>
                <div className="text-xs text-muted-foreground mt-1">{calc.grossEntitlement.toFixed(2)} × {(calc.factor * 100).toFixed(0)}% = {calc.netAmount.toFixed(2)}</div>
              </Step>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button onClick={openPayDialog} data-testid="btn-pay-eos">
              <Banknote className="size-4 me-1" /> صرف المكافأة (إنشاء قيد محاسبي)
            </Button>
            <Button onClick={() => explainMut.mutate()} disabled={explainMut.isPending} variant="outline" data-testid="btn-explain-eos">
              {explainMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Sparkles className="size-4 me-1" />}
              شرح بالـ AI
            </Button>
            <Button onClick={printReport} variant="outline" data-testid="btn-print-eos">
              <Printer className="size-4 me-1" /> طباعة
            </Button>
          </div>

          {explain && (
            <div className="rounded-lg border bg-blue-50/30 border-blue-200 p-4">
              <div className="flex items-center gap-2 mb-2 text-blue-900 font-semibold">
                <Sparkles className="size-4" /> شرح المستشار القانوني
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{explain}</pre>
            </div>
          )}
        </div>
      )}

      <Dialog open={showPay} onOpenChange={setShowPay}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>صرف مكافأة نهاية الخدمة</DialogTitle>
          </DialogHeader>
          {calc && selectedEmp && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-3 space-y-1">
                <div><span className="text-muted-foreground">الموظف:</span> <strong>{selectedEmp.nameAr}</strong> ({selectedEmp.code})</div>
                <div><span className="text-muted-foreground">الصافي المحتسب:</span> <strong className="text-emerald-700">{calc.netAmount.toFixed(2)} ر.س</strong></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">المبلغ المصروف *</label>
                  <Input type="number" step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} data-testid="pay-amount" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">تاريخ الصرف *</label>
                  <Input type="date" value={payForm.payDate} onChange={(e) => setPayForm({ ...payForm, payDate: e.target.value })} data-testid="pay-date" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">طريقة الصرف</label>
                <div className="flex gap-2">
                  <Button type="button" variant={payForm.payMethod === "cash" ? "default" : "outline"} size="sm"
                    onClick={() => setPayForm({ ...payForm, payMethod: "cash", accountId: "" })}>صندوق نقدي</Button>
                  <Button type="button" variant={payForm.payMethod === "bank" ? "default" : "outline"} size="sm"
                    onClick={() => setPayForm({ ...payForm, payMethod: "bank", accountId: "" })}>حساب بنكي</Button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{payForm.payMethod === "cash" ? "الصندوق" : "الحساب البنكي"}</label>
                <SearchCombobox
                  items={(payForm.payMethod === "cash" ? (hrSettings?.cashBoxes || []) : (hrSettings?.bankAccounts || [])).map((x: any) => ({
                    value: String(x.id), label: x.nameAr || x.nameEn || `#${x.id}`,
                  }))}
                  value={payForm.accountId ? String(payForm.accountId) : ""}
                  onValueChange={(v) => setPayForm({ ...payForm, accountId: v ? Number(v) : "" })}
                  placeholder="— اختر —"
                  className="w-full"
                />
              </div>
              <div className="space-y-2 rounded border bg-muted/20 p-3">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox checked={payForm.useProvision} onCheckedChange={(v) => setPayForm({ ...payForm, useProvision: !!v })} data-testid="use-provision" />
                  <div>
                    <div className="font-medium">الصرف من حساب المخصص</div>
                    <div className="text-xs text-muted-foreground">حدّد إذا كنت تكوّن مخصصاً سنوياً لمكافأة نهاية الخدمة (يجعل الجانب المدين هو ح/ مخصص نهاية الخدمة بدلاً من المصروف).</div>
                  </div>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox checked={payForm.endEmployment} onCheckedChange={(v) => setPayForm({ ...payForm, endEmployment: !!v })} data-testid="end-employment" />
                  <div>
                    <div className="font-medium">إنهاء خدمة الموظف</div>
                    <div className="text-xs text-muted-foreground">تحديث حالة الموظف إلى "منتهي الخدمة" وإثبات تاريخ الانتهاء.</div>
                  </div>
                </label>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">البيان</label>
                <Textarea rows={2} value={payForm.description} onChange={(e) => setPayForm({ ...payForm, description: e.target.value })} />
              </div>
              <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2">
                سيتم إنشاء قيد: من ح/ {payForm.useProvision ? "مخصص نهاية الخدمة" : "مصروف نهاية الخدمة"} {Number(payForm.amount || 0).toFixed(2)} إلى ح/ {payForm.payMethod === "cash" ? "الصندوق" : "البنك"} {Number(payForm.amount || 0).toFixed(2)}.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPay(false)}>إلغاء</Button>
            <Button onClick={() => payMut.mutate()} disabled={payMut.isPending || !payForm.accountId || !(Number(payForm.amount) > 0)} data-testid="btn-confirm-pay">
              {payMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <CheckCircle2 className="size-4 me-1" />}
              تأكيد الصرف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="text-xs text-muted-foreground bg-amber-50/50 border border-amber-200 rounded p-3 print:hidden">
        <strong>ملاحظات هامة:</strong>
        <ul className="list-disc list-inside mt-1 space-y-1">
          <li>عند الاستقالة: لا توجد مكافأة قبل سنتين، ⅓ من 2-5 سنوات، ⅔ من 5-10 سنوات، كاملة بعد 10 سنوات (المادة 85).</li>
          <li>عند الإنهاء من صاحب العمل لأسباب غير مشروعة: المكافأة كاملة (المادة 84).</li>
          <li>الأجر المحتسب هو الأجر الشامل (الأساسي + البدلات الثابتة)، لا يشمل الإضافي أو العمولات المتغيرة.</li>
          <li>المرأة العاملة التي تنهي عقدها بسبب الزواج خلال 6 أشهر من تاريخ الزواج تستحق المكافأة كاملة.</li>
        </ul>
      </div>
    </div>
  );
}

function Card({ label, value, hint, amber, emerald }: any) {
  return (
    <div className={`rounded-lg border p-3 bg-card ${amber ? "bg-amber-50/50 border-amber-200" : ""} ${emerald ? "bg-emerald-50/50 border-emerald-200" : ""}`}>
      <div className={`text-xs ${amber ? "text-amber-700" : emerald ? "text-emerald-700" : "text-muted-foreground"}`}>{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${amber ? "text-amber-700" : emerald ? "text-emerald-700" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function Step({ n, title, children }: any) {
  return (
    <div className="flex gap-3">
      <div className="size-7 rounded-full bg-primary/10 text-primary font-semibold text-sm flex items-center justify-center shrink-0">{n}</div>
      <div className="flex-1">
        <div className="font-medium text-sm mb-1">{title}</div>
        <div className="text-sm text-slate-700">{children}</div>
      </div>
    </div>
  );
}
