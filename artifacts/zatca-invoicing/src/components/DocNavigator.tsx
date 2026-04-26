// Shared "smart document navigator" — prev/next arrow buttons + a fuzzy
// search combobox that loads any document in the same series. Used by every
// transactional form (sales/purchase invoices, returns, orders, quotations)
// so the user can step between docs or jump to one by typing any
// recognizable fragment (number, party name, date, total).
//
// Two ways to wire selection:
//   1. Pass `basePath` (default) — clicking an item navigates to
//      `${basePath}/${id}`. Use for forms with their own /:id route.
//   2. Pass `onSelect` (overrides #1) — useful for inline list+form pages
//      (sales/purchase returns) where editing is driven by local state
//      instead of URL routing.
//
// `items` are sorted newest-first by id internally so prev/next have a
// stable, canonical ordering regardless of input order.
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { cn } from "@/lib/utils";

export interface DocNavItem {
  id: string | number;
  docNumber?: string | null;
  partyName?: string;
  date?: string;
  total?: number | string;
  currencyCode?: string | null;
}

export interface DocNavigatorProps {
  items: DocNavItem[];
  currentId: number | string | null | undefined;
  basePath?: string;
  onSelect?: (id: string | number) => void;
  fallbackPrefix?: string;
  className?: string;
}

export function DocNavigator({
  items,
  currentId,
  basePath,
  onSelect,
  fallbackPrefix = "DOC-",
  className,
}: DocNavigatorProps) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) =>
    Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const [, navigate] = useLocation();

  const sorted = [...items].sort((a, b) => Number(b.id) - Number(a.id));
  const cur = currentId != null && currentId !== "" ? Number(currentId) : NaN;
  const navIndex = Number.isFinite(cur) ? sorted.findIndex(it => Number(it.id) === cur) : -1;
  const prev = navIndex >= 0 && navIndex < sorted.length - 1 ? sorted[navIndex + 1] : null;
  const next = navIndex > 0 ? sorted[navIndex - 1] : null;
  // Position counter: "5 / 23" when on a known doc, else just the total "23"
  // (locale-aware digits — Arabic-Indic in RTL, ASCII in English).
  const totalCount = sorted.length;
  const posLocale = isRtl ? "ar-SA" : "en-US";
  const positionLabel = navIndex >= 0
    ? t("docNavigator.position", {
        current: (navIndex + 1).toLocaleString(posLocale),
        total: totalCount.toLocaleString(posLocale),
      })
    : t("docNavigator.total", { total: totalCount.toLocaleString(posLocale) });

  const comboItems = sorted.map(it => ({
    value: String(it.id),
    code: it.docNumber ?? `${fallbackPrefix}${it.id}`,
    label: it.partyName ?? "—",
    description: `${it.date ?? ""} · ${fmt(it.total)} ${it.currencyCode ?? ""}`,
  }));

  const go = (id: string | number) => {
    if (onSelect) onSelect(id);
    else if (basePath) navigate(`${basePath}/${id}`);
  };

  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      {/* Tight navigation cluster: prev | counter pill | next.
          Grouping these three together makes the position counter
          visually inseparable from the arrows it describes. */}
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 px-2.5"
          disabled={!prev}
          title={prev ? `${prev.docNumber ?? `${fallbackPrefix}${prev.id}`}` : t("docNavigator.prevDisabled")}
          onClick={() => prev && go(prev.id)}
          data-enter-skip="true"
        >
          {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
          <span className="text-xs">{t("docNavigator.prev")}</span>
        </Button>
        <span
          className="inline-flex items-center justify-center h-9 min-w-[3.5rem] px-2.5 rounded-md border bg-muted/40 text-xs font-medium text-foreground tabular-nums whitespace-nowrap select-none"
          title={positionLabel}
          data-testid="doc-navigator-counter"
        >
          {positionLabel}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 px-2.5"
          disabled={!next}
          title={next ? `${next.docNumber ?? `${fallbackPrefix}${next.id}`}` : t("docNavigator.nextDisabled")}
          onClick={() => next && go(next.id)}
          data-enter-skip="true"
        >
          <span className="text-xs">{t("docNavigator.next")}</span>
          {isRtl ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
      <div className="w-64 max-w-[60vw]">
        <SearchCombobox
          items={comboItems}
          value={cur && Number.isFinite(cur) ? String(cur) : ""}
          onValueChange={(v) => { if (v) go(v); }}
          placeholder={t("docNavigator.placeholder")}
          searchPlaceholder={t("docNavigator.searchPlaceholder")}
          emptyText={t("docNavigator.empty")}
        />
      </div>
    </div>
  );
}
