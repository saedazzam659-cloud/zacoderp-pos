import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Calculator,
  CheckCircle2,
  ClipboardList,
  Boxes,
  Cog,
  GitBranch,
  LockKeyhole,
} from "lucide-react";
import type { Catalog, Order } from "./types";

type ReadonlyOrder = Order & {
  detail?: {
    order?: Record<string, any>;
    items?: Array<Record<string, any>>;
    stages?: Array<Record<string, any>>;
    costAllocations?: Array<Record<string, any>>;
    costConfiguration?: Record<string, any>;
    manualCosts?: Array<Record<string, any>>;
  };
  meta?: Record<string, any>;
};

type StepId = "basic" | "materials" | "routing" | "resources" | "costs" | "review";

const NOT_SAVED = "غير محفوظ";

const steps: Array<{ id: StepId; label: string; icon: typeof ClipboardList }> = [
  { id: "basic", label: "البيانات الأساسية", icon: ClipboardList },
  { id: "materials", label: "المواد والوصفة", icon: Boxes },
  { id: "routing", label: "مسار الإنتاج", icon: GitBranch },
  { id: "resources", label: "الموارد", icon: Cog },
  { id: "costs", label: "التكاليف", icon: Calculator },
  { id: "review", label: "المراجعة", icon: CheckCircle2 },
];

const costCategories = [
  { id: "payroll", label: "الرواتب والأجور" },
  { id: "fixed_asset_depreciation", label: "الإهلاك" },
  { id: "prepaid_amortization", label: "المصروفات المقدمة / الإيجار" },
] as const;

const costModeLabels: Record<string, string> = {
  none: "بدون تكلفة",
  linked: "ربط مصدر مرحّل",
  manual: "إدخال تكلفة يدوية",
};

function valueOrNotSaved(value: unknown) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return NOT_SAVED;
  return String(value);
}

function savedNumber(value: unknown) {
  return value == null || value === "" ? NOT_SAVED : String(value);
}

function savedObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function savedDate(value: unknown) {
  return valueOrNotSaved(value);
}

function statusLabel(status: unknown) {
  return ({
    draft: "مسودة",
    approved: "معتمد",
    in_production: "قيد الإنتاج",
    paused: "متوقف مؤقتاً",
    quality_check: "فحص الجودة",
    completed: "مكتمل",
    cancelled: "ملغى",
    reversed: "معكوس",
  } as Record<string, string>)[String(status)] ?? valueOrNotSaved(status);
}

function Field({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`rounded-lg border bg-slate-50/60 p-3 ${wide ? "md:col-span-2" : ""}`}>
      <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>
      <div className="min-h-5 break-words text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function CatalogReference({
  id,
  rows,
  kind,
}: {
  id: unknown;
  rows: Array<{ id: number; nameAr?: string | null }>;
  kind: string;
}) {
  if (id == null || id === "") return <span>{NOT_SAVED}</span>;
  const row = rows.find(item => String(item.id) === String(id));
  return (
    <span>
      {row?.nameAr ? `${row.nameAr} — ` : ""}
      {kind} #{String(id)}
    </span>
  );
}

function SnapshotValue({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-xs font-semibold text-slate-700">{valueOrNotSaved(value)}</div>
    </div>
  );
}

/**
 * Historical wizard evidence for an order.
 *
 * This deliberately does not reuse SimpleWizard: that component loads current
 * BOMs/cost sources and derives previews, which would make an old order appear
 * to have today's setup. Every value in this component comes from the order
 * header or its saved detail snapshot. There are no inputs, comboboxes,
 * popovers, save buttons, or network requests here.
 */
