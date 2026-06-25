import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Table2 } from "lucide-react";
import { useInstalledExtensions } from "./registry";
import ExtensionDataGrid from "./ExtensionDataGrid";

// ─────────────────────────────────────────────────────────────────────────
// ExtensionTableScreen — route resolver for /ext/:extensionId/table/:tableKey.
//
// Resolves the requested extension + declared table against the tenant's
// INSTALLED (enabled) set, then renders the generic, host-provided data grid.
// Unlike partner screens, this grid is NOT sandboxed: it is host UI talking to
// the same tenant-scoped, manifest-gated /api/ext/:extId/data/:collection
// endpoints, so partners get a working back-office table with zero extra code.
// ─────────────────────────────────────────────────────────────────────────
export default function ExtensionTableScreen({
  params,
}: {
  params?: { extensionId?: string; tableKey?: string };
}) {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language?.startsWith("en");
  const extensionId = params?.extensionId ?? "";
  const tableKey = params?.tableKey ?? "";
  const { data: installed, isLoading, isError, error } = useInstalledExtensions();

  if (isLoading) {
    return (
      <div className="p-6 text-muted-foreground" data-testid="ext-table-loading">
        {t("common.loading", "جارٍ التحميل…")}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 text-destructive" data-testid="ext-table-error">
        {(error as Error)?.message || t("common.error", "حدث خطأ")}
      </div>
    );
  }

  const ext = (installed ?? []).find((e) => e.extensionId === extensionId);
  const table = ext?.tables?.find((tb) => tb.key === tableKey);
  if (!ext || !table) {
    return (
      <div className="p-6 space-y-3" data-testid="ext-table-notfound">
        <p className="text-muted-foreground">
          {t("extensions.data.tableNotFound", "هذا الجدول غير متاح لهذه الشركة.")}
        </p>
        <Link href="/extensions" className="text-primary underline">
          {t("extensions.backToList", "العودة إلى الإضافات")}
        </Link>
      </div>
    );
  }

  const extName = isEn ? ext.nameEn || ext.nameAr : ext.nameAr;
  const tableTitle = isEn ? table.titleEn || table.titleAr : table.titleAr;
  const tables = ext.tables ?? [];

  return (
    <div className="flex flex-col h-full" data-testid={`ext-table-screen-${extensionId}-${tableKey}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
        <Link href="/extensions" className="text-sm text-muted-foreground hover:text-foreground">
          {t("nav.extensionsGroup", "الإضافات")}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">{extName}</span>
        <span className="text-muted-foreground">/</span>
        <span className="inline-flex items-center gap-1 text-sm font-medium">
          <Table2 className="h-4 w-4 text-indigo-600" />
          {tableTitle}
        </span>
        {tables.length > 1 && (
          <div className="flex flex-wrap gap-1 ms-auto">
            {tables.map((tb) => {
              const active = tb.key === tableKey;
              const label = isEn ? tb.titleEn || tb.titleAr : tb.titleAr;
              return (
                <Link
                  key={tb.key}
                  href={`/ext/${ext.extensionId}/table/${tb.key}`}
                  className={
                    "rounded-md px-2.5 py-1 text-xs " +
                    (active ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70")
                  }
                  data-testid={`ext-table-tab-${tb.key}`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <ExtensionDataGrid extensionId={ext.extensionId} collection={tableKey} title={tableTitle} />
      </div>
    </div>
  );
}
