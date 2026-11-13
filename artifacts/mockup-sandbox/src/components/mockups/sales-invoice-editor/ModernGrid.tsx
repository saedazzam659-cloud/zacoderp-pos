import { useMemo, useState, type ReactNode } from "react";

type Line = { item: string; unit: string; qty: number; free: number; price: number; discount: number; tax: number };

const initialLines: Line[] = [
  { item: "قهوة عربية فاخرة 500 جم", unit: "عبوة", qty: 3, free: 0, price: 42, discount: 5, tax: 15 },
  { item: "تمر سكري فاخر — كرتون", unit: "كرتون (×12)", qty: 2, free: 1, price: 96, discount: 0, tax: 15 },
  { item: "ماء شرب 330 مل", unit: "كرتون", qty: 5, free: 0, price: 18, discount: 0, tax: 15 },
];

const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Field({ label, children, className = "", required = false }: {
  label: string; children: ReactNode; className?: string; required?: boolean;
}) {
  return (
    <label className={`mg-field ${className}`}>
      <span>{label}{required && <b className="mg-required"> *</b>}</span>
      {children}
    </label>
  );
}

export function ModernGrid() {
  const [lines, setLines] = useState(initialLines);
  const [customer, setCustomer] = useState("مؤسسة النور التجارية");
  const [invoiceType, setInvoiceType] = useState("مبسّطة (B2C)");
  const [payment, setPayment] = useState("نقدي");
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState("");

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
    const tax = lines.reduce((sum, line) => sum + Math.max(0, line.qty * line.price - line.discount) * line.tax / 100, 0);
    return { subtotal, lineDiscount, tax, grand: subtotal - lineDiscount - invoiceDiscount + tax };
  }, [lines, invoiceDiscount]);

  const invalidLines = lines.filter((line) => !line.item.trim() || line.qty <= 0 || line.price < 0);
  const updateLine = (index: number, key: keyof Line, value: string | number) => {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
    setNotice("");
  };
  const addLine = () => {
    setLines((current) => [...current, { item: "", unit: "عبوة", qty: 1, free: 0, price: 0, discount: 0, tax: 15 }]);
    setNotice("");
  };

  return (
    <main className="mg-page" dir="rtl" lang="ar">
      <style>{`
        .mg-page {
          --mg-ink: #183538; --mg-muted: #71817e; --mg-line: #dce5df;
          --mg-paper: #f5f7f2; --mg-panel: #fffefa; --mg-teal: #147c70;
          --mg-teal-dark: #0e6259; --mg-soft: #e9f3ed; --mg-orange: #c86a3b;
          min-height: 100dvh; padding: 22px 28px 18px; box-sizing: border-box;
          color: var(--mg-ink); background: var(--mg-paper);
          font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px;
        }
        .mg-page *, .mg-page *::before, .mg-page *::after { box-sizing: border-box; }
        .mg-topline { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:15px; }
        .mg-title { display:flex; align-items:center; gap:13px; min-width:0; }
        .mg-mark { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; color:#fff; background:var(--mg-ink); font-weight:800; font-size:15px; letter-spacing:-1px; }
        .mg-title h1 { margin:0; font-size:21px; letter-spacing:-.45px; line-height:1.2; }
        .mg-title p { margin:4px 0 0; color:var(--mg-muted); font-size:11px; }
        .mg-docmeta { display:flex; align-items:center; gap:10px; }
        .mg-number { padding:8px 12px; border:1px solid var(--mg-line); border-radius:8px; background:var(--mg-panel); color:var(--mg-muted); font-size:11px; }
        .mg-number strong { margin-inline-start:7px; color:var(--mg-ink); font:700 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
        .mg-status { display:flex; align-items:center; gap:6px; padding:7px 10px; border-radius:99px; color:var(--mg-teal-dark); background:var(--mg-soft); font-size:11px; font-weight:700; white-space:nowrap; }
        .mg-dot { width:7px; height:7px; border-radius:50%; background:#3b9b78; }
        .mg-identity { padding:14px 16px 4px; border:1px solid var(--mg-line); border-radius:12px; background:var(--mg-panel); box-shadow:0 3px 12px rgba(24,53,56,.035); }
        .mg-identity-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:11px; }
        .mg-identity-head strong { font-size:12px; }
        .mg-identity-head span { color:var(--mg-muted); font-size:10px; }
        .mg-fields { display:grid; grid-template-columns:1.35fr .85fr 1fr 1fr 1fr; gap:0 12px; }
        .mg-field { display:flex; flex-direction:column; min-width:0; margin-bottom:10px; }
        .mg-field > span { margin-bottom:5px; color:#697a76; font-size:10px; font-weight:700; }
        .mg-required { color:#b84f3a; }
        .mg-page input, .mg-page select, .mg-page textarea {
          width:100%; min-width:0; height:34px; padding:6px 9px; outline:none;
          border:1px solid #d6e0da; border-radius:7px; color:var(--mg-ink);
          background:#fff; font:inherit; font-size:12px; transition:border-color .16s, box-shadow .16s;
        }
        .mg-page input:focus, .mg-page select:focus, .mg-page textarea:focus { border-color:var(--mg-teal); box-shadow:0 0 0 3px rgba(20,124,112,.12); }
        .mg-page input[aria-invalid="true"] { border-color:#cc5948; background:#fff8f5; }
        .mg-customer-control { display:flex; gap:5px; }
        .mg-customer-control select { flex:1; }
        .mg-add-customer { flex:0 0 34px; height:34px; border:1px solid #b8d5c9; border-radius:7px; color:var(--mg-teal-dark); background:var(--mg-soft); font-size:17px; cursor:pointer; }
        .mg-buyer { margin:1px 0 10px; padding:11px 12px 1px; border:1px solid #dfcaa8; border-radius:9px; background:#fff9ee; }
        .mg-buyer-title { display:flex; justify-content:space-between; margin-bottom:8px; color:#73572f; font-size:11px; font-weight:800; }
        .mg-buyer-fields { display:grid; grid-template-columns:1fr 1fr 1.4fr; gap:0 12px; }
        .mg-grid-section { margin-top:16px; }
        .mg-grid-heading { display:flex; align-items:end; justify-content:space-between; margin:0 1px 9px; }
        .mg-grid-title { display:flex; align-items:center; gap:10px; }
        .mg-grid-title strong { font-size:16px; letter-spacing:-.2px; }
        .mg-count { padding:3px 8px; border-radius:20px; color:var(--mg-teal-dark); background:#e2f0e9; font-size:10px; font-weight:800; }
        .mg-grid-hint { color:var(--mg-muted); font-size:10px; }
        .mg-table-wrap { overflow-x:auto; border:1px solid #d5dfd9; border-radius:11px; background:var(--mg-panel); }
        .mg-table { width:100%; min-width:1010px; table-layout:fixed; border-collapse:collapse; }
        .mg-table th { height:35px; padding:7px 5px; border-bottom:1px solid #d8e2dc; color:#6b7b76; background:#edf2ed; font-size:10px; font-weight:800; white-space:nowrap; }
        .mg-table td { height:47px; padding:5px; border-bottom:1px solid #e9eeea; vertical-align:middle; }
        .mg-table tbody tr:last-child td { border-bottom:0; }
        .mg-table tbody tr:hover td { background:#f7faf6; }
        .mg-table tbody tr.mg-invalid-row td { background:#fff8f5; }
        .mg-table th:nth-child(1) { width:4%; text-align:center; }
        .mg-table th:nth-child(2) { width:22%; text-align:right; }
        .mg-table th:nth-child(3) { width:10%; }
        .mg-table th:nth-child(4), .mg-table th:nth-child(5) { width:7%; }
        .mg-table th:nth-child(6) { width:10%; }
        .mg-table th:nth-child(7) { width:10%; }
        .mg-table th:nth-child(8) { width:7%; }
        .mg-table th:nth-child(9) { width:15%; }
        .mg-table th:nth-child(10) { width:8%; }
        .mg-table td input, .mg-table td select { height:32px; padding:4px 7px; font-size:11px; }
        .mg-table td:nth-child(4) input, .mg-table td:nth-child(5) input, .mg-table td:nth-child(6) input, .mg-table td:nth-child(8) input { text-align:center; font-variant-numeric:tabular-nums; }
        .mg-rowno { color:#98a5a0; text-align:center; font:600 11px ui-monospace, monospace; }
        .mg-line-total { color:var(--mg-ink); text-align:left; white-space:nowrap; font:700 12px ui-monospace, monospace; }
        .mg-line-total small { color:var(--mg-muted); font:10px "Segoe UI", Tahoma, sans-serif; }
        .mg-line-actions { text-align:center; }
        .mg-line-actions button { width:26px; height:26px; border:0; border-radius:6px; color:#b44b41; background:transparent; font-size:17px; cursor:pointer; }
        .mg-line-actions button:hover { background:#fff0ed; }
        .mg-add-row { display:flex; align-items:center; justify-content:center; width:100%; min-height:42px; border:0; color:var(--mg-teal-dark); background:#f8fbf7; font-family:inherit; font-size:11px; font-weight:700; cursor:pointer; }
        .mg-add-row:hover { background:#edf6ef; }
        .mg-validation { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:33px; margin-top:7px; padding:6px 10px; border:1px solid #cfe4d7; border-radius:7px; color:#28654f; background:#f1f8f2; font-size:10px; }
        .mg-validation.is-error { border-color:#edc3b7; color:#9a4132; background:#fff4ef; }
        .mg-validation b { font-size:10px; }
        .mg-lower { display:grid; grid-template-columns:minmax(0,1.42fr) minmax(340px,1fr); gap:14px; margin-top:13px; align-items:stretch; }
        .mg-payment, .mg-notes { padding:11px 13px; border:1px solid var(--mg-line); border-radius:10px; background:var(--mg-panel); }
        .mg-subhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:9px; }
        .mg-subhead strong { font-size:11px; }
        .mg-subhead span { color:var(--mg-muted); font-size:9px; }
        .mg-payment-fields { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0 9px; }
        .mg-payment .mg-field { margin-bottom:0; }
        .mg-notes textarea { height:63px; resize:vertical; }
        .mg-totals { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-top:12px; }
        .mg-total-box { min-width:0; padding:8px 10px; border:1px solid var(--mg-line); border-radius:8px; background:#fffefa; }
        .mg-total-box span { display:block; margin-bottom:6px; color:var(--mg-muted); font-size:9px; white-space:nowrap; }
        .mg-total-box b { display:block; color:var(--mg-ink); font:700 12px ui-monospace, SFMono-Regular, Consolas, monospace; white-space:nowrap; }
        .mg-total-box.discount { position:relative; }
        .mg-total-box.discount input { height:25px; padding:3px 6px; text-align:left; font:700 11px ui-monospace, monospace; }
        .mg-total-box.grand { border-color:#a7cec0; background:#e7f2eb; }
        .mg-total-box.grand span { color:#3f7161; }
        .mg-total-box.grand b { color:#0e6259; font-size:15px; }
        .mg-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:13px; }
        .mg-footer-note { color:var(--mg-muted); font-size:10px; }
        .mg-actions { display:flex; gap:8px; }
        .mg-btn { min-height:37px; padding:8px 15px; border:1px solid #d0dcd5; border-radius:8px; color:var(--mg-ink); background:#fffefa; font-family:inherit; font-size:11px; font-weight:700; cursor:pointer; transition:transform .14s, background .14s; }
        .mg-btn:active { transform:translateY(1px); }
        .mg-btn:hover { background:#f2f6f1; }
        .mg-btn.save { border-color:var(--mg-teal); color:#fff; background:var(--mg-teal); }
        .mg-btn.save:hover { background:var(--mg-teal-dark); }
        .mg-toast { position:fixed; z-index:5; left:24px; bottom:20px; max-width:min(400px,calc(100vw - 40px)); padding:11px 15px; border:1px solid #b9d8ca; border-radius:9px; color:#17594d; background:#f1f8f2; box-shadow:0 10px 28px rgba(24,53,56,.12); font-size:12px; }
        @media(max-width:1050px) {
          .mg-page { padding:18px; }
          .mg-fields { grid-template-columns:repeat(3,minmax(0,1fr)); }
          .mg-lower { grid-template-columns:1fr; }
        }
        @media(max-width:680px) {
          .mg-page { padding:14px 12px 18px; }
          .mg-topline { align-items:flex-start; flex-direction:column; }
          .mg-title h1 { font-size:18px; }
          .mg-fields { grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 9px; }
          .mg-buyer-fields { grid-template-columns:1fr; }
          .mg-grid-hint { display:none; }
          .mg-table { min-width:960px; }
          .mg-payment-fields { grid-template-columns:1fr 1fr; }
          .mg-totals { grid-template-columns:repeat(2,minmax(0,1fr)); }
          .mg-total-box.grand { grid-column:span 2; }
          .mg-footer { align-items:flex-start; flex-direction:column; }
          .mg-actions { width:100%; }
          .mg-actions .mg-btn { flex:1; }
        }
      `}</style>

      <header className="mg-topline">
        <div className="mg-title">
          <div className="mg-mark" aria-hidden="true">Z</div>
          <div><h1>فاتورة مبيعات جديدة</h1><p>إدخال سريع — راجع البنود قبل الترحيل</p></div>
        </div>
        <div className="mg-docmeta">
          <div className="mg-number">رقم الفاتورة <strong>SI-002487</strong></div>
          <div className="mg-status"><i className="mg-dot" /> مسودة محلية</div>
        </div>
      </header>

      <section className="mg-identity" aria-label="بيانات الفاتورة">
        <div className="mg-identity-head"><strong>بيانات الفاتورة</strong><span>الحقول ذات النجمة مطلوبة</span></div>
        <div className="mg-fields">
          <Field label="العميل" required>
            <div className="mg-customer-control">
              <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-invalid={!customer}>
                <option>مؤسسة النور التجارية</option><option>شركة أبعاد للتجارة</option><option>عميل نقدي</option>
              </select>
              <button type="button" className="mg-add-customer" title="إضافة عميل" onClick={() => setNotice("إضافة العميل متاحة من شاشة العملاء.")}>＋</button>
            </div>
          </Field>
          <Field label="تاريخ الفاتورة"><input type="date" defaultValue="2025-02-18" /></Field>
          <Field label="المستودع"><select defaultValue="المستودع الرئيسي"><option>المستودع الرئيسي</option><option>مستودع المعرض</option></select></Field>
          <Field label="الضريبة"><select defaultValue="ضريبة القيمة المضافة — 15%"><option>ضريبة القيمة المضافة — 15%</option><option>بدون ضريبة</option></select></Field>
          <Field label="الفرع"><select defaultValue="الفرع الرئيسي"><option>الفرع الرئيسي</option><option>فرع الشمال</option></select></Field>
          <Field label="مركز التكلفة"><select defaultValue="— بدون —"><option>— بدون —</option><option>المبيعات العامة</option></select></Field>
          <Field label="مندوب المبيعات"><select defaultValue="سارة العتيبي"><option>سارة العتيبي</option><option>— بدون —</option><option>محمد القحطاني</option></select></Field>
          <Field label="نوع الفاتورة — زاتكا">
            <select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}><option>مبسّطة (B2C)</option><option>ضريبية (B2B)</option></select>
          </Field>
          <Field label="العملة"><select defaultValue="SAR — ريال سعودي"><option>SAR — ريال سعودي</option><option>USD — دولار أمريكي</option></select></Field>
          <Field label="سعر الصرف"><input type="number" defaultValue="1.00" step="0.01" /></Field>
        </div>
        <div className="mg-buyer">
          <div className="mg-buyer-title">
            <span>بيانات المشتري {invoiceType.includes("B2B") ? "— مطلوبة للفاتورة الضريبية" : "— اختيارية للفاتورة المبسّطة"}</span>
            <span>زاتكا · {invoiceType.includes("B2B") ? "B2B" : "B2C"}</span>
          </div>
          <div className="mg-buyer-fields">
            <Field label="اسم المشتري" required={invoiceType.includes("B2B")}><input defaultValue={customer} /></Field>
            <Field label="الرقم الضريبي للمشتري" required={invoiceType.includes("B2B")}><input defaultValue="310123456700003" /></Field>
            <Field label="عنوان المشتري"><input defaultValue="الرياض، حي العليا" /></Field>
          </div>
        </div>
      </section>

      <section className="mg-grid-section" aria-label="بنود الأصناف">
        <div className="mg-grid-heading">
          <div className="mg-grid-title"><strong>بنود الأصناف</strong><span className="mg-count">{lines.length} أصناف</span></div>
          <span className="mg-grid-hint">أدخل الكمية والسعر مباشرة — الإجمالي يُحتسب تلقائياً</span>
        </div>
        <div className="mg-table-wrap">
          <table className="mg-table">
            <thead><tr><th>#</th><th>الصنف *</th><th>الوحدة</th><th>الكمية</th><th>مجاني</th><th>سعر الوحدة</th><th>الخصم · ر.س</th><th>ض. %</th><th>الإجمالي شامل الضريبة</th><th>حذف</th></tr></thead>
            <tbody>
              {lines.map((line, index) => {
                const lineTotal = Math.max(0, line.qty * line.price - line.discount);
                const totalWithTax = lineTotal + lineTotal * line.tax / 100;
                const invalid = !line.item.trim() || line.qty <= 0;
                return (
                  <tr key={index} className={invalid ? "mg-invalid-row" : ""}>
                    <td className="mg-rowno">{String(index + 1).padStart(2, "0")}</td>
                    <td><input value={line.item} onChange={(e) => updateLine(index, "item", e.target.value)} aria-label={`الصنف ${index + 1}`} aria-invalid={!line.item.trim()} placeholder="اختر الصنف أو اكتب اسمه" /></td>
                    <td><select value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)} aria-label={`الوحدة ${index + 1}`}><option>عبوة</option><option>كرتون</option><option>كرتون (×12)</option></select></td>
                    <td><input type="number" min="0" value={line.qty} onChange={(e) => updateLine(index, "qty", Number(e.target.value))} aria-label={`الكمية ${index + 1}`} aria-invalid={line.qty <= 0} /></td>
                    <td><input type="number" min="0" value={line.free} onChange={(e) => updateLine(index, "free", Number(e.target.value))} aria-label={`كمية مجانية ${index + 1}`} /></td>
                    <td><input type="number" min="0" value={line.price} onChange={(e) => updateLine(index, "price", Number(e.target.value))} aria-label={`سعر الوحدة ${index + 1}`} /></td>
                    <td><input type="number" min="0" value={line.discount} onChange={(e) => updateLine(index, "discount", Number(e.target.value))} aria-label={`الخصم ${index + 1}`} /></td>
                    <td><input type="number" min="0" value={line.tax} onChange={(e) => updateLine(index, "tax", Number(e.target.value))} aria-label={`نسبة الضريبة ${index + 1}`} /></td>
                    <td className="mg-line-total">{money(totalWithTax)} <small>ر.س</small></td>
                    <td className="mg-line-actions"><button type="button" aria-label={`حذف السطر ${index + 1}`} title="حذف السطر" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>×</button></td>
                  </tr>
                );
              })}
              <tr><td colSpan={10} style={{ padding: 0 }}><button type="button" className="mg-add-row" onClick={addLine}>＋ إضافة صنف جديد إلى الفاتورة</button></td></tr>
            </tbody>
          </table>
        </div>
        <div className={`mg-validation ${invalidLines.length ? "is-error" : ""}`} role="status">
          <span>{invalidLines.length ? `تحقق من ${invalidLines.length} سطر: اسم الصنف والكمية الموجبة مطلوبان قبل الحفظ.` : "التحقق الأولي مكتمل — لا توجد حقول ناقصة في البنود."}</span>
          <b>{invalidLines.length ? "يتطلب مراجعة" : "جاهز للمراجعة"}</b>
        </div>
      </section>

      <section className="mg-lower" aria-label="الدفع والملاحظات">
        <div className="mg-payment">
          <div className="mg-subhead"><strong>الدفع والتسوية</strong><span>طريقة واحدة أو توزيع على أكثر من وسيلة</span></div>
          <div className="mg-payment-fields">
            <Field label="طريقة الدفع"><select value={payment} onChange={(e) => setPayment(e.target.value)}><option>نقدي</option><option>بنك</option><option>آجل (على الحساب)</option><option>متعدد الطرق</option></select></Field>
            <Field label="الخزينة"><select defaultValue="الصندوق الرئيسي · SAR"><option>الصندوق الرئيسي · SAR</option><option>صندوق المعرض · SAR</option></select></Field>
            <Field label="البنك"><select defaultValue="مصرف الراجحي · SAR"><option>مصرف الراجحي · SAR</option><option>البنك الأهلي · SAR</option></select></Field>
            {payment === "متعدد الطرق" && <>
              <Field label="المبلغ النقدي · ر.س"><input type="number" defaultValue={money(totals.grand * .6)} /></Field>
              <Field label="المبلغ البنكي · ر.س"><input type="number" defaultValue={money(totals.grand * .4)} /></Field>
              <Field label="المتبقي آجل · ر.س"><input readOnly value="0.00" /></Field>
            </>}
          </div>
        </div>
        <div className="mg-notes">
          <div className="mg-subhead"><strong>ملاحظات الفاتورة</strong><span>اختياري</span></div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="أضف ملاحظات للفريق أو تعليمات التسليم..." />
        </div>
      </section>

      <section className="mg-totals" aria-label="ملخص الإجماليات">
        <div className="mg-total-box"><span>الإجمالي قبل الخصم</span><b>{money(totals.subtotal)} ر.س</b></div>
        <div className="mg-total-box"><span>خصم البنود</span><b>{money(totals.lineDiscount)} ر.س</b></div>
        <label className="mg-total-box discount"><span>خصم الفاتورة · ر.س</span><input type="number" min="0" value={invoiceDiscount} onChange={(e) => setInvoiceDiscount(Number(e.target.value))} /></label>
        <div className="mg-total-box"><span>إجمالي الضريبة</span><b>{money(totals.tax)} ر.س</b></div>
        <div className="mg-total-box grand"><span>الإجمالي النهائي</span><b>{money(totals.grand)} ر.س</b></div>
      </section>

      <footer className="mg-footer">
        <span className="mg-footer-note">سيُنشأ قيد المبيعات عند الترحيل · نسخة إدخال محلية</span>
        <div className="mg-actions">
          <button className="mg-btn" type="button" onClick={() => setNotice("تم إلغاء التغييرات المحلية في هذه المعاينة.")}>إلغاء</button>
          <button className="mg-btn save" type="button" onClick={() => setNotice(invalidLines.length ? "لا يمكن الحفظ: راجع البنود المحددة باللون الأحمر." : "تم التحقق محلياً — هذه المعاينة لا تحفظ أو ترحّل البيانات.")}>حفظ وترحيل ←</button>
        </div>
      </footer>
      {notice && <div className="mg-toast" role="status" onClick={() => setNotice("")}>{notice}　×</div>}
    </main>
  );
}
