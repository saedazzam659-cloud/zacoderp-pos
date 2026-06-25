import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Puzzle, ShieldCheck, ShieldAlert, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useExtensionCatalog,
  useSetExtensionEnabled,
  screensByKind,
  type CatalogExtension,
  type ExtensionScreenDef,
  type ExtensionScreenKind,
} from "./registry";

// ─────────────────────────────────────────────────────────────────────────
// ExtensionsAdmin — the company admin's control panel for the platform.
//
// Lists the full signed catalog and lets an admin enable/disable each
// extension FOR THEIR COMPANY (every extension is OFF by default). Enabled
// extensions surface their screens here as quick-open links; the actual UI
// always renders inside the sandboxed iframe (PartnerScreenWrapper).
// ─────────────────────────────────────────────────────────────────────────
export default function ExtensionsAdmin() {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language?.startsWith("en");
  const { data: catalog, isLoading, isError, error } = useExtensionCatalog();
  const setEnabled = useSetExtensionEnabled();

  const name = (e: CatalogExtension) => (isEn ? e.nameEn || e.nameAr : e.nameAr);

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="extensions-admin">
      <div className="flex items-center gap-2">
        <Puzzle className="h-6 w-6 text-primary" />
        <h1 className="text-xl font-bold">{t("extensions.title", "الإضافات")}</h1>
      </div>
      <p className="text-sm text-muted-foreground max-w-2xl">
        {t(
          "extensions.subtitle",
          "إضافات الشركاء تعمل ضمن النظام دون الوصول إلى الكود الأساسي. كل إضافة معطّلة افتراضيًا — فعّلها لتظهر شاشاتها.",
        )}
      </p>

      {isLoading && (
        <div className="text-muted-foreground" data-testid="extensions-admin-loading">
          {t("common.loading", "جارٍ التحميل…")}
        </div>
      )}

      {isError && (
        <div className="text-destructive" data-testid="extensions-admin-error">
          {(error as Error)?.message || t("common.error", "حدث خطأ")}
        </div>
      )}

      {!isLoading && !isError && (catalog ?? []).length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="extensions-admin-empty">
            {t("extensions.empty", "لا توجد إضافات متاحة حاليًا.")}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(catalog ?? []).map((e) => (
          <Card key={e.extensionId} data-testid={`extension-card-${e.extensionId}`}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {name(e)}
                  {e.verified ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" aria-label={t("extensions.verified", "موثّقة")} />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-amber-600" aria-label={t("extensions.unverified", "غير موثّقة")} />
                  )}
                </CardTitle>
                <Badge variant={e.enabled ? "default" : "secondary"}>
                  {e.enabled ? t("extensions.on", "مفعّلة") : t("extensions.off", "معطّلة")}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {e.vendor ? `${e.vendor} · ` : ""}v{e.version}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {e.permissions?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {e.permissions.map((p) => (
                    <span key={p} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {p}
                    </span>
                  ))}
                </div>
              )}

              {e.tables && e.tables.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">
                    {t("extensions.tables", "جداول خاصة")}:
                  </span>
                  {e.tables.map((tb) => (
                    <span key={tb.key} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">
                      {isEn ? tb.titleEn || tb.titleAr : tb.titleAr}
                    </span>
                  ))}
                </div>
              )}

              {e.enabled &&
                e.screens?.length > 0 &&
                (() => {
                  const groups = screensByKind(e.screens);
                  const sections = (
                    [
                      { kind: "dashboard", label: t("extensions.kind.dashboard", "لوحات المعلومات"), items: groups.dashboard },
                      { kind: "report", label: t("extensions.kind.report", "التقارير"), items: groups.report },
                      { kind: "screen", label: t("extensions.kind.screen", "الشاشات"), items: groups.screen },
                    ] as Array<{ kind: ExtensionScreenKind; label: string; items: ExtensionScreenDef[] }>
                  ).filter((s) => s.items.length > 0);
                  return (
                    <div className="space-y-1.5">
                      {sections.map((section) => (
                        <div key={section.kind} className="space-y-1">
                          <div className="text-[10px] font-medium text-muted-foreground">{section.label}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {section.items.map((s) => (
                              <Link
                                key={s.key}
                                href={`/ext/${e.extensionId}/${s.key}`}
                                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs hover:bg-muted/70"
                                data-testid={`extension-open-${e.extensionId}-${s.key}`}
                              >
                                <ExternalLink className="h-3 w-3" />
                                {isEn ? s.titleEn || s.titleAr : s.titleAr}
                              </Link>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

              <Button
                variant={e.enabled ? "outline" : "default"}
                size="sm"
                disabled={setEnabled.isPending}
                onClick={() => setEnabled.mutate({ extensionId: e.extensionId, enabled: !e.enabled })}
                data-testid={`extension-toggle-${e.extensionId}`}
              >
                {e.enabled ? t("extensions.disable", "تعطيل") : t("extensions.enable", "تفعيل")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
