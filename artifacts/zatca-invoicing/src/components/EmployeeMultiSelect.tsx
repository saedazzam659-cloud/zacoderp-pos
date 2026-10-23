import { useState } from "react";
import { Input } from "@/components/ui/input";

export type EmployeeOption = { value: string; label: string };

type Props = {
  employees: EmployeeOption[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function EmployeeMultiSelect({
  employees,
  value,
  onChange,
  disabled,
  placeholder = "اختر الموظفين",
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const availableIds = new Set(employees.map((employee) => employee.value));
  const options = [
    ...employees,
    ...value
      .filter((id) => !availableIds.has(id))
      .map((id) => ({ value: id, label: `موظف #${id} (غير متاح لهذا الفرع)` })),
  ];
  const selectedNames = options
    .filter((employee) => value.includes(employee.value))
    .map((employee) => employee.label);
  const visibleEmployees = options.filter((employee) =>
    employee.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  return (
    <div className="relative" dir="rtl">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate text-right">
          {selectedNames.length ? selectedNames.join("، ") : placeholder}
        </span>
        <span className="mr-2 shrink-0 text-xs text-muted-foreground">
          {value.length ? value.length : ""}
        </span>
      </button>
      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-64 w-full space-y-2 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-md">
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ابحث عن موظف..."
            aria-label="ابحث عن موظف"
            className="h-8"
          />
          {visibleEmployees.length ? visibleEmployees.map((employee) => {
            const checked = value.includes(employee.value);
            return (
              <label key={employee.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(
                    checked
                      ? value.filter((id) => id !== employee.value)
                      : [...value, employee.value],
                  )}
                  className="h-4 w-4 accent-primary"
                />
                <span>{employee.label}</span>
              </label>
            );
          }) : <p className="px-2 py-3 text-center text-xs text-muted-foreground">لا توجد نتائج</p>}
          <button type="button" onClick={() => setOpen(false)} className="w-full rounded px-2 py-1.5 text-xs text-primary hover:bg-muted">
            تم
          </button>
        </div>
      )}
    </div>
  );
}
