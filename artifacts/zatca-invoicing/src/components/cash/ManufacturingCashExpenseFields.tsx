import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Fields = {
  manufacturingEligible: boolean;
  manufacturingAllocationMethod: "labor_hours" | "production_quantity";
  approvedManufacturingHours: string;
  approvedProductionQuantity: string;
};

export function ManufacturingCashExpenseFields({ value, onChange, disabled, isRtl }: {
  value: Fields;
  onChange: (patch: Partial<Fields>) => void;
  disabled: boolean;
  isRtl: boolean;
}) {
  const hours = value.manufacturingAllocationMethod === "labor_hours";
  return <div className="space-y-3 rounded-md border p-3">
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor="manufacturing-cash-expense">{isRtl ? "تحميل على التصنيع" : "Manufacturing overhead"}</Label>
      <Switch id="manufacturing-cash-expense" checked={value.manufacturingEligible}
        onCheckedChange={checked => onChange({ manufacturingEligible: checked })} disabled={disabled} />
    </div>
    <p className="text-xs text-muted-foreground">{isRtl
      ? "لإيجار المصنع: مبلغ السند هو الباقي بعد خصم حصة المقدم. يُحمّل استهلاك المقدم من مصدره المنفصل."
      : "Factory rent: enter only the balance after the prepaid portion. Posted prepaid amortization remains a separate source."}</p>
    {value.manufacturingEligible && <>
      <div className="flex flex-wrap gap-2">
        {(["labor_hours", "production_quantity"] as const).map(method => (
          <Button key={method} type="button" size="sm" disabled={disabled}
            variant={value.manufacturingAllocationMethod === method ? "default" : "outline"}
            onClick={() => onChange({ manufacturingAllocationMethod: method })}>
            {method === "labor_hours" ? (isRtl ? "ساعات العمل" : "Labor hours") : (isRtl ? "كمية الإنتاج" : "Production quantity")}
          </Button>
        ))}
      </div>
      <Label htmlFor="manufacturing-cash-driver">{isRtl ? "إجمالي محرك التوزيع المعتمد للشهر" : "Approved monthly allocation driver total"}</Label>
      <Input id="manufacturing-cash-driver" type="number" min="0" step="0.001" disabled={disabled}
        value={hours ? value.approvedManufacturingHours : value.approvedProductionQuantity}
        onChange={e => onChange(hours ? { approvedManufacturingHours: e.target.value } : { approvedProductionQuantity: e.target.value })} />
    </>}
  </div>;
}
