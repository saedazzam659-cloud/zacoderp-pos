import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Calculator, Sparkles, Loader2, CalendarDays, HeartPulse, Clock, Shield, MailWarning, GraduationCap, BookOpen,
} from "lucide-react";

const today = () => new Date().toISOString().slice(0, 10);

function ResultBox({ result, calcType, inputs }: any) {
  const { toast } = useToast();
  const [explain, setExplain] = useState<string>("");

  const explainMut = useMutation({
    mutationFn: () => employeesApi.aiExplainHrCalc(calcType, inputs, result),
    onSuccess: (d) => setExplain(d.explanation),
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  if (!result) return null;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/20 p-4 space-y-1.5 text-sm">
        {Object.entries(result).map(([k, v]) => {
          if (k === "legalRef" || k === "warning" || k === "formula" || k === "noteTransition" || k === "statusLabel") return null;
          if (v == null || v === "") return null;
          if (typeof v === "object") return null;
          return (
            <div key={k} className="flex justify-between border-b last:border-0 pb-1">
              <span className="text-muted-foreground text-xs">{LABELS[k] || k}</span>
              <span className="font-medium tabular-nums">{typeof v === "boolean" ? (v ? "نعم" : "لا") : String(v)}</span>
            </div>
          );
        })}
        {result.formula && (
          <div className="pt-2 mt-2 border-t bg-emerald-50/50 -mx-2 px-2 py-1 rounded text-emerald-900 text-xs">
            <strong>المعادلة:</strong> {result.formula}
          </div>
        )}
        {result.noteTransition && (
          <div className="text-xs text-blue-700 bg-blue-50/50 rounded p-1.5">{result.noteTransition}</div>
        )}
        {result.statusLabel && (
          <div className="text-sm font-semibold pt-1">{result.statusLabel}</div>
        )}
        {result.warning && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mt-2">⚠ {result.warning}</div>
        )}
        {result.legalRef && (
          <div className="text-xs text-muted-foreground bg-blue-50/30 rounded p-2 mt-2 flex items-start gap-1.5">
            <BookOpen className="size-3.5 mt-0.5 text-blue-600" />
            <span>{result.legalRef}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => explainMut.mutate()} disabled={explainMut.isPending} variant="outline" size="sm" data-testid={`btn-explain-${calcType}`}>
          {explainMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Sparkles className="size-4 me-1 text-violet-600" />}
          شرح بالـ AI
        </Button>
      </div>

      {explain && (
        <div className="rounded-lg border bg-blue-50/30 border-blue-200 p-3">
          <div className="flex items-center gap-2 mb-2 text-blue-900 font-semibold text-sm">
            <Sparkles className="size-4" /> شرح المستشار
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{explain}</pre>
        </div>
      )}
    </div>
  );
}

const LABELS: Record<string, string> = {
  hireDate: "تاريخ التعيين",
  asOfDate: "حتى تاريخ",
  yearsOfService: "مدة الخدمة (سنة)",
  ratePerYearCurrent: "معدل الاستحقاق الحالي (يوم/سنة)",
  accruedDaysTotal: "إجمالي الأيام المتراكمة",
  daysTaken: "الأيام المستهلكة",
  remainingDays: "الرصيد المتبقي",
  currentYearAccrual: "تراكم العام الحالي",
  dailyWage: "الأجر اليومي",
  cashValueIfPaid: "القيمة النقدية للرصيد",
  fullPaidDays: "أيام أجر كامل",
  partialPaidDays: "أيام أجر جزئي (75%)",
  unpaidDays: "أيام بدون أجر",
  beyondLimit: "تجاوز الحد (يوم)",
  fullPay: "أجر الأيام الكاملة",
  partialPay: "أجر الأيام الجزئية",
  totalPay: "إجمالي ما يُدفع",
  lostWages: "الأجر المفقود",
  remainingFull: "متبقي بأجر كامل",
  remainingPartial: "متبقي بأجر جزئي",
  remainingTotal: "متبقي إجمالي",
  monthlyWage: "الأجر الشهري الشامل",
  hourlyWage: "أجر الساعة العادية",
  overtimeHours: "ساعات الوقت الإضافي",
  multiplier: "المعامل",
  overtimeAmount: "قيمة الوقت الإضافي",
  wageBeforeCap: "الأجر قبل الحد الأعلى",
  gosiWage: "الأجر التأميني",
  cap: "الحد الأعلى",
  isSaudi: "موظف سعودي",
  employeeShare: "حصة الموظف (10%)",
  employerAnnuities: "حصة صاحب العمل — معاشات (12%)",
  employerOccupationalHazards: "حصة صاحب العمل — أخطار مهنية (2%)",
  totalEmployer: "إجمالي حصة صاحب العمل",
  totalCost: "إجمالي تكلفة التأمين",
  netToEmployee: "صافي للموظف",
  capApplied: "تم تطبيق الحد الأعلى",
  requiredNoticeDays: "أيام الإشعار المطلوبة",
  daysActuallyGiven: "أيام الإشعار الممنوحة",
  compensationDays: "أيام التعويض",
  compensationAmount: "قيمة بدل الإشعار",
  probationDays: "فترة التجربة (يوم)",
  probationEndDate: "تاريخ نهاية التجربة",
  daysElapsed: "الأيام المنقضية",
  daysRemaining: "الأيام المتبقية",
  status: "الحالة",
};

export default function HRCalculators() {
  const { toast } = useToast();
  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });

  function loadEmp(empId: string, setter: (e: any) => void) {
    const emp = employees.find((x: any) => String(x.id) === empId);
    if (emp) setter(emp);
  }

  // ─── Annual Leave ───────────────────────────────────────────
  const [alForm, setAlForm] = useState<any>({ hireDate: "", asOfDate: today(), daysTaken: 0, basicSalary: 0, housingAllow: 0, transportAllow: 0 });
  const [alResult, setAlResult] = useState<any>(null);
  const alMut = useMutation({ mutationFn: () => employeesApi.calcAnnualLeave(alForm), onSuccess: setAlResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  // ─── Sick Leave ─────────────────────────────────────────────
  const [slForm, setSlForm] = useState<any>({ daysTaken: 0, basicSalary: 0, housingAllow: 0 });
  const [slResult, setSlResult] = useState<any>(null);
  const slMut = useMutation({ mutationFn: () => employeesApi.calcSickLeave(slForm), onSuccess: setSlResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  // ─── Overtime ───────────────────────────────────────────────
  const [otForm, setOtForm] = useState<any>({ basicSalary: 0, housingAllow: 0, transportAllow: 0, workingDaysPerMonth: 30, hoursPerDay: 8, overtimeHours: 0 });
  const [otResult, setOtResult] = useState<any>(null);
  const otMut = useMutation({ mutationFn: () => employeesApi.calcOvertime(otForm), onSuccess: setOtResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  // ─── GOSI ───────────────────────────────────────────────────
  const [gForm, setGForm] = useState<any>({ basicSalary: 0, housingAllow: 0, isSaudi: false });
  const [gResult, setGResult] = useState<any>(null);
  const gMut = useMutation({ mutationFn: () => employeesApi.calcGosi(gForm), onSuccess: setGResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  // ─── Notice Period ──────────────────────────────────────────
  const [npForm, setNpForm] = useState<any>({ basicSalary: 0, housingAllow: 0, transportAllow: 0, requiredNoticeDays: 60, daysActuallyGiven: 0 });
  const [npResult, setNpResult] = useState<any>(null);
  const npMut = useMutation({ mutationFn: () => employeesApi.calcNoticePeriod(npForm), onSuccess: setNpResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  // ─── Probation ──────────────────────────────────────────────
  const [pForm, setPForm] = useState<any>({ hireDate: "", probationDays: 90, asOfDate: today() });
  const [pResult, setPResult] = useState<any>(null);
  const pMut = useMutation({ mutationFn: () => employeesApi.calcProbation(pForm), onSuccess: setPResult, onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }) });

  function EmpPicker({ onPick }: { onPick: (emp: any) => void }) {
    return (
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">تحميل بيانات موظف (اختياري)</label>
        <SearchCombobox
          items={employees.map((e: any) => ({ value: String(e.id), code: e.code, label: e.nameAr, description: e.jobTitle || undefined }))}
          value=""
          onValueChange={(v) => loadEmp(v, onPick)}
          placeholder="ابحث ثم اختر…"
          searchPlaceholder="ابحث بالاسم أو الكود…"
          className="w-full"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-hr-calculators">
      <div className="flex items-center gap-2">
        <Calculator className="size-6 text-primary" />
        <h1 className="text-xl font-semibold">حاسبات الموارد البشرية — وفق نظام العمل السعودي</h1>
      </div>

      <Tabs defaultValue="annual-leave">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="annual-leave"><CalendarDays className="size-4 me-1" />إجازة سنوية</TabsTrigger>
          <TabsTrigger value="sick-leave"><HeartPulse className="size-4 me-1" />إجازة مرضية</TabsTrigger>
          <TabsTrigger value="overtime"><Clock className="size-4 me-1" />وقت إضافي</TabsTrigger>
          <TabsTrigger value="gosi"><Shield className="size-4 me-1" />تأمينات GOSI</TabsTrigger>
          <TabsTrigger value="notice-period"><MailWarning className="size-4 me-1" />بدل الإشعار</TabsTrigger>
          <TabsTrigger value="probation"><GraduationCap className="size-4 me-1" />فترة التجربة</TabsTrigger>
        </TabsList>

        {/* Annual Leave */}
        <TabsContent value="annual-leave" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setAlForm({ ...alForm, hireDate: e.hireDate || "", basicSalary: Number(e.basicSalary || 0), housingAllow: Number(e.housingAllow || 0), transportAllow: Number(e.transportAllow || 0) })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">تاريخ التعيين *</label><Input type="date" value={alForm.hireDate} onChange={e => setAlForm({ ...alForm, hireDate: e.target.value })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">حتى تاريخ</label><Input type="date" value={alForm.asOfDate} onChange={e => setAlForm({ ...alForm, asOfDate: e.target.value })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الأيام المستهلكة</label><Input type="number" min="0" value={alForm.daysTaken} onChange={e => setAlForm({ ...alForm, daysTaken: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الراتب الأساسي</label><Input type="number" min="0" value={alForm.basicSalary} onChange={e => setAlForm({ ...alForm, basicSalary: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل سكن</label><Input type="number" min="0" value={alForm.housingAllow} onChange={e => setAlForm({ ...alForm, housingAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل انتقال</label><Input type="number" min="0" value={alForm.transportAllow} onChange={e => setAlForm({ ...alForm, transportAllow: Number(e.target.value) })} /></div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => alMut.mutate()} disabled={!alForm.hireDate || alMut.isPending} data-testid="btn-calc-al">
                {alMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={alResult} calcType="annual-leave" inputs={alForm} />
          <Hint title="المادة 109">رصيد الإجازة 21 يوماً سنوياً، يصبح 30 يوماً بعد إكمال 5 سنوات متصلة. الرصيد قابل للتجميع، وإذا انتهى العقد ولم تُستخدم الأيام تُدفع نقداً بأجر شامل (أساسي + سكن + انتقال) ÷ 30.</Hint>
        </TabsContent>

        {/* Sick Leave */}
        <TabsContent value="sick-leave" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setSlForm({ ...slForm, basicSalary: Number(e.basicSalary || 0), housingAllow: Number(e.housingAllow || 0) })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">عدد أيام الإجازة المرضية في السنة *</label><Input type="number" min="0" max="365" value={slForm.daysTaken} onChange={e => setSlForm({ ...slForm, daysTaken: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الراتب الأساسي</label><Input type="number" min="0" value={slForm.basicSalary} onChange={e => setSlForm({ ...slForm, basicSalary: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل سكن</label><Input type="number" min="0" value={slForm.housingAllow} onChange={e => setSlForm({ ...slForm, housingAllow: Number(e.target.value) })} /></div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => slMut.mutate()} disabled={slMut.isPending} data-testid="btn-calc-sl">
                {slMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={slResult} calcType="sick-leave" inputs={slForm} />
          <Hint title="المادة 117">للموظف خلال السنة الواحدة: <strong>30 يوم بأجر كامل</strong>، ثم <strong>60 يوم بأجر 75%</strong>، ثم <strong>30 يوم بدون أجر</strong>. بعد ذلك يحق لصاحب العمل إنهاء العقد (المادة 82).</Hint>
        </TabsContent>

        {/* Overtime */}
        <TabsContent value="overtime" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setOtForm({ ...otForm, basicSalary: Number(e.basicSalary || 0), housingAllow: Number(e.housingAllow || 0), transportAllow: Number(e.transportAllow || 0) })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الراتب الأساسي</label><Input type="number" min="0" value={otForm.basicSalary} onChange={e => setOtForm({ ...otForm, basicSalary: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل سكن</label><Input type="number" min="0" value={otForm.housingAllow} onChange={e => setOtForm({ ...otForm, housingAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل انتقال</label><Input type="number" min="0" value={otForm.transportAllow} onChange={e => setOtForm({ ...otForm, transportAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">أيام عمل/شهر</label><Input type="number" min="1" max="31" value={otForm.workingDaysPerMonth} onChange={e => setOtForm({ ...otForm, workingDaysPerMonth: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">ساعات/يوم</label><Input type="number" min="1" max="12" value={otForm.hoursPerDay} onChange={e => setOtForm({ ...otForm, hoursPerDay: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">ساعات إضافية *</label><Input type="number" min="0" step="0.25" value={otForm.overtimeHours} onChange={e => setOtForm({ ...otForm, overtimeHours: Number(e.target.value) })} /></div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => otMut.mutate()} disabled={otMut.isPending} data-testid="btn-calc-ot">
                {otMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={otResult} calcType="overtime" inputs={otForm} />
          <Hint title="المادة 107">أجر ساعة الوقت الإضافي = أجر الساعة العادية + 50% (×1.5). أجر الساعة العادية = الأجر الشهري ÷ أيام الشهر ÷ ساعات اليوم.</Hint>
        </TabsContent>

        {/* GOSI */}
        <TabsContent value="gosi" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setGForm({ ...gForm, basicSalary: Number(e.basicSalary || 0), housingAllow: Number(e.housingAllow || 0), isSaudi: /سعود|saudi/i.test(e.nationality || "") })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الراتب الأساسي</label><Input type="number" min="0" value={gForm.basicSalary} onChange={e => setGForm({ ...gForm, basicSalary: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل سكن</label><Input type="number" min="0" value={gForm.housingAllow} onChange={e => setGForm({ ...gForm, housingAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الجنسية</label>
              <SearchCombobox
                items={[{ value: "true", label: "سعودي" }, { value: "false", label: "غير سعودي" }]}
                value={String(gForm.isSaudi)}
                onValueChange={(v) => setGForm({ ...gForm, isSaudi: v === "true" })}
                placeholder="—" className="w-full"
              />
            </div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => gMut.mutate()} disabled={gMut.isPending} data-testid="btn-calc-gosi">
                {gMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={gResult} calcType="gosi" inputs={gForm} />
          <Hint title="نظام التأمينات الاجتماعية">للسعوديين: 10% خصم من الموظف + 12% معاشات على صاحب العمل + 2% أخطار مهنية. لغير السعوديين: 2% أخطار مهنية فقط على صاحب العمل. الحد الأعلى للأجر التأميني = 45,000 ر.س (أساسي + سكن).</Hint>
        </TabsContent>

        {/* Notice Period */}
        <TabsContent value="notice-period" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setNpForm({ ...npForm, basicSalary: Number(e.basicSalary || 0), housingAllow: Number(e.housingAllow || 0), transportAllow: Number(e.transportAllow || 0) })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">الراتب الأساسي</label><Input type="number" min="0" value={npForm.basicSalary} onChange={e => setNpForm({ ...npForm, basicSalary: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل سكن</label><Input type="number" min="0" value={npForm.housingAllow} onChange={e => setNpForm({ ...npForm, housingAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">بدل انتقال</label><Input type="number" min="0" value={npForm.transportAllow} onChange={e => setNpForm({ ...npForm, transportAllow: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">أيام الإشعار المطلوبة</label><Input type="number" min="0" value={npForm.requiredNoticeDays} onChange={e => setNpForm({ ...npForm, requiredNoticeDays: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">أيام الإشعار الفعلية</label><Input type="number" min="0" value={npForm.daysActuallyGiven} onChange={e => setNpForm({ ...npForm, daysActuallyGiven: Number(e.target.value) })} /></div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => npMut.mutate()} disabled={npMut.isPending} data-testid="btn-calc-np">
                {npMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={npResult} calcType="notice-period" inputs={npForm} />
          <Hint title="المادة 75">العقد غير محدد المدة يُنهى بإشعار <strong>60 يوم من صاحب العمل</strong> و<strong>30 يوم من العامل</strong>. إذا لم تُمنح فترة الإشعار يُدفع بدلها أجر تلك المدة بالكامل.</Hint>
        </TabsContent>

        {/* Probation */}
        <TabsContent value="probation" className="space-y-3">
          <div className="rounded-lg border bg-card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmpPicker onPick={(e) => setPForm({ ...pForm, hireDate: e.hireDate || "" })} />
            <div className="space-y-1"><label className="text-xs text-muted-foreground">تاريخ التعيين *</label><Input type="date" value={pForm.hireDate} onChange={e => setPForm({ ...pForm, hireDate: e.target.value })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">فترة التجربة (يوم) — حد أقصى 180</label><Input type="number" min="1" max="180" value={pForm.probationDays} onChange={e => setPForm({ ...pForm, probationDays: Number(e.target.value) })} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">حتى تاريخ</label><Input type="date" value={pForm.asOfDate} onChange={e => setPForm({ ...pForm, asOfDate: e.target.value })} /></div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={() => pMut.mutate()} disabled={!pForm.hireDate || pMut.isPending} data-testid="btn-calc-p">
                {pMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />} احتساب
              </Button>
            </div>
          </div>
          <ResultBox result={pResult} calcType="probation" inputs={pForm} />
          <Hint title="المادة 53">فترة التجربة الافتراضية 90 يوماً. يجوز تمديدها باتفاق كتابي إلى 180 يوماً. خلال هذه الفترة لكلا الطرفين الحق في إنهاء العقد دون إشعار أو مكافأة.</Hint>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Hint({ title, children }: any) {
  return (
    <div className="text-xs text-slate-700 bg-blue-50/40 border border-blue-200 rounded p-3 flex items-start gap-2">
      <BookOpen className="size-4 text-blue-600 mt-0.5 shrink-0" />
      <div>
        <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200 me-2 text-[10px]">{title}</Badge>
        {children}
      </div>
    </div>
  );
}
