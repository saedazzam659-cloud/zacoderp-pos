// Purchase Order form — operational, finance-FREE.
//
// LAYOUT: pixel-mirror of PurchaseInvoiceForm so that purchase orders share
// the same width (max-w-6xl), card structure, field sizing (h-9 text-sm),
// header band (icon tile + title + subtitle), header-data grid, lines grid,
// totals box (w-72), and bottom action bar. The ONLY structural differences
// from the invoice form are:
//   1. Header has a status badge + (when converted) a clickable INV-N chip
//   2. Bottom action bar shows Confirm / Cancel / Convert buttons
//      contextually before the Save button (no Post button at all)
//   3. The header grid has an "expectedDeliveryDate" field instead of LC
//   4. The lines grid drops the weight / expenses / finalCost columns
//   5. The totals box drops the LC-expenses row
// All of those are required by the spec — purchase orders carry zero finance
// state. Saving here only writes rows in `purchase_orders` /
// `purchase_order_lines`; never a journal entry, stock movement, voucher,
// or supplier balance update. Converting still produces a *draft* invoice
// that the user must post separately.
import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { validateInvoiceLines } from "@/lib/lineValidation";
import { useRoute, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { useScreenItemModes, annotateItemCombo } from "@/lib/itemUsageClient";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useToast } from "@/hooks/use-toast";
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useCompanyTaxes } from "@/hooks/useCompanyTaxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { DiscountRow } from "@/components/DiscountRow";
import { currencySymbol } from "@/lib/format";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  ArrowRight, ArrowLeft, ClipboardList, Plus, Trash2, FileText, ListOrdered,
  Wallet, CreditCard, CheckCircle, XCircle, FileCheck2, RotateCcw,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import PurchaseOrderDetails from "./PurchaseOrderDetails";
import {
  catalogUnitsWithHistoricalSelection,
  isActiveItemUnit,
  itemUnitsWithHistoricalSelection,
  serializeDocumentLine,
} from "@/lib/documentLineUnits";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface OrderLine {
  _id: string;
  /** Persisted database line id; absent on newly added/duplicated lines. */
  id?: number;
  itemId: string;
  itemName: string;
  itemCode: string;
  unitId: string;
  unit: string;
  conversionFactor: string;
  warehouseId: string;
  qty: string;
  freeQty: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  lineTotal: string;
  notes: string;
}

function newLine(): OrderLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", freeQty: "0", unitPrice: "0", discount: "0", vatRate: "15",
    lineTotal: "0", notes: "",
  };
}

function calcLine(l: OrderLine, priceIncludesVat = false) {
  const qty = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const disc = Number(l.discount) || 0;
  const rate = (Number(l.vatRate) || 0) / 100;
  const gross = qty * price * (1 - disc / 100);
  if (priceIncludesVat) {
    const net = rate > -1 ? gross / (1 + rate) : gross;
    return { lineTotal: gross, subtotal: net };
  }
  const vat = gross * rate;
  return { lineTotal: gross + vat, subtotal: gross };
}

