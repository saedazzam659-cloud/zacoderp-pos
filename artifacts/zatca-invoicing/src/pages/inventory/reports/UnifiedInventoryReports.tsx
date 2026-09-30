import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { BarChart2, Search, X, ChevronLeft } from "lucide-react";
import { usePermission } from "@/hooks/usePermission";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { INVENTORY_REPORTS } from "./InventoryReportsHub";

export default function UnifiedInventoryReports() {
  const { t, i18n } = useTranslation();
  const canViewSmartAlerts = usePermission("items", "view");
  const [search, setSearch] = useState("");
  const isRtl = i18n.language === "ar";

  const visibleReports = useMemo(
    () =>
      INVENTORY_REPORTS.filter(
        (report) =>
          report.href !== "/inventory/alerts" || canViewSmartAlerts,
      ),
    [canViewSmartAlerts],
  );

  const filteredReports = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase(i18n.language);
    if (!normalizedSearch) return visibleReports;

    return visibleReports.filter((report) => {
      const title = t(`inventoryReports.hub.${report.key}Title`);
      const description = t(`inventoryReports.hub.${report.key}Desc`);
      return `${title} ${description} ${report.key}`
        .toLocaleLowerCase(i18n.language)
        .includes(normalizedSearch);
    });
  }, [i18n.language, search, t, visibleReports]);

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            data-testid="text-unified-inventory-reports-title"
          >
            <BarChart2 className="h-6 w-6 text-primary" aria-hidden="true" />
            {t("inventoryReports.hub.title")}
          </h1>
          <p
            className="mt-1 text-sm text-muted-foreground"
            data-testid="text-unified-inventory-reports-subtitle"
          >
            {t("inventoryReports.hub.subtitle")}
          </p>
        </div>

        <div className="w-full sm:max-w-sm">
          <label
            htmlFor="inventory-report-search"
            className="sr-only"
          >
            {t("inventoryReports.hub.search", {
              defaultValue: isRtl ? "ابحث في التقارير" : "Search reports",
            })}
          </label>
          <div className="relative">
            <Search
              className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ${
                isRtl ? "right-3" : "left-3"
              }`}
              aria-hidden="true"
            />
            <Input
              id="inventory-report-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("inventoryReports.hub.search", {
                defaultValue: isRtl ? "ابحث في التقارير" : "Search reports",
              })}
              className={isRtl ? "pe-9 ps-10" : "pe-10 ps-9"}
              data-testid="input-unified-inventory-report-search"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch("")}
                aria-label={isRtl ? "مسح البحث" : "Clear search"}
                className={`absolute top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground ${
                  isRtl ? "left-1" : "right-1"
                }`}
                data-testid="button-clear-unified-inventory-report-search"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span data-testid="text-unified-inventory-report-count">
          {filteredReports.length} / {visibleReports.length}
        </span>
        {search.trim() && (
          <span aria-live="polite">
            {isRtl ? "نتائج البحث" : "Search results"}
          </span>
        )}
      </div>

      {filteredReports.length === 0 ? (
        <div
          className="rounded-xl border border-dashed bg-card px-5 py-14 text-center"
          data-testid="empty-unified-inventory-reports"
        >
          <Search
            className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="font-semibold">
            {t("inventoryReports.hub.noResults", {
              defaultValue: isRtl ? "لا توجد تقارير مطابقة" : "No matching reports",
            })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("inventoryReports.hub.tryAnotherSearch", {
              defaultValue: isRtl
                ? "جرّب كلمة بحث مختلفة."
                : "Try a different search term.",
            })}
          </p>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="grid-unified-inventory-reports"
        >
          {filteredReports.map((report) => {
            const ReportIcon = report.icon;
            return (
              <Link
                key={report.href}
                href={report.href}
                className={`group block cursor-pointer rounded-xl border bg-gradient-to-br p-5 transition-all hover:-translate-y-0.5 hover:shadow-md ${report.color}`}
                data-testid={`link-unified-inventory-report-${report.key}`}
              >
                <div className="mb-3 flex items-start justify-between">
                  <ReportIcon className="h-7 w-7" aria-hidden="true" />
                  <ChevronLeft
                    className={`h-4 w-4 opacity-40 transition-all group-hover:opacity-100 ${
                      isRtl
                        ? "group-hover:-translate-x-1"
                        : "rotate-180 group-hover:translate-x-1"
                    }`}
                    aria-hidden="true"
                  />
                </div>
                <h2 className="mb-1.5 text-base font-bold">
                  {t(`inventoryReports.hub.${report.key}Title`)}
                </h2>
                <p className="text-xs leading-relaxed opacity-80">
                  {t(`inventoryReports.hub.${report.key}Desc`)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}