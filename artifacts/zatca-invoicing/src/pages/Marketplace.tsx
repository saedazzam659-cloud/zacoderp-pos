import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Store, ShieldCheck, Star, Download, Trash2, CheckCircle2, ShoppingCart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  useStorefront,
  usePurchaseApp,
  useInstallApp,
  useUninstallApp,
  type StorefrontItem,
} from "@/extensions/marketplaceApi";

// ─────────────────────────────────────────────────────────────────────────
// Marketplace — Phase 4 tenant storefront (المتجر والماركت بليس).
//
// A company admin browses the PUBLISHED apps, buys paid ones (billed via the
// platform's internal ledger), and installs / uninstalls each per company.
// A paid app must be purchased before it can be installed (enabled).
// ─────────────────────────────────────────────────────────────────────────
function priceLabel(item: StorefrontItem, t: TFunction): string {
  if (!item.paid) return t("marketplace.free", "مجاني");
  const amount = Number(item.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const per = item.pricingModel === "monthly" ? ` / ${t("marketplace.month", "شهريًا")}` : "";
  return `${amount} ${item.currency}${per}`;
}

export default function Marketplace() {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language?.startsWith("en");
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useStorefront();
  const purchase = usePurchaseApp();
  const install = useInstallApp();
  const uninstall = useUninstallApp();
  const [busyId, setBusyId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const name = (e: StorefrontItem) => (isEn ? e.nameEn || e.nameAr : e.nameAr);
  const summary = (e: StorefrontItem) => (isEn ? e.summaryEn || e.summaryAr : e.summaryAr || e.summaryEn);

  async function run(action: "purchase" | "install" | "uninstall", item: StorefrontItem) {
    setBusyId(item.extensionId);
    const mut = action === "purchase" ? purchase : action === "install" ? install : uninstall;
    try {
      await mut.mutateAsync(item.extensionId);
      toast({
        title:
          action === "purchase"
            ? t("marketplace.purchased", "تم الشراء والتثبيت")
            : action === "install"
              ? t("marketplace.installed", "تم التثبيت")
              : t("marketplace.uninstalled", "تم إلغاء التثبيت"),
      });
    } catch (e) {
      toast({ variant: "destructive", title: t("common.error", "حدث خطأ"), description: (e as Error)?.message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="marketplace">
      <div className="flex items-center gap-2">
        <Store className="h-6 w-6 text-primary" />
        <h1 className="text-xl font-bold">{t("marketplace.title", "المتجر والماركت بليس")}</h1>
      </div>
      <p className="text-sm text-muted-foreground max-w-2xl">
        {t(
          "marketplace.subtitle",
          "تصفّح التطبيقات والإضافات من المطوّرين الشركاء، واشترِ ما يناسب شركتك ثبّته بنقرة واحدة. كل تطبيق معطّل افتراضيًا.",
        )}
      </p>

      {isLoading && (
        <div className="text-muted-foreground" data-testid="marketplace-loading">
          {t("common.loading", "جارٍ التحميل…")}
        </div>
      )}
      {isError && (
        <div className="text-destructive" data-testid="marketplace-error">
          {(error as Error)?.message || t("common.error", "حدث خطأ")}
        </div>
      )}
      {!isLoading && !isError && items.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="marketplace-empty">
            {t("marketplace.empty", "لا توجد تطبيقات متاحة في المتجر حاليًا.")}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((e) => {
          const busy = busyId === e.extensionId;
          return (
            <Card key={e.extensionId} data-testid={`market-card-${e.extensionId}`} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {e.iconUrl ? (
                      <img src={e.iconUrl} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    )}
                    {name(e)}
                    {e.featured && <Star className="h-4 w-4 text-amber-500 fill-amber-500" aria-label="مميّز" />}
                  </CardTitle>
                  <Badge variant={e.paid ? "default" : "secondary"} data-testid={`market-price-${e.extensionId}`}>
                    {priceLabel(e, t)}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {e.vendor ? `${e.vendor} · ` : ""}v{e.version}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 flex flex-col flex-1">
                {summary(e) && <p className="text-sm text-muted-foreground line-clamp-3">{summary(e)}</p>}
                <div className="flex flex-wrap gap-1">
                  {e.owned && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-[10px]">
                      <CheckCircle2 className="h-3 w-3" /> {t("marketplace.owned", "مُشترى")}
                    </span>
                  )}
                  {e.installed && (
                    <span className="rounded bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px]">
                      {t("marketplace.installedTag", "مُثبّت")}
                    </span>
                  )}
                </div>

                <div className="mt-auto flex gap-2">
                  {e.installed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => run("uninstall", e)}
                      data-testid={`market-uninstall-${e.extensionId}`}
                    >
                      <Trash2 className="h-4 w-4 me-1" /> {t("marketplace.uninstall", "إلغاء التثبيت")}
                    </Button>
                  ) : e.paid && !e.owned ? (
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => run("purchase", e)}
                      data-testid={`market-buy-${e.extensionId}`}
                    >
                      <ShoppingCart className="h-4 w-4 me-1" /> {t("marketplace.buy", "شراء")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => run("install", e)}
                      data-testid={`market-install-${e.extensionId}`}
                    >
                      <Download className="h-4 w-4 me-1" /> {t("marketplace.install", "تثبيت")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
