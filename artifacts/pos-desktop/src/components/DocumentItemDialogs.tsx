import { useEffect, useMemo, useState } from "react";
import { salesItemPartyHistory, type SalesItemPartyHistoryEntry } from "../lib/accounting";
import type { LocalItem } from "../lib/items";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { fmt, input, btnPrimary, btnSecondary } from "../pages/_adminUi";

export function DocumentItemPicker({ items, onCancel, onAdd }: {
  items: LocalItem[];
  onCancel: () => void;
  onAdd: (items: LocalItem[]) => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter((item) => [item.nameAr, item.nameEn, item.code, item.barcode]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(q)));
  }, [items, query]);
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10010, display: "grid", placeItems: "center", padding: 16, background: "#0f172a70" }}>
      <section role="dialog" aria-modal="true" aria-labelledby="document-item-picker-title"
        dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: "min(680px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "#fff", borderRadius: 14, border: "1px solid #dbe4eb", boxShadow: "0 24px 70px #0f172a40", overflow: "hidden" }}>
        <header style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8f0", background: "#f3f8f7" }}>
          <h3 id="document-item-picker-title" style={{ margin: 0, color: "#183c39" }}>{text("اختيار أصناف موجودة", "Select existing items")}</h3>
          <p style={{ margin: "5px 0 0", color: "#64748b", fontSize: 13 }}>{text("سيُضاف كل صنف محدد كسطر مستقل ويمكن تعديل كميته.", "Each selected item is added as its own line; quantities remain editable.")}</p>
        </header>
        <div style={{ padding: "12px 16px 8px" }}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            aria-label={text("البحث في الأصناف", "Search items")} placeholder={text("ابحث بالاسم أو الكود أو الباركود", "Search by name, code, or barcode")} style={input} />
          <div aria-live="polite" style={{ marginTop: 7, fontSize: 12, color: "#55716c" }}>
            {text(`محدد: ${selected.size}`, `Selected: ${selected.size}`)}
          </div>
        </div>
        <div style={{ overflowY: "auto", minHeight: 140, padding: "0 16px 12px" }}>
          {filtered.length ? filtered.map((item) => (
            <label key={item.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 8px", borderBottom: "1px solid #edf1f3", cursor: "pointer" }}>
              <input type="checkbox" checked={selected.has(item.id)}
                onChange={(e) => setSelected((old) => {
                  const next = new Set(old);
                  if (e.target.checked) next.add(item.id); else next.delete(item.id);
                  return next;
                })} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: "block", color: "#233044" }}>{item.nameAr}</strong>
                <small style={{ color: "#718096" }}>{[item.code, item.barcode].filter(Boolean).join(" · ")}</small>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: "#315e56" }}>{fmt(item.salePrice)}</span>
            </label>
          )) : <div style={{ padding: 28, textAlign: "center", color: "#758394" }}>{text("لا توجد أصناف مطابقة", "No matching items")}</div>}
        </div>
        <footer style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderTop: "1px solid #e2e8f0", background: "#f8fafb" }}>
          <button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size} style={{ ...btnSecondary, opacity: selected.size ? 1 : 0.5 }}>{text("إلغاء التحديد", "Clear selection")}</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
            <button type="button" disabled={!selected.size} onClick={() => {
              const ids = selected;
              onAdd(items.filter((item) => ids.has(item.id)));
              onCancel();
            }} style={{ ...btnPrimary, background: "#087f69", opacity: selected.size ? 1 : 0.55 }}>
              {text(`إضافة المحدد (${selected.size})`, `Add selected (${selected.size})`)}
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
