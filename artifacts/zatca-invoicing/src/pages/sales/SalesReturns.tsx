import { useState, useEffect, useRef, useMemo } from "react";
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
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, CheckCircle2, Undo2, Calculator, FileText, ListOrdered, Pencil, Copy, Printer, FileSpreadsheet, FileDown, X, Loader2, Send } from "lucide-react";
import * as XLSX from "xlsx";
import {
  downloadCsv, matchCol, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import SalesPrintModal from "./SalesPrintModal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { AccountCombobox } from "@/components/AccountCombobox";
import { CustomerVatControl } from "@/components/CustomerVatControl";
import { DiscountRow } from "@/components/DiscountRow";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { safeLogoSrc } from "@/lib/export";

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

  // Sticky toggle — see SalesDocumentForm for behavior contract.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]         = useState<any>({ ...EMPTY, priceIncludesVat: stickyPriceIncl.initial });
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
  async function handleCurrencyChange(code: string) {
    setForm((p: any) => ({ ...p, currencyCode: code, exchangeRate: getLatestRate(code) }));
    await repriceAllLinesForCurrency(code);
  }

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

  /* ── Bulk action helpers ──
     Iterate sequentially and partition successes from failures so we can
     show ONE toast at the end ("ok of N succeeded") instead of N toasts. */
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPrintBusy, setBulkPrintBusy] = useState(false);
  async function bulkRun(
    ids: number[],
    perId: (id: number) => Promise<void>,
  ): Promise<{ ok: number; failed: Array<{ id: number; error: string }> }> {
    let ok = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      try { await perId(id); ok++; }
      catch (e: any) { failed.push({ id, error: e?.message ?? "خطأ" }); }
    }
    return { ok, failed };
  }

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
    setForm({ ...EMPTY, ...loadAcctDefaults(), priceIncludesVat: stickyPriceIncl.read() });
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

  // Per-currency price cache: itemId → [{ currencyCode, salePrice, ... }]
  const [itemCurrencyPricesMap, setItemCurrencyPricesMap] = useState<Record<string, any[]>>({});
  async function fetchItemCurrencyPrices(itemId: string): Promise<any[]> {
    if (itemCurrencyPricesMap[itemId]) return itemCurrencyPricesMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/currency-prices?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemCurrencyPricesMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }
  function pickCurrencySale(rows: any[], code: string): string | null {
    const m = rows.find((p: any) => p.currencyCode === code);
    if (!m || m.salePrice == null || m.salePrice === "") return null;
    return String(m.salePrice);
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) return;
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    let chosenPrice: string = String(base?.salePrice ?? item.sellPrice ?? item.price ?? "0");
    const code = form.currencyCode;
    if (code && defaultCurrency && code !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const m = pickCurrencySale(cps, code);
      if (m != null) chosenPrice = m;
    }
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
        unitPrice: chosenPrice,
        vatRate:   String(item.vatRate ?? "15"),
      };
      return { ...updated, lineTotal: calcLineTotal(updated, !!form.priceIncludesVat).toFixed(2) };
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
        const v = row?.salePrice ?? item?.sellPrice ?? item?.price;
        if (v != null) np = String(v);
      } else {
        const cps = await fetchItemCurrencyPrices(l.itemId);
        const m = pickCurrencySale(cps, code);
        if (m != null) np = m;
      }
      if (np != null) updates[l._id] = np;
    }
    if (myVersion !== repriceVersion.current) return;
    if (!Object.keys(updates).length) return;
    setLines(prev => prev.map(l => {
      const np = updates[l._id];
      if (np == null) return l;
      const updated: ReturnLine = { ...l, unitPrice: np };
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
  const invMap = useMemo(
    () => Object.fromEntries((invoices as any[]).map((i: any) => [i.id, i.docNumber ?? `SI-${i.id}`])),
    [invoices],
  );

  const statusLabel = (s: string) =>
    s === "posted" ? t("status.posted") : t("status.draft");

  /* ── Audit-grid column model ────────────────────────────────────────── */
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                                type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                              type: "none", valueOf: () => "" },
    { key: "doc",      label: t("salesReturns.colReturnNumber"), type: "text", valueOf: (r) => r.docNumber ?? `SR-${r.id}` },
    { key: "date",     label: t("salesReturns.date"),            type: "text", valueOf: (r) => r.returnDate ?? "" },
    { key: "customer", label: t("salesReturns.customer"),        type: "text", valueOf: (r) => cusMap[r.customerId] ?? "" },
    { key: "invoice",  label: t("salesReturns.colInvoice"),      type: "text", valueOf: (r) => r.invoiceId ? (invMap[r.invoiceId] ?? `SI-${r.invoiceId}`) : "" },
    { key: "currency", label: t("salesReturns.currency"),        type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: "المجموع",                          type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0) },
    { key: "vat",      label: t("salesReturns.vatLabel"),        type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: t("salesReturns.totalLabel"),      type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "journal",  label: t("salesReturns.colJournal"),      type: "text", valueOf: (r) => r.journalEntryId ? `JE-${r.journalEntryId}` : "" },
    { key: "status",   label: t("salesReturns.colStatus"),       type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "_act",     label: t("salesReturns.colActions"),      type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const [tableSearch, setTableSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted">("all");

  const layout = useAuditGridLayout({
    screenSlug: "salesReturnsAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);

  /* ── Filtering ── */
  const filteredReturns = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (returns_ as any[]).filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [
          r.docNumber, `SR-${r.id}`, r.returnDate, cusMap[r.customerId],
          invMap[r.invoiceId], r.currencyCode, r.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const f = layout.colFilters[col.key];
        if (!f) continue;
        if (!matchCol(col.valueOf(r), f, col.type)) return false;
      }
      return true;
    });
  }, [returns_, tableSearch, statusFilter, layout.colFilters, cusMap, invMap]);

  /* ── Pagination ── */
  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredReturns.length / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) setPage(safePage);
  const pagedReturns = useMemo(
    () => pageSize === 0 ? filteredReturns : filteredReturns.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredReturns, pageSize, safePage],
  );
  const pageStart = filteredReturns.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredReturns.length : Math.min(safePage * pageSize, filteredReturns.length);

  /* ── Totals ── */
  const totals = useMemo(() => filteredReturns.reduce(
    (a, r: any) => {
      const sub = Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0);
      a.subtotal += sub;
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredReturns]);

  /* ── Visible columns in user's saved order ── */
  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find((c) => c.key === "_sel")!;
    const idx = COLUMNS.find((c) => c.key === "_idx")!;
    const act = COLUMNS.find((c) => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(
    () => DATA_KEYS.map((k) => COLUMNS.find((c) => c.key === k)!).map((c) => ({ key: c.key, label: c.label })),
    [DATA_KEYS, COLUMNS],
  );

  /* ──────────────────────────────────────────────────────────────────
     Page-level Print / PDF / Excel helpers (toolbar buttons in header)
     ────────────────────────────────────────────────────────────────── */
  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const safeLogo = safeLogoSrc((user?.company as any)?.logo) ?? "";
  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      toast({
        title: "تم حظر النافذة المنبثقة",
        description: "الرجاء السماح بفتح النوافذ المنبثقة من المتصفح للطباعة",
        variant: "destructive",
      });
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  };
  const itemsMap = useMemo(() => {
    const m: Record<number, any> = {};
    for (const it of (inventoryItems as any[])) m[Number(it.id)] = it;
    return m;
  }, [inventoryItems]);

  // Build the page-level summary print HTML (one row per return)
  const buildReturnsListHtml = (source: any[] = filteredReturns) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const sumSubtotal = source.reduce((a, r: any) => a + (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)), 0);
    const sumVat      = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTotal    = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>`
      : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>`
      : "";
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(t("salesReturns.title"))}</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.h { text-align:center; margin-bottom:8px; }
.h h1 { margin:0 0 4px; font-size:18px; }
.h .meta { font-size:11px; color:#555; }
.totals { display:flex; gap:16px; justify-content:center; margin:8px 0 12px; font-size:12px; }
.totals span b { color:#1e3a8a; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:right; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
tfoot td { padding:6px 8px; border:1px solid #1e3a8a; background:#eef2ff; font-weight:700; }
.num { font-family:"Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(t("salesReturns.title"))}</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد المرتجعات: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSubtotal.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTotal.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم المرتجع</th><th>التاريخ</th><th>العميل</th><th>الفاتورة</th>
  <th>العملة</th><th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => {
  const sub = Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0);
  const status = r.status === "posted" ? "مرحّل" : r.status === "voided" ? "ملغى" : "مسودة";
  return `<tr>
    <td>${i + 1}</td>
    <td>${escapeHtml(r.docNumber ?? `SR-${r.id}`)}</td>
    <td>${escapeHtml(r.returnDate ?? "")}</td>
    <td>${escapeHtml(cusMap[r.customerId] ?? "")}</td>
    <td>${escapeHtml(r.invoiceId ? (invMap[r.invoiceId] ?? `SI-${r.invoiceId}`) : "")}</td>
    <td>${escapeHtml(r.currencyCode ?? "")}</td>
    <td class="num">${sub.toFixed(2)}</td>
    <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
    <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
    <td>${status}</td>
  </tr>`;
}).join("")}
</tbody><tfoot><tr>
  <td colspan="6">الإجمالي العام</td>
  <td class="num">${sumSubtotal.toFixed(2)}</td>
  <td class="num">${sumVat.toFixed(2)}</td>
  <td class="num">${sumTotal.toFixed(2)}</td>
  <td></td>
</tr></tfoot></table>
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  // Build the bulk-print HTML — one full A4 portrait sheet per selected return
  // showing every line (item / qty / price / vat / total) of that return.
  const buildBulkReturnsHtml = (docs: any[]) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const grandSub = docs.reduce((a, d: any) => a + (Number(d.totalAmount ?? 0) - Number(d.vatAmount ?? 0)), 0);
    const grandVat = docs.reduce((a, d: any) => a + Number(d.vatAmount ?? 0), 0);
    const grandTot = docs.reduce((a, d: any) => a + Number(d.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:block;margin:0 auto;" /></div>`
      : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;text-align:center;">${escapeHtml(user.company.nameAr)}</div>`
      : "";
    const sections = docs.map((d: any) => {
      const lines: any[] = Array.isArray(d.lines) ? d.lines : [];
      const docNo  = d.docNumber ?? `SR-${d.id}`;
      const status = d.status === "posted" ? "مرحّل" : d.status === "voided" ? "ملغى" : "مسودة";
      const sub = Number(d.totalAmount ?? 0) - Number(d.vatAmount ?? 0);
      const linesHtml = lines.length === 0
        ? `<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:14px;">لا توجد أصناف لهذا المرتجع.</td></tr>`
        : lines.map((l: any, i: number) => {
            const it   = itemsMap[Number(l.itemId)];
            const itemLabel = it
              ? (it.code ? `${it.code} — ${it.nameAr ?? it.nameEn ?? ""}` : (it.nameAr ?? it.nameEn ?? `#${it.id}`))
              : (l.description ?? `#${l.itemId ?? ""}`);
            const qty  = Number(l.quantity ?? 0);
            const up   = Number(l.unitPrice ?? 0);
            const vat  = Number(l.vatAmount ?? 0);
            const ttl  = Number(l.totalAmount ?? 0);
            return `<tr>
              <td style="text-align:center;">${i + 1}</td>
              <td>${escapeHtml(itemLabel)}</td>
              <td>${escapeHtml(l.description ?? "")}</td>
              <td class="num">${qty.toFixed(2)}</td>
              <td class="num">${up.toFixed(2)}</td>
              <td class="num">${vat.toFixed(2)}</td>
              <td class="num">${ttl.toFixed(2)}</td>
            </tr>`;
          }).join("");
      return `
<section class="doc">
  <div class="doc-head">
    <span class="badge b-doc">رقم المرتجع: ${escapeHtml(docNo)}</span>
    <span class="badge b-date">التاريخ: ${escapeHtml(d.returnDate ?? "")}</span>
    <span class="badge b-cust">العميل: ${escapeHtml(cusMap[d.customerId] ?? "")}</span>
    ${d.invoiceId ? `<span class="badge b-inv">الفاتورة: ${escapeHtml(invMap[d.invoiceId] ?? `SI-${d.invoiceId}`)}</span>` : ""}
    <span class="badge b-status s-${escapeHtml(d.status)}">${escapeHtml(status)}</span>
  </div>
  ${d.notes ? `<div class="desc">${escapeHtml(d.notes)}</div>` : ""}
  <table>
    <thead><tr>
      <th style="width:30px;">#</th><th>الصنف</th><th>البيان</th>
      <th style="width:70px;">الكمية</th><th style="width:80px;">السعر</th>
      <th style="width:75px;">الضريبة</th><th style="width:90px;">الإجمالي</th>
    </tr></thead>
    <tbody>${linesHtml}</tbody>
    <tfoot><tr>
      <td colspan="5" style="text-align:left;">إجمالي المرتجع</td>
      <td class="num">${Number(d.vatAmount ?? 0).toFixed(2)}</td>
      <td class="num">${Number(d.totalAmount ?? 0).toFixed(2)}</td>
    </tr><tr>
      <td colspan="5" style="text-align:left;">المجموع قبل الضريبة</td>
      <td colspan="2" class="num" style="text-align:right;">${sub.toFixed(2)}</td>
    </tr></tfoot>
  </table>
</section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة المرتجعات المحدّدة</title>
<style>
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family:"Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.h { text-align:center; margin-bottom:10px; }
.h h1 { margin:0 0 4px; font-size:17px; }
.h .meta { font-size:11px; color:#555; }
.grand { display:flex; gap:14px; justify-content:center; margin:6px 0 14px; font-size:12px; }
.grand span b { color:#0f766e; }
section.doc { margin:0 0 14px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; page-break-inside:avoid; background:#fff; }
.doc-head { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid; }
.b-doc{background:#eef2ff;border-color:#a5b4fc;color:#3730a3;}
.b-date{background:#fef9c3;border-color:#fde047;color:#713f12;}
.b-cust{background:#ecfeff;border-color:#67e8f9;color:#155e75;}
.b-inv{background:#f5f3ff;border-color:#c4b5fd;color:#5b21b6;}
.b-status.s-posted{background:#d1fae5;border-color:#34d399;color:#065f46;}
.b-status.s-draft{background:#f1f5f9;border-color:#94a3b8;color:#334155;}
.b-status.s-voided{background:#fee2e2;border-color:#f87171;color:#991b1b;}
.desc { font-size:11px; color:#475569; padding:4px 6px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:4px; margin-bottom:6px; }
table { width:100%; border-collapse:collapse; font-size:10.5px; }
thead th { background:#1e3a8a; color:#fff; padding:5px 6px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:4px 6px; border:1px solid #d1d5db; text-align:right; }
tfoot td { padding:5px 6px; border:1px solid #1e3a8a; background:#eef2ff; font-weight:700; }
.num { font-family:"Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">${logoHtml}${companyHtml}<h1>المرتجعات المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد المرتجعات: ${docs.length}</div></div>
<div class="grand">
  <span>إجمالي المجموع: <b>${grandSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${grandVat.toFixed(2)}</b></span>
  <span>الإجمالي العام: <b>${grandTot.toFixed(2)}</b></span>
</div>
${sections}
<script>setTimeout(()=>window.print(),350);</script></body></html>`;
  };

  const handlePrint      = () => openPrintWindow(buildReturnsListHtml());
  const handleExportPDF  = () => openPrintWindow(buildReturnsListHtml());
  const handleExportExcel = () => {
    if (filteredReturns.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const rows = filteredReturns.map((r: any) => ({
      "رقم المرتجع": r.docNumber ?? `SR-${r.id}`,
      "التاريخ": r.returnDate ?? "",
      "العميل": cusMap[r.customerId] ?? "",
      "الفاتورة": r.invoiceId ? (invMap[r.invoiceId] ?? `SI-${r.invoiceId}`) : "",
      "العملة": r.currencyCode ?? "",
      "المجموع": (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "الحالة": r.status === "posted" ? "مرحّل" : r.status === "voided" ? "ملغى" : "مسودة",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t("salesReturns.title"));
    XLSX.writeFile(wb, `sales-returns-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // Bulk-print: fetch every selected return's full lines, then open the
  // multi-doc print sheet. Falls back to the cached row if a fetch fails.
  async function handleBulkPrint() {
    const ids = Array.from(layout.selected);
    if (ids.length === 0) return;
    setBulkPrintBusy(true);
    try {
      const idSet = new Set(ids.map(Number));
      const ordered = (filteredReturns as any[]).filter((r) => idSet.has(Number(r.id)));
      let failed = 0;
      const docs = await Promise.all(
        ordered.map(async (row: any) => {
          try {
            const res = await fetch(`${API}/api/sales/sales-returns/${row.id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
          } catch {
            failed += 1;
            return { ...row, lines: [] };
          }
        }),
      );
      openPrintWindow(buildBulkReturnsHtml(docs));
      if (failed > 0) {
        toast({
          title: "تعذّر تحميل تفاصيل بعض المرتجعات",
          description: `تمت طباعة ${docs.length} مع ${failed} مرتجع بدون بنود تفصيلية`,
          variant: "destructive",
        });
      }
    } finally {
      setBulkPrintBusy(false);
    }
  }

  function exportCsv() {
    if (filteredReturns.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredReturns.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`sales-returns-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  const { theme, footerTheme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;

  /* ── Bulk action handlers (post / unpost / delete) ──
     Partition selected rows by status because not every action applies to
     every row (e.g. you can only post drafts, can only unpost posted ones,
     can't delete posted ones — same business rules as SalesAuditGrid). */
  const allFilteredIds: number[] = useMemo(
    () => filteredReturns.map((r: any) => Number(r.id)),
    [filteredReturns],
  );
  const selectedReturns = useMemo(
    () => (returns_ as any[]).filter((r) => isSelected(Number(r.id))),
    [returns_, isSelected],
  );
  const selectedDrafts   = selectedReturns.filter((r) => r.status !== "posted");
  const selectedPosted   = selectedReturns.filter((r) => r.status === "posted");
  const selectedDeletable = selectedReturns.filter((r) => r.status !== "posted");

  async function bulkPost() {
    const ids = selectedDrafts.map((r) => Number(r.id));
    if (ids.length === 0) {
      toast({ title: "لا توجد مسوّدات ضمن المحدَّد", variant: "destructive" });
      return;
    }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-returns/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم ترحيل ${ok} مرتجع بنجاح` });
      else toast({ title: `ترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnpost() {
    const ids = selectedPosted.map((r) => Number(r.id));
    if (ids.length === 0) {
      toast({ title: "لا توجد مرتجعات مرحَّلة ضمن المحدَّد", variant: "destructive" });
      return;
    }
    if (!window.confirm(`فك ترحيل ${ids.length} مرتجع؟ سيتم حذف القيود المحاسبية المرتبطة.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-returns/${id}/unpost`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم فك ترحيل ${ok} مرتجع` });
      else toast({ title: `فك الترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) {
      toast({ title: "لا يمكن حذف المرتجعات المرحَّلة. فك الترحيل أولاً.", variant: "destructive" });
      return;
    }
    if (!window.confirm(`حذف ${ids.length} مرتجع نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-returns/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم حذف ${ok} مرتجع` });
      else toast({ title: `حذف: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-primary" />{t("salesReturns.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesReturns.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          {/* Solid green "New Return" button (visual far-left in RTL) */}
          <Button
            onClick={() => { reset(); setShowForm(true); }}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t("salesReturns.newReturn")}
          </Button>
          {/* Grouped export pill: PDF | Excel | Print */}
          <div className="inline-flex items-stretch rounded-md border border-slate-300 bg-white shadow-sm overflow-hidden">
            <Button
              variant="ghost" size="sm" onClick={handleExportPDF}
              className="h-9 rounded-none gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-700 px-3"
            >
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <div className="w-px bg-slate-200" />
            <Button
              variant="ghost" size="sm" onClick={handleExportExcel}
              className="h-9 rounded-none gap-1.5 text-green-700 hover:bg-green-50 hover:text-green-700 px-3"
            >
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <div className="w-px bg-slate-200" />
            <Button
              variant="ghost" size="sm" onClick={handlePrint}
              className="h-9 rounded-none gap-1.5 text-slate-700 hover:bg-slate-50 hover:text-slate-700 px-3"
            >
              <Printer className="h-4 w-4" /> طباعة
            </Button>
          </div>
        </div>
      </div>

      {showForm && (() => {
        // Look up the currently-edited return so we can render its status
        // pill inline with the form title. On a fresh /new there's no
        // "current" return — the badge + navigator are skipped in that case.
        const currentRet = editingId
          ? (returns_ as any[]).find((r: any) => Number(r.id) === Number(editingId))
          : null;
        const customerNameById = (id: any) => {
          const c = (customers as any[]).find((c: any) => Number(c.id) === Number(id));
          return c ? (c.nameAr ?? c.nameEn ?? `#${c.id}`) : "—";
        };
        return (
        <>
          {editingId && (returns_ as any[]).length > 0 && (
            <div className="flex justify-end">
              <DocNavigator
                items={(returns_ as any[]).map((d: any) => ({
                  id: d.id,
                  docNumber: d.docNumber,
                  partyName: customerNameById(d.customerId),
                  date: d.returnDate ?? "",
                  total: d.totalAmount ?? 0,
                  currencyCode: d.currencyCode ?? "",
                }))}
                currentId={editingId}
                onSelect={(id) => editReturn(Number(id))}
                fallbackPrefix="SR-"
              />
            </div>
          )}
        <FormPanel
          icon={RotateCcw}
          title={
            <span className="inline-flex items-center gap-2 flex-wrap">
              {t("salesReturns.formTitle")}
              {currentRet && <DocStatusBadge status={currentRet.status} />}
            </span>
          }
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
              <Field label={
                <span className="flex items-center justify-between gap-2 w-full">
                  <span>{t("salesReturns.exchangeRate")}</span>
                  {form.currencyCode && form.currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                    <span className="text-[10px] text-muted-foreground font-normal" dir="ltr">
                      1 {form.currencyCode} = {Number(form.exchangeRate) > 0 ? Number(form.exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                    </span>
                  )}
                </span>
              }>
                <Input type="text" inputMode="decimal" dir="ltr" className="text-left" value={form.exchangeRate} onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
              </Field>
              <Field label={t("salesReturns.paymentType")}>
                <Select value={form.paymentType} onValueChange={(v) => setForm((p: any) => {
                  const next: any = { ...p, paymentType: v };
                  if (v === "cash") {
                    if (!p.cashBoxId) {
                      const first = [...(cashBoxes as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                      if (first) next.cashBoxId = String(first.id);
                    }
                    next.bankAccountId = "";
                  } else if (v === "bank") {
                    if (!p.bankAccountId) {
                      const first = [...(bankAccounts as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                      if (first) next.bankAccountId = String(first.id);
                    }
                    next.cashBoxId = "";
                  } else {
                    next.cashBoxId = "";
                    next.bankAccountId = "";
                  }
                  return next;
                })}>
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
                  onChange={e => {
                    setForm((p: any) => ({ ...p, priceIncludesVat: e.target.checked }));
                    stickyPriceIncl.persist(e.target.checked);
                  }}
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
        </>
        );
      })()}

      {/* ── Audit-grid toolbar ───────────────────────────────────────────── */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir={isRtl ? "rtl" : "ltr"}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <RotateCcw className="h-4 w-4 opacity-90" />
            جرد مرتجعات المبيعات
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button type="button" size="sm" variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)} onClick={exportCsv}>
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir={isRtl ? "rtl" : "ltr"}>
          <Input
            placeholder="بحث (مستند، عميل، فاتورة، عملة)…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "posted"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? "الكل" : statusLabel(s)}
              </button>
            ))}
          </div>
          {Object.values(colFilters).some((v) => v) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filteredReturns.length} مرتجع
            {filteredReturns.length !== returns_.length && <span className="text-slate-400"> / {returns_.length}</span>}
          </span>
        </div>
        {/* ── Bulk-action bar (visible only when one or more rows selected) ── */}
        <AuditGridBulkBar
          count={layout.selected.size}
          onClear={clearSelection}
          busy={bulkBusy}
        >
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-blue-700 hover:bg-blue-600 text-white"
            onClick={handleBulkPrint}
            disabled={layout.selected.size === 0 || bulkPrintBusy}
            title={`طباعة (${layout.selected.size})`}
          >
            {bulkPrintBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
            طباعة ({layout.selected.size})
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkPost}
            disabled={bulkBusy || selectedDrafts.length === 0}
            title={selectedDrafts.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedDrafts.length} مرتجع`}
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            ترحيل ({selectedDrafts.length})
          </Button>
          <Button
            type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkUnpost}
            disabled={bulkBusy || selectedPosted.length === 0 || !isAdmin}
            title={!isAdmin
              ? "فك الترحيل متاح للمدير فقط"
              : selectedPosted.length === 0
                ? "لا توجد مرتجعات مرحَّلة ضمن المحدَّد"
                : `فك ترحيل ${selectedPosted.length} مرتجع`}
          >
            <Undo2 className="h-3.5 w-3.5" />
            فك الترحيل ({selectedPosted.length})
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف المرتجعات المرحَّلة. فك الترحيل أولاً."
              : `حذف ${selectedDeletable.length} مرتجع (مسوّدة فقط)`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── Audit-grid table ─────────────────────────────────────────────── */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
          ) : filteredReturns.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {returns_.length === 0 ? t("salesReturns.noReturns") : "لا توجد مرتجعات ضمن التصفية الحالية"}
            </div>
          ) : (
            <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              <colgroup>
                {visibleColumns.map((col) => (
                  <col key={col.key} data-col-key={col.key}
                    style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {visibleColumns.map((col, idx) => (
                    <th
                      key={col.key}
                      data-col-key={col.key}
                      style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                      className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]"
                    >
                      {col.key === "_sel" ? (
                        <HeaderSelectCheckbox
                          allSelected={isAllSelected(allFilteredIds)}
                          someSelected={isSomeSelected(allFilteredIds)}
                          onToggle={() => toggleAll(allFilteredIds)}
                          disabled={allFilteredIds.length === 0 || bulkBusy}
                        />
                      ) : col.label}
                      {col.key !== "_sel" && (
                        <span
                          {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
                <tr className="bg-amber-50/80 border-b border-amber-200">
                  {visibleColumns.map((col) => (
                    <th key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                      {col.type === "none" ? null : (
                        <Input
                          value={colFilters[col.key] ?? ""}
                          onChange={(e) => setColFilter(col.key, e.target.value)}
                          placeholder={col.type === "num" ? ">=100" : "بحث…"}
                          className="h-6 text-[10.5px] px-1.5 border-slate-300 bg-white"
                          title={col.type === "num" ? "أمثلة: >=100, <500, =0" : "بحث جزئي"}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedReturns.map((r: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const stCls = STATUS_CLS[r.status] ?? STATUS_CLS.draft;
                  const rid = Number(r.id);
                  const isSel = isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => toggleRow(rid)}
                              ariaLabel={`تحديد المرتجع ${r.docNumber ?? `SR-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{r.docNumber ?? `SR-${r.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">{r.returnDate}</td>;
                      case "customer":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.customer ? "" : "max-w-[200px]")} title={cusMap[r.customerId] ?? ""}>{cusMap[r.customerId] ?? t("common.none")}</td>;
                      case "invoice":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{r.invoiceId ? (invMap[r.invoiceId] ?? `SI-${r.invoiceId}`) : <span className="text-muted-foreground">{t("common.none")}</span>}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{r.currencyCode}</td>;
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-slate-800">{fmt(Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0))}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(r.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(r.totalAmount)}</td>;
                      case "journal":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {r.journalEntryId ? (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); navigate(`/accounting/journals/${r.journalEntryId}?tab=lines`); }}
                                className="font-mono text-[10px] text-blue-600 hover:underline"
                              >
                                JE-{r.journalEntryId}
                              </button>
                            ) : <span className="text-muted-foreground text-[10px]">{t("common.none")}</span>}
                          </td>
                        );
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", stCls)}>{statusLabel(r.status)}</span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  title={t("salesReturns.actionEdit")}
                                  onClick={(e) => { e.stopPropagation(); editReturn(r.id); }}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-700 hover:text-primary hover:bg-muted"
                                title="طباعة"
                                onClick={(e) => { e.stopPropagation(); openPrint(r); }}>
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                title={t("salesReturns.actionDuplicate")}
                                onClick={(e) => { e.stopPropagation(); duplicateReturn(r.id); }}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-700 hover:bg-emerald-50" title={t("salesReturns.actionPost")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("salesReturns.confirmPost"))) postMut.mutate(r.id); }}>
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {r.status === "posted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                  title={t("salesReturns.actionUnpost")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("salesReturns.confirmUnpost"))) unpostMut.mutate(r.id); }}>
                                  <Undo2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("salesReturns.confirmDelete"))) deleteMut.mutate(r.id); }}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        );
                      default:
                        return <td key={col.key} className="px-2 py-1 border border-slate-200" />;
                    }
                  };
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? "bg-emerald-100/70 hover:bg-emerald-100" : "hover:bg-amber-50/60",
                      )}
                      onClick={(e) => {
                        // Skip toggle when the click landed on an interactive child.
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(rid);
                      }}
                      onDoubleClick={() => editReturn(r.id)}
                      title="اضغط لتحديد الصف، أو مرتين لفتح المرتجع"
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    // The "الإجمالي:" label sits in the FIRST non-checkbox cell.
                    // We added _sel as the new column 0, so the label now belongs at i === 1.
                    if (col.key === "_sel") {
                      return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                    }
                    if (i === 1) {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>الإجمالي:</td>;
                    }
                    if (col.key === "subtotal") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.subtotal)}</td>;
                    }
                    if (col.key === "vat") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.vat)}</td>;
                    }
                    if (col.key === "total") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.total)}</td>;
                    }
                    return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filteredReturns.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="مرتجع"
        />
      </div>
      <SalesPrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}

