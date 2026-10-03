import "./_group.css";
import { useState } from "react";
import {
  Boxes,
  Calculator,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Cog,
  FileText,
  Factory,
  GitBranch,
  HardHat,
  Plus,
  RefreshCw,
  Settings2,
  Wrench,
} from "lucide-react";

const navigation = [
  { id: "orders", label: "سجل الأوامر", icon: Boxes, tint: "sky" },
  { id: "new", label: "أمر تصنيع جديد", icon: Plus, tint: "violet" },
  { id: "setup", label: "الإعدادات", icon: Settings2, tint: "amber" },
  { id: "reports", label: "التقارير المجمعة", icon: FileText, tint: "emerald" },
] as const;

const wizardSteps = [
  { id: "basic", label: "البيانات الأساسية", icon: ClipboardList, tint: "sky" },
  { id: "materials", label: "المواد والوصفة", icon: Boxes, tint: "teal" },
  { id: "routing", label: "مسار الإنتاج", icon: GitBranch, tint: "amber" },
  { id: "resources", label: "الموارد", icon: Cog, tint: "violet" },
  { id: "costs", label: "التكاليف", icon: Calculator, tint: "emerald" },
  { id: "review", label: "المراجعة", icon: CheckCircle2, tint: "rose" },
] as const;

const tabColors: Record<string, string> = {
  sky: "border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 data-[active=true]:!border-sky-700 data-[active=true]:!bg-sky-700 data-[active=true]:!text-white",
  teal: "border-teal-200 bg-teal-50 text-teal-900 hover:bg-teal-100 data-[active=true]:!border-teal-700 data-[active=true]:!bg-teal-700 data-[active=true]:!text-white",
  amber: "border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100 data-[active=true]:!border-amber-700 data-[active=true]:!bg-amber-600 data-[active=true]:!text-white",
  violet: "border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100 data-[active=true]:!border-violet-700 data-[active=true]:!bg-violet-700 data-[active=true]:!text-white",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-950 hover:bg-emerald-100 data-[active=true]:!border-emerald-700 data-[active=true]:!bg-emerald-700 data-[active=true]:!text-white",
  rose: "border-rose-200 bg-rose-50 text-rose-950 hover:bg-rose-100 data-[active=true]:!border-rose-700 data-[active=true]:!bg-rose-700 data-[active=true]:!text-white",
};

const productionStages = [
  {
    name: "تجهيز المواد والوزن",
    duration: 20,
    resource: "عمالة",
    workers: "عاملان",
    machine: null,
    tone: "sky",
  },
  {
    name: "الخلط والتشغيل",
    duration: 45,
    resource: "آلة + عمالة",
    workers: "عاملان",
    machine: "خلاط صناعي M-04",
    tone: "teal",
  },
  {
    name: "الفحص والتعبئة",
    duration: 30,
    resource: "عمالة",
    workers: "3 عمال",
    machine: null,
    tone: "amber",
  },
] as const;

const stageTones = {
  sky: {
    rail: "bg-sky-500",
    number: "border-sky-200 bg-sky-50 text-sky-800",
    pill: "border-sky-200 bg-sky-50 text-sky-800",
  },
  teal: {
    rail: "bg-teal-600",
    number: "border-teal-200 bg-teal-50 text-teal-800",
    pill: "border-teal-200 bg-teal-50 text-teal-800",
  },
  amber: {
    rail: "bg-amber-500",
    number: "border-amber-200 bg-amber-50 text-amber-800",
    pill: "border-amber-200 bg-amber-50 text-amber-800",
  },
} as const;

