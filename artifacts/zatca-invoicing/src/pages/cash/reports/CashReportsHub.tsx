import { Link } from "wouter";
import {
  ChevronLeft, Wallet, Landmark, FileText, Banknote,
  ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, CalendarRange,
} from "lucide-react";

const REPORTS = [
  {
    href: "/cash/reports/cash-balances",
    title: "أرصدة الخزائن",
    desc: "أرصدة جميع الخزائن النقدية بتاريخ محدد",
    icon: Wallet,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/cash/reports/bank-balances",
    title: "أرصدة البنوك",
    desc: "أرصدة جميع الحسابات البنكية بتاريخ محدد",
    icon: Landmark,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/cash/reports/cash-box-statement",
    title: "كشف حساب خزينة",
    desc: "حركة خزينة تفصيلية مع الرصيد الافتتاحي والتراكمي",
    icon: FileText,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/cash/reports/bank-statement",
    title: "كشف حساب بنكي",
    desc: "حركة حساب بنكي تفصيلية مع الرصيد الافتتاحي والتراكمي",
    icon: Banknote,
    color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  },
  {
    href: "/cash/reports/daily-summary",
    title: "الحركة اليومية للنقدية",
    desc: "ملخص يومي لإجمالي المقبوضات والمدفوعات وصافي التدفق",
    icon: CalendarRange,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
  },
  {
    href: "/cash/reports/receipts",
    title: "تقرير سندات القبض",
    desc: "قائمة بكل سندات القبض المعتمدة مع الفلاتر والتصدير",
    icon: ArrowDownCircle,
    color: "from-green-50 to-green-100/40 text-green-700 border-green-200",
  },
  {
    href: "/cash/reports/payments",
    title: "تقرير سندات الصرف",
    desc: "قائمة بكل سندات الصرف المعتمدة مع الفلاتر والتصدير",
    icon: ArrowUpCircle,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
  {
    href: "/cash/reports/transfers",
    title: "تقرير التحويلات",
    desc: "قائمة بكل التحويلات بين الخزائن والبنوك",
    icon: ArrowLeftRight,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
];

export default function CashReportsHub() {
  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wallet className="h-6 w-6 text-primary" /> تقارير النقد والبنوك
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          مجموعة شاملة من تقارير النقدية والبنوك مع إمكانية التصدير لـ Excel و PDF والطباعة
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href} className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
            <div className="flex items-start justify-between mb-3">
              <r.icon className="h-7 w-7" />
              <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
            </div>
            <h3 className="text-base font-bold mb-1.5">{r.title}</h3>
            <p className="text-xs opacity-80 leading-relaxed">{r.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
