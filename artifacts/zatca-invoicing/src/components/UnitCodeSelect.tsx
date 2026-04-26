import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ZATCA_UNIT_CODES } from "@/lib/zatca-units";

const API = import.meta.env.VITE_API_URL || "";

type Unit = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  conversionFactor: string;
};

export type UnitOption = {
  code: string;
  nameAr: string;
  nameEn?: string | null;
};

export function useUnits(): {
  units: UnitOption[];
  loading: boolean;
  fromDb: boolean;
  degraded: boolean;
} {
  const { token, user } = useAuth() as any;
  const cid = user?.companyId ?? null;
  const q = useQuery<Unit[]>({
    queryKey: ["units", cid],
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const url = cid
        ? `${API}/api/inventory/units?companyId=${cid}`
        : `${API}/api/inventory/units`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const dbUnits = q.data ?? [];
  const fromDb = q.isSuccess && dbUnits.length > 0;
  const degraded = q.isError;

  const units: UnitOption[] = useMemo(() => {
    if (fromDb) {
      return dbUnits.map((u) => ({ code: u.code, nameAr: u.nameAr, nameEn: u.nameEn }));
    }
    return ZATCA_UNIT_CODES.map((u) => ({ code: u.code, nameAr: u.nameAr, nameEn: u.nameEn }));
  }, [dbUnits, fromDb]);

  return { units, loading: q.isLoading, fromDb, degraded };
}

export function formatUnit(opt: UnitOption, lang: string): string {
  const name = lang?.startsWith("en") ? (opt.nameEn || opt.nameAr) : opt.nameAr;
  return `${opt.code} — ${name}`;
}

interface UnitCodeSelectProps {
  value: string;
  onChange: (code: string) => void;
  className?: string;
  placeholder?: string;
  "data-testid"?: string;
  disabled?: boolean;
}

export default function UnitCodeSelect({
  value,
  onChange,
  className,
  placeholder,
  disabled,
  ...rest
}: UnitCodeSelectProps) {
  const { i18n, t } = useTranslation();
  const { units, degraded } = useUnits();
  const lang = i18n.language || "ar";

  const list = useMemo(() => {
    if (value && !units.some((u) => u.code === value)) {
      return [{ code: value, nameAr: value, nameEn: value }, ...units];
    }
    return units;
  }, [units, value]);

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={className}
        data-testid={rest["data-testid"]}
        title={degraded ? t("production.unitsOfflineFallback", "Using standard units (inventory list unavailable)") : undefined}
      >
        <SelectValue placeholder={placeholder ?? t("production.unitCode")} />
      </SelectTrigger>
      <SelectContent className="max-h-[280px]">
        {list.map((u) => (
          <SelectItem key={u.code} value={u.code}>
            {formatUnit(u, lang)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
