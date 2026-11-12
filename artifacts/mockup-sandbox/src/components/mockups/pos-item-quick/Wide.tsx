import { useState } from "react";
import "./_group.css";

const fieldStyle = {
  width: "100%",
  height: 42,
  padding: "0 12px",
  border: "1px solid #d9dce8",
  borderRadius: 8,
  background: "#fff",
  color: "#25243a",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box" as const,
  fontFamily: "inherit",
};

const labelStyle = {
  display: "grid",
  gap: 7,
  color: "#5f6074",
  fontSize: 12,
  fontWeight: 700,
} as const;

export function Wide() {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("25.00");
  const [tax, setTax] = useState("15");
  const [code, setCode] = useState("");
  const [barcode, setBarcode] = useState("");
  const [unit, setUnit] = useState("حبة");
  const [nature, setNature] = useState("stock");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("عام");

  return (
    <main className="wide-item-stage" dir="rtl">
      <style>{`
        .wide-item-stage {
          --ink: #29283d;
          --muted: #77788b;
          --line: #e7e7ef;
          --violet: #7552c7;
          min-height: 100vh;
          padding: 22px;
          display: grid;
          place-items: center;
          box-sizing: border-box;
          color: var(--ink);
          background:
            radial-gradient(ellipse at 10% 4%, rgba(117,82,199,.09), transparent 34%),
            #f1f2f7;
          font-family: inherit;
        }
        .wide-item-dialog {
          width: min(100%, 900px);
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.9);
          border-radius: 17px;
          background: #fff;
          box-shadow: 0 24px 70px rgba(42, 37, 73, .16), 0 3px 10px rgba(42,37,73,.05);
        }
        .wide-item-header {
          min-height: 82px;
          padding: 17px 24px;
          display: flex;
          align-items: center;
          gap: 14px;
          color: #fff;
          background: linear-gradient(112deg, #6646b4 0%, #8b66d2 100%);
          box-sizing: border-box;
        }
        .wide-item-mark {
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          border: 1px solid rgba(255,255,255,.28);
          border-radius: 13px;
          background: rgba(255,255,255,.14);
        }
        .wide-item-content { padding: 22px 24px 0; }
        .wide-item-section {
          padding: 17px 18px 18px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
        }
        .wide-item-section + .wide-item-section { margin-top: 14px; }
        .wide-item-section-title {
          margin: 0 0 15px;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #39384f;
          font-size: 13px;
          font-weight: 800;
        }
        .wide-item-section-title:before {
          content: "";
          width: 3px;
          height: 15px;
          border-radius: 3px;
          background: var(--violet);
        }
        .wide-item-grid-main {
          display: grid;
          grid-template-columns: minmax(220px, 1.75fr) minmax(130px, .8fr) minmax(130px, .8fr);
          gap: 13px 15px;
        }
        .wide-item-grid-meta {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 13px 15px;
        }
        .wide-item-grid-brand {
          display: grid;
          grid-template-columns: 1.1fr 1.1fr 1fr;
          gap: 13px 15px;
          align-items: end;
        }
        .wide-item-helper {
          margin-top: 6px;
          color: #9292a2;
          font-size: 10px;
          font-weight: 500;
        }
        .wide-item-input-wrap { position: relative; }
        .wide-item-suffix {
          position: absolute;
          top: 50%;
          left: 11px;
          color: #88899b;
          font-size: 11px;
          transform: translateY(-50%);
          pointer-events: none;
        }
        .wide-item-input-suffixed { padding-left: 38px !important; }
        .wide-item-brand-add {
          height: 42px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 0 12px;
          border: 1px dashed #b9a9df;
          border-radius: 8px;
          color: #6746b2;
          background: #faf8ff;
          font-family: inherit;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .wide-item-actions {
          margin-top: 18px;
          min-height: 72px;
          padding: 13px 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          border-top: 1px solid #ededf2;
          background: #fcfcfe;
        }
        .wide-item-note { color: #88899a; font-size: 11px; }
        .wide-item-buttons { display: flex; align-items: center; gap: 9px; }
        .wide-item-btn {
          min-height: 39px;
          padding: 0 17px;
          border-radius: 8px;
          font-family: inherit;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .wide-item-cancel { border: 1px solid #dedee7; color: #656578; background: #fff; }
        .wide-item-save { border: 1px solid #6746b2; color: #fff; background: #7351c3; box-shadow: 0 3px 8px rgba(103,70,178,.2); }
        .wide-item-save:hover { background: #6443af; }
        .wide-item-cancel:hover { background: #f7f7fa; }
        @media (max-width: 680px) {
          .wide-item-stage { padding: 10px; display: block; }
          .wide-item-dialog { border-radius: 13px; }
          .wide-item-header { min-height: 74px; padding: 14px 16px; }
          .wide-item-header p { max-width: 275px; line-height: 1.55; }
          .wide-item-content { padding: 14px 13px 0; }
          .wide-item-section { padding: 14px 13px; }
          .wide-item-grid-main, .wide-item-grid-meta, .wide-item-grid-brand { grid-template-columns: 1fr 1fr; gap: 12px; }
          .wide-item-grid-main .wide-item-full, .wide-item-grid-brand .wide-item-full { grid-column: 1 / -1; }
          .wide-item-actions { margin-top: 14px; padding: 12px 14px; align-items: stretch; flex-direction: column; }
          .wide-item-note { text-align: center; }
          .wide-item-buttons { width: 100%; }
          .wide-item-btn { flex: 1; }
        }
        @media (max-width: 390px) {
          .wide-item-grid-main, .wide-item-grid-meta, .wide-item-grid-brand { grid-template-columns: 1fr; }
          .wide-item-grid-main .wide-item-full, .wide-item-grid-brand .wide-item-full { grid-column: auto; }
          .wide-item-mark { width: 39px; height: 39px; }
        }
      `}</style>
      <section className="wide-item-dialog" role="dialog" aria-modal="true" aria-labelledby="wide-item-title">
        <header className="wide-item-header">
          <div className="wide-item-mark" aria-hidden="true">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
              <path d="M4.5 7.3 12 3.5l7.5 3.8v9.4L12 20.5l-7.5-3.8V7.3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <path d="m4.8 7.4 7.2 3.8 7.2-3.8M12 11.2v9" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h2 id="wide-item-title" style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>إضافة صنف جديد</h2>
            <p style={{ margin: "4px 0 0", fontSize: 11, opacity: .88 }}>أدخل بيانات الصنف ليتاح فوراً في فاتورة المبيعات</p>
          </div>
          <button type="button" aria-label="إغلاق" style={{ marginInlineStart: "auto", width: 31, height: 31, display: "grid", placeItems: "center", border: 0, borderRadius: 8, color: "#fff", background: "rgba(255,255,255,.15)", fontSize: 20, cursor: "pointer" }}>×</button>
        </header>

        <div className="wide-item-content">
          <section className="wide-item-section" aria-labelledby="item-basic-title">
            <h3 id="item-basic-title" className="wide-item-section-title">البيانات الأساسية</h3>
            <div className="wide-item-grid-main">
              <label className="wide-item-full" style={labelStyle}>الاسم بالعربية *
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: مياه معدنية" style={fieldStyle} />
              </label>
              <label style={labelStyle}>سعر البيع
                <div className="wide-item-input-wrap">
                  <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} style={{ ...fieldStyle, paddingLeft: 50 }} />
                  <span className="wide-item-suffix">ر.س</span>
                </div>
              </label>
              <label style={labelStyle}>الضريبة
                <div className="wide-item-input-wrap">
                  <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} style={{ ...fieldStyle, paddingLeft: 34 }} />
                  <span className="wide-item-suffix">٪</span>
                </div>
              </label>
            </div>
          </section>

          <section className="wide-item-section" aria-labelledby="item-details-title">
            <h3 id="item-details-title" className="wide-item-section-title">التعريف والتصنيف</h3>
            <div className="wide-item-grid-meta">
              <label style={labelStyle}>الكود الداخلي
                <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="مثال: ITM-1042" style={fieldStyle} />
              </label>
              <label style={labelStyle}>الباركود
                <input value={barcode} onChange={(e) => setBarcode(e.target.value)} dir="ltr" placeholder="امسح أو أدخل الرقم" style={fieldStyle} />
              </label>
              <label style={labelStyle}>وحدة القياس *
                <select value={unit} onChange={(e) => setUnit(e.target.value)} style={fieldStyle}>
                  <option>حبة</option><option>كرتون</option><option>كيلو</option><option>لتر</option>
                </select>
              </label>
              <label style={labelStyle}>نوع الصنف
                <select value={nature} onChange={(e) => setNature(e.target.value)} style={fieldStyle}>
                  <option value="stock">صنف مخزني</option><option value="service">خدمة</option>
                </select>
              </label>
            </div>
          </section>

          <section className="wide-item-section" aria-labelledby="item-brand-title">
            <h3 id="item-brand-title" className="wide-item-section-title">ربط العلامة التجارية</h3>
            <div className="wide-item-grid-brand">
              <label style={labelStyle}>العلامة التجارية
                <select value={brand} onChange={(e) => setBrand(e.target.value)} style={fieldStyle}>
                  <option value="">اختر علامة تجارية</option>
                  <option value="صفا">صفا</option><option value="روافد">روافد</option><option value="غير ذلك">غير ذلك</option>
                </select>
              </label>
              <label style={labelStyle}>التصنيف
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={fieldStyle}>
                  <option>عام</option><option>مشروبات</option><option>مواد غذائية</option><option>مستلزمات</option>
                </select>
              </label>
              <button type="button" className="wide-item-brand-add" onClick={() => setBrand("علامة جديدة")}>
                <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>＋</span>
                إضافة علامة تجارية
              </button>
            </div>
            <div className="wide-item-helper">اربط الصنف بعلامته التجارية لتسهيل البحث وإعداد التقارير.</div>
          </section>
        </div>

        <footer className="wide-item-actions">
          <span className="wide-item-note">الحقول التي تحمل علامة * مطلوبة</span>
          <div className="wide-item-buttons">
            <button type="button" className="wide-item-btn wide-item-cancel" onClick={() => { setName(""); setCode(""); setBarcode(""); }}>إلغاء</button>
            <button type="button" className="wide-item-btn wide-item-save" onClick={() => setName((value) => value || "صنف جديد")}>حفظ وإضافة إلى الفاتورة</button>
          </div>
        </footer>
      </section>
    </main>
  );
}
