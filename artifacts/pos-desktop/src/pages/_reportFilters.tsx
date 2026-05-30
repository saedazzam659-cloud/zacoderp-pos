import { useEffect, useState } from "react";
import { listBranches, type Branch } from "../lib/branches";
import { listCostCenters, type CostCenter } from "../lib/costCenters";
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

export function branchOptions(branches: Branch[]) {
  return [
    { value: "", label: "كل الفروع" },
    ...branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ];
}

export function costCenterOptions(costCenters: CostCenter[]) {
  return [
    { value: "", label: "كل مراكز التكلفة" },
    ...costCenters.map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}` })),
  ];
}

/** Options for ENTRY forms (not report filters): only active branches and
 *  active + posting cost centers are valid posting targets. The blank option
 *  reads "بدون" (none) rather than "all". */
export function branchPickerOptions(branches: Branch[]) {
  return [
    { value: "", label: "— بدون فرع —" },
    ...branches.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ];
}

export function costCenterPickerOptions(costCenters: CostCenter[]) {
  return [
    { value: "", label: "— بدون مركز تكلفة —" },
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
    <FilterField label="الفرع">
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
    <FilterField label="مركز التكلفة">
      <SearchCombobox
        value={value}
        onChange={(v) => onChange(v === "" ? "" : Number(v))}
        options={costCenterOptions(costCenters)}
        style={filterInput}
      />
    </FilterField>
  );
}
