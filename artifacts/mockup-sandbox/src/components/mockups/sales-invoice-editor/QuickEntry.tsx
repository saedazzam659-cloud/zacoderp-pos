import { useMemo, useState } from "react";
import type { ReactNode } from "react";

type Line = { item: string; unit: string; qty: number; free: number; price: number; discount: number; tax: number };
const initialLines: Line[] = [
  { item: "قهوة عربية فاخرة 500 جم", unit: "عبوة", qty: 3, free: 0, price: 42, discount: 5, tax: 15 },
  { item: "تمر سكري فاخر — كرتون", unit: "كرتون (×12)", qty: 2, free: 1, price: 96, discount: 0, tax: 15 },
  { item: "ماء شرب 330 مل", unit: "كرتون", qty: 5, free: 0, price: 18, discount: 0, tax: 15 },
];
const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`qe-field ${className}`}><span>{label}</span>{children}</label>;
}

export function QuickEntry() {
  const [lines, setLines] = useState(initialLines);
  const [payment, setPayment] = useState("نقدي");
  const [notes, setNotes] = useState("");
  const [invoiceType, setInvoiceType] = useState("مبسّطة (B2C)");
  const [discount, setDiscount] = useState(0);
  const [customer, setCustomer] = useState("مؤسسة النور التجارية");
  const [message, setMessage] = useState("");
  const [buyerName, setBuyerName] = useState("مؤسسة النور التجارية");
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
    const tax = lines.reduce((sum, line) => sum + (line.qty * line.price - line.discount) * line.tax / 100, 0);
    return { subtotal, lineDiscount, tax, grand: subtotal - lineDiscount - discount + tax };
  }, [lines, discount]);
  const updateLine = (index: number, key: keyof Line, value: string | number) => {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
    setMessage("");
  };
  const addLine = () => setLines((current) => [...current, { item: "", unit: "عبوة", qty: 1, free: 0, price: 0, discount: 0, tax: 15 }]);
  const savePreview = () => {
    if (!customer || lines.some((line) => !line.item.trim() || line.qty <= 0)) {
      setMessage("تحقق من العميل والأصناف والكمية — توجد حقول مطلوبة.");
      document.getElementById("qe-items")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setMessage("تم التحقق من بيانات الفاتورة — معاينة فقط، دون حفظ أو ترحيل.");
  };
  const resetPreview = () => {
    setLines(initialLines);
    setPayment("نقدي");
    setNotes("");
    setInvoiceType("مبسّطة (B2C)");
    setDiscount(0);
    setCustomer("مؤسسة النور التجارية");
    setBuyerName("مؤسسة النور التجارية");
    setMessage("أُعيدت الحقول إلى بيانات المعاينة.");
  };

  return (
    <main className="qe-page" dir="rtl" lang="ar">
      <style>{`
        .qe-page{--ink:#243a3b;--muted:#718180;--line:#d8e2dc;--paper:#f4f7f2;--surface:#fffefa;--teal:#246f68;--teal-soft:#e5f1eb;--gold:#b78637;--alert:#aa493b;min-height:100vh;padding:22px clamp(14px,2.2vw,34px) 108px;background:var(--paper);color:var(--ink);font:13px/1.45 "Segoe UI",Tahoma,sans-serif;box-sizing:border-box}
        .qe-page *{box-sizing:border-box}.qe-top{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding:0 2px 15px;margin-bottom:14px}
        .qe-brand{display:flex;align-items:center;gap:12px}.qe-mark{width:38px;height:38px;border-radius:11px;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:17px;font-weight:800;letter-spacing:-2px}
        .qe-brand b{display:block;font-size:15px;letter-spacing:.1px}.qe-brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
        .qe-heading{text-align:left}.qe-heading strong{display:block;font-size:20px;font-weight:750;letter-spacing:-.4px}.qe-heading span{color:var(--muted);font-size:11px}
        .qe-steps{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:11px;margin:0 0 14px}.qe-step{display:flex;align-items:center;gap:7px;white-space:nowrap}.qe-step i{width:21px;height:21px;border-radius:50%;display:grid;place-items:center;background:#e1e9e2;color:#647571;font-style:normal;font-size:10px;font-weight:800}.qe-step.active{color:var(--teal);font-weight:700}.qe-step.active i{color:#fff;background:var(--teal)}.qe-connector{height:1px;background:var(--line);width:38px}
        .qe-card{background:var(--surface);border:1px solid var(--line);border-radius:9px;margin-bottom:12px;box-shadow:0 2px 7px rgba(41,70,60,.035);overflow:hidden}.qe-card-head{display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid #e8eee8;background:#fbfcf8}.qe-card-head h2{font-size:13px;margin:0;font-weight:750}.qe-card-head p{color:var(--muted);font-size:11px;margin:0}.qe-section-no{color:var(--gold);font:700 11px ui-monospace,monospace;margin-left:8px}
        .qe-fields{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0 12px;padding:13px 15px 6px}.qe-field{display:flex;min-width:0;flex-direction:column;margin-bottom:10px;color:#455956}.qe-field>span{font-size:11px;font-weight:650;margin-bottom:5px;color:#566966}.qe-page input,.qe-page select,.qe-page textarea{width:100%;min-width:0;height:34px;padding:6px 9px;border:1px solid #d0dbd4;border-radius:5px;outline:0;background:#fff;color:var(--ink);font:inherit;font-size:12px}.qe-page input:focus,.qe-page select:focus,.qe-page textarea:focus{border-color:#4a8f83;box-shadow:0 0 0 2px rgba(36,111,104,.13)}.qe-page input[readonly]{background:#f1f4ef;color:#6e7d78}
        .qe-control{display:flex;gap:5px}.qe-control select{flex:1}.qe-add-customer{width:35px;border:1px solid #b8d4cb;border-radius:5px;background:var(--teal-soft);color:var(--teal);font-weight:800;font-size:18px;cursor:pointer}
        .qe-alert{margin:0 15px 12px;padding:8px 10px;border-right:3px solid var(--gold);background:#fff7e6;color:#76541b;font-size:11px;border-radius:3px}.qe-alert.error{border-color:var(--alert);background:#fff0ec;color:#8c3529}.qe-buyer{margin:0 15px 12px;padding:11px 12px;border:1px dashed #c8d8d0;border-radius:6px;background:#f5f8f3}.qe-buyer b{display:block;font-size:11px;margin-bottom:8px}.qe-buyer .qe-fields{padding:0;grid-template-columns:repeat(3,minmax(0,1fr))}
        .qe-table-wrap{overflow-x:auto}.qe-table{width:100%;min-width:1050px;border-collapse:collapse;table-layout:fixed}.qe-table th{padding:9px 6px;background:#eff4ee;border-bottom:1px solid #d8e2dc;text-align:right;color:#586b66;font-size:10px;white-space:nowrap}.qe-table td{padding:5px 5px;border-bottom:1px solid #edf0eb;vertical-align:middle}.qe-table tbody tr:nth-child(even){background:#fcfdf9}.qe-table tbody tr:hover{background:#f1f7f2}.qe-table th:nth-child(1){width:4%;text-align:center}.qe-table th:nth-child(2){width:22%}.qe-table th:nth-child(3){width:12%}.qe-table th:nth-child(4),.qe-table th:nth-child(5){width:7%;text-align:center}.qe-table th:nth-child(6){width:10%}.qe-table th:nth-child(7){width:12%}.qe-table th:nth-child(8){width:7%}.qe-table th:nth-child(9){width:13%}.qe-table th:nth-child(10){width:6%;text-align:center}.qe-table td input,.qe-table td select{height:31px;padding:4px 6px;font-size:11px}.qe-table td:nth-child(4) input,.qe-table td:nth-child(5) input,.qe-table td:nth-child(6) input,.qe-table td:nth-child(8) input{text-align:center;font-weight:650}.qe-number{text-align:center;color:#92a19b;font-family:ui-monospace,monospace}.qe-line-total{font-family:ui-monospace,monospace;font-weight:700;white-space:nowrap;color:#314d48}.qe-discount{display:flex;gap:3px}.qe-discount select{width:43px}.qe-row-actions{text-align:center}.qe-row-actions button{border:0;background:transparent;color:#9d5145;font-size:17px;cursor:pointer}.qe-addline{display:block;width:100%;padding:11px;border:0;background:#fbfcf8;color:var(--teal);font:inherit;font-weight:700;text-align:center;cursor:pointer}.qe-addline:hover{background:var(--teal-soft)}
        .qe-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;padding:11px 13px 13px;border-top:1px solid #e8eee8}.qe-summary>div,.qe-summary>label{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:6px;padding:8px 9px;border:1px solid #e1e8e1;border-radius:5px;background:#f8faf6;font-size:10px;color:#667773}.qe-summary b{color:#334b46;white-space:nowrap;font-size:12px;font-family:ui-monospace,monospace}.qe-summary label{flex-wrap:wrap}.qe-summary label span{width:100%}.qe-summary label input{height:27px;flex:1}.qe-summary .qe-grand{background:#e7f1e9;border-color:#bbd2c3;color:#385e4c}.qe-summary .qe-grand b{font-size:14px;color:#215f53}
        .qe-bottom-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}.qe-payment-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 10px;padding:12px 14px 3px}.qe-notes{padding:0 14px 12px}.qe-page .qe-notes textarea{height:50px;resize:vertical}.qe-footer{position:fixed;z-index:3;bottom:0;right:0;left:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px clamp(14px,2.2vw,34px);border-top:1px solid #d4dfd7;background:rgba(250,252,248,.96);box-shadow:0 -5px 18px rgba(32,57,48,.06);backdrop-filter:blur(8px)}.qe-footer-note{color:var(--muted);font-size:11px}.qe-actions{display:flex;gap:8px}.qe-btn{padding:8px 16px;border:1px solid #cbd8d0;border-radius:5px;background:#fff;color:#455b55;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.qe-btn:hover{background:#f1f6f1}.qe-save{background:var(--teal);color:#fff;border-color:var(--teal);min-width:132px}.qe-save:hover{background:#1d605a}.qe-page button:focus-visible{outline:2px solid #bb8c42;outline-offset:2px}
        @media(max-width:900px){.qe-fields{grid-template-columns:repeat(3,minmax(0,1fr))}.qe-bottom-grid{grid-template-columns:1fr}.qe-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.qe-top{align-items:flex-start}.qe-heading strong{font-size:17px}}
        @media(max-width:600px){.qe-page{padding:14px 10px 100px}.qe-top{align-items:flex-start;flex-direction:column}.qe-heading{text-align:right}.qe-steps{overflow:auto;padding-bottom:4px}.qe-connector{width:17px;flex:none}.qe-fields{grid-template-columns:repeat(2,minmax(0,1fr));padding:11px 10px 3px}.qe-fields .qe-wide{grid-column:span 2}.qe-buyer .qe-fields{grid-template-columns:1fr}.qe-summary{grid-template-columns:repeat(2,minmax(0,1fr));padding:9px}.qe-payment-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.qe-footer{align-items:flex-start;flex-direction:column;padding:9px 12px}.qe-footer-note{display:none}.qe-actions{width:100%}.qe-actions .qe-btn{flex:1}.qe-card-head{padding:10px}.qe-card-head p{font-size:10px}}
      `}</style>
      <header className="qe-top">
        <div className="qe-brand"><div className="qe-mark">Z</div><div><b>Zacode ERP</b><small>المبيعات · فرع الرياض</small></div></div>
        <div className="qe-heading"><strong>فاتورة مبيعات جديدة</strong><span>إدخال سريع · فاتورة رقمية غير مرحلة</span></div>
      </header>
      <div className="qe-steps" aria-label="تدفق إدخال مستمر">
        <div className="qe-step active"><i>١</i><span>العميل والبيانات</span></div><div className="qe-connector" />
        <div className="qe-step active"><i>٢</i><span>الأصناف والكميات</span></div><div className="qe-connector" />
        <div className="qe-step"><i>٣</i><span>التسوية والحفظ</span></div>
        <span style={{ marginRight: "auto" }}>مسودة إدخال <b style={{ color: "#b78637" }}>●</b></span>
      </div>
      <section className="qe-card">
        <div className="qe-card-head"><h2><span className="qe-section-no">01</span>بيانات الفاتورة</h2><p>ابدأ بالعميل، ثم انتقل مباشرة إلى الأصناف</p></div>
        <div className="qe-fields">
          <Field label="العميل *" className="qe-wide"><div className="qe-control"><select value={customer} onChange={(e) => { setCustomer(e.target.value); setBuyerName(e.target.value); }}><option>مؤسسة النور التجارية</option><option>شركة أبعاد للتجارة</option><option>عميل نقدي</option></select><button type="button" className="qe-add-customer" aria-label="إضافة عميل" onClick={() => setMessage("إضافة عميل جديدة غير متاحة في المعاينة.")}>＋</button></div></Field>
          <Field label="تاريخ الفاتورة *"><input type="date" defaultValue="2025-02-18" /></Field>
          <Field label="المستودع"><select defaultValue="المستودع الرئيسي"><option>المستودع الرئيسي</option><option>مستودع المعرض</option></select></Field>
          <Field label="الضريبة"><select defaultValue="ضريبة القيمة المضافة — 15%"><option>ضريبة القيمة المضافة — 15%</option><option>بدون ضريبة</option></select></Field>
          <Field label="الفرع"><select defaultValue="الفرع الرئيسي"><option>الفرع الرئيسي</option><option>فرع الشمال</option></select></Field>
          <Field label="مركز التكلفة"><select defaultValue="— بدون —"><option>— بدون —</option><option>المبيعات العامة</option></select></Field>
          <Field label="مندوب المبيعات"><select defaultValue="سارة العتيبي"><option>سارة العتيبي</option><option>— بدون —</option><option>محمد القحطاني</option></select></Field>
          <Field label="نوع الفاتورة (زاتكا)"><select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}><option>مبسّطة (B2C)</option><option>ضريبية (B2B)</option></select></Field>
          <Field label="العملة"><select defaultValue="SAR — ريال سعودي"><option>SAR — ريال سعودي</option><option>USD — دولار أمريكي</option></select></Field>
          <Field label="سعر الصرف"><input type="number" defaultValue="1.00" step="0.01" /></Field>
        </div>
        <div className="qe-alert">تنبيه تحقق: راجع بيانات العميل قبل الترحيل. يلزم إدخال صنف وكمية صحيحة لكل سطر.</div>
        <div className="qe-buyer"><b>بيانات المشتري وزاتكا · تستكمل عند اختيار الفاتورة الضريبية</b><div className="qe-fields">
          <Field label="اسم المشتري *"><input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} /></Field>
          <Field label="الرقم الضريبي للمشتري *"><input defaultValue="310123456700003" /></Field>
          <Field label="عنوان المشتري"><input defaultValue="الرياض، حي العليا" /></Field>
        </div></div>
      </section>
      <section className="qe-card" id="qe-items">
        <div className="qe-card-head"><h2><span className="qe-section-no">02</span>بنود الأصناف</h2><p>{lines.length} أصناف · أدخل الكمية والسعر والخصم في نفس السطر</p></div>
        <div className="qe-table-wrap"><table className="qe-table"><thead><tr><th>#</th><th>الصنف *</th><th>الوحدة</th><th>الكمية *</th><th>مجاني</th><th>سعر الوحدة</th><th>الخصم</th><th>ض. %</th><th>الإجمالي</th><th>حذف</th></tr></thead>
          <tbody>{lines.map((line, index) => { const rowBase = line.qty * line.price - line.discount; const rowTotal = rowBase + rowBase * line.tax / 100; return <tr key={index}>
            <td className="qe-number">{String(index + 1).padStart(2, "0")}</td>
            <td><input aria-label={`الصنف ${index + 1}`} value={line.item} onChange={(e) => updateLine(index, "item", e.target.value)} placeholder="ابحث عن صنف أو أدخل اسمه" /></td>
            <td><select value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)}><option>عبوة</option><option>كرتون</option><option>كرتون (×12)</option></select></td>
            <td><input aria-label="الكمية" type="number" min="0" value={line.qty} onChange={(e) => updateLine(index, "qty", Number(e.target.value))} /></td>
            <td><input aria-label="كمية مجانية" type="number" min="0" value={line.free} onChange={(e) => updateLine(index, "free", Number(e.target.value))} /></td>
            <td><input aria-label="سعر الوحدة" type="number" min="0" value={line.price} onChange={(e) => updateLine(index, "price", Number(e.target.value))} /></td>
            <td><div className="qe-discount"><input aria-label="الخصم" type="number" min="0" value={line.discount} onChange={(e) => updateLine(index, "discount", Number(e.target.value))} /><select aria-label="نوع الخصم"><option>%</option><option>ر.س</option></select></div></td>
            <td><input aria-label="نسبة الضريبة" type="number" min="0" value={line.tax} onChange={(e) => updateLine(index, "tax", Number(e.target.value))} /></td>
            <td className="qe-line-total">ر.س {money(rowTotal)}</td><td className="qe-row-actions"><button type="button" aria-label="حذف السطر" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>×</button></td>
          </tr>;})}</tbody></table></div>
        <button type="button" className="qe-addline" onClick={addLine}>＋ أضف صنفًا جديدًا إلى الفاتورة</button>
        <div className="qe-summary">
          <div><span>الإجمالي قبل الخصم</span><b>{money(totals.subtotal)}</b></div>
          <div><span>خصم البنود</span><b>{money(totals.lineDiscount)}</b></div>
          <label><span>خصم الفاتورة · ر.س</span><input type="number" min="0" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></label>
          <div><span>إجمالي الضريبة</span><b>{money(totals.tax)}</b></div>
          <div className="qe-grand"><span>الإجمالي النهائي</span><b>ر.س {money(totals.grand)}</b></div>
        </div>
      </section>
      <div className="qe-bottom-grid">
        <section className="qe-card">
          <div className="qe-card-head"><h2><span className="qe-section-no">03</span>التسوية</h2><p>حدد مسار استلام المبلغ</p></div>
          <div className="qe-payment-fields">
            <Field label="طريقة الدفع"><select value={payment} onChange={(e) => setPayment(e.target.value)}><option>نقدي</option><option>بنك</option><option>آجل (على الحساب)</option><option>متعدد الطرق</option></select></Field>
            {(payment === "نقدي" || payment === "متعدد الطرق") && <Field label="الخزينة"><select defaultValue="الصندوق الرئيسي · SAR"><option>الصندوق الرئيسي · SAR</option><option>صندوق المعرض · SAR</option></select></Field>}
            {(payment === "بنك" || payment === "متعدد الطرق") && <Field label="البنك"><select defaultValue="مصرف الراجحي · SAR"><option>مصرف الراجحي · SAR</option><option>البنك الأهلي · SAR</option></select></Field>}
            {payment === "متعدد الطرق" && <><Field label="المبلغ النقدي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.6)} /></Field><Field label="المبلغ البنكي · ر.س"><input type="number" defaultValue={money(totals.grand * 0.4)} /></Field><Field label="المتبقي آجل · ر.س"><input readOnly value="0.00" /></Field></>}
          </div>
        </section>
        <section className="qe-card">
          <div className="qe-card-head"><h2>ملاحظات الفاتورة</h2><p>تظهر للفريق عند مراجعة الإدخال</p></div>
          <Field label="ملاحظات" className="qe-notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="أضف ملاحظة مختصرة..." /></Field>
          <div className="qe-payment-fields" style={{ paddingTop: 0 }}>
            <Field label="مرجع المشتري"><input placeholder="رقم أمر الشراء (اختياري)" /></Field>
            <Field label="الرقم الضريبي"><input placeholder="الرقم الضريبي للمشتري" /></Field>
            <Field label="معرّف زاتكا"><input readOnly value="يُنشأ عند الترحيل" /></Field>
          </div>
        </section>
      </div>
      <footer className="qe-footer">
        <div className="qe-footer-note">{message || "تسلسل الإدخال: العميل ← الأصناف ← طريقة الدفع"}</div>
        <div className="qe-actions"><button type="button" className="qe-btn" onClick={resetPreview}>إلغاء</button><button type="button" className="qe-btn qe-save" onClick={savePreview}>حفظ وترحيل</button></div>
      </footer>
      {message && <div className={`qe-alert ${message.startsWith("تحقق") ? "error" : ""}`} role="status" style={{ position: "fixed", bottom: 64, right: 24, zIndex: 5, boxShadow: "0 3px 12px #243a3b22" }}>{message}</div>}
    </main>
  );
}
