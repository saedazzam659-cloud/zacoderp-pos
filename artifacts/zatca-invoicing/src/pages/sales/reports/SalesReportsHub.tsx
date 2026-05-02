import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft, ChevronRight, FileText, Wallet, AlertTriangle, Users, Package,
  CalendarRange, TrendingUp, RotateCcw, Receipt, Sun, CreditCard, ListChecks,
} from "lucide-react";

export default function SalesReportsHub() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.hub.${k}`, opts) as string;
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  const REPORTS = [
    {
      href: "/sales/reports/daily",
      title: tr("dailyTitle"),
      desc: tr("dailyDesc"),
      icon: Sun,
      color: "from-yellow-50 to-yellow-100/40 text-yellow-700 border-yellow-200",
    },
    {
      href: "/sales/reports/payment-mix",
      title: tr("paymentMixTitle"),
      desc: tr("paymentMixDesc"),
      icon: CreditCard,
      color: "from-violet-50 to-fuchsia-100/40 text-violet-700 border-violet-200",
    },
    {
      href: "/sales/reports/daily-detailed",
      title: tr("dailyDetailedTitle"),
      desc: tr("dailyDetailedDesc"),
      icon: ListChecks,
      color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200",
    },
    {
      href: "/sales/reports/customer-statement",
      title: tr("customerStatementTitle"),
      desc: tr("customerStatementDesc"),
      icon: FileText,
      color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
    },
    {
      href: "/sales/reports/customer-balances",
      title: tr("customerBalancesTitle"),
      desc: tr("customerBalancesDesc"),
      icon: Wallet,
      color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
    },
    {
      href: "/sales/reports/aging",
      title: tr("agingTitle"),
      desc: tr("agingDesc"),
      icon: AlertTriangle,
      color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
    },
    {
      href: "/sales/reports/sales-by-customer",
      title: tr("salesByCustomerTitle"),
      desc: tr("salesByCustomerDesc"),
      icon: Users,
      color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
    },
    {
      href: "/sales/reports/sales-by-item",
      title: tr("salesByItemTitle"),
      desc: tr("salesByItemDesc"),
      icon: Package,
      color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
    },
    {
      href: "/sales/reports/sales-by-period",
      title: tr("salesByPeriodTitle"),
      desc: tr("salesByPeriodDesc"),
      icon: CalendarRange,
      color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
    },
    {
      href: "/sales/reports/top-customers",
      title: tr("topCustomersTitle"),
      desc: tr("topCustomersDesc"),
      icon: TrendingUp,
      color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
    },
    {
      href: "/sales/reports/returns",
      title: tr("returnsTitle"),
      desc: tr("returnsDesc"),
      icon: RotateCcw,
      color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200",
    },
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Receipt className="h-6 w-6 text-primary" /> {tr("title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {tr("subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                <ChevronIcon className={`h-4 w-4 opacity-40 group-hover:opacity-100 ${isRtl ? "group-hover:-translate-x-1" : "group-hover:translate-x-1"} transition-all`} />
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
