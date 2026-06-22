import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { validateInvoiceLines } from "@/lib/lineValidation";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { JournalScanArchive } from "@/components/JournalScanArchive";
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
import { SupplierVatControl } from "@/components/SupplierVatControl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft, ShoppingCart, Plus, Trash2, FileText, ListOrdered, AlertCircle, Wallet, CreditCard, TrendingUp, TrendingDown, Lock } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface InvoiceLine {
  _id: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unitId: string;
  unit: string;
  conversionFactor: string;
  warehouseId: string;
  qty: string;
  freeQty: string;
  weight: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  lineTotal: string;
  expenseShare: string;
  finalCost: string;
  batchNumber: string;
  expiryDate: string;
  notes: string;
}

function newLine(): InvoiceLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", freeQty: "0", weight: "0", unitPrice: "0", discount: "0", vatRate: "15",
    lineTotal: "0", expenseShare: "0", finalCost: "0", batchNumber: "", expiryDate: "", notes: "",
  };
}

// `taxMode` controls whether VAT is computed before or after the line
// discount. Defaults to "after_discount" (legacy/ZATCA-standard); the
// caller passes the company-wide preference read from auth.
type TaxMode = "before_discount" | "after_discount";
function calcLine(l: InvoiceLine, priceIncludesVat = false, taxMode: TaxMode = "after_discount") {
  const qty = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const disc = Number(l.discount) || 0;
  const rate = (Number(l.vatRate) || 0) / 100;
  if (taxMode === "before_discount") {
    const fullGross = qty * price;
    const discAmt = fullGross * (disc / 100);
    if (priceIncludesVat) {
      const fullNet = rate > -1 ? fullGross / (1 + rate) : fullGross;
      return { lineTotal: Math.max(0, fullGross - discAmt), subtotal: Math.max(0, fullNet - discAmt) };
    }
    const vat = fullGross * rate;
    return { lineTotal: Math.max(0, fullGross + vat - discAmt), subtotal: Math.max(0, fullGross - discAmt) };
  }
  const gross = qty * price * (1 - disc / 100);
  if (priceIncludesVat) {
    const net = rate > -1 ? gross / (1 + rate) : gross;
    return { lineTotal: gross, subtotal: net };
  }
  const vat = gross * rate;
  return { lineTotal: gross + vat, subtotal: gross };
}

