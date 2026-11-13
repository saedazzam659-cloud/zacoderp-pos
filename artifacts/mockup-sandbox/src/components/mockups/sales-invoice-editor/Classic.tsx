import { useMemo, useState } from "react";
import "./_group.css";

type Line = { item: string; unit: string; qty: number; free: number; price: number; discount: number; tax: number };
const seedLines: Line[] = [
  { item: "قهوة عربية فاخرة 500 جم", unit: "عبوة", qty: 3, free: 0, price: 42, discount: 5, tax: 15 },
  { item: "تمر سكري فاخر — كرتون", unit: "كرتون (×12)", qty: 2, free: 1, price: 96, discount: 0, tax: 15 },
  { item: "ماء شرب 330 مل", unit: "كرتون", qty: 5, free: 0, price: 18, discount: 0, tax: 15 },
];
const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const css = `
.classic-invoice{--ink:#25374a;--muted:#69798a;--line:#c8d1d9;--paper:#f4f5f3;--panel:#fff;--blue:#1d5678;--blue2:#eaf1f5;--gold:#b38a44;min-height:100dvh;background:var(--paper);color:var(--ink);font:13px/1.45 "Segoe UI",Tahoma,sans-serif;padding:15px 20px 12px;direction:rtl}
.classic-invoice *{box-sizing:border-box}.classic-invoice button,.classic-invoice input,.classic-invoice select,.classic-invoice textarea{font:inherit}
.classic-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:#e8edf0;border:1px solid #c7d0d6;border-bottom:3px solid var(--blue);box-shadow:0 1px 2px #20354812}
.classic-brand{display:flex;align-items:center;gap:12px}.classic-mark{width:35px;height:35px;display:grid;place-items:center;background:var(--blue);color:white;font-weight:800;border-radius:2px;font-size:18px}.classic-brand strong{display:block;font-size:18px;letter-spacing:-.3px}.classic-brand small{display:block;color:var(--muted);font-size:11px;margin-top:1px}.classic-doc-ref{text-align:left;direction:ltr;color:#5d6c78;font:11px/1.6 "Segoe UI",sans-serif}.classic-doc-ref b{display:block;color:#314557;font-size:13px}
.classic-toolbar{display:flex;align-items:center;gap:7px;padding:7px 0 9px;border-bottom:1px solid #d5dadd;margin-bottom:9px}.classic-toolbar button{height:29px;padding:0 12px;background:#fff;border:1px solid #bdc9d1;border-radius:2px;color:#35495b;cursor:pointer;font-size:12px}.classic-toolbar .tool-primary{background:var(--blue);color:white;border-color:var(--blue)}.classic-toolbar .tool-status{margin-right:auto;color:#496a51;background:#edf4ee;border:1px solid #ccddcf;padding:4px 9px;font-size:11px}.classic-toolbar .tool-status.is-invalid{color:#9d493d;background:#fff0ec;border-color:#e5c3ba}
.classic-block{border:1px solid #c6cfd5;background:var(--panel);margin-bottom:10px;box-shadow:0 1px 1px #21384a0a}.classic-block-title{display:flex;align-items:center;gap:9px;padding:6px 10px;background:#edf1f3;border-bottom:1px solid #cbd3d8;font-weight:700;color:#304c61}.classic-block-title:before{content:"";width:3px;height:15px;background:var(--gold)}.classic-block-title em{margin-right:auto;color:#75828c;font-size:10px;font-style:normal;font-weight:500}
.classic-head-fields{display:grid;grid-template-columns:2fr 1.1fr 1.35fr 1.35fr 1.2fr;gap:7px 10px;padding:10px 12px 2px}.classic-field{min-width:0;display:flex;flex-direction:column;gap:3px;margin-bottom:7px;color:#475968;font-size:11px;font-weight:650}.classic-field input,.classic-field select,.classic-field textarea{width:100%;height:30px;padding:4px 7px;border:1px solid #bfcbd3;background:#fff;border-radius:2px;color:#253746;outline:none;font-size:12px}.classic-field input:focus,.classic-field select:focus,.classic-field textarea:focus{border-color:#457c9e;box-shadow:0 0 0 2px #1d56781c}.classic-field .required{color:#a04437}.classic-control-add{display:flex;gap:4px}.classic-control-add select{flex:1}.classic-control-add button{width:31px;border:1px solid #b9c8d1;background:#edf3f6;color:var(--blue);cursor:pointer}.classic-inline-error{font-size:10px;color:#a3453d;margin-top:1px}.classic-buyer{padding:0 12px}.classic-buyer .buyer-fields{display:grid;grid-template-columns:1.25fr 1fr 2fr;gap:10px}.classic-buyer-note{color:#8d6f30;font-size:10px;padding:0 0 7px}
.classic-lines-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#edf1f3;border-bottom:1px solid #cbd3d8}.classic-lines-head strong{color:#304c61}.classic-lines-head span{font-size:11px;color:#71808b}.classic-table-wrap{overflow-x:auto}.classic-table{border-collapse:collapse;width:100%;min-width:1080px;table-layout:fixed;direction:rtl}.classic-table th{height:29px;padding:4px 5px;text-align:right;white-space:nowrap;background:#f2f4f5;border-bottom:1px solid #c4cdd3;border-left:1px solid #d8dee2;color:#536472;font-size:10px;font-weight:700}.classic-table td{padding:4px 4px;border-left:1px solid #e0e4e7;border-bottom:1px solid #dce1e4;background:#fff}.classic-table tr:nth-child(even) td{background:#fafbfb}.classic-table tr:hover td{background:#f1f6f8}.classic-table th:nth-child(1){width:4%;text-align:center}.classic-table th:nth-child(2){width:21%}.classic-table th:nth-child(3){width:10%}.classic-table th:nth-child(4),.classic-table th:nth-child(5){width:7%;text-align:center}.classic-table th:nth-child(6){width:10%}.classic-table th:nth-child(7){width:12%}.classic-table th:nth-child(8){width:6%;text-align:center}.classic-table th:nth-child(9){width:13%}.classic-table th:nth-child(10){width:7%;text-align:center}.classic-table td input,.classic-table td select{width:100%;height:28px;padding:3px 5px;border:1px solid #c8d1d7;border-radius:2px;background:white;color:#263949;font-size:11px}.classic-table td:nth-child(4) input,.classic-table td:nth-child(5) input,.classic-table td:nth-child(6) input,.classic-table td:nth-child(8) input{text-align:center;direction:ltr}.classic-row-num{text-align:center;color:#82909a;font:11px "Segoe UI",sans-serif}.classic-discount{display:flex;gap:3px}.classic-discount select{max-width:42px;padding:2px!important}.classic-line-total{font-weight:700;white-space:nowrap;color:#294b61;direction:ltr;text-align:left;font-size:11px}.classic-row-actions{white-space:nowrap;text-align:center}.classic-row-actions button{border:0;background:none;color:#567084;cursor:pointer;padding:3px 5px;font-size:14px}.classic-row-actions button:last-child{color:#a3473c}.classic-add-row{height:34px;text-align:center;background:#f7f9f9!important}.classic-add-row button{padding:4px 12px;border:1px dashed #9aabb5;background:#fff;color:#365d75;cursor:pointer;border-radius:2px;font-size:11px}
.classic-totals{display:flex;align-items:stretch;gap:0;border-top:1px solid #c8d1d7;background:#f7f8f7;direction:rtl}.classic-total-item{flex:1;min-width:120px;padding:8px 10px;border-left:1px solid #d7dde0;display:flex;justify-content:space-between;align-items:center;gap:8px;color:#63717c;font-size:11px}.classic-total-item b{color:#304555;font:700 12px "Segoe UI",sans-serif;direction:ltr;white-space:nowrap}.classic-total-item input{width:68px;height:25px;border:1px solid #c3cdd3;padding:3px;text-align:left;direction:ltr}.classic-total-grand{background:#e8eff2;color:#284b60;font-weight:700}.classic-total-grand b{color:#1d5678;font-size:15px}
.classic-bottom{display:grid;grid-template-columns:1.15fr 1fr 1.7fr;gap:10px}.classic-payment-fields{padding:9px 10px 2px;display:grid;grid-template-columns:1fr 1fr;gap:0 9px}.classic-notes{padding:9px 10px 2px}.classic-notes textarea{height:69px!important;resize:vertical}.classic-payment-note{grid-column:1/-1;font-size:10px;color:#7e6a3b;margin:-2px 0 6px}.classic-zatca{padding:8px 10px 3px;display:flex;flex-direction:column;gap:2px}.classic-zatca-row{display:flex;justify-content:space-between;padding:3px 1px;border-bottom:1px dotted #d1d8dc;color:#61717d;font-size:11px}.classic-zatca-row b{color:#31495b}.classic-zatca-row .warning{color:#a24e42}.classic-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:3px;padding-top:8px;border-top:1px solid #cbd3d8}.classic-footer small{color:#76838c;font-size:10px}.classic-actions{display:flex;gap:7px}.classic-actions button{padding:7px 17px;border:1px solid #b9c6ce;border-radius:2px;background:#fff;color:#405363;cursor:pointer;font-weight:650}.classic-actions .save{background:#1d5678;border-color:#1d5678;color:white}.classic-actions .save:hover{background:#164662}.classic-toast{position:fixed;bottom:18px;left:22px;z-index:5;padding:10px 15px;background:#e7f1eb;border:1px solid #b7cdbd;color:#355a42;box-shadow:0 4px 18px #20354820;font-size:12px}
@media(max-width:900px){.classic-invoice{padding:10px}.classic-head-fields{grid-template-columns:repeat(3,minmax(0,1fr))}.classic-bottom{grid-template-columns:1fr 1fr}.classic-zatca{grid-column:1/-1}.classic-totals{overflow-x:auto}.classic-total-item{min-width:145px}}
@media(max-width:600px){.classic-top{align-items:flex-start}.classic-brand strong{font-size:15px}.classic-doc-ref{font-size:10px}.classic-toolbar{flex-wrap:wrap}.classic-toolbar .tool-status{margin-right:0}.classic-head-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.classic-buyer .buyer-fields{grid-template-columns:1fr}.classic-bottom{grid-template-columns:1fr}.classic-zatca{grid-column:auto}.classic-footer{align-items:flex-start;flex-direction:column}.classic-actions{width:100%}.classic-actions button{flex:1}.classic-totals{justify-content:flex-start}}
`;
function Field({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return <label className="classic-field"><span>{label}{required && <i className="required"> *</i>}</span>{children}</label>;
}

export function Classic() {
  const [lines, setLines] = useState(seedLines);
  const [customer, setCustomer] = useState("مؤسسة النور التجارية");
  const [invoiceType, setInvoiceType] = useState("مبسّطة (B2C)");
  const [payment, setPayment] = useState("نقدي");
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState("");
  const [toast, setToast] = useState("");
  const [buyerName, setBuyerName] = useState("مؤسسة النور التجارية");
  const [buyerTax, setBuyerTax] = useState("310123456700003");
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
    const tax = lines.reduce((sum, line) => sum + (line.qty * line.price - line.discount) * line.tax / 100, 0);
    return { subtotal, lineDiscount, tax, grand: subtotal - lineDiscount - discount + tax };
  }, [lines, discount]);
  const updateLine = (index: number, key: keyof Line, value: string | number) =>
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
  const addLine = (item = "") => setLines((current) => [...current, { item, unit: "عبوة", qty: 1, free: 0, price: item ? 24 : 0, discount: 0, tax: 15 }]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  const reset = () => {
    setLines(seedLines); setCustomer("مؤسسة النور التجارية"); setInvoiceType("مبسّطة (B2C)");
    setPayment("نقدي"); setDiscount(0); setNotes(""); notify("أُعيدت الحقول إلى بيانات الفاتورة الحالية");
  };
  const invalidLine = lines.some((line) => !line.item.trim() || line.qty <= 0 || line.price < 0);
  const invalidTax = invoiceType.includes("B2B") && buyerTax.replace(/\D/g, "").length !== 15;
  return (
    <main className="classic-invoice" dir="rtl" lang="ar">
      <style>{css}</style>
      <header className="classic-top">
        <div className="classic-brand"><div className="classic-mark">ز</div><div><strong>فاتورة مبيعات</strong><small>إدخال مستند جديد · نقطة البيع الرئيسية</small></div></div>
        <div className="classic-doc-ref"><b>SALES INVOICE / NEW</b>مستند غير مرحّل · رقم تلقائي عند الحفظ</div>
      </header>
      <nav className="classic-toolbar" aria-label="إجراءات المستند">
        <button type="button" className="tool-primary" onClick={() => addLine()}>＋ سطر جديد</button>
        <button type="button" onClick={() => addLine("صنف من قائمة الأصناف")}>اختيار صنف</button>
        <button type="button" onClick={() => notify("إضافة صنف جديد — نموذج محلي للمعاينة")}>تعريف صنف</button>
        <button type="button" onClick={() => notify("تم فتح معاينة الطباعة المحلية")}>معاينة الطباعة</button>
        <span className={`tool-status${invalidLine || invalidTax ? " is-invalid" : ""}`}>{invalidLine || invalidTax ? "تحقق مطلوب · راجع الحقول المعلّمة" : "✓ جاهز للمراجعة · العميل محدد"}</span>
      </nav>
      <section className="classic-block">
        <div className="classic-block-title">بيانات المستند <em>حقول الفاتورة الأساسية</em></div>
        <div className="classic-head-fields">
          <Field label="العميل" required><div className="classic-control-add"><select value={customer} onChange={(e) => setCustomer(e.target.value)}><option>مؤسسة النور التجارية</option><option>شركة أبعاد للتجارة</option><option>عميل نقدي</option></select><button type="button" title="إضافة عميل" onClick={() => notify("إضافة عميل — بيانات تجريبية فقط")}>＋</button></div></Field>
          <Field label="تاريخ الفاتورة"><input type="date" defaultValue="2025-02-18" /></Field>
          <Field label="المستودع"><select defaultValue="المستودع الرئيسي"><option>المستودع الرئيسي</option><option>مستودع المعرض</option></select></Field>
          <Field label="مجموعة الضريبة"><select defaultValue="ضريبة القيمة المضافة — 15%"><option>ضريبة القيمة المضافة — 15%</option><option>بدون ضريبة</option></select></Field>
          <Field label="الفرع"><select defaultValue="الفرع الرئيسي"><option>الفرع الرئيسي</option><option>فرع الشمال</option></select></Field>
          <Field label="مركز التكلفة"><select defaultValue="— بدون —"><option>— بدون —</option><option>المبيعات العامة</option></select></Field>
          <Field label="مندوب المبيعات"><select defaultValue="سارة العتيبي"><option>سارة العتيبي</option><option>محمد القحطاني</option><option>— بدون —</option></select></Field>
          <Field label="نوع الفاتورة (زاتكا)"><select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}><option>مبسّطة (B2C)</option><option>ضريبية (B2B)</option></select></Field>
          <Field label="العملة"><select defaultValue="SAR — ريال سعودي"><option>SAR — ريال سعودي</option><option>USD — دولار أمريكي</option></select></Field>
          <Field label="سعر الصرف"><input type="number" defaultValue="1.00" step="0.01" /></Field>
        </div>
        <div className="classic-buyer">
          <div className="classic-block-title" style={{ margin: "0 -12px 8px", borderTop: "1px solid #d8dfe3" }}>بيانات المشتري وزاتكا <em>{invoiceType.includes("B2B") ? "مطلوبة للإصدار الضريبي" : "تُستخدم عند إصدار فاتورة ضريبية"}</em></div>
          <div className="buyer-fields">
            <Field label="اسم المشتري"><input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} /></Field>
            <Field label="الرقم الضريبي للمشتري"><input value={buyerTax} onChange={(e) => setBuyerTax(e.target.value)} /></Field>
            <Field label="عنوان المشتري"><input defaultValue="الرياض، حي العليا" /></Field>
          </div>
          {invalidTax && <div className="classic-buyer-note">تنبيه: الرقم الضريبي يتكون من ١٥ رقمًا.</div>}
        </div>
      </section>
      <section className="classic-block">
        <div className="classic-lines-head"><strong>تفاصيل الأصناف</strong><span>{lines.length} بنود · أدخل الكميات والأسعار مباشرة في الجدول</span></div>
        <div className="classic-table-wrap"><table className="classic-table">
          <thead><tr><th>#</th><th>الصنف / البيان</th><th>الوحدة</th><th>الكمية</th><th>مجاني</th><th>سعر الوحدة</th><th>الخصم</th><th>ض. %</th><th>الإجمالي شامل الضريبة</th><th>حذف</th></tr></thead>
          <tbody>{lines.map((line, index) => {
            const net = line.qty * line.price - line.discount;
            return <tr key={index}>
              <td className="classic-row-num">{index + 1}</td>
              <td><input aria-label="الصنف" value={line.item} onChange={(e) => updateLine(index, "item", e.target.value)} /></td>
              <td><select aria-label="الوحدة" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)}><option>عبوة</option><option>كرتون</option><option>كرتون (×12)</option></select></td>
              <td><input aria-label="الكمية" type="number" min="0" value={line.qty} onChange={(e) => updateLine(index, "qty", Number(e.target.value))} /></td>
              <td><input aria-label="كمية مجانية" type="number" min="0" value={line.free} onChange={(e) => updateLine(index, "free", Number(e.target.value))} /></td>
              <td><input aria-label="سعر الوحدة" type="number" min="0" value={line.price} onChange={(e) => updateLine(index, "price", Number(e.target.value))} /></td>
              <td><div className="classic-discount"><input aria-label="الخصم" type="number" min="0" value={line.discount} onChange={(e) => updateLine(index, "discount", Number(e.target.value))} /><select aria-label="نوع الخصم"><option>%</option><option>ر.س</option></select></div></td>
              <td><input aria-label="نسبة الضريبة" type="number" min="0" value={line.tax} onChange={(e) => updateLine(index, "tax", Number(e.target.value))} /></td>
              <td className="classic-line-total">ر.س {money(net + net * line.tax / 100)}</td>
              <td className="classic-row-actions"><button type="button" title="حذف السطر" aria-label="حذف السطر" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>×</button></td>
            </tr>;
          })}
          <tr className="classic-add-row"><td colSpan={10}><button type="button" onClick={() => addLine()}>＋ إضافة صنف إلى الفاتورة</button></td></tr>
          </tbody>
        </table></div>
        {invalidLine && <div style={{ padding: "5px 10px", color: "#a3453d", background: "#fff6f3", fontSize: 11 }}>راجع سطور الأصناف: يجب إدخال اسم الصنف وكمية أكبر من صفر.</div>}
        <div className="classic-totals">
          <div className="classic-total-item"><span>الإجمالي قبل الخصم</span><b>ر.س {money(totals.subtotal)}</b></div>
          <div className="classic-total-item"><span>خصم البنود</span><b>ر.س {money(totals.lineDiscount)}</b></div>
          <label className="classic-total-item"><span>خصم الفاتورة</span><input aria-label="خصم الفاتورة" type="number" min="0" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></label>
          <div className="classic-total-item"><span>إجمالي الضريبة</span><b>ر.س {money(totals.tax)}</b></div>
          <div className="classic-total-item classic-total-grand"><span>الصافي المستحق</span><b>ر.س {money(totals.grand)}</b></div>
        </div>
      </section>
      <div className="classic-bottom">
        <section className="classic-block">
          <div className="classic-block-title">طريقة السداد</div>
          <div className="classic-payment-fields">
            <Field label="طريقة الدفع"><select value={payment} onChange={(e) => setPayment(e.target.value)}><option>نقدي</option><option>بنك</option><option>آجل (على الحساب)</option><option>متعدد الطرق</option></select></Field>
            {(payment === "نقدي" || payment === "متعدد الطرق") && <Field label="الخزينة"><select defaultValue="الصندوق الرئيسي · SAR"><option>الصندوق الرئيسي · SAR</option><option>صندوق المعرض · SAR</option></select></Field>}
            {(payment === "بنك" || payment === "متعدد الطرق") && <Field label="الحساب البنكي"><select defaultValue="مصرف الراجحي · SAR"><option>مصرف الراجحي · SAR</option><option>البنك الأهلي · SAR</option></select></Field>}
            {payment === "متعدد الطرق" && <>
              <Field label="المبلغ النقدي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.6)} /></Field>
              <Field label="المبلغ البنكي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.4)} /></Field>
              <div className="classic-payment-note">يتم توزيع مبلغ السداد محليًا للمعاينة.</div>
            </>}
          </div>
        </section>
        <section className="classic-block">
          <div className="classic-block-title">ملاحظات المستند</div>
          <div className="classic-notes"><Field label="ملاحظات داخلية"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اكتب ملاحظة للفريق أو للتسليم..." /></Field></div>
        </section>
        <section className="classic-block">
          <div className="classic-block-title">التحقق الضريبي · زاتكا</div>
          <div className="classic-zatca">
            <div className="classic-zatca-row"><span>تصنيف الفاتورة</span><b>{invoiceType}</b></div>
            <div className="classic-zatca-row"><span>بيانات المشتري</span><b className={invoiceType.includes("B2B") && invalidTax ? "warning" : ""}>{invoiceType.includes("B2B") ? (invalidTax ? "يلزم التحقق" : "مكتملة") : "غير مطلوبة"}</b></div>
            <div className="classic-zatca-row"><span>معالجة الضريبة</span><b>ضريبة القيمة المضافة · 15%</b></div>
          </div>
        </section>
      </div>
      <footer className="classic-footer">
        <small>المستخدم: سارة العتيبي　·　الفرع الرئيسي　·　تاريخ المستند: 18/02/2025</small>
        <div className="classic-actions"><button type="button" onClick={reset}>إلغاء / إعادة</button><button type="button" className="save" onClick={() => notify(invalidLine || invalidTax ? "تعذر التحقق: راجع الحقول المحددة قبل الحفظ" : "تم التحقق محليًا — لا يتم حفظ أي بيانات")}>حفظ وترحيل</button></div>
      </footer>
      {toast && <div role="status" className="classic-toast">{toast}</div>}
    </main>
  );
}
