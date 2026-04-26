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
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  ArrowRight, ArrowLeft, ClipboardList, Plus, Trash2, FileText, ListOrdered,
  Wallet, CreditCard, CheckCircle, XCircle, FileCheck2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface OrderLine {
  _id: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unitId: string;
  unit: string;
  conversionFactor: string;
  warehouseId: string;
  qty: string;
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
    qty: "1", unitPrice: "0", discount: "0", vatRate: "15",
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
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
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
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [matchNew]  = useRoute("/purchasing/orders/new");
  const [matchEdit, params] = useRoute("/purchasing/orders/:id");
  const isNew  = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;

  const seqPeek = useNextSequenceNumber("purchase_order", isNew);

  const [docNumber,    setDocNumber]    = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [orderDate,    setOrderDate]    = useState(today());
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [supplierId,   setSupplierId]   = useState("");
  const [branchId,     setBranchId]     = useState("");
  const [paymentType,  setPaymentType]  = useState("credit");
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [notes,        setNotes]        = useState("");
  const [docDiscount,  setDocDiscount]  = useState("0");
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
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
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  const { containerRef, onKeyDown } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  // Smart document navigator — list of all purchase orders for the
  // current company. Cache key matches the list page so opening the
  // navigator is instant once the user has visited the list.
  const { data: allPurchaseOrders = [] } = useQuery<any[]>({
    queryKey: ["purchase-orders", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/purchasing/purchase-orders?companyId=${cid}` : `${API}/api/purchasing/purchase-orders`, { headers: authH });
      return r.json();
    },
    enabled: !!user,
  });

  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: exchangeRates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/currencies/rates?companyId=${cid}` : `${API}/api/currencies/rates`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: inventoryItems = [] } = useQuery<any[]>({
    queryKey: ["inventory-items", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/inventory/items?companyId=${cid}` : `${API}/api/inventory/items`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: units = [] } = useQuery<any[]>({
    queryKey: ["units", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/inventory/units?companyId=${cid}` : `${API}/api/inventory/units`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ["warehouses", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/inventory/warehouses?companyId=${cid}` : `${API}/api/inventory/warehouses`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });
  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  useEffect(() => {
    if (!isNew || !defaultBranch || branchId) return;
    setBranchId(String(defaultBranch.id));
  }, [isNew, defaultBranch?.id]);

  const defaultWarehouse = (warehouses as any[])[0];
  const hasEmptyWarehouse = lines.some(l => !l.warehouseId);
  useEffect(() => {
    if (!defaultWarehouse || !hasEmptyWarehouse) return;
    setLines(prev => prev.map(l => l.warehouseId ? l : { ...l, warehouseId: String(defaultWarehouse.id) }));
  }, [defaultWarehouse?.id, hasEmptyWarehouse]);

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

  function handleCurrencyChange(code: string) {
    setCurrencyCode(code);
    setExchangeRate(getLatestRate(code));
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
    setLines(existing.lines?.length ? existing.lines.map((l: any) => ({
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
      vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      notes:       l.notes ?? "",
    })) : [newLine()]);
  }, [existing]);

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

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) { updateLine(lineId, "itemId", ""); return; }
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
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
        unitPrice: trimTrailingZeros(base?.costPrice ?? item.costPrice ?? "0"),
        vatRate:   (Number(item.vatRate) > 0 ? String(item.vatRate) : "15"),
      };
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
    saveMut.mutate({
      companyId: cid, branchId: branchId || null,
      docNumber: docNumber || null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate, expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: supplierId || null, paymentType,
      currencyCode, exchangeRate,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      priceIncludesVat,
      notes: notes || null,
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">{tr("loadingEdit")}</div>;

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
  ];
  const itemComboItems = [
    { value: "", label: tr("itemSearchPh") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      label: i.code ? `${i.code} — ${itemNameOf(i)}` : itemNameOf(i),
    })),
  ];
  const unitItems = units.map((u: any) => ({ value: String(u.id), label: unitNameOf(u) }));

  // 11-column lines grid — same column widths as the invoice form, minus the
  // weight / expenses / finalCost columns that have no meaning for an order.
  const HEADERS = [
    tr("lineCols.item"),
    tr("lineCols.itemCode"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    tr("lineCols.unitPrice"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.lineTotal"),
    tr("lineCols.notes"),
    "",
  ];

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

      <Tabs value="header" dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {tr("linesSummary", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount) })}
              </p>
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                  <FileText className="h-3.5 w-3.5" />{tr("headerData")}
                </TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>

          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
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
                  <Input type="date" className="h-9 text-sm" value={orderDate} onChange={e => setOrderDate(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.expectedDeliveryDate")}</Label>
                  <Input type="date" className="h-9 text-sm" value={expectedDeliveryDate} onChange={e => setExpectedDeliveryDate(e.target.value)} />
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
                        1 {currencyCode} = {Number(exchangeRate) > 0 ? (1 / Number(exchangeRate)).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
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
            </CardContent>
          </TabsContent>

          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-2 pb-5 border-t">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{tr("linesTitle")} ({lines.filter(l => l.itemName).length})</span>
              </div>
              {(() => {
                const GRID_COLS = "220px 110px 160px 120px 90px 110px 80px 80px 130px 180px 40px";
                return (
              <div data-enter-nav-container="lines" className="mb-3 rounded-xl border bg-card overflow-x-auto">
                <div className="min-w-max">
                <div
                  className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0"
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
                {lines.map(l => (
                  <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div
                      className="grid gap-2 items-center"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox
                          items={itemComboItems}
                          value={l.itemId}
                          onValueChange={v => selectItem(l._id, v)}
                          placeholder={tr("itemSearchPh")}
                        />
                      ) : (
                        <Input className="h-8 text-xs" placeholder={tr("itemNamePh")} value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      <Input className="h-8 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder={tr("auto")} value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
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
                          ? itemUnits.map((iu: any) => ({
                              value: String(iu.unitId),
                              label: `${unitNameOf(iu.unit)}${Number(iu.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(iu.conversionFactor)})` : ""}`,
                            }))
                          : unitItems;
                        return units.length > 0 ? (
                          <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                            <SelectContent>
                              {opts.map((u: any) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder={tr("unitPh")} value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.discount}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.lineTotal)} />
                      <Input className="h-8 text-xs" value={l.notes}
                        onChange={e => updateLine(l._id, "notes", e.target.value)} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => setLines(p => p.filter(x => x._id !== l._id))} disabled={lines.length <= 1}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                </div>
                </div>
              </div>
                );
              })()}

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addLine}>
                <Plus className="h-4 w-4" />{tr("addLine")}
              </Button>

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
                    onChange={e => setPriceIncludesVat(e.target.checked)}
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
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} />
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt(totalAmount / Number(exchangeRate))}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" data-enter-skip="true" onClick={() => navigate("/purchasing/orders")}>{tr("back")}</Button>
        {/* Status flow buttons sit next to Save so the action bar mirrors
            the invoice form's footer placement exactly. */}
        {!isNew && orderStatus === "draft" && (
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
        {!isNew && orderStatus === "confirmed" && !convertedInvoiceId && (
          <Button className="gap-1.5"
            onClick={() => { if (confirm(tr("confirmConvert"))) convertMut.mutate(); }}
            disabled={convertMut.isPending}>
            <FileCheck2 className="h-4 w-4" />{convertMut.isPending ? tr("converting") : tr("convert")}
          </Button>
        )}
        <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending || isLocked}>
          {saveMut.isPending ? tr("saving") : isNew ? tr("saveOrder") : tr("saveEdit")}
        </Button>
      </div>
    </div>
  );
}
