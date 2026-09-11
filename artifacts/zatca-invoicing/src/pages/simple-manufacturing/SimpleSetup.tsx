import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Boxes, GitBranch, FileText, Plus, Save, Server, PackageOpen } from "lucide-react";
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
    onSaveBom: (data: { productItemId: string; nameAr: string; lines: Array<{ itemId: string; quantity: string }> }) => Promise<unknown>;
   onSaveRouting: (data: { productItemId: string; nameAr: string; stage: string }) => Promise<unknown>;
   onSaveTemplate: (data: { name: string; productItemId: string; plannedQty: string }) => Promise<unknown>;
   onSaveWarehouse: (data: { code: string; nameAr: string; isDefault: boolean }) => Promise<unknown>;
}) {
  const [material, setMaterial] = useState({ code: "", nameAr: "", itemNature: "raw" });
  const [bom, setBom] = useState({ productItemId: "", nameAr: "" });
  const [bomLines, setBomLines] = useState<Array<{ itemId: string; quantity: string }>>([{ itemId: "", quantity: "1" }]);
  const [routing, setRouting] = useState({ productItemId: "", nameAr: "", stage: "" });
  const [template, setTemplate] = useState({ name: "", productItemId: "", plannedQty: "1" });
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
    if (row && row.id) setBomLines([{ itemId: String(row.id), quantity: "1" }]);
  };

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-2">

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
                  <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background" value={material.itemNature} onChange={e => setMaterial({ ...material, itemNature: e.target.value })}>
                    <option value="raw">مادة خام</option>
                    <option value="semi">نصف مصنعة</option>
                    <option value="finished">منتج نهائي</option>
                    <option value="consumable">مستهلك</option>
                  </select>
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
              <DialogContent dir="rtl">
                 <DialogHeader><DialogTitle>قائمة مكونات مبسطة</DialogTitle><DialogDescription>اربط أي عدد من المواد الخام أو نصف المصنعة بالمنتج النهائي.</DialogDescription></DialogHeader>
                <div className="space-y-4 py-4">
                  <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={bom.productItemId} onChange={e => setBom({ ...bom, productItemId: e.target.value })}>
                    <option value="">اختر المنتج النهائي...</option>
                    {catalog.items.filter(i => !i.itemNature || ["finished", "semi", "merchandise"].includes(i.itemNature)).map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
                  </select>
                  <Input value={bom.nameAr} onChange={e => setBom({ ...bom, nameAr: e.target.value })} placeholder="اسم القائمة (مثال: وصفة الخبز الأساسية)" />
                   <div className="space-y-2">
                     <div className="text-sm font-semibold text-slate-700">المواد</div>
                     {bomLines.map((line, index) => (
                       <div key={index} className="flex items-center gap-2">
                         <select className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                           value={line.itemId}
                           onChange={e => setBomLines(lines => lines.map((current, i) => i === index
                             ? { ...current, itemId: e.target.value }
                             : current))}>
                           <option value="">اختر المادة...</option>
                           {catalog.items
                             .filter(i => !i.itemNature || ["raw", "semi", "consumable"].includes(i.itemNature))
                             .map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
                         </select>
                         <Input className="w-24" type="number" min="0.0001" step="0.0001" value={line.quantity}
                           onChange={e => setBomLines(lines => lines.map((current, i) => i === index
                             ? { ...current, quantity: e.target.value }
                             : current))}
                           placeholder="الكمية" />
                         <Button type="button" variant="ghost" size="icon" className="text-destructive"
                           disabled={bomLines.length <= 1}
                           onClick={() => setBomLines(lines => lines.filter((_, i) => i !== index))}>
                           ×
                         </Button>
                       </div>
                     ))}
                     <Button type="button" variant="outline" size="sm"
                       onClick={() => setBomLines(lines => [...lines, { itemId: "", quantity: "1" }])}
                       disabled={!canEdit}>
                       <Plus className="mr-1 h-4 w-4" /> إضافة مادة
                     </Button>
                   </div>
                   <Button disabled={busy || !canEdit || !bom.productItemId || !bomLines.length || bomLines.some(line => !line.itemId || !(Number(line.quantity) > 0))}
                     onClick={async () => {
                       await onSaveBom({ ...bom, lines: bomLines });
                       setOpenBom(false);
                       setBom({ productItemId: "", nameAr: "" });
                       setBomLines([{ itemId: "", quantity: "1" }]);
                     }} className="w-full">
                    حفظ القائمة
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
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
            <DialogContent dir="rtl">
              <DialogHeader><DialogTitle>مسار إنتاج مبسط</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={routing.productItemId} onChange={e => setRouting({ ...routing, productItemId: e.target.value })}>
                  <option value="">اختر المنتج...</option>
                  {catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
                </select>
                <Input value={routing.nameAr} onChange={e => setRouting({ ...routing, nameAr: e.target.value })} placeholder="اسم المسار (مثال: خط الخبز)" />
                <Input value={routing.stage} onChange={e => setRouting({ ...routing, stage: e.target.value })} placeholder="اسم المرحلة الأولى (مثال: العجن والخبز)" />
                <Button disabled={busy || !canEdit || !routing.productItemId} onClick={async () => { await onSaveRouting(routing); setOpenRouting(false); setRouting({ productItemId: "", nameAr: "", stage: "" }); }} className="w-full">
                  حفظ المسار
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <div className="text-sm text-slate-500 bg-slate-50 p-3 rounded-lg border">
            المسارات النشطة حالياً: <span className="font-semibold text-slate-700">{catalog.routings.length}</span>
          </div>
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
                <Input value={template.name} onChange={e => setTemplate({ ...template, name: e.target.value })} placeholder="اسم القالب (مثال: طلبية المخبز اليومية)" />
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={template.productItemId} onChange={e => setTemplate({ ...template, productItemId: e.target.value })}>
                  <option value="">اختر المنتج الافتراضي...</option>
                  {catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
                </select>
                <Input type="number" value={template.plannedQty} onChange={e => setTemplate({ ...template, plannedQty: e.target.value })} placeholder="الكمية الافتراضية" />
                <Button disabled={busy || !canCreate || !template.productItemId || !template.name} onClick={async () => { await onSaveTemplate(template); setOpenTemplate(false); setTemplate({ name: "", productItemId: "", plannedQty: "1" }); }} className="w-full">
                  حفظ القالب
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <div className="flex flex-wrap gap-2">
            {catalog.templates.map(t => (
              <div key={t.id} className="text-xs bg-violet-100 text-violet-800 px-2 py-1 rounded-md border border-violet-200">
                {t.name}
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
