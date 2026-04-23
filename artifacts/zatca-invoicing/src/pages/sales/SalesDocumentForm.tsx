import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { useAutoFocusOnMount } from "@/hooks/useAutoFocusOnMount";
import { useRoute, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useFormatters } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { CustomerVatControl } from "@/components/CustomerVatControl";
import { DiscountRow } from "@/components/DiscountRow";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft, ShoppingBag, FileSignature, Plus, Trash2, FileText, ListOrdered, Calculator } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface DocLine {
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

function newLine(): DocLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", unitPrice: "0", discount: "0", vatRate: "15",
    lineTotal: "0", notes: "",
  };
}

// When `priceIncludesVat` is true, the entered unitPrice already contains VAT.
//   gross    = qty * unitPrice * (1 - disc/100)        ← gross is the displayed line total
//   net      = gross / (1 + vatRate/100)               ← VAT-exclusive subtotal
//   vat      = gross - net
// When false (default), the entered unitPrice is VAT-exclusive — VAT is added on top.
function calcLine(l: DocLine, priceIncludesVat = false) {
  const qty   = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const disc  = Number(l.discount) || 0;
  const rate  = (Number(l.vatRate) || 0) / 100;
  const gross = qty * price * (1 - disc / 100);
  if (priceIncludesVat) {
    const net = rate > -1 ? gross / (1 + rate) : gross;
    const vat = gross - net;
    return { subtotal: net, vat, lineTotal: gross };
  }
  const vat = gross * rate;
  return { subtotal: gross, vat, lineTotal: gross + vat };
}

export interface SalesDocumentFormProps {
  mode: "invoice" | "quotation";
}

