import { useTranslation } from "react-i18next";
import {
  Stethoscope, Building2, UserSquare2, CalendarRange, FileText, Sparkles,
  HeartPulse,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.hospitals",           href: "/hospital/hospitals",     icon: Building2,     tone: "sky",     permKey: "hospital" },
  { nameKey: "nav.hospitalDoctors",     href: "/hospital/doctors",       icon: HeartPulse,    tone: "emerald", permKey: "hospital" },
  { nameKey: "nav.hospitalPatients",    href: "/hospital/patients",      icon: UserSquare2,   tone: "indigo",  permKey: "hospital" },
  { nameKey: "nav.hospitalAppointments",href: "/hospital/appointments",  icon: CalendarRange, tone: "violet",  permKey: "hospital" },
  { nameKey: "nav.hospitalInvoices",    href: "/hospital/invoices",      icon: FileText,      tone: "amber",   permKey: "hospital" },
  { nameKey: "nav.hospitalAI",          href: "/hospital/ai",            icon: Sparkles,      tone: "rose",    permKey: "hospital" },
];

export default function HospitalHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.hospitalGroup")}
      subtitle={t("hub.hospitalSubtitle")}
      icon={Stethoscope}
      headerTone="sky"
      tiles={tiles}
    />
  );
}
