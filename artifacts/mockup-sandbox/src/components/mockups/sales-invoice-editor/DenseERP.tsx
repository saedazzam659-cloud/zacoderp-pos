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
  return <label className={`de-field ${className}`}><span>{label}</span>{children}</label>;
}

export function DenseERP() {
  const [lines, setLines] = useState(initialLines);
  const [payment, setPayment] = useState("نقدي");
  const [notes, setNotes] = useState("");
  const [invoiceType, setInvoiceType] = useState("مبسّطة (B2C)");
  const [discount, setDiscount] = useState(0);
  const [customer, setCustomer] = useState("مؤسسة النور التجارية");
  const [notice, setNotice] = useState("");
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
    const tax = lines.reduce((sum, line) => sum + (line.qty * line.price - line.discount) * line.tax / 100, 0);
    return { subtotal, lineDiscount, tax, grand: subtotal - lineDiscount - discount + tax };
  }, [lines, discount]);
  const updateLine = (index: number, key: keyof Line, value: string | number) =>
    setLines(current => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
  const addLine = () => setLines(current => [...current, { item: "", unit: "عبوة", qty: 1, free: 0, price: 0, discount: 0, tax: 15 }]);

  return <main className="de-page" dir="rtl" lang="ar">
    <header className="de-top">
      <div className="de-brand"><span className="de-mark">ز</span><div><b>ZACODE <em>ERP</em></b><small>المبيعات / فاتورة جديدة</small></div></div>
      <div className="de-doc"><span className="de-status">مسودة جديدة</span><strong>فاتورة مبيعات</strong><small>رقم المستند <b>تلقائي عند الحفظ</b></small></div>
      <div className="de-keys"><kbd>F2</kbd> العميل <i /> <kbd>F4</kbd> إضافة صنف <i /> <kbd>Ctrl + S</kbd> حفظ</div>
    </header>
    <div className="de-context"><span><b>INV</b> مستند مبيعات جديد</span><span>آخر رقم محفوظ <strong>INV-2025-2486</strong></span><span className="de-context-count">{lines.length} بنود في الفاتورة</span></div>

    <section className="de-card">
      <div className="de-section-title"><span>أ</span><div><strong>بيانات المستند</strong><small>أدخل المعلومات الأساسية قبل إضافة تفاصيل الأصناف</small></div><b className="de-required">* حقل إلزامي</b></div>
      <div className="de-fields">
        <Field label="العميل *" className="de-customer"><div className="de-with-add"><select value={customer} onChange={e => setCustomer(e.target.value)}><option>مؤسسة النور التجارية</option><option>شركة أبعاد للتجارة</option><option>عميل نقدي</option></select><button type="button" onClick={() => setNotice("إضافة عميل جديد — النموذج المحلي جاهز")}>＋</button></div><small className="de-valid">● الرصيد المتاح: 18,450.00 ر.س</small></Field>
        <Field label="تاريخ الفاتورة *"><input type="date" defaultValue="2025-02-18" /></Field>
        <Field label="المستودع *"><select defaultValue="المستودع الرئيسي"><option>المستودع الرئيسي</option><option>مستودع المعرض</option></select></Field>
        <Field label="الضريبة"><select defaultValue="ضريبة القيمة المضافة — 15%"><option>ضريبة القيمة المضافة — 15%</option><option>بدون ضريبة</option></select></Field>
        <Field label="الفرع"><select defaultValue="الفرع الرئيسي"><option>الفرع الرئيسي</option><option>فرع الشمال</option></select></Field>
        <Field label="مركز التكلفة"><select defaultValue="— بدون —"><option>— بدون —</option><option>المبيعات العامة</option></select></Field>
        <Field label="مندوب المبيعات"><select defaultValue="سارة العتيبي"><option>سارة العتيبي</option><option>محمد القحطاني</option><option>— بدون —</option></select></Field>
        <Field label="نوع الفاتورة (زاتكا)"><select value={invoiceType} onChange={e => setInvoiceType(e.target.value)}><option>مبسّطة (B2C)</option><option>ضريبية (B2B)</option></select></Field>
        <Field label="العملة"><select defaultValue="SAR — ريال سعودي"><option>SAR — ريال سعودي</option><option>USD — دولار أمريكي</option></select></Field>
        <Field label="سعر الصرف"><input type="number" defaultValue="1.00" step="0.01" /></Field>
      </div>
    </section>

    <section className="de-card de-items">
      <div className="de-section-title"><span>ب</span><div><strong>تفاصيل الأصناف</strong><small>أدخل الكميات والأسعار مباشرة — استخدم Tab للتنقل بين الخانات</small></div><div className="de-grid-shortcut"><kbd>F4</kbd> إضافة سطر</div></div>
      <div className="de-table-scroll"><table className="de-table"><thead><tr><th>#</th><th>الصنف / الباركود</th><th>الوحدة</th><th>الكمية</th><th>مجاني</th><th>سعر الوحدة</th><th>الخصم</th><th>ضريبة %</th><th>الإجمالي شامل الضريبة</th><th></th></tr></thead>
        <tbody>{lines.map((line, index) => { const net = line.qty * line.price - line.discount; return <tr key={index}>
          <td className="de-row-no">{String(index + 1).padStart(2, "0")}</td>
          <td><input className={!line.item ? "de-invalid" : ""} aria-label="الصنف" value={line.item} placeholder="ابحث بالاسم أو الرمز..." onChange={e => updateLine(index, "item", e.target.value)} />{!line.item && <small className="de-error">اختر صنفًا مطلوبًا</small>}</td>
          <td><select value={line.unit} aria-label="الوحدة" onChange={e => updateLine(index, "unit", e.target.value)}><option>عبوة</option><option>كرتون</option><option>كرتون (×12)</option></select></td>
          <td><input type="number" aria-label="الكمية" value={line.qty} onChange={e => updateLine(index, "qty", Number(e.target.value))} /></td>
          <td><input type="number" aria-label="كمية مجانية" value={line.free} onChange={e => updateLine(index, "free", Number(e.target.value))} /></td>
          <td><input type="number" aria-label="سعر الوحدة" value={line.price} onChange={e => updateLine(index, "price", Number(e.target.value))} /></td>
          <td><div className="de-discount"><input type="number" aria-label="الخصم" value={line.discount} onChange={e => updateLine(index, "discount", Number(e.target.value))} /><select aria-label="نوع الخصم"><option>ر.س</option><option>%</option></select></div></td>
          <td><input type="number" aria-label="نسبة الضريبة" value={line.tax} onChange={e => updateLine(index, "tax", Number(e.target.value))} /></td>
          <td className="de-line-total">{money(net + net * line.tax / 100)} <small>ر.س</small></td>
          <td><button className="de-remove" type="button" aria-label="حذف السطر" onClick={() => setLines(current => current.filter((_, i) => i !== index))}>×</button></td>
        </tr>; })}</tbody></table></div>
      <button className="de-add-line" type="button" onClick={addLine}>＋ <b>إضافة صنف</b><span>إضافة صنف جديد للفاتورة</span></button>
      <div className="de-totals">
        <div><small>الإجمالي قبل الخصم</small><b>{money(totals.subtotal)} <i>ر.س</i></b></div>
        <div><small>خصم البنود</small><b>{money(totals.lineDiscount)} <i>ر.س</i></b></div>
        <label><small>خصم الفاتورة</small><span><input type="number" value={discount} onChange={e => setDiscount(Number(e.target.value))} /><i>ر.س</i></span></label>
        <div><small>إجمالي الضريبة</small><b>{money(totals.tax)} <i>ر.س</i></b></div>
        <div className="de-grand"><small>الإجمالي المستحق</small><b>{money(totals.grand)} <i>ر.س</i></b></div>
      </div>
    </section>

    <section className="de-card">
      <div className="de-section-title"><span>ج</span><div><strong>السداد ومعلومات المشتري</strong><small>حدد طريقة التحصيل وأكمل بيانات الفاتورة عند الحاجة</small></div></div>
      <div className="de-fields">
        <Field label="طريقة الدفع"><select value={payment} onChange={e => setPayment(e.target.value)}><option>نقدي</option><option>بنك</option><option>آجل (على الحساب)</option><option>متعدد الطرق</option></select></Field>
        {(payment === "نقدي" || payment === "متعدد الطرق") && <Field label="الخزينة"><select defaultValue="الصندوق الرئيسي · SAR"><option>الصندوق الرئيسي · SAR</option><option>صندوق المعرض · SAR</option></select></Field>}
        {(payment === "بنك" || payment === "متعدد الطرق") && <Field label="البنك"><select defaultValue="مصرف الراجحي · SAR"><option>مصرف الراجحي · SAR</option><option>البنك الأهلي · SAR</option></select></Field>}
        {payment === "متعدد الطرق" && <><Field label="المبلغ النقدي · ر.س"><input type="number" defaultValue={money(totals.grand * .6)} /></Field><Field label="المبلغ البنكي · ر.س"><input type="number" defaultValue={money(totals.grand * .4)} /></Field><Field label="المتبقي آجل · ر.س"><input readOnly value="0.00" /></Field></>}
      </div>
      <div className="de-buyer"><div className="de-subtitle">بيانات المشتري وزاتكا <span>الفاتورة المبسطة — بيانات المشتري اختيارية</span></div><div className="de-fields"><Field label="اسم المشتري"><input placeholder="اسم المنشأة أو المشتري" /></Field><Field label="الرقم الضريبي للمشتري"><input placeholder="15 رقمًا" /></Field><Field label="عنوان المشتري"><input placeholder="المدينة، الحي، الشارع" /></Field></div></div>
      <Field label="ملاحظات داخلية" className="de-notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="ملاحظات تظهر للفريق ولا تطبع على الفاتورة..." /></Field>
    </section>

    <footer className="de-footer">
      <div className="de-footer-meta"><span className="de-warning-dot">!</span><span><b>{lines.some(line => !line.item) ? "يوجد صنف يحتاج إلى استكمال" : "جميع الحقول الأساسية مكتملة"}</b><small>راجع الأصناف قبل ترحيل الفاتورة</small></span></div>
      <div className="de-footer-buttons"><button className="de-plain" onClick={addLine}>＋ إضافة صنف</button><button className="de-cancel" type="button" onClick={() => { setNotice("تم إلغاء التعديلات المحلية"); setLines(initialLines); setNotes(""); }}>إلغاء</button><button className="de-save" type="button" onClick={() => setNotice(lines.some(line => !line.item) ? "تعذر الحفظ: أكمل بيانات الصنف المحدد باللون الأحمر" : "تم التحقق — هذه معاينة دون حفظ فعلي")}><span>حفظ وترحيل</span><kbd>Ctrl + S</kbd></button></div>
    </footer>
    {notice && <div className="de-notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="إغلاق">×</button></div>}
  </main>;
}

const style = document.createElement("style");
style.dataset.denseErp = "true";
style.textContent = `
.de-page{--ink:#263b43;--muted:#728087;--line:#d3ddd9;--teal:#087e78;--deep:#174d50;--paper:#f1f4ef;min-height:100vh;padding:14px 22px 12px;color:var(--ink);background:var(--paper);font:12px/1.35 "Segoe UI",Tahoma,sans-serif;display:flex;flex-direction:column;gap:9px;box-sizing:border-box;position:relative}
.de-page *{box-sizing:border-box}.de-page button,.de-page input,.de-page select,.de-page textarea{font:inherit}.de-page button{cursor:pointer}.de-top{display:flex;align-items:center;gap:26px;min-height:52px;padding:0 2px;border-bottom:1px solid #c8d4ce}.de-brand{display:flex;align-items:center;gap:10px;min-width:185px}.de-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:5px;background:var(--deep);color:#eaf1d9;font-size:22px;font-weight:800}.de-brand b{font-size:13px;letter-spacing:1.3px;color:#264c4e}.de-brand em{font-style:normal;color:#b48045}.de-brand small{display:block;color:#79868a;font-size:10px;margin-top:2px}.de-doc{display:flex;align-items:center;gap:12px;flex:1}.de-doc strong{font-size:16px;color:#1c343a}.de-doc small{color:var(--muted);border-right:1px solid var(--line);padding-right:12px}.de-doc small b{color:#465b5d;margin-right:5px}.de-status{padding:4px 8px;background:#f1e5c9;color:#80551d;border-radius:3px;font-weight:700;font-size:10px}.de-keys{color:#7a8588;font-size:10px;white-space:nowrap}.de-keys kbd,.de-grid-shortcut kbd,.de-save kbd{font:9px ui-monospace,monospace;color:#51636a;background:#e7ece8;border:1px solid #ced8d1;border-radius:3px;padding:2px 4px}.de-keys i{display:inline-block;height:12px;border-right:1px solid #cbd3cf;margin:0 8px -3px}.de-tabs{display:flex;align-items:stretch;min-height:37px;border-bottom:1px solid #c7d2cc;gap:5px}.de-tabs button{padding:0 14px;background:transparent;border:0;border-bottom:2px solid transparent;color:#66757a;font-weight:600}.de-tabs button b{font:10px ui-monospace,monospace;color:#91a09d;margin-left:6px}.de-tabs button.active{color:var(--deep);border-bottom-color:#af7e42}.de-tabs button span{display:inline-grid;place-items:center;min-width:17px;height:17px;border-radius:9px;background:#e4ebe6;color:#526767;font-size:10px;margin-right:4px}.de-tabs-aside{margin-right:auto;align-self:center;color:#84918f;font-size:10px}.de-tabs-aside strong{color:#506364;margin-right:5px;font:10px ui-monospace,monospace}
.de-card{background:#fbfcf8;border:1px solid #cbd6cf;box-shadow:0 1px 2px #263c3711;padding:13px 15px;flex:1}.de-section-title{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:9px;border-bottom:1px solid #e0e6e1}.de-section-title>span{display:grid;place-items:center;width:25px;height:25px;border:1px solid #c8d4ca;border-radius:4px;color:var(--teal);font-weight:800}.de-section-title strong{display:block;color:#304a4c;font-size:13px}.de-section-title small{display:block;color:#87928f;margin-top:2px;font-size:10px}.de-required{margin-right:auto;color:#a66b38;font-size:10px}.de-fields{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px 12px}.de-field{display:flex;min-width:0;flex-direction:column;gap:4px;color:#56666a}.de-field>span{font-size:10px;color:#536568;font-weight:700}.de-page input,.de-page select,.de-page textarea{height:30px;width:100%;min-width:0;padding:4px 8px;border:1px solid #cbd6d1;border-radius:3px;outline:none;color:#293d42;background:#fff;font-size:11px}.de-page input:focus,.de-page select:focus,.de-page textarea:focus{border-color:#338d83;box-shadow:0 0 0 2px #32877d20}.de-page input[readonly]{background:#edf1ec;color:#66766d}.de-customer{grid-column:span 2}.de-with-add{display:flex;gap:4px}.de-with-add select{flex:1}.de-with-add button{width:31px;border:1px solid #adc5bb;border-radius:3px;background:#e9f0eb;color:#176c66;font-weight:700;font-size:16px}.de-valid{color:#3b7b68;font-size:9px}.de-buyer{margin-top:12px;padding:9px 10px 1px;background:#f1f5f0;border:1px solid #dce4de;border-right:3px solid #b0834c}.de-subtitle{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:#465b58;margin-bottom:8px}.de-subtitle span{font-size:9px;font-weight:500;color:#8b775b}.de-buyer .de-fields{grid-template-columns:repeat(3,minmax(0,1fr))}.de-items{padding-bottom:12px}.de-grid-shortcut{margin-right:auto;color:#7b8985;font-size:10px}.de-table-scroll{overflow-x:auto;border:1px solid #cbd5cf;background:#fff}.de-table{width:100%;min-width:1020px;border-collapse:collapse;table-layout:fixed}.de-table th{height:29px;background:#e7ede8;color:#4c6061;font-size:10px;text-align:right;padding:5px 7px;border-bottom:1px solid #c4d0c8;white-space:nowrap}.de-table th:first-child{width:4%;text-align:center}.de-table th:nth-child(2){width:24%}.de-table th:nth-child(3){width:10%}.de-table th:nth-child(4),.de-table th:nth-child(5){width:7%;text-align:center}.de-table th:nth-child(6){width:10%;text-align:center}.de-table th:nth-child(7){width:11%}.de-table th:nth-child(8){width:8%;text-align:center}.de-table th:nth-child(9){width:15%;text-align:left}.de-table td{height:45px;padding:4px 5px;border-bottom:1px solid #e4e9e5;vertical-align:middle}.de-table tbody tr:nth-child(even){background:#f8faf7}.de-table tbody tr:focus-within{background:#edf5ef}.de-table td input,.de-table td select{height:29px;padding:4px 6px}.de-table td:nth-child(4) input,.de-table td:nth-child(5) input,.de-table td:nth-child(6) input,.de-table td:nth-child(8) input{text-align:center;font-variant-numeric:tabular-nums}.de-row-no{text-align:center;color:#84918e;font:10px ui-monospace,monospace}.de-line-total{text-align:left;white-space:nowrap;font-weight:700;color:#285e58;font-variant-numeric:tabular-nums}.de-line-total small{font-size:9px;color:#87928d}.de-discount{display:flex;gap:3px}.de-discount select{width:43px;padding:3px}.de-remove{width:25px;height:25px;border:0;background:transparent;color:#a15a4b;font-size:18px}.de-invalid{border-color:#bd624d!important;background:#fff7f4!important}.de-error{display:block;color:#ac4e3d;font-size:9px;margin-top:2px}.de-add-line{display:flex;align-items:center;gap:7px;margin-top:7px;padding:7px 11px;border:1px dashed #9dbcb0;border-radius:3px;background:#f5f9f5;color:#1a7169}.de-add-line span{color:#86938e;font-size:9px}.de-totals{display:grid;grid-template-columns:1fr 1fr 1.2fr 1fr 1.35fr;gap:8px;margin-top:11px}.de-totals>div,.de-totals>label{min-width:0;display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px solid #d9e0da;border-radius:3px;background:#f7f9f5}.de-totals small{color:#71807d;font-size:10px}.de-totals b{color:#30484a;font-size:13px;font-variant-numeric:tabular-nums}.de-totals i{font-style:normal;font-size:9px;color:#85918c}.de-totals label span{display:flex;align-items:center;gap:5px}.de-totals label input{height:25px;max-width:120px}.de-totals .de-grand{background:#e3eee7;border-color:#a8c4b3;border-top:2px solid #32776e}.de-grand b{font-size:17px;color:#175d55}.de-notes{margin-top:12px}.de-page .de-notes textarea{height:62px;resize:vertical}.de-footer{margin-top:auto;padding:9px 0 0;border-top:1px solid #cbd6cf;display:flex;align-items:center;justify-content:space-between;gap:12px}.de-footer-meta{display:flex;align-items:center;gap:8px}.de-warning-dot{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#f4ead7;color:#a06d2e;font-weight:800}.de-footer-meta b{display:block;color:#56665f;font-size:10px}.de-footer-meta small{display:block;color:#89948f;font-size:9px;margin-top:2px}.de-footer-buttons{display:flex;align-items:center;gap:7px}.de-footer-buttons button{height:33px;padding:0 14px;border-radius:3px;font-weight:700}.de-plain{border:1px solid #b7cbc0;background:#f4f8f3;color:#246c63}.de-cancel{border:1px solid #cbd4cf;background:#fbfcf8;color:#586769}.de-save{display:flex;align-items:center;gap:12px;border:1px solid #176e67;background:#176e67;color:#fff}.de-save kbd{color:#dceae4;background:#236f69;border-color:#59928a}.de-notice{position:fixed;left:22px;bottom:60px;z-index:5;display:flex;align-items:center;gap:14px;padding:10px 14px;background:#284b49;color:#fff;border-radius:4px;box-shadow:0 5px 18px #1d34352b}.de-notice button{border:0;background:transparent;color:#fff;font-size:18px}
@media(max-width:900px){.de-page{padding:12px}.de-fields{grid-template-columns:repeat(3,minmax(0,1fr))}.de-totals{grid-template-columns:repeat(3,minmax(0,1fr))}.de-keys{display:none}.de-table{min-width:920px}}
@media(max-width:600px){.de-top{gap:10px;flex-wrap:wrap;padding-bottom:8px}.de-brand{min-width:130px}.de-doc{gap:6px}.de-doc strong{font-size:13px}.de-tabs{overflow-x:auto}.de-tabs button{white-space:nowrap;padding:0 8px;font-size:10px}.de-tabs-aside{display:none}.de-fields,.de-buyer .de-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.de-customer{grid-column:span 2}.de-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.de-totals .de-grand{grid-column:span 2}.de-footer{align-items:flex-start;flex-direction:column}.de-footer-buttons{width:100%;justify-content:flex-end}.de-section-title{align-items:flex-start}.de-card{padding:10px}.de-required{font-size:9px}}
`;
style.textContent += `.de-page{padding:10px 20px;gap:6px}.de-context{display:flex;align-items:center;gap:18px;min-height:25px;padding:3px 10px;background:#e7ede8;border-right:3px solid #af7e42;color:#677976;font-size:10px}.de-context b{color:#326b65;font:700 10px ui-monospace,monospace;margin-left:5px}.de-context strong{color:#425b59;font:10px ui-monospace,monospace;margin-right:4px}.de-context-count{margin-right:auto;color:#3d7168;font-weight:700}.de-card{flex:0 0 auto;padding:8px 11px}.de-section-title{gap:8px;margin-bottom:6px;padding-bottom:5px}.de-section-title>span{width:21px;height:21px}.de-fields{gap:4px 9px}.de-field{gap:2px}.de-field>span{font-size:9px}.de-page input,.de-page select{height:26px;font-size:10px;padding:3px 6px}.de-valid{font-size:8px}.de-buyer{margin-top:7px;padding:6px 8px 1px}.de-subtitle{margin-bottom:5px}.de-table th{height:26px}.de-table td{height:40px}.de-table td input,.de-table td select{height:26px}.de-add-line{margin-top:5px;padding:5px 9px}.de-totals{gap:6px;margin-top:7px}.de-totals>div,.de-totals>label{gap:3px;padding:6px 8px}.de-footer{margin-top:0;padding-top:7px}`;
if (!document.head.querySelector("style[data-dense-erp]")) document.head.appendChild(style);
