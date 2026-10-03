import "./_group.css";
import { useState } from "react";
import {
  Boxes,
  Calculator,
  CheckCircle2,
  ClipboardList,
  Cog,
  Factory,
  FileText,
  GitBranch,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const steps = [
  { id: "basic", label: "البيانات الأساسية", icon: ClipboardList },
  { id: "materials", label: "المواد والوصفة", icon: Boxes },
  { id: "routing", label: "مسار الإنتاج", icon: GitBranch },
  { id: "resources", label: "الموارد", icon: Cog },
  { id: "costs", label: "التكاليف", icon: Calculator },
  { id: "review", label: "المراجعة", icon: CheckCircle2 },
];

const stages = [
  { name: "تجهيز المواد والوزن", duration: 20, resource: "عمالة", workers: 2, resourceId: null },
  { name: "الخلط والتشغيل", duration: 45, resource: "آلة + عمالة", workers: 2, resourceId: 4 },
  { name: "الفحص والتعبئة", duration: 30, resource: "عمالة", workers: 3, resourceId: null },
];

export function Current() {
  const [activeStep, setActiveStep] = useState("routing");

  return (
    <main
      dir="rtl"
      lang="ar"
      className="min-h-screen bg-background p-5 font-sans text-foreground sm:p-7"
    >
      <section className="mx-auto max-w-7xl space-y-6 pb-12">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 p-3 text-white shadow-lg shadow-violet-200/70">
              <Factory className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">التصنيع الذكي</h1>
              <p className="mt-1 text-sm text-slate-500">
                إدارة أوامر التشغيل، التكاليف، وإعدادات الورشة من شاشة واحدة.
              </p>
            </div>
          </div>
          <button className="inline-flex h-10 items-center rounded-lg border bg-slate-50 px-3 text-sm text-slate-600">
            <RefreshCw className="ml-2 h-4 w-4" />
            تحديث البيانات
          </button>
        </header>

        <Tabs defaultValue="new" className="space-y-6">
          <TabsList className="flex h-14 w-full overflow-x-auto rounded-xl border bg-white p-1 shadow-sm">
            <TabsTrigger value="orders" className="h-11 flex-1 rounded-lg text-base data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
              <Boxes className="ml-2 h-4 w-4" />
              سجل الأوامر
            </TabsTrigger>
            <TabsTrigger value="new" className="h-11 flex-1 rounded-lg text-base data-[state=active]:bg-violet-600 data-[state=active]:text-white data-[state=active]:shadow-sm">
              <Plus className="ml-2 h-4 w-4" />
              أمر تصنيع جديد
            </TabsTrigger>
            <TabsTrigger value="setup" className="h-11 flex-1 rounded-lg text-base data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
              <Settings2 className="ml-2 h-4 w-4" />
              الإعدادات
            </TabsTrigger>
            <TabsTrigger value="reports" className="h-11 flex-1 rounded-lg text-base data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
              <FileText className="ml-2 h-4 w-4" />
              التقارير المجمعة
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-4 flex gap-2 overflow-x-auto rounded-xl border bg-slate-50 p-2">
            {steps.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveStep(id)}
                className={`flex min-w-[120px] flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
                  activeStep === id
                    ? "border border-violet-100 bg-white text-violet-700 shadow-sm"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                }`}
              >
                <Icon className={`h-4 w-4 ${activeStep === id ? "text-violet-600" : ""}`} />
                {label}
              </button>
            ))}
          </div>

          <div className="rounded-lg border bg-slate-50 p-4 text-sm text-slate-600">
            <div className="mb-2 rounded-md border border-violet-200 bg-violet-50 p-3 text-violet-900">
              تُنسخ المراحل من مسار الإنتاج النشط كلقطة مستقلة للأمر. هذه معاينة قبل الإنشاء، وليست تسجيل التنفيذ الفعلي.
            </div>
            <div className="relative flex flex-col gap-3 pl-8 before:absolute before:inset-y-0 before:start-[19px] before:w-0.5 before:bg-violet-100">
              {stages.map((stage, index) => (
                <article key={stage.name} className="relative rounded-lg border bg-white p-4 shadow-sm">
                  <div className="absolute -start-11 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border-2 border-violet-500 bg-violet-100 text-xs font-bold text-violet-700">
                    {index + 1}
                  </div>
                  <h3 className="font-semibold text-slate-800">{stage.name}</h3>
                  <div className="mt-1 flex items-center gap-4 text-xs text-slate-500">
                    <span>المدة (محرك التكلفة): {stage.duration} دقيقة</span>
                    <span>المورد: {stage.resource}</span>
                    {stage.workers != null && <span>العمال: {stage.workers}</span>}
                    {stage.resourceId != null && <span>الآلة: #{stage.resourceId}</span>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}