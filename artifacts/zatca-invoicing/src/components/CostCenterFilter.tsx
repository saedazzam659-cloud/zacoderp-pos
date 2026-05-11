/**
 * Cost-Center Filter for reports — visual twin of `BranchFilter` so the
 * two filters line up naturally side-by-side in any report's filter bar.
 *
 * Contract:
 *   <CostCenterFilter value={ccId} onChange={setCcId} />
 *
 *   - `value: number | undefined`   → undefined ⇒ "All cost centers" sentinel.
 *   - `onChange(id | undefined)`    → wire into the React-Query queryKey,
 *      the API querystring (`costCenterId`), and any export builder so
 *      exports match the on-screen rows.
 *
 * The backend filters on `journal_entry_lines.cost_center` (stored as text)
 * by stringifying the numeric id. Only reports that explicitly accept the
 * `costCenterId` query param will honour the filter — others ignore it.
 */
import { useTranslation } from "react-i18next";
import { Target } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useCostCenters } from "@/hooks/useCostCenters";
import { cn } from "@/lib/utils";

interface Props {
  value: number | undefined;
  onChange: (costCenterId: number | undefined) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

const ALL = "__all__";

export default function CostCenterFilter({
  value, onChange, className, showLabel = true, size = "md",
}: Props) {
  const { t, i18n } = useTranslation();
  const { data: centers = [], isLoading } = useCostCenters();
  const isAr = i18n.language?.startsWith("ar");

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <Target className="h-3.5 w-3.5" />
          {t("nav.costCenters", "مراكز التكلفة")}
        </Label>
      )}
      <Select
        value={value === undefined || value === null ? ALL : String(value)}
        onValueChange={(v) => onChange(v === ALL ? undefined : Number(v))}
        disabled={isLoading}
      >
        <SelectTrigger className={cn(size === "sm" ? "h-8 text-xs" : "h-9 text-sm", "min-w-[180px]")}>
          <SelectValue placeholder={t("common.allCostCenters", "كل مراكز التكلفة")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("common.allCostCenters", "كل مراكز التكلفة")}</SelectItem>
          {centers.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              <span className="font-mono text-xs text-muted-foreground me-2">{c.code}</span>
              {(isAr ? c.nameAr : (c.nameEn || c.nameAr)) || c.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
