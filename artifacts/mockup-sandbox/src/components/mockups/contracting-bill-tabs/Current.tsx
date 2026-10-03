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
  { value: "metadata", label: "بيانات المستخلص", icon: Briefcase },
  { value: "execution", label: "بنود التنفيذ", icon: FileSpreadsheet },
  { value: "adjustments", label: "الإضافات والخصومات", icon: Plus },
  { value: "payments", label: "الدفعات والاستقطاعات", icon: Wallet },
  { value: "summary", label: "الملخص النهائي", icon: TrendingUp },
];

export function Current() {
  const [activeTab, setActiveTab] = useState("metadata");

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
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1 sm:grid-cols-3 xl:grid-cols-5">
            {tabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="min-h-11 gap-2 px-2 text-xs sm:text-sm"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
            المرحلة المحددة:{" "}
            <span className="font-semibold text-foreground">
              {tabs.find((tab) => tab.value === activeTab)?.label}
            </span>
          </div>
        </Tabs>
      </section>
    </main>
  );
}