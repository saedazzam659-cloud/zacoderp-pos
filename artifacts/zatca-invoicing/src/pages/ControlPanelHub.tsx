import { useTranslation } from "react-i18next";
import {
  MapPin, Building2, Link2, Sliders, Users, DollarSign,
  BookMarked, Database, ListOrdered, FileText, BarChart3, ScrollText,
  LayoutDashboard, BadgeCheck,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.regions",            href: "/org/regions",                  icon: MapPin,      tone: "emerald", permKey: "regions" },
  { nameKey: "nav.branches",           href: "/org/branches",                 icon: Building2,   tone: "sky",     permKey: "branches" },
  { nameKey: "nav.zatcaLink",          href: "/zatca",                        icon: Link2,       tone: "violet",  permKey: "zatca_setup" },
  { nameKey: "nav.generalSettings",    href: "/general-settings",             icon: Sliders,     tone: "slate",   permKey: "general_settings" },
  { nameKey: "nav.companyProfile",     href: "/company-profile",              icon: BadgeCheck,  tone: "emerald", permKey: "company_profile" },
  { nameKey: "nav.users",              href: "/users",                        icon: Users,       tone: "blue",    permKey: "users", requireAdmin: true },
  { nameKey: "nav.currencies",         href: "/settings/currencies",          icon: DollarSign,  tone: "amber",   permKey: "currencies" },
  { nameKey: "nav.accountingMappings", href: "/settings/accounting-mappings", icon: BookMarked,  tone: "indigo",  permKey: "general_settings" },
  { nameKey: "nav.dataIo",             href: "/settings/data-io",             icon: Database,    tone: "teal",    permKey: "data_io" },
  { nameKey: "nav.sequences",          href: "/settings/sequences",           icon: ListOrdered, tone: "fuchsia", permKey: "sequences", requireAdmin: true },
  { nameKey: "nav.invoices",           href: "/invoices",                     icon: FileText,    tone: "rose",    permKey: "sales_invoices" },
  { nameKey: "nav.vatDeclaration",     href: "/vat-declaration",              icon: BarChart3,   tone: "cyan",    permKey: "vat_declaration" },
  { nameKey: "nav.auditLog",           href: "/admin/audit-log",              icon: ScrollText,  tone: "orange",  requireAdmin: true },
];

export default function ControlPanelHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.dashboardGroup")}
      subtitle={t("hub.controlPanelSubtitle")}
      icon={LayoutDashboard}
      headerTone="indigo"
      tiles={tiles}
    />
  );
}
