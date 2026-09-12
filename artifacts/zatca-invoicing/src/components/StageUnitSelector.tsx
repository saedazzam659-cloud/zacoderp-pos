import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";

const ORDER_UNIT_VALUE = "";
const CUSTOM_UNIT_VALUE = "__custom__";

export type StageUnitCatalogOption = {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  conversionFactor?: number;
  factor?: string | number;
  baseUnitCode?: string | null;
};

export type StageUnitSelectorProps = {
  value: string | null;
  factor: number;
  baseUnit: string;
  unitCatalog: StageUnitCatalogOption[];
  amount: number;
  label: string;
  kind: "quantity" | "waste";
  stageId: string;
  customMode: boolean;
  disabled?: boolean;
  onUnitChange: (unit: string | null, factor: number, customMode: boolean) => void;
  onFactorChange: (factor: number) => void;
  onCustomModeChange: (custom: boolean) => void;
};

function positiveNumber(value: number): value is number {
  return Number.isFinite(value) && value > 0;
}

function displayNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * A stage quantity unit is deliberately independent from the item's stock unit.
 * Catalog entries are item-specific links resolved by the central conversion
 * engine. Existing custom/manual rows remain readable, but a new selection
 * cannot invent a factor or use an unrelated company unit.
 */
export function StageUnitSelector({
  value,
  factor,
  baseUnit,
  unitCatalog,
  amount,
  label,
  kind,
  stageId,
  customMode,
  disabled = false,
  onUnitChange,
  onFactorChange,
  onCustomModeChange,
}: StageUnitSelectorProps) {
  const { i18n } = useTranslation();
  const [customDraft, setCustomDraft] = useState(value ?? "");
  const effectiveCustomMode = customMode || (!!value && !unitCatalog.some((unit) => unit.code === value));
  const baseOption = useMemo(
    () => unitCatalog.find((unit) => unit.code === baseUnit),
    [baseUnit, unitCatalog],
  );
  const displayCatalogUnit = (unit: StageUnitCatalogOption) => {
    const name = i18n.language?.startsWith("en")
      ? (unit.nameEn || unit.nameAr)
      : unit.nameAr;
    return `${unit.code} — ${name}`;
  };
  const baseLabel = baseOption ? displayCatalogUnit(baseOption) : (baseUnit || "وحدة الأمر");

  useEffect(() => {
    if (effectiveCustomMode) setCustomDraft(value ?? "");
  }, [effectiveCustomMode, value]);

  const items = useMemo<ComboboxItem[]>(() => {
    const catalogItems = unitCatalog
      .filter((unit) => unit.code && unit.code !== baseUnit)
      .map((unit) => ({
        value: unit.code,
        code: unit.code,
        label: displayCatalogUnit(unit),
        labelEn: unit.nameEn || undefined,
        description: Number.isFinite(unit.conversionFactor) && Number(unit.conversionFactor) > 0
          ? `مرجع الكتالوج ×${displayNumber(Number(unit.conversionFactor))} — أدخل معامل المرحلة صراحةً`
          : "معامل المرحلة غير محدد — أدخله صراحةً",
      }));
    return [
      {
        value: ORDER_UNIT_VALUE,
        code: baseUnit || undefined,
        label: `وحدة الأمر — ${baseLabel}`,
        description: "الوحدة الأساسية للمنتج النهائي (المعامل = 1)",
      },
      ...catalogItems,
      ...(effectiveCustomMode ? [{
        value: CUSTOM_UNIT_VALUE,
        label: value ? `وحدة تاريخية — ${value}` : "وحدة مخصصة — اكتب الاسم",
        description: "وحدة محفوظة تاريخياً؛ الوحدات الجديدة يجب أن تكون مرتبطة بالصنف",
      }] : []),
    ];
  }, [baseLabel, baseUnit, effectiveCustomMode, i18n.language, unitCatalog, value]);

  const selectedValue = effectiveCustomMode ? CUSTOM_UNIT_VALUE : (value ?? ORDER_UNIT_VALUE);
  const selectedCatalogOption = value
    ? unitCatalog.find((unit) => unit.code === value)
    : undefined;
  const unitName = effectiveCustomMode
    ? (customDraft.trim() || "الوحدة المخصصة")
    : (value ? (unitCatalog.find((unit) => unit.code === value)
      ? displayCatalogUnit(unitCatalog.find((unit) => unit.code === value)!)
      : value) : baseLabel);
  const convertedAmount = positiveNumber(factor) && Number.isFinite(amount) ? amount * factor : null;
  const testPrefix = `${kind}-stage-unit-${stageId}`;

  const selectUnit = (next: string) => {
    if (next === CUSTOM_UNIT_VALUE) {
      onCustomModeChange(true);
      setCustomDraft(value && !unitCatalog.some((unit) => unit.code === value) ? value : "");
      // A custom name and its factor must both be supplied explicitly.
      onUnitChange(null, 0, true);
      return;
    }
    onCustomModeChange(false);
    if (next === ORDER_UNIT_VALUE) {
      onUnitChange(null, 1, false);
      return;
    }
    const option = unitCatalog.find((unit) => unit.code === next);
    const directFactor = Number(option?.factor);
    const resolvedFactor = positiveNumber(directFactor)
      ? directFactor
      : Number(option?.conversionFactor);
    // The API validates this same item-specific relation. Passing the
    // catalog snapshot keeps the preview responsive while the API remains
    // authoritative and re-resolves a changed unit.
    onUnitChange(next, positiveNumber(resolvedFactor) ? resolvedFactor : 0, false);
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white/80 p-3">
      <Label className="text-xs font-medium text-slate-700">{label}</Label>
      <SearchCombobox
        value={selectedValue}
        onValueChange={selectUnit}
        items={items}
        disabled={disabled}
        placeholder="اختر وحدة المرحلة"
        searchPlaceholder="ابحث عن وحدة..."
        testId={`select-${testPrefix}`}
      />
      {effectiveCustomMode && (
        <Input
          value={customDraft}
          onChange={(event) => {
            const next = event.target.value;
            setCustomDraft(next);
            // Renaming a unit invalidates the previous conversion until the
            // operator enters a factor for the new name.
            onUnitChange(next.trim() || null, 0, true);
          }}
          placeholder="مثال: صينية أو دفعة"
          disabled={disabled}
          data-testid={`input-${testPrefix}-custom`}
          aria-label="اسم وحدة المرحلة المخصصة"
        />
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500">المعامل إلى وحدة الأمر</Label>
          <Input
            dir="ltr"
            inputMode="decimal"
            type="number"
            min="0"
            step="any"
            value={positiveNumber(factor) ? factor : ""}
            onChange={(event) => onFactorChange(Number(event.target.value) || 0)}
            disabled={disabled || (!!selectedCatalogOption && !effectiveCustomMode)}
            data-testid={`input-${testPrefix}-factor`}
            aria-label={`معامل تحويل ${label}`}
          />
        </div>
        <div className="text-[11px] leading-5 text-slate-600" data-testid={`text-${testPrefix}-formula`}>
          <div>1 {unitName} = {positiveNumber(factor) ? displayNumber(factor) : "؟"} {baseLabel}</div>
          {convertedAmount === null ? (
            <div className="text-amber-700">أدخل معاملًا موجبًا لإظهار التحويل</div>
          ) : (
            <div className="font-medium text-violet-700">
              {displayNumber(amount)} {unitName} = {displayNumber(convertedAmount)} {baseLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}