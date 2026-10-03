import "./_group.css";
import { useState } from "react";
import {
  Briefcase,
  FileSpreadsheet,
  Plus,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const tabs = [
  {
    value: "metadata",
    label: "بيانات المستخلص",
    icon: Briefcase,
    color:
      "border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 dark:hover:bg-sky-900/60 data-[state=active]:!border-sky-700 data-[state=active]:!bg-sky-700 data-[state=active]:!text-white dark:data-[state=active]:!border-sky-500 dark:data-[state=active]:!bg-sky-600",
  },
  {
    value: "execution",
    label: "بنود التنفيذ",
    icon: FileSpreadsheet,
    color:
      "border-teal-200 bg-teal-50 text-teal-900 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200 dark:hover:bg-teal-900/60 data-[state=active]:!border-teal-700 data-[state=active]:!bg-teal-700 data-[state=active]:!text-white dark:data-[state=active]:!border-teal-500 dark:data-[state=active]:!bg-teal-600",
  },
  {
    value: "adjustments",
    label: "الإضافات والخصومات",
    icon: Plus,
    color:
      "border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/60 data-[state=active]:!border-amber-700 data-[state=active]:!bg-amber-600 data-[state=active]:!text-white dark:data-[state=active]:!border-amber-500 dark:data-[state=active]:!bg-amber-600",
  },
  {
    value: "payments",
    label: "الدفعات والاستقطاعات",
    icon: Wallet,
    color:
      "border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-900/60 data-[state=active]:!border-violet-700 data-[state=active]:!bg-violet-700 data-[state=active]:!text-white dark:data-[state=active]:!border-violet-500 dark:data-[state=active]:!bg-violet-600",
  },
  {
    value: "summary",
    label: "الملخص النهائي",
    icon: TrendingUp,
    color:
      "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-900/60 data-[state=active]:!border-emerald-700 data-[state=active]:!bg-emerald-700 data-[state=active]:!text-white dark:data-[state=active]:!border-emerald-500 dark:data-[state=active]:!bg-emerald-600",
  },
];

export function StageColors() {
  const [activeTab, setActiveTab] = useState("metadata");
  const activeIndex = tabs.findIndex((tab) => tab.value === activeTab);

  return (
    <main
      dir="rtl"
      lang="ar"
      className="min-h-screen bg-background p-6 font-sans text-foreground"
    >
      <section className="mx-auto max-w-[1120px] rounded-xl border bg-card p-5 shadow-sm">
        <header className="mb-4 flex items-center justify-between border-b border-sky-100 pb-3 dark:border-sky-900/40">
          <div>
            <h1 className="flex items-center gap-2 font-bold text-sky-800 dark:text-sky-200">
              تعديل المستخلص
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500 dark:bg-slate-800">
                (للمالك — صادر)
              </span>
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              انتقل بين أقسام المستخلص لإكمال البيانات
            </p>
          </div>
          <span className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-500 dark:border-slate-700">
            PR0003
          </span>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-2 rounded-xl bg-transparent p-0 sm:grid-cols-3 xl:grid-cols-5">
            {tabs.map(({ value, label, icon: Icon, color }) => (
              <TabsTrigger
                key={value}
                value={value}
                className={`min-h-12 gap-2 rounded-lg border px-2 text-xs font-semibold transition-colors sm:text-sm ${color}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
            المرحلة {activeIndex + 1} من {tabs.length}:{" "}
            <span className="font-semibold text-foreground">
              {tabs[activeIndex]?.label}
            </span>
          </div>
        </Tabs>
      </section>
    </main>
  );
}