export default function SalesDocumentForm({ mode }: SalesDocumentFormProps) {
  const isInvoice = mode === "invoice";
  const basePath  = isInvoice ? "/sales/invoices"   : "/sales/quotations";
  const apiPath   = isInvoice ? "sales-invoices"    : "sales-quotations";
  const queryKey  = isInvoice ? "sales-invoice"     : "sales-quotation";

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [matchNew]            = useRoute(`${basePath}/new`);
  const [matchEdit, params]   = useRoute(`${basePath}/:id`);
  const isNew  = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;

  const [activeTab, setActiveTab]       = useState("header");
  const [docNumber, setDocNumber]       = useState("");
  const [docDate,   setDocDate]         = useState(today());
  const [validUntil,setValidUntil]      = useState("");
  const [customerId,setCustomerId]      = useState("");
  const [branchId,  setBranchId]        = useState("");
  const [paymentType,setPaymentType]    = useState("credit");
  const [cashBoxId, setCashBoxId]       = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currencyCode,setCurrencyCode]  = useState("");
  const [exchangeRate,setExchangeRate]  = useState("1");
  const [notes,     setNotes]           = useState("");
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [docDiscount, setDocDiscount]   = useState("0");
  const [lines,     setLines]           = useState<DocLine[]>(() => {
    const l = newLine();
    return [l];
  });
  const [focusLineId, setFocusLineId] = useState<string>(() => lines[0]?._id ?? "");
  const addLine = () => {
    const l = newLine();
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  const { containerRef: enterNavRef, onKeyDown: enterNavKey } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  // Accounts used to build journal entry on posting (invoices only)
  const [cogsAccountId,      setCogsAccountId]      = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [salesAccountId,     setSalesAccountId]     = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [discountAccountId,  setDiscountAccountId]  = useState("");

  // Persist last-used accounts per company so new invoices auto-fill them
  const acctPrefsKey = `sales-invoice-accts:${cid ?? "all"}`;
  useEffect(() => {
    if (!isNew || !isInvoice) return;
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.salesAccountId    && !salesAccountId)    setSalesAccountId(String(p.salesAccountId));
      if (p.cogsAccountId     && !cogsAccountId)     setCogsAccountId(String(p.cogsAccountId));
      if (p.inventoryAccountId&& !inventoryAccountId)setInventoryAccountId(String(p.inventoryAccountId));
      if (p.taxAccountId      && !taxAccountId)      setTaxAccountId(String(p.taxAccountId));
      if (p.discountAccountId && !discountAccountId) setDiscountAccountId(String(p.discountAccountId));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, isInvoice, cid]);

  useEffect(() => {
    if (!isInvoice) return;
    if (!salesAccountId && !cogsAccountId && !inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({
        salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId,
      }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId]);

  // Lookups
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
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
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`, { headers: authH }); return r.json(); },
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: authH }); return r.json(); },
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
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id))
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }
  function handleCurrencyChange(code: string) { setCurrencyCode(code); setExchangeRate(getLatestRate(code)); }

  useEffect(() => {
    if (!isNew || !defaultCurrency || currencyCode) return;
    setCurrencyCode(defaultCurrency.code);
  }, [isNew, defaultCurrency?.code]);

  // Load existing
  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: [queryKey, editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales/${apiPath}/${editId}?companyId=${cid}`, { headers: authH });
      return r.json();
    },
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber ?? "");
    setDocDate((isInvoice ? existing.invoiceDate : existing.quotationDate) ?? today());
    if (!isInvoice) setValidUntil(existing.validUntil ?? "");
    setCustomerId(existing.customerId ? String(existing.customerId) : "");
    if (isInvoice) setBranchId(existing.branchId ? String(existing.branchId) : "");
    if (isInvoice) setPaymentType(existing.paymentType ?? "credit");
    if (isInvoice) setCashBoxId(existing.cashBoxId ? String(existing.cashBoxId) : "");
    if (isInvoice) setBankAccountId(existing.bankAccountId ? String(existing.bankAccountId) : "");
    setCurrencyCode(existing.currencyCode ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setNotes(existing.notes ?? "");
    setPriceIncludesVat(!!existing.priceIncludesVat);
    setDocDiscount(String(existing.discountAmount ?? "0"));
    if (isInvoice) {
      setCogsAccountId(existing.cogsAccountId ? String(existing.cogsAccountId) : "");
      setInventoryAccountId(existing.inventoryAccountId ? String(existing.inventoryAccountId) : "");
      setSalesAccountId(existing.salesAccountId ? String(existing.salesAccountId) : "");
      setTaxAccountId(existing.taxAccountId ? String(existing.taxAccountId) : "");
      setDiscountAccountId(existing.discountAccountId ? String(existing.discountAccountId) : "");
    }
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
      vatRate:     String(l.vatRate ?? "15"),
      lineTotal:   String(l.lineTotal),
      notes:       l.notes ?? "",
    })) : [newLine()]);
  }, [existing]);

  // ── Duplicate from another document (?from=<id> on /new) ──
  const duplicatedRef = useRef(false);
  useEffect(() => {
    if (!isNew || duplicatedRef.current || !user) return;
    const params = new URLSearchParams(window.location.search);
    const fromId = params.get("from");
    if (!fromId) return;
    duplicatedRef.current = true;

    (async () => {
      try {
        const r = await fetch(`${API}/api/sales/${apiPath}/${fromId}?companyId=${cid}`, { headers: authH });
        if (!r.ok) return;
        const src = await r.json();
        setDocNumber("");
        setDocDate(today());
        if (!isInvoice) setValidUntil("");
        setCustomerId(src.customerId ? String(src.customerId) : "");
        if (isInvoice) setBranchId(src.branchId ? String(src.branchId) : "");
        if (isInvoice) setPaymentType(src.paymentType ?? "credit");
        if (isInvoice) setCashBoxId(src.cashBoxId ? String(src.cashBoxId) : "");
        if (isInvoice) setBankAccountId(src.bankAccountId ? String(src.bankAccountId) : "");
        setCurrencyCode(src.currencyCode ?? "SAR");
        setExchangeRate(String(src.exchangeRate ?? "1"));
        setNotes(src.notes ?? "");
        setPriceIncludesVat(!!src.priceIncludesVat);
        setDocDiscount(String(src.discountAmount ?? "0"));
        if (isInvoice) {
          setCogsAccountId(src.cogsAccountId ? String(src.cogsAccountId) : "");
          setInventoryAccountId(src.inventoryAccountId ? String(src.inventoryAccountId) : "");
          setSalesAccountId(src.salesAccountId ? String(src.salesAccountId) : "");
          setTaxAccountId(src.taxAccountId ? String(src.taxAccountId) : "");
          setDiscountAccountId(src.discountAccountId ? String(src.discountAccountId) : "");
        }
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
          unitPrice:   String(l.unitPrice),
          discount:    String(l.discount ?? "0"),
          vatRate:     String(l.vatRate ?? "15"),
          lineTotal:   String(l.lineTotal),
          notes:       l.notes ?? "",
        })) : [newLine()]);
        toast({ title: t("salesDocForm.toastDuplicated") });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, user, cid]);

  function updateLine(id: string, field: keyof DocLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const updated = { ...l, [field]: value };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  // Recompute every line's lineTotal whenever the inclusive/exclusive flag changes
  useEffect(() => {
    setLines(prev => prev.map(l => {
      const { lineTotal } = calcLine(l, priceIncludesVat);
      return { ...l, lineTotal: lineTotal.toFixed(2) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceIncludesVat]);

  // Cache item-specific unit prices: itemId → [{ unitId, unit:{id,nameAr}, conversionFactor, salePrice, costPrice, isBase }]
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
    // Pick base unit (or first configured, or fallback to item's default unit)
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    const chosenUnitId = base?.unitId ?? item.unitId ?? null;
    const chosenUnitName = base?.unit?.nameAr ?? fallbackUnit?.nameAr ?? "";
    const chosenPrice = base?.salePrice ?? item.sellPrice ?? item.price ?? "0";
    const chosenFactor = base?.conversionFactor ?? "1";

    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const updated: DocLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  item.nameAr ?? "",
        itemCode:  item.code   ?? "",
        unitId:    chosenUnitId ? String(chosenUnitId) : "",
        unit:      chosenUnitName,
        conversionFactor: String(chosenFactor),
        unitPrice: trimTrailingZeros(chosenPrice),
        vatRate:   String(item.vatRate ?? "15"),
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
      const updated: DocLine = {
        ...l,
        unitId: newUnitId,
        unit: row?.unit?.nameAr ?? globalUnit?.nameAr ?? "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        // If item has this unit configured, snap to its salePrice
        unitPrice: row?.salePrice != null ? trimTrailingZeros(row.salePrice) : l.unitPrice,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  const subtotal    = lines.reduce((s, l) => s + calcLine(l, priceIncludesVat).subtotal, 0);
  const vatAmount   = lines.reduce((s, l) => s + calcLine(l, priceIncludesVat).vat,      0);
  const lineDiscountTotal = lines.reduce((s, l) => {
    const noDisc = calcLine({ ...l, discount: "0" }, priceIncludesVat).lineTotal;
    const withDisc = calcLine(l, priceIncludesVat).lineTotal;
    return s + Math.max(0, noDisc - withDisc);
  }, 0);
  const grossTotal  = subtotal + vatAmount;
  const discountAmt = Math.max(0, Math.min(grossTotal, Number(docDiscount) || 0));
  const totalAmount = grossTotal - discountAmt;

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/sales/${apiPath}/${editId}` : `${API}/api/sales/${apiPath}`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);

      // Auto-post immediately after save for invoices only (not quotations)
      if (isInvoice && j?.id && (j.status ?? "draft") === "draft") {
        const postRes = await fetch(`${API}/api/sales/${apiPath}/${j.id}/post`, {
          method: "PATCH", headers,
        });
        const postJson = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          throw new Error(postJson.error || postRes.statusText);
        }
        return postJson;
      }
      return j;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [isInvoice ? "sales-invoices" : "sales-quotations"] });
      toast({ title: isNew
        ? (isInvoice ? t("salesDocForm.toastInvoiceCreated") : t("salesDocForm.toastQuotationCreated"))
        : (isInvoice ? t("salesDocForm.toastInvoiceSaved")  : t("salesDocForm.toastQuotationSaved")) });
      navigate(basePath);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function handleSave() {
    const base: any = {
      companyId: cid, docNumber: docNumber || null,
      customerId: customerId || null, currencyCode, exchangeRate,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: discountAmt.toFixed(2), totalAmount: totalAmount.toFixed(2),
      priceIncludesVat,
      notes: notes || null,
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    };
    if (isInvoice) {
      base.invoiceDate = docDate;
      base.paymentType = paymentType;
      base.cashBoxId = paymentType === "cash" ? (cashBoxId || null) : null;
      base.bankAccountId = paymentType === "bank" ? (bankAccountId || null) : null;
      base.branchId = branchId || null;
      base.cogsAccountId      = cogsAccountId      ? Number(cogsAccountId)      : null;
      base.inventoryAccountId = inventoryAccountId ? Number(inventoryAccountId) : null;
      base.salesAccountId     = salesAccountId     ? Number(salesAccountId)     : null;
      base.taxAccountId       = taxAccountId       ? Number(taxAccountId)       : null;
      base.discountAccountId  = discountAccountId  ? Number(discountAccountId)  : null;
    } else {
      base.quotationDate = docDate;
      base.validUntil = validUntil || null;
    }
    saveMut.mutate(base);
  }

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">{t("common.loadingShort")}</div>;

  const customerComboItems = [
    { value: "", label: t("salesDocForm.noCustomer") },
    ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` })),
  ];
  const itemComboItems = [
    { value: "", label: t("salesDocForm.selectItem") },
    ...inventoryItems.map((i: any) => ({ value: String(i.id), label: i.code ? `${i.code} — ${i.nameAr}` : i.nameAr })),
  ];
  const unitItems = units.map((u: any) => ({ value: String(u.id), label: u.nameAr }));

  const Icon  = isInvoice ? ShoppingBag : FileSignature;
  const title = isNew
    ? (isInvoice ? t("salesDocForm.newInvoice") : t("salesDocForm.newQuotation"))
    : (isInvoice ? t("salesDocForm.editInvoice", { id: editId }) : t("salesDocForm.editQuotation", { id: editId }));
  const subtitle = isInvoice
    ? t("salesDocForm.subtitleInvoice")
    : t("salesDocForm.subtitleQuotation");

  const linesSection = (
    <div className="pt-2 space-y-3">
              <div data-enter-nav-container="lines" className="space-y-1.5">
                {(() => {
                  const gridCols = isInvoice
                    ? "2.2fr 1fr 1.4fr 1.1fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.4fr auto"
                    : "2.6fr 1fr 1.2fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.5fr auto";
                  const totalLabel = t("salesDocForm.colTotal");
                  const headers = isInvoice
                    ? [t("salesDocForm.colItem"), t("salesDocForm.colItemCode"), t("salesDocForm.colWarehouse"), t("salesDocForm.colUnit"), t("salesDocForm.colQty"), t("salesDocForm.colPrice"), t("salesDocForm.colDiscPct"), t("salesDocForm.colVatPct"), totalLabel, t("salesDocForm.colNotes"), ""]
                    : [t("salesDocForm.colItem"), t("salesDocForm.colItemCode"), t("salesDocForm.colUnit"), t("salesDocForm.colQty"), t("salesDocForm.colPrice"), t("salesDocForm.colDiscPct"), t("salesDocForm.colVatPct"), totalLabel, t("salesDocForm.colNotes"), ""];
                  return (
                    <div className="grid gap-1.5 px-2 pb-1" style={{ gridTemplateColumns: gridCols }}>
                      {headers.map((h, i) => (
                        <p key={i} className={cn("text-[10px]", h === totalLabel ? "font-semibold text-primary" : "text-muted-foreground")}>{h}</p>
                      ))}
                    </div>
                  );
                })()}
                {lines.map(l => (
                  <div key={l._id} className="rounded-lg border bg-muted/20 p-2">
                    <div
                      className="grid gap-1.5 items-center"
                      style={{
                        gridTemplateColumns: isInvoice
                          ? "2.2fr 1fr 1.4fr 1.1fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.4fr auto"
                          : "2.6fr 1fr 1.2fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.5fr auto",
                      }}
                    >
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox items={itemComboItems} value={l.itemId} onValueChange={v => selectItem(l._id, v)} placeholder={t("salesDocForm.itemPlaceholder")} />
                      ) : (
                        <Input className="h-8 text-xs" placeholder={t("salesDocForm.itemNamePlaceholder")} value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      <Input className="h-8 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      {isInvoice && (
                        warehouses.length > 0 ? (
                          <Select value={l.warehouseId || undefined} onValueChange={v => updateLine(l._id, "warehouseId", v)}>
                            <SelectTrigger className={cn("h-8 text-xs", l.itemId && !l.warehouseId && "border-amber-400")}>
                              <SelectValue placeholder={t("salesDocForm.warehousePlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              {warehouses.map((w: any) => (
                                <SelectItem key={w.id} value={String(w.id)}>{w.nameAr}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder="—" readOnly />
                        )
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
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t("salesDocForm.colUnit")} /></SelectTrigger>
                            <SelectContent>
                              {opts.map((u: any) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder={t("salesDocForm.colUnit")} value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" dir="ltr" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={l.discount}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={l.vatRate}
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

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addLine}>
                <Plus className="h-4 w-4" />{t("salesDocForm.addLine")}
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
                    onChange={e => setPriceIncludesVat(e.target.checked)}
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold">{t("salesDocForm.priceInclusiveTitle")}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {priceIncludesVat
                        ? t("salesDocForm.priceInclusiveYes")
                        : t("salesDocForm.priceInclusiveNo")}
                    </p>
                  </div>
                </label>

                <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                    <span>{t("salesDocForm.calcMethod")}</span>
                    <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                      {priceIncludesVat ? t("salesDocForm.calcInclusive") : t("salesDocForm.calcExclusive")}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("salesDocForm.subtotalLabel")}</span><span className="font-mono">{fmt(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("salesDocForm.vatLabel")}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                      <span className="text-muted-foreground">{t("salesDocForm.lineDiscountTotal")}</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} />
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? t("salesDocForm.totalLabelInclusive") : t("salesDocForm.totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {t("salesDocForm.equivalentIn", { currency: defaultCurrency?.code ?? "SAR", value: fmt(totalAmount / Number(exchangeRate)) })}
                    </p>
                  )}
                </div>
              </div>
    </div>
  );

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(basePath)}>
          <BackIcon className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{title}</h1>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "header"
                  ? t("salesDocForm.headerHint")
                  : t("salesDocForm.summaryHint", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount) })}
              </p>
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                  <FileText className="h-3.5 w-3.5" />{t("salesDocForm.tabHeader")}
                </TabsTrigger>
                {isInvoice && (
                  <TabsTrigger value="accounts" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <Calculator className="h-3.5 w-3.5" />{t("salesDocForm.tabAccounts")}
                  </TabsTrigger>
                )}
              </TabsList>
            </div>
          </CardHeader>

          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{isInvoice ? t("salesDocForm.invoiceNumber") : t("salesDocForm.quotationNumber")}</Label>
                  <Input ref={docNumberRef} className="h-9 text-sm" placeholder={t("common.auto")} dir="ltr" value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.date")}</Label>
                  <Input type="date" className="h-9 text-sm" value={docDate} onChange={e => setDocDate(e.target.value)} required />
                </div>
                {!isInvoice && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.validUntil")}</Label>
                    <Input type="date" className="h-9 text-sm" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.customer")}</Label>
                  <SearchCombobox items={customerComboItems} value={customerId} onValueChange={setCustomerId} placeholder={t("salesDocForm.customerPlaceholder")} />
                </div>
                <CustomerVatControl customers={customers} customerId={customerId} onCustomerChange={setCustomerId} />
                {isInvoice && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.branch")}</Label>
                    <Select value={branchId || undefined} onValueChange={setBranchId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.branchPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(branches as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? ` (${t("common.main")})` : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {isInvoice && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.paymentType")}</Label>
                    <Select value={paymentType} onValueChange={setPaymentType}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="credit">{t("salesDocForm.paymentCredit")}</SelectItem>
                        <SelectItem value="cash">{t("salesDocForm.paymentCash")}</SelectItem>
                        <SelectItem value="bank">{t("salesDocForm.paymentBank")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {isInvoice && paymentType === "cash" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.cashBox")}</Label>
                    <Select value={cashBoxId || undefined} onValueChange={setCashBoxId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.cashBoxPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(cashBoxes as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {isInvoice && paymentType === "bank" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.bankAccount")}</Label>
                    <Select value={bankAccountId || undefined} onValueChange={setBankAccountId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.bankAccountPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(bankAccounts as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.currency")}</Label>
                  {currencies.length > 0 ? (
                    <Select value={currencyCode || undefined} onValueChange={handleCurrencyChange}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent>
                        {currencies.map((c: any) => (
                          <SelectItem key={c.id} value={c.code}>{c.code}{c.nameAr ? ` — ${c.nameAr}` : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-9 text-sm" dir="ltr" value={currencyCode} onChange={e => setCurrencyCode(e.target.value)} />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.exchangeRate")}</Label>
                  <Input type="text" inputMode="decimal" className="h-9 text-sm" dir="ltr" value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{t("salesDocForm.notes")}</Label>
                <Textarea className="text-sm min-h-[60px] resize-none" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
              </div>

              <div className="border-t pt-4 mt-2 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{t("salesDocForm.tabLines", { count: lines.filter(l => l.itemName).length })}</span>
              </div>
              {linesSection}
            </CardContent>
          </TabsContent>

          {isInvoice && (
            <TabsContent value="accounts" className="mt-0">
              <CardContent className="pt-5 pb-5">
                <div className="rounded-lg border-2 border-blue-200 bg-blue-50/40 p-4 space-y-4">
                  <div className="flex items-center gap-2 text-blue-900">
                    <Calculator className="h-4 w-4" />
                    <span className="text-sm font-semibold">{t("salesDocForm.accountsCardTitle")}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("salesDocForm.salesAccount")} <span className="text-destructive">*</span></Label>
                      <AccountCombobox value={salesAccountId} onValueChange={setSalesAccountId}
                        placeholder={t("salesDocForm.salesAccountPlaceholder")} filterTypes={["revenue"]} allowEmpty={false} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("salesDocForm.cogsAccount")} <span className="text-destructive">*</span></Label>
                      <AccountCombobox value={cogsAccountId} onValueChange={setCogsAccountId}
                        placeholder={t("salesDocForm.cogsAccountPlaceholder")} filterTypes={["expense"]} allowEmpty={false} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("salesDocForm.vatAccount")}</Label>
                      <AccountCombobox value={taxAccountId} onValueChange={setTaxAccountId}
                        placeholder={t("salesDocForm.vatAccountPlaceholder")} filterTypes={["liability"]} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("salesDocForm.discountAccount")}</Label>
                      <AccountCombobox value={discountAccountId} onValueChange={setDiscountAccountId}
                        placeholder={t("salesDocForm.discountAccountPlaceholder")} filterTypes={["expense"]} />
                    </div>
                  </div>
                  <p className="text-[11px] text-blue-900/70">
                    {t("salesDocForm.accountsHelp")}
                  </p>
                </div>
              </CardContent>
            </TabsContent>
          )}

        </Card>
      </Tabs>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(basePath)}>{t("common.cancel")}</Button>
        <Button onClick={handleSave} disabled={saveMut.isPending}>
          {saveMut.isPending ? t("common.saving") : isNew ? (isInvoice ? t("salesDocForm.saveInvoice") : t("salesDocForm.saveQuotation")) : t("salesDocForm.saveEdit")}
        </Button>
      </div>
    </div>
  );
}
