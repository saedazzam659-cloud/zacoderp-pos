import { useRef, useState } from "react";
import { getDefaultUom, type Uom } from "../lib/uom";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { btnPrimary, btnSecondary, input } from "../pages/_adminUi";
import { listBrands } from "../lib/brands";

export type QuickCreatePayload =
  | { kind: "customer"; nameAr: string; phone: string; vatNumber: string }
  | { kind: "item"; nameAr: string; code: string; barcode: string; salePrice: number; salePriceTouched?: boolean; vatRate: number; vatRateTouched?: boolean; nature: "stock" | "service"; uomId: number; brandId: number | null; quantity?: number };

export interface QuickCreateSavedItem {
  entryKey: string;
  itemId: number;
  nameAr: string;
  quantity: number;
  salePrice: number;
  vatRate: number;
  code: string;
  barcode: string;
  nature: "stock" | "service";
  uomId: number;
  brandId: number | null;
  createdInSession: boolean;
}

export interface QuickCreateSubmitContext {
  entryKey: string;
  editingEntry: QuickCreateSavedItem | null;
}

export type QuickCreateSubmitResult =
  | boolean
  | void
  | { ok: true; savedItem: QuickCreateSavedItem; notice?: string };

export default function QuickCreateDialog({ kind, documentLabel, initialVatRate, includeQuantity = false, busy, error, onCancel, onSubmit, uoms, showSavedItems = false, documentItemCount = 0 }: {
  kind: "customer" | "item";
  documentLabel: { ar: string; en: string };
  initialVatRate: number;
  includeQuantity?: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: QuickCreatePayload, action: "close" | "add-another", context?: QuickCreateSubmitContext) => QuickCreateSubmitResult | Promise<QuickCreateSubmitResult>;
  uoms: Uom[];
  showSavedItems?: boolean;
  documentItemCount?: number;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [nameAr, setNameAr] = useState("");
  const [phone, setPhone] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [code, setCode] = useState("");
  const [barcode, setBarcode] = useState("");
  const [salePrice, setSalePrice] = useState(0);
  const [salePriceTouched, setSalePriceTouched] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [vatRate, setVatRate] = useState(initialVatRate);
  const [vatRateTouched, setVatRateTouched] = useState(false);
  const [nature, setNature] = useState<"stock" | "service">("stock");
  const [uomId, setUomId] = useState(() => getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [savedItems, setSavedItems] = useState<QuickCreateSavedItem[]>([]);
  const [editingEntryKey, setEditingEntryKey] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const nextEntryNumber = useRef(0);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const isCustomer = kind === "customer";
  const accent = isCustomer ? "#2563eb" : "#7c3aed";
  const fieldStyle = { ...input, borderRadius: 9, padding: "9px 11px", background: "#fff" };
  const brands = isCustomer ? [] : listBrands().filter((brand) => brand.status === "active");
  const editingEntry = savedItems.find((item) => item.entryKey === editingEntryKey) ?? null;
  const catalogLocked = !!editingEntry && !editingEntry.createdInSession;
  const historyEnabled = !isCustomer && showSavedItems;
  const totalSavedQuantity = savedItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalSavedValue = savedItems.reduce((sum, item) => sum + item.quantity * item.salePrice, 0);
  const formatNumber = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

  function resetItemForm() {
    setNameAr(""); setCode(""); setBarcode(""); setSalePrice(0);
    setSalePriceTouched(false);
    setQuantity(1);
    setVatRate(initialVatRate); setVatRateTouched(false);
    setNature("stock"); setUomId(() => getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
    setBrandId(null);
    setEditingEntryKey(null);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }

  function openSavedItem(item: QuickCreateSavedItem) {
    if (editingEntryKey === item.entryKey) return;
    if (nameAr.trim() && !window.confirm(text("سيتم استبدال بيانات الصنف الحالية. هل تريد المتابعة؟", "Replace the current item form with this saved item?"))) return;
    setNameAr(item.nameAr);
    setCode(item.code);
    setBarcode(item.barcode);
    setSalePrice(item.salePrice);
    setSalePriceTouched(true);
    setQuantity(item.quantity);
    setVatRate(item.vatRate);
    setVatRateTouched(true);
    setNature(item.nature);
    setUomId(item.uomId);
    setBrandId(item.brandId);
    setEditingEntryKey(item.entryKey);
    setSaveNotice(item.createdInSession ? null : text("هذا الصنف موجود في الدليل؛ يمكنك تعديل سعره وكميته لهذه الفاتورة دون تغيير بياناته الأساسية.", "This item already exists in the catalog; edit its price or quantity for this invoice without changing its catalog details."));
  }

  async function submit(action: "close" | "add-another" = "close") {
    const payload: QuickCreatePayload = isCustomer
      ? { kind, nameAr, phone, vatNumber }
      : { kind, nameAr, code, barcode, salePrice, salePriceTouched, vatRate, vatRateTouched, nature, uomId, brandId, ...(includeQuantity ? { quantity } : {}) };
    const entryKey = editingEntry?.entryKey ?? `quick-item-${++nextEntryNumber.current}`;
    const context = historyEnabled ? { entryKey, editingEntry } : undefined;
    const result = await onSubmit(payload, action, context);
    const savedResult = result && typeof result === "object" && "ok" in result && result.ok ? result : null;
    const succeeded = result === true || !!savedResult;
    if (savedResult && historyEnabled) {
      setSavedItems((items) => {
        const existingIndex = items.findIndex((item) => item.entryKey === savedResult.savedItem.entryKey);
        if (existingIndex < 0) return [...items, savedResult.savedItem];
        return items.map((item, index) => index === existingIndex ? savedResult.savedItem : item);
      });
      setSaveNotice(savedResult.notice ?? null);
    }
    if (action === "add-another" && succeeded) {
      resetItemForm();
      if (savedResult?.notice) setSaveNotice(savedResult.notice);
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
          {historyEnabled && (
            <section aria-label={text("الأصناف المضافة سريعًا", "Quick-added items")} data-testid="quick-create-saved-items-summary"
              style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid #ddd6fe", borderInlineStart: "4px solid #7c3aed", borderRadius: 12, background: "linear-gradient(120deg,#faf5ff,#fff)", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 12 }}>
                <strong style={{ color: "#5b21b6" }}>{text("الأصناف المضافة", "Added items")}</strong>
                <span style={{ padding: "3px 8px", borderRadius: 999, background: "#ede9fe", color: "#5b21b6", fontWeight: 800 }}>
                  {savedItems.length} {text("صنف سريع", "quick items")}
                </span>
                <span data-testid="quick-create-invoice-item-count" style={{ color: "#475569" }}>{text("إجمالي أصناف الفاتورة", "Invoice item lines")}: <b>{documentItemCount}</b></span>
                <span style={{ color: "#475569" }}>{text("الكمية", "Quantity")}: <b>{formatNumber(totalSavedQuantity)}</b></span>
                <span data-testid="quick-create-saved-item-value" style={{ marginInlineStart: "auto", color: "#334155" }}>{text("قيمة الأصناف قبل الضريبة", "Item value before tax")}: <b>{formatNumber(totalSavedValue)}</b></span>
                <button type="button" data-testid="button-quick-create-new-item" onClick={() => {
                  if (nameAr.trim() && !window.confirm(text("سيتم مسح بيانات الصنف الحالية وبدء صنف جديد. هل تريد المتابعة؟", "Clear the current item form and start a new item?"))) return;
                  resetItemForm();
                  setSaveNotice(null);
                }}
                  style={{ ...btnSecondary, padding: "5px 9px", borderRadius: 8, color: "#6d28d9", whiteSpace: "nowrap" }}>
                  + {text("صنف جديد", "New item")}
                </button>
              </div>
              {savedItems.length > 0 && (
                <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2, scrollbarWidth: "thin" }}>
                  {savedItems.map((item) => (
                    <button key={item.entryKey} type="button" data-testid={`quick-created-item-${item.entryKey}`}
                      onClick={() => openSavedItem(item)}
                      aria-pressed={editingEntryKey === item.entryKey}
                      title={text("اضغط للعودة إلى الصنف وتعديله", "Select to edit this saved item")}
                      style={{ flex: "0 0 auto", minWidth: 150, maxWidth: 250, display: "grid", gap: 3, textAlign: "start", padding: "7px 10px", borderRadius: 9, border: `1px solid ${editingEntryKey === item.entryKey ? "#7c3aed" : "#e2e8f0"}`, background: editingEntryKey === item.entryKey ? "#f3e8ff" : "#fff", color: "#1e293b", cursor: "pointer", boxShadow: editingEntryKey === item.entryKey ? "0 0 0 2px #7c3aed22" : "0 1px 3px #0f172a0a" }}>
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{item.nameAr}</strong>
                      <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>{formatNumber(item.quantity)} × {formatNumber(item.salePrice)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700, gridColumn: isCustomer ? undefined : "1 / -1" }}>
            {editingEntry ? text("تعديل الصنف المضاف *", "Edit saved item *") : text("الاسم بالعربية *", "Arabic name *")}
            <input ref={nameInputRef} autoFocus value={nameAr} disabled={catalogLocked} onChange={(e) => setNameAr(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              placeholder={isCustomer ? text("مثال: أحمد محمد", "Example: Ahmed Mohamed") : text("مثال: مياه معدنية", "Example: Mineral water")} style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
          </label>
          {catalogLocked && <div role="note" style={{ padding: "8px 10px", borderRadius: 9, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8", fontSize: 12 }}>
            {text("الصنف موجود في الدليل؛ تعديل السعر والكمية هنا يخص الفاتورة فقط.", "This catalog item is reused; price and quantity edits apply to this invoice only.")}
          </div>}
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
                  <input type="number" min="0" step="0.01" value={salePrice} onChange={(e) => { setSalePrice(Number(e.target.value) || 0); setSalePriceTouched(true); }} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الضريبة %", "Tax %")}
                  <input type="number" min="0" max="100" step="0.01" value={vatRate} onChange={(e) => { setVatRate(Number(e.target.value) || 0); setVatRateTouched(true); }} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الكود (اختياري)", "Code (optional)")}
                  <input value={code} disabled={catalogLocked} onChange={(e) => setCode(e.target.value)} dir="ltr" style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الباركود (اختياري)", "Barcode (optional)")}
                  <input value={barcode} disabled={catalogLocked} onChange={(e) => setBarcode(e.target.value)} dir="ltr" style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("وحدة القياس *", "Unit of measure *")}
                <select value={uomId || ""} disabled={catalogLocked} onChange={(e) => setUomId(Number(e.target.value) || 0)} style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }}>
                  <option value="">{text("اختر وحدة القياس", "Choose a unit")}</option>
                  {uoms.map((unit) => <option key={unit.id} value={unit.id}>
                    {language === "en" ? unit.nameEn || unit.nameAr : unit.nameAr}{unit.shortCode ? ` (${unit.shortCode})` : ""}
                  </option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("نوع الصنف", "Item type")}
                <select value={nature} disabled={catalogLocked} onChange={(e) => setNature(e.target.value as "stock" | "service")} style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }}>
                  <option value="stock">{text("صنف مخزني", "Stock item")}</option>
                  <option value="service">{text("خدمة", "Service")}</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                {text("العلامة التجارية (اختياري)", "Brand (optional)")}
                <select value={brandId ?? ""} disabled={catalogLocked} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)} style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }}>
                  <option value="">{text("بدون علامة تجارية", "No brand")}</option>
                  {brands.map((brand) => <option key={brand.id} value={brand.id}>{language === "en" ? brand.nameEn || brand.nameAr : brand.nameAr}</option>)}
                </select>
                <span style={{ fontWeight: 400, color: "#718096" }}>{text("يُحفظ الربط على هذا الجهاز فقط.", "This link is stored on this device only.")}</span>
              </label>
            </>
          )}
          {saveNotice && <div role="status" aria-live="polite" style={{ padding: "9px 11px", borderRadius: 9, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: 13 }}>{saveNotice}</div>}
          {error && <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", fontSize: 13 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, padding: "12px 20px", borderTop: "1px solid #e7edf1", background: "#fbfcfd", flexWrap: "wrap" }}>
            <button type="button" onClick={onCancel} disabled={busy} style={{ ...btnSecondary, borderRadius: 9, padding: "9px 14px" }}>{text("إلغاء", "Cancel")}</button>
            {!isCustomer && <button type="button" onClick={() => void submit("add-another")} disabled={busy || !nameAr.trim() || !uomId}
              style={{ ...btnSecondary, borderRadius: 9, padding: "9px 16px", color: accent, borderColor: `${accent}55`, opacity: busy || !nameAr.trim() || !uomId ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : editingEntry ? text("حفظ التعديل وإضافة آخر", "Save changes and add another") : text("حفظ وإضافة آخر", "Save and add another")}
            </button>}
            <button type="button" onClick={() => void submit("close")} disabled={busy || !nameAr.trim() || (!isCustomer && !uomId)}
              style={{ ...btnPrimary, borderRadius: 9, padding: "9px 16px", background: accent, opacity: busy || !nameAr.trim() || (!isCustomer && !uomId) ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : isCustomer ? text("حفظ وإضافة للفاتورة", "Save and add customer") : editingEntry ? text("حفظ التعديل وإغلاق", "Save changes and close") : text("حفظ وإغلاق", "Save and close")}
            </button>
        </div>
      </section>
    </div>
  );
}
