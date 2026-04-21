import { Link } from "wouter";
import {
  ChevronLeft, FileText, Wallet, AlertTriangle, Users, Package,
  CalendarRange, TrendingUp, RotateCcw, Receipt,
} from "lucide-react";

const REPORTS = [
  {
    href: "/sales/reports/customer-statement",
    title: "كشف حساب عميل",
    desc: "حركة عميل تفصيلية مع الرصيد الافتتاحي والتراكمي",
    icon: FileText,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/sales/reports/customer-balances",
    title: "أرصدة العملاء",
    desc: "ملخص أرصدة جميع العملاء (مدين/دائن)",
    icon: Wallet,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/sales/reports/aging",
    title: "تحليل أعمار الديون",
    desc: "توزيع المديونية على فترات (30/60/90 يوم وأكثر)",
    icon: AlertTriangle,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/sales/reports/sales-by-customer",
    title: "المبيعات حسب العميل",
    desc: "إجمالي المبيعات والمرتجعات والمحصل لكل عميل",
    icon: Users,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/sales/reports/sales-by-item",
    title: "المبيعات حسب الصنف",
    desc: "إجمالي مبيعات كل صنف بالكمية والقيمة",
    icon: Package,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
  },
  {
    href: "/sales/reports/sales-by-period",
    title: "المبيعات اليومية / الشهرية",
    desc: "ملخص المبيعات وضريبة القيمة المضافة عبر الزمن",
    icon: CalendarRange,
    color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  },
  {
    href: "/sales/reports/top-customers",
    title: "أفضل العملاء",
    desc: "ترتيب أعلى العملاء قيمةً خلال الفترة المحددة",
    icon: TrendingUp,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
  {
    href: "/sales/reports/returns",
    title: "تقرير مرتجعات المبيعات",
    desc: "ملخص مرتجعات المبيعات لكل عميل",
    icon: RotateCcw,
    color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200",
  },
];

export default function SalesReportsHub() {
  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Receipt className="h-6 w-6 text-primary" /> تقارير العملاء والمبيعات
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          مجموعة شاملة من تقارير العملاء والمبيعات مع إمكانية التصدير لـ Excel و PDF والطباعة
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
              </div>
              <h3 className="text-base font-bold mb-1.5">{r.title}</h3>
              <p className="text-xs opacity-80 leading-relaxed">{r.desc}</p>
            </a>
          </Link>
        ))}
      </div>
    </div>
  );
}
