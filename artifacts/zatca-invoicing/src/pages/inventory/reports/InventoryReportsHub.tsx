import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  BarChart2, BookOpen, IdCard, AlertTriangle, Wallet, Hourglass, ChevronLeft, Bell, ArrowLeftRight,
  Gift, ReceiptText, ClipboardCheck, Layers3, CalendarClock, Shirt, Package, RotateCcw,
} from "lucide-react";
import { usePermission } from "@/hooks/usePermission";
import { companyAllowsMenuModuleKey } from "@/lib/companyModuleGate";

export const INVENTORY_REPORTS = [
  {
    href: "/inventory/reports/batches",
    key: "batches",
    icon: Layers3,
    color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  },
  {
    href: "/inventory/reports/expiry",
    key: "expiry",
    icon: CalendarClock,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/inventory/reports/stock-balance",
    key: "stockBalance",
    icon: BarChart2,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/inventory/reports/clothing-stock",
    key: "clothingStock",
    icon: Shirt,
    color: "from-green-50 to-green-100/40 text-green-800 border-green-200",
  },
  {
    href: "/inventory/reports/clothing-sales",
    key: "clothingSales",
    icon: ReceiptText,
    color: "from-teal-50 to-teal-100/40 text-teal-800 border-teal-200",
  },
  {
    href: "/inventory/reports/clothing-purchases",
    key: "clothingPurchases",
    icon: Package,
    color: "from-blue-50 to-blue-100/40 text-blue-800 border-blue-200",
  },
  {
    href: "/inventory/reports/clothing-purchase-returns",
    key: "clothingPurchaseReturns",
    icon: RotateCcw,
    color: "from-orange-50 to-orange-100/40 text-orange-800 border-orange-200",
  },
  {
    href: "/inventory/reports/clothing-net-purchases",
    key: "clothingVariantNetPurchases",
    icon: ArrowLeftRight,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-800 border-indigo-200",
  },
  {
    href: "/inventory/reports/clothing-slow-moving",
    key: "clothingSlowMoving",
    icon: Hourglass,
    color: "from-rose-50 to-rose-100/40 text-rose-800 border-rose-200",
  },
  {
    href: "/inventory/reports/stock-ledger",
    key: "stockLedger",
    icon: BookOpen,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/inventory/reports/item-card",
    key: "itemCard",
    icon: IdCard,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/inventory/reports/low-stock",
    key: "lowStock",
    icon: AlertTriangle,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/inventory/reports/valuation",
    key: "valuation",
    icon: Wallet,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
  },
  {
    href: "/inventory/reports/slow-moving",
    key: "slowMoving",
    icon: Hourglass,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
  {
    href: "/inventory/alerts",
    key: "smartAlerts",
    icon: Bell,
    color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200",
  },
  {
    href: "/inventory/reports/free-quantities",
    key: "freeQuantities",
    icon: Gift,
    color: "from-pink-50 to-pink-100/40 text-pink-700 border-pink-200",
  },
  {
    href: "/inventory/reports/item-sales-valuation",
    key: "itemSalesValuation",
    icon: ReceiptText,
    color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200",
  },
  {
    href: "/inventory/reports/stocktake",
    key: "stocktake",
    icon: ClipboardCheck,
    color: "from-violet-50 to-violet-100/40 text-violet-700 border-violet-200",
  },
];

export default function InventoryReportsHub() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth() as any;
  const canViewSmartAlerts = usePermission("items", "view");
  const canViewClothing = companyAllowsMenuModuleKey(user?.company?.menuPermissions, "clothing");
  const isRtl = i18n.language === "ar";
  const visibleReports = INVENTORY_REPORTS.filter(
    report => report.href !== "/inventory/alerts" || canViewSmartAlerts,
  ).filter(report => !report.key.startsWith("clothing") || canViewClothing);
  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart2 className="h-6 w-6 text-primary" /> {t("inventoryReports.hub.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("inventoryReports.hub.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleReports.map(r => (
          <Link key={r.href} href={r.href} data-testid={`link-report-${r.key}`} className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
            <div className="flex items-start justify-between mb-3">
              <r.icon className="h-7 w-7" />
              <ChevronLeft className={`h-4 w-4 opacity-40 group-hover:opacity-100 transition-all ${isRtl ? "group-hover:-translate-x-1" : "rotate-180 group-hover:translate-x-1"}`} />
            </div>
            <h3 className="text-base font-bold mb-1.5">{t(`inventoryReports.hub.${r.key}Title`)}</h3>
            <p className="text-xs opacity-80 leading-relaxed">{t(`inventoryReports.hub.${r.key}Desc`)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
