import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { GitBranch, FileText, Plus, Server, PackageOpen } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Switch } from "@/components/ui/switch";
import type { Catalog } from "./types";

export function SimpleSetup({
  catalog,
  busy,
   canCreate,
   canEdit,
  onSaveMaterial,
  onSaveBom,
  onLoadBom,
  onSaveRouting,
  onLoadRouting,
  onSaveTemplate,
   onSaveWarehouse,
   onSaveAccounting,
}: {
  catalog: Catalog;
  busy: boolean;
   canCreate: boolean;
   canEdit: boolean;
  onSaveMaterial: (data: { code: string; nameAr: string; itemNature: string; unitId: string }) => Promise<any>;
  onSaveBom: (data: { id?: number; productItemId: string; nameAr: string; outputQty: string; outputUnitCode: string; lines: Array<{ itemId: string; quantity: string; unitCode: string }> }) => Promise<unknown>;
  onLoadBom: (id: number) => Promise<any>;
  onSaveRouting: (data: { id?: number; productItemId: string; nameAr: string; stages: Array<{ nameAr: string; expectedDurationMinutes?: number; code?: string; expectedCost?: string | number; expectedWasteRatio?: string | number; workCenterId?: number | null; expectedCostAccountId?: number | null; notes?: string | null; nameEn?: string | null; resourceMode: "labor" | "machine" | "both"; resourceId?: string; workerCount?: number }> }) => Promise<unknown>;
  onLoadRouting: (id: number) => Promise<any>;
  onSaveTemplate: (data: { id?: number; name: string; productItemId: string; plannedQty: string; unitCode: string }) => Promise<unknown>;
  onSaveWarehouse: (data: { code: string; nameAr: string; isDefault: boolean }) => Promise<unknown>;
  onSaveAccounting: (data: {
    defaultWipAccountId: number | null;
    defaultRawInventoryAccountId: number | null;
    defaultFinishedGoodsAccountId: number | null;
    defaultOverheadAccountId: number | null;
    defaultWasteAccountId: number | null;
    electricityTariffPerKwh?: number | null;
    internalTransportEnabled?: boolean;
  }) => Promise<unknown>;
}) {
  const [material, setMaterial] = useState({ code: "", nameAr: "", itemNature: "raw", unitId: "" });
  const [bom, setBom] = useState({ productItemId: "", nameAr: "", outputQty: "1", outputUnitCode: "" });
  const [bomLines, setBomLines] = useState<Array<{ itemId: string; quantity: string; unitCode: string }>>([{ itemId: "", quantity: "1", unitCode: "" }]);
  const [routing, setRouting] = useState({ productItemId: "", nameAr: "" });
  const [routingStages, setRoutingStages] = useState<Array<{
    nameAr: string;
    expectedDurationMinutes: number;
    code?: string;
    expectedCost?: string | number;
    expectedWasteRatio?: string | number;
    workCenterId?: number | null;
    expectedCostAccountId?: number | null;
    notes?: string | null;
    nameEn?: string | null;
    resourceMode: "labor" | "machine" | "both";
    resourceId?: string;
    workerCount?: number;
  }>>([{ nameAr: "", expectedDurationMinutes: 0, resourceMode: "labor", workerCount: 1 }]);
  const [template, setTemplate] = useState({ name: "", productItemId: "", plannedQty: "1", unitCode: "" });
  const [warehouse, setWarehouse] = useState({ code: "", nameAr: "", isDefault: false });
  const [internalTransportEnabled, setInternalTransportEnabled] = useState(
    catalog.accounting?.settings?.internalTransportEnabled === true,
  );
  const [savingTransportSetting, setSavingTransportSetting] = useState(false);

  useEffect(() => {
    setInternalTransportEnabled(catalog.accounting?.settings?.internalTransportEnabled === true);
  }, [catalog.accounting?.settings?.internalTransportEnabled]);

  // Dialog open states
  const [openMat, setOpenMat] = useState(false);
  const [openBom, setOpenBom] = useState(false);
  const [openRouting, setOpenRouting] = useState(false);
  const [openTemplate, setOpenTemplate] = useState(false);
  const [openWarehouse, setOpenWarehouse] = useState(false);
  const [editingBomId, setEditingBomId] = useState<number | null>(null);
  const [editingRoutingId, setEditingRoutingId] = useState<number | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [loadingBomId, setLoadingBomId] = useState<number | null>(null);
  const [loadingRoutingId, setLoadingRoutingId] = useState<number | null>(null);

  const resetBom = () => {
    setEditingBomId(null);
    setBom({ productItemId: "", nameAr: "", outputQty: "1", outputUnitCode: "" });
    setBomLines([{ itemId: "", quantity: "1", unitCode: "" }]);
  };

  const resetRouting = () => {
    setEditingRoutingId(null);
    setRouting({ productItemId: "", nameAr: "" });
    setRoutingStages([{ nameAr: "", expectedDurationMinutes: 0, resourceMode: "labor", workerCount: 1 }]);
  };

  const resetTemplate = () => {
    setEditingTemplateId(null);
    setTemplate({ name: "", productItemId: "", plannedQty: "1", unitCode: "" });
  };

  const startBomCreate = () => {
    resetBom();
    setOpenBom(true);
  };

  const startRoutingCreate = () => {
    resetRouting();
    setOpenRouting(true);
  };

  const startTemplateCreate = () => {
    resetTemplate();
    setOpenTemplate(true);
  };

  const openTemplateForEdit = (row: Catalog["templates"][number]) => {
    const configuration = row.configuration ?? {};
    setEditingTemplateId(row.id);
    setTemplate({
      name: String(row.name ?? ""),
      productItemId: String(configuration.productItemId ?? ""),
      plannedQty: String(configuration.plannedQty ?? "1"),
      unitCode: configuration.unitCode ? String(configuration.unitCode) : "",
    });
    setOpenTemplate(true);
  };

  const openBomForEdit = async (id: number) => {
    setLoadingBomId(id);
    try {
      const detail = await onLoadBom(id);
      const lines = Array.isArray(detail?.lines) ? detail.lines : [];
      setEditingBomId(id);
      setBom({
        productItemId: String(detail?.productItemId ?? ""),
        nameAr: String(detail?.nameAr ?? ""),
        outputQty: String(detail?.outputQty ?? "1"),
        outputUnitCode: detail?.outputUnitCode ? String(detail.outputUnitCode) : "",
      });
      setBomLines(lines.length
        ? lines.map((line: any) => ({
          itemId: line?.itemId == null ? "" : String(line.itemId),
          quantity: String(line?.quantity ?? "1"),
          unitCode: line?.unitCode ? String(line.unitCode) : "",
        }))
        : [{ itemId: "", quantity: "1", unitCode: "" }]);
      setOpenBom(true);
    } catch {
      // The controller owns the toast/error contract. Leave the dialog closed
      // when a detail request fails so stale form values cannot be edited.
    } finally {
      setLoadingBomId(null);
    }
  };

  const openRoutingForEdit = async (id: number) => {
    setLoadingRoutingId(id);
    try {
      const detail = await onLoadRouting(id);
      const stages = Array.isArray(detail?.stages) ? detail.stages : [];
      setEditingRoutingId(id);
      setRouting({
        productItemId: String(detail?.productItemId ?? ""),
        nameAr: String(detail?.nameAr ?? ""),
      });
      setRoutingStages(stages.length
        ? stages
          .slice()
          .sort((a: any, b: any) => Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0))
          .map((stage: any) => ({
            nameAr: String(stage?.nameAr ?? ""),
            expectedDurationMinutes: Number(stage?.expectedDurationMinutes ?? 0) || 0,
            code: stage?.code ? String(stage.code) : undefined,
            expectedCost: stage?.expectedCost ?? 0,
            expectedWasteRatio: stage?.expectedWasteRatio ?? 0,
            workCenterId: stage?.workCenterId == null ? null : Number(stage.workCenterId),
            expectedCostAccountId: stage?.expectedCostAccountId == null ? null : Number(stage.expectedCostAccountId),
            notes: stage?.notes ?? null,
            nameEn: stage?.nameEn ?? null,
            resourceMode: stage?.resourceMode === "machine" || stage?.resourceMode === "both" ? stage.resourceMode : "labor",
            resourceId: stage?.resourceId == null ? "" : String(stage.resourceId),
            workerCount: Number(stage?.workerCount ?? 1) || 1,
          }))
        : [{ nameAr: "", expectedDurationMinutes: 0, resourceMode: "labor", workerCount: 1 }]);
      setOpenRouting(true);
    } catch {
      // The controller owns the toast/error contract.
    } finally {
      setLoadingRoutingId(null);
    }
  };

  const handleSaveMaterial = async () => {
    const row = await onSaveMaterial(material);
    setMaterial({ code: "", nameAr: "", itemNature: "raw", unitId: "" });
    setOpenMat(false);
    if (row && row.id) setBomLines([{ itemId: String(row.id), quantity: "1", unitCode: "" }]);
  };

  return (
    <div dir="rtl" className="grid gap-6 text-start md:grid-cols-2 lg:grid-cols-2">
      <Card className="border-amber-200 bg-amber-50/30 shadow-sm md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-amber-950">النقل الداخلي إلى التصنيع</CardTitle>
          <CardDescription>يسمح بالتقاط تكلفة النقل الجديدة في أذونات التسليم. الإيقاف لا يحذف التاريخ المحفوظ.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm">
            <div className="font-semibold">{internalTransportEnabled ? "التقاط تكلفة النقل مفعّل" : "التقاط تكلفة النقل متوقف"}</div>
            <p className="mt-1 text-xs text-slate-600">يمكن قراءة أذونات النقل السابقة وتكلفتها في تفاصيل الأمر مهما كان الإعداد الحالي.</p>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={internalTransportEnabled}
              disabled={savingTransportSetting || busy}
              onCheckedChange={async (checked) => {
                const previous = internalTransportEnabled;
                setInternalTransportEnabled(checked);
                setSavingTransportSetting(true);
                try {
                  await onSaveAccounting({
                    defaultWipAccountId: catalog.accounting?.settings?.defaultWipAccountId ?? null,
                    defaultRawInventoryAccountId: catalog.accounting?.settings?.defaultRawInventoryAccountId ?? null,
                    defaultFinishedGoodsAccountId: catalog.accounting?.settings?.defaultFinishedGoodsAccountId ?? null,
                    defaultOverheadAccountId: catalog.accounting?.settings?.defaultOverheadAccountId ?? null,
                    defaultWasteAccountId: catalog.accounting?.settings?.defaultWasteAccountId ?? null,
                    electricityTariffPerKwh: catalog.accounting?.settings?.electricityTariffPerKwh == null
                      ? null : Number(catalog.accounting.settings.electricityTariffPerKwh),
                    internalTransportEnabled: checked,
                  });
                } catch {
                  setInternalTransportEnabled(previous);
                } finally {
                  setSavingTransportSetting(false);
                }
              }}
              aria-label="تفعيل النقل الداخلي"
            />
            <span className="text-xs font-medium">{internalTransportEnabled ? "مفعّل" : "متوقف"}</span>
          </div>
        </CardContent>
      </Card>

      {/* Materials & BOM */}
      <Card className="border-violet-100 shadow-sm">
        <CardHeader className="bg-violet-50/50 pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <PackageOpen className="h-5 w-5 text-violet-600" />
            المواد وقوائم المكونات
          </CardTitle>
          <CardDescription>
            تعريف المواد الخام والمنتجات النهائية، وربط المكونات (الوصفات) بالمنتجات.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div className="flex gap-2">
            <Dialog open={openMat} onOpenChange={setOpenMat}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full justify-start" disabled={!canCreate}><Plus className="mr-2 h-4 w-4" /> إضافة صنف (مادة/منتج)</Button>
              </DialogTrigger>
              <DialogContent dir="rtl">
                <DialogHeader><DialogTitle>إضافة صنف جديد</DialogTitle><DialogDescription>أضف مادة خام أو منتج نهائي إلى الكتالوج.</DialogDescription></DialogHeader>
                <div className="space-y-4 py-4">
                  <Input value={material.code} onChange={e => setMaterial({ ...material, code: e.target.value })} placeholder="رمز الصنف (مثال: RAW-01)" />
                  <Input value={material.nameAr} onChange={e => setMaterial({ ...material, nameAr: e.target.value })} placeholder="اسم الصنف (مثال: دقيق)" />
                  <SearchCombobox
                    value={material.itemNature}
                    className="h-10"
                    openOnFocus={false}
                    placeholder="اختر طبيعة الصنف..."
                    searchPlaceholder="ابحث عن طبيعة الصنف..."
                    items={[
                      { value: "raw", label: "مادة خام" },
                      { value: "semi", label: "نصف مصنعة" },
                      { value: "finished", label: "منتج نهائي" },
                      { value: "consumable", label: "مستهلك" },
                    ]}
                    onValueChange={value => setMaterial({ ...material, itemNature: value })}
                  />
                   <div className="space-y-2">
                     <label className="text-sm font-semibold">
                       الوحدة الأساسية <span className="text-destructive">*</span>
                     </label>
                     <SearchCombobox
                       value={material.unitId}
                       className="h-10"
                       openOnFocus={false}
                       placeholder="اختر الوحدة الأساسية..."
                       searchPlaceholder="ابحث عن الوحدة..."
                       items={[
                         { value: "", label: "اختر الوحدة الأساسية..." },
                         ...(catalog.units ?? []).map(unit => ({
                           value: String(unit.id),
                           code: unit.code,
                           label: unit.nameAr,
                           labelEn: unit.code,
                         })),
                       ]}
                       onValueChange={value => setMaterial({ ...material, unitId: value })}
                     />
                   </div>
                    <Button disabled={busy || !canCreate || !material.code || !material.nameAr || !material.unitId} onClick={handleSaveMaterial} className="w-full">
                    حفظ الصنف
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={openBom} onOpenChange={open => { if (!open) { setOpenBom(false); resetBom(); } else setOpenBom(true); }}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full justify-start" disabled={!canEdit} onClick={startBomCreate} data-testid="button-create-bom"><Plus className="mr-2 h-4 w-4" /> ربط قائمة مكونات (بسيطة)</Button>
              </DialogTrigger>
              <DialogContent dir="rtl" className="max-w-2xl max-h-[85vh] overflow-y-auto">
                 <DialogHeader><DialogTitle>{editingBomId ? "تعديل قائمة مكونات مبسطة" : "قائمة مكونات مبسطة"}</DialogTitle><DialogDescription>اربط أي عدد من المواد بالمنتج النهائي.</DialogDescription></DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">المنتج النهائي</label>
                    <SearchCombobox
                      value={bom.productItemId}
                      className="h-10"
                      openOnFocus={false}
                      placeholder="اختر المنتج..."
                      searchPlaceholder="ابحث برمز أو اسم المنتج..."
                      items={[
                        { value: "", label: "اختر المنتج..." },
                        ...catalog.items
                          .filter(i => !i.itemNature || ["finished", "semi", "merchandise"].includes(i.itemNature))
                          .map(i => ({
                            value: String(i.id),
                            code: i.code,
                            label: i.nameAr,
                            labelEn: i.nameEn || undefined,
                          })),
                      ]}
                      onValueChange={value => setBom({ ...bom, productItemId: value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-semibold">الكمية الناتجة</label>
                      <Input type="text" inputMode="decimal" value={bom.outputQty} onChange={e => setBom({ ...bom, outputQty: e.target.value })} placeholder="الكمية الافتراضية" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-semibold">وحدة المنتج (اختياري)</label>
                      <SearchCombobox
                        value={bom.outputUnitCode}
                        className="h-10"
                        openOnFocus={false}
                        placeholder="(افتراضي للصنف)"
                        searchPlaceholder="ابحث عن الوحدة..."
                        items={[
                          { value: "", label: "(افتراضي للصنف)" },
                          ...(catalog.units ?? []).map(u => ({
                            value: u.code,
                            code: u.code,
                            label: u.nameAr,
                          })),
                        ]}
                        onValueChange={value => setBom({ ...bom, outputUnitCode: value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">اسم القائمة</label>
                    <Input value={bom.nameAr} onChange={e => setBom({ ...bom, nameAr: e.target.value })} placeholder="اسم القائمة (مثال: وصفة الخبز الأساسية)" />
                  </div>
                   <div className="space-y-2">
                     <div className="text-sm font-semibold text-slate-700">المواد المطلوبة للإنتاج</div>
                     {bomLines.map((line, index) => (
                       <div key={index} className="flex items-center gap-2">
                          <SearchCombobox
                            value={line.itemId}
                            className="h-10 flex-[2]"
                            openOnFocus={false}
                            placeholder="اختر المادة..."
                            searchPlaceholder="ابحث برمز أو اسم المادة..."
                            items={[
                              { value: "", label: "اختر المادة..." },
                              ...catalog.items
                                .filter(i => !i.itemNature || ["raw", "semi", "consumable"].includes(i.itemNature))
                                .map(i => ({
                                  value: String(i.id),
                                  code: i.code,
                                  label: i.nameAr,
                                  labelEn: i.nameEn || undefined,
                                })),
                            ]}
                            onValueChange={value => setBomLines(lines => lines.map((current, i) => i === index
                              ? { ...current, itemId: value }
                              : current))}
                          />
                         <Input className="flex-[1] min-w-[80px]" type="text" inputMode="decimal" value={line.quantity}
                           onChange={e => setBomLines(lines => lines.map((current, i) => i === index
                             ? { ...current, quantity: e.target.value }
                             : current))}
                           placeholder="الكمية" />
                          <SearchCombobox
                            value={line.unitCode}
                            className="h-10 flex-[1]"
                            openOnFocus={false}
                            placeholder="(افتراضي)"
                            searchPlaceholder="ابحث عن الوحدة..."
                            items={[
                              { value: "", label: "(افتراضي)" },
                              ...(catalog.units ?? []).map(u => ({
                                value: u.code,
                                code: u.code,
                                label: u.nameAr,
                              })),
                            ]}
                            onValueChange={value => setBomLines(lines => lines.map((current, i) => i === index
                              ? { ...current, unitCode: value }
                              : current))}
                          />
                         <Button type="button" variant="ghost" size="icon" className="text-destructive"
                           disabled={bomLines.length <= 1}
                           onClick={() => setBomLines(lines => lines.filter((_, i) => i !== index))}>
                           ×
                         </Button>
                       </div>
                     ))}
                     <Button type="button" variant="outline" size="sm"
                       onClick={() => setBomLines(lines => [...lines, { itemId: "", quantity: "1", unitCode: "" }])}
                       disabled={!canEdit}>
                       <Plus className="mr-1 h-4 w-4" /> إضافة مادة
                     </Button>
                   </div>
                   <div className="bg-slate-50 p-2 text-xs text-slate-500 rounded border">ملاحظة: إذا تركت الوحدة فارغة سيتم استخدام وحدة القياس الأساسية للصنف.</div>
                    <Button disabled={busy || !canEdit || !bom.productItemId || !bomLines.length || bomLines.some(line => !line.itemId || !(Number(line.quantity) > 0))}
                     onClick={async () => {
                        await onSaveBom({ ...bom, id: editingBomId ?? undefined, lines: bomLines });
                        setOpenBom(false);
                        resetBom();
                     }} className="w-full">
                     {editingBomId ? "تحديث القائمة" : "حفظ القائمة"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {catalog.bomTemplates && catalog.bomTemplates.length > 0 && (
            <div className="space-y-2 mt-2">
              <div className="text-sm font-semibold text-slate-600">الأصناف المحفوظة</div>
              <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto">
                {catalog.items.map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-violet-100 bg-violet-50/40 px-3 py-2 text-sm">
                    <span className="font-medium">{item.nameAr}</span>
                    <span className="text-xs text-muted-foreground" dir="ltr">{item.code}{item.unitCode ? ` · ${item.unitCode}` : ""}</span>
                  </div>
                ))}
                {!catalog.items.length && <span className="text-sm text-muted-foreground">لم تُضف أصناف بعد.</span>}
              </div>
              <div className="text-sm font-semibold text-slate-600">قوائم المواد المحفوظة</div>
              <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                {catalog.bomTemplates.map(b => (
                   <div
                     key={b.id}
                     className={`text-sm bg-white border border-slate-200 px-3 py-2 rounded-md shadow-sm flex flex-col ${canEdit ? "cursor-pointer hover:border-violet-300 hover:bg-violet-50/30" : ""}`}
                     onDoubleClick={() => { if (canEdit) void openBomForEdit(b.id); }}
                     data-testid={`card-bom-${b.id}`}
                     role={canEdit ? "button" : undefined}
                     tabIndex={canEdit ? 0 : undefined}
                   >
                    <span className="font-semibold text-violet-700">{b.nameAr}</span>
                     <span className="text-xs text-slate-500">{b.productNameAr} • {b.linesCount} مكونات</span>
                     {loadingBomId === b.id && <span className="text-xs text-violet-500">جارٍ تحميل القائمة…</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-sm text-slate-500 bg-slate-50 p-3 rounded-lg border">
            <b>تلميح:</b> لإنشاء وصفات معقدة بأسطر متعددة بشكل أسهل، يمكنك إنشاء القائمة مباشرة من داخل شاشة إعداد أمر التصنيع الجديد.
          </div>
        </CardContent>
      </Card>

      {/* Routing */}
      <Card className="border-violet-100 shadow-sm">
        <CardHeader className="bg-violet-50/50 pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <GitBranch className="h-5 w-5 text-violet-600" />
            مسارات ومراحل الإنتاج
          </CardTitle>
          <CardDescription>
            تحديد الخطوات التي يمر بها المنتج (اختياري، يمكن التصنيع بدون مسار).
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <Dialog open={openRouting} onOpenChange={open => { if (!open) { setOpenRouting(false); resetRouting(); } else setOpenRouting(true); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start" disabled={!canEdit} onClick={startRoutingCreate} data-testid="button-create-routing"><Plus className="mr-2 h-4 w-4" /> مسار إنتاج جديد</Button>
            </DialogTrigger>
            <DialogContent dir="rtl" className="max-w-xl max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>{editingRoutingId ? "تعديل مسار الإنتاج" : "مسار إنتاج جديد"}</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-semibold">المنتج المرتبط</label>
                  <SearchCombobox
                    value={routing.productItemId}
                    className="h-10"
                    openOnFocus={false}
                    placeholder="اختر المنتج..."
                    searchPlaceholder="ابحث برمز أو اسم المنتج..."
                    items={[
                      { value: "", label: "اختر المنتج..." },
                      ...catalog.items.map(i => ({
                        value: String(i.id),
                        code: i.code,
                        label: i.nameAr,
                        labelEn: i.nameEn || undefined,
                      })),
                    ]}
                    onValueChange={value => setRouting({ ...routing, productItemId: value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-semibold">اسم المسار</label>
                  <Input value={routing.nameAr} onChange={e => setRouting({ ...routing, nameAr: e.target.value })} placeholder="اسم المسار (مثال: خط الخبز)" />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-700">مراحل الإنتاج بالترتيب</div>
                  {routingStages.map((stage, index) => (
                     <div key={index} className="rounded-lg border bg-slate-50/50 p-3 space-y-3">
                       <div className="flex items-center gap-2">
                         <div className="w-6 h-6 shrink-0 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-500">{index + 1}</div>
                         <Input className="flex-[2]" value={stage.nameAr} onChange={e => setRoutingStages(stages => stages.map((s, i) => i === index ? { ...s, nameAr: e.target.value } : s))} placeholder="اسم المرحلة (مثال: العجن)" />
                         <Input className="flex-[1]" type="text" inputMode="numeric" value={stage.expectedDurationMinutes || ""} onChange={e => setRoutingStages(stages => stages.map((s, i) => i === index ? { ...s, expectedDurationMinutes: Number(e.target.value) || 0 } : s))} placeholder="المدة (دقيقة)" />
                         <Button type="button" variant="ghost" size="icon" className="text-destructive shrink-0"
                           disabled={routingStages.length <= 1}
                           onClick={() => setRoutingStages(stages => stages.filter((_, i) => i !== index))}>
                           ×
                         </Button>
                       </div>
                       <div className="grid gap-3 sm:grid-cols-3">
                         <div className="space-y-1">
                           <label className="text-xs font-medium text-slate-600">موارد المرحلة</label>
                           <SearchCombobox
                             value={stage.resourceMode}
                             items={[
                               { value: "labor", label: "عمالة فقط" },
                               { value: "machine", label: "آلة فقط" },
                               { value: "both", label: "آلة + عمالة" },
                             ]}
                             onValueChange={value => setRoutingStages(stages => stages.map((s, i) => i === index
                               ? { ...s, resourceMode: value === "machine" || value === "both" ? value : "labor" }
                               : s))}
                           />
                         </div>
                         {(stage.resourceMode === "labor" || stage.resourceMode === "both") && (
                           <div className="space-y-1">
                             <label className="text-xs font-medium text-slate-600">عدد العمال</label>
                             <Input type="text" inputMode="numeric" dir="ltr" value={stage.workerCount ?? ""}
                               onChange={e => setRoutingStages(stages => stages.map((s, i) => i === index
                                 ? { ...s, workerCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) }
                                 : s))} />
                           </div>
                         )}
                         {(stage.resourceMode === "machine" || stage.resourceMode === "both") && (
                           <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">آلة المرحلة</label>
                              <SearchCombobox
                                value={stage.resourceId ?? ""}
                                placeholder="اختر آلة محفوظة…"
                                searchPlaceholder="ابحث عن آلة…"
                                items={[
                                  { value: "", label: "اختر آلة محفوظة…" },
                                  ...(catalog.machines ?? []).map(machine => ({
                                    value: String(machine.id),
                                    label: machine.name,
                                  })),
                                ]}
                                onValueChange={resourceId => setRoutingStages(stages => stages.map((s, i) => i === index
                                  ? { ...s, resourceId }
                                  : s))}
                              />
                              {(() => {
                                const machine = (catalog.machines ?? []).find(row => String(row.id) === stage.resourceId);
                                if (!machine?.electricityEnabled) return null;
                                 return <p className="text-[11px] leading-5 text-amber-800">كهرباء مفعلة ({machine.electricityKw ?? "—"} kW): عند تنفيذ أمر v1 تُجمّد ساعات الآلة وkWh/التعريفة. مع فاتورة صناعية مرتبطة تبقى المعالجة مرتبطة بالمصدر؛ بلا فاتورة يرسمل الخادم التقدير المجمد في الاستلام بحساب الاستحقاق/الامتصاص ثم تُحدّد الفاتورة والمصنع ومركز التكلفة صراحةً في الإقفال لتصفية التقدير وتسوية الفرق فقط.</p>;
                              })()}
                           </div>
                         )}
                       </div>
                       <p className="text-[11px] text-slate-500">
                          تستخدم المرحلة ساعات تشغيل واحدة فقط. بيانات الطاقة مرتبطة بالآلة المختارة؛ لا توجد ساعات كهرباء أو إهلاك منفصلة.
                       </p>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm"
                     onClick={() => setRoutingStages(stages => [...stages, { nameAr: "", expectedDurationMinutes: 0, resourceMode: "labor", workerCount: 1 }])}
                    disabled={!canEdit}>
                    <Plus className="mr-1 h-4 w-4" /> إضافة مرحلة
                  </Button>
                </div>

                <Button disabled={busy || !canEdit || !routing.productItemId || routingStages.some(s =>
                  !s.nameAr ||
                  ((s.resourceMode === "labor" || s.resourceMode === "both") && !(Number.isInteger(s.workerCount) && Number(s.workerCount) > 0)) ||
                  ((s.resourceMode === "machine" || s.resourceMode === "both") && !(Number.isInteger(Number(s.resourceId)) && Number(s.resourceId) > 0))
                )} onClick={async () => { await onSaveRouting({ ...routing, id: editingRoutingId ?? undefined, stages: routingStages }); setOpenRouting(false); resetRouting(); }} className="w-full">
                  {editingRoutingId ? "تحديث المسار" : "حفظ المسار"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {catalog.routings && catalog.routings.length > 0 ? (
            <div className="space-y-2 mt-2">
              <div className="text-sm font-semibold text-slate-600">مسارات الإنتاج المحفوظة</div>
              <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                {catalog.routings.map(r => (
                  <div
                    key={r.id}
                    className={`text-sm bg-white border border-slate-200 px-3 py-2 rounded-md shadow-sm flex flex-col gap-1 ${canEdit ? "cursor-pointer hover:border-violet-300 hover:bg-violet-50/30" : ""}`}
                    onDoubleClick={() => { if (canEdit) void openRoutingForEdit(r.id); }}
                    data-testid={`card-routing-${r.id}`}
                    role={canEdit ? "button" : undefined}
                    tabIndex={canEdit ? 0 : undefined}
                  >
                    <div className="flex justify-between items-start">
                      <span className="font-semibold text-violet-700">{r.nameAr}</span>
                      <span className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">{r.productNameAr}</span>
                    </div>
                    {loadingRoutingId === r.id && <div className="text-xs text-violet-500">جارٍ تحميل المسار…</div>}
                    {r.stages && r.stages.length > 0 ? (
                      <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-1">
                        {r.stages.map((st, idx) => (
                          <span key={st.id || idx} className="bg-violet-50 text-violet-600 px-1.5 py-0.5 rounded flex items-center">
                            <span className="opacity-50 mr-1">{idx + 1}.</span> {st.nameAr}
                            {st.plannedMinutes ? <span className="mr-1 opacity-75">({st.plannedMinutes}د)</span> : null}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 mt-1">عدد المراحل: {r.stagesCount || 0}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-500 bg-slate-50 p-3 rounded-lg border">
              المسارات النشطة حالياً: <span className="font-semibold text-slate-700">0</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fast Templates */}
      <Card className="border-violet-100 shadow-sm">
        <CardHeader className="bg-violet-50/50 pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5 text-violet-600" />
            قوالب الأوامر السريعة
          </CardTitle>
          <CardDescription>
            حفظ إعدادات أمر التصنيع المتكررة لإنشائه بنقرة واحدة لاحقاً.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <Dialog open={openTemplate} onOpenChange={open => { setOpenTemplate(open); if (!open) resetTemplate(); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start" disabled={!canCreate} onClick={startTemplateCreate}><Plus className="mr-2 h-4 w-4" /> قالب أمر جديد</Button>
            </DialogTrigger>
            <DialogContent dir="rtl">
              <DialogHeader><DialogTitle>{editingTemplateId ? "تعديل قالب الأمر" : "حفظ كقالب متكرر"}</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-semibold">اسم القالب</label>
                  <Input value={template.name} onChange={e => setTemplate({ ...template, name: e.target.value })} placeholder="اسم القالب (مثال: طلبية المخبز اليومية)" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-semibold">المنتج الافتراضي</label>
                  <SearchCombobox
                    value={template.productItemId}
                    className="h-10"
                    openOnFocus={false}
                    placeholder="اختر المنتج الافتراضي..."
                    searchPlaceholder="ابحث برمز أو اسم المنتج..."
                    items={[
                      { value: "", label: "اختر المنتج الافتراضي..." },
                      ...catalog.items
                        .filter(i => !i.itemNature || ["finished", "semi", "merchandise"].includes(i.itemNature))
                        .map(i => ({
                          value: String(i.id),
                          code: i.code,
                          label: i.nameAr,
                          labelEn: i.nameEn || undefined,
                        })),
                    ]}
                    onValueChange={value => setTemplate({ ...template, productItemId: value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">الكمية الافتراضية</label>
                    <Input type="text" inputMode="decimal" value={template.plannedQty} onChange={e => setTemplate({ ...template, plannedQty: e.target.value })} placeholder="الكمية" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">وحدة القياس</label>
                    <SearchCombobox
                      value={template.unitCode}
                      className="h-10"
                      openOnFocus={false}
                      placeholder="(افتراضي للصنف)"
                      searchPlaceholder="ابحث عن الوحدة..."
                      items={[
                        { value: "", label: "(افتراضي للصنف)" },
                        ...(catalog.units ?? []).map(u => ({
                          value: u.code,
                          code: u.code,
                          label: u.nameAr,
                        })),
                      ]}
                      onValueChange={value => setTemplate({ ...template, unitCode: value })}
                    />
                  </div>
                </div>
                <div className="bg-slate-50 p-2 text-xs text-slate-500 rounded border">ملاحظة: إذا تركت الوحدة فارغة سيتم استخدام وحدة القياس الأساسية للصنف عند تطبيق القالب.</div>
                <Button
                  disabled={busy || (editingTemplateId ? !canEdit : !canCreate) || !template.productItemId || !template.name}
                  onClick={async () => {
                    try {
                      await onSaveTemplate({ ...template, id: editingTemplateId ?? undefined });
                      setOpenTemplate(false);
                      resetTemplate();
                    } catch { /* The parent displays the error; keep edits open. */ }
                  }}
                  className="w-full"
                >
                  {editingTemplateId ? "تحديث القالب" : "حفظ القالب"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
            {catalog.templates.map(t => (
              <div
                key={t.id}
                className={`text-sm bg-white text-violet-900 p-3 rounded-md border border-violet-100 shadow-sm flex flex-col ${canEdit ? "cursor-pointer hover:border-violet-300 hover:bg-violet-50/30" : ""}`}
                onDoubleClick={() => { if (canEdit) openTemplateForEdit(t); }}
                onKeyDown={e => {
                  if (canEdit && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openTemplateForEdit(t);
                  }
                }}
                data-testid={`card-template-${t.id}`}
                role={canEdit ? "button" : undefined}
                tabIndex={canEdit ? 0 : undefined}
              >
                <span className="font-semibold">{t.name}</span>
                <span className="text-xs text-slate-500 mt-1">الكمية: {t.configuration?.plannedQty || 1} {t.configuration?.unitCode ? `(${t.configuration.unitCode})` : ""}</span>
              </div>
            ))}
            {catalog.templates.length === 0 && <span className="text-sm text-slate-400">لا توجد قوالب محفوظة.</span>}
          </div>
        </CardContent>
      </Card>

      {/* Warehouses */}
      <Card className="border-violet-100 shadow-sm">
        <CardHeader className="bg-violet-50/50 pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Server className="h-5 w-5 text-violet-600" />
            المخازن
          </CardTitle>
          <CardDescription>
            إضافة مخازن الخامات ومستودعات الإنتاج التام.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <Dialog open={openWarehouse} onOpenChange={setOpenWarehouse}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start" disabled={!canCreate}><Plus className="mr-2 h-4 w-4" /> إضافة مخزن جديد</Button>
            </DialogTrigger>
            <DialogContent dir="rtl">
              <DialogHeader><DialogTitle>مخزن جديد</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <Input value={warehouse.code} onChange={e => setWarehouse({ ...warehouse, code: e.target.value })} placeholder="رمز المخزن (مثال: W-01)" />
                <Input value={warehouse.nameAr} onChange={e => setWarehouse({ ...warehouse, nameAr: e.target.value })} placeholder="اسم المخزن (مثال: مستودع التبريد)" />
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" className="rounded text-violet-600" checked={warehouse.isDefault} onChange={e => setWarehouse({ ...warehouse, isDefault: e.target.checked })} />
                  تعيين كمخزن افتراضي
                </label>
                <Button disabled={busy || !canCreate || !warehouse.code || !warehouse.nameAr} onClick={async () => { await onSaveWarehouse(warehouse); setOpenWarehouse(false); setWarehouse({ code: "", nameAr: "", isDefault: false }); }} className="w-full">
                  حفظ المخزن
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <div className="flex flex-wrap gap-2">
            {catalog.warehouses.map(w => (
              <div key={w.id} className="text-xs bg-slate-100 text-slate-800 px-2 py-1 rounded-md border flex items-center gap-1">
                {w.nameAr} {w.isDefault && <span className="text-[10px] bg-slate-200 px-1 rounded text-slate-500">افتراضي</span>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
