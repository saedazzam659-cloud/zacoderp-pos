import re

with open("artifacts/zatca-invoicing/src/components/ContractingBillDetailEditor.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# Let's replace the whole `return (` block.
start_idx = content.find('  return (\n    <div className="mt-4 space-y-4 rounded-lg border border-sky-200 bg-sky-50/40 p-4 dark:border-sky-900 dark:bg-sky-950/20" dir="rtl">')

if start_idx == -1:
    print("Could not find start")
    exit(1)

# Extract everything before `return (`
before_return = content[:start_idx]

# I need to find the sections
m2 = re.search(r'(<section className="space-y-2">.*?</section>).*?(<section className="space-y-2">.*?</section>).*?(<section className="space-y-2">.*?</section>).*?(<section className="space-y-2">.*?</section>).*?(<section className="space-y-2">.*?</section>)', content[start_idx:], re.DOTALL)
if m2:
    boq_lines = m2.group(1)
    additions = m2.group(2)
    deductions = m2.group(3)
    penalties = m2.group(4)
    attachments = m2.group(5)
else:
    print("Could not find all sections")
    exit(1)

new_return = """  return (
    <div className="mt-4 space-y-4" dir="rtl">
      {/* 1. TOP: Metadata / Project context */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <h4 className="font-bold text-lg flex items-center gap-2">
            تفاصيل المستخلص والرقابة
            {bill?.billNumber && <span className="font-mono text-sm bg-muted text-muted-foreground px-2 py-0.5 rounded">{bill.billNumber}</span>}
          </h4>
          <p className="text-[11px] text-slate-500 mt-1">الكميات السابقة والتراكمية يحسبها الخادم تلقائيًا من المستخلصات المعتمدة السابقة لتجنب الأخطاء البشرية.</p>
          
          {project && (
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="font-medium text-foreground">المشروع:</span> {project.nameAr} {project.code ? `(${project.code})` : ''}</span>
              {detail.bill.direction === 'owner' ? (
                <span className="flex items-center gap-1.5"><span className="font-medium text-foreground">العميل:</span> {project.clientName || '—'}</span>
              ) : null}
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">قيمة العقد المعدلة:</span> {money(detail.summary.adjustedContractValue)} ر.س
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={locked ? "secondary" : "default"} className="text-sm px-3 py-1">{STATUS_LABEL[detail.state] || detail.state}</Badge>
        </div>
      </div>
"""

financial_summary = """
      {/* 3. BOTTOM: Financial values and adjustments summary */}
      <div className="flex flex-wrap items-start justify-end gap-4 mt-8 pt-4 border-t">
        <div className="w-80 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1 mb-3">
            <span>الملخص المالي للمستخلص</span>
            <span className="font-semibold px-2 py-0.5 rounded bg-muted text-foreground/70">
              إنجاز: {detail.summary.cumulativeCompletionPercent.toFixed(2)}%
            </span>
          </div>
          
          <div className="flex justify-between"><span className="text-muted-foreground">أعمال سابقة (معتمدة)</span><span className="font-mono">{money(detail.summary.previousWorks)}</span></div>
          <div className="flex justify-between font-bold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-900/20 px-2 py-1 rounded -mx-2 -my-1"><span className="ms-2">أعمال حالية</span><span className="font-mono me-2">{money(detail.summary.currentWorks)}</span></div>
          <div className="flex justify-between text-slate-700 dark:text-slate-300"><span className="text-muted-foreground">أعمال تراكمية</span><span className="font-mono font-semibold">{money(detail.summary.cumulativeWorks)}</span></div>
          
          <div className="flex justify-between border-t pt-2 mt-2"><span className="text-muted-foreground">الإضافات المالية</span><span className="font-mono text-emerald-600">{money(detail.summary.additionsTotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الاستقطاعات</span><span className="font-mono text-amber-700">−{money(detail.summary.deductionsTotal)}</span></div>
          {detail.summary.advanceRecovery && detail.summary.advanceRecovery.enabled && (
            <div className="flex justify-between text-[11px]"><span className="text-muted-foreground ms-2">↳ استرداد سلفة</span><span className="font-mono text-amber-700">−{money(Number(detail.summary.advanceRecovery.recoveryAmount))}</span></div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">الغرامات المستقلة</span><span className="font-mono text-rose-700">−{money(detail.summary.penaltyTotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">الضريبة (VAT)</span><span className="font-mono">{money(detail.summary.vatAmount)}</span></div>
          
          <div className="flex justify-between font-bold border-t pt-2 text-base">
            <span>صافي المستخلص الحالي</span>
            <span className="font-mono text-primary">{money(detail.summary.adjustedNetAmount)}</span>
          </div>
        </div>
      </div>

      {/* 4. FOOTER: Save / Approve / Print */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-4 border-t bg-muted/20 p-4 rounded-xl">
        <div className="text-xs text-muted-foreground">
          {detail.summary.advanceRecovery && detail.summary.advanceRecovery.enabled && (
            <p>الرصيد الفعلي للسلفة قبل التطبيق: {money(Number(detail.summary.advanceRecovery.actualAdvanceRemaining))} ر.س · بعد التطبيق: {money(Number(detail.summary.advanceRecovery.remainingAdvanceAfter))} ر.س</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {bill?.direction && bill.billNumber && (
            <ContractingBillExportActions
              compact
              snapshot={{
                bill: {
                  ...(bill ?? {}),
                  id: billId,
                  projectId,
                  projectCode: project?.code,
                  projectName: project?.nameAr || project?.nameEn,
                  direction: bill.direction,
                  billNumber: bill.billNumber,
                  billDate: bill.billDate ?? "",
                } as ContractingBillSnapshot,
                project,
              }}
            />
          )}
          {nextStates.length > 0 && (
            <>
              <BillDetailPicker
                className="w-40 bg-white dark:bg-slate-950"
                items={nextStates.map((state) => ({ value: state, label: STATUS_LABEL[state] || state }))}
                value={workflowState}
                onValueChange={setWorkflowState}
                placeholder="الإجراء التالي"
                searchPlaceholder="بحث في الإجراءات..."
                testId="bill-workflow-picker"
              />
              <Button onClick={() => void transition()} disabled={transitioning || !workflowState || workflowState === detail.state}>{transitioning ? "جار الحفظ…" : "تسجيل حالة المستخلص"}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
"""

with open("artifacts/zatca-invoicing/src/components/ContractingBillDetailEditor.tsx", "w", encoding="utf-8") as f:
    f.write(before_return + new_return + boq_lines + "\n" + additions + "\n" + deductions + "\n" + penalties + "\n" + attachments + "\n" + financial_summary)

print("Done")
