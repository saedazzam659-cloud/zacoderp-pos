import re

with open("artifacts/zatca-invoicing/src/pages/ContractingProjectDetail.tsx", "r", encoding="utf-8") as f:
    content = f.read()

bills_tab_match = re.search(r'function BillsTab\(\{.*?(?=function RisksTab)', content, re.DOTALL)
if not bills_tab_match:
    print("Could not find BillsTab")
    exit(1)
bills_tab_code = bills_tab_match.group(0)

start_idx = bills_tab_code.find('      {editing && (\n        <div className="rounded-lg border-2 border-emerald-300')
if start_idx == -1:
    print("Could not find start_idx")
    exit(1)
end_str = '        </div>\n      )}\n    </div>\n  );\n}'
end_idx = bills_tab_code.find(end_str)
if end_idx == -1:
    print("Could not find end_idx")
    exit(1)

old_editing_block = bills_tab_code[start_idx:end_idx + len('        </div>\n      )}')]

new_editing_block = """      {editing && (
        <div className="rounded-lg border bg-white dark:bg-slate-900 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-sky-100 dark:border-sky-900/40">
            <h4 className="font-bold text-sky-800 dark:text-sky-200 flex items-center gap-2">
              {(editing as any)?.id ? t("contracting.bills.edit", "تعديل المستخلص") : t("contracting.bills.add", "مستخلص جديد")}
              <span className="text-xs font-normal text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                ({direction === "outgoing" ? t("contracting.bills.outgoing", "للمالك (صادر)") : t("contracting.bills.incoming", "من الباطن (وارد)")})
              </span>
            </h4>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label={t("common.close", "إغلاق")}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          
          {/* TOP METADATA GRID */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 bg-muted/20 p-3 rounded-lg border">
            {direction === "incoming" && (
              <Field label={t("contracting.bills.contractor", "المقاول الباطن")} required>
                <ContractingPicker
                  items={contractors.map(c => ({ value: String(c.id), label: `${c.name}${c.specialty ? ` (${c.specialty})` : ""}` }))}
                  value={editing.contractorId ? String(editing.contractorId) : ""}
                  onValueChange={value => onContractorChange(value ? Number(value) : null)}
                  placeholder={t("contracting.bills.pickContractor", "اختر مقاولاً")}
                  searchPlaceholder={t("contracting.bills.searchContractor", "بحث باسم المقاول...")}
                  emptyText={t("contracting.bills.noContractors", "لا توجد مقاولات متاحة")}
                  disabled={!billOptionsLoaded}
                  testId="bill-contractor-picker"
                />
              </Field>
            )}
            {direction === "outgoing" && (
              <Field label={t("contracting.bills.ownerContract", "عقد المالك المرتبط")} required>
                <ContractingPicker
                  items={ownerContracts.map(c => ({ value: String(c.id), label: `#${c.contractNumber} (${labelEnum(CONTRACT_TYPE_LABEL, c.contractType)})` }))}
                  value={editing.ownerContractId ? String(editing.ownerContractId) : ""}
                  onValueChange={value => setEditing({ ...editing, ownerContractId: value ? Number(value) : null })}
                  placeholder={t("contracting.bills.ownerContractPlaceholder", "اختر عقد المالك")}
                  searchPlaceholder={t("contracting.bills.searchContract", "بحث برقم العقد...")}
                  emptyText={t("contracting.bills.noOwnerContracts", "لا توجد عقود مالك لهذا المشروع")}
                  disabled={!billOptionsLoaded}
                  testId="bill-owner-contract-picker"
                />
              </Field>
            )}
            {direction === "incoming" && (
              <Field label={t("contracting.bills.subcontract", "عقد الباطن المرتبط")} required>
                <ContractingPicker
                  items={selectedSubContracts.map(contract => ({
                    value: String(contract.id),
                    label: `#${contract.contractNumber} · ${contract.retentionPercent}%`,
                  }))}
                  value={editing.subcontractorContractId ? String(editing.subcontractorContractId) : ""}
                  onValueChange={value => {
                    const selected = selectedSubContracts.find(contract => contract.id === Number(value));
                    setEditing({
                      ...editing,
                      subcontractorContractId: value ? Number(value) : null,
                      retentionPercent: selected?.retentionPercent ?? editing.retentionPercent,
                    });
                  }}
                  placeholder={editing.contractorId
                    ? t("contracting.bills.subcontractPlaceholder", "اختر عقد الباطن")
                    : t("contracting.bills.selectContractorFirst", "اختر المقاول أولاً")}
                  searchPlaceholder={t("contracting.bills.searchSubcontract", "بحث برقم عقد الباطن...")}
                  emptyText={editing.contractorId
                    ? t("contracting.bills.noSubcontractsForContractor", "لا توجد عقود باطن لهذا المقاول في المشروع")
                    : t("contracting.bills.selectContractorFirst", "اختر المقاول أولاً")}
                  disabled={!billOptionsLoaded || !editing.contractorId}
                  testId="bill-subcontract-picker"
                />
              </Field>
            )}
            <Field label={t("contracting.bills.number", "الرقم")}>
              <Input
                value={
                  isCreatingBill
                    ? (nextBillCode.number ?? (nextBillCode.loading ? "..." : t("contracting.bills.autoCode", "تلقائي")))
                    : (editing.billNumber ?? "")
                }
                readOnly
                disabled
                className="font-mono text-sm bg-muted/30"
                data-testid="input-bill-number"
              />
            </Field>
            <Field label={t("contracting.bills.date", "التاريخ")} required><DateField value={editing.billDate ?? ""} onChange={e => setEditing({ ...editing, billDate: e.target.value })} /></Field>
            <Field label={t("contracting.bills.type", "النوع")}>
              <ContractingPicker
                items={["interim","final","advance","retention_release"].map(x => ({ value: x, label: labelEnum(BILL_TYPE_LABEL, x) }))}
                value={editing.billType ?? "interim"}
                onValueChange={billType => setEditing({ ...editing, billType })}
                placeholder={t("contracting.bills.typePlaceholder", "اختر النوع")}
                searchPlaceholder={t("contracting.bills.typeSearchPlaceholder", "بحث في أنواع المستخلصات...")}
                testId="bill-type-picker"
              />
            </Field>
            
            <Field label={t("contracting.bills.costCenter", "مركز التكلفة")}>
              <ContractingPicker
                items={[
                  { value: "__none", label: t("contracting.bills.noCostCenter", "بدون مركز تكلفة") },
                  ...(costCenters as CostCenter[]).map(center => {
                    const active = center.isActive !== false;
                    const current = editing.costCenterId === center.id;
                    return {
                      value: String(center.id),
                      label: `${center.code} — ${center.nameAr || center.nameEn || `#${center.id}`}${!active ? ` (${t("contracting.bills.inactiveCostCenter", "غير نشط")})` : ""}`,
                      disabled: !active && !current,
                      disabledReason: t("contracting.bills.inactiveCostCenter", "غير نشط"),
                    };
                  }),
                ]}
                value={editing.costCenterId == null ? "__none" : String(editing.costCenterId)}
                onValueChange={value => setEditing({ ...editing, costCenterId: value === "__none" ? null : Number(value) })}
                placeholder={t("contracting.bills.noCostCenter", "بدون مركز تكلفة")}
                searchPlaceholder={t("contracting.bills.costCenterSearchPlaceholder", "بحث بالكود أو الاسم...")}
                disabled={costCentersLoading}
                testId="bill-cost-center-picker"
              />
            </Field>

            <Field label={t("contracting.bills.status", "الحالة")}>
              <ContractingPicker
                items={["draft","submitted","approved","posted","partially_paid","rejected","paid"].map(x => ({
                  value: x,
                  label: labelEnum(BILL_STATUS_LABEL, x),
                  disabled: ["approved","posted","partially_paid","paid"].includes(x),
                  disabledReason: t("contracting.bills.lockedStatus", "الحالة المرحّلة لا يمكن اختيارها يدوياً"),
                }))}
                value={editing.status ?? "draft"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.bills.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.bills.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="bill-status-picker"
              />
            </Field>
          </div>

          {(editing as any)?.id != null ? (
            <ContractingBillDetailEditor
              billId={Number((editing as any).id)}
              projectId={projectId}
              bill={editing as any}
              project={project}
            />
          ) : (
            <div className="mt-8 pt-4">
              <h5 className="font-semibold text-sky-800 dark:text-sky-200 mb-4">القيم الإجمالية (إدخال التجميع المباشر)</h5>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 bg-muted/10 border p-4 rounded-xl">
                <Field label={t("contracting.bills.progress", "الإنجاز التراكمي %")}><Input type="number" min="0" max="100" value={editing.progressPercent ?? "0"} onChange={e => setEditing({ ...editing, progressPercent: e.target.value })} /></Field>
                <Field label={t("contracting.bills.gross", "الإجمالي التراكمي قبل الضريبة (ر.س)")} required><Input type="number" value={editing.grossAmount ?? "0"} onChange={e => setEditing({ ...editing, grossAmount: e.target.value })} /></Field>
                <Field label={t("contracting.bills.retentionPercent", "% محتجز")}><Input type="number" value={editing.retentionPercent ?? "10"} onChange={e => setEditing({ ...editing, retentionPercent: e.target.value })} /></Field>
                <Field label={t("contracting.bills.previousPaid", "المدفوع سابقاً")}><Input type="number" value={editing.previousPaid ?? "0"} onChange={e => setEditing({ ...editing, previousPaid: e.target.value })} /></Field>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t bg-muted/20 p-4 rounded-xl">
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ البيانات الأساسية")}</Button>
          </div>
        </div>
      )}"""

new_bills_tab_code = bills_tab_code.replace(old_editing_block, new_editing_block)
content = content.replace(bills_tab_code, new_bills_tab_code)

with open("artifacts/zatca-invoicing/src/pages/ContractingProjectDetail.tsx", "w", encoding="utf-8") as f:
    f.write(content)

print("Done")
