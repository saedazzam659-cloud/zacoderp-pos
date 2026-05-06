import { useTranslation } from "react-i18next";
import {
  Truck, Users, CreditCard, ClipboardList, ShoppingCart,
  RotateCcw, Banknote, BarChart2, Package,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.suppliers",            href: "/suppliers",                  icon: Truck,         tone: "orange",  permKey: "suppliers" },
  { nameKey: "nav.supplierGroups",       href: "/purchasing/supplier-groups", icon: Users,         tone: "blue",    permKey: "suppliers" },
  { nameKey: "nav.lc",                   href: "/purchasing/lc",              icon: CreditCard,    tone: "fuchsia", permKey: "purchase_invoices" },
  { nameKey: "nav.lcExpenseEntry",       href: "/purchasing/lc-expense-entry",icon: CreditCard,    tone: "amber",   permKey: "purchase_invoices" },
  { nameKey: "nav.purchaseOrders",       href: "/purchasing/orders",          icon: ClipboardList, tone: "indigo",  permKey: "purchase_invoices" },
  { nameKey: "nav.purchaseInvoices",     href: "/purchasing/invoices",        icon: ShoppingCart,  tone: "amber",   permKey: "purchase_invoices" },
  { nameKey: "nav.purchaseReturns",      href: "/purchasing/returns",         icon: RotateCcw,     tone: "rose",    permKey: "purchase_returns" },
  { nameKey: "nav.supplierSettlements",  href: "/purchasing/settlements",     icon: Banknote,      tone: "emerald", permKey: "supplier_settlements" },
  { nameKey: "navExtra.purchaseReportsGroup", href: "/purchasing/reports",    icon: BarChart2,     tone: "slate",   permKey: "purchase_invoices" },
];

export default function PurchasingHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.purchasingGroup")}
      subtitle={t("hub.purchasingSubtitle")}
      icon={Package}
      headerTone="orange"
      tiles={tiles}
    />
  );
}
