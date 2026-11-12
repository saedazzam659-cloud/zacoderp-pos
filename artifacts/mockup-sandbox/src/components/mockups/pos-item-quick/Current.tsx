import { useState } from "react";
import "./_group.css";

const input = { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit" };
const btnPrimary = { padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 };
const btnSecondary = { padding: "8px 16px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 14 };

export function Current() {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("25");
  const [tax, setTax] = useState("15");
  const [code, setCode] = useState("");
  const [barcode, setBarcode] = useState("");
  const [unit, setUnit] = useState("1");
  const [nature, setNature] = useState("stock");
  return (
    <div className="min-h-screen bg-slate-100 p-6 flex items-center justify-center" dir="rtl">
      <section role="dialog" aria-modal="true" className="w-full overflow-hidden rounded-[18px] border border-white/70 bg-white shadow-2xl" style={{ maxWidth: 480 }}>
        <header className="px-5 py-[18px] text-white" style={{ background: "linear-gradient(120deg,#7c3aed,#a855f7)" }}>
          <div className="flex items-center gap-3">
            <div className="grid size-[42px] place-items-center rounded-[13px] border border-white/30 bg-white/15 text-[22px]">📦</div>
            <div>
              <h2 className="m-0 text-lg font-extrabold">إضافة صنف جديد</h2>
              <p className="mt-1 text-xs opacity-90">أدخل البيانات الأساسية فقط، وسيظهر مباشرة في فاتورة المبيعات</p>
            </div>
            <button type="button" aria-label="إغلاق" className="ms-auto grid size-[30px] place-items-center rounded-lg border-0 bg-white/15 text-xl text-white">×</button>
          </div>
        </header>
        <div className="grid gap-3 p-5">
          <label className="grid gap-1 text-xs font-bold text-slate-600">الاسم بالعربية *
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: مياه معدنية" style={input} />
          </label>
          <div className="grid grid-cols-2 gap-[10px]">
            <label className="grid gap-1 text-xs font-bold text-slate-600">سعر البيع
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} style={input} />
            </label>
            <label className="grid gap-1 text-xs font-bold text-slate-600">الضريبة %
              <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} style={input} />
            </label>
            <label className="grid gap-1 text-xs font-bold text-slate-600">الكود (اختياري)
              <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" style={input} />
            </label>
            <label className="grid gap-1 text-xs font-bold text-slate-600">الباركود (اختياري)
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)} dir="ltr" style={input} />
            </label>
          </div>
          <label className="grid gap-1 text-xs font-bold text-slate-600">وحدة القياس *
            <select value={unit} onChange={(e) => setUnit(e.target.value)} style={input}>
              <option value="1">حبة</option><option value="2">كرتون</option><option value="3">كيلو</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-bold text-slate-600">نوع الصنف
            <select value={nature} onChange={(e) => setNature(e.target.value)} style={input}>
              <option value="stock">صنف مخزني</option><option value="service">خدمة</option>
            </select>
          </label>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" style={btnSecondary}>إلغاء</button>
            <button type="button" style={{ ...btnPrimary, background: "#7c3aed" }}>حفظ وإضافة إلى الفاتورة</button>
          </div>
        </div>
      </section>
    </div>
  );
}
