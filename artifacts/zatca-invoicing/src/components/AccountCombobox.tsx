import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TYPE_LABELS: Record<string, string> = {
  asset:     "أصول",
  liability: "التزامات",
  equity:    "حقوق ملكية",
  revenue:   "إيرادات",
  expense:   "مصروفات",
};

const TYPE_BADGE_CLASS: Record<string, string> = {
  asset:     "bg-blue-50 text-blue-700 border-blue-200",
  liability: "bg-red-50 text-red-700 border-red-200",
  equity:    "bg-purple-50 text-purple-700 border-purple-200",
  revenue:   "bg-green-50 text-green-700 border-green-200",
  expense:   "bg-orange-50 text-orange-700 border-orange-200",
};

interface AccountComboboxProps {
  value?:         string;
  onValueChange:  (value: string) => void;
  placeholder?:   string;
  className?:     string;
  disabled?:      boolean;
  filterTypes?:   string[];
  grouped?:       boolean;
  allowEmpty?:    boolean;
  emptyLabel?:    string;
  autoFocus?:     boolean;
}

export function AccountCombobox({
  value,
  onValueChange,
  placeholder    = "— اختر حساباً —",
  className,
  disabled,
  filterTypes,
  grouped        = true,
  allowEmpty     = true,
  emptyLabel     = "بدون حساب",
  autoFocus,
}: AccountComboboxProps) {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const filtered = filterTypes
    ? accounts.filter((a: any) => filterTypes.includes(a.accountType))
    : accounts;

  // Build set of parent IDs (any account that is referenced as parent
  // by another account) — these are header/group accounts and must not
  // be selectable in transactions. Compute against the full accounts
  // list so filtering by accountType doesn't change the result.
  const parentIds = new Set<number>();
  for (const a of accounts as any[]) {
    if (a?.parentId != null) parentIds.add(Number(a.parentId));
  }

  const items: ComboboxItem[] = [
    ...(allowEmpty ? [{ value: "", label: emptyLabel }] : []),
    ...filtered
      .filter((a: any) => a.isActive)
      .map((a: any) => {
        const isParent  = parentIds.has(Number(a.id));
        const nonPost   = a.isPosting === false;
        const disabled  = isParent || nonPost;
        return {
          value:          String(a.id),
          code:           a.code,
          label:          a.nameAr,
          labelEn:        a.nameEn ?? undefined,
          group:          grouped ? (TYPE_LABELS[a.accountType] ?? a.accountType) : undefined,
          badge:          disabled ? "رئيسي" : TYPE_LABELS[a.accountType],
          badgeClass:     disabled
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : TYPE_BADGE_CLASS[a.accountType],
          disabled,
          disabledReason: disabled
            ? "لا يمكن اختيار حساب رئيسي، يرجى اختيار حساب فرعي"
            : undefined,
        };
      }),
  ];

  return (
    <SearchCombobox
      items={items}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder="ابحث بالكود أو الاسم..."
      emptyText="لا توجد حسابات مطابقة"
      className={className}
      disabled={disabled}
      grouped={grouped && !filterTypes}
    />
  );
}
