import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft, ChevronRight, FileText, Wallet, AlertTriangle, Truck, Package,
  CalendarRange, TrendingUp, RotateCcw, ShoppingCart, CreditCard,
} from "lucide-react";

export default function PurchaseReportsHub() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";

  const REPORTS = [
    { href: "/purchasing/reports/supplier-statement",     title: t("purchasingReports.hub.supplierStatement"),     desc: t("purchasingReports.hub.supplierStatementDesc"),     icon: FileText,       color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200" },
    { href: "/purchasing/reports/supplier-balances",      title: t("purchasingReports.hub.supplierBalances"),      desc: t("purchasingReports.hub.supplierBalancesDesc"),      icon: Wallet,         color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200" },
    { href: "/purchasing/reports/aging",                  title: t("purchasingReports.hub.agingPayables"),         desc: t("purchasingReports.hub.agingPayablesDesc"),         icon: AlertTriangle,  color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200" },
    { href: "/purchasing/reports/purchases-by-supplier",  title: t("purchasingReports.hub.purchasesBySupplier"),   desc: t("purchasingReports.hub.purchasesBySupplierDesc"),   icon: Truck,          color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200" },
    { href: "/purchasing/reports/purchases-by-item",      title: t("purchasingReports.hub.purchasesByItem"),       desc: t("purchasingReports.hub.purchasesByItemDesc"),       icon: Package,        color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200" },
    { href: "/purchasing/reports/purchases-by-period",    title: t("purchasingReports.hub.purchasesByPeriod"),     desc: t("purchasingReports.hub.purchasesByPeriodDesc"),     icon: CalendarRange,  color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200" },
    { href: "/purchasing/reports/purchases-vat-register", title: t("purchasingReports.vatRegister.title"),         desc: t("purchasingReports.vatRegister.subtitle"),         icon: FileText,       color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200" },
    { href: "/purchasing/reports/top-suppliers",          title: t("purchasingReports.hub.topSuppliers"),          desc: t("purchasingReports.hub.topSuppliersDesc"),          icon: TrendingUp,     color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200" },
    { href: "/purchasing/reports/returns",                title: t("purchasingReports.hub.purchaseReturns"),       desc: t("purchasingReports.hub.purchaseReturnsDesc"),       icon: RotateCcw,      color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200" },
    { href: "/purchasing/reports/lc-statement",           title: t("purchasingReports.hub.lcStatement"),           desc: t("purchasingReports.hub.lcStatementDesc"),           icon: CreditCard,     color: "from-fuchsia-50 to-fuchsia-100/40 text-fuchsia-700 border-fuchsia-200" },
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShoppingCart className="h-6 w-6 text-primary" /> {t("purchasingReports.hub.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("purchasingReports.hub.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                {isRtl
                  ? <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
                  : <ChevronRight className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />}
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
