import { Input } from "@/components/ui/input";

export type AdvanceRecoveryPolicy = {
  advanceRecoveryEnabled?: boolean;
  advanceRecoveryPercent?: string;
  advanceRecoveryStartProgressPercent?: string;
  advanceRecoveryMethod?: "percentage" | "fixed";
  advanceRecoveryFixedAmount?: string;
};

export default function ContractingAdvanceRecoveryFields({ value, onChange, disabled }: {
  value: AdvanceRecoveryPolicy; onChange: (value: AdvanceRecoveryPolicy) => void; disabled?: boolean;
}) {
  return <div className="col-span-full space-y-3 rounded border border-amber-200 bg-amber-50/40 p-3 dark:bg-amber-950/20">
    <label className="flex items-center gap-2 text-sm font-semibold">
      <input type="checkbox" checked={value.advanceRecoveryEnabled === true} disabled={disabled}
        onChange={e => onChange({ advanceRecoveryEnabled: e.target.checked })} />
      خصم الدفعة المقدمة من المستخلصات (استرداد المقدم)
    </label>
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1 text-xs">طريقة استرداد الدفعة المقدمة
        <select className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={value.advanceRecoveryMethod ?? "percentage"} disabled={disabled || !value.advanceRecoveryEnabled}
          onChange={e => onChange({ advanceRecoveryMethod: e.target.value as "percentage" | "fixed" })}>
          <option value="percentage">نسبة من الأعمال المعتمدة الحالية</option>
          <option value="fixed">مبلغ ثابت لكل مستخلص</option>
        </select>
      </label>
      {value.advanceRecoveryMethod === "fixed" ? <label className="space-y-1 text-xs">مبلغ الاسترداد لكل مستخلص (ر.س)
        <Input type="number" min="0" step="0.01" value={value.advanceRecoveryFixedAmount ?? "0"}
          disabled={disabled || !value.advanceRecoveryEnabled}
          onChange={e => onChange({ advanceRecoveryFixedAmount: e.target.value })} />
      </label> : <label className="space-y-1 text-xs">نسبة الخصم من الأعمال المعتمدة الحالية %
        <Input type="number" min="0" max="100" step="0.01" value={value.advanceRecoveryPercent ?? "0"}
          disabled={disabled || !value.advanceRecoveryEnabled}
          onChange={e => onChange({ advanceRecoveryPercent: e.target.value })} />
      </label>}
      <label className="space-y-1 text-xs">بدء الخصم عند نسبة اعتماد مالي تراكمية %
        <Input type="number" min="0" max="100" step="0.01" value={value.advanceRecoveryStartProgressPercent ?? "0"}
          disabled={disabled || !value.advanceRecoveryEnabled}
          onChange={e => onChange({ advanceRecoveryStartProgressPercent: e.target.value })} />
      </label>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">هذه نسبة استرداد المقدم، وليست نسبة الدفعة المقدمة في العقد ولا المحتجز.
      {" "}يلزم تسجيل الدفعة المقدمة وترحيلها في «المحاسبة والتسويات» لنفس العقد. يتم التطبيق عند الاعتماد المالي، بحد الرصيد الفعلي المتاح.
      {" "}تقرأ المستخلصات غير المعتمدة إعدادات العقد تلقائيًا. المعتمد يحتفظ بإعداداته واسترداداته السابقة دون تغيير.</p>
  </div>;
}