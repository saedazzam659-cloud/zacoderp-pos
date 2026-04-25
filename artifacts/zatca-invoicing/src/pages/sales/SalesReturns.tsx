import { useState, useEffect, useRef } from "react";
import { useAutoFocusOnMount } from "@/hooks/useAutoFocusOnMount";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, CheckCircle2, Undo2, Calculator, FileText, ListOrdered, Pencil, Copy, Printer } from "lucide-react";
import SalesPrintModal from "./SalesPrintModal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import { CustomerVatControl } from "@/components/CustomerVatControl";
import { DiscountRow } from "@/components/DiscountRow";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

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
  docNumber: "", returnDate: today(), customerId: "", branchId: "", invoiceId: "",
  paymentType: "credit", cashBoxId: "", bankAccountId: "",
  currencyCode: "", exchangeRate: "1", notes: "", salesRepId: "",
  priceIncludesVat: false,
  cogsAccountId: "", inventoryAccountId: "", salesAccountId: "", taxAccountId: "", discountAccountId: "",
  discountAmount: "0",
};

const STATUS_CLS: Record<string, string> = {
  draft:  "bg-amber-50 text-amber-700 border-amber-200",
  posted: "bg-green-50 text-green-700 border-green-200",
};

export default function SalesReturns() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]         = useState<any>(EMPTY);
  const [lines, setLines]       = useState<ReturnLine[]>([newLine()]);
  const [printData, setPrintData] = useState<any>(null);

  // Pull next return number from the central sequence engine while creating
  // a new return. Skip when editing an existing record (its number is fixed)
  // or when the form panel is closed.
  const seqPeek = useNextSequenceNumber("sales_return", showForm && editingId == null);
  useEffect(() => {
    if (!showForm || editingId != null) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.docNumber === seqPeek.number ? p : { ...p, docNumber: seqPeek.number }));
    }
  }, [showForm, editingId, seqPeek.hasSequence, seqPeek.number]);

  async function openPrint(r: any) {
    try {
      const res = await fetch(`${API}/api/sales/sales-returns/${r.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === r.customerId) ?? null;
      setPrintData({ type: "return", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل المرتجع للطباعة", variant: "destructive" });
    }
  }
  const [focusLineId, setFocusLineId] = useState<string>(() => lines[0]?._id ?? "");
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
  const docNumberRef = useRef<HTMLInputElement>(null);
  const { containerRef: enterNavRef, onKeyDown: enterNavKey } = useEnterNavigation(
    () => handleSubmit({ preventDefault() {} } as any),
  );

  const { data: returns_ = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-returns", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-returns?companyId=${cid}` : `${API}/api/sales/sales-returns`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-invoices?companyId=${cid}` : `${API}/api/sales/sales-invoices`, { headers: authH }); return r.json(); },
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

  const { data: salesReps = [] } = useQuery<any[]>({
    queryKey: ["sales-reps", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`;
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
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
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: authH }); return r.json(); },
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
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id))
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }
  function handleCurrencyChange(code: string) { setForm((p: any) => ({ ...p, currencyCode: code, exchangeRate: getLatestRate(code) })); }

  useEffect(() => {
    if (!showForm || !defaultCurrency || form.currencyCode) return;
    setForm((p: any) => ({ ...p, currencyCode: defaultCurrency.code }));
  }, [showForm, defaultCurrency?.code]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-returns"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const isEdit = editingId != null;
      const url = isEdit
        ? `${API}/api/sales/sales-returns/${editingId}`
        : `${API}/api/sales/sales-returns`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers,
        body: JSON.stringify({ ...data, companyId: cid }),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      if (j?.id && (j.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/sales/sales-returns/${j.id}/post`, { method: "PATCH", headers });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) throw new Error(t("salesReturns.savedButPostFailed", { error: pj.error || pr.statusText }));
        return pj;
      }
      return j;
    },
    onSuccess: () => {
      invalidate();
      const wasEdit = editingId != null;
      reset();
      toast({ title: wasEdit ? t("salesReturns.toastReturnEdited") : t("salesReturns.toastReturnCreated") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}/post`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesReturns.toastPosted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesReturns.toastUnposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesReturns.toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const acctPrefsKey = `sales-return-accts:${cid ?? "all"}`;
  function loadAcctDefaults() {
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return {};
      const p = JSON.parse(raw);
      return {
        salesAccountId:     p.salesAccountId     ? String(p.salesAccountId)     : "",
        cogsAccountId:      p.cogsAccountId      ? String(p.cogsAccountId)      : "",
        inventoryAccountId: p.inventoryAccountId ? String(p.inventoryAccountId) : "",
        taxAccountId:       p.taxAccountId       ? String(p.taxAccountId)       : "",
        discountAccountId:  p.discountAccountId  ? String(p.discountAccountId)  : "",
      };
    } catch { return {}; }
  }

  useEffect(() => {
    const { salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId } = form;
    if (!salesAccountId && !cogsAccountId && !inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({
        salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId,
      }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.salesAccountId, form.cogsAccountId, form.inventoryAccountId, form.taxAccountId, form.discountAccountId]);

  function reset() {
    setForm({ ...EMPTY, ...loadAcctDefaults() });
    setLines([newLine()]);
    setShowForm(false);
    setEditingId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("fromInvoice");
    window.history.replaceState({}, "", url.toString());
  }

  async function editReturn(id: number) {
    try {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || t("salesReturns.loadFailed")); }
      const r = await res.json();
      setEditingId(id);
      setForm({
        docNumber: r.docNumber ?? "",
        returnDate: r.returnDate ?? today(),
        customerId: r.customerId ? String(r.customerId) : "",
        invoiceId: r.invoiceId ? String(r.invoiceId) : "",
        branchId: r.branchId ? String(r.branchId) : "",
        currencyCode: r.currencyCode ?? "SAR",
        exchangeRate: String(r.exchangeRate ?? "1"),
        paymentType: r.paymentType ?? "credit",
        cashBoxId: r.cashBoxId ? String(r.cashBoxId) : "",
        bankAccountId: r.bankAccountId ? String(r.bankAccountId) : "",
        discountAmount: r.discountAmount != null ? String(r.discountAmount) : "0",
        notes: r.notes ?? "",
        salesRepId: r.salesRepId ? String(r.salesRepId) : "",
        priceIncludesVat: !!r.priceIncludesVat,
        salesAccountId:     r.salesAccountId     ? String(r.salesAccountId)     : "",
        cogsAccountId:      r.cogsAccountId      ? String(r.cogsAccountId)      : "",
        inventoryAccountId: r.inventoryAccountId ? String(r.inventoryAccountId) : "",
        taxAccountId:       r.taxAccountId       ? String(r.taxAccountId)       : "",
        discountAccountId:  r.discountAccountId  ? String(r.discountAccountId)  : "",
      });
      setLines((r.lines ?? []).length
        ? r.lines.map((l: any) => ({
            _id: `e-${l.id}-${Math.random().toString(36).slice(2,7)}`,
            itemId: l.itemId ? String(l.itemId) : "",
            itemName: l.itemName ?? "",
            itemCode: l.itemCode ?? "",
            unit: l.unit ?? "",
            unitId: l.unitId ? String(l.unitId) : "",
            conversionFactor: String(l.conversionFactor ?? "1"),
            warehouseId: l.warehouseId ? String(l.warehouseId) : "",
            qty: String(l.qty ?? "1"),
            unitPrice: String(l.unitPrice ?? "0"),
            discount: String(l.discount ?? "0"),
            vatRate: (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
            lineTotal: String(l.lineTotal ?? "0"),
            notes: l.notes ?? "",
          }))
        : [newLine()]);
      setShowForm(true);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    }
  }

  async function duplicateReturn(id: number) {
    try {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || t("salesReturns.loadFailed")); }
      const r = await res.json();
      setEditingId(null);
      setForm({
        docNumber: "",
        returnDate: today(),
        customerId: r.customerId ? String(r.customerId) : "",
        invoiceId: r.invoiceId ? String(r.invoiceId) : "",
        branchId: r.branchId ? String(r.branchId) : "",
        currencyCode: r.currencyCode ?? "SAR",
        exchangeRate: String(r.exchangeRate ?? "1"),
        paymentType: r.paymentType ?? "credit",
        cashBoxId: r.cashBoxId ? String(r.cashBoxId) : "",
        bankAccountId: r.bankAccountId ? String(r.bankAccountId) : "",
        discountAmount: r.discountAmount != null ? String(r.discountAmount) : "0",
        notes: r.notes ?? "",
        salesRepId: r.salesRepId ? String(r.salesRepId) : "",
        priceIncludesVat: !!r.priceIncludesVat,
        salesAccountId:     r.salesAccountId     ? String(r.salesAccountId)     : "",
        cogsAccountId:      r.cogsAccountId      ? String(r.cogsAccountId)      : "",
        inventoryAccountId: r.inventoryAccountId ? String(r.inventoryAccountId) : "",
        taxAccountId:       r.taxAccountId       ? String(r.taxAccountId)       : "",
        discountAccountId:  r.discountAccountId  ? String(r.discountAccountId)  : "",
      });
      setLines((r.lines ?? []).length
        ? r.lines.map((l: any) => ({
            _id: crypto.randomUUID(),
            itemId: l.itemId ? String(l.itemId) : "",
            itemName: l.itemName ?? "",
            itemCode: l.itemCode ?? "",
            unit: l.unit ?? "",
            unitId: l.unitId ? String(l.unitId) : "",
            conversionFactor: String(l.conversionFactor ?? "1"),
            warehouseId: l.warehouseId ? String(l.warehouseId) : "",
            qty: String(l.qty ?? "1"),
            unitPrice: String(l.unitPrice ?? "0"),
            discount: String(l.discount ?? "0"),
            vatRate: (Number(l.vatRate) > 0 ? String(l.vatRate) : "15"),
            lineTotal: String(l.lineTotal ?? "0"),
            notes: l.notes ?? "",
          }))
        : [newLine()]);
      setShowForm(true);
      toast({ title: t("salesReturns.toastDuplicated") });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    }
  }

  // Load a sales invoice and populate the return form with its data
  async function loadInvoiceIntoForm(invId: string | number, opts: { openForm?: boolean } = {}) {
    if (!invId) return;
    try {
      const res = await fetch(`${API}/api/sales/sales-invoices/${invId}?companyId=${cid}`, { headers: authH });
      if (!res.ok) return;
      const inv = await res.json();
      setForm((prev: any) => ({
        ...prev,
        customerId: inv.customerId ? String(inv.customerId) : "",
        branchId:   inv.branchId   ? String(inv.branchId)   : "",
        invoiceId:  String(inv.id),
        currencyCode: inv.currencyCode ?? prev.currencyCode ?? defaultCurrency?.code ?? "",
        exchangeRate: inv.exchangeRate ? String(inv.exchangeRate) : "1",
        notes: t("salesReturns.fromInvoiceNote", { number: inv.docNumber ?? `SI-${inv.id}` }),
        salesRepId: inv.salesRepId ? String(inv.salesRepId) : prev.salesRepId,
        priceIncludesVat: !!inv.priceIncludesVat,
        cogsAccountId:      inv.cogsAccountId      ? String(inv.cogsAccountId)      : prev.cogsAccountId,
        inventoryAccountId: inv.inventoryAccountId ? String(inv.inventoryAccountId) : prev.inventoryAccountId,
        salesAccountId:     inv.salesAccountId     ? String(inv.salesAccountId)     : prev.salesAccountId,
        taxAccountId:       inv.taxAccountId       ? String(inv.taxAccountId)       : prev.taxAccountId,
        discountAccountId:  inv.discountAccountId  ? String(inv.discountAccountId)  : prev.discountAccountId,
      }));
      if (inv.lines?.length) {
        setLines(inv.lines.map((l: any) => ({
          _id: crypto.randomUUID(),
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

  // Pre-fill from sales invoice via ?fromInvoice URL param
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
    if (!item) return;
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const updated: ReturnLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  item.nameAr ?? "",
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      base?.unit?.nameAr ?? fallbackUnit?.nameAr ?? "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: String(base?.salePrice ?? item.sellPrice ?? item.price ?? "0"),
        vatRate:   String(item.vatRate ?? "15"),
      };
      return { ...updated, lineTotal: calcLineTotal(updated, !!form.priceIncludesVat).toFixed(2) };
    }));
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
        unit: row?.unit?.nameAr ?? globalUnit?.nameAr ?? "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.salePrice != null ? String(row.salePrice) : l.unitPrice,
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
      customerId: form.customerId || null,
      branchId:   form.branchId   || null,
      invoiceId:  form.invoiceId  || null,
      salesRepId: form.salesRepId ? Number(form.salesRepId) : null,
      paymentType: form.paymentType || "credit",
      cashBoxId:  form.paymentType === "cash" ? (form.cashBoxId || null) : null,
      bankAccountId: form.paymentType === "bank" ? (form.bankAccountId || null) : null,
      totalAmount: totalAmount.toFixed(2),
      vatAmount:   vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2),
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  const customerItems = [{ value: "", label: t("salesReturns.noCustomer") }, ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` }))];
  const invoiceItems  = [{ value: "", label: t("salesReturns.noInvoice") }, ...invoices.map((i: any) => ({ value: String(i.id), label: i.docNumber ?? `SI-${i.id}` }))];
  const salesRepItems = [
    { value: "", label: t("salesReturns.noSalesRep") },
    ...(salesReps as any[])
      .filter((r: any) => r.isActive !== false)
      .map((r: any) => ({
        value: String(r.id),
        label: r.code ? `${r.code} — ${r.nameAr ?? r.nameEn ?? `#${r.id}`}` : (r.nameAr ?? r.nameEn ?? `#${r.id}`),
      })),
  ];
  const itemComboItems = [{ value: "", label: t("salesReturns.selectItem") }, ...inventoryItems.map((i: any) => ({ value: String(i.id), label: i.code ? `${i.code} — ${i.nameAr}` : i.nameAr }))];
  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const statusLabel = (s: string) =>
    s === "posted" ? t("status.posted") : t("status.draft");

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-primary" />{t("salesReturns.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesReturns.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{t("salesReturns.newReturn")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={RotateCcw}
          title={t("salesReturns.formTitle")}
          subtitle={form.invoiceId
            ? t("salesReturns.formSubtitleFromInvoice", { number: invoices.find((i: any) => String(i.id) === form.invoiceId)?.docNumber ?? `SI-${form.invoiceId}` })
            : t("salesReturns.formSubtitleDefault")}
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.returnDate}
          saveLabel={t("salesReturns.saveReturn")}
        >
          <Tabs defaultValue="header" dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
            <TabsList className="h-9 bg-muted/40 border gap-1">
              <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <FileText className="h-3.5 w-3.5" />{t("salesReturns.tabHeader")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="header" className="mt-0 space-y-5">
            <FormGrid cols={4}>
              <Field label={t("salesReturns.returnNumber")}><Input
                ref={docNumberRef}
                placeholder={seqPeek.loading ? "…" : t("common.auto")}
                dir="ltr"
                className={cn("text-left", (editingId != null || seqPeek.hasSequence) && "bg-muted/40 cursor-not-allowed")}
                value={form.docNumber}
                onChange={e => { if (editingId == null && !seqPeek.hasSequence) setForm((p: any) => ({ ...p, docNumber: e.target.value })); }}
                readOnly={editingId != null || seqPeek.hasSequence}
                title={editingId != null ? "الرقم محفوظ — لا يمكن تعديله" : (seqPeek.hasSequence ? `مسلسل: ${seqPeek.sequenceCode ?? ""}` : undefined)}
              /></Field>
              <Field label={t("salesReturns.date")} required><Input type="date" value={form.returnDate} onChange={e => setForm((p: any) => ({ ...p, returnDate: e.target.value }))} /></Field>
              <Field label={t("salesReturns.customer")}><SearchCombobox items={customerItems} value={form.customerId} onValueChange={v => setForm((p: any) => ({ ...p, customerId: v }))} placeholder={t("salesReturns.customerPlaceholder")} /></Field>
              <CustomerVatControl customers={customers} customerId={form.customerId} onCustomerChange={v => setForm((p: any) => ({ ...p, customerId: v }))} />
              <Field label={t("salesReturns.salesInvoice")}><SearchCombobox items={invoiceItems} value={form.invoiceId} onValueChange={v => { setForm((p: any) => ({ ...p, invoiceId: v })); if (v) loadInvoiceIntoForm(v); }} placeholder={t("salesReturns.invoicePlaceholder")} /></Field>
              <Field label={t("salesReturns.branch")}>
                <Select value={form.branchId || undefined} onValueChange={(v) => setForm((p: any) => ({ ...p, branchId: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesReturns.branchPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    {(branches as any[]).map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? ` (${t("common.main")})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("salesReturns.currency")}>
                {currencies.length > 0 ? (
                  <Select value={form.currencyCode || undefined} onValueChange={handleCurrencyChange}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesReturns.currencyPlaceholder")} /></SelectTrigger>
                    <SelectContent>
                      {currencies.map((c: any) => (
                        <SelectItem key={c.id} value={c.code}>{c.code}{c.nameAr ? ` — ${c.nameAr}` : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} />
                )}
              </Field>
              <Field label={t("salesReturns.exchangeRate")}><Input type="text" inputMode="decimal" dir="ltr" className="text-left" value={form.exchangeRate} onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
              <Field label={t("salesReturns.paymentType")}>
                <Select value={form.paymentType} onValueChange={(v) => setForm((p: any) => ({ ...p, paymentType: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">{t("salesReturns.paymentCredit")}</SelectItem>
                    <SelectItem value="cash">{t("salesReturns.paymentCash")}</SelectItem>
                    <SelectItem value="bank">{t("salesReturns.paymentBank")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {form.paymentType === "cash" && (
                <Field label={t("salesReturns.cashBox")} required>
                  <Select value={form.cashBoxId || undefined} onValueChange={(v) => setForm((p: any) => ({ ...p, cashBoxId: v }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesReturns.cashBoxPlaceholder")} /></SelectTrigger>
                    <SelectContent>
                      {(cashBoxes as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {form.paymentType === "bank" && (
                <Field label={t("salesReturns.bankAccount")} required>
                  <Select value={form.bankAccountId || undefined} onValueChange={(v) => setForm((p: any) => ({ ...p, bankAccountId: v }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesReturns.bankAccountPlaceholder")} /></SelectTrigger>
                    <SelectContent>
                      {(bankAccounts as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label={t("salesReturns.salesRep")}>
                <SearchCombobox
                  items={salesRepItems}
                  value={form.salesRepId}
                  onValueChange={v => setForm((p: any) => ({ ...p, salesRepId: v }))}
                  placeholder={t("salesReturns.salesRepPlaceholder")}
                />
              </Field>
              <Field label={t("salesReturns.notes")} className="col-span-2 lg:col-span-4"><Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
            </FormGrid>
            </TabsContent>

            <TabsContent value="header" className="mt-0 space-y-5">
            <div data-enter-nav-container="lines" className="space-y-1.5">
              <div className="border-t pt-4 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{t("salesReturns.tabLines", { count: lines.filter(l => l.itemId || l.itemName).length })}</span>
              </div>
              {(() => {
                const GRID_COLS_SR = "220px 110px 160px 120px 90px 110px 80px 80px 130px 180px 40px";
                return (
              <div className="rounded-xl border bg-card overflow-x-auto">
                <div className="min-w-max">
              <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: GRID_COLS_SR }}>
                {[
                  { k: "item", l: t("salesReturns.colItem") },
                  { k: "code", l: t("salesReturns.colItemCode") },
                  { k: "wh", l: t("salesReturns.colWarehouse") },
                  { k: "unit", l: t("salesReturns.colUnit") },
                  { k: "qty", l: t("salesReturns.colQty") },
                  { k: "price", l: t("salesReturns.colPrice") },
                  { k: "disc", l: t("salesReturns.colDiscPct") },
                  { k: "vat", l: t("salesReturns.colVatPct") },
                  { k: "total", l: t("salesReturns.colTotal") },
                  { k: "notes", l: t("salesReturns.colNotes") },
                  { k: "act", l: "" },
                ].map((h) => (
                  <p key={h.k} className={cn("text-[11px] font-medium truncate", h.k === "total" ? "font-semibold text-primary" : "text-muted-foreground")} title={h.l}>{h.l}</p>
                ))}
              </div>
              <div className="divide-y">
              {lines.map(l => (
                <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                  <div className="grid gap-2 items-center" style={{ gridTemplateColumns: GRID_COLS_SR }}>
                    {inventoryItems.length > 0 ? (
                      <SearchCombobox items={itemComboItems} value={l.itemId} onValueChange={v => selectItem(l._id, v)} placeholder={t("salesReturns.itemPlaceholder")} />
                    ) : (
                      <Input className="h-8 text-xs" placeholder={t("salesReturns.itemNamePlaceholder")} value={l.itemName}
                        onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                    )}
                    <Input className="h-8 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
                      onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                    {warehouses.length > 0 ? (
                      <Select value={l.warehouseId || undefined} onValueChange={v => updateLine(l._id, "warehouseId", v)}>
                        <SelectTrigger className={cn("h-8 text-xs", l.itemId && !l.warehouseId && "border-amber-400")}>
                          <SelectValue placeholder={t("salesReturns.warehousePlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          {warehouses.map((w: any) => (
                            <SelectItem key={w.id} value={String(w.id)}>{w.nameAr}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input className="h-8 text-xs" placeholder={t("common.none")} readOnly />
                    )}
                    {(() => {
                      const itemUnits = (l.itemId && itemUnitsMap[l.itemId]) ? itemUnitsMap[l.itemId] : [];
                      const opts = itemUnits.length > 0
                        ? itemUnits.map((iu: any) => ({
                            value: String(iu.unitId),
                            label: `${iu.unit?.nameAr ?? ""}${Number(iu.conversionFactor) !== 1 ? ` (×${iu.conversionFactor})` : ""}`,
                          }))
                        : (units as any[]).map((u: any) => ({ value: String(u.id), label: u.nameAr }));
                      return units.length > 0 ? (
                        <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t("salesReturns.colUnit")} /></SelectTrigger>
                          <SelectContent>
                            {opts.map((u: any) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input className="h-8 text-xs" placeholder={t("salesReturns.colUnit")} value={l.unit}
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
                </div>
              </div>
                );
              })()}

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addLine}>
                <Plus className="h-4 w-4" />{t("salesReturns.addLine")}
              </Button>
            </div>

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
                  onChange={e => setForm((p: any) => ({ ...p, priceIncludesVat: e.target.checked }))}
                />
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold">{t("salesReturns.priceInclusiveTitle")}</p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {priceIncludesVat
                      ? t("salesReturns.priceInclusiveYes")
                      : t("salesReturns.priceInclusiveNo")}
                  </p>
                </div>
              </label>

              <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                  <span>{t("salesReturns.calcMethod")}</span>
                  <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                    {priceIncludesVat ? t("salesReturns.calcInclusive") : t("salesReturns.calcExclusive")}
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("salesReturns.grossLabel")}</span><span className="font-mono">{fmt(grossTotal)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("salesReturns.vatLabel")}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                {lineDiscountTotal > 0 && (
                  <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                    <span className="text-muted-foreground">{t("salesReturns.lineDiscountTotal")}</span>
                    <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                  </div>
                )}
                <DiscountRow gross={grossTotal} value={form.discountAmount ?? "0"} onChange={v => setForm((p: any) => ({ ...p, discountAmount: v }))} />
                <div className="flex justify-between font-bold border-t pt-2 text-base">
                  <span>{priceIncludesVat ? t("salesReturns.totalLabelInclusive") : t("salesReturns.totalLabel")}</span>
                  <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                </div>
              </div>
            </div>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
          : returns_.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">{t("salesReturns.noReturns")}</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {[
                t("salesReturns.colReturnNumber"),
                t("salesReturns.date"),
                t("salesReturns.customer"),
                t("salesReturns.colInvoice"),
                t("salesReturns.currency"),
                "المجموع",
                t("salesReturns.vatLabel"),
                t("salesReturns.totalLabel"),
                t("salesReturns.colJournal"),
                t("salesReturns.colStatus"),
                t("salesReturns.colActions"),
              ].map(h =>
                <th key={h} className="text-start px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns_.map((r: any) => {
                const stCls = STATUS_CLS[r.status] ?? STATUS_CLS.draft;
                const inv = invoices.find((i: any) => i.id === r.invoiceId);
                return (
                  <tr key={r.id} className="border-b hover:bg-muted/30 cursor-pointer"
                    onDoubleClick={() => editReturn(r.id)}
                    title={r.status === "draft" ? t("salesReturns.doubleClickEdit") : t("salesReturns.doubleClickView")}>
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber ?? `SR-${r.id}`}</td>
                    <td className="px-3 py-2.5">{r.returnDate}</td>
                    <td className="px-3 py-2.5">{cusMap[r.customerId] ?? t("common.none")}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv?.docNumber ?? (r.invoiceId ? `SI-${r.invoiceId}` : t("common.none"))}</td>
                    <td className="px-3 py-2.5">{r.currencyCode}</td>
                    <td className="px-3 py-2.5 font-mono">{fmt(Number(r.totalAmount) - Number(r.vatAmount))}</td>
                    <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(r.vatAmount)}</td>
                    <td className="px-3 py-2.5 font-mono font-semibold">{fmt(r.totalAmount)}</td>
                    <td className="px-3 py-2.5">
                      {r.journalEntryId ? (
                        <button onClick={() => navigate(`/accounting/journals/${r.journalEntryId}?tab=lines`)}
                          className="font-mono text-xs text-blue-600 hover:underline">
                          JE-{r.journalEntryId}
                        </button>
                      ) : <span className="text-muted-foreground text-xs">{t("common.none")}</span>}
                    </td>
                    <td className="px-3 py-2.5"><span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", stCls)}>{statusLabel(r.status)}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title={t("salesReturns.actionEdit")}
                            onClick={() => editReturn(r.id)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-700 hover:text-primary hover:bg-muted"
                          title="طباعة"
                          onClick={() => openPrint(r)}>
                          <Printer className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                          title={t("salesReturns.actionDuplicate")}
                          onClick={() => duplicateReturn(r.id)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("salesReturns.actionPost")}
                            onClick={() => { if (confirm(t("salesReturns.confirmPost"))) postMut.mutate(r.id); }}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {r.status === "posted" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                            title={t("salesReturns.actionUnpost")}
                            onClick={() => { if (confirm(t("salesReturns.confirmUnpost"))) unpostMut.mutate(r.id); }}>
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm(t("salesReturns.confirmDelete"))) deleteMut.mutate(r.id); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <SalesPrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}

