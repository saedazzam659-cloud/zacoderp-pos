import { useTranslation } from "react-i18next";
import {
  Wallet, Landmark, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight,
  BarChart2,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.cashBoxes",       href: "/cash/boxes",            icon: Wallet,          tone: "emerald", permKey: "cash_boxes" },
  { nameKey: "nav.banks",           href: "/cash/banks",            icon: Landmark,        tone: "sky",     permKey: "bank_accounts" },
  { nameKey: "nav.receiptVouchers", href: "/cash/receipt-vouchers", icon: ArrowDownCircle, tone: "teal",    permKey: "receipt_vouchers" },
  { nameKey: "nav.paymentVouchers", href: "/cash/payment-vouchers", icon: ArrowUpCircle,   tone: "rose",    permKey: "payment_vouchers" },
  { nameKey: "nav.transfers",       href: "/cash/transfers",        icon: ArrowLeftRight,  tone: "violet",  permKey: "cash_boxes" },
  { nameKey: "nav.cashReports",     href: "/cash/reports",          icon: BarChart2,       tone: "slate",   permKey: "cash_boxes" },
];

export default function CashHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.cashGroup")}
      subtitle={t("hub.cashSubtitle")}
      icon={Wallet}
      headerTone="emerald"
      tiles={tiles}
    />
  );
}
