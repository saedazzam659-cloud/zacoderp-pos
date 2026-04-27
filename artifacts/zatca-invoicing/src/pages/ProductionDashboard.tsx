import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Factory, BarChart3, Cog, AlertTriangle, TrendingUp, Package, Wallet,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";
import { MenuHub, type HubTile } from "@/components/MenuHub";
import { ClipboardList } from "lucide-react";

const productionHubTiles: HubTile[] = [
  { nameKey: "nav.productionDashboard", href: "/production",           icon: BarChart3,     tone: "violet",  permKey: "production" },
  { nameKey: "nav.productionOrders",    href: "/production/orders",    icon: ClipboardList, tone: "indigo",  permKey: "production" },
  { nameKey: "nav.productionResources", href: "/production/resources", icon: Cog,           tone: "amber",   permKey: "production" },
];

const API = import.meta.env.VITE_API_URL || "";

type Dashboard = {
  totalOrders: number;
  byStatus: Record<string, number>;
  totalPlanned: number;
  totalProduced: number;
  totalWaste: number;
  totalCost: number;
  completionRate: number;
  wasteRate: number;
  totalResources: number;
  resourcesByStatus: Record<string, number>;
  machineUtilization: number;
};

const ALL_STATUSES = [
  "draft",
  "approved",
  "in_production",
  "quality_check",
  "completed",
  "cancelled",
] as const;

export default function ProductionDashboard() {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Module landing tiles (Odoo-style) */}
      <MenuHub
        title={t("production.dashboard")}
        subtitle={t("production.subtitle")}
        icon={Factory}
        headerTone="violet"
        tiles={productionHubTiles}
        variant="compact"
      />

      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
          <Factory className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t("production.dashboard")}</h1>
          <p className="text-sm text-slate-500">{t("production.subtitle")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi
              icon={<Package className="h-5 w-5" />}
              label={t("production.totalOrders")}
              value={data?.totalOrders ?? 0}
              tone="violet"
              loading={loading && !data}
            />
            <Kpi
              icon={<TrendingUp className="h-5 w-5" />}
              label={t("production.completionRate")}
              value={`${data?.completionRate ?? 0}%`}
              tone="emerald"
              loading={loading && !data}
            />
            <Kpi
              icon={<AlertTriangle className="h-5 w-5" />}
              label={t("production.wasteRate")}
              value={`${data?.wasteRate ?? 0}%`}
              tone="amber"
              loading={loading && !data}
            />
            <Kpi
              icon={<Wallet className="h-5 w-5" />}
              label={t("production.totalCost")}
              value={(data?.totalCost ?? 0).toLocaleString()}
              tone="indigo"
              loading={loading && !data}
            />
          </div>

          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
            <div className="mb-3 flex items-center gap-2 font-semibold">
              <BarChart3 className="h-4 w-4" /> {t("production.ordersByStatus")}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {ALL_STATUSES.map((s) => {
                const count = data?.byStatus?.[s] ?? 0;
                const total = data?.totalOrders ?? 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={s} className="rounded-md border p-3 dark:border-slate-700">
                    <div className="text-xs text-slate-500">{t(`production.status_${s}`)}</div>
                    <div className="mt-1 flex items-end justify-between">
                      <div className="text-xl font-bold">{count}</div>
                      <div className="text-xs text-slate-400">{pct}%</div>
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-1.5 rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
            <div className="mb-3 flex items-center gap-2 font-semibold">
              <Cog className="h-4 w-4" /> {t("production.totalResources")} ·
              <span className="text-sm font-normal text-slate-500">
                {t("production.machineUtilization")}: {data?.machineUtilization ?? 0}%
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              {(["available", "busy", "maintenance", "offline"] as const).map((s) => (
                <div key={s} className="rounded-md border p-3 dark:border-slate-700">
                  <div className="text-xs text-slate-500">{t(`production.resourceStatus_${s}`)}</div>
                  <div className="text-xl font-bold mt-1">
                    {data?.resourcesByStatus?.[s] ?? 0}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <ProductionAIAssistant
            screenContext="production.dashboard"
            currentAction="reviewing production KPIs"
          />
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon, label, value, tone, loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone: "violet" | "emerald" | "amber" | "indigo";
  loading?: boolean;
}) {
  const toneCls: Record<typeof tone, string> = {
    violet: "from-violet-500 to-fuchsia-500",
    emerald: "from-emerald-500 to-teal-500",
    amber: "from-amber-500 to-orange-500",
    indigo: "from-indigo-500 to-blue-500",
  };
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">{label}</div>
          <div className="text-2xl font-bold mt-1">
            {loading ? <Skeleton className="h-7 w-16" /> : value}
          </div>
        </div>
        <div className={`rounded-lg bg-gradient-to-br ${toneCls[tone]} p-2 text-white`}>
          {icon}
        </div>
      </div>
    </div>
  );
}
