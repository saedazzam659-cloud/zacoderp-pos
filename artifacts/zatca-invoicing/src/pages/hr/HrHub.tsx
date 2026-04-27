import { useTranslation } from "react-i18next";
import {
  UserCog, FileSignature, CalendarRange, ScanFace, Wallet,
  Banknote, Scale, Calculator, BarChart3, Settings, Users,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.hrEmployeesList", href: "/hr/employees",      icon: UserCog,        tone: "blue",    permKey: "hr_employees" },
  { nameKey: "nav.hrContracts",     href: "/hr/contracts",      icon: FileSignature,  tone: "indigo",  permKey: "hr_employees" },
  { nameKey: "nav.hrAttendance",    href: "/hr/attendance",     icon: CalendarRange,  tone: "emerald", permKey: "hr_attendance" },
  { nameKey: "nav.hrFaceAttendance",href: "/hr/face",           icon: ScanFace,       tone: "violet",  permKey: "hr_face_attendance" },
  { nameKey: "nav.hrLoans",         href: "/hr/loans",          icon: Wallet,         tone: "amber",   permKey: "hr_loans" },
  { nameKey: "nav.hrPayroll",       href: "/hr/payroll",        icon: Banknote,       tone: "teal",    permKey: "hr_payroll" },
  { nameKey: "nav.hrEos",           href: "/hr/end-of-service", icon: Scale,          tone: "rose",    permKey: "hr_eos" },
  { nameKey: "nav.hrCalculators",   href: "/hr/calculators",    icon: Calculator,     tone: "fuchsia", permKey: "hr_calculators" },
  { nameKey: "nav.hrReports",       href: "/hr/reports",        icon: BarChart3,      tone: "sky",     permKey: "hr_employees" },
  { nameKey: "nav.hrSettings",      href: "/hr/settings",       icon: Settings,       tone: "slate",   permKey: "hr_settings" },
];

export default function HrHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.hrEmployees")}
      subtitle={t("hub.hrSubtitle")}
      icon={Users}
      headerTone="blue"
      tiles={tiles}
    />
  );
}