export function SimpleOrderWizardReadonly({
  order,
  catalog,
  resourceCost,
}: {
  order: ReadonlyOrder;
  catalog: Catalog;
  resourceCost?: any;
}) {
  const [tab, setTab] = useState<StepId>("basic");
  const detail = order.detail ?? {};
  const savedOrder = (detail.order ?? order) as Record<string, any>;
  const meta = savedObject(savedOrder.meta) ?? savedObject(order.meta) ?? {};
  const items = Array.isArray(detail.items) ? detail.items : [];
  const stages = Array.isArray(detail.stages) ? detail.stages : [];
  const allocations = Array.isArray(detail.costAllocations) ? detail.costAllocations : [];
  const costConfiguration = savedObject(detail.costConfiguration);
  const hasSavedCostConfiguration = savedObject(meta.costConfiguration) !== null;
  const costPolicy = savedObject(meta.costPolicy);
  const productId = savedOrder.productItemId ?? order.productItemId;
  const resourceStages = Array.isArray(resourceCost?.stages) ? resourceCost.stages : [];

  const renderBasic = () => (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="عنوان أمر الإنتاج" value={valueOrNotSaved(savedOrder.title)} wide />
        <Field
          label="المنتج النهائي (المعرّف المحفوظ)"
          value={
            <CatalogReference
              id={productId}
              rows={catalog.items}
              kind="صنف"
            />
          }
        />
        <Field label="الكمية المخططة" value={savedNumber(savedOrder.plannedQty)} />
        <Field label="وحدة القياس المحفوظة" value={valueOrNotSaved(savedOrder.unitCode)} />
        <Field label="تاريخ البدء المتوقع" value={savedDate(savedOrder.plannedStartDate)} />
        <Field label="تاريخ الانتهاء المتوقع" value={savedDate(savedOrder.plannedEndDate)} />
        <Field label="رقم الأمر" value={valueOrNotSaved(savedOrder.orderNumber)} />
        <Field label="الحالة المحفوظة" value={<Badge variant="outline">{statusLabel(savedOrder.status)}</Badge>} />
        <Field label="الملاحظات المحفوظة" value={valueOrNotSaved(savedOrder.notes)} wide />
      </div>
      <p className="text-xs text-slate-500">
        هذه القيم مأخوذة من رأس الأمر المحفوظ، وليست معاينة من إعدادات التصنيع الحالية.
      </p>
    </div>
  );

  const renderMaterials = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm text-blue-900">
        تُعرض هنا كميات وخطوط المواد المحفوظة مع الأمر كما التُقطت وقت الإنشاء. لا تُعاد قراءة وصفة حالية ولا تُعاد
        حساب الكميات.
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">
          لا توجد مواد محفوظة لهذا الأمر؛ لا يمكن استنتاج وصفة تاريخية غير محفوظة.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => {
            const itemMeta = savedObject(item.meta);
            const basis = savedObject(item.quantityBasis);
            return (
              <Card key={item.id ?? `${item.itemId}-${index}`} className="border-slate-200 shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">
                    {valueOrNotSaved(item.description || item.itemNameAr || item.itemNameEn || (item.itemId != null ? `صنف #${item.itemId}` : null))}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <SnapshotValue label="الكمية المحفوظة" value={savedNumber(item.quantity)} />
                    <SnapshotValue label="الوحدة المحفوظة" value={valueOrNotSaved(item.unitCode)} />
                    <SnapshotValue label="تكلفة الوحدة المحفوظة" value={savedNumber(item.unitCost)} />
                    <SnapshotValue label="إجمالي تكلفة السطر المحفوظ" value={savedNumber(item.totalCost)} />
                  </div>
                  {(itemMeta || basis) && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3">
                      <div className="mb-2 text-xs font-semibold text-emerald-900">لقطة الوصفة المحفوظة</div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        <SnapshotValue label="معرّف قالب الوصفة" value={itemMeta?.fromBomTemplateId ?? basis?.templateId} />
                        <SnapshotValue label="كمية سطر الوصفة" value={itemMeta?.bomLineQuantity ?? basis?.lineQuantity} />
                        <SnapshotValue label="وحدة سطر الوصفة" value={itemMeta?.bomLineUnitCode ?? basis?.lineUnitCode} />
                        <SnapshotValue label="كمية ناتج الوصفة" value={itemMeta?.bomOutputQuantity ?? basis?.outputQuantity} />
                        <SnapshotValue label="وحدة ناتج الوصفة" value={itemMeta?.bomOutputUnitCode ?? basis?.outputUnitCode} />
                        <SnapshotValue label="كمية الاستخدام المحفوظة" value={itemMeta?.usageQuantity} />
                        <SnapshotValue label="وحدة الاستخدام المحفوظة" value={itemMeta?.usageUnitCode} />
                        <SnapshotValue label="معامل التحويل المحفوظ" value={itemMeta?.usageFactor} />
                        <SnapshotValue label="الكمية الأساسية المحفوظة" value={itemMeta?.baseQuantity} />
                        <SnapshotValue label="الوحدة الأساسية المحفوظة" value={itemMeta?.baseUnitCode} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderRouting = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-sm text-violet-900">
        هذه مراحل مسار الإنتاج التي حُفظت كلقطة مستقلة للأمر. لا تُعرض مراحل المسار الحالي بدلاً منها.
      </div>
      {stages.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">
          لا توجد مراحل محفوظة لهذا الأمر؛ لا يمكن استنتاج مسار تاريخي غير محفوظ.
        </div>
      ) : (
        <div className="space-y-3">
          {stages.map((stage, index) => (
            <Card key={stage.id ?? `${stage.sequence}-${index}`} className="border-slate-200 shadow-none">
              <CardContent className="pt-5">
                <div className="mb-3 flex items-center gap-2">
                  <Badge variant="outline">{valueOrNotSaved(stage.sequence ?? index + 1)}</Badge>
                  <div className="font-semibold text-slate-800">{valueOrNotSaved(stage.nameAr || stage.nameEn)}</div>
                  {stage.code && <span className="text-xs text-slate-500">({stage.code})</span>}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <SnapshotValue label="المدة المتوقعة المحفوظة (دقيقة)" value={savedNumber(stage.expectedDurationMinutes)} />
                   <SnapshotValue label="مدة التشغيل الفعلية المحفوظة (دقيقة)" value={savedNumber(stage.actualDurationMinutes)} />
                   <SnapshotValue label="حالة التنفيذ المحفوظة" value={valueOrNotSaved(stage.status)} />
                  <SnapshotValue label="التكلفة المتوقعة المحفوظة" value={savedNumber(stage.expectedCost)} />
                  <SnapshotValue label="الهالك المتوقع المحفوظ" value={savedNumber(stage.expectedWasteRatio)} />
                  <SnapshotValue label="مركز العمل المحفوظ" value={stage.workCenterId == null ? NOT_SAVED : `#${stage.workCenterId}`} />
                   <SnapshotValue label="نمط المورد المحفوظ" value={stage.resourceMode === "both" ? "آلة + عمالة" : stage.resourceMode === "machine" ? "آلة" : stage.resourceMode === "labor" ? "عمالة" : NOT_SAVED} />
                   <SnapshotValue label="معرّف آلة المرحلة المحفوظ" value={stage.resourceId == null ? NOT_SAVED : `#${stage.resourceId}`} />
                   <SnapshotValue label="عدد العمال المحفوظ" value={savedNumber(stage.workerCount)} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  const renderResources = () => (
    <div className="space-y-5">
      <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
        هذه معرّفات الموارد والحسابات المحفوظة مع الأمر. أسماء الكتالوج المعروضة بجوار المعرّف هي للاسترشاد الحالي فقط؛
        لا تُستبدل بها القيمة التاريخية.
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="مخزن سحب الخامات"
          value={<CatalogReference id={savedOrder.rawWarehouseId} rows={catalog.warehouses} kind="مخزن" />}
        />
        <Field
          label="مستودع إيداع الإنتاج التام"
          value={<CatalogReference id={savedOrder.finishedWarehouseId} rows={catalog.warehouses} kind="مخزن" />}
        />
        <Field label="مركز العمل" value={savedOrder.workCenterId == null ? NOT_SAVED : `#${savedOrder.workCenterId}`} />
        <Field label="المورد/المورد التشغيلي المحفوظ" value={savedOrder.resourceId == null ? NOT_SAVED : `#${savedOrder.resourceId}`} />
        <Field label="إجمالي الساعات المخططة المحفوظة" value={savedNumber(savedOrder.plannedHours)} />
        <Field label="مركز التكلفة المحفوظ" value={valueOrNotSaved(savedOrder.costCenter)} />
      </div>
      <div>
        <h4 className="mb-2 text-sm font-semibold text-slate-800">حسابات الترحيل المحفوظة</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="حساب WIP" value={savedOrder.wipAccountId == null ? NOT_SAVED : `#${savedOrder.wipAccountId}`} />
          <Field label="حساب مخزون الخامات" value={savedOrder.rawInventoryAccountId == null ? NOT_SAVED : `#${savedOrder.rawInventoryAccountId}`} />
          <Field label="حساب مخزون الإنتاج التام" value={savedOrder.finishedGoodsAccountId == null ? NOT_SAVED : `#${savedOrder.finishedGoodsAccountId}`} />
          <Field label="حساب الهالك/الفروق" value={savedOrder.wasteAccountId == null ? NOT_SAVED : `#${savedOrder.wasteAccountId}`} />
        </div>
      </div>
    </div>
  );

  const renderCosts = () => (
    <div className="space-y-5">
      <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-sm text-violet-900">
        تُعرض إعدادات وتوزيعات التكلفة الملتقطة مع الأمر كما حُفظت. لا تُعاد قراءة مصادر الفترة ولا تُعاد حساب أي مبلغ.
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="فترة مصادر التكلفة المحفوظة" value={valueOrNotSaved(meta.costPeriod)} />
        <Field label="التكلفة التقديرية المحفوظة" value={savedNumber(savedOrder.estimatedCost)} />
      </div>
      {Number(resourceCost?.version) >= 1 && (
        <div className="rounded-lg border border-violet-200 bg-white p-3">
          <div className="mb-2 text-sm font-semibold text-violet-950">لقطة تكلفة المورد المحفوظة</div>
          <p className="mb-3 text-xs text-slate-600">هذه الأرقام وردت من لقطة الخادم ولا تستند إلى أسعار المورد الحالية. الكهرباء دليل استخدام تقديري فقط؛ يختار المستخدم فاتورة صناعية مرحّلة والمصنع ومركز التكلفة لاحقاً في الإقفال، ثم تطابق ساعات الآلات الفعلية. لا تجمع لقطة الكهرباء مع WIP/FG/COGS مرة أخرى.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <SnapshotValue label="عمالة" value={savedNumber(resourceCost?.totals?.labor)} />
            <SnapshotValue label="إهلاك" value={savedNumber(resourceCost?.totals?.depreciation)} />
            <SnapshotValue label="كهرباء (تقدير)" value={savedNumber(resourceCost?.totals?.electricity)} />
            <SnapshotValue label="عبء مصنع" value={savedNumber(resourceCost?.totals?.factoryOverhead)} />
            <SnapshotValue label="إجمالي لقطة الاستخدام" value={savedNumber(resourceCost?.totals?.total)} />
          </div>
          {resourceStages.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-semibold text-violet-950">تفصيل لقطات المراحل المجمدة</div>
              {resourceStages.map((stage: any) => {
                const components = Array.isArray(stage.snapshot) ? stage.snapshot : [];
                return <div key={stage.stageId} className="rounded-md border border-violet-100 bg-violet-50/30 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-800">
                    <span>مرحلة #{valueOrNotSaved(stage.stageId)} — {stage.resourceMode === "both" ? "آلة + عمالة" : stage.resourceMode === "machine" ? "آلة" : "عمالة"}</span>
                    <span>دقائق التشغيل الفعلية: {savedNumber(stage.durationMinutes)}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {components.map((component: any, index: number) => (
                      <SnapshotValue
                        key={`${component.component}-${component.sourceType}-${component.sourceRecordId}-${index}`}
                        label={`${valueOrNotSaved(component.component)} — ${valueOrNotSaved(component.sourceType)}`}
                        value={`مصدر #${valueOrNotSaved(component.sourceRecordId)} / تخصيص #${valueOrNotSaved(savedObject(component.snapshot)?.sourceAllocationId)}`}
                      />
                    ))}
                  </div>
                </div>;
              })}
            </div>
          )}
        </div>
      )}
      {!hasSavedCostConfiguration || !costConfiguration ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">
          إعدادات التكاليف التفصيلية غير محفوظة لهذا الأمر.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {costCategories.map(category => {
            const entry = savedObject(costConfiguration[category.id]);
            return (
              <Card key={category.id} className="border-slate-200 shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">{category.label}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-0">
                  <SnapshotValue label="طريقة التكلفة" value={costModeLabels[String(entry?.mode)] ?? valueOrNotSaved(entry?.mode)} />
                  <SnapshotValue label="المبلغ اليدوي المحفوظ" value={savedNumber(entry?.amount)} />
                  <SnapshotValue label="الوصف المحفوظ" value={valueOrNotSaved(entry?.description)} />
                  <SnapshotValue
                    label="الحساب المقابل المحفوظ"
                    value={entry?.counterpartAccountId == null ? NOT_SAVED : `#${entry.counterpartAccountId}`}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {allocations.length > 0 ? (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-800">مصادر التكلفة الموزعة المحفوظة</h4>
          <div className="space-y-2">
            {allocations.map((allocation, index) => {
              const snapshotMeta = savedObject(allocation.snapshotMeta);
              return (
                <div key={allocation.id ?? `${allocation.sourceType}-${allocation.sourceRecordId}-${index}`} className="rounded-lg border bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">
                      {valueOrNotSaved(allocation.sourceType)} #{valueOrNotSaved(allocation.sourceRecordId)}
                    </span>
                    <Badge variant="outline">{savedNumber(allocation.allocatedAmount)}</Badge>
                  </div>
                  <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <SnapshotValue label="الفترة" value={`${valueOrNotSaved(allocation.periodStart)} — ${valueOrNotSaved(allocation.periodEnd)}`} />
                    <SnapshotValue label="الأساس" value={valueOrNotSaved(allocation.basis)} />
                    <SnapshotValue label="مبلغ المصدر المحفوظ" value={savedNumber(allocation.sourceAmount)} />
                    <SnapshotValue label="نسبة المشاركة المحفوظة" value={savedNumber(allocation.sharePct)} />
                    <SnapshotValue label="التصنيف المحفوظ" value={valueOrNotSaved(snapshotMeta?.costTreatment)} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">
          لا توجد توزيعات مصادر تكلفة محفوظة لهذا الأمر.
        </div>
      )}
      {costPolicy ? (
        <div className="rounded-lg border bg-slate-50 p-3">
          <h4 className="mb-2 text-sm font-semibold text-slate-800">سياسة معالجة التكلفة المحفوظة</h4>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(costPolicy).map(([key, value]) => (
              <SnapshotValue key={key} label={key} value={valueOrNotSaved(value)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">سياسة معالجة التكلفة غير محفوظة لهذا الأمر.</div>
      )}
    </div>
  );

  const renderReview = () => (
    <div className="space-y-5">
      <div className="rounded-xl border bg-slate-50 p-5 text-center">
        <h3 className="text-xl font-bold text-slate-800">{valueOrNotSaved(savedOrder.title)}</h3>
        <p className="mt-1 text-sm text-slate-600">
          {savedNumber(savedOrder.plannedQty)} {valueOrNotSaved(savedOrder.unitCode)} —{" "}
          <CatalogReference id={productId} rows={catalog.items} kind="صنف" />
        </p>
        <p className="mt-3 text-xs text-slate-500">ملخص مراجعة مبني على القيم المحفوظة، دون تشغيل معاينات أو حسابات جديدة.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Field label="التكلفة التقديرية المحفوظة" value={savedNumber(savedOrder.estimatedCost)} />
        <Field label="التكلفة الفعلية المحفوظة" value={savedNumber(savedOrder.actualCost)} />
        <Field label="تكلفة العمالة المحفوظة" value={savedNumber(savedOrder.laborCost)} />
        <Field label="التكاليف غير المباشرة المحفوظة" value={savedNumber(savedOrder.overheadCost)} />
        <Field label="تكلفة المواد الخام المحفوظة" value={savedNumber(savedOrder.rawMaterialsCost)} />
        <Field label="الكمية المنتجة المحفوظة" value={savedNumber(savedOrder.producedQty)} />
        <Field label="كمية الهالك المحفوظة" value={savedNumber(savedOrder.wasteQty)} />
        <Field label="رقم دفعة الإنتاج المحفوظ" value={valueOrNotSaved(savedOrder.batchNumber)} />
        <Field label="رقم قيد صرف المواد" value={savedOrder.issueJournalEntryId == null ? NOT_SAVED : `#${savedOrder.issueJournalEntryId}`} />
        <Field label="رقم قيد استلام الإنتاج" value={savedOrder.receiptJournalEntryId == null ? NOT_SAVED : `#${savedOrder.receiptJournalEntryId}`} />
      </div>
    </div>
  );

  const content: Record<StepId, () => ReactNode> = {
    basic: renderBasic,
    materials: renderMaterials,
    routing: renderRouting,
    resources: renderResources,
    costs: renderCosts,
    review: renderReview,
  };

  return (
    <Card className="mt-6 border-emerald-200 bg-emerald-50/20 shadow-sm">
      <CardHeader className="border-b border-emerald-100 bg-white/80">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5 text-emerald-700" />
          <div>
            <CardTitle className="text-lg text-emerald-950">بيانات المعالج المحفوظة — للقراءة فقط</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              خطوات الأمر الأصلية محفوظة كما كانت وقت الإنشاء. لا يمكن تعديلها أو إضافة موارد أو إعادة حسابها من هنا.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4 md:p-6">
        <div className="flex gap-2 overflow-x-auto rounded-xl border bg-white p-2 no-scrollbar" role="tablist" aria-label="خطوات المعالج المحفوظة">
          {steps.map(step => {
            const Icon = step.icon;
            const active = tab === step.id;
            return (
              <button
                key={step.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`saved-wizard-panel-${step.id}`}
                onClick={() => setTab(step.id)}
                className={`flex min-w-[125px] flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  active
                    ? "bg-emerald-50 text-emerald-800 shadow-sm ring-1 ring-emerald-200"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                }`}
              >
                <Icon className="h-4 w-4" />
                {step.label}
              </button>
            );
          })}
        </div>
        <div id={`saved-wizard-panel-${tab}`} role="tabpanel" aria-label={steps.find(step => step.id === tab)?.label}>
          {content[tab]()}
        </div>
      </CardContent>
    </Card>
  );
}
