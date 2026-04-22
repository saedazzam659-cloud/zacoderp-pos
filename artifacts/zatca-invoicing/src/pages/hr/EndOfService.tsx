import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Calculator, Sparkles, Loader2, ScrollText, Printer } from "lucide-react";

export default function EndOfService() {
  const { toast } = useToast();
  const [empId, setEmpId] = useState<number | "">("");
  const [reason, setReason] = useState<"resignation" | "termination">("resignation");
  const [calc, setCalc] = useState<any | null>(null);
  const [explain, setExplain] = useState<string>("");

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const selectedEmp = employees.find((e: any) => e.id === Number(empId));

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
            <select value={empId} onChange={e => { setEmpId(e.target.value ? Number(e.target.value) : ""); setCalc(null); setExplain(""); }}
              className="h-9 w-full rounded-md border bg-background px-2" data-testid="eos-emp">
              <option value="">— اختر موظفاً —</option>
              {employees.map((e: any) => (
                <option key={e.id} value={e.id}>{e.code} — {e.nameAr}{e.hireDate ? "" : " (لا يوجد تاريخ تعيين)"}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">سبب إنهاء الخدمة</label>
            <select value={reason} onChange={e => { setReason(e.target.value as any); setCalc(null); setExplain(""); }}
              className="h-9 w-full rounded-md border bg-background px-2" data-testid="eos-reason">
              <option value="resignation">استقالة الموظف (المادة 85)</option>
              <option value="termination">إنهاء من صاحب العمل (المادة 84 — كاملة)</option>
            </select>
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
