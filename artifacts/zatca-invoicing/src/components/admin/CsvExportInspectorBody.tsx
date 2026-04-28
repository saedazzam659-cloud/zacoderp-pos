// Shared layout for the CSV export-details dialog body, used on both
// /admin/ai-fix (Arabic-only maintenance-history table) and /admin/audit-log
// (bilingual audit-row details dialog).
//
// Before task #152 each surface implemented the same dialog body twice —
// /admin/ai-fix had hardcoded Arabic literals inline and /admin/audit-log
// had a near-identical component reading from i18n keys
// (`adminPages.auditLog.export*`). Adding a new metadata field, renaming a
// metric, or tweaking the truncation pill required keeping both copies in
// sync, which is the same drift problem `maintenanceHistoryLabels` solved
// for the action / entity-type values.
//
// Now there is exactly one source of truth: this file. All visible labels
// (pills, metrics grid, filter rows, extras heading, inspector title) live
// in the `LABELS` map below for both languages, and both surfaces render
// the body by mounting <CsvExportInspectorBody />. Adding a new well-known
// metadata field only requires editing this file.
//
// The action / entity-type values shown inside the filter list still come
// from `lib/maintenanceHistoryLabels` — that module already centralises
// those, and this component just defers to it.

import type { ReactNode } from "react";
import { CheckCircle2, FileSearch, Scissors } from "lucide-react";
import {
  maintenanceHistoryActionLabel,
  maintenanceHistoryEntityTypeLabel,
} from "@/lib/maintenanceHistoryLabels";

export type CsvExportInspectorLanguage = "ar" | "en";

// All visible strings rendered by the inspector body. The same map covers
// both surfaces — the only thing the parent picks is the language.
const LABELS: Record<
  CsvExportInspectorLanguage,
  {
    inspectorTitle: string;
    truncatedPill: string;
    truncatedRows: (cap: string, total: string) => string;
    fullPill: string;
    metricCount: string;
    metricTotalAvailable: string;
    metricRowCap: string;
    filtersTitle: string;
    filtersEmpty: string;
    filterFrom: string;
    filterTo: string;
    filterAction: string;
    filterEntityType: string;
    extras: string;
  }
> = {
  ar: {
    inspectorTitle:       "تفاصيل تصدير CSV",
    truncatedPill:        "تم اقتطاع التصدير",
    truncatedRows:        (cap, total) => `${cap} / ${total} صف`,
    fullPill:             "تم تنزيل الملف بالكامل",
    metricCount:          "عدد الصفوف في الملف",
    metricTotalAvailable: "إجمالي الصفوف المتاحة",
    metricRowCap:         "حد الاقتطاع",
    filtersTitle:         "الفلاتر المُطبَّقة وقت التصدير",
    filtersEmpty:         "لم يتم تطبيق أي فلتر — تم تصدير كامل النطاق المتاح للأمر.",
    filterFrom:           "من تاريخ",
    filterTo:             "إلى تاريخ",
    filterAction:         "الإجراء",
    filterEntityType:     "الفئة",
    extras:               "بيانات إضافية",
  },
  en: {
    inspectorTitle:       "CSV export details",
    truncatedPill:        "Export was truncated",
    truncatedRows:        (cap, total) => `${cap} / ${total} rows`,
    fullPill:             "Full file downloaded",
    metricCount:          "Rows in file",
    metricTotalAvailable: "Total rows available",
    metricRowCap:         "Truncation cap",
    filtersTitle:         "Filters applied at export time",
    filtersEmpty:         "No filters applied — exported the full available range.",
    filterFrom:           "From date",
    filterTo:             "To date",
    filterAction:         "Action",
    filterEntityType:     "Category",
    extras:               "Additional data",
  },
};

// Documented metadata keys we render explicitly (pills + metrics grid +
// filters list). Anything else attached by a writer is surfaced verbatim in
// the "extras" pre block so we never silently drop fields a future writer
// adds.
const WELL_KNOWN_META_KEYS = new Set([
  "truncated", "count", "totalAvailable", "rowCap", "format", "filters",
]);

// Shape returned by parseExportInspectorMetadata. Exported so the parent
// can read e.g. `filters` to wire up surface-specific actions like the
// "re-run with the same filters" button on /admin/ai-fix.
export interface ParsedExportInspectorMetadata {
  truncated: boolean;
  count: number | null;
  totalAvailable: number | null;
  rowCap: number | null;
  format: string | null;
  filters: Record<string, unknown> | null;
  extras: Record<string, unknown>;
  hasExtras: boolean;
}

export function parseExportInspectorMetadata(
  metadata: unknown,
): ParsedExportInspectorMetadata {
  const meta = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const truncated = meta.truncated === true;
  const count = typeof meta.count === "number" ? meta.count : null;
  const totalAvailable =
    typeof meta.totalAvailable === "number" ? meta.totalAvailable : null;
  const rowCap = typeof meta.rowCap === "number" ? meta.rowCap : null;
  const format = typeof meta.format === "string" ? meta.format : null;
  const filters =
    meta.filters && typeof meta.filters === "object" && !Array.isArray(meta.filters)
      ? (meta.filters as Record<string, unknown>)
      : null;

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!WELL_KNOWN_META_KEYS.has(k)) extras[k] = v;
  }

  return {
    truncated,
    count,
    totalAvailable,
    rowCap,
    format,
    filters,
    extras,
    hasExtras: Object.keys(extras).length > 0,
  };
}