export function StageAware() {
  const [activeStep, setActiveStep] = useState("routing");
  const [activeNavigation, setActiveNavigation] = useState("new");
  const selectedStepIndex = wizardSteps.findIndex((step) => step.id === activeStep);
  const selectedStep = wizardSteps[selectedStepIndex];
  const SelectedIcon = selectedStep.icon;

  return (
    <main
      dir="rtl"
      lang="ar"
      className="min-h-[100dvh] bg-slate-50 p-4 font-sans text-slate-800 sm:p-6"
    >
      <div className="mx-auto max-w-[1120px] space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-4">
            <div className="rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 p-3.5 text-white shadow-lg shadow-violet-200">
              <Factory className="h-7 w-7" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">التصنيع الذكي</h1>
              <p className="mt-1 text-sm text-slate-500">
                إدارة أوامر التشغيل، التكاليف، وإعدادات الورشة من شاشة واحدة.
              </p>
            </div>
          </div>
          <div className="inline-flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600">
            <RefreshCw className="ml-2 h-4 w-4" aria-hidden="true" />
            تحديث البيانات
          </div>
        </header>

        <nav aria-label="أقسام التصنيع الذكي">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {navigation.map(({ id, label, icon: Icon, tint }) => {
              const isActive = activeNavigation === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  data-active={isActive}
                  onClick={() => setActiveNavigation(id)}
                  className={`flex min-h-12 items-center justify-center gap-2 rounded-xl border px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2 sm:text-sm ${tabColors[tint]}`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900 sm:text-xl">أمر تصنيع جديد</h2>
              <p className="mt-1 text-sm text-slate-500">انتقل بين خطوات إعداد أمر التصنيع.</p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-lg border border-violet-100 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800">
              <GitBranch className="h-4 w-4" aria-hidden="true" />
              مسار الإنتاج
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {wizardSteps.map(({ id, label, icon: Icon, tint }, index) => {
              const isActive = activeStep === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-active={isActive}
                  aria-current={isActive ? "step" : undefined}
                  onClick={() => setActiveStep(id)}
                  className={`flex min-h-[54px] items-center gap-2 rounded-lg border px-2.5 py-2 text-start text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2 sm:justify-center sm:text-[13px] ${tabColors[tint]}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${isActive ? "bg-white/15 text-white" : "bg-white/75 text-current"}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <Icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
                  <span className="leading-5">{label}</span>
                </button>
              );
            })}
          </div>

          <div
            aria-live="polite"
            aria-atomic="true"
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-100 bg-violet-50/70 px-3.5 py-2.5 text-sm"
          >
            <div className="flex items-center gap-2 text-slate-600">
              <SelectedIcon className="h-4 w-4 text-violet-700" aria-hidden="true" />
              <span>الخطوة المحددة:</span>
              <strong className="font-semibold text-violet-900">{selectedStep.label}</strong>
            </div>
            <span className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-violet-100">
              الخطوة {selectedStepIndex + 1} من {wizardSteps.length}
            </span>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 sm:text-lg">مراحل مسار الإنتاج المخططة</h3>
                <p className="mt-1 text-sm text-slate-500">المراحل والموارد المقترحة من مسار الإنتاج النشط.</p>
              </div>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                {productionStages.length} مراحل
              </span>
            </div>

            <aside className="mb-4 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm leading-6 text-violet-900">
              تُنسخ المراحل من مسار الإنتاج النشط كلقطة مستقلة للأمر، فلا تغيّر التعديلات اللاحقة على المسار تاريخ هذا الأمر.
              <p className="mt-2 border-t border-violet-200/80 pt-2 text-xs leading-5 text-violet-800">
                هذه معاينة قبل إنشاء الأمر، وليست تسجيلًا للتنفيذ الفعلي. تُدخل ساعات التشغيل الفعلية وعدد العمال الفعليين لكل مرحلة بعد البدء فقط من شاشة تنفيذ المرحلة.
              </p>
            </aside>

            <div className="space-y-3">
              {productionStages.map((stage, index) => {
                const tone = stageTones[stage.tone];
                return (
                  <article
                    key={stage.name}
                    className="relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
                  >
                    <div className={`absolute inset-y-0 start-0 w-1 ${tone.rail}`} />
                    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3 p-3.5 sm:grid-cols-[auto_minmax(150px,1fr)_auto] sm:gap-4 sm:p-4">
                      <span className={`flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-bold tabular-nums ${tone.number}`}>
                        {index + 1}
                      </span>
                      <h4 className="font-bold text-slate-800">{stage.name}</h4>
                      <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-1 sm:justify-end">
                        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${tone.pill}`}>
                          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                          المدة: {stage.duration} دقيقة
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600">
                          <span>المورد: {stage.resource}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600">
                          <HardHat className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                          العمال: {stage.workers}
                        </span>
                        {stage.machine && (
                          <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600">
                            <Wrench className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                            الآلة: {stage.machine}
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}