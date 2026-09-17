import React, { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, ListOrdered, LockKeyhole, PackageCheck, Plus, Printer, Save, Settings2, Trash2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { InvoiceSearchCombobox, type InvoiceComboOption } from "./_shared/InvoiceSearchCombobox";
import "./_group.css";

type DeliveryLine = { id: string; itemId: string; code: string; unit: string; qty: string; note: string };

const warehouses: InvoiceComboOption[] = [
  { value: "central", code: "WH-01", label: "المستودع المركزي" },
  { value: "raw", code: "WH-04", label: "مستودع المواد الخام" },
];
const productionWarehouses: InvoiceComboOption[] = [
  { value: "production-a", code: "PRD-01", label: "مستودع الإنتاج — خط A" },
  { value: "production-b", code: "PRD-02", label: "مستودع الإنتاج — خط B" },
];
const orders: InvoiceComboOption[] = [
  { value: "mo-2418", code: "MO-2025-2418", label: "إنتاج خلطة العزل — الدفعة 06" },
  { value: "mo-2423", code: "MO-2025-2423", label: "إنتاج بلاط الأرصفة — الدفعة 02" },
];
const items: InvoiceComboOption[] = [
  { value: "resin", code: "RM-1016", label: "راتنج إيبوكسي صناعي" },
  { value: "sand", code: "RM-2081", label: "رمل سيليكا مغسول" },
  { value: "pigment", code: "RM-3044", label: "صبغة أكسيد رمادي" },
  { value: "pack", code: "PK-0112", label: "عبوات تعبئة 20 لتر" },
];
const initialLines: DeliveryLine[] = [
  { id: "d-1", itemId: "resin", code: "RM-1016", unit: "برميل", qty: "8", note: "لخط الخلط A" },
  { id: "d-2", itemId: "sand", code: "RM-2081", unit: "طن", qty: "3.5", note: "" },
  { id: "d-3", itemId: "pigment", code: "RM-3044", unit: "كجم", qty: "42", note: "" },
];
const orderCostFixtures: Record<string, { priorTransport: number; baseProduction: number; notes: number }> = {
  "mo-2418": { priorTransport: 620, baseProduction: 18450, notes: 3 },
  "mo-2423": { priorTransport: 410, baseProduction: 12780, notes: 2 },
};

const amount = (value: string) => Number(value.replace(/,/g, "")) || 0;
const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className}`}><Label className="text-xs">{label}</Label>{children}</div>;
}

export function InternalDelivery() {
  const [tab, setTab] = useState(() => typeof window !== "undefined" && ["items", "costs"].includes(new URLSearchParams(window.location.search).get("tab") ?? "") ? new URLSearchParams(window.location.search).get("tab")! : "basic");
  const [number] = useState("IDN-2026-00137");
  const [date, setDate] = useState("2026-06-13");
  const [fromWarehouse, setFromWarehouse] = useState("central");
  const [toWarehouse, setToWarehouse] = useState("production-a");
  const [order, setOrder] = useState("mo-2418");
  const [lines, setLines] = useState<DeliveryLine[]>(initialLines);
  const [notes, setNotes] = useState("تسليم المواد للدفعة الصباحية حسب خطة الإنتاج.");
  const [transportEnabled, setTransportEnabled] = useState(true);
  const [transport, setTransport] = useState("275.00");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [status, setStatus] = useState<"draft" | "posted">("draft");
  const [notice, setNotice] = useState("");
  const locked = status === "posted";
  const quantitiesByUnit = useMemo(() => lines.reduce<Record<string, number>>((all, line) => ({ ...all, [line.unit || "بدون وحدة"]: (all[line.unit || "بدون وحدة"] || 0) + amount(line.qty) }), {}), [lines]);
  const selectedOrder = orders.find((entry) => entry.value === order);
  const validTransport = () => { const raw = transport.trim().replace(/,/g, ""); return raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0; };

  const updateLine = (id: string, key: keyof DeliveryLine, value: string) => setLines((all) => all.map((line) => line.id === id ? { ...line, [key]: value } : line));
  const setItem = (id: string, itemId: string) => {
    const selected = items.find((item) => item.value === itemId);
    setLines((all) => all.map((line) => line.id === id ? { ...line, itemId, code: selected?.code ?? "" } : line));
  };
  const addLine = () => setLines((all) => [...all, { id: `d-${Date.now()}`, itemId: "", code: "", unit: "قطعة", qty: "1", note: "" }]);
  const removeLine = (id: string) => setLines((all) => all.length > 1 ? all.filter((line) => line.id !== id) : all);
  const saveDraft = () => setNotice("تم حفظ المسودة محلياً في هذه المعاينة فقط. لم يتم إنشاء أي حركة مخزون.");
  const requestPost = () => {
    if (!date || !fromWarehouse || !toWarehouse || lines.some((line) => !line.itemId || amount(line.qty) <= 0) || (transportEnabled && !validTransport())) {
      setNotice("أكمل التاريخ والمستودعات والصنف والكمية الموجبة؛ وتأكد أن تكلفة النقل رقماً موجباً أو صفراً.");
      return;
    }
    setPostOpen(true);
  };
  const confirmPost = () => { setStatus("posted"); setPostOpen(false); setNotice("تم ترحيل الإذن محلياً للعرض فقط؛ تم قفل الإدخال ولم تُسجّل أي حركة فعلية."); };

  const gridCols = "120px minmax(270px,1.5fr) 125px 100px minmax(180px,.9fr) 40px";
  return (
    <div dir="rtl" className="invoice-base-scope min-h-[100dvh] w-full space-y-5 p-4 sm:p-5">
      <style>{`.delivery-note .delivery-alert{border-color:hsl(var(--primary)/.25);background:hsl(var(--primary)/.05)}.delivery-note.is-locked select{pointer-events:none;opacity:.62;background:hsl(var(--muted))}@media print {.delivery-note .no-print{display:none!important}.delivery-note{padding:0!important;background:#fff!important}}`}</style>
      <div className={`delivery-note ${locked ? "is-locked" : ""}`}>
        <div className="flex items-center gap-3 flex-wrap no-print">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="رجوع" onClick={() => setNotice("زر الرجوع ضمن المعاينة فقط؛ لم يتم الانتقال إلى صفحة أخرى.")}><ArrowRight className="h-4 w-4" /></Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10"><PackageCheck className="h-5 w-5 text-primary" /></div>
            <div><h1 className="text-lg font-bold">إذن تسليم داخلي إلى التصنيع</h1><p className="text-xs text-muted-foreground">تحويل مواد بين المستودع والإنتاج</p></div>
          </div>
          <span className={`ms-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${locked ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>{locked ? <LockKeyhole className="h-3 w-3" /> : null}{locked ? "مرحل — مقفل" : "مسودة"}</span>
          <span className="inline-flex items-center rounded border border-dashed px-2 py-1 text-[10px] text-muted-foreground">معاينة تصميم — بيانات توضيحية</span>
          <div className="ms-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPrintOpen(true)}><Printer className="h-4 w-4" />طباعة</Button>
            {!locked && <><Button variant="outline" size="sm" className="gap-1.5" onClick={saveDraft}><Save className="h-4 w-4" />حفظ مسودة</Button><Button size="sm" className="gap-1.5" onClick={requestPost}><PackageCheck className="h-4 w-4" />ترحيل</Button></>}
          </div>
        </div>
        {notice && <div className="delivery-alert mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs text-foreground"><span>{notice}</span><button className="text-muted-foreground underline" onClick={() => setNotice("")}>إخفاء</button></div>}

        <Tabs value={tab} onValueChange={setTab} dir="rtl" className="mt-5">
          <Card className="border-2">
            <CardHeader className="p-0">
              <div className="flex items-center justify-between gap-3 flex-nowrap px-4 py-2 border-b bg-muted/20">
                <TabsList className="h-8 bg-background border gap-1 shrink-0 overflow-x-auto">
                  <TabsTrigger value="basic" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><FileText className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
                  <TabsTrigger value="items" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ListOrdered className="h-3.5 w-3.5" />الأصناف</TabsTrigger>
                  <TabsTrigger value="costs" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><Truck className="h-3.5 w-3.5" />تكلفة النقل</TabsTrigger>
                </TabsList>
                <p className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate text-end">{tab === "items" ? `عدد الأصناف ${lines.length} — الكميات حسب الوحدة` : tab === "costs" ? "تكلفة النقل مستقلة عن قيمة الأصناف." : "أدخل بيانات التسليم ثم أضف الأصناف."}</p>
              </div>
            </CardHeader>
            <TabsContent value="basic" className="mt-0"><CardContent className="pt-5 pb-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Field label="رقم الإذن"><Input className="h-9 text-sm bg-muted/40 cursor-not-allowed font-mono" dir="ltr" value={number} readOnly /></Field>
                <Field label="التاريخ *"><Input disabled={locked} className="h-9 text-sm" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
                <Field label="من مستودع *"><InvoiceSearchCombobox disabled={locked} items={warehouses} value={fromWarehouse} onValueChange={setFromWarehouse} placeholder="اختر مستودع المصدر" /></Field>
                <Field label="إلى مستودع الإنتاج *"><InvoiceSearchCombobox disabled={locked} items={productionWarehouses} value={toWarehouse} onValueChange={setToWarehouse} placeholder="اختر مستودع الإنتاج" /></Field>
                <Field label="أمر التصنيع (اختياري)" className="lg:col-span-2"><InvoiceSearchCombobox disabled={locked} items={orders} value={order} onValueChange={setOrder} placeholder="بدون ربط بأمر تصنيع" /><p className="text-[10px] text-muted-foreground">يمكن ربط عدة أذونات بنفس الأمر، أو حفظ الإذن دون أمر.</p></Field>
                <Field label="ملاحظات" className="lg:col-span-2"><Textarea disabled={locked} className="min-h-16 text-sm resize-none" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
              </div>
              <div className="border-t pt-4 mt-2 flex items-center justify-between gap-3"><p className="text-[11px] text-muted-foreground">لا يشمل هذا الإذن عميلاً أو دفعات أو ضريبة.</p><Button disabled={locked} onClick={() => setTab("items")} className="gap-1.5">الأصناف<ArrowLeft className="h-4 w-4" /></Button></div>
            </CardContent></TabsContent>
            <TabsContent value="items" className="mt-0"><CardContent className="pt-5 pb-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2 no-print"><Button variant="ghost" size="sm" onClick={() => setTab("basic")} className="gap-1.5"><ArrowRight className="h-4 w-4" />البيانات الأساسية</Button><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}><Printer className="h-4 w-4" />طباعة</Button>{!locked && <Button size="sm" onClick={saveDraft}><Save className="h-4 w-4" />حفظ مسودة</Button>}</div></div>
              <div className="border-t pt-4 flex items-center gap-2 text-sm font-semibold text-foreground/80"><ListOrdered className="h-4 w-4" /><span>الأصناف ({lines.length})</span></div>
              <div className="rounded-xl border bg-card overflow-x-auto"><div className="min-w-max">
                <div className="grid gap-2 px-3 py-2 border-b bg-muted/40" style={{ gridTemplateColumns: gridCols }}>{["كود الصنف", "الصنف", "الوحدة", "الكمية", "ملاحظات السطر", ""].map((header) => <p key={header} className="text-[11px] font-medium text-muted-foreground">{header}</p>)}</div>
                <div className="divide-y">{lines.map((line) => <div key={line.id} className="px-3 py-2 hover:bg-muted/30"><div className="grid gap-2 items-center" style={{ gridTemplateColumns: gridCols }}>
                  <Input className="h-8 text-xs bg-muted/40 font-mono" value={line.code} readOnly placeholder="تلقائي" />
                  <InvoiceSearchCombobox disabled={locked} items={items} value={line.itemId} onValueChange={(value) => setItem(line.id, value)} placeholder="ابحث واختر الصنف" className="h-8" />
                  <Input disabled={locked} className="h-8 text-xs" value={line.unit} onChange={(event) => updateLine(line.id, "unit", event.target.value)} />
                  <Input disabled={locked} className="h-8 text-xs text-left font-mono" dir="ltr" inputMode="decimal" value={line.qty} onChange={(event) => updateLine(line.id, "qty", event.target.value)} />
                  <Input disabled={locked} className="h-8 text-xs" value={line.note} onChange={(event) => updateLine(line.id, "note", event.target.value)} />
                  <Button aria-label="حذف سطر الصنف" disabled={locked || lines.length === 1} variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeLine(line.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div></div>)}</div>
                {!locked && <div className="border-t bg-muted/20 px-3 py-2"><Button variant="outline" size="sm" className="gap-2 h-8" onClick={addLine}><Plus className="h-4 w-4" />إضافة صنف</Button></div>}
              </div></div>
              <div className="rounded-xl border bg-muted/30 px-4 py-2.5 flex flex-wrap gap-x-4 gap-y-2 items-center text-sm"><span className="text-xs text-muted-foreground">إجماليات الكميات حسب الوحدة</span>{Object.entries(quantitiesByUnit).map(([unit, quantity]) => <span key={unit} className="font-mono font-bold text-primary">{quantity} <span className="font-sans text-xs">{unit}</span></span>)}<span className="text-[10px] text-muted-foreground">لا تُجمع الوحدات المختلفة، ولا تُحتسب قيمة بضاعة هنا.</span></div>
            </CardContent></TabsContent>
            <TabsContent value="costs" className="mt-0"><CardContent className="pt-5 pb-5 space-y-4">
              <div className="flex justify-between items-center border-b pb-3"><div><h2 className="text-sm font-semibold">تكلفة النقل الداخلي</h2><p className="text-[11px] text-muted-foreground">معلومة تكلفة منفصلة؛ ليست قيمة أصناف ولا ضريبة.</p></div><Button disabled={locked} variant="outline" size="sm" onClick={() => setSettingsOpen(true)} className="gap-1.5"><Settings2 className="h-4 w-4" />إعداد النقل</Button></div>
              {transportEnabled ? <div className="grid grid-cols-1 lg:grid-cols-3 gap-4"><Field label="تكلفة نقل هذا الإذن (ر.س)"><Input disabled={locked} dir="ltr" className="h-9 font-mono text-left" inputMode="decimal" value={transport} onChange={(event) => setTransport(event.target.value)} /></Field><div className="rounded-lg border bg-muted/20 px-3 py-2.5 lg:col-span-2"><p className="text-xs font-semibold">ملخص الأمر المحدد</p>{order ? (() => { const fixture = orderCostFixtures[order]; const current = amount(transport); return <><p className="mt-1 text-[11px] text-muted-foreground">{selectedOrder?.code} — {fixture.notes} أذونات سابقة، وهذا الإذن مضاف مرة واحدة فقط.</p><div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs"><span>نقل أذونات سابقة: <b className="font-mono">{money(fixture.priorTransport)} ر.س</b></span><span>هذا الإذن: <b className="font-mono text-primary">{money(current)} ر.س</b></span><span>تكلفة إنتاج أساسية: <b className="font-mono">{money(fixture.baseProduction)} ر.س</b></span><span className="font-semibold">{locked ? "إجمالي الإنتاج" : "تقديري بعد ترحيل هذا الإذن"}: <b className="font-mono text-primary">{money(fixture.baseProduction + fixture.priorTransport + current)} ر.س</b></span></div></>; })() : <p className="mt-1 text-[11px] text-muted-foreground">لم يتم اختيار أمر تصنيع؛ تحفظ تكلفة النقل لهذا الإذن دون تجميع أمر.</p>}</div></div> : <div className="rounded-xl border border-dashed bg-muted/20 p-5 text-center"><Truck className="mx-auto h-5 w-5 text-muted-foreground" /><p className="mt-2 text-sm font-medium">النقل الداخلي غير مفعّل</p><p className="mt-1 text-xs text-muted-foreground">المبالغ المسجلة تاريخياً تبقى كما هي ولا تُعاد حسابها.</p></div>}
              {transportEnabled && order && <div className="rounded-lg border bg-primary/5 px-4 py-3 text-sm flex flex-wrap justify-between gap-2">
                <span>إجمالي النقل الداخلي للأمر {locked ? "" : "المتوقع بعد الترحيل"}</span>
                <strong className="font-mono text-primary">{money(orderCostFixtures[order].priorTransport + amount(transport))} ر.س</strong>
              </div>}
              <p className="text-[10px] text-muted-foreground">بيانات العرض محلية فقط. تغيير الإعداد يؤثر على الإدخال التالي ولا يغير تكلفة أي إذن محفوظ تاريخياً.</p>
            </CardContent></TabsContent>
          </Card>
        </Tabs>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent dir="rtl" className="max-w-md"><DialogHeader><DialogTitle>إعداد تكلفة النقل الداخلي</DialogTitle><DialogDescription>خيار توضيحي داخل المعاينة، لا يحفظ إعدادات فعلية.</DialogDescription></DialogHeader><div className="flex items-start gap-3 rounded-lg border p-3"><Checkbox id="transport" checked={transportEnabled} onCheckedChange={(checked) => setTransportEnabled(checked === true)} /><Label htmlFor="transport" className="space-y-1 leading-5"><span>تفعيل تكلفة النقل في إذن التسليم</span><span className="block text-[11px] font-normal text-muted-foreground">عند التعطيل، تبقى المبالغ التاريخية محفوظة كما سُجلت ولا تتغير.</span></Label></div><DialogFooter><Button onClick={() => { setSettingsOpen(false); setNotice("تم تطبيق إعداد النقل محلياً على هذه المعاينة فقط."); }}>تطبيق</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={postOpen} onOpenChange={setPostOpen}><DialogContent dir="rtl"><DialogHeader><DialogTitle>تأكيد ترحيل إذن التسليم</DialogTitle><DialogDescription>سيتم قفل حقول الإذن في هذه المعاينة.</DialogDescription></DialogHeader><div className="rounded-lg border bg-muted/30 p-3 text-sm leading-6">الترحيل يعني تحويل المخزون من مستودع المصدر إلى مستودع الإنتاج فقط؛ لا يعني استهلاك مواد خام في أمر التصنيع. هذا عرض محلي تجريبي ولن ينشئ أي حركة أو قيد فعلي.</div><DialogFooter><Button variant="outline" onClick={() => setPostOpen(false)}>إلغاء</Button><Button onClick={confirmPost}>تأكيد الترحيل المحلي</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={printOpen} onOpenChange={setPrintOpen}><DialogContent dir="rtl"><DialogHeader><DialogTitle>معاينة الطباعة</DialogTitle><DialogDescription>نموذج طباعة محلي؛ لا يتم إرسال مستند.</DialogDescription></DialogHeader><div className="border rounded-lg p-4 text-sm space-y-2"><div className="flex justify-between font-semibold"><span>إذن تسليم داخلي إلى التصنيع</span><span dir="ltr">{number}</span></div><p>من: {warehouses.find((w) => w.value === fromWarehouse)?.label}</p><p>إلى: {productionWarehouses.find((w) => w.value === toWarehouse)?.label}</p><p>الأصناف: {lines.length} — {Object.entries(quantitiesByUnit).map(([unit, quantity]) => `${quantity} ${unit}`).join("، ")}</p></div><DialogFooter><Button variant="outline" onClick={() => setPrintOpen(false)}>إغلاق</Button><Button onClick={() => window.print()}><Printer className="h-4 w-4" />طباعة محلية</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}