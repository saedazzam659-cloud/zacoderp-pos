/**
 * Canonical Branch Filter for ALL reports.
 *
 * Per the **Branch Filter Policy (MANDATORY)** in `replit.md`, every new
 * report (sales / purchasing / cash / inventory / accounting / tax / HR /
 * POS — anything that renders aggregated or transactional data) MUST mount
 * this component at the top of its filter bar. Do NOT roll your own branch
 * picker.
 *
 * Contract:
 *   <BranchFilter value={branchId} onChange={setBranchId} />
 *
 *   - `value: number | undefined`   → undefined ⇒ "All branches" sentinel.
 *   - `onChange(id | undefined)`    → wire the value into:
 *        1. the React-Query `queryKey` (so changes refetch),
 *        2. the API helper's `qs({ branchId })`,
 *        3. any export (PDF / Excel / CSV / print) builder so exports
 *           match the on-screen rows.
 *
 * Backend enforcement is automatic via `branchScopeFilter(req, table.branchId)`
 * in `artifacts/api-server/src/middleware/auth.ts` — it intersects the
 * caller's `viewAllBranches` / `userBranches` grants with the explicit
 * `?branchId=…` from the query string. Never bypass it.
 *
 * The audit script `pnpm audit:branch-filter` will flag any report file
 * that does not import this component.
 */
import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBranches } from "@/hooks/useBranches";
import { cn } from "@/lib/utils";

interface Props {
  value: number | undefined;
  onChange: (branchId: number | undefined) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

const ALL = "__all__";

export default function BranchFilter({
  value, onChange, className, showLabel = true, size = "md",
}: Props) {
  const { t, i18n } = useTranslation();
  const { data: branches = [], isLoading } = useBranches();
  const isAr = i18n.language?.startsWith("ar");

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" />
          {t("common.branch")}
        </Label>
      )}
      <Select
        value={value === undefined || value === null ? ALL : String(value)}
        onValueChange={(v) => onChange(v === ALL ? undefined : Number(v))}
        disabled={isLoading}
      >
        <SelectTrigger className={cn(size === "sm" ? "h-8 text-xs" : "h-9 text-sm", "min-w-[180px]")}>
          <SelectValue placeholder={t("common.allBranches")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("common.allBranches")}</SelectItem>
          {branches.map((b) => (
            <SelectItem key={b.id} value={String(b.id)}>
              {(isAr ? b.nameAr : (b.nameEn || b.nameAr)) || b.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
