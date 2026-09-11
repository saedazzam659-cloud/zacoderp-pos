import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Boxes, GitBranch, FileText, Plus, Save, Server, PackageOpen } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import type { Catalog } from "./types";

export function SimpleSetup({
  catalog,
  busy,
   canCreate,
   canEdit,
  onSaveMaterial,
  onSaveBom,
  onSaveRouting,
  onSaveTemplate,
  onSaveWarehouse
}: {
  catalog: Catalog;
  busy: boolean;
   canCreate: boolean;
   canEdit: boolean;
  onSaveMaterial: (data: { code: string; nameAr: string; itemNature: string }) => Promise<any>;
  onSaveBom: (data: { productItemId: string; nameAr: string; outputQty: string; outputUnitCode: string; lines: Array<{ itemId: string; quantity: string; unitCode: string }> }) => Promise<unknown>;
  onSaveRouting: (data: { productItemId: string; nameAr: string; stages: Array<{ nameAr: string; expectedDurationMinutes?: number }> }) => Promise<unknown>;
  onSaveTemplate: (data: { name: string; productItemId: string; plannedQty: string; unitCode: string }) => Promise<unknown>;
  onSaveWarehouse: (data: { code: string; nameAr: string; isDefault: boolean }) => Promise<unknown>;
}) {
  const [material, setMaterial] = useState({ code: "", nameAr: "", itemNature: "raw" });
  const [bom, setBom] = useState({ productItemId: "", nameAr: "", outputQty: "1", outputUnitCode: "" });
  const [bomLines, setBomLines] = useState<Array<{ itemId: string; quantity: string; unitCode: string }>>([{ itemId: "", quantity: "1", unitCode: "" }]);
  const [routing, setRouting] = useState({ productItemId: "", nameAr: "" });
  const [routingStages, setRoutingStages] = useState<Array<{ nameAr: string; expectedDurationMinutes: number }>>([{ nameAr: "", expectedDurationMinutes: 0 }]);
  const [template, setTemplate] = useState({ name: "", productItemId: "", plannedQty: "1", unitCode: "" });
  const [warehouse, setWarehouse] = useState({ code: "", nameAr: "", isDefault: false });

  // Dialog open states
  const [openMat, setOpenMat] = useState(false);
  const [openBom, setOpenBom] = useState(false);
  const [openRouting, setOpenRouting] = useState(false);
  const [openTemplate, setOpenTemplate] = useState(false);
  const [openWarehouse, setOpenWarehouse] = useState(false);

  const handleSaveMaterial = async () => {
    const row = await onSaveMaterial(material);
    setMaterial({ code: "", nameAr: "", itemNature: "raw" });
    setOpenMat(false);
    if (row && row.id) setBomLines([{ itemId: String(row.id), quantity: "1", unitCode: "" }]);
  };

  return (
    <div dir="rtl" className="grid gap-6 text-start md:grid-cols-2 lg:grid-cols-2">

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
                   <Button disabled={busy || !canCreate || !material.code || !material.nameAr} onClick={handleSaveMaterial} className="w-full">
                    حفظ الصنف
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={openBom} onOpenChange={setOpenBom}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full justify-start" disabled={!canEdit}><Plus className="mr-2 h-4 w-4" /> ربط قائمة مكونات (بسيطة)</Button>
              </DialogTrigger>
              <DialogContent dir="rtl" className="max-w-2xl max-h-[85vh] overflow-y-auto">
                 <DialogHeader><DialogTitle>قائمة مكونات مبسطة</DialogTitle><DialogDescription>اربط أي عدد من المواد بالمنتج النهائي.</DialogDescription></DialogHeader>
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
                       await onSaveBom({ ...bom, lines: bomLines });
                       setOpenBom(false);
                       setBom({ productItemId: "", nameAr: "", outputQty: "1", outputUnitCode: "" });
                       setBomLines([{ itemId: "", quantity: "1", unitCode: "" }]);
                     }} className="w-full">
                    حفظ القائمة
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
                  <div key={b.id} className="text-sm bg-white border border-slate-200 px-3 py-2 rounded-md shadow-sm flex flex-col">
                    <span className="font-semibold text-violet-700">{b.nameAr}</span>
                    <span className="text-xs text-slate-500">{b.productNameAr} • {b.linesCount} مكونات</span>
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
          <Dialog open={openRouting} onOpenChange={setOpenRouting}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start" disabled={!canEdit}><Plus className="mr-2 h-4 w-4" /> مسار إنتاج جديد</Button>
            </DialogTrigger>
            <DialogContent dir="rtl" className="max-w-xl max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>مسار إنتاج جديد</DialogTitle></DialogHeader>
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
                    <div key={index} className="flex items-center gap-2">
                      <div className="w-6 h-6 shrink-0 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-500">{index + 1}</div>
                      <Input className="flex-[2]" value={stage.nameAr} onChange={e => setRoutingStages(stages => stages.map((s, i) => i === index ? { ...s, nameAr: e.target.value } : s))} placeholder="اسم المرحلة (مثال: العجن)" />
                      <div className="flex-[1] flex items-center gap-1">
                        <Input type="text" inputMode="numeric" value={stage.expectedDurationMinutes || ""} onChange={e => setRoutingStages(stages => stages.map((s, i) => i === index ? { ...s, expectedDurationMinutes: Number(e.target.value) || 0 } : s))} placeholder="المدة (دقيقة)" />
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="text-destructive shrink-0"
                        disabled={routingStages.length <= 1}
                        onClick={() => setRoutingStages(stages => stages.filter((_, i) => i !== index))}>
                        ×
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setRoutingStages(stages => [...stages, { nameAr: "", expectedDurationMinutes: 0 }])}
                    disabled={!canEdit}>
                    <Plus className="mr-1 h-4 w-4" /> إضافة مرحلة
                  </Button>
                </div>

                <Button disabled={busy || !canEdit || !routing.productItemId || routingStages.some(s => !s.nameAr)} onClick={async () => { await onSaveRouting({ ...routing, stages: routingStages }); setOpenRouting(false); setRouting({ productItemId: "", nameAr: "" }); setRoutingStages([{ nameAr: "", expectedDurationMinutes: 0 }]); }} className="w-full">
                  حفظ المسار
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {catalog.routings && catalog.routings.length > 0 ? (
            <div className="space-y-2 mt-2">
              <div className="text-sm font-semibold text-slate-600">مسارات الإنتاج المحفوظة</div>
              <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                {catalog.routings.map(r => (
                  <div key={r.id} className="text-sm bg-white border border-slate-200 px-3 py-2 rounded-md shadow-sm flex flex-col gap-1">
                    <div className="flex justify-between items-start">
                      <span className="font-semibold text-violet-700">{r.nameAr}</span>
                      <span className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">{r.productNameAr}</span>
                    </div>
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
          <Dialog open={openTemplate} onOpenChange={setOpenTemplate}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start" disabled={!canCreate}><Plus className="mr-2 h-4 w-4" /> قالب أمر جديد</Button>
            </DialogTrigger>
            <DialogContent dir="rtl">
              <DialogHeader><DialogTitle>حفظ كقالب متكرر</DialogTitle></DialogHeader>
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
                <Button disabled={busy || !canCreate || !template.productItemId || !template.name} onClick={async () => { await onSaveTemplate(template); setOpenTemplate(false); setTemplate({ name: "", productItemId: "", plannedQty: "1", unitCode: "" }); }} className="w-full">
                  حفظ القالب
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
            {catalog.templates.map(t => (
              <div key={t.id} className="text-sm bg-white text-violet-900 p-3 rounded-md border border-violet-100 shadow-sm flex flex-col">
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
