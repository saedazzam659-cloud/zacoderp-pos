import { Fragment, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  executionEstimate, executionInput,
  type ExecutionLine, type ExecutionInputs, type ExecutionInput,
} from "@/lib/contractingExecution";

const money = (value: number) => Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
export default function ContractingExecutionTable({
  rows, values, onChange, disabled = false, renderVariation,
}: {
  rows: ExecutionLine[];
  values: ExecutionInputs;
  onChange: (values: ExecutionInputs) => void;
  disabled?: boolean;
  renderVariation?: (row: ExecutionLine) => ReactNode;
}) {
  function change(row: ExecutionLine, field: keyof ExecutionInput, value: string) {
    if (row.boqLineId == null) return;
    onChange({ ...values, [row.boqLineId]: { ...(values[row.boqLineId] ?? executionInput(row)), [field]: value } });
  }
  const totals = rows.reduce((sum, row) => {
    const estimate = executionEstimate(row, values[row.boqLineId!] ?? executionInput(row));
    return { executed: sum.executed + estimate.executionValue, certified: sum.certified + estimate.certifiedTotal, pending: sum.pending + estimate.pending };
  }, { executed: 0, certified: 0, pending: 0 });
  return <div className="space-y-3">
    <p className="rounded border border-sky-200 bg-sky-50/50 p-3 text-xs leading-6 text-sky-900 dark:bg-sky-950/20 dark:text-sky-100">
      أدخل التنفيذ الفعلي الجديد فقط. نسبة الاعتماد للصرف تخص قيمة هذا التنفيذ، وليست نسبة إنجاز العقد.
      يمكن اعتماد رصيد معلّق سابق مع تنفيذ حالي صفر. المعلّق ليس محتجزًا ماليًا ولا يستهلك كمية العقد مرة ثانية.
    </p>
    <div className="overflow-x-auto rounded-lg border bg-background">
      <Table className="min-w-[850px]">
        <TableHeader className="bg-muted/40"><TableRow>
          <TableHead>بند العقد / الوحدة</TableHead><TableHead>كمية العقد</TableHead>
          <TableHead>المنفّذ السابق</TableHead><TableHead className="text-sky-700">تنفيذ حالي جديد</TableHead>
          <TableHead>إجمالي المنفّذ</TableHead><TableHead>المتبقي للتنفيذ</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map(row => {
          const input = row.boqLineId == null ? executionInput(row) : values[row.boqLineId] ?? executionInput(row);
          const estimate = executionEstimate(row, input);
          const locked = disabled || row.boqLineId == null;
          const key = row.boqLineId ?? `legacy-${row.id}`;
          return <Fragment key={key}>
            <TableRow className="border-b-0">
              <TableCell className="min-w-52">
                <div className="font-semibold">{row.boqLineCode || row.workItemCode} {row.workItemName || "بند سابق"}</div>
                <div className="text-xs text-muted-foreground">{row.unitSnapshot || row.unit || "—"} · سعر العرض الفعّال {row.quotedPriceComponentsSnapshot?.length && row.quotedPriceComponentsSnapshot.length > 1
                  ? "(أجزاء بنسب ضريبية مستقلة)" : row.boqPriceIncludesVat ? "(شامل الضريبة)" : "(قبل الضريبة)"}: {money(row.quotedPriceComponentsSnapshot?.length
                  ? row.quotedPriceComponentsSnapshot.reduce((sum, part) => sum + Number(part.unitPrice), 0)
                  : Number(row.boqUnitPrice ?? row.unitPriceSnapshot ?? 0))}
                  {row.quotedPriceComponentsSnapshot?.length && row.unitPriceSnapshot != null
                    ? ` · سعر الوحدة الصافي التقريبي: ${money(Number(row.unitPriceSnapshot))} (الاعتماد من إجمالي السطر قبل التقريب)` : ""}
                </div>
                {row.boqLineId == null && <div className="text-xs text-amber-700">سجل قديم — لا ربط تلقائي</div>}
                {renderVariation?.(row)}
              </TableCell>
              <TableCell className="tabular-nums">{row.contractQty ?? "—"}</TableCell>
              <TableCell className="tabular-nums">{row.previousQty}</TableCell>
              <TableCell className="bg-sky-50/40 dark:bg-sky-950/20">
                <Input aria-label={`التنفيذ الحالي ${row.workItemName ?? key}`} data-testid={`execution-qty-${key}`}
                  className="h-9 w-28" type="number" min="0" step="0.0001"
                  max={row.contractQty == null ? undefined : Math.max(0, Number(row.contractQty) - Number(row.previousQty))}
                  disabled={locked} value={input.currentQty} onChange={e => change(row, "currentQty", e.target.value)} />
                <div className="mt-1 text-xs text-muted-foreground">قيمة المنفّذ: {money(estimate.executionValue)}</div>
              </TableCell>
              <TableCell className="tabular-nums">{money(estimate.cumulativeQty)}</TableCell>
              <TableCell className={`tabular-nums ${estimate.remainingQty < 0 ? "font-bold text-red-600" : ""}`}>{row.contractQty == null ? "—" : money(estimate.remainingQty)}</TableCell>
            </TableRow>
            <TableRow className="bg-muted/10"><TableCell colSpan={6}>
              <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
                <label className="space-y-1 text-xs">اعتماد المنفّذ الحالي %
                  <Input aria-label={`نسبة الاعتماد ${row.workItemName ?? key}`} data-testid={`execution-percent-${key}`}
                    className="h-9" type="number" min="0" max="100" step="0.01" disabled={locked}
                    value={input.certificationPercent} onChange={e => change(row, "certificationPercent", e.target.value)} />
                </label>
                <div className="space-y-1 text-xs">معتمد من التنفيذ الحالي<div className="rounded border bg-background p-2 tabular-nums">{money(estimate.certifiedCurrent)}</div></div>
                <div className="space-y-1 text-xs">رصيد معلّق سابق (قيمة)<div className="rounded border bg-background p-2 tabular-nums">{money(estimate.previousPending)}</div></div>
                <label className="space-y-1 text-xs">اعتماد من المعلّق السابق
                  <Input aria-label={`اعتماد المعلق ${row.workItemName ?? key}`} data-testid={`execution-release-${key}`}
                    className="h-9" type="number" min="0" max={estimate.previousPending} step="0.01" disabled={locked}
                    value={input.priorPendingCertifiedValue} onChange={e => change(row, "priorPendingCertifiedValue", e.target.value)} />
                </label>
                <div className="space-y-1 text-xs text-emerald-800 dark:text-emerald-300">إجمالي المعتمد للفترة<div className="rounded border border-emerald-200 bg-emerald-50 p-2 font-bold tabular-nums dark:bg-emerald-950/20">{money(estimate.certifiedTotal)}</div></div>
                <div className="space-y-1 text-xs text-amber-800 dark:text-amber-300">قيمة متبقية معلّقة<div className="rounded border border-amber-200 bg-amber-50 p-2 tabular-nums dark:bg-amber-950/20">{money(estimate.pending)}</div></div>
                <label className="col-span-3 space-y-1 text-xs lg:col-span-6">سبب الاعتماد الجزئي / مرجع اعتماد المعلّق
                  <Input aria-label={`مرجع الاعتماد ${row.workItemName ?? key}`} data-testid={`execution-reason-${key}`}
                    className="h-9" disabled={locked} value={input.certificationReason}
                    placeholder="رقم محضر الاستشاري أو سبب التعليق؛ مطلوب للاعتماد الجزئي أو صرف المعلّق"
                    onChange={e => change(row, "certificationReason", e.target.value)} />
                </label>
              </div>
            </TableCell></TableRow>
          </Fragment>;
        })}
        {rows.length === 0 && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">لا توجد بنود مرتبطة بالعقد. افتح العقد وأضف بنوده من بنود تنفيذ المشروع أولًا.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
    <div className="grid grid-cols-3 gap-3 text-xs">
      <div className="rounded border p-3">قيمة التنفيذ الجديد<div className="mt-1 text-base font-semibold tabular-nums">{money(totals.executed)}</div></div>
      <div className="rounded border border-emerald-200 bg-emerald-50/50 p-3 dark:bg-emerald-950/20">المعتمد للفترة قبل التسويات والضريبة<div className="mt-1 text-base font-semibold tabular-nums">{money(totals.certified)}</div></div>
      <div className="rounded border border-amber-200 bg-amber-50/50 p-3 dark:bg-amber-950/20">قيمة منفّذة متبقية معلّقة<div className="mt-1 text-base font-semibold tabular-nums">{money(totals.pending)}</div></div>
    </div>
    {!disabled && <p className="text-xs text-muted-foreground">القيم معاينة للإدخال. تُثبت عند حفظ البنود، ثم يعاد التحقق منها عند الاعتماد المالي.</p>}
  </div>;
}