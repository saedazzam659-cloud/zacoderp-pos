/**
 * Onboarding Wizard — "ابدأ هنا"
 *
 * Self-detecting checklist that walks a brand-new tenant through the bare
 * minimum needed to start issuing ZATCA-compliant invoices. Each step
 * queries an existing endpoint to decide whether it's already done; the
 * UI then highlights the next pending step and provides a one-click
 * "اذهب للصفحة" button.
 *
 * No new server endpoints needed — everything reuses existing GETs.
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Building2, MapPin, Warehouse, ShieldCheck, Users, Package,
  FileText, CheckCircle2, ArrowLeft, Sparkles, Circle,
} from "lucide-react";

interface StepState {
  done: boolean;
  detail?: string;
}

function useStep<T>(url: string, predicate: (data: T) => StepState): StepState {
  const { data, isLoading, isError } = useQuery<T>({
    queryKey: ["onboarding", url],
    queryFn: () => fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    retry: false,
    staleTime: 30_000,
  });
  if (isLoading) return { done: false, detail: "جاري التحقق..." };
  if (isError || !data)  return { done: false };
  return predicate(data);
}

interface ApiCompany { vatNumber?: string | null; crNumber?: string | null; nameAr?: string | null }
interface ApiBranches { branches?: unknown[] }
interface ApiWarehouses { warehouses?: unknown[] }
interface ApiCustomers { customers?: unknown[] }
interface ApiItems { items?: unknown[] }
interface ApiInvoices { invoices?: unknown[] }
interface ApiZatcaStatus { hasCsid?: boolean; environment?: string }

export default function Onboarding() {
  // Each step queries a real endpoint. Anything that returns a non-2xx
  // is treated as "not done yet" so brand-new tenants don't see scary
  // errors before they've even started.
  const company   = useStep<ApiCompany>("/api/companies/me", d => ({
    done: !!(d.vatNumber && d.crNumber),
    detail: d.nameAr ? `${d.nameAr}` : undefined,
  }));
  const branches  = useStep<ApiBranches>("/api/org/branches", d => ({
    done: (d.branches?.length ?? 0) > 0,
    detail: d.branches?.length ? `${d.branches.length} فرع` : undefined,
  }));
  const warehouses = useStep<ApiWarehouses>("/api/inventory/warehouses", d => ({
    done: (d.warehouses?.length ?? 0) > 0,
    detail: d.warehouses?.length ? `${d.warehouses.length} مخزن` : undefined,
  }));
  const zatca     = useStep<ApiZatcaStatus>("/api/zatca/csid-status", d => ({
    done: !!d.hasCsid,
    detail: d.environment ? (d.environment === "production" ? "بيئة الإنتاج" : "بيئة التجربة") : undefined,
  }));
  const customers = useStep<ApiCustomers>("/api/customers", d => ({
    done: (d.customers?.length ?? 0) > 0,
    detail: d.customers?.length ? `${d.customers.length} عميل` : undefined,
  }));
  const items     = useStep<ApiItems>("/api/inventory/items?includeHidden=1", d => ({
    done: (d.items?.length ?? 0) > 0,
    detail: d.items?.length ? `${d.items.length} صنف` : undefined,
  }));
  const invoices  = useStep<ApiInvoices>("/api/sales/invoices", d => ({
    done: (d.invoices?.length ?? 0) > 0,
    detail: d.invoices?.length ? `${d.invoices.length} فاتورة` : undefined,
  }));

  const STEPS = [
    {
      n: 1, key: "company",
      title: "بيانات الشركة",
      desc: "أكمل الرقم الضريبي والسجل التجاري وبيانات العنوان",
      href: "/general-settings",
      icon: Building2,
      gradient: "from-emerald-500 to-teal-600",
      state: company,
    },
    {
      n: 2, key: "branches",
      title: "إعداد الفروع",
      desc: "أنشئ على الأقل فرعاً واحداً لشركتك",
      href: "/org/branches",
      icon: MapPin,
      gradient: "from-blue-500 to-cyan-600",
      state: branches,
    },
    {
      n: 3, key: "warehouses",
      title: "المخازن",
      desc: "أضف مخازنك (للأصناف القابلة للتخزين)",
      href: "/inventory/warehouses",
      icon: Warehouse,
      gradient: "from-amber-500 to-orange-600",
      state: warehouses,
    },
    {
      n: 4, key: "zatca",
      title: "شهادة زاتكا (CSID)",
      desc: "ربط حسابك مع زاتكا بشهادة التشفير — مطلوب لإرسال الفواتير",
      href: "/zatca",
      icon: ShieldCheck,
      gradient: "from-purple-500 to-pink-600",
      state: zatca,
      critical: true,
    },
    {
      n: 5, key: "customers",
      title: "أول عميل",
      desc: "أنشئ سجلاً واحداً على الأقل لعميل (للفاتورة B2B)",
      href: "/customers",
      icon: Users,
      gradient: "from-rose-500 to-red-600",
      state: customers,
    },
    {
      n: 6, key: "items",
      title: "الأصناف / المنتجات",
      desc: "أضف أصناف منتجاتك بالأسعار وضريبة القيمة المضافة",
      href: "/inventory/items",
      icon: Package,
      gradient: "from-indigo-500 to-violet-600",
      state: items,
    },
    {
      n: 7, key: "invoices",
      title: "أول فاتورة",
      desc: "جهّز فاتورتك الأولى — ستُرسل لزاتكا تلقائياً بعد الاعتماد",
      href: "/sales/invoices/new",
      icon: FileText,
      gradient: "from-green-500 to-emerald-600",
      state: invoices,
    },
  ] as const;

  const doneCount = STEPS.filter(s => s.state.done).length;
  const totalCount = STEPS.length;
  const pct = Math.round((doneCount / totalCount) * 100);
  const allDone = doneCount === totalCount;
  const nextStepN = STEPS.find(s => !s.state.done)?.n ?? null;

  return (
    <div dir="rtl" className="max-w-5xl mx-auto p-4 md:p-8 space-y-6">
      {/* Header */}
      <div className="text-center space-y-3 py-6">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30">
          <Sparkles className="h-8 w-8" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-slate-100">
          {allDone ? "🎉 أنت جاهز للعمل!" : "ابدأ هنا"}
        </h1>
        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          {allDone
            ? "أكملت كل الإعدادات الأساسية. يمكنك الآن إصدار الفواتير وإرسالها لزاتكا بدون قلق."
            : "خطوات بسيطة لتجهيز حسابك خلال دقائق وتبدأ في إصدار فواتير زاتكا الإلكترونية."}
        </p>
      </div>

      {/* Progress bar */}
      <Card className="p-6 bg-gradient-to-br from-slate-50 to-white dark:from-slate-900 dark:to-slate-800 border-2">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm text-slate-600 dark:text-slate-400">تقدّم الإعداد</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              {doneCount} <span className="text-lg font-normal text-slate-500">من {totalCount}</span>
            </div>
          </div>
          <div className={`text-3xl font-bold ${allDone ? "text-emerald-600" : "text-blue-600"}`}>
            {pct}%
          </div>
        </div>
        <Progress value={pct} className="h-3" />
        {!allDone && nextStepN && (
          <p className="text-xs text-slate-500 mt-3">
            الخطوة التالية: <span className="font-semibold text-slate-700 dark:text-slate-300">
              {STEPS.find(s => s.n === nextStepN)?.title}
            </span>
          </p>
        )}
      </Card>

      {/* Steps */}
      <div className="space-y-3">
        {STEPS.map(step => {
          const Icon = step.icon;
          const isNext = step.n === nextStepN;
          const isDone = step.state.done;
          return (
            <Card
              key={step.key}
              className={`relative p-5 transition-all overflow-hidden ${
                isDone
                  ? "bg-gradient-to-r from-emerald-50/50 to-white dark:from-emerald-950/20 dark:to-slate-900 border-emerald-200 dark:border-emerald-900"
                  : isNext
                    ? "border-2 border-blue-400 dark:border-blue-600 shadow-lg shadow-blue-100 dark:shadow-blue-900/20"
                    : "opacity-90 hover:opacity-100"
              }`}
            >
              {isNext && !isDone && (
                <div className="absolute top-0 left-0 h-full w-1 bg-gradient-to-b from-blue-500 to-indigo-600" />
              )}
              <div className="flex items-start gap-4">
                {/* Step number / icon */}
                <div className={`shrink-0 h-14 w-14 rounded-xl flex items-center justify-center text-white shadow-md ${
                  isDone
                    ? "bg-gradient-to-br from-emerald-500 to-emerald-600"
                    : `bg-gradient-to-br ${step.gradient}`
                }`}>
                  {isDone ? <CheckCircle2 className="h-7 w-7" /> : <Icon className="h-7 w-7" />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-slate-400">خطوة {step.n}</span>
                    <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      {step.title}
                    </h3>
                    {isDone && (
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300">
                        مكتملة
                      </Badge>
                    )}
                    {isNext && !isDone && (
                      <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300">
                        التالية
                      </Badge>
                    )}
                    {(step as { critical?: boolean }).critical && !isDone && (
                      <Badge variant="destructive" className="bg-red-100 text-red-700 hover:bg-red-100">
                        مهمة
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {step.desc}
                  </p>
                  {step.state.detail && (
                    <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
                      <Circle className="h-2 w-2 fill-current" />
                      {step.state.detail}
                    </p>
                  )}
                </div>

                {/* CTA */}
                <div className="shrink-0 flex items-center">
                  <Link href={step.href}>
                    <Button
                      variant={isDone ? "outline" : isNext ? "default" : "ghost"}
                      size="sm"
                      className={isNext && !isDone ? "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white border-0" : ""}
                    >
                      {isDone ? "تعديل" : isNext ? "ابدأ الآن" : "اذهب"}
                      <ArrowLeft className="h-4 w-4 mr-1.5 rtl:rotate-180" />
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Bottom CTA */}
      {allDone ? (
        <Card className="p-8 text-center bg-gradient-to-br from-emerald-500 to-teal-600 text-white border-0 shadow-xl shadow-emerald-500/20">
          <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-90" />
          <h2 className="text-2xl font-bold mb-2">كل شيء جاهز ✨</h2>
          <p className="opacity-90 mb-4">يمكنك الآن استخدام النظام بكامل إمكانياته.</p>
          <Link href="/">
            <Button variant="secondary" size="lg" className="bg-white text-emerald-700 hover:bg-slate-50">
              اذهب للوحة التحكم
              <ArrowLeft className="h-4 w-4 mr-1.5 rtl:rotate-180" />
            </Button>
          </Link>
        </Card>
      ) : (
        <Card className="p-5 bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900">
          <div className="flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
            <div className="text-sm text-slate-700 dark:text-slate-300">
              <p className="font-semibold mb-1">نصيحة:</p>
              <p className="text-slate-600 dark:text-slate-400">
                لا يلزم أن تكمل كل الخطوات الآن. يمكنك العودة في أي وقت من خلال
                <span className="font-semibold mx-1">القائمة الجانبية → ابدأ هنا</span>.
                الخطوات المهمة (المُعلَّمة بشارة حمراء) ضرورية لإرسال الفواتير لزاتكا.
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
