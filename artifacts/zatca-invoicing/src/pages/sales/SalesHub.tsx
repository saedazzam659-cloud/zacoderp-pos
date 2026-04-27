import { useTranslation } from "react-i18next";
import {
  Users, BadgeCheck, FileSignature, ClipboardList, ShoppingBag,
  RotateCcw, ArrowDownCircle, Link2, BarChart3, BarChart2, ShoppingCart,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.customers",           href: "/customers",         icon: Users,           tone: "blue",    permKey: "customers" },
  { nameKey: "nav.salesReps",           href: "/sales/reps",        icon: BadgeCheck,      tone: "emerald", permKey: "sales_reps" },
  { nameKey: "nav.quotations",          href: "/sales/quotations",  icon: FileSignature,   tone: "violet",  permKey: "sales_quotations" },
  { nameKey: "nav.salesOrders",         href: "/sales/orders",      icon: ClipboardList,   tone: "indigo",  permKey: "sales_invoices" },
  { nameKey: "nav.salesInvoices",       href: "/sales/invoices",    icon: ShoppingBag,     tone: "amber",   permKey: "sales_invoices" },
  { nameKey: "nav.salesReturns",        href: "/sales/returns",     icon: RotateCcw,       tone: "rose",    permKey: "sales_returns" },
  { nameKey: "nav.customerSettlements", href: "/sales/settlements", icon: ArrowDownCircle, tone: "teal",    permKey: "sales_settlements" },
  { nameKey: "nav.zatcaBridge",         href: "/zatca-bridge",      icon: Link2,           tone: "cyan",    permKey: "zatca_bridge" },
  { nameKey: "nav.zatcaReport",         href: "/zatca-report",      icon: BarChart3,       tone: "sky",     permKey: "zatca_report" },
  { nameKey: "navExtra.salesReportsGroup", href: "/sales/reports",  icon: BarChart2,       tone: "slate",   permKey: "sales_reports" },
];

export default function SalesHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.salesGroup")}
      subtitle={t("hub.salesSubtitle")}
      icon={ShoppingCart}
      headerTone="amber"
      tiles={tiles}
    />
  );
}
