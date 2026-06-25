import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useInstalledExtensions } from "./registry";
import PartnerScreenWrapper from "./PartnerScreenWrapper";

// ─────────────────────────────────────────────────────────────────────────
// ExtensionScreen — route resolver for /ext/:extensionId/:screenKey?
//
// Resolves the requested extension against the tenant's INSTALLED (enabled)
// set. Anything not enabled for this company renders a friendly notice rather
// than the iframe — the backend enforces the same gate, this is just UX.
// ─────────────────────────────────────────────────────────────────────────
export default function ExtensionScreen({
  params,
}: {
  params?: { extensionId?: string; screenKey?: string };
}) {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language?.startsWith("en");
  const extensionId = params?.extensionId ?? "";
  const { data: installed, isLoading, isError, error } = useInstalledExtensions();

  if (isLoading) {
    return (
      <div className="p-6 text-muted-foreground" data-testid="ext-screen-loading">
        {t("common.loading", "جارٍ التحميل…")}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 text-destructive" data-testid="ext-screen-error">
        {(error as Error)?.message || t("common.error", "حدث خطأ")}
      </div>
    );
  }

  const ext = (installed ?? []).find((e) => e.extensionId === extensionId);
  if (!ext) {
    return (
      <div className="p-6 space-y-3" data-testid="ext-screen-notfound">
        <p className="text-muted-foreground">
          {t("extensions.notEnabled", "هذه الإضافة غير مفعّلة لهذه الشركة.")}
        </p>
        <Link href="/extensions" className="text-primary underline">
          {t("extensions.backToList", "العودة إلى الإضافات")}
        </Link>
      </div>
    );
  }

  const screens = ext.screens ?? [];
  const screenKey =
    params?.screenKey && screens.some((s) => s.key === params.screenKey)
      ? params.screenKey
      : screens[0]?.key ?? "home";
  const screen = screens.find((s) => s.key === screenKey);
  const extName = isEn ? ext.nameEn || ext.nameAr : ext.nameAr;
  const screenTitle = screen ? (isEn ? screen.titleEn || screen.titleAr : screen.titleAr) : screenKey;

  return (
    <div className="flex flex-col h-full" data-testid={`ext-screen-${extensionId}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
        <Link href="/extensions" className="text-sm text-muted-foreground hover:text-foreground">
          {t("nav.extensionsGroup", "الإضافات")}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">{extName}</span>
        {screens.length > 1 && (
          <div className="flex flex-wrap gap-1 ms-auto">
            {screens.map((s) => {
              const active = s.key === screenKey;
              const label = isEn ? s.titleEn || s.titleAr : s.titleAr;
              return (
                <Link
                  key={s.key}
                  href={`/ext/${ext.extensionId}/${s.key}`}
                  className={
                    "rounded-md px-2.5 py-1 text-xs " +
                    (active ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70")
                  }
                  data-testid={`ext-screen-tab-${s.key}`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <PartnerScreenWrapper
          extensionId={ext.extensionId}
          screenKey={screenKey}
          title={`${extName} — ${screenTitle}`}
          className="w-full h-full min-h-[70vh] border-0 bg-white"
        />
      </div>
    </div>
  );
}
