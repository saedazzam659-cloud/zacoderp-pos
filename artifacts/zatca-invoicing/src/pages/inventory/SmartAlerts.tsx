import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useFmt } from "@/hooks/use-fmt";
import { Bell, AlertTriangle, Hourglass, Package, ArrowLeft } from "lucide-react";

// Tiny local debounce hook — keeps SmartAlerts self-contained.
function useEffectDebounce(fn: () => void, deps: any[], delay: number) {
  useEffect(() => {
    const t = setTimeout(fn, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function SmartAlerts() {
  const { t, i18n } = useTranslation();
  const { fmtQty } = useFmt();
  const [idleDaysInput, setIdleDaysInput] = useState("90");
  // Debounced + server-clamp-aligned value used for fetching. Keeps query
  // key stable across keystrokes (200ms) and constrains to server's 1..3650
  // range so the UI can't request a value the server will rewrite.
  const [debouncedIdle, setDebouncedIdle] = useState(90);
  useEffectDebounce(() => {
    const n = Math.max(1, Math.min(3650, Number(idleDaysInput) || 90));
    setDebouncedIdle(n);
  }, [idleDaysInput], 200);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["inventory-alerts", debouncedIdle],
    queryFn: () => inventoryApi.getInventoryAlerts(debouncedIdle),
  });
  // Always show the SERVER-CLAMPED idleDays in the section header so the
  // displayed number can never diverge from what was actually queried.
  const effectiveIdleDays = data?.idleDays ?? debouncedIdle;

  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString(i18n.language === "ar" ? "ar-EG" : "en-US"); }
    catch { return iso; }
  };

  const lowStock = data?.lowStock ?? [];
  const idle = data?.idle ?? [];

  return (
    <div className="space-y-6" dir={i18n.language === "ar" ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6 text-amber-500" />
            {t("pages.alerts.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("pages.alerts.subtitle")}</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("pages.alerts.idleDaysLabel")}</Label>
            <Input
              type="number"
              min={1}
              max={3650}
              value={idleDaysInput}
              onChange={(e) => setIdleDaysInput(e.target.value)}
              className="w-28 text-center"
            />
          </div>
        </div>
      </div>

      {isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {t("pages.alerts.error")}
        </div>
      )}

      {/* Summary KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <KpiTile
          icon={AlertTriangle}
          tone="amber"
          label={t("pages.alerts.lowStockCount")}
          value={isLoading ? null : lowStock.length}
        />
        <KpiTile
          icon={Hourglass}
          tone="rose"
          label={t("pages.alerts.idleCount")}
          value={isLoading ? null : idle.length}
        />
      </div>

      {/* Low Stock section */}
      <section className="rounded-xl border bg-card overflow-hidden">
        <header className="px-4 py-3 bg-amber-50/60 dark:bg-amber-900/10 border-b flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <h2 className="font-bold text-sm">{t("pages.alerts.lowStockTitle")}</h2>
          {!isLoading && <Badge variant="secondary" className="ms-auto">{lowStock.length}</Badge>}
        </header>
        {isLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : lowStock.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {t("pages.alerts.lowStockEmpty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="px-4 py-2 text-start font-semibold text-muted-foreground">{t("pages.items.code")}</th>
                <th className="px-4 py-2 text-start font-semibold text-muted-foreground">{t("pages.items.item")}</th>
                <th className="px-4 py-2 text-end font-semibold text-muted-foreground">{t("pages.alerts.currentQty")}</th>
                <th className="px-4 py-2 text-end font-semibold text-muted-foreground">{t("pages.alerts.reorderLevel")}</th>
                <th className="px-4 py-2 text-end font-semibold text-muted-foreground">{t("pages.alerts.shortfall")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lowStock.map((r) => (
                <tr key={`ls-${r.code}`} className="hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs font-bold">{r.code}</td>
                  <td className="px-4 py-2">
                    {r.itemId ? (
                      <Link href={`/inventory/items?itemId=${r.itemId}`}>
                        <a className="text-primary hover:underline inline-flex items-center gap-1">
                          {r.nameAr || r.nameEn} <ArrowLeft className="h-3 w-3 opacity-60" />
                        </a>
                      </Link>
                    ) : (r.nameAr || r.nameEn)}
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums font-semibold">{fmtQty(r.totalQty)}</td>
                  <td className="px-4 py-2 text-end tabular-nums text-muted-foreground">{fmtQty(r.reorderLevel)}</td>
                  <td className="px-4 py-2 text-end tabular-nums text-amber-700">
                    {fmtQty(Math.max(0, r.reorderLevel - r.totalQty))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Idle Items section */}
      <section className="rounded-xl border bg-card overflow-hidden">
        <header className="px-4 py-3 bg-rose-50/60 dark:bg-rose-900/10 border-b flex items-center gap-2">
          <Hourglass className="h-4 w-4 text-rose-600" />
          <h2 className="font-bold text-sm">
            {t("pages.alerts.idleTitle", { days: effectiveIdleDays })}
          </h2>
          {!isLoading && <Badge variant="secondary" className="ms-auto">{idle.length}</Badge>}
        </header>
        {isLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : idle.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {t("pages.alerts.idleEmpty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="px-4 py-2 text-start font-semibold text-muted-foreground">{t("pages.items.code")}</th>
                <th className="px-4 py-2 text-start font-semibold text-muted-foreground">{t("pages.items.item")}</th>
                <th className="px-4 py-2 text-end font-semibold text-muted-foreground">{t("pages.alerts.lastSold")}</th>
                <th className="px-4 py-2 text-end font-semibold text-muted-foreground">{t("pages.alerts.daysIdle")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {idle.map((r) => (
                <tr key={`idle-${r.itemId}`} className="hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs font-bold">{r.code}</td>
                  <td className="px-4 py-2">
                    <Link href={`/inventory/items?itemId=${r.itemId}`}>
                      <a className="text-primary hover:underline inline-flex items-center gap-1">
                        {r.nameAr || r.nameEn} <ArrowLeft className="h-3 w-3 opacity-60" />
                      </a>
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums">{formatDate(r.lastSoldDate)}</td>
                  <td className="px-4 py-2 text-end tabular-nums font-semibold text-rose-700">
                    {r.daysIdle}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// Inline KPI tile so we don't drag in a heavier dashboard component for two
// numbers. `value === null` shows a skeleton, matching the rest of the page.
function KpiTile({ icon: Icon, tone, label, value }: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "amber" | "rose";
  label: string;
  value: number | null;
}) {
  const toneCls = tone === "amber"
    ? "from-amber-50 to-amber-100/40 text-amber-800 border-amber-200"
    : "from-rose-50 to-rose-100/40 text-rose-800 border-rose-200";
  return (
    <div className={`rounded-xl border bg-gradient-to-br ${toneCls} p-4`}>
      <div className="flex items-center gap-2 text-xs font-medium opacity-80 mb-2">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums">
        {value === null ? <Skeleton className="h-7 w-14" /> : value}
      </div>
    </div>
  );
}
