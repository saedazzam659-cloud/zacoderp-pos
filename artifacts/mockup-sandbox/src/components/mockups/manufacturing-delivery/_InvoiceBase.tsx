import React, { useMemo, useState } from "react";
import "./_group.css";
import { ArrowLeft, ArrowRight, FileText, ListOrdered, Plus, Printer, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InvoiceSearchCombobox, type InvoiceComboOption } from "./_shared/InvoiceSearchCombobox";

/*
 * SOURCE PROVENANCE — faithful invoice-editor extraction, not a redesign.
 * Main wrapper/header/tabs: SalesDocumentForm.tsx lines 3055-3100 and
 * 3241-3308. Header fields: lines 3306-3590. Items grid: lines 2284-2465
 * (the source's gridCols and cell classes are retained below). Totals/footer:
 * lines 1849-1928 and compact variant lines 2238-2279.
 *
 * SalesInvoiceForm.tsx line 2 delegates to SalesDocumentForm mode="invoice".
 * API/auth/router/payment/ZATCA lifecycle dependencies were intentionally
 * removed. Fixture data and editable state below are local only.
 */

type InvoiceLine = {
  id: string;
  itemCode: string;
  itemId: string;
  itemName: string;
  warehouseId: string;
  unit: string;
  qty: string;
  freeQty: string;
  price: string;
  discount: string;
  discountAmount: string;
  vatRate: string;
  notes: string;
};

const customers: InvoiceComboOption[] = [
  { value: "almas", code: "C-1042", label: "شركة الماسة للمقاولات" },
  { value: "riyadh", code: "C-0781", label: "مؤسسة ركن الرياض التجارية" },
  { value: "nour", code: "C-0166", label: "شركة النور للتجهيزات" },
];
const branches: InvoiceComboOption[] = [
  { value: "main", label: "الفرع الرئيسي — الرياض" },
  { value: "east", label: "فرع العليا" },
];
const warehouses: InvoiceComboOption[] = [
  { value: "central", code: "WH-01", label: "المستودع المركزي" },
  { value: "north", code: "WH-02", label: "مستودع الشمال" },
];
const items: InvoiceComboOption[] = [
  { value: "cement", code: "ITM-1008", label: "أسمنت مقاوم 50 كجم" },
  { value: "steel", code: "ITM-2041", label: "حديد تسليح 12 مم" },
  { value: "pipes", code: "ITM-3120", label: "أنابيب PVC مقاس 4 بوصة" },
];

const initialLines: InvoiceLine[] = [
  {
    id: "line-1", itemCode: "ITM-1008", itemId: "cement", itemName: "أسمنت مقاوم 50 كجم",
    warehouseId: "central", unit: "كيس", qty: "24", freeQty: "0", price: "18.50",
    discount: "0", discountAmount: "0", vatRate: "15", notes: "توريد الدفعة الأولى",
  },
  {
    id: "line-2", itemCode: "ITM-2041", itemId: "steel", itemName: "حديد تسليح 12 مم",
    warehouseId: "central", unit: "طن", qty: "2", freeQty: "0", price: "2,350",
    discount: "2", discountAmount: "0", vatRate: "15", notes: "",
  },
  {
    id: "line-3", itemCode: "ITM-3120", itemId: "pipes", itemName: "أنابيب PVC مقاس 4 بوصة",
    warehouseId: "north", unit: "متر", qty: "36", freeQty: "4", price: "12.75",
    discount: "0", discountAmount: "0", vatRate: "15", notes: "",
  },
];

