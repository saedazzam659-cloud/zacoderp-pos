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
