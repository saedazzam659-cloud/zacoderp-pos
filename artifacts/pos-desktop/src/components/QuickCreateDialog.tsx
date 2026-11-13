import { useState } from "react";
import { getDefaultUom, type Uom } from "../lib/uom";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { btnPrimary, btnSecondary, input } from "../pages/_adminUi";
import { listBrands } from "../lib/brands";

export type QuickCreatePayload =
  | { kind: "customer"; nameAr: string; phone: string; vatNumber: string }
  | { kind: "item"; nameAr: string; code: string; barcode: string; salePrice: number; vatRate: number; nature: "stock" | "service"; uomId: number; brandId: number | null; quantity?: number };

export default function QuickCreateDialog({ kind, documentLabel, initialVatRate, includeQuantity = false, busy, error, onCancel, onSubmit, uoms }: {
  kind: "customer" | "item";
  documentLabel: { ar: string; en: string };
  initialVatRate: number;
  includeQuantity?: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: QuickCreatePayload, action: "close" | "add-another") => void | boolean | Promise<void | boolean>;
  uoms: Uom[];
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [nameAr, setNameAr] = useState("");
  const [phone, setPhone] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [code, setCode] = useState("");
  const [barcode, setBarcode] = useState("");
  const [salePrice, setSalePrice] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [vatRate, setVatRate] = useState(initialVatRate);
  const [nature, setNature] = useState<"stock" | "service">("stock");
  const [uomId, setUomId] = useState(() => getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
  const [brandId, setBrandId] = useState<number | null>(null);
  const isCustomer = kind === "customer";
  const accent = isCustomer ? "#2563eb" : "#7c3aed";
  const fieldStyle = { ...input, borderRadius: 9, padding: "9px 11px", background: "#fff" };
  const brands = isCustomer ? [] : listBrands().filter((brand) => brand.status === "active");

  async function submit(action: "close" | "add-another" = "close") {
    const payload: QuickCreatePayload = isCustomer
      ? { kind, nameAr, phone, vatNumber }
      : { kind, nameAr, code, barcode, salePrice, vatRate, nature, uomId, brandId, ...(includeQuantity ? { quantity } : {}) };
    const result = await onSubmit(payload, action);
    if (action === "add-another" && result === true) {
      setNameAr(""); setCode(""); setBarcode(""); setSalePrice(0);
      setQuantity(1);
      setVatRate(initialVatRate); setNature("stock"); setUomId(() => getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
      setBrandId(null);
    }
  }

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 12, background: "#0f172a75", backdropFilter: "blur(3px)" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="quick-create-title"
        dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: isCustomer ? "min(100%, 560px)" : "min(1180px, calc(100vw - 24px))", maxHeight: "min(94dvh, 900px)", display: "flex", flexDirection: "column", borderRadius: 18, overflow: "hidden", background: "#fff", boxShadow: "0 24px 80px #02061755", border: "1px solid #ffffffaa" }}>
        <div style={{ padding: "18px 20px", color: "#fff", background: `linear-gradient(120deg, ${accent}, ${isCustomer ? "#06b6d4" : "#a855f7"})` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div aria-hidden="true" style={{ width: 42, height: 42, borderRadius: 13, display: "grid", placeItems: "center", fontSize: 20, fontWeight: 800, background: "#ffffff25", border: "1px solid #ffffff45" }}>
              {isCustomer ? "＋" : "□"}
            </div>
            <div>
              <h3 id="quick-create-title" style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                {isCustomer ? text("إضافة عميل جديد", "Add a customer") : text("إضافة صنف جديد", "Add an item")}
              </h3>
              <div style={{ marginTop: 3, fontSize: 12, opacity: 0.9 }}>
                {text(`أدخل البيانات الأساسية فقط، وسيظهر مباشرة في ${documentLabel.ar}`, `Enter only the essentials; it will be available in the ${documentLabel.en}`)}
              </div>
            </div>
            <button type="button" onClick={onCancel} disabled={busy} aria-label={text("إغلاق", "Close")}
              style={{ marginInlineStart: "auto", width: 30, height: 30, border: 0, borderRadius: 9, color: "#fff", background: "#ffffff25", cursor: "pointer", fontSize: 19 }}>×</button>
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 12, overflowY: "auto", minHeight: 0 }}>
          <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700, gridColumn: isCustomer ? undefined : "1 / -1" }}>
            {text("الاسم بالعربية *", "Arabic name *")}
            <input autoFocus value={nameAr} onChange={(e) => setNameAr(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              placeholder={isCustomer ? text("مثال: أحمد محمد", "Example: Ahmed Mohamed") : text("مثال: مياه معدنية", "Example: Mineral water")} style={fieldStyle} />
          </label>
          {isCustomer ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("رقم الهاتف", "Phone")}
                <input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" placeholder="01xxxxxxxxx" style={fieldStyle} />
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("الرقم الضريبي", "Tax number")}
                <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} dir="ltr" inputMode="numeric" placeholder={text("اختياري", "Optional")} style={fieldStyle} />
              </label>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                {includeQuantity && (
                  <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                    {text("الكمية المضافة للمستند", "Quantity to add")}
                    <input type="number" min="0.001" step="0.001" value={quantity}
                      onChange={(e) => setQuantity(Number(e.target.value) || 0)} style={fieldStyle} />
                  </label>
                )}
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("سعر البيع", "Sale price")}
                  <input type="number" min="0" step="0.01" value={salePrice} onChange={(e) => setSalePrice(Number(e.target.value) || 0)} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الضريبة %", "Tax %")}
                  <input type="number" min="0" max="100" step="0.01" value={vatRate} onChange={(e) => setVatRate(Number(e.target.value) || 0)} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الكود (اختياري)", "Code (optional)")}
                  <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الباركود (اختياري)", "Barcode (optional)")}
                  <input value={barcode} onChange={(e) => setBarcode(e.target.value)} dir="ltr" style={fieldStyle} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("وحدة القياس *", "Unit of measure *")}
                <select value={uomId || ""} onChange={(e) => setUomId(Number(e.target.value) || 0)} style={fieldStyle}>
                  <option value="">{text("اختر وحدة القياس", "Choose a unit")}</option>
                  {uoms.map((unit) => <option key={unit.id} value={unit.id}>
                    {language === "en" ? unit.nameEn || unit.nameAr : unit.nameAr}{unit.shortCode ? ` (${unit.shortCode})` : ""}
                  </option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("نوع الصنف", "Item type")}
                <select value={nature} onChange={(e) => setNature(e.target.value as "stock" | "service")} style={fieldStyle}>
                  <option value="stock">{text("صنف مخزني", "Stock item")}</option>
                  <option value="service">{text("خدمة", "Service")}</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("العلامة التجارية (اختياري)", "Brand (optional)")}
                <select value={brandId ?? ""} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)} style={fieldStyle}>
                  <option value="">{text("بدون علامة تجارية", "No brand")}</option>
                  {brands.map((brand) => <option key={brand.id} value={brand.id}>{language === "en" ? brand.nameEn || brand.nameAr : brand.nameAr}</option>)}
                </select>
                <span style={{ fontWeight: 400, color: "#718096" }}>{text("يُحفظ الربط على هذا الجهاز فقط.", "This link is stored on this device only.")}</span>
              </label>
            </>
          )}
          {error && <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", fontSize: 13 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, padding: "12px 20px", borderTop: "1px solid #e7edf1", background: "#fbfcfd", flexWrap: "wrap" }}>
            <button type="button" onClick={onCancel} disabled={busy} style={{ ...btnSecondary, borderRadius: 9, padding: "9px 14px" }}>{text("إلغاء", "Cancel")}</button>
            {!isCustomer && <button type="button" onClick={() => void submit("add-another")} disabled={busy || !nameAr.trim() || !uomId}
              style={{ ...btnSecondary, borderRadius: 9, padding: "9px 16px", color: accent, borderColor: `${accent}55`, opacity: busy || !nameAr.trim() || !uomId ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : text("حفظ وإضافة آخر", "Save and add another")}
            </button>}
            <button type="button" onClick={() => void submit("close")} disabled={busy || !nameAr.trim() || (!isCustomer && !uomId)}
              style={{ ...btnPrimary, borderRadius: 9, padding: "9px 16px", background: accent, opacity: busy || !nameAr.trim() || (!isCustomer && !uomId) ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : isCustomer ? text("حفظ وإضافة للفاتورة", "Save and add customer") : text("حفظ وإغلاق", "Save and close")}
            </button>
        </div>
      </section>
    </div>
  );
}
