import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { saveUiPrefs } from "@/lib/uiPrefsApi";
import { Button } from "@/components/ui/button";

export type UnifiedReportChoice = { href: string; label: string };

export function useUnifiedReportSelection(
  moduleId: string,
  reports: UnifiedReportChoice[],
) {
  const { user, actingCompanyId, setUser } = useAuth() as any;
  const companyId = actingCompanyId ?? user?.companyId ?? user?.company?.id ?? "none";
  const prefsScreen = user?.id
    ? `unifiedReports:${moduleId}:${String(user.id)}:${String(companyId)}`
    : null;
  const scope = prefsScreen ?? `anonymous:${moduleId}`;
  const savedHref = prefsScreen
    ? user?.uiPreferences?.[prefsScreen]?.lastReportHref
    : null;
  const [selection, setSelection] = useState<{ scope: string; href: string | null }>({
    scope: "",
    href: null,
  });

  useEffect(() => {
    setSelection({
      scope,
      href: typeof savedHref === "string" && reports.some(report => report.href === savedHref)
        ? savedHref
        : null,
    });
  }, [reports, savedHref, scope]);

  const selectReport = useCallback((href: string) => {
    setSelection({ scope, href });
    if (!prefsScreen || !user?.id) return;
    const layout = { lastReportHref: href };
    setUser((current: any) => current
      ? {
          ...current,
          uiPreferences: { ...(current.uiPreferences ?? {}), [prefsScreen]: layout },
        }
      : current);
    void saveUiPrefs(prefsScreen, layout).catch(error => {
      console.warn("Could not save the last unified report preference", error);
    });
  }, [prefsScreen, scope, setUser, user?.id]);

  const clearReport = useCallback(() => {
    setSelection({ scope, href: null });
  }, [scope]);

  const selectedHref = selection.scope === scope ? selection.href : null;
  const selectedReport = reports.find(report => report.href === selectedHref) ?? null;
  return { selectedReport, selectReport, clearReport };
}

function embeddedReportSrc(href: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  const appPath = `${base}${href.replace(/^\/+/, "")}`;
  const url = new URL(appPath, window.location.origin);
  url.searchParams.set("__unifiedReportEmbed", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function UnifiedReportEmbed({
  report,
  onClose,
}: {
  report: UnifiedReportChoice;
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const isRtl = i18n.language.startsWith("ar");
  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      data-testid="panel-unified-report-embed"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{report.label}</span>
        </h2>
        <div className="flex items-center gap-2">
          <a
            href={report.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            data-testid="link-open-unified-report-separately"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">
              {isRtl ? "فتح في صفحة مستقلة" : "Open in a separate page"}
            </span>
          </a>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            data-testid="button-close-unified-report"
          >
            <X className="me-1 h-4 w-4" aria-hidden="true" />
            {isRtl ? "إغلاق" : "Close"}
          </Button>
        </div>
      </header>
      <iframe
        key={report.href}
        src={embeddedReportSrc(report.href)}
        title={report.label}
        className="block h-[72vh] min-h-[560px] w-full bg-background"
        referrerPolicy="same-origin"
        data-testid="iframe-unified-report"
      />
    </section>
  );
}