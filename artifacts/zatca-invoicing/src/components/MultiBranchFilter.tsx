import { useTranslation } from "react-i18next";
import { Building2, Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useBranches } from "@/hooks/useBranches";
import { cn } from "@/lib/utils";

/**
 * Multi-select branch filter for managers with cross-branch visibility.
 *
 * Renders ONLY when {@link useBranches} returns more than one branch (i.e.
 * the user is admin / superadmin / viewAllBranches=true and the company
 * actually has multiple branches). Restricted users with a single allowed
 * branch get nothing — the page falls back to its legacy single-branch
 * scoped view, preserving the original UX for non-managers.
 *
 * Wire the resulting `value` (number[] — empty = "all branches") into:
 *   1. the React-Query `queryKey` (so changes refetch),
 *   2. the API helper as `branchIds=1,2,3`,
 *   3. any export builder so exports match the on-screen rows.
 *
 * Backend enforcement is automatic via `multiBranchScopeSpread()` in
 * `artifacts/api-server/src/middleware/auth.ts` — restricted-user safety
 * still applies even if the frontend gate is bypassed.
 */
interface Props {
  value: number[];
  onChange: (ids: number[]) => void;
  className?: string;
  size?: "sm" | "md";
}

export default function MultiBranchFilter({
  value, onChange, className, size = "md",
}: Props) {
  const { t, i18n } = useTranslation();
  const { data: branches = [], isLoading } = useBranches();
  const isAr = i18n.language?.startsWith("ar");

  // Hide entirely when there's nothing meaningful to pick. This keeps
  // the legacy filter bar untouched for single-branch companies and for
  // users without cross-branch permission.
  if (!isLoading && branches.length <= 1) return null;

  const allCount = branches.length;
  const selCount = value.length;
  const isAll    = selCount === 0;
  const labelFor = (b: { nameAr: string; nameEn: string | null; code: string }) =>
    (isAr ? b.nameAr : (b.nameEn || b.nameAr)) || b.code;

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  const triggerLabel =
    isAll
      ? `${t("common.allBranches", "كل الفروع")} (${allCount})`
      : selCount === 1
        ? labelFor(branches.find((b) => b.id === value[0])!)
        : `${selCount} ${t("common.branches", "فروع")}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === "sm" ? "sm" : "default"}
          className={cn(
            "gap-2 font-medium border-2",
            isAll ? "border-slate-200" : "border-emerald-300 bg-emerald-50/50 text-emerald-800 hover:bg-emerald-50",
            size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
            className,
          )}
          data-testid="multi-branch-filter-trigger"
        >
          <Building2 className="h-4 w-4 opacity-70" />
          <span>{triggerLabel}</span>
          {!isAll && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange([]); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onChange([]); }
              }}
              className="ms-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-200 hover:bg-emerald-300 cursor-pointer"
              title={t("common.clear", "مسح")}
              aria-label={t("common.clear", "مسح")}
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72 p-0 overflow-hidden"
        data-testid="multi-branch-filter-content"
      >
        {/* Header */}
        <div className="px-3 py-2.5 border-b bg-gradient-to-l from-emerald-50 to-teal-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-emerald-700" />
            <span className="text-sm font-bold text-emerald-900">
              {t("common.filterByBranches", "تصفية حسب الفروع")}
            </span>
          </div>
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-white text-emerald-700 border border-emerald-200">
            {isAll ? t("common.all", "الكل") : `${selCount}/${allCount}`}
          </span>
        </div>

        {/* Quick actions */}
        <div className="px-3 py-2 border-b flex items-center gap-2 bg-slate-50/60">
          <Button
            type="button" variant="ghost" size="sm"
            onClick={() => onChange([])}
            className="h-7 text-xs flex-1"
            data-testid="multi-branch-clear"
          >
            {t("common.allBranches", "كل الفروع")}
          </Button>
          <Button
            type="button" variant="ghost" size="sm"
            onClick={() => onChange(branches.map((b) => b.id))}
            className="h-7 text-xs flex-1"
            data-testid="multi-branch-select-all"
          >
            <Check className="h-3.5 w-3.5 me-1" />
            {t("common.selectAll", "اختيار الكل")}
          </Button>
        </div>

        {/* Branch list */}
        <div className="max-h-72 overflow-y-auto py-1">
          {isLoading && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("common.loading", "جارٍ التحميل…")}
            </div>
          )}
          {!isLoading && branches.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("common.noBranches", "لا توجد فروع متاحة")}
            </div>
          )}
          {branches.map((b) => {
            const checked = value.includes(b.id);
            return (
              <label
                key={b.id}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors",
                  checked ? "bg-emerald-50" : "hover:bg-slate-50",
                )}
                data-testid={`multi-branch-row-${b.id}`}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(b.id)}
                  className="data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600"
                />
                <div className="flex-1 min-w-0">
                  <p className={cn(
                    "text-sm truncate",
                    checked ? "font-bold text-emerald-900" : "text-slate-700",
                  )}>
                    {labelFor(b)}
                  </p>
                  {b.code && (
                    <p className="text-[11px] text-muted-foreground truncate font-mono">
                      {b.code}
                    </p>
                  )}
                </div>
                {checked && <Check className="h-4 w-4 text-emerald-600 flex-shrink-0" />}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
