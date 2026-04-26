// Purchase Order form — operational, finance-FREE.
//
// Mirrors the operational portion of the purchase invoice form (supplier,
// branch, items, totals) but intentionally omits every accounting / posting
// concern: no inventory/tax/discount account pickers, no LC, no expense
// distribution, no auto-post on save. Saving here only writes rows in
// `purchase_orders` and `purchase_order_lines` — never a journal entry,
// stock movement, voucher, or supplier balance update. Converting to a
// purchase invoice still requires the user to post that invoice separately.
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
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft, ClipboardList, Plus, Trash2, FileText, CheckCircle, XCircle, FileCheck2 } from "lucide-react";

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

  const [activeTab,    setActiveTab]    = useState("header");
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
  // pattern used by the invoice form so unit & cost auto-populate from the
  // selected item without an extra round-trip per keystroke.
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

  async function pickItem(lineId: string, itemId: string) {
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

  const STATUS_BADGES: Record<string, { labelKey: string; cls: string }> = {
    draft:     { labelKey: "status.draft",     cls: "bg-amber-50 text-amber-700 border-amber-200" },
    confirmed: { labelKey: "status.confirmed", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    cancelled: { labelKey: "status.cancelled", cls: "bg-muted text-muted-foreground border-border" },
    converted: { labelKey: "status.converted", cls: "bg-green-50 text-green-700 border-green-200" },
  };
  const stBadge = STATUS_BADGES[orderStatus] ?? STATUS_BADGES.draft;

  return (
    <div className="space-y-4" dir={isRtl ? "rtl" : "ltr"} ref={containerRef as any} onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate("/purchasing/orders")} className="gap-1.5">
            {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
            {tr("back")}
          </Button>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            {isNew ? tr("newOrder") : tr("editOrder")}
          </h1>
          {!isNew && (
            <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", stBadge.cls)}>
              {t(stBadge.labelKey)}
            </span>
          )}
          {!isNew && convertedInvoiceId && (
            <button type="button"
              className="text-xs rounded-full px-2 py-0.5 font-medium border border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
              title={tr("openInvoice")}
              onClick={() => navigate(`/purchasing/invoices/${convertedInvoiceId}`)}>
              <FileCheck2 className="inline h-3 w-3 mr-1" />INV-{convertedInvoiceId}
            </button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {!isNew && orderStatus === "draft" && (
            <>
              <Button size="sm" variant="outline" className="gap-1.5 text-blue-700 border-blue-200 hover:bg-blue-50"
                onClick={() => statusMut.mutate("confirmed")} disabled={statusMut.isPending}>
                <CheckCircle className="h-4 w-4" />{tr("confirm")}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50"
                onClick={() => { if (confirm(tr("confirmCancel"))) statusMut.mutate("cancelled"); }}
                disabled={statusMut.isPending}>
                <XCircle className="h-4 w-4" />{tr("cancel")}
              </Button>
            </>
          )}
          {!isNew && orderStatus === "confirmed" && !convertedInvoiceId && (
            <Button size="sm" className="gap-1.5"
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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="header">{tr("tabHeader")}</TabsTrigger>
          <TabsTrigger value="lines">{tr("tabLines")} ({lines.length})</TabsTrigger>
          <TabsTrigger value="totals">{tr("tabTotals")}</TabsTrigger>
        </TabsList>

        <TabsContent value="header" className="space-y-3">
          <Card>
            <CardHeader className="text-sm font-semibold">{tr("section.order")}</CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>{tr("docNumber")}</Label>
                <Input
                  ref={docNumberRef}
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  readOnly={seqPeek.hasSequence}
                  placeholder={seqPeek.hasSequence ? "" : tr("autoPlaceholder")}
                />
                {seqPeek.exhausted && (
                  <p className="text-xs text-destructive mt-1">{tr("seqExhausted")}</p>
                )}
              </div>
              <div>
                <Label>{tr("orderDate")}</Label>
                <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </div>
              <div>
                <Label>{tr("expectedDeliveryDate")}</Label>
                <Input type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
              </div>
              <div>
                <Label>{tr("supplier")}</Label>
                <SearchCombobox
                  items={supplierItems}
                  value={supplierId}
                  onValueChange={setSupplierId}
                  placeholder={tr("supplierPh")}
                />
              </div>
              <div>
                <Label>{tr("supplierInvoiceNumber")}</Label>
                <Input value={supplierInvoiceNumber} onChange={(e) => setSupplierInvoiceNumber(e.target.value)} />
              </div>
              <div>
                <Label>{tr("branch")}</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger><SelectValue placeholder={tr("branchPh")} /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{branchName(b)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{tr("paymentType")}</Label>
                <Select value={paymentType} onValueChange={setPaymentType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">{tr("paymentCredit")}</SelectItem>
                    <SelectItem value="cash">{tr("paymentCash")}</SelectItem>
                    <SelectItem value="bank">{tr("paymentBank")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground mt-1">{tr("paymentInformational")}</p>
              </div>
              <div>
                <Label>{tr("currency")}</Label>
                <Select value={currencyCode} onValueChange={handleCurrencyChange}>
                  <SelectTrigger><SelectValue placeholder={tr("currencyPh")} /></SelectTrigger>
                  <SelectContent>
                    {currencies.map((c: any) => (
                      <SelectItem key={c.id} value={c.code}>{c.code} — {isRtl ? c.nameAr : (c.nameEn ?? c.nameAr)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{tr("exchangeRate")}</Label>
                <Input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-semibold">{tr("section.notes")}</CardHeader>
            <CardContent>
              <textarea
                className="w-full min-h-[80px] rounded-md border bg-background p-2 text-sm"
                value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder={tr("notesPh")}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="lines" className="space-y-3">
          <Card>
            <CardContent className="p-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>#</th>
                      <th className={cn("px-2 py-2 font-semibold min-w-[200px]", isRtl ? "text-right" : "text-left")}>{tr("col.item")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.warehouse")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.unit")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.qty")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.unitPrice")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.discount")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.vat")}</th>
                      <th className={cn("px-2 py-2 font-semibold", isRtl ? "text-right" : "text-left")}>{tr("col.total")}</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => {
                      const itemUnits = l.itemId ? (itemUnitsMap[l.itemId] ?? []) : [];
                      return (
                        <tr key={l._id} className="border-b hover:bg-muted/20">
                          <td className="px-2 py-1.5 text-muted-foreground">{idx + 1}</td>
                          <td className="px-2 py-1.5">
                            <SearchCombobox
                              items={itemComboItems}
                              value={l.itemId}
                              onValueChange={(v) => pickItem(l._id, v)}
                              placeholder={tr("itemSearchPh")}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Select value={l.warehouseId} onValueChange={(v) => updateLine(l._id, "warehouseId", v)}>
                              <SelectTrigger className="h-8 text-xs min-w-[120px]"><SelectValue placeholder={tr("warehousePh")} /></SelectTrigger>
                              <SelectContent>
                                {warehouses.map((w: any) => (
                                  <SelectItem key={w.id} value={String(w.id)}>{warehouseName(w)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-2 py-1.5">
                            <Select value={l.unitId} onValueChange={(v) => changeLineUnit(l._id, v)} disabled={!l.itemId}>
                              <SelectTrigger className="h-8 text-xs min-w-[100px]"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                              <SelectContent>
                                {(itemUnits.length ? itemUnits : units.filter((u: any) => true)).map((u: any) => {
                                  const id = String(u.unitId ?? u.id);
                                  const name = unitNameOf(u.unit ?? u);
                                  return <SelectItem key={id} value={id}>{name}</SelectItem>;
                                })}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 w-20 text-xs" type="number" step="0.001" value={l.qty}
                              onChange={(e) => updateLine(l._id, "qty", e.target.value)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 w-24 text-xs" type="number" step="0.01" value={l.unitPrice}
                              onChange={(e) => updateLine(l._id, "unitPrice", e.target.value)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 w-16 text-xs" type="number" step="0.01" value={l.discount}
                              onChange={(e) => updateLine(l._id, "discount", e.target.value)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 w-16 text-xs" type="number" step="0.01" value={l.vatRate}
                              onChange={(e) => updateLine(l._id, "vatRate", e.target.value)} />
                          </td>
                          <td className="px-2 py-1.5 font-mono">{fmt(l.lineTotal)}</td>
                          <td className="px-2 py-1.5">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                              onClick={() => setLines(prev => prev.filter(x => x._id !== l._id))}
                              disabled={lines.length <= 1}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={addLine}>
                  <Plus className="h-3.5 w-3.5" />{tr("addLine")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="totals" className="space-y-3">
          <Card>
            <CardHeader className="text-sm font-semibold">{tr("section.totals")}</CardHeader>
            <CardContent className="space-y-2 max-w-md">
              <div className="flex items-center gap-2 mb-3">
                <input id="pivat" type="checkbox" checked={priceIncludesVat}
                  onChange={(e) => setPriceIncludesVat(e.target.checked)} />
                <Label htmlFor="pivat" className="cursor-pointer">{tr("priceIncludesVat")}</Label>
              </div>
              <div className="flex justify-between text-sm">
                <span>{tr("subtotal")}</span><span className="font-mono">{fmt(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>{tr("vat")}</span><span className="font-mono">{fmt(vatAmount)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <Label htmlFor="docDisc">{tr("docDiscount")}</Label>
                <Input id="docDisc" className="w-32 h-8 text-xs" type="number" step="0.01"
                  value={docDiscount} onChange={(e) => setDocDiscount(e.target.value)} />
              </div>
              <div className="flex justify-between text-base font-bold border-t pt-2">
                <span>{tr("total")}</span><span className="font-mono">{fmt(totalAmount)}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