// Helper for callers that just need the localised title (e.g. AICompanyFix
// renders it inside the DialogHeader instead of in the body).
export function csvExportInspectorTitle(
  language: CsvExportInspectorLanguage,
): string {
  return LABELS[language].inspectorTitle;
}

interface Props {
  metadata: unknown;
  // Language drives the visible labels. AuditLog derives this from the
  // current i18n locale; AICompanyFix passes "ar" explicitly.
  language: CsvExportInspectorLanguage;
  // Locale string used for number formatting (e.g. "ar-SA", "en-US"). Falls
  // back to the language code if the caller doesn't pass anything.
  numberLocale?: string;
  // Show the "CSV export details" heading inline inside the body. AuditLog
  // does this; AICompanyFix has the same title in the DialogHeader, so it
  // passes false to avoid duplicating it.
  showInlineTitle?: boolean;
  // Stable test-id prefix for the body's child elements (pill, metrics,
  // filters, extras). AICompanyFix passes "maint-history-inspector" and
  // AuditLog passes "audit-details-export"; in both cases the children
  // come out as `${prefix}-truncated-pill`, `${prefix}-metrics`, etc.,
  // which matches what the existing e2e specs target.
  testIdPrefix: string;
  // Optional test-id for the wrapper div itself. AuditLog uses this to
  // expose `audit-details-export-inspector` (so tests can scope to the
  // whole inspector); AICompanyFix doesn't need it because its outer
  // dialog already carries `maint-history-inspector-dialog`.
  rootTestId?: string;
  // Surface-specific footer (e.g. the "re-run with the same filters"
  // replay button on /admin/ai-fix). Rendered after the extras block,
  // separated by a top border.
  footerSlot?: ReactNode;
}

export function CsvExportInspectorBody({
  metadata,
  language,
  numberLocale,
  showInlineTitle = false,
  testIdPrefix,
  rootTestId,
  footerSlot,
}: Props) {
  const labels = LABELS[language];
  const parsed = parseExportInspectorMetadata(metadata);
  const { truncated, count, totalAvailable, rowCap, format, filters, extras, hasExtras } = parsed;

  const fmtLocale = numberLocale ?? language;
  const fmt = (n: number) => n.toLocaleString(fmtLocale);

  const resolveAction = (v: string) => maintenanceHistoryActionLabel(v, language);
  const resolveEntityType = (v: string) => maintenanceHistoryEntityTypeLabel(v, language);

  return (
    <div className="space-y-4 text-sm" data-testid={rootTestId}>
      <div className="flex flex-wrap items-center gap-2">
        {truncated ? (
          <span
            data-testid={`${testIdPrefix}-truncated-pill`}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
          >
            <Scissors className="h-3 w-3" />
            <span>{labels.truncatedPill}</span>
            {rowCap != null && totalAvailable != null && (
              <span className="font-mono text-[10px] opacity-80">
                {labels.truncatedRows(fmt(rowCap), fmt(totalAvailable))}
              </span>
            )}
          </span>
        ) : (
          <span
            data-testid={`${testIdPrefix}-full-pill`}
            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800"
          >
            <CheckCircle2 className="h-3 w-3" />
            <span>{labels.fullPill}</span>
          </span>
        )}
        {format && (
          <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-mono uppercase text-slate-700">
            {format}
          </span>
        )}
      </div>

      {showInlineTitle && (
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <FileSearch className="h-3.5 w-3.5" />
          <span>{labels.inspectorTitle}</span>
        </div>
      )}

      <dl
        data-testid={`${testIdPrefix}-metrics`}
        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
      >
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{labels.metricCount}</dt>
          <dd className="font-mono text-base text-foreground">
            {count != null ? fmt(count) : "—"}
          </dd>
        </div>
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{labels.metricTotalAvailable}</dt>
          <dd className="font-mono text-base text-foreground">
            {totalAvailable != null ? fmt(totalAvailable) : "—"}
          </dd>
        </div>
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{labels.metricRowCap}</dt>
          <dd className="font-mono text-base text-foreground">
            {rowCap != null ? fmt(rowCap) : "—"}
          </dd>
        </div>
      </dl>

      <div data-testid={`${testIdPrefix}-filters`}>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {labels.filtersTitle}
        </div>
        {!filters || Object.values(filters).every((v) => v == null) ? (
          <p className="text-xs italic text-muted-foreground">
            {labels.filtersEmpty}
          </p>
        ) : (
          <ul className="text-xs space-y-1">
            {Object.entries(filters).map(([k, v]) => {
              if (v == null) return null;
              let label = k;
              if (k === "from") label = labels.filterFrom;
              else if (k === "to") label = labels.filterTo;
              else if (k === "action") label = labels.filterAction;
              else if (k === "entityType") label = labels.filterEntityType;
              let display = String(v);
              if (k === "action" && typeof v === "string") {
                display = resolveAction(v);
              } else if (k === "entityType" && typeof v === "string") {
                display = resolveEntityType(v);
              }
              return (
                <li key={k} className="flex items-center gap-2">
                  <span className="text-muted-foreground">{label}:</span>
                  <span className="font-mono">{display}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hasExtras && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {labels.extras}
          </div>
          <pre
            dir="ltr"
            data-testid={`${testIdPrefix}-extras`}
            className="text-xs font-mono bg-muted/40 border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto"
          >
            {JSON.stringify(extras, null, 2)}
          </pre>
        </div>
      )}

      {footerSlot && (
        <div className="pt-2 border-t flex items-center justify-end gap-2">
          {footerSlot}
        </div>
      )}
    </div>
  );
}
