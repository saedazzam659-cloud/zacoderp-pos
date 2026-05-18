/**
 * Canonical Region Filter for ALL reports.
 *
 * Companion to <BranchFilter />. Mount alongside the branch filter on the
 * filter bar of any report (sales / purchasing / inventory / cash / AR / AP)
 * that should support region-scoped slicing.
 *
 * Contract:
 *   <RegionFilter value={regionId} onChange={setRegionId} />
 *
 *   - `value: number | undefined`  → undefined ⇒ "All regions" sentinel.
 *   - `onChange(id | undefined)`   → wire the value into:
 *        1. the React-Query `queryKey` (so changes refetch),
 *        2. the API helper's `qs({ regionId })`,
 *        3. any export (PDF / Excel / CSV / print) builder so exports
 *           match the on-screen rows.
 *
 * Backend enforcement: routes call `pushRegionScope(req, conds, table.branchId, cid, regionId)`
 * (see `artifacts/api-server/src/middleware/auth.ts`) which resolves the
 * region to the set of branches inside it and applies an IN(...) condition.
 * Region scope intersects with branch scope — if a user is restricted to
 * branches outside the selected region, they correctly see zero rows.
 *
 * Region is hidden automatically when the company has no regions defined.
 */
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useRegions } from "@/hooks/useRegions";
import { cn } from "@/lib/utils";

interface Props {
  value: number | undefined;
  onChange: (regionId: number | undefined) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
  /** When true (default), the filter renders nothing if the company has no regions. */
  hideWhenEmpty?: boolean;
}

const ALL = "__all__";

export default function RegionFilter({
  value, onChange, className, showLabel = true, size = "md", hideWhenEmpty = true,
}: Props) {
  const { t, i18n } = useTranslation();
  const { data: regions = [], isLoading } = useRegions();
  const isAr = i18n.language?.startsWith("ar");

  if (hideWhenEmpty && !isLoading && regions.length === 0) return null;

  const allLabel = isAr ? "كل المناطق" : "All regions";
  const labelText = isAr ? "المنطقة" : "Region";

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" />
          {t("common.region", labelText)}
        </Label>
      )}
      <Select
        value={value === undefined || value === null ? ALL : String(value)}
        onValueChange={(v) => onChange(v === ALL ? undefined : Number(v))}
        disabled={isLoading}
      >
        <SelectTrigger className={cn(size === "sm" ? "h-8 text-xs" : "h-9 text-sm", "min-w-[180px]")}>
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {regions.map((r) => (
            <SelectItem key={r.id} value={String(r.id)}>
              {(isAr ? r.nameAr : (r.nameEn || r.nameAr)) || r.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
