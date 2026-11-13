import { useMemo, useState } from "react";
import "./_group.css";

type Line = { item: string; unit: string; qty: number; free: number; price: number; discount: number; tax: number };

const initialLines: Line[] = [
  { item: "قهوة عربية فاخرة 500 جم", unit: "عبوة", qty: 3, free: 0, price: 42, discount: 5, tax: 15 },
  { item: "تمر سكري فاخر — كرتون", unit: "كرتون (×12)", qty: 2, free: 1, price: 96, discount: 0, tax: 15 },
  { item: "ماء شرب 330 مل", unit: "كرتون", qty: 5, free: 0, price: 18, discount: 0, tax: 15 },
];

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`si-field ${className}`}><span>{label}</span>{children}</label>;
}

export function Current() {
  const [tab, setTab] = useState<"basic" | "items" | "payments">("basic");
  const [lines, setLines] = useState(initialLines);
  const [payment, setPayment] = useState("نقدي");
  const [notes, setNotes] = useState("");
  const [invoiceType, setInvoiceType] = useState("مبسّطة (B2C)");
  const [discount, setDiscount] = useState(0);
  const [customer, setCustomer] = useState("مؤسسة النور التجارية");
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
    const tax = lines.reduce((sum, line) => sum + (line.qty * line.price - line.discount) * line.tax / 100, 0);
    return { subtotal, lineDiscount, tax, grand: subtotal - lineDiscount - discount + tax };
  }, [lines, discount]);
  const updateLine = (index: number, key: keyof Line, value: string | number) => {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
  };

  return (
    <main className="si-page" dir="rtl" lang="ar">
      <header className="si-header">
        <div className="si-title-group">
          <strong>فاتورة مبيعات جديدة</strong>
          <span>٢٬٤٨٦ فاتورة — يتم ترحيل القيد تلقائيًا عند الحفظ</span>
        </div>
        <button className="si-title-action" type="button" onClick={() => setTab("basic")}>＋ فاتورة مبيعات</button>
      </header>

      <nav className="si-tabs" aria-label="أقسام الفاتورة">
        <button className={tab === "basic" ? "active" : ""} onClick={() => setTab("basic")}>البيانات الأساسية</button>
        <button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>بنود الأصناف ({lines.length})</button>
        <button className={tab === "payments" ? "active" : ""} onClick={() => setTab("payments")}>المدفوعات</button>
      </nav>

      {tab === "basic" && <section className="si-panel">
        <div className="si-fields">
          <Field label="العميل *"><div className="si-control-with-add"><select value={customer} onChange={(e) => setCustomer(e.target.value)}><option>مؤسسة النور التجارية</option><option>شركة أبعاد للتجارة</option><option>عميل نقدي</option></select><button type="button" className="si-add" title="إضافة عميل">＋</button></div></Field>
          <Field label="التاريخ"><input type="date" defaultValue="2025-02-18" /></Field>
          <Field label="المستودع"><select defaultValue="المستودع الرئيسي"><option>المستودع الرئيسي</option><option>مستودع المعرض</option></select></Field>
          <Field label="الضريبة"><select defaultValue="ضريبة القيمة المضافة — 15%"><option>ضريبة القيمة المضافة — 15%</option><option>بدون ضريبة</option></select></Field>
          <Field label="الفرع"><select defaultValue="الفرع الرئيسي"><option>الفرع الرئيسي</option><option>فرع الشمال</option></select></Field>
          <Field label="مركز التكلفة"><select defaultValue="— بدون —"><option>— بدون —</option><option>المبيعات العامة</option></select></Field>
          <Field label="مندوب المبيعات"><select defaultValue="سارة العتيبي"><option>سارة العتيبي</option><option>— بدون —</option><option>محمد القحطاني</option></select></Field>
          <Field label="نوع الفاتورة (زاتكا)"><select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}><option>مبسّطة (B2C)</option><option>ضريبية (B2B)</option></select></Field>
          <Field label="العملة"><select defaultValue="SAR — ريال سعودي"><option>SAR — ريال سعودي</option><option>USD — دولار أمريكي</option></select></Field>
          <Field label="سعر الصرف"><input type="number" defaultValue="1.00" step="0.01" /></Field>
        </div>
        {invoiceType.includes("B2B") && <div className="si-buyer">
          <strong>بيانات المشتري (للفاتورة الضريبية)</strong>
          <div className="si-fields">
            <Field label="اسم المشتري"><input defaultValue={customer} /></Field>
            <Field label="الرقم الضريبي للمشتري"><input defaultValue="310123456700003" /></Field>
            <Field label="عنوان المشتري"><input defaultValue="الرياض، حي العليا" /></Field>
          </div>
        </div>}
      </section>}

      {tab === "items" && <section className="si-items-panel">
        <div className="si-section-heading"><strong>بنود الأصناف</strong><span>{lines.length} أصناف</span></div>
        <div className="si-table-wrap">
          <table className="si-table">
            <thead><tr><th className="si-number">#</th><th className="si-item">الصنف</th><th>الوحدة</th><th>الكمية</th><th>مجاني</th><th>سعر الوحدة</th><th>الخصم</th><th>ض. %</th><th>الإجمالي</th><th>إجراءات</th></tr></thead>
            <tbody>
              {lines.map((line, index) => {
                const lineTotal = line.qty * line.price - line.discount;
                return <tr key={index}>
                  <td className="si-muted">{index + 1}</td>
                  <td><input value={line.item} onChange={(e) => updateLine(index, "item", e.target.value)} /></td>
                  <td><select value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)}><option>عبوة</option><option>كرتون</option><option>كرتون (×12)</option></select></td>
                  <td><input type="number" value={line.qty} onChange={(e) => updateLine(index, "qty", Number(e.target.value))} /></td>
                  <td><input type="number" value={line.free} onChange={(e) => updateLine(index, "free", Number(e.target.value))} /></td>
                  <td><input type="number" value={line.price} onChange={(e) => updateLine(index, "price", Number(e.target.value))} /></td>
                  <td><div className="si-discount"><input type="number" value={line.discount} onChange={(e) => updateLine(index, "discount", Number(e.target.value))} /><select aria-label="نوع الخصم"><option>%</option><option>ر.س</option></select></div></td>
                  <td><input type="number" value={line.tax} onChange={(e) => updateLine(index, "tax", Number(e.target.value))} /></td>
                  <td className="si-total">ر.س {money(lineTotal + lineTotal * line.tax / 100)}</td>
                  <td className="si-actions"><button type="button" title="تفاصيل السطر">⋯</button><button type="button" title="حذف السطر" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>×</button></td>
                </tr>;
              })}
              <tr className="si-empty-row"><td colSpan={10}><span>＋ أضف صنفًا إلى الفاتورة</span></td></tr>
            </tbody>
          </table>
        </div>
        <div className="si-summary">
          <div><span>الإجمالي قبل الخصم</span><b>ر.س {money(totals.subtotal)}</b></div>
          <div><span>خصم البنود</span><b>ر.س {money(totals.lineDiscount)}</b></div>
          <label><span>خصم الفاتورة</span><input type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /><small>ر.س</small></label>
          <div><span>إجمالي الضريبة</span><b>ر.س {money(totals.tax)}</b></div>
          <div className="si-grand"><span>الإجمالي النهائي</span><b>ر.س {money(totals.grand)}</b></div>
        </div>
      </section>}

      {tab === "payments" && <section className="si-panel">
        <div className="si-fields">
          <Field label="طريقة الدفع"><select value={payment} onChange={(e) => setPayment(e.target.value)}><option>نقدي</option><option>بنك</option><option>آجل (على الحساب)</option><option>متعدد الطرق</option></select></Field>
          {(payment === "نقدي" || payment === "متعدد الطرق") && <Field label="الخزينة"><select defaultValue="الصندوق الرئيسي · SAR"><option>الصندوق الرئيسي · SAR</option><option>صندوق المعرض · SAR</option></select></Field>}
          {(payment === "بنك" || payment === "متعدد الطرق") && <Field label="البنك"><select defaultValue="مصرف الراجحي · SAR"><option>مصرف الراجحي · SAR</option><option>البنك الأهلي · SAR</option></select></Field>}
          {payment === "متعدد الطرق" && <>
            <Field label="المبلغ النقدي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.6)} /></Field>
            <Field label="المبلغ البنكي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.4)} /></Field>
            <Field label="المتبقي آجل · ر.س"><input readOnly value="0.00" /></Field>
          </>}
        </div>
        <Field label="ملاحظات" className="si-notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="أضف ملاحظات على الفاتورة..." /></Field>
      </section>}

      <footer className="si-footer">
        <div className="si-footer-left">{tab === "items" && <><button className="si-secondary" onClick={() => setLines((current) => [...current, { item: "", unit: "عبوة", qty: 1, free: 0, price: 0, discount: 0, tax: 15 }])}>＋ إضافة صنف</button><button className="si-secondary">اختيار أصناف</button><button className="si-secondary">✨ صنف جديد</button></>}</div>
        <div className="si-footer-actions"><button className="si-secondary">إلغاء</button><button className="si-save">حفظ وترحيل</button></div>
      </footer>
    </main>
  );
}
