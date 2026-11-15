import { useEffect, useMemo, useState } from "react";
import { salesItemPartyHistory, type SalesItemPartyHistoryEntry } from "../lib/accounting";
import type { LocalItem } from "../lib/items";
import { listBrands, listItemBrands } from "../lib/brands";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { fmt, input, btnPrimary, btnSecondary } from "../pages/_adminUi";

export function ItemCodeHistoryButton({ code, itemName, disabled, onClick }: {
  code?: string | null;
  itemName: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const displayCode = code?.trim() || text("بدون كود", "No code");
  return (
    <button
      type="button"
      className="zdoc-item-code-history"
      onClick={onClick}
      disabled={disabled}
      dir="ltr"
      aria-label={text(`عرض سجل أسعار ${itemName}`, `View price history for ${itemName}`)}
      title={text(`اضغط لعرض أسعار ${itemName} السابقة لهذا العميل`, `Click to view previous prices for ${itemName} with this customer`)}
      style={{
        flex: "0 0 auto", minWidth: 72, maxWidth: 108, height: 32,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
        padding: "0 7px", overflow: "hidden", border: "1px solid #b8d4cb", borderRadius: 7,
        background: disabled ? "#f8fafc" : "linear-gradient(180deg,#fff,#eff9f6)",
        color: disabled ? "#94a3b8" : "#087f69", fontFamily: "inherit", fontSize: 11,
        fontWeight: 800, whiteSpace: "nowrap", textOverflow: "ellipsis",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayCode}</span>
      <span aria-hidden="true" style={{ flex: "0 0 auto", fontSize: 12 }}>◷</span>
    </button>
  );
}

export interface DocumentItemPickerSelection {
  item: LocalItem;
  quantity: number;
  brandId: number | null;
  brandName: string | null;
  salePrice: number;
  barcode: string | null;
}

interface DocumentItemPickerEntry extends DocumentItemPickerSelection {
  key: string;
  brandCode: string | null;
  brandLogo: string | null;
}

function parsePickerQuantity(raw: string): number | null {
  let value = raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
  const commaCount = (value.match(/,/g) ?? []).length;
  if (commaCount === 1 && !value.includes(".")) value = value.replace(",", ".");
  else value = value.replace(/,/g, "");
  const quantity = Number(value.trim());
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

export function DocumentItemPicker({ items, onCancel, onAdd, showBrandFilters = false, showQuantities = false }: {
  items: LocalItem[];
  onCancel: () => void;
  onAdd: (items: LocalItem[], selections?: DocumentItemPickerSelection[]) => void;
  showBrandFilters?: boolean;
  showQuantities?: boolean;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [query, setQuery] = useState("");
  const [brandFilterId, setBrandFilterId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const brands = useMemo(() => listBrands(), []);
  const brandsById = useMemo(() => new Map(brands.map((brand) => [brand.id, brand])), [brands]);
  const entries = useMemo<DocumentItemPickerEntry[]>(() => items.flatMap((item) => {
    const base: DocumentItemPickerEntry = {
      key: `${item.id}:base`, item, quantity: 1, brandId: null, brandName: null,
      salePrice: item.salePrice ?? 0, barcode: item.barcode ?? null,
      brandCode: null, brandLogo: null,
    };
    if (!showBrandFilters) return [base];
    const variants = listItemBrands(item.id).map((link): DocumentItemPickerEntry => {
      const brand = brandsById.get(link.brandId);
      return {
        key: `${item.id}:brand:${link.brandId}`,
        item,
        quantity: 1,
        brandId: link.brandId,
        brandName: link.brandNameAr,
        salePrice: (link.salePrice1 ?? 0) > 0 ? Number(link.salePrice1) : item.salePrice ?? 0,
        barcode: link.barcode?.trim() || item.barcode || null,
        brandCode: brand?.code ?? null,
        brandLogo: brand?.logoUrl ?? null,
      };
    });
    return [base, ...variants];
  }), [items, showBrandFilters, brandsById]);
  const brandChoices = useMemo(() => {
    const seen = new Set<number>();
    return entries.flatMap((entry) => {
      if (entry.brandId == null || seen.has(entry.brandId)) return [];
      seen.add(entry.brandId);
      return [entry];
    });
  }, [entries]);
  const visibleEntries = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (brandFilterId == null ? entry.brandId != null : entry.brandId !== brandFilterId) return false;
      if (!q) return true;
      return [
        entry.item.nameAr, entry.item.nameEn, entry.item.code, entry.barcode,
        entry.brandName, entry.brandCode,
      ].some((value) => String(value ?? "").toLocaleLowerCase().includes(q));
    });
  }, [entries, query, brandFilterId]);
  const selectedEntries = useMemo(() => entries.filter((entry) => selected.has(entry.key)), [entries, selected]);
  const selectedQuantities = selectedEntries.map((entry) => ({
    entry,
    quantity: showQuantities ? parsePickerQuantity(quantities[entry.key] ?? "1") : 1,
  }));
  const canAdd = selectedQuantities.length > 0 && selectedQuantities.every((entry) => entry.quantity != null);
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10010, display: "grid", placeItems: "center", padding: 16, background: "#0f172a70" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="document-item-picker-title"
        dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: "min(760px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", background: "#fff", borderRadius: 14, border: "1px solid #dbe4eb", boxShadow: "0 24px 70px #0f172a40", overflow: "hidden" }}>
        <header style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8f0", background: "#f3f8f7" }}>
          <h3 id="document-item-picker-title" style={{ margin: 0, color: "#183c39" }}>{text("اختيار أصناف موجودة", "Select existing items")}</h3>
          <p style={{ margin: "5px 0 0", color: "#64748b", fontSize: 13 }}>{text("سيُضاف كل صنف محدد كسطر مستقل ويمكن تعديل كميته.", "Each selected item is added as its own line; quantities remain editable.")}</p>
        </header>
        {showBrandFilters && brandChoices.length > 0 && (
          <nav aria-label={text("تصفية حسب العلامة التجارية", "Filter by brand")}
            style={{ display: "flex", alignItems: "center", gap: 7, overflowX: "auto", padding: "10px 16px 2px", borderBottom: "1px solid #eef2f5" }}>
            <button type="button" onClick={() => setBrandFilterId(null)} aria-pressed={brandFilterId == null}
              style={{
                flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, height: 38,
                padding: "0 12px", borderRadius: 10, border: `1px solid ${brandFilterId == null ? "#087f69" : "#d8e3e8"}`,
                background: brandFilterId == null ? "#e7f6f1" : "#fff", color: brandFilterId == null ? "#087f69" : "#475569",
                font: "inherit", fontSize: 12, fontWeight: 800, cursor: "pointer",
              }}>
              <span aria-hidden="true">▦</span>{text("كل الأصناف", "All items")}
            </button>
            {brandChoices.map((entry) => {
              const active = brandFilterId === entry.brandId;
              return (
                <button key={entry.brandId} type="button" onClick={() => setBrandFilterId(entry.brandId)}
                  aria-pressed={active} title={entry.brandName ?? ""}
                  style={{
                    flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 7, height: 38,
                    maxWidth: 170, padding: "0 10px", borderRadius: 10,
                    border: `1px solid ${active ? "#087f69" : "#d8e3e8"}`,
                    background: active ? "linear-gradient(135deg,#e6f7ef,#d7f0e8)" : "#fff",
                    color: active ? "#087f69" : "#334155", font: "inherit", fontSize: 12,
                    fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
                  }}>
                  <span style={{
                    position: "relative", display: "grid", placeItems: "center", flex: "0 0 25px",
                    width: 25, height: 25, borderRadius: 8, background: "#eaf2f3", color: "#087f69",
                    overflow: "hidden", fontSize: 12, fontWeight: 900,
                  }}>
                    {(entry.brandName ?? "?").trim().slice(0, 1)}
                    {entry.brandLogo && <img src={entry.brandLogo} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.brandName}</span>
                </button>
              );
            })}
          </nav>
        )}
        <div style={{ padding: "12px 16px 8px" }}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            aria-label={text("البحث في الأصناف", "Search items")} placeholder={text("ابحث بالاسم أو الكود أو الباركود", "Search by name, code, or barcode")} style={input} />
          <div aria-live="polite" style={{ marginTop: 7, fontSize: 12, color: "#55716c" }}>
            {text(`محدد: ${selectedEntries.length}`, `Selected: ${selectedEntries.length}`)}
          </div>
        </div>
        <div style={{ overflowY: "auto", minHeight: 140, padding: "0 16px 12px" }}>
          {visibleEntries.length ? visibleEntries.map((entry) => (
            <div key={entry.key} style={{
              display: "grid", gridTemplateColumns: "minmax(0,1fr) 88px 92px 24px",
              alignItems: "center", gap: 10, minHeight: 60, padding: "8px",
              borderBottom: "1px solid #edf1f3",
              background: selected.has(entry.key) ? "#f0faf6" : "#fff",
            }}>
              <span style={{ minWidth: 0 }}>
                <strong style={{ display: "block", color: "#233044", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.item.nameAr}</strong>
                <small style={{ color: "#718096", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[entry.item.code, entry.barcode, entry.brandName].filter(Boolean).join(" · ")}
                </small>
              </span>
              {showQuantities ? (
                <label style={{ display: "grid", gap: 3, color: "#64748b", fontSize: 10, fontWeight: 700 }}>
                  <span>{text("الكمية", "Qty")}</span>
                  <input type="text" inputMode="decimal" dir="ltr" value={quantities[entry.key] ?? "1"}
                    aria-label={text(`كمية ${entry.item.nameAr}${entry.brandName ? ` - ${entry.brandName}` : ""}`, `Quantity for ${entry.item.nameAr}${entry.brandName ? ` - ${entry.brandName}` : ""}`)}
                    onChange={(e) => setQuantities((current) => ({ ...current, [entry.key]: e.target.value }))}
                    style={{ ...input, width: "100%", height: 34, boxSizing: "border-box", textAlign: "center", padding: "4px 6px", fontVariantNumeric: "tabular-nums" }} />
                </label>
              ) : <span />}
              <span style={{ textAlign: "end", fontVariantNumeric: "tabular-nums", color: "#315e56", fontWeight: 700 }}>{fmt(entry.salePrice)}</span>
              <input type="checkbox" checked={selected.has(entry.key)}
                aria-label={text(`اختيار ${entry.item.nameAr}${entry.brandName ? ` - ${entry.brandName}` : ""}`, `Select ${entry.item.nameAr}${entry.brandName ? ` - ${entry.brandName}` : ""}`)}
                onChange={(e) => setSelected((old) => {
                  const next = new Set(old);
                  if (e.target.checked) next.add(entry.key); else next.delete(entry.key);
                  return next;
                })} />
            </div>
          )) : <div style={{ padding: 28, textAlign: "center", color: "#758394" }}>{text("لا توجد أصناف مطابقة", "No matching items")}</div>}
        </div>
        <footer style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderTop: "1px solid #e2e8f0", background: "#f8fafb" }}>
          <button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size} style={{ ...btnSecondary, opacity: selected.size ? 1 : 0.5 }}>{text("إلغاء التحديد", "Clear selection")}</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
            <button type="button" disabled={!canAdd} onClick={() => {
              const picks = selectedQuantities.map(({ entry, quantity }) => ({
                ...entry,
                quantity: quantity ?? 1,
              }));
              onAdd(picks.map((pick) => pick.item), picks);
              onCancel();
            }} style={{ ...btnPrimary, background: "#087f69", opacity: canAdd ? 1 : 0.55 }}>
              {text(`إضافة المحدد (${selectedEntries.length})`, `Add selected (${selectedEntries.length})`)}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function ItemHistoryDialog({ itemId, itemName, customerId, customerName, onClose }: {
  itemId: number;
  itemName: string;
  customerId: number;
  customerName: string;
  onClose: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<SalesItemPartyHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    salesItemPartyHistory(itemId, customerId, 20)
      .then((result) => { if (active) setRows(result); })
      .catch((e: unknown) => { if (active) setError(typeof e === "string" ? e : e instanceof Error ? e.message : text("تعذر تحميل سجل الصنف", "Could not load item history")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [itemId, customerId]);
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10020, display: "grid", placeItems: "center", padding: 16, background: "#0f172a70" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="item-history-title" dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: "min(760px, 96vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", background: "#fff", borderRadius: 14, overflow: "hidden", boxShadow: "0 24px 70px #0f172a40" }}>
        <header style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8f0", background: "#f3f8f7" }}>
          <h3 id="item-history-title" style={{ margin: 0 }}>{text("سجل مبيعات الصنف", "Item sales history")}</h3>
          <div style={{ marginTop: 5, color: "#536b69", fontSize: 13 }}>{itemName} · {customerName}</div>
          <p style={{ margin: "8px 0 0", color: "#725b22", fontSize: 12, lineHeight: 1.5 }}>
            {text("يعرض فواتير المبيعات المُرحّلة فقط (ولا يعرض عروض الأسعار). للاطلاع فقط: لا يغيّر هذا السجل سعر السطر الحالي. السعر المعروض هو السعر المسجل في الفاتورة.", "Posted sales invoices only (quotations are not sales history). Informational only: this history never changes the current line price. The shown amount is the recorded invoice price.")}
          </p>
        </header>
        <div style={{ padding: 16, overflow: "auto", minHeight: 100 }}>
          {loading ? <div role="status" style={{ padding: 22, textAlign: "center", color: "#61736f" }}>{text("جارٍ تحميل السجل…", "Loading history…")}</div>
            : error ? <div role="alert" style={{ padding: 12, color: "#9b2c2c", background: "#fff5f4", borderRadius: 8 }}>{error}</div>
            : rows.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#718096" }}>{text("لا توجد فواتير مبيعات مُرحّلة لهذا الصنف والعميل.", "No posted sales invoices found for this item and customer.")}</div>
            : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#f1f5f6", textAlign: "start" }}>
                {[text("الفاتورة", "Invoice"), text("التاريخ", "Date"), text("الكمية", "Quantity"), text("الوحدة", "Unit"), text("السعر المسجل", "Recorded price"), text("العملة", "Currency")].map((label) => <th key={label} style={{ padding: 9, textAlign: "start" }}>{label}</th>)}
              </tr></thead>
              <tbody>{rows.map((row, index) => <tr key={`${row.invoiceId}-${index}`} style={{ borderBottom: "1px solid #e8edef" }}>
                <td style={{ padding: 9 }}>{row.invoiceNo}</td><td style={{ padding: 9 }}>{row.invoiceDate}</td>
                <td style={{ padding: 9, fontVariantNumeric: "tabular-nums" }}>{fmt(row.qty)}</td><td style={{ padding: 9 }}>{row.uomName ?? "—"}</td>
                <td style={{ padding: 9, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmt(row.unitPrice)}</td><td style={{ padding: 9 }}>{row.currencyCode}</td>
              </tr>)}</tbody>
            </table>}
        </div>
        <footer style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid #e2e8f0" }}>
          <button type="button" onClick={onClose} style={btnSecondary}>{text("إغلاق", "Close")}</button>
        </footer>
      </section>
    </div>
  );
}

export function NoCustomerHistoryDialog({ onClose }: { onClose: () => void }) {
  const language = useUiLanguage();
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10020, display: "grid", placeItems: "center", padding: 16, background: "#0f172a70" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="item-history-no-customer" dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: "min(430px, 94vw)", padding: 22, borderRadius: 14, background: "#fff", boxShadow: "0 24px 70px #0f172a40" }}>
        <h3 id="item-history-no-customer" style={{ marginTop: 0 }}>{uiText("سجل الصنف", "Item history", language)}</h3>
        <p style={{ color: "#64748b", lineHeight: 1.6 }}>{uiText("اختر عميلاً أولاً لعرض سجل فواتير المبيعات المُرحّلة الخاصة به.", "Select a customer first to view their posted sales-invoice history.", language)}</p>
        <div style={{ textAlign: "end" }}><button type="button" onClick={onClose} style={btnSecondary}>{uiText("إغلاق", "Close", language)}</button></div>
      </section>
    </div>
  );
}
