import { useState } from "react";
import { ListOrdered, PackageMinus, PackagePlus, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// Static Arabic labels transcribed from purchasingPages.goodsReceipts,
// salesPages.goodsDeliveries and goodsReceiptsPage in the app's ar.json.
const receipt = {
  newTitle: "إذن استلام جديد", saveLabel: "حفظ الإذن", headerData: "البيانات الرأسية",
  number: "رقم الإذن", date: "تاريخ الاستلام", party: "المورد", partyPh: "اختر المورد...",
  reference: "رقم فاتورة المورد", referencePh: "رقم الفاتورة لدى المورد (اختياري)",
  branch: "الفرع", mainBranch: " (الرئيسي)", warehouse: "المخزن", warehousePh: "اختر مخزن",
  tax: "الضريبة", taxPh: "اختر الضريبة", taxHint: "اختيار الضريبة يطبّق نسبتها على كل البنود",
  currency: "العملة", notes: "ملاحظات", notesPh: "ملاحظات حول الاستلام...",
  linesTitle: "الأصناف المُستلمة", addLine: "إضافة صنف", selectItem: "اختر صنف...",
  unitPh: "وحدة", priceIncludesVat: "السعر شامل الضريبة",
  vatHintIncl: "السعر المُدخل يتضمن الضريبة — يستخرج النظام قيمة الضريبة من المبلغ",
  vatHintExcl: "السعر المُدخل بدون ضريبة — يضيف النظام الضريبة فوق المبلغ",
  calcMethod: "طريقة الحساب", inclVat: "شامل الضريبة", exclVat: "غير شامل الضريبة",
  subtotalIncl: "المجموع شامل الضريبة", vatAmount: "قيمة الضريبة", itemDiscount: "خصم الأصناف",
  totalLabel: "الإجمالي",
  headers: ["كود الصنف", "الصنف", "المخزن", "الوحدة", "الكمية", "السعر", "خصم%", "ضريبة%", "الإجمالي", "رقم الدفعة", "تاريخ الانتهاء", "ملاحظات", ""],
} as const;
const delivery = {
  newTitle: "إذن تسليم جديد", saveLabel: "حفظ الإذن", headerData: "البيانات الرئيسية",
  number: "رقم الإذن", date: "تاريخ التسليم", party: "العميل", partyPh: "اختر العميل...",
  reference: "رقم طلب العميل", referencePh: "رقم طلب الشراء من العميل (اختياري)",
  branch: "الفرع", mainBranch: " (رئيسي)", warehouse: "المستودع", warehousePh: "اختر المستودع",
  tax: "الضريبة", taxPh: "اختر الضريبة", taxHint: "اختيار الضريبة يطبّق نسبتها على كل البنود",
  currency: "العملة", notes: "ملاحظات", notesPh: "ملاحظات على هذا الإذن...",
  linesTitle: "البنود المسلَّمة", addLine: "إضافة سطر", selectItem: "اختر الصنف...",
  unitPh: "الوحدة", priceIncludesVat: "السعر شامل الضريبة",
  vatHintIncl: "السعر المُدخل شامل الضريبة — يتم استخراج الضريبة من المبلغ",
  vatHintExcl: "السعر المُدخل بدون ضريبة — تُضاف الضريبة فوقه",
  calcMethod: "طريقة الحساب", inclVat: "شامل الضريبة", exclVat: "بدون الضريبة",
  subtotalIncl: "الإجمالي شامل الضريبة", vatAmount: "قيمة الضريبة", itemDiscount: "خصم البنود",
  totalLabel: "الإجمالي",
  headers: ["الكود", "الصنف", "المخزن", "الوحدة", "الكمية", "السعر", "خصم %", "ض %", "الإجمالي", "ملاحظات", ""],
} as const;

type Line = {
  _id: number; itemCode: string; itemId: string; itemName: string;
  warehouseId: string; unitId: string; qty: string; unitPrice: string;
  discount: string; vatRate: string; batchNumber: string; expiryDate: string; notes: string;
};
const initialLines: Line[] = [
  { _id: 1, itemCode: "ITM-001", itemId: "1", itemName: "حاسوب محمول", warehouseId: "1", unitId: "1", qty: "2", unitPrice: "2500", discount: "0", vatRate: "15", batchNumber: "B-2025-01", expiryDate: "", notes: "" },
  { _id: 2, itemCode: "ITM-002", itemId: "2", itemName: "شاشة 24 بوصة", warehouseId: "1", unitId: "1", qty: "3", unitPrice: "650", discount: "5", vatRate: "15", batchNumber: "B-2025-02", expiryDate: "", notes: "" },
];
const items = [{ id: "1", label: "حاسوب محمول" }, { id: "2", label: "شاشة 24 بوصة" }];
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Source: src/components/FormPanel.tsx — panel header/body/footer and field grid.
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <div className="space-y-1.5">
    <label className="text-xs font-medium text-foreground/80 flex items-center gap-1">{label}{required && <span className="text-destructive">*</span>}</label>
    {children}
  </div>;
}
function FormGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-5 gap-y-4 grid-cols-1 md:grid-cols-2">{children}</div>;
}
function DemoCombo({ options, value, onChange, placeholder, className }: {
  options: { id: string; label: string }[]; value: string; onChange: (v: string) => void;
  placeholder: string; className?: string;
}) {
  return <Select value={value || undefined} onValueChange={onChange}>
    <SelectTrigger className={className}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent>{options.map(o => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
  </Select>;
}

export function GoodsDocumentCurrent({ kind }: { kind: "receipt" | "delivery" }) {
  const isReceipt = kind === "receipt";
  const text = isReceipt ? receipt : delivery;
  const Icon = isReceipt ? PackagePlus : PackageMinus;
  const [form, setForm] = useState({
    docNumber: isReceipt ? "GRN-000124" : "GDN-000088", date: "2025-06-15",
    partyId: "1", reference: isReceipt ? "INV-5892" : "PO-1048",
    branchId: "1", projectId: "", currencyCode: "SAR",
    notes: "", discountAmount: "0", priceIncludesVat: false, exchangeRate: "1",
  });
  const [headerWarehouseId, setHeaderWarehouseId] = useState("1");
  const [headerTaxId, setHeaderTaxId] = useState("1");
  const [lines, setLines] = useState<Line[]>(initialLines);
  const updateLine = (id: number, key: keyof Line, value: string) =>
    setLines(prev => prev.map(l => l._id === id ? { ...l, [key]: value } : l));
  const lineMath = lines.map(l => {
    const base = Number(l.qty) * Number(l.unitPrice) * (1 - Number(l.discount) / 100);
    const vat = form.priceIncludesVat ? base - base / (1 + Number(l.vatRate) / 100) : base * Number(l.vatRate) / 100;
    return { total: form.priceIncludesVat ? base : base + vat, vat };
  });
  const grossTotal = lineMath.reduce((n, l) => n + l.total, 0);
  const vatAmount = lineMath.reduce((n, l) => n + l.vat, 0);
  const lineDiscountTotal = lines.reduce((n, l) => n + Number(l.qty) * Number(l.unitPrice) * Number(l.discount) / 100, 0);
  const totalAmount = Math.max(0, grossTotal - Number(form.discountAmount));
  const gridColumns = isReceipt
    ? "110px minmax(260px,1.4fr) 160px 120px 90px 110px 80px 80px 130px 120px 130px 180px 40px"
    : "110px minmax(260px,1.4fr) 160px 120px 90px 110px 80px 80px 130px 180px 40px";
  const warehouseOptions = [{ id: "1", label: "المستودع الرئيسي" }, { id: "2", label: "مستودع الفرع" }];
  const partyOptions = isReceipt
    ? [{ id: "1", label: "شركة التقنية الحديثة" }, { id: "2", label: "مؤسسة الأفق للتوريد" }]
    : [{ id: "1", label: "شركة النور التجارية" }, { id: "2", label: "مؤسسة اليسر" }];
  return <div className="goods-document-current min-h-screen p-6" dir="rtl">
    <div className="mx-auto w-full max-w-6xl scroll-mt-24">
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0"><h2 className="font-semibold text-sm sm:text-base text-foreground truncate">{text.newTitle}</h2></div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label="إغلاق"><X className="h-4 w-4" /></Button>
        </div>
        <div className="p-6">
          <Tabs defaultValue="header" className="w-full">
            <TabsList className="mb-4"><TabsTrigger value="header">{text.headerData}</TabsTrigger></TabsList>
            <TabsContent value="header" className="mt-0 space-y-5">
              <FormGrid>
                <Field label={text.number}><Input value={form.docNumber} onChange={e => setForm(p => ({ ...p, docNumber: e.target.value }))} placeholder="تلقائي" /></Field>
                <Field label={text.date} required><Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></Field>
                <Field label={text.party}><DemoCombo options={partyOptions} value={form.partyId} onChange={v => setForm(p => ({ ...p, partyId: v }))} placeholder={text.partyPh} /></Field>
                <Field label={text.reference}><Input value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} placeholder={text.referencePh} /></Field>
                <Field label={text.branch}><DemoCombo options={[{ id: "1", label: `الفرع الرئيسي${text.mainBranch}` }, { id: "2", label: "فرع الرياض" }]} value={form.branchId} onChange={v => setForm(p => ({ ...p, branchId: v }))} placeholder={text.branch} /></Field>
                <Field label="المشروع (اختياري)"><select aria-label="مشروع الإذن" value={form.projectId} onChange={e => setForm(p => ({ ...p, projectId: e.target.value }))} className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"><option value="">— بدون مشروع —</option><option value="1">PRJ-001 — مشروع توريد الأجهزة</option></select></Field>
                <Field label={text.warehouse}><DemoCombo options={warehouseOptions} value={headerWarehouseId} onChange={v => { setHeaderWarehouseId(v); setLines(p => p.map(l => ({ ...l, warehouseId: v }))); }} placeholder={text.warehousePh} /></Field>
                <Field label={text.tax}><DemoCombo options={[{ id: "1", label: "ضريبة القيمة المضافة 15%" }, { id: "2", label: "معفى من الضريبة" }]} value={headerTaxId} onChange={v => { setHeaderTaxId(v); setLines(p => p.map(l => ({ ...l, vatRate: v === "1" ? "15" : "0" }))); }} placeholder={text.taxPh} /><p className="text-[10px] text-muted-foreground">{text.taxHint}</p></Field>
                <Field label={text.currency}><DemoCombo options={[{ id: "SAR", label: "SAR — ريال سعودي" }, { id: "USD", label: "USD — دولار أمريكي" }]} value={form.currencyCode} onChange={v => setForm(p => ({ ...p, currencyCode: v }))} placeholder="العملة..." /></Field>
                {form.currencyCode !== "SAR" && <Field label="سعر الصرف"><Input type="text" inputMode="decimal" value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>}
              </FormGrid>
              <Field label={text.notes}><Textarea rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder={text.notesPh} /></Field>
              <div data-enter-nav-container="lines" className="space-y-1.5">
                <div className="border-t pt-4 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                  <ListOrdered className="h-4 w-4" /><span>{text.linesTitle} ({lines.length})</span>
                </div>
                <div className="rounded-xl border bg-card overflow-x-auto" dir="rtl"><div className="min-w-max">
                  <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: gridColumns }}>
                    {text.headers.map((h, i) => <p key={i} className={cn("text-[11px] font-medium truncate", h === text.totalLabel ? "font-semibold text-primary" : "text-muted-foreground")} title={h}>{h}</p>)}
                  </div>
                  <div className="divide-y">{lines.map((l, i) => <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div className="grid gap-2 items-center" style={{ gridTemplateColumns: gridColumns }}>
                      <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder="تلقائي" value={l.itemCode} onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      <DemoCombo options={items} value={l.itemId} onChange={v => { setLines(prev => prev.map(x => x._id === l._id ? { ...x, itemId: v, itemName: items.find(it => it.id === v)?.label ?? "", itemCode: `ITM-00${v}` } : x)); }} placeholder={text.selectItem} className="h-8 text-xs" />
                      <DemoCombo options={warehouseOptions} value={l.warehouseId} onChange={v => updateLine(l._id, "warehouseId", v)} placeholder="المخزن" className="h-8 text-xs" />
                      <DemoCombo options={[{ id: "1", label: "قطعة" }, { id: "2", label: "علبة" }]} value={l.unitId} onChange={v => updateLine(l._id, "unitId", v)} placeholder={text.unitPh} className="h-8 text-xs" />
                      <Input className={cn("h-8 text-xs", !isReceipt && "text-end")} inputMode="decimal" value={l.qty} onChange={e => updateLine(l._id, "qty", e.target.value)} />
                      <Input className={cn("h-8 text-xs", !isReceipt && "text-end")} inputMode="decimal" value={l.unitPrice} onChange={e => updateLine(l._id, "unitPrice", e.target.value)} />
                      <Input className={cn("h-8 text-xs", !isReceipt && "text-end")} inputMode="decimal" value={l.discount} onChange={e => updateLine(l._id, "discount", e.target.value)} />
                      <Input className={cn("h-8 text-xs", !isReceipt && "text-end")} inputMode="decimal" value={l.vatRate} onChange={e => updateLine(l._id, "vatRate", e.target.value)} />
                      <Input className={isReceipt ? "h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" : "h-8 text-xs text-end font-semibold text-primary bg-primary/5"} dir={isReceipt ? "ltr" : undefined} readOnly value={fmt(lineMath[i].total)} />
                      {isReceipt && <><Input className="h-8 text-xs" placeholder="رقم الدفعة" value={l.batchNumber} onChange={e => updateLine(l._id, "batchNumber", e.target.value)} /><Input type="date" className="h-8 text-xs" value={l.expiryDate} onChange={e => updateLine(l._id, "expiryDate", e.target.value)} /></>}
                      <Input className="h-8 text-xs" value={l.notes} onChange={e => updateLine(l._id, "notes", e.target.value)} placeholder={isReceipt ? undefined : "ملاحظات"} />
                      <Button type="button" variant="ghost" size="icon" className={isReceipt ? "h-8 w-8 text-destructive" : "h-7 w-7 text-rose-700 hover:bg-rose-50"} onClick={() => setLines(p => p.filter(x => x._id !== l._id))} disabled={lines.length <= 1}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>)}</div>
                  {!isReceipt && <div className="px-3 py-2 border-t bg-muted/20"><Button type="button" size="sm" variant="ghost" onClick={() => setLines(p => [...p, { ...initialLines[0], _id: Date.now(), itemCode: "", itemId: "", itemName: "", qty: "1" }])} className="gap-1 text-xs h-7"><Plus className="h-3.5 w-3.5" /> {text.addLine}</Button></div>}
                </div></div>
                {isReceipt && <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setLines(p => [...p, { ...initialLines[0], _id: Date.now(), itemCode: "", itemId: "", itemName: "", qty: "1" }])}><Plus className="h-4 w-4" />{text.addLine}</Button>}
              </div>
              <div className={isReceipt ? "mt-5 flex flex-wrap justify-between gap-4" : "flex flex-wrap gap-4 justify-between border-t pt-4"}>
                <label className={isReceipt ? cn("flex items-start gap-2.5 rounded-xl border-2 p-3 cursor-pointer select-none transition-colors max-w-sm", form.priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50") : "flex items-start gap-2 text-xs cursor-pointer"}>
                  <input type="checkbox" className={isReceipt ? "mt-0.5 h-4 w-4 accent-primary cursor-pointer" : "mt-0.5"} checked={form.priceIncludesVat} onChange={e => setForm(p => ({ ...p, priceIncludesVat: e.target.checked }))} />
                  <div className="space-y-0.5"><p className="text-xs font-semibold">{text.priceIncludesVat}</p><p className="text-[10px] text-muted-foreground leading-relaxed">{form.priceIncludesVat ? text.vatHintIncl : text.vatHintExcl}</p></div>
                </label>
                <div className="w-72 text-sm border rounded-xl p-3 bg-muted/30 space-y-2">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1"><span>{text.calcMethod}</span><span className={cn("font-semibold px-2 py-0.5 rounded", form.priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>{form.priceIncludesVat ? text.inclVat : text.exclVat}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{text.subtotalIncl}</span><span className="font-mono">{fmt(grossTotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{text.vatAmount}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && <div className="flex justify-between text-rose-700"><span className="text-muted-foreground">{text.itemDiscount}</span><span className="font-mono">−{fmt(lineDiscountTotal)}</span></div>}
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">الخصم</span><div className="flex items-center gap-1"><Input type="number" min="0" max="100" step="0.01" defaultValue="0" className="w-14 h-7 text-left font-mono text-rose-700 bg-background border rounded px-1.5 text-xs" /><span className="text-[10px] text-muted-foreground">%</span><Input type="number" min="0" step="0.01" value={form.discountAmount} onChange={e => setForm(p => ({ ...p, discountAmount: e.target.value }))} className="w-24 h-7 text-left font-mono text-rose-700 bg-background border rounded px-2 text-xs" /><span className="text-[10px] text-muted-foreground">ر.س</span></div></div>
                  <div className="flex justify-between font-bold border-t pt-2 text-base"><span>{text.totalLabel}</span><span className="font-mono text-primary">{fmt(totalAmount)}</span></div>
                  {form.currencyCode !== "SAR" && Number(form.exchangeRate) > 0 && <p className="text-[10px] text-muted-foreground border-t pt-1">{isReceipt ? "المكافئ بـ" : "ما يعادل بـ"} SAR: {fmt(totalAmount * Number(form.exchangeRate))}</p>}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t bg-muted/20">
          <Button variant="outline" size="sm" className="gap-1.5"><X className="h-4 w-4" />إلغاء</Button>
          <Button size="sm" className="gap-1.5 min-w-[110px]"><Save className="h-4 w-4" />{text.saveLabel}</Button>
        </div>
      </div>
    </div>
  </div>;
}