export default function PurchaseInvoiceForm() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`purchasingPages.purchaseInvoiceForm.${k}`, opts) as string;
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

  const [matchNew]  = useRoute("/purchasing/invoices/new");
  const [matchEdit, params] = useRoute("/purchasing/invoices/:id");
  const isNew  = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;

  const [activeTab,    setActiveTab]    = useState("header");
  const [docNumber,    setDocNumber]    = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [invoiceDate,  setInvoiceDate]  = useState(today());
  const [supplierId,   setSupplierId]   = useState("");
  const [branchId,     setBranchId]     = useState("");

  // Peek the NEXT number for the SAME branch the form will submit — counters
  // are per-(sequence, branch), so omitting branchId reads the empty branch-0
  // sentinel and the badge freezes at the start number while saves advance the
  // real branch counter.
  const seqPeek = useNextSequenceNumber("purchase_invoice", isNew, undefined, branchId);
  const [paymentType,  setPaymentType]  = useState("credit");
  const [cashBoxId,    setCashBoxId]    = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [lcId,         setLcId]         = useState("");
  const [distMethod,   setDistMethod]   = useState("value");
  const [notes,        setNotes]        = useState("");
  const [costCenter,   setCostCenter]   = useState("");
  const [docDiscount,  setDocDiscount]  = useState("0");
  // Sticky toggle — see SalesDocumentForm for behavior contract.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [priceIncludesVat, setPriceIncludesVat] = useState(stickyPriceIncl.initial);
  const [lines,        setLines]        = useState<InvoiceLine[]>([newLine()]);
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
  const { containerRef, onKeyDown } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [discountAccountId,  setDiscountAccountId]  = useState("");

  const acctPrefsKey = `purchase-invoice-accts:${cid ?? "all"}`;
  useEffect(() => {
    if (!isNew) return;
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.inventoryAccountId && !inventoryAccountId) setInventoryAccountId(String(p.inventoryAccountId));
      if (p.taxAccountId       && !taxAccountId)       setTaxAccountId(String(p.taxAccountId));
      if (p.discountAccountId  && !discountAccountId)  setDiscountAccountId(String(p.discountAccountId));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, cid]);

  useEffect(() => {
    if (!inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({ inventoryAccountId, taxAccountId, discountAccountId }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryAccountId, taxAccountId, discountAccountId]);

  // Smart document navigator — list of all purchase invoices for the
  // current company (lightweight). Same cache key as the list page so
  // opening the navigator is instant if the user already visited the list.
  const { data: allPurchaseInvoices = [] } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/purchasing/purchase-invoices?companyId=${cid}` : `${API}/api/purchasing/purchase-invoices`, authH),
    enabled: !!user,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, authH),
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

  const { data: lcs = [] } = useQuery<any[]>({
    queryKey: ["lc", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/purchasing/letters-of-credit?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit`, authH),
    enabled: !!user,
  });

  const { data: inventoryItems = [] } = useQuery<any[]>({
    queryKey: ["inventory-items", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/items?companyId=${cid}` : `${API}/api/inventory/items`, authH),
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
  // SERVICE items never touch stock → no warehouse, no batch/expiry. This helper
  // lets the warehouse auto-fill / broadcast effects skip service lines and lets
  // the line grid hide the warehouse + batch + expiry inputs for them.
  const isServiceLine = (l: { itemId: string }) =>
    (inventoryItems as any[]).some((i: any) => String(i.id) === l.itemId && i.itemType === "service");
  const hasEmptyWarehouse = lines.some(l => !l.warehouseId && !isServiceLine(l));
  useEffect(() => {
    if (!headerWarehouseId || !hasEmptyWarehouse) return;
    setLines(prev => prev.map(l => (l.warehouseId || isServiceLine(l)) ? l : { ...l, warehouseId: headerWarehouseId }));
  }, [headerWarehouseId, hasEmptyWarehouse]);
  function applyHeaderWarehouse(v: string) {
    setHeaderWarehouseId(v);
    if (!v) return;
    setLines(prev => prev.map(l => isServiceLine(l) ? l : { ...l, warehouseId: v }));
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
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }
  // Route-transition safeguard — clear header on doc-id change so init/derive
  // effects re-populate from the freshly loaded doc.
  useEffect(() => {
    setHeaderWarehouseId("");
    setHeaderTaxId("");
  }, [editId, isNew]);

  const { data: supplierBalances = [] } = useQuery<any[]>({
    queryKey: ["supplier-balances", cid],
    queryFn: () => fetchJsonArray(`${API}/api/suppliers/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "credit",
  });

  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/cost-centers?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetchJsonArray(`${API}/api/cash-boxes?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: cashBoxBalances = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: () => fetchJsonArray(`${API}/api/cash-boxes/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "bank",
  });
  const { data: bankAccountBalances = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts-bal", cid],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "bank",
  });

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
    queryKey: ["purchase-invoice", editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/purchasing/purchase-invoices/${editId}?companyId=${cid}`, { headers: authH });
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
    setInvoiceDate(existing.invoiceDate ?? today());
    setSupplierId(existing.supplierId ? String(existing.supplierId) : "");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    setPaymentType(existing.paymentType ?? "credit");
    setCashBoxId(existing.cashBoxId ? String(existing.cashBoxId) : "");
    setBankAccountId(existing.bankAccountId ? String(existing.bankAccountId) : "");
    setCurrencyCode(existing.currencyCode ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setLcId(existing.lcId ? String(existing.lcId) : "");
    setDistMethod(existing.distributionMethod ?? "value");
    setNotes(existing.notes ?? "");
    setCostCenter(existing.costCenter ?? "");
    setDocDiscount(String(existing.discountAmount ?? "0"));
    setPriceIncludesVat(!!existing.priceIncludesVat);
    setInventoryAccountId(existing.inventoryAccountId ? String(existing.inventoryAccountId) : "");
    setTaxAccountId(existing.taxAccountId ? String(existing.taxAccountId) : "");
    setDiscountAccountId(existing.discountAccountId ? String(existing.discountAccountId) : "");
    setHeaderTaxId((existing as any).taxId != null ? String((existing as any).taxId) : "");
    setLines(existing.lines?.length ? existing.lines.map((l: any) => ({
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
      weight:      String(l.weight ?? "0"),
      unitPrice:   String(l.unitPrice),
      discount:    String(l.discount ?? "0"),
      vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      expenseShare:String(l.expenseShare ?? "0"),
      finalCost:   String(l.finalCost ?? "0"),
      batchNumber: l.batchNumber ?? "",
      expiryDate:  l.expiryDate  ?? "",
      notes:       l.notes ?? "",
    })) : [newLine()]);
  }, [existing]);

  const duplicatedRef = useRef(false);
  useEffect(() => {
    if (!isNew || duplicatedRef.current || !user) return;
    const params = new URLSearchParams(window.location.search);
    const fromId = params.get("from");
    if (!fromId) return;
    duplicatedRef.current = true;

    (async () => {
      try {
        const r = await fetch(`${API}/api/purchasing/purchase-invoices/${fromId}?companyId=${cid}`, { headers: authH });
        if (!r.ok) return;
        const src = await r.json();
        setDocNumber("");
        setSupplierInvoiceNumber("");
        setInvoiceDate(today());
        setSupplierId(src.supplierId ? String(src.supplierId) : "");
        setBranchId(src.branchId ? String(src.branchId) : "");
        setPaymentType(src.paymentType ?? "credit");
        setCashBoxId(src.cashBoxId ? String(src.cashBoxId) : "");
        setBankAccountId(src.bankAccountId ? String(src.bankAccountId) : "");
        setCurrencyCode(src.currencyCode ?? "SAR");
        setExchangeRate(String(src.exchangeRate ?? "1"));
        setLcId(src.lcId ? String(src.lcId) : "");
        setDistMethod(src.distributionMethod ?? "value");
        setNotes(src.notes ?? "");
        setDocDiscount(String(src.discountAmount ?? "0"));
        setPriceIncludesVat(!!src.priceIncludesVat);
        setInventoryAccountId(src.inventoryAccountId ? String(src.inventoryAccountId) : "");
        setTaxAccountId(src.taxAccountId ? String(src.taxAccountId) : "");
        setDiscountAccountId(src.discountAccountId ? String(src.discountAccountId) : "");
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
          weight:      String(l.weight ?? "0"),
          unitPrice:   String(l.unitPrice),
          discount:    String(l.discount ?? "0"),
          vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal),
          expenseShare:String(l.expenseShare ?? "0"),
          finalCost:   String(l.finalCost ?? "0"),
          batchNumber: l.batchNumber ?? "",
          expiryDate:  l.expiryDate  ?? "",
          notes:       l.notes ?? "",
        })) : [newLine()]);
        toast({ title: tr("duplicated") });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, user, cid]);

  function updateLine(id: string, field: keyof InvoiceLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const updated = { ...l, [field]: value };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  useEffect(() => {
    setLines(prev => prev.map(l => {
      const { lineTotal } = calcLine(l, priceIncludesVat);
      return { ...l, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(l.expenseShare || 0)).toFixed(2) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceIncludesVat]);

  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/units?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemUnitsMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }

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
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    let chosenPrice: string = String(base?.costPrice ?? item.costPrice ?? "0");
    if (currencyCode && defaultCurrency && currencyCode !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const m = pickCurrencyCost(cps, currencyCode);
      if (m != null) chosenPrice = m;
    }
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const isService = item.itemType === "service";
      const updated: InvoiceLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemNameOf(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitNameOf(base?.unit) || unitNameOf(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: trimTrailingZeros(chosenPrice),
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
        // Service lines never hit inventory: drop warehouse + batch + expiry.
        warehouseId: isService ? "" : l.warehouseId,
        batchNumber: isService ? "" : l.batchNumber,
        expiryDate:  isService ? "" : l.expiryDate,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
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
          ?? itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
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
      const updated: InvoiceLine = { ...l, unitPrice: np };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  function changeLineUnit(lineId: string, newUnitId: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const itemUnits = itemUnitsMap[l.itemId] ?? [];
      const row = itemUnits.find((u: any) => String(u.unitId) === newUnitId);
      const globalUnit = units.find((u: any) => String(u.id) === newUnitId);
      const updated: InvoiceLine = {
        ...l,
        unitId: newUnitId,
        unit: unitNameOf(row?.unit) || unitNameOf(globalUnit) || "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.costPrice != null ? trimTrailingZeros(row.costPrice) : l.unitPrice,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  async function distributeExpenses() {
    if (!selectedLc || !lines.length) {
      toast({ title: tr("selectLcFirst"), variant: "destructive" });
      return;
    }
    const totalBase = distMethod === "qty"
      ? lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
      : lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
    if (!totalBase) {
      toast({ title: tr("enterLinesFirst"), variant: "destructive" });
      return;
    }

    // Distribute the LC's expenses *in base currency*. Each expense row is
    // converted via its own historical rate (IAS 21) on the server, so we sum
    // the pre-computed `amountBase`/`totalExpensesBase` rather than raw amounts.
    let totalLcExpenses = 0;
    let baseCur = defaultCurrency?.code ?? "SAR";
    try {
      const url = `${API}/api/purchasing/letters-of-credit/${selectedLc.id}${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: authH });
      if (!r.ok) throw new Error(tr("lcLoadFail"));
      const detail = await r.json();
      baseCur = detail.baseCurrency ?? baseCur;
      totalLcExpenses = Number(detail.totalExpensesBase ?? 0)
        || (detail.expenses ?? []).reduce(
            (s: number, e: any) => s + (Number(e.amountBase ?? e.amount) || 0), 0);
    } catch (err: any) {
      toast({ title: err.message || tr("lcLoadFail"), variant: "destructive" });
      return;
    }

    if (totalLcExpenses <= 0) {
      toast({ title: tr("lcNoExpenses"), variant: "destructive" });
      return;
    }

    setLines(prev => prev.map(l => {
      const base = distMethod === "qty" ? Number(l.qty) : Number(l.lineTotal);
      const share = (base / totalBase) * totalLcExpenses;
      const finalCost = Number(l.lineTotal) + share;
      return { ...l, expenseShare: share.toFixed(2), finalCost: finalCost.toFixed(2) };
    }));
    toast({ title: tr("lcDistributed"), description: tr("lcDistributedDesc", { total: fmt(totalLcExpenses), cur: baseCur }) });
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
  const totalExpLoaded = lines.reduce((s, l) => s + (Number(l.expenseShare) || 0), 0);
  const selectedLc     = lcs.find((lc: any) => String(lc.id) === lcId);

  // Per-doc-type auto-posting flag with global fallback. See
  // SalesDocumentForm for the full rationale on the legacy fallback.
  const _co = (user as any)?.company;
  const _gl = _co?.autoPostingEnabled !== false;
  const autoPostingEnabled = _co?.autoPostPurchase === undefined || _co?.autoPostPurchase === null
    ? _gl
    : _co.autoPostPurchase !== false;
  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/purchasing/purchase-invoices/${editId}` : `${API}/api/purchasing/purchase-invoices`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);

      if (autoPostingEnabled && j?.id && (j.status ?? "draft") === "draft") {
        const postRes = await fetch(`${API}/api/purchasing/purchase-invoices/${j.id}/post`, {
          method: "PATCH", headers,
        });
        const postJson = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          throw new Error(tr("savedNotPosted", { err: postJson.error || postRes.statusText }));
        }
        return postJson;
      }
      return j;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: autoPostingEnabled
        ? (isNew ? tr("createdAndPosted") : tr("savedAndPosted"))
        : (isNew ? tr("createdDraft") : tr("savedDraft"))
      });
      navigate("/purchasing/invoices");
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function handleSave() {
    // Required-fields gate (mirrors the server's 400 in /purchase-invoices):
    // every purchase invoice must carry an explicit supplier + branch.
    // Surfaced as a destructive toast BEFORE the network round-trip so the
    // user sees the failure instantly with both missing fields listed.
    const missing: string[] = [];
    if (!supplierId) missing.push("المورد");
    if (!branchId)   missing.push("الفرع");
    if (missing.length) {
      toast({
        title: "⚠️ بيانات ناقصة — لا يمكن حفظ الفاتورة",
        description: `الحقول التالية مطلوبة: ${missing.join("، ")}`,
        variant: "destructive",
      });
      return;
    }
    // Per-line gate: item name + unit + qty + price required on every row.
    const lineCheck = validateInvoiceLines(lines);
    if (!lineCheck.ok) {
      toast({ title: lineCheck.title, description: lineCheck.description, variant: "destructive" });
      return;
    }
    saveMut.mutate({
      companyId: cid, branchId: branchId || null,
      docNumber: docNumber || null, supplierInvoiceNumber: supplierInvoiceNumber || null, invoiceDate,
      supplierId: supplierId || null, paymentType,
      cashBoxId: paymentType === "cash" ? (cashBoxId || null) : null,
      bankAccountId: paymentType === "bank" ? (bankAccountId || null) : null,
      currencyCode,
      exchangeRate, lcId: lcId || null, distributionMethod: distMethod,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      taxId: headerTaxId ? Number(headerTaxId) : null,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2), totalExpensesLoaded: totalExpLoaded.toFixed(2),
      totalAmount: (totalAmount + totalExpLoaded).toFixed(2),
      priceIncludesVat,
      notes: notes || null,
      // Header-level cost center — when set, the /post handler tags every
      // generated JE line with this code so cost-center reports pick it up.
      costCenter: costCenter || null,
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">{tr("loadingEdit")}</div>;

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
  ];
  // The dropdown label always shows the LC's GRAND TOTAL in the company's
  // base currency (LC amount + expenses, both already converted via IAS 21
  // historical rates by the server). For multi-currency LCs the user sees a
  // single SAR figure they can reason about, not a mix of USD/SAR.
  const lcItems = [
    { value: "", label: tr("noLcOpt") },
    ...lcs.filter((l: any) => l.status !== "closed").map((l: any) => {
      const grand = Number(l.totalAmountBase ?? l.totalAmount ?? 0)
                  + Number(l.totalExpensesBase ?? 0);
      const cur   = l.baseCurrency ?? defaultCurrency?.code ?? "SAR";
      return { value: String(l.id), label: `${l.lcNumber} (${cur} ${fmt(grand)})` };
    }),
  ];
  const itemComboItems = [
    { value: "", label: tr("itemSearchPh") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      code: i.code ?? undefined,
      label: itemNameOf(i),
    })),
  ];
  const unitItems = units.map((u: any) => ({ value: String(u.id), label: unitNameOf(u) }));

  const HEADERS = [
    tr("lineCols.itemCode"),
    tr("lineCols.item"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    t("salesDocForm.colFreeQty"),
    tr("lineCols.weight"),
    tr("lineCols.unitPrice"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.expenses"),
    tr("lineCols.finalCost"),
    "رقم الدفعة",
    "تاريخ الانتهاء",
    tr("lineCols.notes"),
    "",
  ];

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="space-y-5 max-w-6xl mx-auto" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/purchasing/invoices")}>
          {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <ShoppingCart className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{isNew ? tr("newTitle") : tr("editTitle", { id: editId })}</h1>
            <p className="text-xs text-muted-foreground">{tr("subtitle")}</p>
          </div>
        </div>
        <JournalScanArchive
          jeKey={(existing as any)?.docNumber ?? (editId ? `PI-${editId}` : "PI-new-draft")}
          companyName={user?.company?.nameAr ?? null}
        />
        {/* Posted/draft/cancelled status pill — visible only when editing
            an existing purchase invoice. */}
        {!isNew && (existing as any) && (
          <DocStatusBadge status={(existing as any).status} />
        )}
        {/* Smart prev/next + search navigator across every purchase invoice
            of the current company. Lets the user step through docs or jump
            to one by typing a recognizable fragment. */}
        <DocNavigator
          items={(allPurchaseInvoices as any[]).map((d: any) => {
            const s = (suppliers as any[]).find((s: any) => Number(s.id) === Number(d.supplierId));
            return {
              id: d.id,
              docNumber: d.docNumber,
              partyName: s ? (s.nameAr ?? s.nameEn ?? `#${s.id}`) : "—",
              date: d.invoiceDate ?? "",
              total: d.totalAmount ?? 0,
              currencyCode: d.currencyCode ?? "",
            };
          })}
          currentId={editId}
          basePath="/purchasing/invoices"
          fallbackPrefix="PI-"
          className="ms-auto"
        />
      </div>

      {!isNew && (existing as any)?.status === "posted" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm flex items-center gap-2">
          <Lock className="h-4 w-4" />
          <span>{tr("postedReadOnly")}</span>
        </div>
      )}
      <fieldset disabled={!isNew && (existing as any)?.status === "posted"} className="contents">
      <Tabs value={activeTab} onValueChange={setActiveTab} dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {tr("linesSummary", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount + totalExpLoaded) })}
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
                  <Label className="text-xs">{tr("fields.invoiceNumber")}</Label>
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
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.date")}</Label>
                  <DateField className="h-9 text-sm" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplier")}</Label>
                  <SearchCombobox items={supplierItems} value={supplierId} onValueChange={setSupplierId} placeholder={tr("fields.supplierPh")} />
                </div>
                <SupplierVatControl suppliers={suppliers} supplierId={supplierId} onSupplierChange={setSupplierId} />
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
                  <Label className="text-xs">{tr("fields.lc")}</Label>
                  <SearchCombobox items={lcItems} value={lcId} onValueChange={setLcId} placeholder={tr("fields.lcPh")} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.notes")}</Label>
                  <Input className="h-9 text-sm" value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">مركز التكلفة</Label>
                  <select
                    value={costCenter}
                    onChange={e => setCostCenter(e.target.value)}
                    data-testid="purchase-cost-center"
                    className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                  >
                    <option value="">— بدون مركز تكلفة —</option>
                    {(costCentersList as any[])
                      .filter((c: any) => c.isActive !== false)
                      .map((c: any) => (
                        <option key={c.id} value={c.code}>
                          {c.code} — {c.nameAr}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground">يُسند تلقائياً إلى كل سطور القيد عند الترحيل.</p>
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
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.paymentType")}</Label>
                  <Select value={paymentType} onValueChange={(v) => {
                    setPaymentType(v);
                    if (v === "cash") {
                      if (!cashBoxId) {
                        const first = [...(cashBoxes as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) setCashBoxId(String(first.id));
                      }
                      setBankAccountId("");
                    } else if (v === "bank") {
                      if (!bankAccountId) {
                        const first = [...(bankAccounts as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) setBankAccountId(String(first.id));
                      }
                      setCashBoxId("");
                    } else {
                      setCashBoxId("");
                      setBankAccountId("");
                    }
                  }}>
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
                        1 {currencyCode} = {Number(exchangeRate) > 0 ? Number(exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                      </span>
                    )}
                  </Label>
                  <Input type="text" inputMode="decimal" className="h-9 text-sm" dir="ltr"
                    value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.distributeMethod")}</Label>
                  <Select value={distMethod} onValueChange={setDistMethod}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">{tr("distribute.value")}</SelectItem>
                      <SelectItem value="qty">{tr("distribute.qty")}</SelectItem>
                      <SelectItem value="weight">{tr("distribute.weight")}</SelectItem>
                      <SelectItem value="manual">{tr("distribute.manual")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {paymentType === "bank" ? (
                (() => {
                  const balMap: Record<number, number> = Object.fromEntries(
                    (bankAccountBalances as any[]).map((b: any) => [b.bankAccountId, Number(b.balance)])
                  );
                  const activeBanks = (bankAccounts as any[]).filter((b: any) => b.isActive !== false);
                  const items = [
                    { value: "", label: tr("selectBank") },
                    ...activeBanks.map((b: any) => ({
                      value: String(b.id),
                      label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
                    })),
                  ];
                  const sel = activeBanks.find((b: any) => String(b.id) === bankAccountId);
                  const bal = sel ? (balMap[sel.id] ?? 0) : 0;
                  const totalDue = totalAmount + totalExpLoaded;
                  const remaining = bal - totalDue;
                  const insufficient = !!sel && remaining < 0;
                  return (
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{tr("bankAccount")}</Label>
                        <SearchCombobox items={items} value={bankAccountId} onValueChange={setBankAccountId} placeholder={tr("bankAccountPh")} />
                      </div>
                      <div className={cn(
                        "rounded-lg border p-3 flex items-start gap-3",
                        !bankAccountId ? "bg-amber-50 border-amber-200 text-amber-800" :
                        insufficient ? "bg-red-50 border-red-200 text-red-800" :
                        "bg-emerald-50 border-emerald-200 text-emerald-800"
                      )}>
                        <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                        {!bankAccountId ? (
                          <div className="text-xs">
                            <p className="font-semibold">{tr("bankPayTitle")}</p>
                            <p className="opacity-80 mt-0.5">{tr("bankPayDesc")}</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">{tr("accountLabel")}: <strong>{branchName(sel)}</strong></span>
                              <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" />{tr("balanceLabel")}: <strong className="font-mono">{fmt(bal)}</strong></span>
                              <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3" />{tr("withdrawn")}: <strong className="font-mono">{fmt(totalDue)}</strong></span>
                              <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>{tr("remaining")}: <strong className="font-mono">{fmt(remaining)}</strong></span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">{tr("balanceInsufficient")}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()
              ) : paymentType === "credit" ? (
                (() => {
                  const sup = suppliers.find((s: any) => String(s.id) === supplierId);
                  const balRow = supplierBalances.find((b: any) => b.supplierId === Number(supplierId));
                  const currentBal = balRow ? Number(balRow.balance) : 0;
                  const newBal = currentBal + (totalAmount + totalExpLoaded);
                  const creditLimit = sup ? Number(sup.creditLimit ?? 0) : 0;
                  const overLimit = creditLimit > 0 && newBal > creditLimit;
                  return (
                    <div className={cn(
                      "rounded-lg border p-3 flex items-start gap-3",
                      !supplierId ? "bg-amber-50 border-amber-200 text-amber-800" :
                      overLimit ? "bg-red-50 border-red-200 text-red-800" :
                      "bg-blue-50 border-blue-200 text-blue-800"
                    )}>
                      <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                      {!supplierId ? (
                        <div className="text-xs">
                          <p className="font-semibold">{tr("creditTitle")}</p>
                          <p className="opacity-80 mt-0.5">{tr("creditDesc")}</p>
                        </div>
                      ) : (
                        <div className="text-xs flex-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-semibold">{tr("supplierLabel")}: <strong>{supName(sup)}</strong></span>
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {tr("currentBalance")}: <strong className="font-mono">{fmt(currentBal)}</strong> {currencyCode}
                            </span>
                            <span className="flex items-center gap-1">
                              {tr("plusInvoice")}: <strong className="font-mono">{fmt(totalAmount + totalExpLoaded)}</strong>
                            </span>
                            <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                              {tr("balanceAfterPost")}: <strong className="font-mono">{fmt(newBal)}</strong> {currencyCode}
                            </span>
                          </div>
                          {creditLimit > 0 && (
                            <p className={cn("mt-1.5 text-[11px]", overLimit ? "font-semibold" : "opacity-80")}>
                              {overLimit ? "⚠ " : ""}{tr("creditLimit")}: <strong className="font-mono">{fmt(creditLimit)}</strong>
                              {overLimit && ` — ${tr("exceededBy", { amt: fmt(newBal - creditLimit) })}`}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const balMap: Record<number, number> = Object.fromEntries(
                    (cashBoxBalances as any[]).map((b: any) => [b.cashBoxId, Number(b.balance)])
                  );
                  const activeBoxes = (cashBoxes as any[]).filter((b: any) => b.isActive);
                  const cashBoxItems = [
                    { value: "", label: tr("selectCashBoxOpt") },
                    ...activeBoxes.map((b: any) => ({
                      value: String(b.id),
                      label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
                    })),
                  ];
                  const selBox = activeBoxes.find((b: any) => String(b.id) === cashBoxId);
                  const boxBal = selBox ? (balMap[selBox.id] ?? 0) : 0;
                  const totalDue = totalAmount + totalExpLoaded;
                  const remaining = boxBal - totalDue;
                  const insufficient = !!selBox && remaining < 0;
                  return (
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{tr("cashBox")}</Label>
                        <SearchCombobox items={cashBoxItems} value={cashBoxId} onValueChange={setCashBoxId} placeholder={tr("cashBoxPh")} />
                      </div>
                      <div className={cn(
                        "rounded-lg border p-3 flex items-start gap-3",
                        !cashBoxId ? "bg-amber-50 border-amber-200 text-amber-800" :
                        insufficient ? "bg-red-50 border-red-200 text-red-800" :
                        "bg-emerald-50 border-emerald-200 text-emerald-800"
                      )}>
                        <Wallet className="h-4 w-4 mt-0.5 shrink-0" />
                        {!cashBoxId ? (
                          <div className="text-xs">
                            <p className="font-semibold">{tr("cashPayTitle")}</p>
                            <p className="opacity-80 mt-0.5">{tr("cashPayDesc")}</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">{tr("cashBox").replace(" *", "")}: <strong>{branchName(selBox)}</strong></span>
                              <span className="flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                {tr("balanceLabel")}: <strong className="font-mono">{fmt(boxBal)}</strong>
                              </span>
                              <span className="flex items-center gap-1">
                                <TrendingDown className="h-3 w-3" />
                                {tr("withdrawn")}: <strong className="font-mono">{fmt(totalDue)}</strong>
                              </span>
                              <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                                {tr("remaining")}: <strong className={cn("font-mono", insufficient && "font-bold")}>{fmt(remaining)}</strong> {currencyCode}
                              </span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">
                                {tr("cashInsufficient", { amt: `${fmt(Math.abs(remaining))} ${currencyCode}` })}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      {activeBoxes.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {tr("noCashBoxes")}<strong>{tr("cashBanksMenu")}</strong>.
                        </p>
                      )}
                    </div>
                  );
                })()
              )}

              {selectedLc && (() => {
                // Show the LC balance entirely in the company base currency:
                // grand total (LC + expenses, both base) regardless of the LC's
                // own currency. This is the figure the user will load and finance.
                const baseCur   = selectedLc.baseCurrency ?? defaultCurrency?.code ?? "SAR";
                const lcBase    = Number(selectedLc.totalAmountBase   ?? selectedLc.totalAmount ?? 0);
                const expBase   = Number(selectedLc.totalExpensesBase ?? 0);
                const grandBase = lcBase + expBase;
                const usedBase  = Number(selectedLc.usedAmount ?? 0);
                const remGoods  = Math.max(0, lcBase - usedBase);
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>
                        {tr("lcInfo", { lc: selectedLc.lcNumber, remaining: `${fmt(grandBase)} ${baseCur}` })}
                      </span>
                      <Button type="button" size="sm" variant="outline" className={cn("h-6 text-xs border-blue-300 text-blue-700", isRtl ? "mr-auto" : "ml-auto")} onClick={distributeExpenses}>
                        {tr("lcDistribute")}
                      </Button>
                    </div>
                    {/* LC posting notice: explains that the supplier will NOT be
                        credited at posting time — the LC settlement account is
                        credited instead, and the LC usage is auto-updated. */}
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 leading-relaxed">
                      <strong className="block mb-1">{tr("lcPostingTitle")}</strong>
                      {tr("lcPostingNote", {
                        goods: `${fmt(remGoods)} ${baseCur}`,
                        used:  `${fmt(usedBase)} ${baseCur}`,
                        total: `${fmt(lcBase)} ${baseCur}`,
                      })}
                    </div>
                  </div>
                );
              })()}

            </CardContent>
          </TabsContent>

          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-2 pb-5 border-t">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{tr("linesTitle")} ({lines.filter(l => l.itemName).length})</span>
              </div>
              {(() => {
                const GRID_COLS = "110px minmax(260px,1.4fr) 160px 120px 90px 80px 80px 110px 80px 80px 110px 130px 120px 130px 180px 40px";
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
                        h === tr("lineCols.finalCost") ? "font-semibold text-primary" : "text-muted-foreground"
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
                      {isServiceLine(l) ? (
                        <div className="h-8 flex items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground" title={t("inventoryMaster.items.serviceNoStockHint") as string}>
                          {t("salesDocForm.serviceNoWarehouse")}
                        </div>
                      ) : warehouses.length > 0 ? (
                        <div className={cn("rounded-md", l.itemId && !l.warehouseId && "ring-1 ring-amber-400")}>
                          <SearchCombobox
                            items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn }))}
                            value={l.warehouseId}
                            onValueChange={v => updateLine(l._id, "warehouseId", v)}
                            placeholder={tr("lineCols.warehouse")}
                            searchPlaceholder="ابحث بالكود أو الاسم..."
                            className="h-8 text-xs"
                          />
                        </div>
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
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono"
                        type="text" inputMode="numeric" value={l.freeQty}
                        title={t("salesDocForm.colFreeQtyHint") as string}
                        onChange={e => updateLine(l._id, "freeQty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.weight}
                        onChange={e => updateLine(l._id, "weight", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.discount}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-blue-50 text-blue-700" readOnly value={fmt(l.expenseShare)} />
                      <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.finalCost)} />
                      {isServiceLine(l) ? (
                        <Input className="h-8 text-xs bg-muted/30" placeholder="—" readOnly />
                      ) : (
                        <Input className="h-8 text-xs" placeholder="رقم الدفعة" value={l.batchNumber}
                          onChange={e => updateLine(l._id, "batchNumber", e.target.value)} />
                      )}
                      {isServiceLine(l) ? (
                        <Input className="h-8 text-xs bg-muted/30" placeholder="—" readOnly />
                      ) : (
                        <DateField className="h-8 text-xs" value={l.expiryDate}
                          onChange={e => updateLine(l._id, "expiryDate", e.target.value)} />
                      )}
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
                  data-testid="price-includes-vat-toggle"
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
                    <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                      <span className="text-muted-foreground">{tr("itemDiscount")}</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("lcExpenses")}</span><span className="font-mono text-blue-700">{fmt(totalExpLoaded)}</span></div>
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount + totalExpLoaded)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt((totalAmount + totalExpLoaded) * Number(exchangeRate))}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button variant="outline" data-enter-skip="true" onClick={() => navigate("/purchasing/invoices")}>
          {!isNew && (existing as any)?.status === "posted" ? tr("back") : tr("cancel")}
        </Button>
        {!(!isNew && (existing as any)?.status === "posted") && (
          <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending}>
            {saveMut.isPending ? tr("saving") : isNew ? tr("saveInvoice") : tr("saveEdit")}
          </Button>
        )}
      </div>
    </div>
  );
}
