import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { getDefaultUom, type Uom } from "../lib/uom";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { btnPrimary, btnSecondary, input } from "../pages/_adminUi";
import { listBrands, listItemBrands } from "../lib/brands";

export type QuickCreatePayload =
  | { kind: "customer"; nameAr: string; phone: string; vatNumber: string }
  | { kind: "item"; nameAr: string; code: string; barcode: string; salePrice: number; salePriceTouched?: boolean; vatRate: number; vatRateTouched?: boolean; nature: "stock" | "service"; uomId: number; brandId: number | null; catalogItemId?: number | null; quantity?: number };

export interface QuickCreateCatalogItem {
  id: number;
  nameAr: string;
  code?: string | null;
  barcode?: string | null;
  salePrice: number;
  vatRate: number;
  nature?: "stock" | "service" | null;
  uomId?: number | null;
}

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

const EMPTY_QUICK_CREATE_ITEMS: QuickCreateSavedItem[] = [];
const EMPTY_QUICK_CREATE_CATALOG: QuickCreateCatalogItem[] = [];

export interface QuickCreateSubmitContext {
  entryKey: string;
  editingEntry: QuickCreateSavedItem | null;
}

export type QuickCreateSubmitResult =
  | boolean
  | void
  | { ok: true; savedItem: QuickCreateSavedItem; notice?: string };

