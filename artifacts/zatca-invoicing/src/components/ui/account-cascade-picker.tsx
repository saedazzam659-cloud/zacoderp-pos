import { useMemo, useState, useEffect } from "react";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { Label } from "@/components/ui/label";
import { Layers, CornerDownRight } from "lucide-react";

interface AccountLike {
  id: number;
  parentId: number | null;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  isActive?: boolean | null;
}

interface AccountCascadePickerProps {
  /** Full chart-of-accounts rows for the company. */
  accounts: AccountLike[];
  /** Currently-selected POSTABLE (leaf) account id, as a string. */
  value: string;
  /** Fires with the chosen leaf account id (or "" when cleared). */
  onValueChange: (accountId: string) => void;
  isRtl: boolean;
  disabled?: boolean;
  mainLabel?: string;
  subLabel?: string;
}

/**
 * Two-level cascading chart-of-accounts picker.
 *
 *   1. الحساب الرئيسي — header/group accounts (those that have children).
 *   2. الحساب الفرعي  — appears after a main is picked; lists ALL postable
 *      (leaf) descendants beneath it, flattened + searchable, so deeply
 *      nested accounts are still reachable with just two fields.
 *
 * `value` is bound to the leaf account id (what the document actually posts
 * to). On edit, the main is derived from the selected leaf's parent chain.
 */
export function AccountCascadePicker({
  accounts,
  value,
  onValueChange,
  isRtl,
  disabled,
  mainLabel,
  subLabel,
}: AccountCascadePickerProps) {
  const nameOf = (a: AccountLike) =>
    (isRtl ? a.nameAr || a.nameEn : a.nameEn || a.nameAr) || "";

  // parentId -> children[] (roots are keyed under 0)
  const childrenMap = useMemo(() => {
    const m = new Map<number, AccountLike[]>();
    for (const a of accounts) {
      const pid = a.parentId ?? 0;
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid)!.push(a);
    }
    return m;
  }, [accounts]);

  const hasChildren = (id: number) => (childrenMap.get(id)?.length ?? 0) > 0;

  // Main accounts = group/header accounts (have at least one child), active.
  const mainItems: ComboboxItem[] = useMemo(
    () =>
      accounts
        .filter((a) => hasChildren(a.id) && a.isActive !== false)
        .map((a) => ({
          value: String(a.id),
          label: nameOf(a),
          code: a.code ?? undefined,
        }))
        .sort((x, y) => String(x.code ?? "").localeCompare(String(y.code ?? ""))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, childrenMap, isRtl],
  );

  const [mainId, setMainId] = useState("");

  // Edit mode: derive the main from the selected leaf's direct parent.
  useEffect(() => {
    if (!value) return;
    const sel = accounts.find((a) => String(a.id) === value);
    if (sel && sel.parentId != null) {
      setMainId((prev) => prev || String(sel.parentId));
    }
  }, [value, accounts]);

  // Sub accounts = all leaf (postable) descendants of the chosen main.
  const subItems: ComboboxItem[] = useMemo(() => {
    if (!mainId) return [];
    const out: ComboboxItem[] = [];
    const stack = [...(childrenMap.get(Number(mainId)) ?? [])];
    while (stack.length) {
      const a = stack.pop()!;
      if (a.isActive === false) continue;
      if (hasChildren(a.id)) {
        stack.push(...(childrenMap.get(a.id) ?? []));
      } else {
        out.push({
          value: String(a.id),
          label: nameOf(a),
          code: a.code ?? undefined,
        });
      }
    }
    out.sort((x, y) => String(x.code ?? "").localeCompare(String(y.code ?? "")));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainId, childrenMap, isRtl]);

  return (
    <div className="rounded-lg border-2 border-emerald-100 bg-emerald-50/30 p-3 space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium flex items-center gap-1.5 text-emerald-900">
          <Layers className="h-3.5 w-3.5" />
          {mainLabel ?? "الحساب الرئيسي"} <span className="text-destructive">*</span>
        </Label>
        <SearchCombobox
          items={mainItems}
          value={mainId}
          onValueChange={(v) => {
            setMainId(v);
            onValueChange("");
          }}
          placeholder="— اختر الحساب الرئيسي —"
          searchPlaceholder="ابحث بالاسم أو الكود..."
          emptyText="لا توجد حسابات"
          disabled={disabled}
        />
      </div>

      {mainId && (
        <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          <Label className="text-xs font-medium flex items-center gap-1.5 text-emerald-900">
            <CornerDownRight className="h-3.5 w-3.5" />
            {subLabel ?? "الحساب الفرعي"} <span className="text-destructive">*</span>
          </Label>
          <SearchCombobox
            items={subItems}
            value={value}
            onValueChange={onValueChange}
            placeholder="— اختر الحساب الفرعي —"
            searchPlaceholder="ابحث بالاسم أو الكود..."
            emptyText="لا توجد حسابات فرعية قابلة للترحيل"
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
