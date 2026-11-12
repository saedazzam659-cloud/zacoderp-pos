import { useEffect, useState } from "react";
import { listBranches, type Branch } from "../lib/branches";
import { listCostCenters, type CostCenter } from "../lib/costCenters";
import { listAccounts, type Account } from "../lib/accounting";
import { uiText } from "../lib/appSettings";
import { input, SearchCombobox } from "./_adminUi";

/** Loads branches + cost centers once for the report filter bars. */
export function useDimensions() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  useEffect(() => {
    void (async () => {
      const [b, c] = await Promise.all([listBranches(), listCostCenters()]);
      setBranches(b);
      setCostCenters(c);
    })();
  }, []);
  return { branches, costCenters };
}

export function useReportAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refreshAccounts(): Promise<Account[]> {
    setLoading(true);
    setError(null);
    try {
      const next = await listAccounts();
      setAccounts(next);
      return next;
    } catch (e) {
      const message = typeof e === "string" ? e : (e as Error)?.message;
      setError(message || uiText("تعذر تحميل شجرة الحسابات", "Could not load the chart of accounts"));
      throw e;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refreshAccounts().catch(() => {}); }, []);
  return { accounts, loading, error, refreshAccounts };
}

export function branchOptions(branches: Branch[]) {
  return [
    { value: "", label: uiText("كل الفروع", "All branches") },
    ...branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ];
}

export function costCenterOptions(costCenters: CostCenter[]) {
  return [
    { value: "", label: uiText("كل مراكز التكلفة", "All cost centers") },
    ...costCenters.map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}` })),
  ];
}

/** Options for ENTRY forms (not report filters): only active branches and
 *  active + posting cost centers are valid posting targets. The blank option
 *  reads "بدون" (none) rather than "all". */
export function branchPickerOptions(branches: Branch[]) {
  return [
    { value: "", label: uiText("— بدون فرع —", "— No branch —") },
    ...branches.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ];
}

export function costCenterPickerOptions(costCenters: CostCenter[]) {
  return [
    { value: "", label: uiText("— بدون مركز تكلفة —", "— No cost center —") },
    ...costCenters.filter((c) => c.isActive && c.isPosting).map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}` })),
  ];
}

const filterInput: React.CSSProperties = { ...input, padding: "8px 10px" };

export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
      <label style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}

export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <FilterField label={label}>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={filterInput} />
    </FilterField>
  );
}

export function BranchField({ branches, value, onChange }: { branches: Branch[]; value: number | ""; onChange: (v: number | "") => void }) {
  return (
    <FilterField label={uiText("الفرع", "Branch")}>
      <SearchCombobox
        value={value}
        onChange={(v) => onChange(v === "" ? "" : Number(v))}
        options={branchOptions(branches)}
        style={filterInput}
      />
    </FilterField>
  );
}

export function CostCenterField({ costCenters, value, onChange }: { costCenters: CostCenter[]; value: number | ""; onChange: (v: number | "") => void }) {
  return (
    <FilterField label={uiText("مركز التكلفة", "Cost center")}>
      <SearchCombobox
        value={value}
        onChange={(v) => onChange(v === "" ? "" : Number(v))}
        options={costCenterOptions(costCenters)}
        style={filterInput}
      />
    </FilterField>
  );
}

export function AccountHierarchyFields({
  accounts, parentIds, onParentIdsChange, levelMode, onLevelModeChange, showZero, onShowZeroChange,
}: {
  accounts: Account[];
  parentIds: number[];
  onParentIdsChange: (ids: number[]) => void;
  levelMode: "all" | "first" | "last";
  onLevelModeChange: (mode: "all" | "first" | "last") => void;
  showZero: boolean;
  onShowZeroChange: (show: boolean) => void;
}) {
  const children = new Set(accounts.flatMap((a) => a.parentId == null ? [] : [a.parentId]));
  const parents = accounts
    .filter((a) => children.has(a.id))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return (
    <>
      <FilterField label={uiText("الحسابات الرئيسية", "Parent accounts")}>
        <select
          multiple
          size={3}
          value={parentIds.map(String)}
          onChange={(e) => onParentIdsChange(Array.from(e.currentTarget.selectedOptions, (o) => Number(o.value)))}
          style={{ ...filterInput, minWidth: 210, height: "auto", padding: "5px 8px" }}
          aria-label={uiText("تصفية حسب الحساب الرئيسي وفروعه", "Filter by parent accounts and descendants")}
        >
          {parents.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
        </select>
      </FilterField>
      <FilterField label={uiText("مستوى الحساب", "Account level")}>
        <select value={levelMode} onChange={(e) => onLevelModeChange(e.target.value as "all" | "first" | "last")} style={filterInput}>
          <option value="all">{uiText("كل المستويات", "All levels")}</option>
          <option value="first">{uiText("الحسابات الرئيسية", "Top-level accounts")}</option>
          <option value="last">{uiText("الحسابات الفرعية", "Leaf accounts")}</option>
        </select>
      </FilterField>
      <label style={{ display: "inline-flex", gap: 7, alignItems: "center", fontSize: 13, cursor: "pointer", minHeight: 36 }}>
        <input type="checkbox" checked={showZero} onChange={(e) => onShowZeroChange(e.target.checked)} />
        {uiText("عرض الحسابات الصفرية", "Show zero-balance accounts")}
      </label>
    </>
  );
}