const numberValue = (value: string) => Number(value.replace(/,/g, "")) || 0;
const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className}`}><Label className="text-xs">{label}</Label>{children}</div>;
}

export default function InvoiceBase() {
  const [activeTab, setActiveTab] = useState("basic");
  const [docNumber, setDocNumber] = useState("INV-2025-00481");
  const [docDate, setDocDate] = useState("2025-06-13");
  const [customer, setCustomer] = useState("almas");
  const [branch, setBranch] = useState("main");
  const [warehouse, setWarehouse] = useState("central");
  const [currency, setCurrency] = useState("SAR");
  const [exchangeRate, setExchangeRate] = useState("1.0000");
  const [salesperson, setSalesperson] = useState("سارة محمد");
  const [notes, setNotes] = useState("التوريد حسب أمر الشراء رقم PO-2025-119.");
  const [docDiscount, setDocDiscount] = useState("0");
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [lines, setLines] = useState<InvoiceLine[]>(initialLines);

  const updateLine = (id: string, key: keyof InvoiceLine, value: string) =>
    setLines((current) => current.map((line) => line.id === id ? { ...line, [key]: value } : line));
  const addLine = () => setLines((current) => [...current, {
    id: `line-${Date.now()}`, itemCode: "", itemId: "", itemName: "", warehouseId: warehouse,
    unit: "قطعة", qty: "1", freeQty: "0", price: "0", discount: "0", discountAmount: "0", vatRate: "15", notes: "",
  }]);
  const removeLine = (id: string) => setLines((current) => current.length > 1 ? current.filter((line) => line.id !== id) : current);
  const changeItem = (id: string, itemId: string) => {
    const selected = items.find((item) => item.value === itemId);
    setLines((current) => current.map((line) => line.id === id ? {
      ...line, itemId, itemCode: selected?.code ?? "", itemName: selected?.label ?? "",
    } : line));
  };

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const gross = numberValue(line.qty) * numberValue(line.price);
      return sum + (priceIncludesVat ? gross / (1 + numberValue(line.vatRate) / 100) : gross);
    }, 0);
    const lineDiscount = lines.reduce((sum, line) => {
      const gross = numberValue(line.qty) * numberValue(line.price);
      return sum + gross * (numberValue(line.discount) / 100) + numberValue(line.discountAmount);
    }, 0);
    const vat = lines.reduce((sum, line) => {
      const gross = numberValue(line.qty) * numberValue(line.price) - numberValue(line.discountAmount);
      return sum + (priceIncludesVat ? gross - gross / (1 + numberValue(line.vatRate) / 100) : gross * numberValue(line.vatRate) / 100);
    }, 0);
    const gross = subtotal + vat;
    const total = Math.max(0, gross - lineDiscount - numberValue(docDiscount));
    return { subtotal, lineDiscount, vat, total };
  }, [docDiscount, lines, priceIncludesVat]);

  const gridCols = "110px minmax(260px,1.4fr) 160px 120px 90px 80px 110px 80px 100px 80px 130px 180px 40px";
  const headers = ["كود الصنف", "الصنف", "المستودع", "الوحدة", "الكمية", "مجاني", "السعر", "خصم %", "قيمة الخصم", "ضريبة %", "الإجمالي", "ملاحظات", ""];

  const linesSection = (
    <div className="pt-2 space-y-3">
      <div data-enter-nav-container="lines" className="rounded-xl border bg-card overflow-x-auto">
        <div className="min-w-max">
          <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: gridCols }}>
            {headers.map((header, index) => <p key={index} className={`text-[11px] font-medium truncate ${header === "الإجمالي" ? "font-semibold text-primary" : "text-muted-foreground"}`} title={header}>{header}</p>)}
          </div>
          <div className="divide-y">
            {lines.map((line) => {
              const lineGross = numberValue(line.qty) * numberValue(line.price);
              const lineTotal = lineGross - lineGross * numberValue(line.discount) / 100 - numberValue(line.discountAmount);
              return (
                <div key={line.id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                  <div className="grid gap-2 items-center" style={{ gridTemplateColumns: gridCols }}>
                    <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!line.itemId} placeholder="تلقائي" value={line.itemCode} onChange={(event) => updateLine(line.id, "itemCode", event.target.value)} />
                    <InvoiceSearchCombobox items={items} value={line.itemId} onValueChange={(value) => changeItem(line.id, value)} placeholder="اختر الصنف" className="h-8" />
                    <InvoiceSearchCombobox items={warehouses} value={line.warehouseId} onValueChange={(value) => updateLine(line.id, "warehouseId", value)} placeholder="اختر المستودع" className="h-8" />
                    <Input className="h-8 text-xs" value={line.unit} onChange={(event) => updateLine(line.id, "unit", event.target.value)} />
                    <Input className="h-8 text-xs text-left" type="text" inputMode="decimal" dir="ltr" value={line.qty} onChange={(event) => updateLine(line.id, "qty", event.target.value)} />
                    <Input className="h-8 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono" type="text" inputMode="decimal" dir="ltr" value={line.freeQty} onChange={(event) => updateLine(line.id, "freeQty", event.target.value)} />
                    <Input className="h-8 text-xs font-mono" type="text" inputMode="decimal" dir="ltr" value={line.price} onChange={(event) => updateLine(line.id, "price", event.target.value)} />
                    <Input className="h-8 text-xs font-mono" type="text" inputMode="decimal" dir="ltr" value={line.discount} onChange={(event) => updateLine(line.id, "discount", event.target.value)} />
                    <Input className="h-8 text-xs font-mono" type="text" inputMode="decimal" dir="ltr" value={line.discountAmount} onChange={(event) => updateLine(line.id, "discountAmount", event.target.value)} />
                    <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={line.vatRate} onChange={(event) => updateLine(line.id, "vatRate", event.target.value)} />
                    <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={money(lineTotal)} />
                    <Input className="h-8 text-xs" value={line.notes} onChange={(event) => updateLine(line.id, "notes", event.target.value)} />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeLine(line.id)} disabled={lines.length <= 1}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t bg-muted/20 px-3 py-2">
            <Button type="button" variant="outline" size="sm" className="gap-2 h-8" onClick={addLine} data-testid="button-add-grid-line"><Plus className="h-4 w-4" />إضافة صنف</Button>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border bg-muted/30 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <button type="button" onClick={() => setPriceIncludesVat((value) => !value)} className={`text-[10px] font-semibold px-2 py-0.5 rounded ${priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70"}`}>{priceIncludesVat ? "السعر شامل الضريبة" : "السعر قبل الضريبة"}</button>
          <div className="flex items-center gap-1.5 ms-auto"><span className="text-muted-foreground text-xs">الإجمالي قبل الضريبة</span><span className="font-mono">{money(totals.subtotal)}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-muted-foreground text-xs">خصم الأصناف</span><span className="font-mono text-rose-700">−{money(totals.lineDiscount)}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-muted-foreground text-xs">ضريبة القيمة المضافة</span><span className="font-mono text-amber-700">{money(totals.vat)}</span></div>
          <div className="flex items-center gap-1.5 min-w-[120px]"><span className="text-muted-foreground text-xs">خصم الفاتورة</span><Input className="h-7 w-20 text-xs font-mono" dir="ltr" value={docDiscount} onChange={(event) => setDocDiscount(event.target.value)} /></div>
          <div className="flex items-center gap-1.5 border-s ps-4"><span className="font-semibold text-xs">الإجمالي شامل الضريبة</span><span className="font-mono text-base font-bold text-primary">{money(totals.total)} ر.س</span></div>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground text-end">يعادل {money(totals.total)} ر.س بالعملة الأساسية</p>
      </div>
    </div>
  );

  return (
    <div dir="rtl" className="invoice-base-scope min-h-screen w-full space-y-5 p-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="رجوع"><ArrowRight className="h-4 w-4" /></Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10"><FileText className="h-5 w-5 text-primary" /></div>
          <div><h1 className="text-lg font-bold">فاتورة مبيعات</h1><p className="text-xs text-muted-foreground">إنشاء وتحرير فاتورة ضريبية</p></div>
        </div>
        <span className="ms-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">مسودة</span>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5"><Printer className="h-4 w-4" />طباعة</Button>
          <Button size="sm" className="gap-1.5"><Save className="h-4 w-4" />حفظ الفاتورة</Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
      <Card className="border-2">
        <CardHeader className="p-0">
          <div className="flex items-center justify-between gap-3 flex-nowrap px-4 py-2 border-b bg-muted/20">
            <TabsList className="h-8 bg-background border gap-1 shrink-0">
              <TabsTrigger value="basic" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><FileText className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
              <TabsTrigger value="items" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ListOrdered className="h-3.5 w-3.5" />الأصناف</TabsTrigger>
            </TabsList>
            <p className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate text-end">{activeTab === "items" ? `عدد الأصناف ${lines.length} — الإجمالي ${money(totals.total)} ر.س` : "أدخل البيانات الأساسية للفاتورة ثم أضف الأصناف."}</p>
          </div>
        </CardHeader>

        <TabsContent value="basic" className="mt-0">
          <CardContent className="pt-5 pb-5 space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Field label="رقم الفاتورة"><Input className="h-9 text-sm bg-muted/40 cursor-not-allowed" dir="ltr" value={docNumber} readOnly /></Field>
              <Field label="التاريخ *"><Input className="h-9 text-sm" type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></Field>
              <Field label="العميل *"><InvoiceSearchCombobox items={customers} value={customer} onValueChange={setCustomer} placeholder="اختر العميل" /></Field>
              <Field label="الفرع *"><InvoiceSearchCombobox items={branches} value={branch} onValueChange={setBranch} placeholder="اختر الفرع" /></Field>
              <Field label="طريقة الدفع"><select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"><option>آجل</option><option>نقدي</option><option>تحويل بنكي</option></select></Field>
              <Field label="العملة"><Input className="h-9 text-sm" dir="ltr" value={currency} onChange={(event) => setCurrency(event.target.value)} /></Field>
              <Field label="سعر الصرف"><Input className="h-9 text-sm" dir="ltr" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} /></Field>
              <Field label="مندوب المبيعات"><Input className="h-9 text-sm" value={salesperson} onChange={(event) => setSalesperson(event.target.value)} /></Field>
              <Field label="المستودع"><InvoiceSearchCombobox items={warehouses} value={warehouse} onValueChange={setWarehouse} placeholder="اختر المستودع" /><p className="text-[10px] text-muted-foreground">يُعبَّأ تلقائياً على كل سطور الأصناف عند الاختيار.</p></Field>
              <Field label="ملاحظات" className="lg:col-span-3"><Input className="h-9 text-sm" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
            </div>
            <div className="border-t pt-4 mt-2 flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">اكتملت البيانات الأساسية — انتقل إلى الأصناف.</p>
              <Button type="button" onClick={() => setActiveTab("items")} className="gap-1.5">الأصناف<ArrowLeft className="h-4 w-4" /></Button>
            </div>
          </CardContent>
        </TabsContent>

        <TabsContent value="items" className="mt-0">
          <CardContent className="pt-5 pb-5 space-y-4">
            <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => setActiveTab("basic")} className="gap-1.5"><ArrowRight className="h-4 w-4" />البيانات الأساسية</Button>
              <div className="flex items-center gap-2"><Button variant="outline" size="sm" className="gap-1.5"><Printer className="h-4 w-4" />طباعة</Button><Button size="sm" className="gap-1.5"><Save className="h-4 w-4" />حفظ الفاتورة</Button></div>
            </div>
            <div className="border-t pt-4 mt-2 flex items-center gap-2 text-sm font-semibold text-foreground/80"><ListOrdered className="h-4 w-4" /><span>الأصناف ({lines.length})</span></div>
            {linesSection}
          </CardContent>
        </TabsContent>
      </Card>
      </Tabs>
    </div>
  );
}