/**
 * Account-level filter for the General Accounts reports.
 *
 *   <AccountLevelFilter value={mode} onChange={setMode} />
 *
 *   - "all"   → no level restriction (default)
 *   - "first" → only top-level (root, level === 1) accounts
 *   - "last"  → only last-level (leaf / posting) accounts — those with no children
 */
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AccountLevelMode } from "@/lib/accountTree";

interface Props {
  value: AccountLevelMode;
  onChange: (mode: AccountLevelMode) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

export default function AccountLevelFilter({
  value, onChange, className, showLabel = true, size = "md",
}: Props) {
  const { t } = useTranslation();

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          {t("accountLevelFilter.label", "المستوى")}
        </Label>
      )}
      <Select value={value} onValueChange={(v) => onChange(v as AccountLevelMode)}>
        <SelectTrigger className={cn(size === "sm" ? "h-8 text-xs" : "h-9 text-sm", "min-w-[160px]")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("accountLevelFilter.all", "كل المستويات")}</SelectItem>
          <SelectItem value="first">{t("accountLevelFilter.first", "المستوى الأول (الرئيسية)")}</SelectItem>
          <SelectItem value="last">{t("accountLevelFilter.last", "المستوى الأخير (الترحيلية)")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
