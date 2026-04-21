import { Link } from "wouter";
import {
  ChevronLeft, FileText, Wallet, AlertTriangle, Truck, Package,
  CalendarRange, TrendingUp, RotateCcw, ShoppingCart,
} from "lucide-react";

const REPORTS = [
  {
    href: "/purchasing/reports/supplier-statement",
    title: "كشف حساب مورد",
    desc: "حركة مورد تفصيلية مع الرصيد الافتتاحي والتراكمي",
    icon: FileText,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/purchasing/reports/supplier-balances",
    title: "أرصدة الموردين",
    desc: "ملخص أرصدة جميع الموردين (مدين/دائن)",
    icon: Wallet,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/purchasing/reports/aging",
    title: "أعمار الذمم الدائنة",
    desc: "توزيع المستحقات للموردين على فترات (30/60/90 يوم وأكثر)",
    icon: AlertTriangle,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/purchasing/reports/purchases-by-supplier",
    title: "المشتريات حسب المورد",
    desc: "إجمالي المشتريات والمرتجعات والمدفوع لكل مورد",
    icon: Truck,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/purchasing/reports/purchases-by-item",
    title: "المشتريات حسب الصنف",
    desc: "إجمالي مشتريات كل صنف بالكمية والقيمة",
    icon: Package,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
  },
  {
    href: "/purchasing/reports/purchases-by-period",
    title: "المشتريات اليومية / الشهرية",
    desc: "ملخص المشتريات وضريبة المدخلات عبر الزمن",
    icon: CalendarRange,
    color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  },
  {
    href: "/purchasing/reports/top-suppliers",
    title: "أكبر الموردين",
    desc: "ترتيب أعلى الموردين قيمةً خلال الفترة المحددة",
    icon: TrendingUp,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
  {
    href: "/purchasing/reports/returns",
    title: "تقرير مرتجعات المشتريات",
    desc: "ملخص مرتجعات المشتريات لكل مورد",
    icon: RotateCcw,
    color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200",
  },
];

export default function PurchaseReportsHub() {
  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShoppingCart className="h-6 w-6 text-primary" /> تقارير الموردين والمشتريات
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          مجموعة شاملة من تقارير الموردين والمشتريات مع إمكانية التصدير لـ Excel و PDF والطباعة
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
