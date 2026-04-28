import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, CheckCircle2, Printer, Wallet, CreditCard, TrendingUp, TrendingDown, Undo2, Pencil, FileText, ListOrdered, Copy } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { DiscountRow } from "@/components/DiscountRow";
import { SupplierVatControl } from "@/components/SupplierVatControl";
import { cn } from "@/lib/utils";
import PurchasePrintModal from "./PurchasePrintModal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface ReturnLine {
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

function newLine(): ReturnLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", unitPrice: "0", discount: "0", vatRate: "15", lineTotal: "0",
    notes: "",
  };
}

const EMPTY = {
  docNumber: "", supplierInvoiceNumber: "", returnDate: today(), supplierId: "", branchId: "", invoiceId: "",
  paymentType: "credit", cashBoxId: "", bankAccountId: "",
  currencyCode: "", exchangeRate: "1", notes: "",
  discountAmount: "0",
  priceIncludesVat: false,
  inventoryAccountId: "", taxAccountId: "", discountAccountId: "",
};

export default function PurchaseReturns() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`purchasingPages.purchaseReturns.${k}`, opts) as string;
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const itemName = (i: any) => isRtl ? (i?.nameAr ?? i?.nameEn ?? "") : (i?.nameEn ?? i?.nameAr ?? "");
  const branchName = (b: any) => isRtl ? (b?.nameAr ?? b?.nameEn ?? `#${b?.id}`) : (b?.nameEn ?? b?.nameAr ?? `#${b?.id}`);
  const unitName = (u: any) => isRtl ? (u?.nameAr ?? u?.nameEn ?? "") : (u?.nameEn ?? u?.nameAr ?? "");
  const warehouseName = (w: any) => isRtl ? (w?.nameAr ?? w?.nameEn ?? "") : (w?.nameEn ?? w?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Sticky toggle — see SalesDocumentForm for behavior contract.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]         = useState<any>({ ...EMPTY, priceIncludesVat: stickyPriceIncl.initial });
  const [lines, setLines]       = useState<ReturnLine[]>([newLine()]);

  const seqPeek = useNextSequenceNumber("purchase_return", showForm && editingId == null);
  useEffect(() => {
    if (!showForm || editingId != null) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.docNumber === seqPeek.number ? p : { ...p, docNumber: seqPeek.number }));
    }
  }, [showForm, editingId, seqPeek.hasSequence, seqPeek.number]);
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
  const { containerRef: enterNavRef, onKeyDown: enterNavKey } = useEnterNavigation(
    () => handleSubmit({ preventDefault() {} } as any),
  );
  const docNumberRef = useRef<HTMLInputElement>(null);
  const [printData, setPrintData] = useState<any>(null);

  const { data: returns_ = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-returns", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/purchasing/purchase-returns?companyId=${cid}` : `${API}/api/purchasing/purchase-returns`, { headers: authH });
      return r.json();
    },
    enabled: !!user,
  });

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/purchasing/purchase-invoices?companyId=${cid}` : `${API}/api/purchasing/purchase-invoices`, { headers: authH }); return r.json(); },
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

  const { data: supplierBalances = [] } = useQuery<any[]>({
    queryKey: ["supplier-balances", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/suppliers/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && form.paymentType === "credit",
  });

  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && form.paymentType === "cash",
  });
  const { data: cashBoxBalances = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/cash-boxes/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && form.paymentType === "cash",
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && form.paymentType === "bank",
  });
  const { data: bankAccountBalances = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts-bal", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts/balances?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid && form.paymentType === "bank",
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });
  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  useEffect(() => {
    if (!showForm || !defaultBranch || form.branchId) return;
    setForm((p: any) => ({ ...p, branchId: String(defaultBranch.id) }));
  }, [showForm, defaultBranch?.id]);

  const defaultWarehouse = (warehouses as any[])[0];
  const hasEmptyWarehouse = lines.some((l: any) => !l.warehouseId);
  useEffect(() => {
    if (!defaultWarehouse || !hasEmptyWarehouse) return;
    setLines(prev => prev.map((l: any) => l.warehouseId ? l : { ...l, warehouseId: String(defaultWarehouse.id) }));
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
    setForm((p: any) => ({ ...p, currencyCode: code, exchangeRate: getLatestRate(code) }));
  }

  useEffect(() => {
    if (!showForm || !defaultCurrency || form.currencyCode) return;
    setForm((p: any) => ({ ...p, currencyCode: defaultCurrency.code }));
  }, [showForm, defaultCurrency?.code]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-returns"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const isEdit = !!editingId;
      const url = isEdit
        ? `${API}/api/purchasing/purchase-returns/${editingId}`
        : `${API}/api/purchasing/purchase-returns`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST", headers, body: JSON.stringify({ ...data, companyId: cid }),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      if (!isEdit && j?.id && (j.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/purchasing/purchase-returns/${j.id}/post`, { method: "PATCH", headers });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) throw new Error(tr("toasts.savedNoPost", { err: pj.error || pr.statusText }));
        return pj;
      }
      return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: editingId ? tr("toasts.edited") : tr("toasts.createdAndPosted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}/post`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}/unpost`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.unposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  async function startEdit(retId: number) {
    try {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${retId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(retId);
      setForm({
        docNumber:    full.docNumber ?? "",
        supplierInvoiceNumber: full.supplierInvoiceNumber ?? "",
        returnDate:   full.returnDate ?? today(),
        supplierId:   full.supplierId ? String(full.supplierId) : "",
        branchId:     full.branchId   ? String(full.branchId)   : "",
        invoiceId:    full.invoiceId  ? String(full.invoiceId)  : "",
        paymentType:  full.paymentType ?? "credit",
        cashBoxId:    full.cashBoxId  ? String(full.cashBoxId)  : "",
        bankAccountId: full.bankAccountId ? String(full.bankAccountId) : "",
        currencyCode: full.currencyCode ?? "",
        exchangeRate: full.exchangeRate ? String(full.exchangeRate) : "1",
        notes:        full.notes ?? "",
        discountAmount: String(full.discountAmount ?? "0"),
        priceIncludesVat: !!full.priceIncludesVat,
        inventoryAccountId: full.inventoryAccountId ? String(full.inventoryAccountId) : "",
        taxAccountId:       full.taxAccountId       ? String(full.taxAccountId)       : "",
        discountAccountId:  full.discountAccountId  ? String(full.discountAccountId)  : "",
      });
      setLines((full.lines ?? []).length ? full.lines.map((l: any) => ({
        _id:         crypto.randomUUID(),
        itemId:      l.itemId      ? String(l.itemId)      : "",
        itemName:    l.itemName    ?? "",
        itemCode:    l.itemCode    ?? "",
        unitId:      l.unitId      ? String(l.unitId)      : "",
        unit:        l.unit        ?? "",
        conversionFactor: String(l.conversionFactor ?? "1"),
        warehouseId: l.warehouseId ? String(l.warehouseId) : "",
        qty:         String(l.qty ?? "1"),
        unitPrice:   String(l.unitPrice ?? "0"),
        discount:    String(l.discount ?? "0"),
        vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
        lineTotal:   String(l.lineTotal ?? "0"),
        notes:       l.notes ?? "",
      })) : [newLine()]);
      setShowForm(true);
    } catch (e: any) {
      toast({ title: e.message || tr("toasts.loadError"), variant: "destructive" });
    }
  }

  async function duplicateReturn(retId: number) {
    try {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${retId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(null);
      setForm({
        docNumber:    "",
        supplierInvoiceNumber: full.supplierInvoiceNumber ?? "",
        returnDate:   today(),
        supplierId:   full.supplierId ? String(full.supplierId) : "",
        branchId:     full.branchId   ? String(full.branchId)   : "",
        invoiceId:    full.invoiceId  ? String(full.invoiceId)  : "",
        paymentType:  full.paymentType ?? "credit",
        cashBoxId:    full.cashBoxId  ? String(full.cashBoxId)  : "",
        bankAccountId: full.bankAccountId ? String(full.bankAccountId) : "",
        currencyCode: full.currencyCode ?? "",
        exchangeRate: full.exchangeRate ? String(full.exchangeRate) : "1",
        notes:        full.notes ?? "",
        discountAmount: String(full.discountAmount ?? "0"),
        priceIncludesVat: !!full.priceIncludesVat,
        inventoryAccountId: full.inventoryAccountId ? String(full.inventoryAccountId) : "",
        taxAccountId:       full.taxAccountId       ? String(full.taxAccountId)       : "",
        discountAccountId:  full.discountAccountId  ? String(full.discountAccountId)  : "",
      });
      setLines((full.lines ?? []).length ? full.lines.map((l: any) => ({
        _id:         crypto.randomUUID(),
        itemId:      l.itemId      ? String(l.itemId)      : "",
        itemName:    l.itemName    ?? "",
        itemCode:    l.itemCode    ?? "",
        unitId:      l.unitId      ? String(l.unitId)      : "",
        unit:        l.unit        ?? "",
        conversionFactor: String(l.conversionFactor ?? "1"),
        warehouseId: l.warehouseId ? String(l.warehouseId) : "",
        qty:         String(l.qty ?? "1"),
        unitPrice:   String(l.unitPrice ?? "0"),
        discount:    String(l.discount ?? "0"),
        vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
        lineTotal:   String(l.lineTotal ?? "0"),
        notes:       l.notes ?? "",
      })) : [newLine()]);
      setShowForm(true);
      toast({ title: tr("toasts.duplicated") });
    } catch (e: any) {
      toast({ title: e.message || tr("toasts.loadError"), variant: "destructive" });
    }
  }

  const acctPrefsKey = `purchase-return-accts:${cid ?? "all"}`;
  function loadAcctDefaults() {
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return {};
      const p = JSON.parse(raw);
      return {
        inventoryAccountId: p.inventoryAccountId ? String(p.inventoryAccountId) : "",
        taxAccountId:       p.taxAccountId       ? String(p.taxAccountId)       : "",
        discountAccountId:  p.discountAccountId  ? String(p.discountAccountId)  : "",
      };
    } catch { return {}; }
  }

  useEffect(() => {
    const { inventoryAccountId, taxAccountId, discountAccountId } = form;
    if (!inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({ inventoryAccountId, taxAccountId, discountAccountId }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.inventoryAccountId, form.taxAccountId, form.discountAccountId]);

  function reset() {
    setForm({ ...EMPTY, ...loadAcctDefaults(), priceIncludesVat: stickyPriceIncl.read() });
    setLines([newLine()]);
    setEditingId(null);
    setShowForm(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("fromInvoice");
    window.history.replaceState({}, "", url.toString());
  }

  async function openPrint(ret: any) {
    const res = await fetch(`${API}/api/purchasing/purchase-returns/${ret.id}`, { headers: authH });
    const full = await res.json();
    const supplier = suppliers.find((s: any) => s.id === ret.supplierId) ?? null;
    setPrintData({ type: "return", doc: full, lines: full.lines ?? [], supplier, company: user?.company ?? null });
  }

  async function loadInvoiceIntoForm(invId: string | number, opts: { openForm?: boolean } = {}) {
    if (!invId) return;
    try {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${invId}`, { headers: authH });
      if (!res.ok) return;
      const inv = await res.json();
      setForm((prev: any) => ({
        ...prev,
        supplierId: inv.supplierId ? String(inv.supplierId) : "",
        branchId:   inv.branchId   ? String(inv.branchId)   : "",
        invoiceId:  String(inv.id),
        paymentType: inv.paymentType ?? prev.paymentType ?? "credit",
        cashBoxId:   inv.cashBoxId ? String(inv.cashBoxId) : "",
        bankAccountId: inv.bankAccountId ? String(inv.bankAccountId) : "",
        currencyCode:  inv.currencyCode  ?? prev.currencyCode ?? defaultCurrency?.code ?? "",
        exchangeRate:  inv.exchangeRate  ? String(inv.exchangeRate) : "1",
        notes: tr("toasts.returnFromInvoice", { doc: inv.docNumber ?? `PI-${inv.id}` }),
        priceIncludesVat: !!inv.priceIncludesVat,
        inventoryAccountId: inv.inventoryAccountId ? String(inv.inventoryAccountId) : prev.inventoryAccountId,
        taxAccountId:       inv.taxAccountId       ? String(inv.taxAccountId)       : prev.taxAccountId,
        discountAccountId:  inv.discountAccountId  ? String(inv.discountAccountId)  : prev.discountAccountId,
      }));
      if (inv.lines?.length) {
        setLines(inv.lines.map((l: any) => ({
          _id:         crypto.randomUUID(),
          itemId:      l.itemId      ? String(l.itemId)      : "",
          itemName:    l.itemName    ?? "",
          itemCode:    l.itemCode    ?? "",
          unitId:      l.unitId      ? String(l.unitId)      : "",
          unit:        l.unit        ?? "",
          conversionFactor: String(l.conversionFactor ?? "1"),
          warehouseId: l.warehouseId ? String(l.warehouseId) : "",
          qty:         String(Math.round(Number(l.qty ?? 1))),
          unitPrice:   String(l.unitPrice ?? 0),
          discount:    String(l.discount  ?? "0"),
          vatRate:     (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal ?? 0),
          notes:       l.notes ?? "",
        })));
      }
      if (opts.openForm) setShowForm(true);
    } catch (_) { /* silent */ }
  }

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const invId = params.get("fromInvoice");
    if (!invId || !user || !currencies.length) return;
    prefilledRef.current = true;
    loadInvoiceIntoForm(invId, { openForm: true });
  }, [user, currencies.length]);

  function calcLineTotal(l: ReturnLine, priceIncludesVat = false) {
    const qty   = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const disc  = Number(l.discount) || 0;
    const rate  = (Number(l.vatRate) || 0) / 100;
    const gross = qty * price * (1 - disc / 100);
    if (priceIncludesVat) return gross;
    return gross * (1 + rate);
  }
  function calcLineParts(l: ReturnLine, priceIncludesVat = false) {
    const qty   = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const disc  = Number(l.discount) || 0;
    const rate  = (Number(l.vatRate) || 0) / 100;
    const gross = qty * price * (1 - disc / 100);
    if (priceIncludesVat) {
      const net = rate > -1 ? gross / (1 + rate) : gross;
      return { subtotal: net, vat: gross - net, lineTotal: gross };
    }
    const vat = gross * rate;
    return { subtotal: gross, vat, lineTotal: gross + vat };
  }

  function updateLine(id: string, field: keyof ReturnLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const u = { ...l, [field]: value };
      return { ...u, lineTotal: calcLineTotal(u, !!form.priceIncludesVat).toFixed(2) };
    }));
  }

  useEffect(() => {
    setLines(prev => prev.map(l => ({ ...l, lineTotal: calcLineTotal(l, !!form.priceIncludesVat).toFixed(2) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.priceIncludesVat]);

  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/units?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemUnitsMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }

  function changeLineUnit(lineId: string, newUnitId: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const itemUnits = itemUnitsMap[l.itemId] ?? [];
      const row = itemUnits.find((u: any) => String(u.unitId) === newUnitId);
      const globalUnit = units.find((u: any) => String(u.id) === newUnitId);
      const updated: ReturnLine = {
        ...l,
        unitId: newUnitId,
        unit: unitName(row?.unit) || unitName(globalUnit) || "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.costPrice != null ? String(row.costPrice) : l.unitPrice,
      };
      return { ...updated, lineTotal: calcLineTotal(updated, !!form.priceIncludesVat).toFixed(2) };
    }));
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) return;
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const updated: ReturnLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemName(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitName(base?.unit) || unitName(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: String(base?.costPrice ?? item.costPrice ?? "0"),
        vatRate:   (Number(item.vatRate) > 0 ? String(item.vatRate) : "15"),
      };
      return { ...updated, lineTotal: calcLineTotal(updated, !!form.priceIncludesVat).toFixed(2) };
    }));
  }

  const priceIncludesVat = !!form.priceIncludesVat;
  const grossTotal  = lines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);
  const vatAmount   = lines.reduce((s, l) => s + calcLineParts(l, priceIncludesVat).vat, 0);
  const lineDiscountTotal = lines.reduce((s, l) => {
    const noDisc   = calcLineTotal({ ...l, discount: "0" }, priceIncludesVat);
    const withDisc = calcLineTotal(l, priceIncludesVat);
    return s + Math.max(0, noDisc - withDisc);
  }, 0);
  const docDiscountAmt = Math.max(0, Math.min(grossTotal, Number(form.discountAmount) || 0));
  const totalAmount    = grossTotal - docDiscountAmt;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({
      ...form,
      supplierId: form.supplierId || null,
      invoiceId:  form.invoiceId  || null,
      cashBoxId:  form.paymentType === "cash" ? (form.cashBoxId || null) : null,
      bankAccountId: form.paymentType === "bank" ? (form.bankAccountId || null) : null,
      inventoryAccountId: form.inventoryAccountId ? Number(form.inventoryAccountId) : null,
      taxAccountId:       form.taxAccountId       ? Number(form.taxAccountId)       : null,
      discountAccountId:  form.discountAccountId  ? Number(form.discountAccountId)  : null,
      discountAmount: docDiscountAmt.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      vatAmount:   vatAmount.toFixed(2),
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
  ];
  const invoiceItems = [
    { value: "", label: tr("noInvoiceOpt") },
    ...invoices.map((i: any) => ({ value: String(i.id), label: i.docNumber ?? `PI-${i.id}` })),
  ];
  const itemComboItems = [
    { value: "", label: tr("selectItemOpt") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      label: i.code ? `${i.code} — ${itemName(i)}` : itemName(i),
    })),
  ];
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));

  const lineColHeaders = [
    tr("lineCols.item"),
    tr("lineCols.itemCode"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    tr("lineCols.price"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.total"),
    tr("lineCols.notes"),
    "",
  ];
  const listColHeaders = [
    tr("listCols.number"),
    tr("listCols.date"),
    tr("listCols.supplier"),
    tr("listCols.currency"),
    tr("listCols.subtotal"),
    tr("listCols.vat"),
    tr("listCols.total"),
    tr("listCols.journal"),
    tr("listCols.status"),
    tr("listCols.actions"),
  ];

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("newReturn")}
        </Button>
      </div>

      {/* ── Form ────────────────────────────────────────── */}
      {showForm && (() => {
        // Look up the currently-edited return so we can render its status
        // pill inline with the form title. On a fresh /new there's no
        // "current" return — the badge + navigator are skipped in that case.
        const currentRet = editingId
          ? (returns_ as any[]).find((r: any) => Number(r.id) === Number(editingId))
          : null;
        const supplierNameById = (id: any) => {
          const s = (suppliers as any[]).find((s: any) => Number(s.id) === Number(id));
          return s ? (s.nameAr ?? s.nameEn ?? `#${s.id}`) : "—";
        };
        return (
        <>
          {editingId && (returns_ as any[]).length > 0 && (
            <div className="flex justify-end">
              <DocNavigator
                items={(returns_ as any[]).map((d: any) => ({
                  id: d.id,
                  docNumber: d.docNumber,
                  partyName: supplierNameById(d.supplierId),
                  date: d.returnDate ?? "",
                  total: d.totalAmount ?? 0,
                  currencyCode: d.currencyCode ?? "",
                }))}
                currentId={editingId}
                onSelect={(id) => startEdit(Number(id))}
                fallbackPrefix="PR-"
              />
            </div>
          )}
        <FormPanel
          icon={RotateCcw}
          title={
            <span className="inline-flex items-center gap-2 flex-wrap">
              {editingId ? tr("editTitle") : tr("newTitle")}
              {currentRet && <DocStatusBadge status={currentRet.status} />}
            </span>
          }
          subtitle={form.invoiceId
            ? <>{tr("fromInvoiceHint")} <span className="font-mono text-orange-600">{invoices.find((i: any) => String(i.id) === form.invoiceId)?.docNumber ?? `PI-${form.invoiceId}`}</span> {tr("fromInvoiceTail")}</>
            : tr("createSubtitle")}
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.returnDate}
          saveLabel={tr("saveLabel")}
        >
          <Tabs defaultValue="header" dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
            <TabsList className="h-9 bg-muted/40 border gap-1">
              <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <FileText className="h-3.5 w-3.5" />{tr("headerData")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="header" className="mt-0 space-y-4">
            <FormGrid cols={4}>
              <Field label={tr("returnNumber")}><Input
                ref={docNumberRef}
                placeholder={seqPeek.loading ? "…" : t("common.auto")}
                dir="ltr"
                className={cn("text-left", (editingId != null || seqPeek.hasSequence) && "bg-muted/40 cursor-not-allowed")}
                value={form.docNumber}
                onChange={e => { if (editingId == null && !seqPeek.hasSequence) setForm((p: any) => ({ ...p, docNumber: e.target.value })); }}
                readOnly={editingId != null || seqPeek.hasSequence}
                title={editingId != null ? t("purchasingPages.purchaseInvoiceForm.lockTitle") : (seqPeek.hasSequence ? `${seqPeek.sequenceCode ?? ""}` : undefined)}
              /></Field>
              <Field label={t("common.date")} required><Input type="date" value={form.returnDate} onChange={e => setForm((p: any) => ({ ...p, returnDate: e.target.value }))} /></Field>
              <Field label={tr("supplierLabel")}>
                <SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder={tr("supplierPlaceholder")} />
              </Field>
              <SupplierVatControl
                suppliers={suppliers}
                supplierId={form.supplierId}
                onSupplierChange={(v) => setForm((p: any) => ({ ...p, supplierId: v }))}
              />
              <Field label={tr("supplierInvoiceLabel")}><SearchCombobox items={invoiceItems} value={form.invoiceId} onValueChange={v => { setForm((p: any) => ({ ...p, invoiceId: v })); if (v) loadInvoiceIntoForm(v); }} placeholder={tr("invoiceNumberPh")} /></Field>
              <Field label={tr("supplierInvoiceNumber")}><Input placeholder={tr("supplierInvoiceNumberPh")} value={form.supplierInvoiceNumber} onChange={e => setForm((p: any) => ({ ...p, supplierInvoiceNumber: e.target.value }))} /></Field>
              <Field label={tr("branch")}>
                <Select value={form.branchId || undefined} onValueChange={v => setForm((p: any) => ({ ...p, branchId: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("purchasingPages.purchaseInvoiceForm.fields.branchPh")} /></SelectTrigger>
                  <SelectContent>
                    {(branches as any[]).map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{branchName(b)}{b.isMain ? tr("mainBranch") : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={tr("currency")}>
                {currencies.length > 0 ? (
                  <Select value={form.currencyCode || undefined} onValueChange={handleCurrencyChange}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={tr("currencyPh")} /></SelectTrigger>
                    <SelectContent>
                      {currencies.map((c: any) => {
                        const cName = isRtl ? c.nameAr : (c.nameEn ?? c.nameAr);
                        return <SelectItem key={c.id} value={c.code}>{c.code}{cName ? ` — ${cName}` : ""}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input placeholder="SAR" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} />
                )}
              </Field>
              <Field
                label={<span className="flex items-center justify-between w-full">
                  <span>{tr("exchangeRate")}</span>
                  {form.currencyCode && form.currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                    <span className="text-[10px] text-muted-foreground font-normal">= {Number(form.exchangeRate) > 0 ? (1 / Number(form.exchangeRate)).toFixed(4) : "—"} {defaultCurrency?.code}</span>
                  )}
                </span>}
              >
                <Input type="text" inputMode="decimal" dir="ltr" className="text-left" value={form.exchangeRate} onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
              </Field>
              <Field label={tr("settlementType")} required>
                <Select
                  value={form.paymentType}
                  onValueChange={(v) => setForm((p: any) => ({ ...p, paymentType: v, cashBoxId: v === "cash" ? p.cashBoxId : "", bankAccountId: v === "bank" ? p.bankAccountId : "" }))}
                >
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">
                      <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("settlement.credit")}</span>
                    </SelectItem>
                    <SelectItem value="cash">
                      <span className="flex items-center gap-2"><Wallet className="h-3.5 w-3.5" />{tr("settlement.cash")}</span>
                    </SelectItem>
                    <SelectItem value="bank">
                      <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("settlement.bank")}</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={tr("notes")}><Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
            </FormGrid>

            {/* Payment link panel */}
            {form.paymentType === "bank" ? (
              (() => {
                const balMap: Record<number, number> = Object.fromEntries(
                  (bankAccountBalances as any[]).map((b: any) => [b.bankAccountId, Number(b.balance)])
                );
                const activeBanks = (bankAccounts as any[]).filter((b: any) => b.isActive !== false);
                const items = [
                  { value: "", label: tr("selectBank") },
                  ...activeBanks.map((b: any) => ({
                    value: String(b.id),
                    label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${form.currencyCode || "SAR"}`,
                  })),
                ];
                const sel = activeBanks.find((b: any) => String(b.id) === form.bankAccountId);
                const bal = sel ? (balMap[sel.id] ?? 0) : 0;
                const newBal = bal + totalAmount;
                return (
                  <div className="space-y-2">
                    <div className="grid md:grid-cols-2 gap-3">
                      <Field label={tr("bankAccount")} required>
                        <SearchCombobox items={items} value={form.bankAccountId} onValueChange={v => setForm((p: any) => ({ ...p, bankAccountId: v }))} placeholder={tr("bankAccountPh")} />
                      </Field>
                    </div>
                    <div className={cn(
                      "rounded-lg border p-3 flex items-start gap-3",
                      !form.bankAccountId ? "bg-amber-50 border-amber-200 text-amber-800" :
                      "bg-emerald-50 border-emerald-200 text-emerald-800"
                    )}>
                      <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                      {!form.bankAccountId ? (
                        <div className="text-xs">
                          <p className="font-semibold">{tr("bankRefundTitle")}</p>
                          <p className="opacity-80 mt-0.5">{tr("bankRefundDesc")}</p>
                        </div>
                      ) : (
                        <div className="text-xs flex-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-semibold">{tr("accountLabel")}: <strong>{branchName(sel)}</strong></span>
                            <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" />{tr("balanceLabel")}: <strong className="font-mono">{fmt(bal)}</strong></span>
                            <span className="flex items-center gap-1">{tr("plusRefund")}: <strong className="font-mono">{fmt(totalAmount)}</strong></span>
                            <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>{tr("balanceAfterPost")}: <strong className="font-mono">{fmt(newBal)}</strong> {form.currencyCode}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : form.paymentType === "credit" ? (
              (() => {
                const sup = suppliers.find((s: any) => String(s.id) === form.supplierId);
                const balRow = (supplierBalances as any[]).find((b: any) => b.supplierId === Number(form.supplierId));
                const currentBal = balRow ? Number(balRow.balance) : 0;
                const refund = totalAmount;
                const newBal = currentBal - refund;
                return (
                  <div className={cn(
                    "rounded-lg border p-3 flex items-start gap-3",
                    !form.supplierId ? "bg-amber-50 border-amber-200 text-amber-800" :
                    "bg-blue-50 border-blue-200 text-blue-800"
                  )}>
                    <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                    {!form.supplierId ? (
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
                            {tr("currentBalance")}: <strong className="font-mono">{fmt(currentBal)}</strong> {form.currencyCode}
                          </span>
                          <span className="flex items-center gap-1">
                            <TrendingDown className="h-3 w-3" />
                            {tr("minusReturn")}: <strong className="font-mono">{fmt(refund)}</strong>
                          </span>
                          <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                            {tr("balanceAfterPost")}: <strong className="font-mono">{fmt(newBal)}</strong> {form.currencyCode}
                            {newBal < 0 && <span className={cn("text-emerald-700", isRtl ? "mr-1" : "ml-1")}>{tr("supplierOwesUs")}</span>}
                          </span>
                        </div>
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
                    label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${form.currencyCode || "SAR"}`,
                  })),
                ];
                const selBox = activeBoxes.find((b: any) => String(b.id) === form.cashBoxId);
                const boxBal = selBox ? (balMap[selBox.id] ?? 0) : 0;
                const newBal = boxBal + totalAmount;
                const maxBal = selBox?.maxBalance ? Number(selBox.maxBalance) : 0;
                const overMax = maxBal > 0 && newBal > maxBal;
                return (
                  <div className="space-y-2">
                    <div className="grid md:grid-cols-2 gap-3">
                      <Field label={tr("cashBox")} required>
                        <SearchCombobox items={cashBoxItems} value={form.cashBoxId} onValueChange={v => setForm((p: any) => ({ ...p, cashBoxId: v }))} placeholder={tr("cashBoxPh")} />
                      </Field>
                    </div>
                    <div className={cn(
                      "rounded-lg border p-3 flex items-start gap-3",
                      !form.cashBoxId ? "bg-amber-50 border-amber-200 text-amber-800" :
                      overMax ? "bg-red-50 border-red-200 text-red-800" :
                      "bg-emerald-50 border-emerald-200 text-emerald-800"
                    )}>
                      <Wallet className="h-4 w-4 mt-0.5 shrink-0" />
                      {!form.cashBoxId ? (
                        <div className="text-xs">
                          <p className="font-semibold">{tr("cashRefundTitle")}</p>
                          <p className="opacity-80 mt-0.5">{tr("cashRefundDesc")}</p>
                        </div>
                      ) : (
                        <div className="text-xs flex-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-semibold">{tr("cashBox")}: <strong>{branchName(selBox)}</strong></span>
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {tr("balanceLabel")}: <strong className="font-mono">{fmt(boxBal)}</strong>
                            </span>
                            <span className="flex items-center gap-1">
                              {tr("plusRefund")}: <strong className="font-mono">{fmt(totalAmount)}</strong>
                            </span>
                            <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                              {tr("balanceAfterPost")}: <strong className="font-mono">{fmt(newBal)}</strong> {form.currencyCode}
                            </span>
                          </div>
                          {overMax && (
                            <p className="mt-1.5 text-[11px] font-semibold">
                              {tr("exceedMaxWarn", { max: fmt(maxBal), over: fmt(newBal - maxBal) })}
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

            </TabsContent>

            <TabsContent value="header" className="mt-0 space-y-5">
            {/* Lines */}
            <div data-enter-nav-container="lines" className="space-y-1.5">
              <div className="border-t pt-4 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{tr("linesTitle")} ({lines.filter(l => l.itemId || l.itemName).length})</span>
              </div>
              {(() => {
                const GRID_COLS_PR = "220px 110px 160px 120px 90px 110px 80px 80px 130px 180px 40px";
                return (
              <div className="rounded-xl border bg-card overflow-x-auto">
                <div className="min-w-max">
              <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: GRID_COLS_PR }}>
                {lineColHeaders.map((h, i) => (
                  <p key={i} className={cn("text-[11px] font-medium truncate", h === tr("lineCols.total") ? "font-semibold text-primary" : "text-muted-foreground")} title={h}>{h}</p>
                ))}
              </div>
              <div className="divide-y">
              {lines.map(l => (
                <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                  <div className="grid gap-2 items-center" style={{ gridTemplateColumns: GRID_COLS_PR }}>
                    {inventoryItems.length > 0 ? (
                      <SearchCombobox
                        items={itemComboItems}
                        value={l.itemId}
                        onValueChange={v => selectItem(l._id, v)}
                        placeholder={tr("selectItemCombo")}
                      />
                    ) : (
                      <Input className="h-8 text-xs" placeholder={tr("itemNamePh")} value={l.itemName}
                        onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                    )}
                    <Input className="h-8 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
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
                            label: `${unitName(iu.unit)}${Number(iu.conversionFactor) !== 1 ? ` (×${iu.conversionFactor})` : ""}`,
                          }))
                        : (units as any[]).map((u: any) => ({ value: String(u.id), label: unitName(u) }));
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

              <Button type="button" variant="outline" size="sm" className="gap-2"
                onClick={addLine}>
                <Plus className="h-4 w-4" />{tr("addLine")}
              </Button>
            </div>

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
                  onChange={e => {
                    setForm((p: any) => ({ ...p, priceIncludesVat: e.target.checked }));
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

              <div className="w-72 text-sm border rounded-xl p-3 bg-muted/30 space-y-2">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                  <span>{tr("calcMethod")}</span>
                  <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                    {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{tr("subtotalIncl")}</span>
                  <span className="font-mono">{fmt(grossTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{tr("vatAmount")}</span>
                  <span className="font-mono text-amber-700">{fmt(vatAmount)}</span>
                </div>
                {lineDiscountTotal > 0 && (
                  <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                    <span className="text-muted-foreground">{tr("itemDiscount")}</span>
                    <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                  </div>
                )}
                <DiscountRow gross={grossTotal} value={form.discountAmount ?? "0"} onChange={v => setForm((p: any) => ({ ...p, discountAmount: v }))} />
                <div className="flex justify-between font-bold border-t pt-2 text-base">
                  <span>{tr("totalLabel")}{priceIncludesVat ? ` ${tr("totalIncl").replace(tr("totalLabel"), "").trim() || ""}` : ""}</span>
                  <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                </div>
                {form.currencyCode && form.currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(form.exchangeRate) > 0 && (
                  <p className="text-[10px] text-muted-foreground border-t pt-1">
                    {tr("equivIn")} {defaultCurrency?.code}: {fmt(totalAmount / Number(form.exchangeRate))}
                  </p>
                )}
              </div>
            </div>
            </TabsContent>
          </Tabs>
        </FormPanel>
        </>
        );
      })()}

      {/* ── List ─────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
        ) : returns_.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{tr("noReturns")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                {listColHeaders.map(h => (
                  <th key={h} className={cn("px-3 py-3 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {returns_.map(r => (
                <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onDoubleClick={() => startEdit(r.id)}
                  title={r.status === "draft" ? tr("rowDoubleClickEdit") : tr("rowDoubleClickView")}>
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber ?? `PR-${r.id}`}</td>
                  <td className="px-3 py-2.5">{r.returnDate}</td>
                  <td className="px-3 py-2.5">{supMap[r.supplierId] ?? "—"}</td>
                  <td className="px-3 py-2.5">{r.currencyCode}</td>
                  <td className="px-3 py-2.5 font-mono">{fmt(Number(r.totalAmount) - Number(r.vatAmount))}</td>
                  <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(r.vatAmount)}</td>
                  <td className="px-3 py-2.5 font-mono font-semibold">{fmt(r.totalAmount)}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {r.journalEntryId ? (
                      <button
                        type="button"
                        className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                        title={tr("viewJournalTip")}
                        onClick={() => { window.location.href = `/accounting/journals/${r.journalEntryId}?tab=lines`; }}>
                        JE-{r.journalEntryId}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                      r.status === "posted"
                        ? "bg-green-50 text-green-700 border-green-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"
                    )}>
                      {r.status === "posted" ? tr("postedM") : tr("draft")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-primary hover:bg-primary/10"
                        title={tr("printTip")} onClick={() => openPrint(r)}>
                        <Printer className="h-3.5 w-3.5" />
                      </Button>
                      {r.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-700 hover:bg-blue-50"
                          title={tr("editTip")} onClick={() => startEdit(r.id)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        title={tr("duplicateTip")} onClick={() => duplicateReturn(r.id)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {r.status === "draft" && (
                        <Button
                          variant="outline" size="sm"
                          className="h-7 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50"
                          disabled={postMut.isPending}
                          onClick={() => postMut.mutate(r.id)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />{tr("postShort")}
                        </Button>
                      )}
                      {r.status === "posted" && (
                        <Button
                          variant="outline" size="sm"
                          className="h-7 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                          disabled={unpostMut.isPending}
                          onClick={() => { if (confirm(tr("confirmUnpost"))) unpostMut.mutate(r.id); }}
                        >
                          <Undo2 className="h-3.5 w-3.5" />{tr("unpostShort")}
                        </Button>
                      )}
                      {r.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => { if (confirm(tr("confirmDelete"))) deleteMut.mutate(r.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PurchasePrintModal
        open={!!printData}
        onClose={() => setPrintData(null)}
        data={printData}
      />
    </div>
  );
}
