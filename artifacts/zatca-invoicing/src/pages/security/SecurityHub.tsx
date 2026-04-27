import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ShieldAlert, ListChecks, BarChart3, AlertOctagon, Activity, ClipboardList,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";
import { Card, CardContent } from "@/components/ui/card";
import { securityEventsApi, type SecuritySummary } from "@/lib/securityEventsApi";

const tiles: HubTile[] = [
  { nameKey: "security.tiles.events",   href: "/security/events",   icon: ListChecks,  tone: "rose",    permKey: "security_events" },
  { nameKey: "security.tiles.openOnly", href: "/security/events?status=open", icon: AlertOctagon, tone: "orange", permKey: "security_events" },
  { nameKey: "security.tiles.investigating", href: "/security/events?status=investigating", icon: Activity, tone: "amber", permKey: "security_events" },
  { nameKey: "security.tiles.history",  href: "/security/events?status=closed", icon: ClipboardList, tone: "slate",   permKey: "security_events" },
];

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card className={`${tone} border-0`}>
      <CardContent className="p-4 text-center">
        <div className="text-3xl font-bold">{value}</div>
        <div className="text-xs mt-1 opacity-90">{label}</div>
      </CardContent>
    </Card>
  );
}

export default function SecurityHub() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SecuritySummary | null>(null);

  useEffect(() => {
    securityEventsApi.summary().then(setSummary).catch(() => setSummary(null));
  }, []);

  return (
    <div className="space-y-6">
      <MenuHub
        title={t("security.title")}
        subtitle={t("security.subtitle")}
        icon={ShieldAlert}
        headerTone="rose"
        tiles={tiles}
      />
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label={t("security.stats.total")} value={summary.totals.total} tone="bg-slate-100 text-slate-900" />
          <StatCard label={t("security.stats.open")} value={summary.totals.open} tone="bg-rose-100 text-rose-900" />
          <StatCard label={t("security.stats.investigating")} value={summary.totals.investigating} tone="bg-amber-100 text-amber-900" />
          <StatCard label={t("security.stats.closed")} value={summary.totals.closed} tone="bg-emerald-100 text-emerald-900" />
          <StatCard label={t("security.stats.falsePositive")} value={summary.totals.falsePositive} tone="bg-slate-100 text-slate-900" />
        </div>
      )}
    </div>
  );
}