export default function PurchaseOrderForm() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`purchasingPages.purchaseOrderForm.${k}`, opts) as string;
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const itemNameOf = (i: any) => isRtl ? (i?.nameAr ?? i?.nameEn ?? "") : (i?.nameEn ?? i?.nameAr ?? "");
  const branchName = (b: any) => isRtl ? (b?.nameAr ?? b?.nameEn ?? `#${b?.id}`) : (b?.nameEn ?? b?.nameAr ?? `#${b?.id}`);
  const unitNameOf = (u: any) => isRtl ? (u?.nameAr ?? u?.nameEn ?? "") : (u?.nameEn ?? u?.nameAr ?? "");
  const warehouseName = (w: any) => isRtl ? (w?.nameAr ?? w?.nameEn ?? "") : (w?.nameEn ?? w?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const usageModes = useScreenItemModes("purchase_orders");
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [matchNew]  = useRoute("/purchasing/orders/new");
  const [matchEdit, params] = useRoute("/purchasing/orders/:id");
  const isNew  = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;

  // ── SAP-style tabbed shell (per-company, default ON) ───────────────────
  // Double-clicking a row in the list opens the order with `?view=1`, which
  // forces the read-only tabbed shell with the interactive التفاصيل tab even
  // for companies that opted into the classic single-page layout.
  const search = useSearch();
  const viewMode = new URLSearchParams(search).get("view") === "1";
  const [activeTab, setActiveTab] = useState<"basic" | "items" | "details">("basic");
  useEffect(() => { if (viewMode) setActiveTab("details"); }, [viewMode]);
  const _co = (user as any)?.company;
  const useTabbedLayout = _co?.invoiceFormLayout !== "classic" || viewMode;
  // Company-wide UX flag (الإعدادات العامة): hide the quick add-item bar and
  // let the items grid grow ~2 rows taller in its place.
  const hideQuickAdd = !!_co?.hideQuickAddBar;

  const [docNumber,    setDocNumber]    = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [orderDate,    setOrderDate]    = useState(today());
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [supplierId,   setSupplierId]   = useState("");
  const [branchId,     setBranchId]     = useState("");

  // Peek the NEXT number for the SAME branch the form will submit (per-branch
  // counters) — omitting branchId reads the empty branch-0 sentinel and the
  // badge freezes at the start number while saves advance the real counter.
  const seqPeek = useNextSequenceNumber("purchase_order", isNew, undefined, branchId);
  const [paymentType,  setPaymentType]  = useState("credit");
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [notes,        setNotes]        = useState("");
  const [docDiscount,  setDocDiscount]  = useState("0");
  // Sticky toggle — see SalesDocumentForm for behavior contract.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [priceIncludesVat, setPriceIncludesVat] = useState(stickyPriceIncl.initial);
  const [orderStatus,  setOrderStatus]  = useState<string>("draft");
  const [convertedInvoiceId, setConvertedInvoiceId] = useState<number | null>(null);
  const [lines,        setLines]        = useState<OrderLine[]>([newLine()]);
  const [focusLineId, setFocusLineId] = useState<string>(() => "");
  useEffect(() => {
    if (lines.length > 0 && !lines.some(l => l._id === focusLineId)) {
      setFocusLineId(lines[0]._id);
    }
  }, [lines, focusLineId]);
  const addLine = () => {
    const l = newLine();
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  // ── "إضافة صنف" quick-add bar state (tabbed items tab) ────────────────
  // Same design as SalesDocumentForm: pick item → warehouse/unit → qty/free/
  // price/discount → commit. Discount is PERCENT-only (order lines have no
  // fixed-amount discount field — no calc-path change).
  const [qaItemId, setQaItemId]           = useState("");
  const [qaWarehouseId, setQaWarehouseId] = useState("");
  const [qaUnitId, setQaUnitId]           = useState("");
  const [qaQty, setQaQty]                 = useState("1");
  const [qaFreeQty, setQaFreeQty]         = useState("0");
  const [qaPrice, setQaPrice]             = useState("");
  const [qaDiscount, setQaDiscount]       = useState("0");
  const quickAddRef = useRef<HTMLDivElement>(null);
  const focusQuickAddStart = () => {
    quickAddRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  };
  const { containerRef, onKeyDown } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, authH),
    enabled: !!user,
  });

  // Smart document navigator — list of all purchase orders for the
  // current company. Cache key matches the list page so opening the
  // navigator is instant once the user has visited the list.
  const { data: allPurchaseOrders = [] } = useQuery<any[]>({
    queryKey: ["purchase-orders", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/purchasing/purchase-orders?companyId=${cid}` : `${API}/api/purchasing/purchase-orders`, authH),
    enabled: !!user,
  });

  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`, authH),
    enabled: !!user,
  });

  const { data: exchangeRates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/currencies/rates?companyId=${cid}` : `${API}/api/currencies/rates`, authH),
    enabled: !!user,
  });

  const { data: inventoryItems = [] } = useQuery<any[]>({
    queryKey: ["inventory-items", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/items?companyId=${cid}&includeHidden=1` : `${API}/api/inventory/items?includeHidden=1`, authH),
    enabled: !!user,
  });

  const { data: units = [] } = useQuery<any[]>({
    queryKey: ["units", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/units?companyId=${cid}` : `${API}/api/inventory/units`, authH),
    enabled: !!user,
  });

  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ["warehouses", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/warehouses?companyId=${cid}` : `${API}/api/inventory/warehouses`, authH),
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`, authH),
    enabled: !!user,
  });
  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  useEffect(() => {
    if (!isNew || !defaultBranch || branchId) return;
    setBranchId(String(defaultBranch.id));
  }, [isNew, defaultBranch?.id]);

  const defaultWarehouse = (warehouses as any[]).find((w: any) => w.isDefault) ?? (warehouses as any[])[0];
  // Header-level warehouse picker — broadcast to every line on change.
  const [headerWarehouseId, setHeaderWarehouseId] = useState<string>("");
  useEffect(() => {
    if (!isNew || !defaultWarehouse || headerWarehouseId) return;
    setHeaderWarehouseId(String(defaultWarehouse.id));
  }, [isNew, defaultWarehouse?.id]);
  useEffect(() => {
    if (isNew || headerWarehouseId) return;
    const firstWh = lines.find(l => l.warehouseId)?.warehouseId;
    if (firstWh) setHeaderWarehouseId(String(firstWh));
  }, [isNew, lines, headerWarehouseId]);
  const hasEmptyWarehouse = lines.some(l => !l.warehouseId);
  useEffect(() => {
    if (!headerWarehouseId || !hasEmptyWarehouse) return;
    setLines(prev => prev.map(l => l.warehouseId ? l : { ...l, warehouseId: headerWarehouseId }));
  }, [headerWarehouseId, hasEmptyWarehouse]);
  function applyHeaderWarehouse(v: string) {
    setHeaderWarehouseId(v);
    if (!v) return;
    setLines(prev => prev.map(l => ({ ...l, warehouseId: v })));
  }
  // Header-level tax picker — dynamic tax catalog (الضرائب). Selecting a
  // percent tax broadcasts its rate to every line's editable vatRate. The
  // chosen taxId is persisted on the document header. ZATCA SAFETY: this
  // only pre-fills the editable rate before issue; it never touches the
  // stored vat_rate/vat_amount/tax_category that ZATCA XML/QR read.
  const { taxes: taxCatalog, defaultPercentTax: defaultTax, comboItemsPercent: taxComboItems, percentRateOf } = useCompanyTaxes();
  const [headerTaxId, setHeaderTaxId] = useState<string>("");
  useEffect(() => {
    if (!isNew || !defaultTax || headerTaxId) return;
    applyHeaderTax(String(defaultTax.id));
  }, [isNew, defaultTax?.id]);
  function applyHeaderTax(v: string) {
    setHeaderTaxId(v);
    const rate = percentRateOf(v);
    if (rate === null) return; // fixed/none → leave line rates untouched
    setLines(prev => prev.map(l => {
      const updated = { ...l, vatRate: String(rate) };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }
  // Route-transition safeguard — clear header on doc-id change so init/derive
  // effects re-populate from the freshly loaded doc.
  useEffect(() => {
    setHeaderWarehouseId("");
    setHeaderTaxId("");
  }, [editId, isNew]);

  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!currencies.length) return "1";
    const selected = currencies.find((c: any) => c.code === selectedCode);
    const base = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id)
      )
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }

  async function handleCurrencyChange(code: string) {
    setCurrencyCode(code);
    setExchangeRate(getLatestRate(code));
    await repriceAllLinesForCurrency(code);
  }

  useEffect(() => {
    if (!isNew || !defaultCurrency || currencyCode) return;
    setCurrencyCode(defaultCurrency.code);
  }, [isNew, defaultCurrency?.code]);

  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["purchase-order", editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/purchasing/purchase-orders/${editId}?companyId=${cid}`, { headers: authH });
      return r.json();
    },
    enabled: !!editId,
  });

  useEffect(() => {
    if (!isNew) return;
    if (seqPeek.hasSequence && seqPeek.number) setDocNumber(seqPeek.number);
  }, [isNew, seqPeek.hasSequence, seqPeek.number]);

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber ?? "");
    setSupplierInvoiceNumber(existing.supplierInvoiceNumber ?? "");
    setOrderDate(existing.orderDate ?? today());
    setExpectedDeliveryDate(existing.expectedDeliveryDate ?? "");
    setSupplierId(existing.supplierId ? String(existing.supplierId) : "");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    setPaymentType(existing.paymentType ?? "credit");
    setCurrencyCode(existing.currencyCode ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setNotes(existing.notes ?? "");
    setDocDiscount(String(existing.discountAmount ?? "0"));
    setPriceIncludesVat(!!existing.priceIncludesVat);
    setOrderStatus(existing.status ?? "draft");
    setConvertedInvoiceId(existing.convertedInvoiceId ?? null);
    setHeaderTaxId((existing as any).taxId != null ? String((existing as any).taxId) : "");
    setLines(existing.lines?.length ? existing.lines.map((l: any) => ({
      freeQty:     String(l.freeQty ?? "0"),
      _id: crypto.randomUUID(),
      id: Number.isInteger(Number(l.id)) ? Number(l.id) : undefined,
      itemId:      l.itemId      ? String(l.itemId)      : "",
      itemName:    l.itemName    ?? "",
      itemCode:    l.itemCode    ?? "",
      unitId:      l.unitId      ? String(l.unitId)      : "",
      unit:        l.unit        ?? "",
      conversionFactor: String(l.conversionFactor ?? "1"),
      warehouseId: l.warehouseId ? String(l.warehouseId) : "",
      qty:         String(l.qty),
      unitPrice:   String(l.unitPrice),
      discount:    String(l.discount ?? "0"),
      vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      notes:       l.notes ?? "",
    })) : (useTabbedLayout ? [] : [newLine()]));
    void Promise.all(
      (existing.lines ?? [])
        .map((l: any) => l.itemId ? String(l.itemId) : "")
        .filter(Boolean)
        .filter((id: string, i: number, ids: string[]) => ids.indexOf(id) === i)
        .map((id: string) => fetchItemUnits(id)),
    );
  }, [existing]);

  // ── Duplicate from another purchase order (?from=<id> on /new) ──
  const duplicatedRef = useRef(false);
  useEffect(() => {
    if (!isNew || duplicatedRef.current || !cid) return;
    const sp = new URLSearchParams(window.location.search);
    const fromId = sp.get("from");
    if (!fromId) return;
    duplicatedRef.current = true;
    (async () => {
      try {
        const r = await fetch(`${API}/api/purchasing/purchase-orders/${fromId}?companyId=${cid}`, { headers: authH });
        if (!r.ok) return;
        const src = await r.json();
        // Keep freshly-issued sequence number, today's date, blank delivery
        // date, blank supplier-invoice-number, draft status — only copy
        // header content + lines.
        setSupplierId(src.supplierId ? String(src.supplierId) : "");
        setBranchId(src.branchId ? String(src.branchId) : "");
        setPaymentType(src.paymentType ?? "credit");
        setCurrencyCode(src.currencyCode ?? "SAR");
        setExchangeRate(String(src.exchangeRate ?? "1"));
        setNotes(src.notes ?? "");
        setDocDiscount(String(src.discountAmount ?? "0"));
        setPriceIncludesVat(!!src.priceIncludesVat);
        setLines(src.lines?.length ? src.lines.map((l: any) => ({
          freeQty:     String(l.freeQty ?? "0"),
          _id: crypto.randomUUID(),
          itemId:      l.itemId      ? String(l.itemId)      : "",
          itemName:    l.itemName    ?? "",
          itemCode:    l.itemCode    ?? "",
          unitId:      l.unitId      ? String(l.unitId)      : "",
          unit:        l.unit        ?? "",
          conversionFactor: String(l.conversionFactor ?? "1"),
          warehouseId: l.warehouseId ? String(l.warehouseId) : "",
          qty:         String(l.qty),
          unitPrice:   String(l.unitPrice),
          discount:    String(l.discount ?? "0"),
          vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal),
          notes:       l.notes ?? "",
        })) : (useTabbedLayout ? [] : [newLine()]));
        toast({ title: tr("duplicatedFromSource", { defaultValue: "تم إنشاء نسخة مماثلة" }) });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, cid]);

  // Per-item unit list (for the unit picker on each line). Mirrors the
  // invoice form so unit & cost auto-populate from the selected item
  // without an extra round-trip per keystroke.
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    try {
      const r = await fetch(`${API}/api/inventory/items/${itemId}/units${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
      const list = r.ok ? await r.json() : [];
      setItemUnitsMap(prev => ({ ...prev, [itemId]: list }));
      return list;
    } catch { return []; }
  }

  // Pre-fetch units for the quick-add bar's chosen item so its unit picker is
  // populated BEFORE commit, and default the picker to the item's base unit.
  useEffect(() => {
    if (!qaItemId) { setQaUnitId(""); return; }
    let cancelled = false;
    (async () => {
      const us = await fetchItemUnits(qaItemId);
      if (cancelled) return;
      const base = us.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? us.find(isActiveItemUnit);
      setQaUnitId(base?.unitId != null ? String(base.unitId) : "");
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaItemId]);

  function updateLine(lineId: string, field: keyof OrderLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const next = { ...l, [field]: value };
      const { lineTotal } = calcLine(next, priceIncludesVat);
      return { ...next, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  // Recalc all line totals when the doc-level "price includes VAT" flag flips
  // so the user sees consistent line totals immediately.
  useEffect(() => {
    setLines(prev => prev.map(l => {
      const { lineTotal } = calcLine(l, priceIncludesVat);
      return { ...l, lineTotal: lineTotal.toFixed(2) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceIncludesVat]);

  // Per-currency cost cache: itemId → [{ currencyCode, costPrice, ... }]
  const [itemCurrencyPricesMap, setItemCurrencyPricesMap] = useState<Record<string, any[]>>({});
  async function fetchItemCurrencyPrices(itemId: string): Promise<any[]> {
    if (itemCurrencyPricesMap[itemId]) return itemCurrencyPricesMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/currency-prices?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemCurrencyPricesMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }
  function pickCurrencyCost(rows: any[], code: string): string | null {
    const m = rows.find((p: any) => p.currencyCode === code);
    if (!m || m.costPrice == null || m.costPrice === "") return null;
    return String(m.costPrice);
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) { updateLine(lineId, "itemId", ""); return; }
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? itemUnits.find(isActiveItemUnit);
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    let chosenPrice: string = String(base?.costPrice ?? item.costPrice ?? "0");
    if (currencyCode && defaultCurrency && currencyCode !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const m = pickCurrencyCost(cps, currencyCode);
      if (m != null) chosenPrice = m;
    }
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const updated: OrderLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemNameOf(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitNameOf(base?.unit) || unitNameOf(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: trimTrailingZeros(chosenPrice),
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  const repriceVersion = useRef(0);
  async function repriceAllLinesForCurrency(code: string) {
    if (!defaultCurrency) return;
    const myVersion = ++repriceVersion.current;
    const isDefault = code === defaultCurrency.code;
    const updates: Record<string, string> = {};
    for (const l of lines) {
      if (!l.itemId) continue;
      let np: string | null = null;
      if (isDefault) {
        const itemUnits = await fetchItemUnits(l.itemId);
        const row = itemUnits.find((u: any) => String(u.unitId) === l.unitId)
          ?? itemUnits.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? itemUnits.find(isActiveItemUnit);
        const item = inventoryItems.find((i: any) => String(i.id) === l.itemId);
        const v = row?.costPrice ?? item?.costPrice;
        if (v != null) np = String(v);
      } else {
        const cps = await fetchItemCurrencyPrices(l.itemId);
        const m = pickCurrencyCost(cps, code);
        if (m != null) np = m;
      }
      if (np != null) updates[l._id] = trimTrailingZeros(np);
    }
    if (myVersion !== repriceVersion.current) return;
    if (!Object.keys(updates).length) return;
    setLines(prev => prev.map(l => {
      const np = updates[l._id];
      if (np == null) return l;
      const updated: OrderLine = { ...l, unitPrice: np };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  function changeLineUnit(lineId: string, newUnitId: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const itemUnits = itemUnitsMap[l.itemId] ?? [];
      const row = itemUnits.find((u: any) => String(u.unitId) === newUnitId);
      const globalUnit = units.find((u: any) => String(u.id) === newUnitId);
      const updated: OrderLine = {
        ...l,
        unitId: newUnitId,
        unit: unitNameOf(row?.unit) || unitNameOf(globalUnit) || "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.costPrice != null ? trimTrailingZeros(row.costPrice) : l.unitPrice,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  // Commit the "إضافة صنف" bar into a new grid line. Appends an empty line,
  // runs the SAME selectItem auto-fill (catalog cost, base unit, VAT), then
  // applies the bar's overrides through updateLine (which recomputes
  // lineTotal per field). Zero duplicated pricing logic.
  async function handleQuickAdd() {
    if (!qaItemId) return;
    const l = newLine();
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    if (qaWarehouseId) l.warehouseId = qaWarehouseId;
    else if (headerWarehouseId) l.warehouseId = headerWarehouseId;
    setLines(p => [...p, l]);
    await selectItem(l._id, qaItemId);
    if (qaUnitId) changeLineUnit(l._id, qaUnitId);
    updateLine(l._id, "qty", qaQty || "1");
    if (qaFreeQty && qaFreeQty !== "0") updateLine(l._id, "freeQty", qaFreeQty);
    if (qaPrice.trim() !== "" && qaPrice !== "0") updateLine(l._id, "unitPrice", qaPrice);
    if (qaDiscount && qaDiscount !== "0") updateLine(l._id, "discount", qaDiscount);
    setFocusLineId(l._id);
    setQaItemId(""); setQaQty("1"); setQaFreeQty("0"); setQaPrice(""); setQaDiscount("0");
  }

  const subtotal       = lines.reduce((s, l) => { const { subtotal } = calcLine(l, priceIncludesVat); return s + subtotal; }, 0);
  const vatAmount      = lines.reduce((s, l) => { const { lineTotal, subtotal } = calcLine(l, priceIncludesVat); return s + (lineTotal - subtotal); }, 0);
  const lineDiscountTotal = lines.reduce((s, l) => {
    const noDisc = calcLine({ ...l, discount: "0" }, priceIncludesVat).lineTotal;
    const withDisc = calcLine(l, priceIncludesVat).lineTotal;
    return s + Math.max(0, noDisc - withDisc);
  }, 0);
  const grossTotal     = subtotal + vatAmount;
  const docDiscountAmt = Math.max(0, Math.min(grossTotal, Number(docDiscount) || 0));
  const totalAmount    = grossTotal - docDiscountAmt;

  const isLocked = orderStatus === "converted" || orderStatus === "cancelled";

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/purchasing/purchase-orders/${editId}` : `${API}/api/purchasing/purchase-orders`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: (j: any) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      toast({ title: isNew ? tr("createdDraft") : tr("savedDraft") });
      if (isNew && j?.id) navigate(`/purchasing/orders/${j.id}`);
      else navigate("/purchasing/orders");
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const statusMut = useMutation({
    mutationFn: async (next: string) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${editId}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status: next }),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: (j: any) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", editId] });
      setOrderStatus(j.status);
      toast({ title: tr("statusUpdated") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${editId}/convert`, { method: "POST", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: (j: any) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: tr("convertedToInvoice"), description: `INV-${j.invoiceId}` });
      navigate(`/purchasing/invoices/${j.invoiceId}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function handleSave() {
    if (isLocked) return;
    // Per-line gate: item name + unit + qty + price required on every row.
    const lineCheck = validateInvoiceLines(lines);
    if (!lineCheck.ok) {
      toast({ title: lineCheck.title, description: lineCheck.description, variant: "destructive" });
      return;
    }
    saveMut.mutate({
      companyId: cid, branchId: branchId || null,
      docNumber: docNumber || null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate, expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: supplierId || null, paymentType,
      currencyCode, exchangeRate,
      taxId: headerTaxId ? Number(headerTaxId) : null,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      priceIncludesVat,
      notes: notes || null,
       lines: lines.filter(l => l.itemName).map(l => serializeDocumentLine(l)),
    });
  }

  // On NEW docs in the tabbed layout, drop the initial pristine seed line:
  // entry happens via the quick-add bar (which always APPENDS a fresh line),
  // so the pre-seeded empty row just lingers in the grid. Runs ONCE; a later
  // flip to the classic layout re-seeds a single editable row. Save paths
  // are unaffected — they already skip empty rows (filter on itemName).
  // NOTE: these hooks MUST live ABOVE the loadingEdit early-return below —
  // hooks after a conditional return change the hook count between the
  // loading render and the loaded render → React error #310 (prod crash).
  const seedPrunedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    if (useTabbedLayout) {
      if (seedPrunedRef.current) return;
      seedPrunedRef.current = true;
      setLines(p => (p.length === 1 && !p[0].itemId && !p[0].itemName && !p[0].notes ? [] : p));
    } else if (lines.length === 0) {
      addLine();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTabbedLayout, isNew, lines.length]);

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">{tr("loadingEdit")}</div>;

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
  ];
  const itemComboItems = annotateItemCombo([
    { value: "", label: tr("itemSearchPh") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      code: i.code ?? undefined,
      label: itemNameOf(i),
    })),
  ], usageModes);
  const unitItems = units
    .filter((u: any) => u.isActive !== false)
    .map((u: any) => ({ value: String(u.id), label: unitNameOf(u) }));

  // 11-column lines grid — same column widths as the invoice form, minus the
  // weight / expenses / finalCost columns that have no meaning for an order.
  const HEADERS = [
    "#",
    tr("lineCols.itemCode"),
    tr("lineCols.item"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    t("salesDocForm.colFreeQty"),
    tr("lineCols.unitPrice"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.lineTotal"),
    "",
  ];

  // ── tabbed-shell helpers ───────────────────────────────────────────────
  // Purchase orders are permissive (supplier is optional, "بدون مورد"), so the
  // only true gate before reaching the items tab is a present order date —
  // every other mandatory check happens at save time (valid lines).
  // Existing docs (edit/view) are never locked out of their items tab.
  const missingBasicFields = (!isNew || viewMode) ? [] : (!orderDate ? ["التاريخ"] : []);
  const basicFieldsValid = missingBasicFields.length === 0;
  // Never silently block the items tab — explain exactly what is missing.
  const explainMissingBasics = () => {
    toast({
      title: "أكمل البيانات الأساسية أولاً",
      description: `الحقول الناقصة: ${missingBasicFields.join("، ")}`,
      variant: "destructive",
    });
  };
  const handleTabChange = (v: string) => {
    if (v === "items" && !basicFieldsValid) { explainMissingBasics(); return; }
    setActiveTab(v as any);
  };
  // In view-only mode the whole form is read-only; otherwise fields stay
  // editable (converted/cancelled orders block only the Save button via
  // `isLocked`, preserving the classic behavior).
  const editLock = viewMode;

  const nextButtonBlock = (
    <div className="flex justify-end pt-2">
      <Button type="button" onClick={() => { if (!basicFieldsValid) { explainMissingBasics(); return; } setActiveTab("items"); }} className="gap-1.5">
        التالي: الأصناف
        {isRtl ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
      </Button>
    </div>
  );

  const statusFlowButtons = (!isNew && !viewMode) ? (
    <>
      {orderStatus === "draft" && (
        <>
          <Button variant="outline" className="gap-1.5 text-blue-700 border-blue-200 hover:bg-blue-50"
            onClick={() => statusMut.mutate("confirmed")} disabled={statusMut.isPending}>
            <CheckCircle className="h-4 w-4" />{tr("confirm")}
          </Button>
          <Button variant="outline" className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50"
            onClick={() => { if (confirm(tr("confirmCancel"))) statusMut.mutate("cancelled"); }}
            disabled={statusMut.isPending}>
            <XCircle className="h-4 w-4" />{tr("cancel")}
          </Button>
        </>
      )}
      {orderStatus === "confirmed" && !convertedInvoiceId && (
        <>
          <Button variant="outline" className="gap-1.5 text-orange-700 border-orange-300 hover:bg-orange-50"
            onClick={() => { if (confirm(t("purchasingPages.purchaseOrders.confirms.unconfirmOne"))) statusMut.mutate("draft"); }}
            disabled={statusMut.isPending}
            title={t("purchasingPages.purchaseOrders.tooltips.unconfirm")}>
            <RotateCcw className="h-4 w-4" />{t("purchasingPages.purchaseOrders.bulk.unconfirm")}
          </Button>
          <Button className="gap-1.5"
            onClick={() => { if (confirm(tr("confirmConvert"))) convertMut.mutate(); }}
            disabled={convertMut.isPending}>
            <FileCheck2 className="h-4 w-4" />{convertMut.isPending ? tr("converting") : tr("convert")}
          </Button>
        </>
      )}
    </>
  ) : null;

  const saveButton = !editLock ? (
    <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending || isLocked}>
      {saveMut.isPending ? tr("saving") : isNew ? tr("saveOrder") : tr("saveEdit")}
    </Button>
  ) : null;

  const topActionBar = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 mb-1">
      <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => setActiveTab("basic")}>
        {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        البيانات الأساسية
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        {statusFlowButtons}
        {saveButton}
      </div>
    </div>
  );

  // ── "إضافة صنف" quick-entry bar (tabbed items tab) ────────────────────
  // Same design as the sales-invoice items tab: pick item → commit. The item
  // picker auto-fills the accurate cost/unit/VAT on commit (handleQuickAdd →
  // selectItem), so leaving السعر blank is the norm.
  // ‹السعر شامل الضريبة› toggle — rendered inside the quick-add bar normally,
  // or standalone above the grid when the bar is hidden (hideQuickAdd).
  const vatModeToggle = (
        <label
          data-testid="price-includes-vat-toggle"
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs cursor-pointer select-none transition-colors",
            priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
          )}
          title={priceIncludesVat ? (tr("vatHintIncl") as string) : (tr("vatHintExcl") as string)}
        >
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary cursor-pointer"
            checked={priceIncludesVat}
            onChange={e => {
              setPriceIncludesVat(e.target.checked);
              stickyPriceIncl.persist(e.target.checked);
            }}
          />
          <span className="font-semibold whitespace-nowrap">{tr("priceIncludesVat")}</span>
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
            {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
          </span>
        </label>
  );

  const quickAddBar = (
    <div className="mb-3 rounded-xl border-2 border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Plus className="h-4 w-4" />
          <span>إضافة صنف</span>
        </div>
        {vatModeToggle}
      </div>
      <div
        ref={quickAddRef}
        data-enter-scope
        className="grid gap-2 items-end"
        style={{ gridTemplateColumns: "minmax(200px,2fr) 140px 120px 76px 76px 110px 110px auto" }}
      >
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">الصنف</label>
          <SearchCombobox
            items={itemComboItems}
            value={qaItemId}
            onValueChange={setQaItemId}
            placeholder={tr("itemSearchPh")}
            searchPlaceholder="ابحث بالكود أو الاسم..."
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.warehouse")}</label>
          <SearchCombobox
            items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn }))}
            value={qaWarehouseId}
            onValueChange={setQaWarehouseId}
            placeholder={tr("lineCols.warehouse")}
            searchPlaceholder="ابحث بالكود أو الاسم..."
            className="h-9 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.unit")}</label>
          {(() => {
            const iu = (qaItemId && itemUnitsMap[qaItemId]) ? itemUnitsMap[qaItemId] : [];
            const opts = itemUnitsWithHistoricalSelection(iu, qaUnitId).map((u: any) => ({
              value: String(u.unitId),
              label: `${unitNameOf(u.unit)}${Number(u.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(u.conversionFactor)})` : ""}`,
              disabled: u.isActive === false || u.unit?.isActive === false,
            }));
            return (
              <Select value={qaUnitId || undefined} onValueChange={setQaUnitId} disabled={opts.length === 0}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                <SelectContent>
                   {opts.map((u: any) => <SelectItem key={u.value} value={u.value} disabled={u.disabled}>{u.label}</SelectItem>)}
                </SelectContent>
              </Select>
            );
          })()}
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.qty")}</label>
          <Input className="h-9 text-xs" type="text" inputMode="numeric" dir="ltr" value={qaQty}
            onChange={e => setQaQty(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{t("salesDocForm.colFreeQty")}</label>
          <Input className="h-9 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono" type="text" inputMode="numeric" dir="ltr" value={qaFreeQty}
            onChange={e => setQaFreeQty(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.unitPrice")}</label>
          <Input className="h-9 text-xs" type="text" inputMode="decimal" dir="ltr" placeholder="تلقائي" value={qaPrice}
            onChange={e => setQaPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">خصم %</label>
          <Input className="h-9 text-xs" type="text" inputMode="decimal" dir="ltr" value={qaDiscount}
            onChange={e => setQaDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={e => {
              // Last field in the bar: Enter commits the line (if an item is
              // chosen) and loops focus back to the item picker.
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                if (qaItemId) void handleQuickAdd().finally(focusQuickAddStart);
                else focusQuickAddStart();
              }
            }} />
        </div>
        <Button type="button" size="sm" className="h-9 gap-1.5 whitespace-nowrap" onClick={() => void handleQuickAdd()} disabled={!qaItemId} data-testid="button-quick-add-item">
          <Plus className="h-4 w-4" />
          إضافة إلى الجريدة
        </Button>
      </div>
    </div>
  );

  const detailsSection = (
    <PurchaseOrderDetails
      docId={editId}
      convertedInvoiceId={convertedInvoiceId}
      cid={cid}
      token={token}
      navigate={navigate}
    />
  );

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="space-y-5 max-w-6xl mx-auto" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/purchasing/orders")}>
          {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <ClipboardList className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{isNew ? tr("newTitle") : tr("editTitle", { id: editId })}</h1>
            <p className="text-xs text-muted-foreground">{tr("subtitle")}</p>
          </div>
        </div>
        {!isNew && <DocStatusBadge status={orderStatus} />}
        {/* Smart prev/next + search navigator across every purchase order
            of the current company. */}
        <DocNavigator
          items={(allPurchaseOrders as any[]).map((d: any) => {
            const s = (suppliers as any[]).find((s: any) => Number(s.id) === Number(d.supplierId));
            return {
              id: d.id,
              docNumber: d.docNumber,
              partyName: s ? (s.nameAr ?? s.nameEn ?? `#${s.id}`) : "—",
              date: d.orderDate ?? "",
              total: d.totalAmount ?? 0,
              currencyCode: d.currencyCode ?? "",
            };
          })}
          currentId={editId}
          basePath="/purchasing/orders"
          fallbackPrefix="PO-"
          className="ms-auto"
        />
        {!isNew && convertedInvoiceId && (
          <button type="button"
            className="text-xs rounded-full px-2 py-0.5 font-medium border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 inline-flex items-center gap-1"
            title={tr("openInvoice")}
            onClick={() => navigate(`/purchasing/invoices/${convertedInvoiceId}`)}>
            <FileCheck2 className="h-3 w-3" />INV-{convertedInvoiceId}
          </button>
        )}
      </div>

      <Tabs value={useTabbedLayout ? activeTab : "header"} onValueChange={handleTabChange} dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            {/* Tab chips FIRST (inline-start): RTL Arabic → tabs start from the
                right; LTR English → from the left. flex-nowrap + shrink-0 keep
                every chip on ONE line; the hint text truncates instead. */}
            <div className="flex items-center justify-between gap-3 flex-nowrap px-4 py-2 border-b bg-muted/20">
              {useTabbedLayout ? (
                <TabsList className="h-8 bg-background border gap-1 shrink-0">
                  <TabsTrigger value="basic" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />البيانات الأساسية
                  </TabsTrigger>
                  <TabsTrigger value="items" className={`h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground ${basicFieldsValid ? "" : "opacity-50"}`}>
                    <ListOrdered className="h-3.5 w-3.5" />الأصناف
                  </TabsTrigger>
                  <TabsTrigger value="details" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />التفاصيل
                  </TabsTrigger>
                </TabsList>
              ) : (
                <TabsList className="h-8 bg-background border gap-1 shrink-0">
                  <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />{tr("headerData")}
                  </TabsTrigger>
                </TabsList>
              )}
              <p className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate text-end">
                {useTabbedLayout && activeTab === "details"
                  ? "تفاصيل العمليات المرتبطة بأمر الشراء"
                  : tr("linesSummary", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount) })}
              </p>
            </div>
          </CardHeader>

          <TabsContent value={useTabbedLayout ? "basic" : "header"} className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
            <fieldset disabled={editLock} className="contents">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.docNumber")}</Label>
                  {(() => {
                    const lockOnEdit = !isNew;
                    const lockOnSeq  = isNew && seqPeek.hasSequence;
                    const locked     = lockOnEdit || lockOnSeq;
                    return (
                      <Input
                        ref={docNumberRef}
                        className={cn("h-9 text-sm", locked && "bg-muted/40 cursor-not-allowed")}
                        placeholder={isNew && seqPeek.loading ? "…" : tr("auto")}
                        value={docNumber}
                        onChange={e => { if (!locked) setDocNumber(e.target.value); }}
                        readOnly={locked}
                        title={lockOnEdit ? tr("lockTitle") : (lockOnSeq ? `${seqPeek.sequenceCode ?? ""}` : undefined)}
                      />
                    );
                  })()}
                  {seqPeek.exhausted && (
                    <p className="text-[11px] text-destructive">{tr("seqExhausted")}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.orderDate")}</Label>
                  <DateField className="h-9 text-sm" value={orderDate} onChange={e => setOrderDate(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.expectedDeliveryDate")}</Label>
                  <DateField className="h-9 text-sm" value={expectedDeliveryDate} onChange={e => setExpectedDeliveryDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplier")}</Label>
                  <SearchCombobox items={supplierItems} value={supplierId} onValueChange={setSupplierId} placeholder={tr("fields.supplierPh")} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplierInvoiceNumber")}</Label>
                  <Input className="h-9 text-sm" placeholder={tr("fields.supplierInvoiceNumberPh")} value={supplierInvoiceNumber} onChange={e => setSupplierInvoiceNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.branch")}</Label>
                  <Select value={branchId || undefined} onValueChange={setBranchId}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={tr("fields.branchPh")} /></SelectTrigger>
                    <SelectContent>
                      {(branches as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{branchName(b)}{b.isMain ? tr("fields.mainBranchTag") : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">المستودع</Label>
                  <SearchCombobox
                    items={(warehouses as any[]).map((w: any) => ({
                      value: String(w.id),
                      label: warehouseName(w) || `#${w.id}`,
                    }))}
                    value={headerWarehouseId}
                    onValueChange={applyHeaderWarehouse}
                    placeholder="اختر المستودع"
                  />
                  <p className="text-[10px] text-muted-foreground">يُعبَّأ تلقائياً على كل سطور الأصناف عند الاختيار.</p>
                </div>
                {taxCatalog.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">الضريبة</Label>
                    <SearchCombobox
                      items={taxComboItems}
                      value={headerTaxId}
                      onValueChange={applyHeaderTax}
                      placeholder="اختر الضريبة"
                    />
                    <p className="text-[10px] text-muted-foreground">تُطبَّق نسبتها تلقائياً على كل سطور الأصناف.</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.currency")}</Label>
                  {currencies.length > 0 ? (
                    <Select value={currencyCode} onValueChange={handleCurrencyChange}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={tr("fields.currencyPh")} /></SelectTrigger>
                      <SelectContent>
                        {currencies.map((c: any) => {
                          const cName = isRtl ? c.nameAr : (c.nameEn ?? c.nameAr);
                          return <SelectItem key={c.id} value={c.code}>{c.code} {cName ? `— ${cName}` : ""}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-9 text-sm" placeholder="SAR" value={currencyCode} onChange={e => setCurrencyCode(e.target.value)} />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center justify-between">
                    <span>{tr("fields.exchangeRate")}</span>
                    {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                      <span className="text-[10px] text-muted-foreground font-normal">
                        1 {currencyCode} = {Number(exchangeRate) > 0 ? Number(exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                      </span>
                    )}
                  </Label>
                  <Input type="text" inputMode="decimal" className="h-9 text-sm" dir="ltr"
                    value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.paymentType")}</Label>
                  <Select value={paymentType} onValueChange={setPaymentType}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="credit">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("payment.credit")}</span>
                      </SelectItem>
                      <SelectItem value="cash">
                        <span className="flex items-center gap-2"><Wallet className="h-3.5 w-3.5" />{tr("payment.cash")}</span>
                      </SelectItem>
                      <SelectItem value="bank">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("payment.bank")}</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">{tr("paymentInformational")}</p>
                </div>
                <div className="space-y-1.5 lg:col-span-3">
                  <Label className="text-xs">{tr("fields.notes")}</Label>
                  <Input className="h-9 text-sm" value={notes} onChange={e => setNotes(e.target.value)} placeholder={tr("notesPh")} />
                </div>
              </div>
              {useTabbedLayout && nextButtonBlock}
            </fieldset>
            </CardContent>
          </TabsContent>

          <TabsContent value={useTabbedLayout ? "items" : "header"} className="mt-0">
            <CardContent className="pt-2 pb-5 border-t">
              {useTabbedLayout && topActionBar}
              <fieldset disabled={editLock} className="contents">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{tr("linesTitle")} ({lines.filter(l => l.itemName).length})</span>
              </div>
              {useTabbedLayout && (hideQuickAdd
                ? <div className="mb-3 flex justify-end">{vatModeToggle}</div>
                : quickAddBar)}
              {(() => {
                const GRID_COLS = "38px 100px minmax(220px,1.3fr) 130px 100px 70px 70px 100px 75px 70px 120px 34px";
                const addGridLine = () => {
                  const nl = newLine();
                  const r = percentRateOf(headerTaxId);
                  if (r !== null) nl.vatRate = String(r);
                  if (headerWarehouseId) nl.warehouseId = headerWarehouseId;
                  setLines(p => [...p, nl]);
                  setFocusLineId(nl._id);
                };
                return (
              <div data-enter-nav-container="lines" className="mb-3 rounded-xl border bg-card overflow-hidden">
                <div className={cn("overflow-auto min-h-[200px]", (useTabbedLayout && hideQuickAdd) ? "max-h-[calc(100vh-260px)]" : "max-h-[calc(100vh-360px)]")}>
                <div className="min-w-max">
                <div
                  className="grid gap-1.5 px-3 py-2 border-b bg-muted/40 sticky top-0 z-10"
                  style={{ gridTemplateColumns: GRID_COLS }}
                >
                  {HEADERS.map((h, i) => (
                    <p
                      key={i}
                      className={cn(
                        "text-[11px] font-medium truncate",
                        h === tr("lineCols.lineTotal") ? "font-semibold text-primary" : "text-muted-foreground"
                      )}
                      title={h}
                    >{h}</p>
                  ))}
                </div>
                <div className="divide-y">
                {lines.length === 0 && (
                  <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                    لا توجد أصناف بعد — أضف صنفًا من الشريط بالأعلى.
                  </div>
                )}
                {lines.map((l, idx) => (
                  <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div
                      className="grid gap-1.5 items-center"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">{idx + 1}</span>
                      <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder={tr("auto")} value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox
                          items={itemComboItems}
                          value={l.itemId}
                          onValueChange={v => selectItem(l._id, v)}
                          placeholder={tr("itemSearchPh")}
                          searchPlaceholder="ابحث بالكود أو الاسم..."
                        />
                      ) : (
                        <Input className="h-8 text-xs" placeholder={tr("itemNamePh")} value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      {warehouses.length > 0 ? (
                        <Select value={l.warehouseId || undefined} onValueChange={v => updateLine(l._id, "warehouseId", v)}>
                          <SelectTrigger className={cn("h-8 text-xs", l.itemId && !l.warehouseId && "border-amber-400")}>
                            <SelectValue placeholder={tr("lineCols.warehouse")} />
                          </SelectTrigger>
                          <SelectContent>
                            {warehouses.map((w: any) => (
                              <SelectItem key={w.id} value={String(w.id)}>{warehouseName(w)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input className="h-8 text-xs" placeholder="—" readOnly />
                      )}
                      {(() => {
                        const itemUnits = (l.itemId && itemUnitsMap[l.itemId]) ? itemUnitsMap[l.itemId] : [];
                        const opts = itemUnits.length > 0
                          ? itemUnitsWithHistoricalSelection(itemUnits, l.unitId).map((iu: any) => ({
                              value: String(iu.unitId),
                              label: `${unitNameOf(iu.unit)}${Number(iu.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(iu.conversionFactor)})` : ""}`,
                              disabled: iu.isActive === false || iu.unit?.isActive === false,
                            }))
                          : [
                              ...unitItems,
                              ...catalogUnitsWithHistoricalSelection(units, l.unitId)
                                .filter((u: any) => !unitItems.some((x: any) => x.value === String(u.id)))
                                .map((u: any) => ({ value: String(u.id), label: unitNameOf(u) || `#${u.id}`, disabled: u.isActive === false })),
                            ];
                        return units.length > 0 ? (
                          <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                            <SelectContent>
                             {opts.map((u: any) => <SelectItem key={u.value} value={u.value} disabled={u.disabled}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder={tr("unitPh")} value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.qty} data-hide-default-one
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono"
                        type="text" inputMode="numeric" value={l.freeQty}
                        title={t("salesDocForm.colFreeQtyHint") as string}
                        onChange={e => updateLine(l._id, "freeQty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.discount}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.lineTotal)} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => setLines(p => p.filter(x => x._id !== l._id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {(l.itemId || l.itemName || l.notes) && (
                      <div className="mt-1.5 pr-[38px]">
                        <Input
                          className="h-7 text-[11px] bg-muted/20 border-dashed"
                          placeholder={t("salesDocForm.notesPlaceholder")}
                          value={l.notes}
                          onChange={e => updateLine(l._id, "notes", e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                ))}
                </div>
                </div>
                </div>
                <div className="border-t bg-muted/20 px-3 py-2">
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addGridLine}>
                    <Plus className="h-4 w-4" />{tr("addLine")}
                  </Button>
                </div>
              </div>
                );
              })()}

              {useTabbedLayout ? (
              /* Compact single-strip totals — mirrors the sales invoice items
                 tab. The VAT toggle lives at the top of the tab (quickAddBar),
                 so it is intentionally absent here. */
              <div className="mt-3 rounded-xl border bg-muted/30 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                    {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
                  </span>
                  <div className="flex items-center gap-1.5 ms-auto">
                    <span className="text-muted-foreground text-xs">{tr("subtotal")}</span>
                    <span className="font-mono">{fmt(subtotal)}</span>
                  </div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex items-center gap-1.5" data-testid="line-discount-total">
                      <span className="text-muted-foreground text-xs">{tr("itemDiscount")}</span>
                      <span className="font-mono text-rose-700">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">{tr("vatAmount")}</span>
                    <span className="font-mono text-amber-700">{fmt(vatAmount)}</span>
                  </div>
                  <div className="min-w-[210px]">
                    <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  </div>
                  <div className="flex items-center gap-1.5 border-s ps-4">
                    <span className="font-semibold text-xs">{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-base font-bold text-primary">{fmt(totalAmount)}</span>
                  </div>
                </div>
                {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                  <p className="mt-1 text-[10px] text-muted-foreground text-end">
                    {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt(totalAmount * Number(exchangeRate))}
                  </p>
                )}
              </div>
              ) : (
              <div className="mt-5 flex flex-wrap justify-between gap-4">
                <label
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border-2 p-3 cursor-pointer select-none transition-colors max-w-sm",
                    priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
                    checked={priceIncludesVat}
                    onChange={e => {
                      setPriceIncludesVat(e.target.checked);
                      stickyPriceIncl.persist(e.target.checked);
                    }}
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold">{tr("priceIncludesVat")}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {priceIncludesVat ? tr("vatHintIncl") : tr("vatHintExcl")}
                    </p>
                  </div>
                </label>

                <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                    <span>{tr("calcMethod")}</span>
                    <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                      {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("subtotal")}</span><span className="font-mono">{fmt(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("vatAmount")}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex justify-between text-rose-700">
                      <span className="text-muted-foreground">{tr("itemDiscount")}</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt(totalAmount * Number(exchangeRate))}
                    </p>
                  )}
                </div>
              </div>
              )}
              </fieldset>
            </CardContent>
          </TabsContent>

          {useTabbedLayout && (
            <TabsContent value="details" className="mt-0">
              <CardContent className="pt-5 pb-5">
                {detailsSection}
              </CardContent>
            </TabsContent>
          )}
        </Card>
      </Tabs>

      {!useTabbedLayout && (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" data-enter-skip="true" onClick={() => navigate("/purchasing/orders")}>{tr("back")}</Button>
        {/* Status flow buttons sit next to Save so the action bar mirrors
            the invoice form's footer placement exactly. */}
        {statusFlowButtons}
        {saveButton}
      </div>
      )}
    </div>
  );
}
