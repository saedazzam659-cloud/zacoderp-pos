import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useAutoFocusOnMount } from "@/hooks/useAutoFocusOnMount";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { AccountCombobox } from "@/components/AccountCombobox";
import { DiscountRow } from "@/components/DiscountRow";
import { SupplierVatControl } from "@/components/SupplierVatControl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, ShoppingCart, Plus, Trash2, FileText, ListOrdered, AlertCircle, Wallet, CreditCard, TrendingUp, TrendingDown } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
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
  weight: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  lineTotal: string;
  expenseShare: string;
  finalCost: string;
  notes: string;
}

function newLine(): InvoiceLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", weight: "0", unitPrice: "0", discount: "0", vatRate: "15",
    lineTotal: "0", expenseShare: "0", finalCost: "0", notes: "",
  };
}

function calcLine(l: InvoiceLine, priceIncludesVat = false) {
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

export default function PurchaseInvoiceForm() {
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
  const [paymentType,  setPaymentType]  = useState("credit");
  const [cashBoxId,    setCashBoxId]    = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [lcId,         setLcId]         = useState("");
  const [distMethod,   setDistMethod]   = useState("value");
  const [notes,        setNotes]        = useState("");
  const [docDiscount,  setDocDiscount]  = useState("0");
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [lines,        setLines]        = useState<InvoiceLine[]>([newLine()]);
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

  // Accounting accounts (used to build the journal entry on post)
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

  // ── Lookups ─────────────────────────────────────────────
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

  const { data: lcs = [] } = useQuery<any[]>({
    queryKey: ["lc", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/purchasing/letters-of-credit?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit`, { headers: authH }); return r.json(); },
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

  // ── Supplier balances (for credit payment) ───────────────
  const { data: supplierBalances = [] } = useQuery<any[]>({
    queryKey: ["supplier-balances", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/suppliers/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && paymentType === "credit",
  });

  // ── Cash boxes + balances (for cash payment) ─────────────
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: cashBoxBalances = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/cash-boxes/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && paymentType === "bank",
  });
  const { data: bankAccountBalances = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts-bal", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && paymentType === "bank",
  });

  // ── Currency helpers ─────────────────────────────────────
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

  // Set default currency on first load
  useEffect(() => {
    if (!isNew || !defaultCurrency || currencyCode) return;
    setCurrencyCode(defaultCurrency.code);
  }, [isNew, defaultCurrency?.code]);

  // ── Load existing invoice ────────────────────────────────
  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["purchase-invoice", editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/purchasing/purchase-invoices/${editId}?companyId=${cid}`, { headers: authH });
      return r.json();
    },
    enabled: !!editId,
  });

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
    setDocDiscount(String(existing.discountAmount ?? "0"));
    setPriceIncludesVat(!!existing.priceIncludesVat);
    setInventoryAccountId(existing.inventoryAccountId ? String(existing.inventoryAccountId) : "");
    setTaxAccountId(existing.taxAccountId ? String(existing.taxAccountId) : "");
    setDiscountAccountId(existing.discountAccountId ? String(existing.discountAccountId) : "");
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
      weight:      String(l.weight ?? "0"),
      unitPrice:   String(l.unitPrice),
      discount:    String(l.discount ?? "0"),
      vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      expenseShare:String(l.expenseShare ?? "0"),
      finalCost:   String(l.finalCost ?? "0"),
      notes:       l.notes ?? "",
    })) : [newLine()]);
  }, [existing]);

  // ── Duplicate from another invoice (?from=<id> on /new) ──
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
          vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal),
          expenseShare:String(l.expenseShare ?? "0"),
          finalCost:   String(l.finalCost ?? "0"),
          notes:       l.notes ?? "",
        })) : [newLine()]);
        toast({ title: "✓ تم إنشاء نسخة مماثلة — راجع البيانات قبل الحفظ" });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, user, cid]);

  // ── Line helpers ─────────────────────────────────────────
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

  // Cache item-specific unit prices: itemId → rows
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/units?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemUnitsMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) { updateLine(lineId, "itemId", ""); return; }
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const updated: InvoiceLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  item.nameAr ?? "",
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      base?.unit?.nameAr ?? fallbackUnit?.nameAr ?? "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: trimTrailingZeros(base?.costPrice ?? item.costPrice ?? "0"),
        vatRate:   (Number(item.vatRate) > 0 ? String(item.vatRate) : "15"),
      };
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
        unit: row?.unit?.nameAr ?? globalUnit?.nameAr ?? "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.costPrice != null ? trimTrailingZeros(row.costPrice) : l.unitPrice,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  function distributeExpenses() {
    if (!selectedLc || !lines.length) return;
    const totalBase = distMethod === "qty"
      ? lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
      : lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
    if (!totalBase) return;
    const totalLcExpenses = Number(selectedLc.totalExpensesLoaded ?? 0);
    setLines(prev => prev.map(l => {
      const base = distMethod === "qty" ? Number(l.qty) : Number(l.lineTotal);
      const share = (base / totalBase) * totalLcExpenses;
      const finalCost = Number(l.lineTotal) + share;
      return { ...l, expenseShare: share.toFixed(2), finalCost: finalCost.toFixed(2) };
    }));
  }

  // ── Totals ───────────────────────────────────────────────
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

  // ── Save ─────────────────────────────────────────────────
  const autoPostingEnabled = (user as any)?.company?.autoPostingEnabled !== false;
  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/purchasing/purchase-invoices/${editId}` : `${API}/api/purchasing/purchase-invoices`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);

      // Auto-post (ترحيل) after save only when enabled system-wide and still draft
      if (autoPostingEnabled && j?.id && (j.status ?? "draft") === "draft") {
        const postRes = await fetch(`${API}/api/purchasing/purchase-invoices/${j.id}/post`, {
          method: "PATCH", headers,
        });
        const postJson = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          throw new Error(`تم الحفظ ولكن فشل الترحيل: ${postJson.error || postRes.statusText}`);
        }
        return postJson;
      }
      return j;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: autoPostingEnabled
        ? (isNew ? "✓ تم إنشاء الفاتورة وترحيلها" : "✓ تم الحفظ والترحيل")
        : (isNew ? "✓ تم إنشاء الفاتورة (مسودة — بحاجة إلى ترحيل يدوي)" : "✓ تم الحفظ (مسودة — بحاجة إلى ترحيل يدوي)")
      });
      navigate("/purchasing/invoices");
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function handleSave() {
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
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2), totalExpensesLoaded: totalExpLoaded.toFixed(2),
      totalAmount: (totalAmount + totalExpLoaded).toFixed(2),
      priceIncludesVat,
      notes: notes || null,
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">جارٍ التحميل...</div>;

  // ── Combobox data ────────────────────────────────────────
  const supplierItems = [
    { value: "", label: "— بدون مورد —" },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: s.nameAr })),
  ];
  const lcItems = [
    { value: "", label: "— بدون اعتماد —" },
    ...lcs.filter((l: any) => l.status !== "closed").map((l: any) => ({
      value: String(l.id), label: `${l.lcNumber} (${l.currencyCode} ${fmt(l.totalAmount)})`,
    })),
  ];
  const itemComboItems = [
    { value: "", label: "— اختر صنف —" },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      label: i.code ? `${i.code} — ${i.nameAr}` : i.nameAr,
    })),
  ];
  const unitItems = units.map((u: any) => ({ value: String(u.id), label: u.nameAr }));

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="space-y-5 max-w-6xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/purchasing/invoices")}>
          <ArrowRight className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <ShoppingCart className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{isNew ? "فاتورة مشتريات جديدة" : `تعديل الفاتورة #${editId}`}</h1>
            <p className="text-xs text-muted-foreground">إنشاء فاتورة مشتريات مع تحميل مصاريف الاعتماد</p>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {`${lines.filter(l => l.itemName).length} صنف — إجمالي: ${fmt(totalAmount + totalExpLoaded)}`}
              </p>
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                  <FileText className="h-3.5 w-3.5" />البيانات الرأسية
                </TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>

          {/* ── Header Tab ──────────────────────────────────── */}
          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">رقم الفاتورة</Label>
                  <Input ref={docNumberRef} className="h-9 text-sm" placeholder="تلقائي" value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">التاريخ *</Label>
                  <Input type="date" className="h-9 text-sm" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">المورد</Label>
                  <SearchCombobox items={supplierItems} value={supplierId} onValueChange={setSupplierId} placeholder="اختر المورد..." />
                </div>
                <SupplierVatControl suppliers={suppliers} supplierId={supplierId} onSupplierChange={setSupplierId} />
                <div className="space-y-1.5">
                  <Label className="text-xs">رقم فاتورة المورد</Label>
                  <Input className="h-9 text-sm" placeholder="رقم الفاتورة لدى المورد" value={supplierInvoiceNumber} onChange={e => setSupplierInvoiceNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">الفرع</Label>
                  <Select value={branchId || undefined} onValueChange={setBranchId}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="اختر الفرع..." /></SelectTrigger>
                    <SelectContent>
                      {(branches as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? " (الرئيسي)" : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">الاعتماد المستندي (اختياري)</Label>
                  <SearchCombobox items={lcItems} value={lcId} onValueChange={setLcId} placeholder="— بدون اعتماد —" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">ملاحظات</Label>
                  <Input className="h-9 text-sm" value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">نوع الدفع *</Label>
                  <Select value={paymentType} onValueChange={(v) => { setPaymentType(v); if (v !== "cash") setCashBoxId(""); if (v !== "bank") setBankAccountId(""); }}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="credit">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />آجل (على الحساب)</span>
                      </SelectItem>
                      <SelectItem value="cash">
                        <span className="flex items-center gap-2"><Wallet className="h-3.5 w-3.5" />نقدي (من الخزنة)</span>
                      </SelectItem>
                      <SelectItem value="bank">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />بنكي (من حساب بنكي)</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Currency from currencies screen */}
                <div className="space-y-1.5">
                  <Label className="text-xs">العملة</Label>
                  {currencies.length > 0 ? (
                    <Select value={currencyCode} onValueChange={handleCurrencyChange}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="العملة..." /></SelectTrigger>
                      <SelectContent>
                        {currencies.map((c: any) => (
                          <SelectItem key={c.id} value={c.code}>
                            {c.code} {c.nameAr ? `— ${c.nameAr}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-9 text-sm" placeholder="SAR" value={currencyCode} onChange={e => setCurrencyCode(e.target.value)} />
                  )}
                </div>

                {/* Exchange rate — auto-filled from currency screen rates */}
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center justify-between">
                    <span>سعر الصرف</span>
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

                <div className="space-y-1.5">
                  <Label className="text-xs">طريقة التوزيع</Label>
                  <Select value={distMethod} onValueChange={setDistMethod}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">حسب القيمة</SelectItem>
                      <SelectItem value="qty">حسب الكمية</SelectItem>
                      <SelectItem value="weight">حسب الوزن</SelectItem>
                      <SelectItem value="manual">يدوي</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Payment link: supplier (credit), cash box (cash), or bank (bank) */}
              {paymentType === "bank" ? (
                (() => {
                  const balMap: Record<number, number> = Object.fromEntries(
                    (bankAccountBalances as any[]).map((b: any) => [b.bankAccountId, Number(b.balance)])
                  );
                  const activeBanks = (bankAccounts as any[]).filter((b: any) => b.isActive !== false);
                  const items = [
                    { value: "", label: "— اختر الحساب البنكي —" },
                    ...activeBanks.map((b: any) => ({
                      value: String(b.id),
                      label: `${b.nameAr ?? b.nameEn ?? `#${b.id}`} — رصيد: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
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
                        <Label className="text-xs">الحساب البنكي *</Label>
                        <SearchCombobox items={items} value={bankAccountId} onValueChange={setBankAccountId} placeholder="اختر الحساب البنكي..." />
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
                            <p className="font-semibold">الدفع بنكي — اختر الحساب البنكي لخصم المبلغ منه</p>
                            <p className="opacity-80 mt-0.5">عند ترحيل الفاتورة سيتم خصم القيمة من رصيد الحساب البنكي المختار.</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">الحساب: <strong>{sel?.nameAr ?? sel?.nameEn}</strong></span>
                              <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" />الرصيد: <strong className="font-mono">{fmt(bal)}</strong></span>
                              <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3" />المسحوب: <strong className="font-mono">{fmt(totalDue)}</strong></span>
                              <span className="flex items-center gap-1 border-r pr-3 mr-1">المتبقي: <strong className="font-mono">{fmt(remaining)}</strong></span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">⚠ الرصيد غير كافٍ</p>
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
                          <p className="font-semibold">الدفع آجل — اختر المورد لربط الفاتورة بحسابه</p>
                          <p className="opacity-80 mt-0.5">سيتم تسجيل المبلغ على حساب المورد كذمّة دائنة.</p>
                        </div>
                      ) : (
                        <div className="text-xs flex-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-semibold">المورد: <strong>{sup?.nameAr ?? "—"}</strong></span>
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              الرصيد الحالي: <strong className="font-mono">{fmt(currentBal)}</strong> {currencyCode}
                            </span>
                            <span className="flex items-center gap-1">
                              + قيمة الفاتورة: <strong className="font-mono">{fmt(totalAmount + totalExpLoaded)}</strong>
                            </span>
                            <span className="flex items-center gap-1 border-r pr-3 mr-1">
                              الرصيد بعد الترحيل: <strong className="font-mono">{fmt(newBal)}</strong> {currencyCode}
                            </span>
                          </div>
                          {creditLimit > 0 && (
                            <p className={cn("mt-1.5 text-[11px]", overLimit ? "font-semibold" : "opacity-80")}>
                              {overLimit ? "⚠ " : ""}سقف الائتمان: <strong className="font-mono">{fmt(creditLimit)}</strong>
                              {overLimit && ` — تجاوز بمقدار ${fmt(newBal - creditLimit)}`}
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
                    { value: "", label: "— اختر الخزنة —" },
                    ...activeBoxes.map((b: any) => ({
                      value: String(b.id),
                      label: `${b.nameAr} — رصيد: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
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
                        <Label className="text-xs">الخزنة *</Label>
                        <SearchCombobox items={cashBoxItems} value={cashBoxId} onValueChange={setCashBoxId} placeholder="اختر الخزنة..." />
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
                            <p className="font-semibold">الدفع نقدي — اختر الخزنة لخصم المبلغ منها</p>
                            <p className="opacity-80 mt-0.5">عند ترحيل الفاتورة سيتم خصم القيمة من رصيد الخزنة المختارة.</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">الخزنة: <strong>{selBox?.nameAr}</strong></span>
                              <span className="flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                الرصيد: <strong className="font-mono">{fmt(boxBal)}</strong>
                              </span>
                              <span className="flex items-center gap-1">
                                <TrendingDown className="h-3 w-3" />
                                المسحوب: <strong className="font-mono">{fmt(totalDue)}</strong>
                              </span>
                              <span className="flex items-center gap-1 border-r pr-3 mr-1">
                                المتبقي: <strong className={cn("font-mono", insufficient && "font-bold")}>{fmt(remaining)}</strong> {currencyCode}
                              </span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">
                                ⚠ رصيد الخزنة غير كافٍ — العجز {fmt(Math.abs(remaining))} {currencyCode}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      {activeBoxes.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          لا توجد خزن نشطة. يرجى إضافة خزنة من <strong>النقد والبنوك ← الخزن</strong>.
                        </p>
                      )}
                    </div>
                  );
                })()
              )}

              {/* LC info banner */}
              {selectedLc && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    الاعتماد: <strong>{selectedLc.lcNumber}</strong> | المتبقي: <strong>{fmt(Number(selectedLc.totalAmount) - Number(selectedLc.usedAmount))}</strong> {selectedLc.currencyCode}
                  </span>
                  <Button type="button" size="sm" variant="outline" className="mr-auto h-6 text-xs border-blue-300 text-blue-700" onClick={distributeExpenses}>
                    توزيع المصاريف
                  </Button>
                </div>
              )}

            </CardContent>
          </TabsContent>

          {/* ── Lines section (rendered below header data in same tab) ─── */}
          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-2 pb-5 border-t">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>الأصناف ({lines.filter(l => l.itemName).length})</span>
              </div>
              {(() => {
                const GRID_COLS = "220px 110px 160px 120px 90px 80px 110px 80px 80px 110px 130px 180px 40px";
                const HEADERS = ["الصنف", "كود الصنف", "المستودع", "الوحدة", "الكمية", "وزن", "سعر الوحدة", "خصم%", "ضريبة%", "مصاريف", "التكلفة النهائية", "ملاحظات", ""];
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
                        h === "التكلفة النهائية" ? "font-semibold text-primary" : "text-muted-foreground"
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
                          placeholder="اختر أو ابحث عن صنف..."
                        />
                      ) : (
                        <Input className="h-8 text-xs" placeholder="اسم الصنف" value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      <Input className="h-8 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder="تلقائي" value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      {warehouses.length > 0 ? (
                        <Select value={l.warehouseId || undefined} onValueChange={v => updateLine(l._id, "warehouseId", v)}>
                          <SelectTrigger className={cn("h-8 text-xs", l.itemId && !l.warehouseId && "border-amber-400")}>
                            <SelectValue placeholder="اختر مستودع..." />
                          </SelectTrigger>
                          <SelectContent>
                            {warehouses.map((w: any) => (
                              <SelectItem key={w.id} value={String(w.id)}>{w.nameAr}</SelectItem>
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
                              label: `${iu.unit?.nameAr ?? ""}${Number(iu.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(iu.conversionFactor)})` : ""}`,
                            }))
                          : unitItems;
                        return units.length > 0 ? (
                          <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="الوحدة" /></SelectTrigger>
                            <SelectContent>
                              {opts.map((u: any) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder="وحدة" value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
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
                <Plus className="h-4 w-4" />إضافة صنف
              </Button>

              {/* Totals */}
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
                    onChange={e => setPriceIncludesVat(e.target.checked)}
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold">السعر شامل الضريبة</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {priceIncludesVat
                        ? "السعر المُدخل يتضمن الضريبة — يستخرج النظام قيمة الضريبة من المبلغ"
                        : "السعر المُدخل بدون ضريبة — يضيف النظام الضريبة فوق المبلغ"}
                    </p>
                  </div>
                </label>

                <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                    <span>طريقة الحساب</span>
                    <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                      {priceIncludesVat ? "شامل الضريبة" : "غير شامل الضريبة"}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">المجموع الفرعي</span><span className="font-mono">{fmt(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">الضريبة</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                      <span className="text-muted-foreground">خصم الأصناف</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} />
                  <div className="flex justify-between"><span className="text-muted-foreground">مصاريف الاعتماد</span><span className="font-mono text-blue-700">{fmt(totalExpLoaded)}</span></div>
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>الإجمالي{priceIncludesVat ? " (شامل)" : ""}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount + totalExpLoaded)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      المكافئ بـ {defaultCurrency?.code ?? "SAR"}: {fmt((totalAmount + totalExpLoaded) / Number(exchangeRate))}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>

      {/* Footer actions */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-enter-skip="true" onClick={() => navigate("/purchasing/invoices")}>إلغاء</Button>
        <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending}>
          {saveMut.isPending ? "جاري الحفظ..." : isNew ? "حفظ الفاتورة" : "حفظ التعديل"}
        </Button>
      </div>
    </div>
  );
}