export default function QuickCreateDialog({ kind, documentLabel, initialVatRate, includeQuantity = false, busy, error, onCancel, onSubmit, uoms, showSavedItems = false, documentItemCount = 0, savedInvoiceItems = EMPTY_QUICK_CREATE_ITEMS, catalogItems = EMPTY_QUICK_CREATE_CATALOG, invoiceTotal, invoiceCurrency = "", invoiceControls, onSaveInvoice, invoiceSaving = false, canSaveInvoice = false, resetToken = 0 }: {
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
  savedInvoiceItems?: QuickCreateSavedItem[];
  catalogItems?: QuickCreateCatalogItem[];
  invoiceTotal?: string;
  invoiceCurrency?: string;
  invoiceControls?: ReactNode;
  onSaveInvoice?: () => void | Promise<void>;
  invoiceSaving?: boolean;
  canSaveInvoice?: boolean;
  resetToken?: number;
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
  const [selectedCatalogItemId, setSelectedCatalogItemId] = useState<number | null>(null);
  const [catalogSuggestionsOpen, setCatalogSuggestionsOpen] = useState(false);
  const [catalogSuggestionIndex, setCatalogSuggestionIndex] = useState(-1);
  const [savedItems, setSavedItems] = useState<QuickCreateSavedItem[]>(savedInvoiceItems);
  const [editingEntryKey, setEditingEntryKey] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const nextEntryNumber = useRef(0);
  const previousResetToken = useRef(resetToken);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const isCustomer = kind === "customer";
  const accent = isCustomer ? "#2563eb" : "#7c3aed";
  const fieldStyle = { ...input, borderRadius: 9, padding: "9px 11px", background: "#fff" };
  const editingEntry = savedItems.find((item) => item.entryKey === editingEntryKey) ?? null;
  const selectedCatalogItem = catalogItems.find((item) => item.id === selectedCatalogItemId) ?? null;
  const lockedCatalogItemId = selectedCatalogItem?.id ?? (editingEntry && !editingEntry.createdInSession ? editingEntry.itemId : null);
  const catalogLocked = (!!editingEntry && !editingEntry.createdInSession) || !!selectedCatalogItem;
  const brands = isCustomer ? [] : listBrands().filter((brand) =>
    brand.status === "active" && (
      lockedCatalogItemId == null
      || brand.id === editingEntry?.brandId
      || listItemBrands(lockedCatalogItemId).some((link) => link.brandId === brand.id && link.status === "active")
    ),
  );
  const historyEnabled = !isCustomer && showSavedItems;
  const normalizedSearch = nameAr.normalize("NFKC").replace(/[\u0640-\u065F\u0670]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const catalogSuggestions = (() => {
    if (!historyEnabled || !normalizedSearch || selectedCatalogItemId) return [];
    const prefixMatches: QuickCreateCatalogItem[] = [];
    const otherMatches: QuickCreateCatalogItem[] = [];
    for (const item of catalogItems) {
      const name = item.nameAr.normalize("NFKC").replace(/[\u0640-\u065F\u0670]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const code = (item.code ?? "").trim().toLocaleLowerCase();
      const barcode = (item.barcode ?? "").trim().toLocaleLowerCase();
      if (name.startsWith(normalizedSearch) || code.startsWith(normalizedSearch) || barcode.startsWith(normalizedSearch)) {
        if (prefixMatches.length < 8) prefixMatches.push(item);
      } else if (name.includes(normalizedSearch) || code.includes(normalizedSearch) || barcode.includes(normalizedSearch)) {
        if (otherMatches.length < 8) otherMatches.push(item);
      }
      if (prefixMatches.length >= 8) break;
    }
    return [...prefixMatches, ...otherMatches].slice(0, 8);
  })();
  const showCatalogSuggestions = catalogSuggestionsOpen && catalogSuggestions.length > 0;
  const nameInputId = isCustomer ? "quick-create-customer-name" : "quick-create-item-name";
  const hasUnappliedItem = !isCustomer && (
    !!nameAr.trim() || !!code.trim() || !!barcode.trim() || salePriceTouched || vatRateTouched
    || quantity !== 1 || nature !== "stock" || brandId != null
    || uomId !== (getDefaultUom()?.id ?? uoms[0]?.id ?? 0)
  );
  const totalSavedQuantity = savedItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalSavedValue = savedItems.reduce((sum, item) => sum + item.quantity * item.salePrice, 0);
  const formatNumber = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

  function isQuickCreateFocusable(node: HTMLElement): boolean {
    if (node.getClientRects().length === 0 || node.getAttribute("aria-disabled") === "true") return false;
    if ("disabled" in node && Boolean((node as HTMLInputElement).disabled)) return false;
    if ("readOnly" in node && Boolean((node as HTMLInputElement).readOnly)) return false;
    return true;
  }

  function quickCreateNavFields(includeArrowButtons = false): HTMLElement[] {
    const root = dialogRef.current;
    if (!root) return [];
    const selector = includeArrowButtons ? '[data-fnav="1"], [data-qc-arrow="1"]' : '[data-fnav="1"]';
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isQuickCreateFocusable);
  }

  function advanceQuickCreateField(from: HTMLElement | null): void {
    if (!from) return;
    const fields = quickCreateNavFields();
    const index = fields.indexOf(from);
    if (index < 0) return;
    for (let next = index + 1; next < fields.length; next += 1) {
      const field = fields[next];
      field.focus();
      if (document.activeElement !== field) continue;
      (field as HTMLInputElement).select?.();
      return;
    }
  }

  function canMoveFromTextBoundary(field: HTMLElement, key: "ArrowLeft" | "ArrowRight"): boolean {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return true;
    if (field instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "password"].includes(field.type)) return true;
    try {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      if (start == null || end == null || start !== end) return false;
      const rtl = getComputedStyle(field).direction === "rtl";
      const atStart = start === 0;
      const atEnd = end === field.value.length;
      return key === "ArrowLeft" ? (rtl ? atEnd : atStart) : (rtl ? atStart : atEnd);
    } catch {
      return true;
    }
  }

  function moveQuickCreateFieldHorizontally(from: HTMLElement, key: "ArrowLeft" | "ArrowRight"): boolean {
    const currentRect = from.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    const candidates = quickCreateNavFields(true)
      .filter((field) => field !== from)
      .map((field) => {
        const rect = field.getBoundingClientRect();
        return { field, rect, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })
      .filter(({ x, y, rect }) => {
        const sameRowTolerance = Math.max(18, (currentRect.height + rect.height) / 2 + 5);
        return Math.abs(y - currentY) <= sameRowTolerance
          && (key === "ArrowRight" ? x > currentX : x < currentX);
      })
      .sort((a, b) => Math.abs(a.x - currentX) - Math.abs(b.x - currentX));

    for (const { field } of candidates) {
      field.focus();
      if (document.activeElement === field) return true;
    }
    return false;
  }

  function onQuickCreateKeyDown(event: ReactKeyboardEvent<HTMLFieldSetElement>): void {
    if (!historyEnabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const field = target?.closest<HTMLElement>('[data-fnav="1"], [data-qc-arrow="1"]') ?? null;
    if (!field) return;

    if (event.key === "Enter" && field.matches('[data-fnav="1"]')) {
      event.preventDefault();
      advanceQuickCreateField(field);
      return;
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight")
      && canMoveFromTextBoundary(field, event.key)
      && moveQuickCreateFieldHorizontally(field, event.key)) {
      event.preventDefault();
    }
  }

  function resetItemForm() {
    setNameAr(""); setCode(""); setBarcode(""); setSalePrice(0);
    setSalePriceTouched(false);
    setQuantity(1);
    setVatRate(initialVatRate); setVatRateTouched(false);
    setNature("stock"); setUomId(() => getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
    setBrandId(null);
    setSelectedCatalogItemId(null);
    setCatalogSuggestionsOpen(false);
    setCatalogSuggestionIndex(-1);
    setEditingEntryKey(null);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }

  function chooseCatalogItem(item: QuickCreateCatalogItem) {
    const activeLinks = listItemBrands(item.id).filter((link) => link.status === "active");
    setNameAr(item.nameAr);
    setCode(item.code ?? "");
    setBarcode(item.barcode ?? "");
    setSalePrice(item.salePrice);
    setSalePriceTouched(false);
    setVatRate(item.vatRate);
    setVatRateTouched(false);
    setNature(item.nature === "service" ? "service" : "stock");
    setUomId(item.uomId ?? getDefaultUom()?.id ?? uoms[0]?.id ?? 0);
    setBrandId(activeLinks[0]?.brandId ?? null);
    setSelectedCatalogItemId(item.id);
    setEditingEntryKey(null);
    setCatalogSuggestionsOpen(false);
    setCatalogSuggestionIndex(-1);
    setSaveNotice(null);
  }

  useEffect(() => {
    setSavedItems(savedInvoiceItems);
  }, [savedInvoiceItems]);

  useEffect(() => {
    if (previousResetToken.current === resetToken) return;
    previousResetToken.current = resetToken;
    resetItemForm();
    setSaveNotice(null);
    setSavedItems(savedInvoiceItems);
  }, [resetToken]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setSelectedCatalogItemId(null);
    setCatalogSuggestionsOpen(false);
    setCatalogSuggestionIndex(-1);
    setEditingEntryKey(item.entryKey);
    setSaveNotice(item.createdInSession ? null : text("هذا الصنف موجود في الدليل؛ يمكنك تعديل سعره وكميته لهذه الفاتورة دون تغيير بياناته الأساسية.", "This item already exists in the catalog; edit its price or quantity for this invoice without changing its catalog details."));
  }

  async function submit(action: "close" | "add-another" = "close") {
    const payload: QuickCreatePayload = isCustomer
      ? { kind, nameAr, phone, vatNumber }
        : { kind, nameAr, code, barcode, salePrice, salePriceTouched, vatRate, vatRateTouched, nature, uomId, brandId, ...(selectedCatalogItemId != null ? { catalogItemId: selectedCatalogItemId } : {}), ...(includeQuantity ? { quantity } : {}) };
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
    <div className={historyEnabled ? "quick-create-invoice-overlay" : undefined} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 12, background: "#0f172a75", backdropFilter: "blur(3px)" }}>
      <section ref={dialogRef} className={historyEnabled ? "quick-create-invoice-dialog" : undefined} data-quick-create-dialog={historyEnabled ? "1" : undefined} role="dialog" aria-modal="true" aria-labelledby="quick-create-title"
        dir={language === "en" ? "ltr" : "rtl"}
        style={{ width: isCustomer ? "min(100%, 560px)" : "min(1180px, calc(100vw - 24px))", height: historyEnabled ? "min(94dvh, 900px)" : undefined, maxHeight: "min(94dvh, 900px)", display: "flex", flexDirection: "column", borderRadius: 18, overflow: "hidden", background: "#fff", boxShadow: "0 24px 80px #02061755", border: "1px solid #ffffffaa" }}>
        {historyEnabled && <style>{`
          @media(max-width:900px){.quick-create-primary-grid,.quick-create-detail-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
          @media(max-width:560px){.quick-create-primary-grid,.quick-create-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
          .quick-create-invoice-dialog .quick-create-invoice-header{padding:11px 16px!important}
          .quick-create-invoice-dialog .quick-create-invoice-body{padding:10px 14px!important;gap:7px!important;scrollbar-width:thin;scrollbar-gutter:stable;overscroll-behavior:contain}
          .quick-create-invoice-dialog .quick-create-invoice-body::-webkit-scrollbar{width:9px}
          .quick-create-invoice-dialog .quick-create-invoice-body::-webkit-scrollbar-thumb{border-radius:999px;background:#94a3b8;border:2px solid #f8fafc}
          .quick-create-invoice-dialog .quick-create-invoice-summary{gap:5px!important;padding:6px 9px!important}
          .quick-create-invoice-dialog .quick-create-invoice-summary-items{gap:5px!important}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls{gap:6px!important}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-section{padding:7px!important}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-header{gap:7px!important;margin-bottom:5px!important}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-intro{min-width:0}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-intro small{display:none}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-fields{gap:6px!important}
          .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-card{gap:6px!important;padding:7px!important}
          @media(max-height:720px){
            .quick-create-invoice-dialog .quick-create-invoice-header{padding:8px 14px!important}
            .quick-create-invoice-dialog .quick-create-invoice-body{padding:7px 11px!important;gap:5px!important}
            .quick-create-invoice-dialog .quick-create-invoice-summary{gap:4px!important;padding:5px 8px!important}
            .quick-create-invoice-dialog .zsales-invoice-quick-controls{gap:4px!important}
            .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-section{padding:5px!important}
            .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-header{margin-bottom:3px!important}
            .quick-create-invoice-dialog .zsales-invoice-quick-controls .zsales-payment-card{gap:4px!important;padding:5px!important}
          }
        `}</style>}
        <div className={historyEnabled ? "quick-create-invoice-header" : undefined} style={{ padding: "18px 20px", color: "#fff", background: `linear-gradient(120deg, ${accent}, ${isCustomer ? "#06b6d4" : "#a855f7"})` }}>
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
        <fieldset disabled={busy} onKeyDown={onQuickCreateKeyDown} className={historyEnabled ? "quick-create-invoice-body" : undefined} style={{ padding: 20, display: "grid", gap: 12, overflowY: "auto", overscrollBehavior: "contain", scrollbarWidth: "thin", flex: historyEnabled ? "1 1 0%" : undefined, minHeight: 0, minWidth: 0, margin: 0, border: 0 }}>
          {historyEnabled && (
            <section className="quick-create-invoice-summary" aria-label={text("الأصناف المضافة سريعًا", "Quick-added items")} data-testid="quick-create-saved-items-summary"
              style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid #ddd6fe", borderInlineStart: "4px solid #7c3aed", borderRadius: 12, background: "linear-gradient(120deg,#faf5ff,#fff)", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 12 }}>
                <strong style={{ color: "#5b21b6" }}>{text("بنود الفاتورة الحالية", "Current invoice lines")}</strong>
                <span style={{ padding: "3px 8px", borderRadius: 999, background: "#ede9fe", color: "#5b21b6", fontWeight: 800 }}>
                  {savedItems.length} {text("بند", "lines")}
                </span>
                <span data-testid="quick-create-invoice-item-count" style={{ color: "#475569" }}>{text("إجمالي أصناف الفاتورة", "Invoice item lines")}: <b>{documentItemCount}</b></span>
                <span style={{ color: "#475569" }}>{text("الكمية", "Quantity")}: <b>{formatNumber(totalSavedQuantity)}</b></span>
                <span data-testid="quick-create-saved-item-value" style={{ marginInlineStart: "auto", color: "#334155" }}>{text("قيمة الأصناف قبل الضريبة", "Item value before tax")}: <b style={{ fontSize: 18, lineHeight: 1.1, fontWeight: 900, color: "#0f172a", whiteSpace: "nowrap" }}>{formatNumber(totalSavedValue)}</b></span>
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
                <div className="quick-create-invoice-summary-items" style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2, scrollbarWidth: "thin" }}>
                  {savedItems.map((item) => (
                    <button key={item.entryKey} type="button" data-testid={`quick-created-item-${item.entryKey}`}
                      onClick={() => openSavedItem(item)}
                      aria-pressed={editingEntryKey === item.entryKey}
                      title={text("اضغط للعودة إلى الصنف وتعديله", "Select to edit this saved item")}
                      style={{ flex: "0 0 auto", minWidth: 150, maxWidth: 250, display: "grid", gap: 3, textAlign: "start", padding: "7px 10px", borderRadius: 9, border: `1px solid ${editingEntryKey === item.entryKey ? "#7c3aed" : "#e2e8f0"}`, background: editingEntryKey === item.entryKey ? "#f3e8ff" : "#fff", color: "#1e293b", cursor: "pointer", boxShadow: editingEntryKey === item.entryKey ? "0 0 0 2px #7c3aed22" : "0 1px 3px #0f172a0a" }}>
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{item.nameAr}</strong>
                      {item.brandId != null && (
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#7c3aed", fontSize: 10, fontWeight: 700 }}>
                          🏷 {brands.find((brand) => brand.id === item.brandId)?.[language === "en" ? "nameEn" : "nameAr"] || brands.find((brand) => brand.id === item.brandId)?.nameAr || `#${item.brandId}`}
                        </span>
                      )}
                      <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>{formatNumber(item.quantity)} × {formatNumber(item.salePrice)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <div style={{ display: "grid", gap: 5, minWidth: 0, position: "relative", gridColumn: isCustomer ? undefined : "1 / -1" }}>
            <label htmlFor={nameInputId} style={{ fontSize: 12, color: "#475569", fontWeight: 700 }}>
              {editingEntry ? text("تعديل الصنف المضاف *", "Edit saved item *") : text("الاسم بالعربية *", "Arabic name *")}
            </label>
            <div style={{ position: "relative", minWidth: 0 }}>
              <input id={nameInputId} ref={nameInputRef} autoFocus value={nameAr} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined}
                role={historyEnabled ? "combobox" : undefined}
                aria-autocomplete={historyEnabled ? "list" : undefined}
                aria-expanded={historyEnabled ? showCatalogSuggestions : undefined}
                aria-controls={historyEnabled ? "quick-create-catalog-suggestions" : undefined}
                aria-activedescendant={showCatalogSuggestions && catalogSuggestionIndex >= 0 ? `quick-create-catalog-option-${catalogSuggestions[catalogSuggestionIndex]?.id}` : undefined}
                onFocus={() => { if (historyEnabled && !selectedCatalogItemId && nameAr.trim()) setCatalogSuggestionsOpen(true); }}
                onBlur={() => setCatalogSuggestionsOpen(false)}
                onChange={(e) => {
                  setNameAr(e.target.value);
                  setSelectedCatalogItemId(null);
                  setCatalogSuggestionIndex(-1);
                  setCatalogSuggestionsOpen(true);
                }}
                onKeyDown={(e) => {
                  if (historyEnabled && e.key === "ArrowDown" && catalogSuggestions.length) {
                    e.preventDefault();
                    setCatalogSuggestionsOpen(true);
                    setCatalogSuggestionIndex((index) => Math.min(index + 1, catalogSuggestions.length - 1));
                    return;
                  }
                  if (historyEnabled && e.key === "ArrowUp" && catalogSuggestions.length) {
                    e.preventDefault();
                    setCatalogSuggestionIndex((index) => Math.max(index - 1, 0));
                    return;
                  }
                  if (historyEnabled && e.key === "Escape" && showCatalogSuggestions) {
                    e.preventDefault();
                    setCatalogSuggestionsOpen(false);
                    setCatalogSuggestionIndex(-1);
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (showCatalogSuggestions && catalogSuggestionIndex >= 0) {
                      chooseCatalogItem(catalogSuggestions[catalogSuggestionIndex]);
                      const current = e.currentTarget;
                      requestAnimationFrame(() => advanceQuickCreateField(current));
                    } else {
                      advanceQuickCreateField(e.currentTarget);
                    }
                  }
                }}
                placeholder={isCustomer ? text("مثال: أحمد محمد", "Example: Ahmed Mohamed") : text("مثال: مياه معدنية", "Example: Mineral water")}
                style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
              {showCatalogSuggestions && (
                <div id="quick-create-catalog-suggestions" role="listbox" aria-label={text("الأصناف الموجودة", "Existing catalog items")}
                  style={{ position: "absolute", zIndex: 30, insetInline: 0, top: "calc(100% + 3px)", maxHeight: 230, overflowY: "auto", padding: 5, border: "1px solid #cbd5e1", borderRadius: 10, background: "#fff", boxShadow: "0 12px 28px #0f172a25" }}>
                  {catalogSuggestions.map((item, index) => {
                    const brandCount = listItemBrands(item.id).filter((link) => link.status === "active").length;
                    return (
                      <button key={item.id} id={`quick-create-catalog-option-${item.id}`} type="button" role="option"
                        aria-selected={catalogSuggestionIndex === index}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setCatalogSuggestionIndex(index)}
                        onClick={() => chooseCatalogItem(item)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: 0, borderRadius: 7, textAlign: "start", background: catalogSuggestionIndex === index ? "#f3e8ff" : "#fff", color: "#1e293b", cursor: "pointer" }}>
                        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{item.nameAr}</strong>
                          <small style={{ color: "#64748b", fontSize: 11 }}>
                            {[item.code || item.barcode, brandCount > 1 ? text(`${brandCount} علامات تجارية`, `${brandCount} brands`) : null].filter(Boolean).join(" · ") || text("صنف موجود في الدليل", "Existing catalog item")}
                          </small>
                        </span>
                        <strong style={{ color: "#5b21b6", whiteSpace: "nowrap", fontSize: 12 }}>{invoiceCurrency} {formatNumber(item.salePrice)}</strong>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
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
              <div className={historyEnabled ? "quick-create-primary-grid" : undefined} style={{ display: "grid", gridTemplateColumns: historyEnabled ? "repeat(5, minmax(0, 1fr))" : "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                {includeQuantity && (
              <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                    {text("الكمية المضافة للمستند", "Quantity to add")}
                    <input type="number" min="0.001" step="0.001" value={quantity} data-fnav={historyEnabled ? "1" : undefined}
                      onChange={(e) => setQuantity(Number(e.target.value) || 0)} style={fieldStyle} />
                  </label>
                )}
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("سعر البيع", "Sale price")}
                  <input type="number" min="0" step="0.01" value={salePrice} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => { setSalePrice(Number(e.target.value) || 0); setSalePriceTouched(true); }} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الضريبة %", "Tax %")}
                  <input type="number" min="0" max="100" step="0.01" value={vatRate} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => { setVatRate(Number(e.target.value) || 0); setVatRateTouched(true); }} style={fieldStyle} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الكود (اختياري)", "Code (optional)")}
                  <input value={code} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => setCode(e.target.value)} dir="ltr" style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
                </label>
                <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("الباركود (اختياري)", "Barcode (optional)")}
                  <input value={barcode} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => setBarcode(e.target.value)} dir="ltr" style={{ ...fieldStyle, opacity: catalogLocked ? 0.75 : 1 }} />
                </label>
              </div>
              <div className={historyEnabled ? "quick-create-detail-grid" : undefined} style={{ display: "grid", gridTemplateColumns: historyEnabled ? "repeat(5, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: 10, alignItems: "start" }}>
                <label style={{ display: "grid", gap: 5, minWidth: 0, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("وحدة القياس *", "Unit of measure *")}
                  <select value={uomId || ""} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => setUomId(Number(e.target.value) || 0)} style={{ ...fieldStyle, minWidth: 0, opacity: catalogLocked ? 0.75 : 1 }}>
                    <option value="">{text("اختر وحدة القياس", "Choose a unit")}</option>
                    {uoms.map((unit) => <option key={unit.id} value={unit.id}>
                      {language === "en" ? unit.nameEn || unit.nameAr : unit.nameAr}{unit.shortCode ? ` (${unit.shortCode})` : ""}
                    </option>)}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 5, minWidth: 0, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("نوع الصنف", "Item type")}
                  <select value={nature} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => setNature(e.target.value as "stock" | "service")} style={{ ...fieldStyle, minWidth: 0, opacity: catalogLocked ? 0.75 : 1 }}>
                    <option value="stock">{text("صنف مخزني", "Stock item")}</option>
                    <option value="service">{text("خدمة", "Service")}</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 5, minWidth: 0, fontSize: 12, color: "#475569", fontWeight: 700 }}>
                  {text("العلامة التجارية (اختياري)", "Brand (optional)")}
                  <select value={brandId ?? ""} disabled={catalogLocked} data-fnav={historyEnabled ? "1" : undefined} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)} style={{ ...fieldStyle, minWidth: 0, opacity: catalogLocked ? 0.75 : 1 }}>
                    <option value="">{text("بدون علامة تجارية", "No brand")}</option>
                    {brands.map((brand) => <option key={brand.id} value={brand.id}>{language === "en" ? brand.nameEn || brand.nameAr : brand.nameAr}</option>)}
                  </select>
                  <span style={{ fontWeight: 400, color: "#718096" }}>{text("يُحفظ الربط على هذا الجهاز فقط.", "This link is stored on this device only.")}</span>
                </label>
              </div>
            </>
          )}
          {!isCustomer && invoiceControls}
          {onSaveInvoice && hasUnappliedItem && <div role="status" style={{ padding: "8px 10px", borderRadius: 9, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12 }}>
            {text("احفظ الصنف الحالي في الفاتورة أو امسح بياناته قبل حفظ الفاتورة.", "Save the current item to the invoice or clear its form before saving the invoice.")}
          </div>}
          {saveNotice && <div role="status" aria-live="polite" style={{ padding: "9px 11px", borderRadius: 9, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: 13 }}>{saveNotice}</div>}
          {error && <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", fontSize: 13 }}>{error}</div>}
        </fieldset>
        <div style={{ display: "flex", justifyContent: historyEnabled ? "space-between" : "flex-end", alignItems: "center", gap: 10, marginTop: 4, padding: "12px 20px", borderTop: "1px solid #e7edf1", background: "#fbfcfd", flexWrap: "wrap", flexShrink: 0 }}>
          {historyEnabled && (
            <div data-testid="quick-create-invoice-grand-total" aria-label={text("إجمالي الفاتورة", "Invoice total")}
              style={{ display: "grid", gap: 2, padding: "6px 12px", border: "1px solid #a7f3d0", borderRadius: 10, background: "linear-gradient(120deg,#ecfdf5,#f0fdfa)", color: "#065f46", minWidth: 170, flex: "0 0 auto" }}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>{text("إجمالي الفاتورة", "Invoice total")}</span>
              <strong style={{ fontSize: 20, lineHeight: 1.2 }}>{invoiceCurrency} {invoiceTotal ?? "0.00"}</strong>
            </div>
          )}
          <div data-testid="quick-create-invoice-actions" style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8, flexWrap: "wrap", minWidth: 0, flex: historyEnabled ? "1 1 auto" : undefined }}>
            <button type="button" onClick={onCancel} disabled={busy} style={{ ...btnSecondary, borderRadius: 9, padding: "9px 14px" }}>{text("إلغاء", "Cancel")}</button>
            {!isCustomer && onSaveInvoice && <button type="button" onClick={() => void onSaveInvoice()} disabled={busy || invoiceSaving || !canSaveInvoice || hasUnappliedItem}
              data-testid="button-quick-create-save-invoice"
              style={{ ...btnPrimary, borderRadius: 9, padding: "9px 16px", background: "#0f8a61", opacity: busy || invoiceSaving || !canSaveInvoice || hasUnappliedItem ? 0.58 : 1 }}>
              {invoiceSaving ? text("جارٍ حفظ الفاتورة…", "Saving invoice…") : text("حفظ الفاتورة", "Save invoice")}
            </button>}
            {!isCustomer && <button type="button" onClick={() => void submit("add-another")} disabled={busy || !nameAr.trim() || !uomId}
              style={{ ...btnSecondary, borderRadius: 9, padding: "9px 16px", color: accent, borderColor: `${accent}55`, opacity: busy || !nameAr.trim() || !uomId ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : editingEntry ? text("حفظ التعديل وإضافة آخر", "Save changes and add another") : text("حفظ وإضافة آخر", "Save and add another")}
            </button>}
            <button type="button" onClick={() => void submit("close")} disabled={busy || !nameAr.trim() || (!isCustomer && !uomId)}
              style={{ ...btnPrimary, borderRadius: 9, padding: "9px 16px", background: accent, opacity: busy || !nameAr.trim() || (!isCustomer && !uomId) ? 0.6 : 1 }}>
              {busy ? text("جارٍ الحفظ…", "Saving…") : isCustomer ? text("حفظ وإضافة للفاتورة", "Save and add customer") : editingEntry ? text("حفظ التعديل وإغلاق", "Save changes and close") : text("حفظ وإغلاق", "Save and close")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
