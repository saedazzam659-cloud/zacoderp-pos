import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { BarChart3, ChevronLeft, Search, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { companyAllowsModule, companyAllowsScreen } from "@/lib/companyModuleGate";
import {
  getUnifiedReportModule,
  type UnifiedReportLink,
  type UnifiedReportModuleId,
} from "@/lib/unifiedModuleReports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const reportTileColors = [
  "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  "from-violet-50 to-violet-100/40 text-violet-700 border-violet-200",
  "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
];

function ReportTile({
  report,
  index,
  user,
}: {
  report: UnifiedReportLink;
  index: number;
  user: any;
}) {
  const { i18n } = useTranslation();
  const canView = usePermission(report.permissionKey);
  const canViewScreen = companyAllowsScreen(user, report.href);
  const canUseCompanyGate = !report.companyGateKey
    || companyAllowsModule(user, report.companyGateKey);
  if (!canView || !canViewScreen || !canUseCompanyGate) return null;

  const ReportIcon = report.icon;
  const color = reportTileColors[index % reportTileColors.length];
  return (
    <Link
      href={report.href}
      className={`group block cursor-pointer rounded-xl border bg-gradient-to-br p-5 transition-all hover:-translate-y-0.5 hover:shadow-md ${color}`}
      data-testid={`link-unified-report-${report.href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
    >
      <div className="mb-3 flex items-start justify-between">
        <ReportIcon className="h-7 w-7" aria-hidden="true" />
        <ChevronLeft
          className="h-4 w-4 opacity-40 transition-all group-hover:-translate-x-1 group-hover:opacity-100 rtl:rotate-0 ltr:rotate-180"
          aria-hidden="true"
        />
      </div>
      <h2 className="text-base font-bold">{report.label}</h2>
      <p className="mt-1.5 text-xs opacity-80">
        {i18n.language.startsWith("en") ? "Open report" : "فتح التقرير"}
      </p>
    </Link>
  );
}

export default function UnifiedModuleReports({
  moduleId,
}: {
  moduleId: UnifiedReportModuleId;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth() as any;
  const [search, setSearch] = useState("");
  const module = getUnifiedReportModule(moduleId);
  const isRtl = i18n.language.startsWith("ar");

  const filteredReports = useMemo(() => {
    if (!module) return [];
    const normalizedSearch = search.trim().toLocaleLowerCase(i18n.language);
    if (!normalizedSearch) return module.reports;
    return module.reports.filter((report) =>
      report.label.toLocaleLowerCase(i18n.language).includes(normalizedSearch),
    );
  }, [i18n.language, module, search]);

  if (!module) {
    return (
      <div role="alert" className="rounded-xl border bg-card p-6 text-sm">
        {isRtl ? "لا تتوفر شاشة تقارير موحدة لهذه الوحدة." : "No unified reports are available for this module."}
      </div>
    );
  }

  const title = module.label;
  const searchPlaceholder = isRtl ? "ابحث في التقارير" : "Search reports";

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            data-testid={`text-unified-reports-title-${moduleId}`}
          >
            <BarChart3 className="h-6 w-6 text-primary" aria-hidden="true" />
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isRtl
              ? "اختر التقرير المطلوب. تظل صلاحيات كل تقرير مطبقة."
              : "Choose a report. Existing permissions are still enforced."}
          </p>
        </div>

        <div className="w-full sm:max-w-sm">
          <label htmlFor="unified-report-search" className="sr-only">
            {searchPlaceholder}
          </label>
          <div className="relative">
            <Search
              className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ${
                isRtl ? "right-3" : "left-3"
              }`}
              aria-hidden="true"
            />
            <Input
              id="unified-report-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              className={isRtl ? "pe-9 ps-10" : "pe-10 ps-9"}
              data-testid="input-unified-report-search"
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
                data-testid="button-clear-unified-report-search"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </header>

      {filteredReports.length === 0 ? (
        <div
          className="rounded-xl border border-dashed bg-card px-5 py-14 text-center"
          data-testid="empty-unified-reports"
        >
          <Search className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
          <p className="font-semibold">
            {t("inventoryReports.hub.noResults", {
              defaultValue: isRtl ? "لا توجد تقارير مطابقة" : "No matching reports",
            })}
          </p>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid={`grid-unified-reports-${moduleId}`}
        >
          {filteredReports.map((report, index) => (
            <ReportTile key={report.href} report={report} index={index} user={user} />
          ))}
        </div>
      )}
    </div>
  );
}