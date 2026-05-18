import { useState, useEffect, useRef, useMemo } from "react";
import MultiBranchFilter from "@/components/MultiBranchFilter";
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
import {
  Plus, Trash2, RotateCcw, CheckCircle2, Printer, Wallet, CreditCard, TrendingUp,
  TrendingDown, Undo2, Pencil, FileText, ListOrdered, Copy,
  FileSpreadsheet, FileDown, X, Loader2,
} from "lucide-react";
import * as XLSX from "xlsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { DiscountRow } from "@/components/DiscountRow";
import { SupplierVatControl } from "@/components/SupplierVatControl";
import { cn } from "@/lib/utils";
import {
  downloadCsv, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  type AdvFilter, isAdvActive, matchAdv, describeAdv,
} from "@/lib/advFilter";
import { AdvFilterPopover } from "@/components/auditGrid/AdvFilterPopover";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { safeLogoSrc } from "@/lib/export";
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
  freeQty: string;
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
    qty: "1", freeQty: "0", unitPrice: "0", discount: "0", vatRate: "15", lineTotal: "0",
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
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const branchKey = branchIds.length ? branchIds.slice().sort((a, b) => a - b).join(",") : "all";

  const { data: returns_ = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-returns", cid, branchKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      if (branchIds.length) params.set("branchIds", branchIds.join(","));
      const r = await fetch(`${API}/api/purchasing/purchase-returns?${params.toString()}`, { headers: authH });
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

  async function handleCurrencyChange(code: string) {
    setForm((p: any) => ({ ...p, currencyCode: code, exchangeRate: getLatestRate(code) }));
    await repriceAllLinesForCurrency(code);
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
        freeQty:     String(l.freeQty ?? "0"),
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
        vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
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
        freeQty:     String(l.freeQty ?? "0"),
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
        vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
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
          freeQty:     String(l.freeQty ?? "0"),
          unitPrice:   String(l.unitPrice ?? 0),
          discount:    String(l.discount  ?? "0"),
          vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
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
    if (!item) return;
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    let chosenPrice: string = String(base?.costPrice ?? item.costPrice ?? "0");
    const code = form.currencyCode;
    if (code && defaultCurrency && code !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const m = pickCurrencyCost(cps, code);
      if (m != null) chosenPrice = m;
    }
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
        unitPrice: chosenPrice,
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
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
        const v = row?.costPrice ?? item?.costPrice;
        if (v != null) np = String(v);
      } else {
        const cps = await fetchItemCurrencyPrices(l.itemId);
        const m = pickCurrencyCost(cps, code);
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
    // Required-fields gate (mirrors the server's 400 in /purchase-returns):
    // every purchase return must carry an explicit supplier + branch.
    // Surfaced as a destructive Arabic toast BEFORE the network round-trip
    // so the user sees the failure instantly with both missing fields listed.
    const missing: string[] = [];
    if (!form.supplierId) missing.push("المورد");
    if (!form.branchId)   missing.push("الفرع");
    if (missing.length) {
      toast({
        title: "⚠️ بيانات ناقصة — لا يمكن حفظ المرتجع",
        description: `الحقول التالية مطلوبة: ${missing.join("، ")}`,
        variant: "destructive",
      });
      return;
    }
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
      code: i.code ?? undefined,
      label: itemName(i),
    })),
  ];
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));

  const lineColHeaders = [
    tr("lineCols.itemCode"),
    tr("lineCols.item"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    t("salesDocForm.colFreeQty"),
    tr("lineCols.price"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.total"),
    tr("lineCols.notes"),
    "",
  ];
  // ── Audit-grid scaffolding ──────────────────────────────────────────────
  const [tableSearch, setTableSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted">("all");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPrintBusy, setBulkPrintBusy] = useState(false);

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : s === "posted" ? tr("postedM") : tr("draft");

  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                     type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                    type: "none", valueOf: () => "" },
    { key: "doc",      label: tr("listCols.number"),  type: "text", valueOf: (r) => r.docNumber ?? `PR-${r.id}` },
    { key: "date",     label: tr("listCols.date"),    type: "text", valueOf: (r) => r.returnDate ?? "" },
    { key: "supplier", label: tr("listCols.supplier"),type: "text", valueOf: (r) => supMap[r.supplierId] ?? "" },
    { key: "currency", label: tr("listCols.currency"),type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: tr("listCols.subtotal"),type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0) },
    { key: "vat",      label: tr("listCols.vat"),     type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: tr("listCols.total"),   type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "journal",  label: tr("listCols.journal"), type: "text", valueOf: (r) => r.journalEntryId ? `JE-${r.journalEntryId}` : "" },
    { key: "status",   label: tr("listCols.status"),  type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "_act",     label: tr("listCols.actions"), type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "purchaseReturnsAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, footerTheme, colWidths, colFilters, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;


  // Per-column advanced filter (two conditions joined by AND/OR) — shared
  // primitives in lib/advFilter.ts + components/auditGrid/AdvFilterPopover.
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const clearColAdv = (key: string) =>
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  const clearAllColFilters = () => { clearColFilters(); setColAdv({}); };
  const filteredReturns = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (returns_ as any[]).filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [
          r.docNumber, `PR-${r.id}`, r.returnDate, supMap[r.supplierId],
          r.currencyCode, r.notes, r.supplierInvoiceNumber,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const adv = colAdv[col.key];
        if (!isAdvActive(adv)) continue;
        if (!matchAdv(col.valueOf(r), adv, col.type)) return false;
      }
      return true;
    });
  }, [returns_, tableSearch, statusFilter, colAdv, supMap]);

  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredReturns.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedReturns = useMemo(
    () => pageSize === 0 ? filteredReturns : filteredReturns.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredReturns, pageSize, safePage],
  );
  const pageStart = filteredReturns.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredReturns.length : Math.min(safePage * pageSize, filteredReturns.length);

  const totals = useMemo(() => filteredReturns.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredReturns]);

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

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const safeLogo = safeLogoSrc((user?.company as any)?.logo) ?? "";
  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بفتح النوافذ المنبثقة من المتصفح للطباعة", variant: "destructive" });
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  };

  const buildListHtml = (source: any[] = filteredReturns) => {
    const reportDate = new Date().toLocaleDateString("ar-SA");
    const sumSub = source.reduce((a, r: any) => a + (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)), 0);
    const sumVat = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTot = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>` : "";
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(tr("title"))}</title>
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
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(tr("title"))}</h1>
<div class="meta">تاريخ التقرير: ${reportDate} — عدد المردودات: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم المستند</th><th>التاريخ</th><th>المورد</th><th>العملة</th>
  <th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>القيد</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `PR-${r.id}`)}</td>
  <td>${escapeHtml(r.returnDate ?? "")}</td>
  <td>${escapeHtml(supMap[r.supplierId] ?? "")}</td>
  <td>${escapeHtml(r.currencyCode ?? "")}</td>
  <td class="num">${(Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2)}</td>
  <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
  <td>${r.journalEntryId ? `JE-${escapeHtml(r.journalEntryId)}` : ""}</td>
  <td>${escapeHtml(statusLabel(r.status))}</td>
</tr>`).join("")}
</tbody><tfoot><tr>
  <td colspan="5">الإجمالي العام</td>
  <td class="num">${sumSub.toFixed(2)}</td>
  <td class="num">${sumVat.toFixed(2)}</td>
  <td class="num">${sumTot.toFixed(2)}</td>
  <td colspan="2"></td>
</tr></tfoot></table>
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  const buildBulkHtml = (docs: any[]) => {
    const reportDate = new Date().toLocaleDateString("ar-SA");
    const grandSub = docs.reduce((a, d: any) => a + (Number(d.totalAmount ?? 0) - Number(d.vatAmount ?? 0)), 0);
    const grandVat = docs.reduce((a, d: any) => a + Number(d.vatAmount ?? 0), 0);
    const grandTot = docs.reduce((a, d: any) => a + Number(d.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;text-align:center;">${escapeHtml(user.company.nameAr)}</div>` : "";
    const sections = docs.map((d: any) => {
      const lns: any[] = Array.isArray(d.lines) ? d.lines : [];
      const docNo  = d.docNumber ?? `PR-${d.id}`;
      const linesHtml = lns.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">لا توجد بنود لهذا المردود.</td></tr>`
        : lns.map((l: any, i: number) => {
            const itemLabel = l.itemName ?? l.description ?? `#${l.itemId ?? ""}`;
            const qty = Number(l.qty ?? l.quantity ?? 0);
            const up  = Number(l.unitPrice ?? 0);
            const vat = Number(l.vatAmount ?? 0);
            const ttl = Number(l.lineTotal ?? l.totalAmount ?? 0);
            return `<tr>
              <td style="text-align:center;">${i + 1}</td>
              <td>${escapeHtml(itemLabel)}</td>
              <td class="num">${qty.toFixed(2)}</td>
              <td class="num">${up.toFixed(2)}</td>
              <td class="num">${vat.toFixed(2)}</td>
              <td class="num">${ttl.toFixed(2)}</td>
            </tr>`;
          }).join("");
      return `<section class="doc">
        <div class="doc-head">
          <span class="badge b-doc">رقم المردود: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">التاريخ: ${escapeHtml(d.returnDate ?? "")}</span>
          <span class="badge b-cust">المورد: ${escapeHtml(supMap[d.supplierId] ?? "")}</span>
          <span class="badge b-status s-${escapeHtml(d.status)}">${escapeHtml(statusLabel(d.status))}</span>
        </div>
        ${d.notes ? `<div class="desc">${escapeHtml(d.notes)}</div>` : ""}
        <table>
          <thead><tr>
            <th style="width:30px;">#</th><th>الصنف</th>
            <th style="width:70px;">الكمية</th><th style="width:80px;">السعر</th>
            <th style="width:75px;">الضريبة</th><th style="width:90px;">الإجمالي</th>
          </tr></thead>
          <tbody>${linesHtml}</tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:left;">المجموع</td>
            <td class="num">${Number(d.vatAmount ?? 0).toFixed(2)}</td>
            <td class="num">${Number(d.totalAmount ?? 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
      </section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة مردودات الشراء المحدّدة</title>
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
.b-status.s-posted{background:#d1fae5;border-color:#34d399;color:#065f46;}
.b-status.s-draft{background:#fef3c7;border-color:#fbbf24;color:#78350f;}
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
<div class="h">${logoHtml}${companyHtml}<h1>مردودات الشراء المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${reportDate} — عدد المردودات: ${docs.length}</div></div>
<div class="grand">
  <span>إجمالي المجموع: <b>${grandSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${grandVat.toFixed(2)}</b></span>
  <span>الإجمالي العام: <b>${grandTot.toFixed(2)}</b></span>
</div>
${sections}
<script>setTimeout(()=>window.print(),350);</script></body></html>`;
  };

  const handleExportPDF = () => openPrintWindow(buildListHtml());
  const handlePrint    = () => openPrintWindow(buildListHtml());
  const handleExportExcel = () => {
    if (filteredReturns.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const rows = filteredReturns.map((r: any) => ({
      "رقم المستند": r.docNumber ?? `PR-${r.id}`,
      "التاريخ": r.returnDate ?? "",
      "المورد": supMap[r.supplierId] ?? "",
      "العملة": r.currencyCode ?? "",
      "المجموع": (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "القيد": r.journalEntryId ? `JE-${r.journalEntryId}` : "",
      "الحالة": statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "مردودات الشراء");
    XLSX.writeFile(wb, `purchase-returns-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

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
            const res = await fetch(`${API}/api/purchasing/purchase-returns/${row.id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
          } catch { failed += 1; return { ...row, lines: [] }; }
        }),
      );
      openPrintWindow(buildBulkHtml(docs));
      if (failed > 0) {
        toast({ title: "تعذّر تحميل تفاصيل بعض المردودات", description: `تمت طباعة ${docs.length} مع ${failed} بدون بنود تفصيلية`, variant: "destructive" });
      }
    } finally { setBulkPrintBusy(false); }
  }

  function exportCsv() {
    if (filteredReturns.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
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
    downloadCsv(`purchase-returns-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  const allFilteredIds: number[] = useMemo(
    () => filteredReturns.map((r: any) => Number(r.id)),
    [filteredReturns],
  );
  const selectedRows = useMemo(
    () => (returns_ as any[]).filter((r) => isSelected(Number(r.id))),
    [returns_, isSelected],
  );
  const selectedPostable    = selectedRows.filter((r) => r.status === "draft");
  const selectedUnpostable  = selectedRows.filter((r) => r.status === "posted");
  const selectedDeletable   = selectedRows.filter((r) => r.status === "draft");

  async function bulkPost() {
    const ids = selectedPostable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد مسوّدات ضمن المحدَّد", variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      if (failed.length === 0) toast({ title: `تم ترحيل ${ok} مردود` });
      else toast({ title: `ترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnpost() {
    const ids = selectedUnpostable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد مردودات مرحَّلة ضمن المحدَّد", variant: "destructive" }); return; }
    if (!window.confirm(`إلغاء ترحيل ${ids.length} مردود؟`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}/unpost`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      if (failed.length === 0) toast({ title: `تم إلغاء ترحيل ${ok} مردود` });
      else toast({ title: `إلغاء: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا يمكن حذف المردودات المرحَّلة", variant: "destructive" }); return; }
    if (!window.confirm(`حذف ${ids.length} مردود نهائياً؟ لا يمكن التراجع.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      if (failed.length === 0) toast({ title: `تم حذف ${ok} مردود` });
      else toast({ title: `حذف: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

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
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => { reset(); setShowForm(true); }}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {tr("newReturn")}
          </Button>
          <div className="inline-flex items-stretch rounded-md border border-slate-300 bg-white shadow-sm overflow-hidden">
            <Button variant="ghost" size="sm" onClick={handleExportPDF}
              className="h-9 rounded-none gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-700 px-3">
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <div className="w-px bg-slate-200" />
            <Button variant="ghost" size="sm" onClick={handleExportExcel}
              className="h-9 rounded-none gap-1.5 text-green-700 hover:bg-green-50 hover:text-green-700 px-3">
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <div className="w-px bg-slate-200" />
            <Button variant="ghost" size="sm" onClick={handlePrint}
              className="h-9 rounded-none gap-1.5 text-slate-700 hover:bg-slate-50 hover:text-slate-700 px-3">
              <Printer className="h-4 w-4" /> طباعة
            </Button>
          </div>
        </div>
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
                    <span className="text-[10px] text-muted-foreground font-normal">= {Number(form.exchangeRate) > 0 ? Number(form.exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code}</span>
                  )}
                </span>}
              >
                <Input type="text" inputMode="decimal" dir="ltr" className="text-left" value={form.exchangeRate} onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
              </Field>
              <Field label={tr("settlementType")} required>
                <Select
                  value={form.paymentType}
                  onValueChange={(v) => setForm((p: any) => {
                    const next: any = { ...p, paymentType: v };
                    if (v === "cash") {
                      next.bankAccountId = "";
                      if (!p.cashBoxId) {
                        const first = [...(cashBoxes as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) next.cashBoxId = String(first.id);
                      } else next.cashBoxId = p.cashBoxId;
                    } else if (v === "bank") {
                      next.cashBoxId = "";
                      if (!p.bankAccountId) {
                        const first = [...(bankAccounts as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) next.bankAccountId = String(first.id);
                      } else next.bankAccountId = p.bankAccountId;
                    } else {
                      next.cashBoxId = "";
                      next.bankAccountId = "";
                    }
                    return next;
                  })}
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
                const GRID_COLS_PR = "110px minmax(260px,1.4fr) 160px 120px 90px 80px 110px 80px 80px 130px 180px 40px";
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
                    <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
                      onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                    {inventoryItems.length > 0 ? (
                      <SearchCombobox
                        items={itemComboItems}
                        value={l.itemId}
                        onValueChange={v => selectItem(l._id, v)}
                        placeholder={tr("selectItemCombo")}
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
                    {tr("equivIn")} {defaultCurrency?.code}: {fmt(totalAmount * Number(form.exchangeRate))}
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

      {/* ── Audit-grid toolbar ────────────────────────────── */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir={isRtl ? "rtl" : "ltr"}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <RotateCcw className="h-4 w-4 opacity-90" />
            جرد مردودات الشراء
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
            placeholder="بحث (مستند، مورد، عملة)…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <MultiBranchFilter value={branchIds} onChange={setBranchIds} size="sm" />
          <div className="flex gap-1">
            {(["all", "draft", "posted"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}>
                {statusLabel(s)}
              </button>
            ))}
          </div>
          {(Object.values(colFilters).some((v) => v) || Object.values(colAdv).some(isAdvActive)) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearAllColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filteredReturns.length} مردود
            {filteredReturns.length !== returns_.length && <span className="text-slate-400"> / {returns_.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection} busy={bulkBusy}>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-blue-700 hover:bg-blue-600 text-white"
            onClick={handleBulkPrint}
            disabled={layout.selected.size === 0 || bulkPrintBusy}
            title={`طباعة (${layout.selected.size})`}>
            {bulkPrintBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
            طباعة ({layout.selected.size})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkPost}
            disabled={bulkBusy || selectedPostable.length === 0}
            title={selectedPostable.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedPostable.length} مردود`}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            ترحيل ({selectedPostable.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد مردودًا واحدًا فقط للتعديل", variant: "destructive" }); return; }
              startEdit(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "فتح/تعديل المردود المحدَّد" : "حدِّد مردودًا واحدًا فقط"}>
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد مردودًا واحدًا فقط للنسخ", variant: "destructive" }); return; }
              duplicateReturn(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "إنشاء نسخة مماثلة من المردود المحدَّد" : "حدِّد مردودًا واحدًا فقط"}>
            <Copy className="h-3.5 w-3.5" />
            نسخة مماثلة
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkUnpost}
            disabled={bulkBusy || selectedUnpostable.length === 0}
            title={selectedUnpostable.length === 0 ? "لا توجد مردودات مرحَّلة ضمن المحدَّد" : `إلغاء ترحيل ${selectedUnpostable.length} مردود`}>
            <Undo2 className="h-3.5 w-3.5" />
            إلغاء الترحيل ({selectedUnpostable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف المردودات المرحَّلة"
              : `حذف ${selectedDeletable.length} مردود`}>
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── List ─────────────────────────────────────────── */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filteredReturns.filter((r: any) => r.status === "draft").length },
          { kind: "posted",    count: filteredReturns.filter((r: any) => r.status === "posted").length },
          { kind: "cancelled", count: filteredReturns.filter((r: any) => r.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
          ) : filteredReturns.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {returns_.length === 0 ? tr("noReturns") : "لا توجد مردودات ضمن التصفية الحالية"}
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
                    <th key={col.key} data-col-key={col.key}
                      style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                      className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]">
                      {col.key === "_sel" ? (
                        <HeaderSelectCheckbox
                          allSelected={isAllSelected(allFilteredIds)}
                          someSelected={isSomeSelected(allFilteredIds)}
                          onToggle={() => toggleAll(allFilteredIds)}
                          disabled={allFilteredIds.length === 0 || bulkBusy}
                        />
                      ) : (
                          <span className="inline-flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            {col.type !== "none" && (
                              <AdvFilterPopover colLabel={col.label || col.key} colType={col.type} value={colAdv[col.key]} active={isAdvActive(colAdv[col.key])} onApply={v => setColAdv(prev => ({ ...prev, [col.key]: v }))} onClear={() => clearColAdv(col.key)} />
                            )}
                          </span>
                        )}
                      {col.key !== "_sel" && (
                        <span {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedReturns.map((r: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
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
                              ariaLabel={`تحديد المردود ${r.docNumber ?? `PR-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{r.docNumber ?? `PR-${r.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">{r.returnDate}</td>;
                      case "supplier":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.supplier ? "" : "max-w-[200px]")} title={supMap[r.supplierId] ?? ""}>{supMap[r.supplierId] ?? "—"}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{r.currencyCode}</td>;
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-slate-800">{fmt(Number(r.totalAmount) - Number(r.vatAmount))}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(r.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(r.totalAmount)}</td>;
                      case "journal":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center font-mono text-[10px]">
                            {r.journalEntryId ? (
                              <button type="button"
                                className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                                title={tr("viewJournalTip")}
                                onClick={(e) => { e.stopPropagation(); window.location.href = `/accounting/journals/${r.journalEntryId}?tab=lines`; }}>
                                JE-{r.journalEntryId}
                              </button>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                        );
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border",
                              r.status === "posted"
                                ? "bg-green-50 text-green-700 border-green-200"
                                : "bg-amber-50 text-amber-700 border-amber-200"
                            )}>
                              {r.status === "posted" ? tr("postedM") : tr("draft")}
                            </span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-primary hover:bg-primary/10"
                                title={tr("printTip")} onClick={(e) => { e.stopPropagation(); openPrint(r); }}>
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              {r.status === "posted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-amber-700 hover:bg-amber-50"
                                  title={tr("unpostShort")}
                                  disabled={unpostMut.isPending}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(tr("confirmUnpost"))) unpostMut.mutate(r.id); }}>
                                  <Undo2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-700 hover:bg-blue-50"
                                  title={tr("editTip")} onClick={(e) => { e.stopPropagation(); startEdit(r.id); }}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                title={tr("duplicateTip")} onClick={(e) => { e.stopPropagation(); duplicateReturn(r.id); }}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-green-700 hover:bg-green-50"
                                  title={tr("postShort")}
                                  disabled={postMut.isPending}
                                  onClick={(e) => { e.stopPropagation(); postMut.mutate(r.id); }}>
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {r.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  onClick={(e) => { e.stopPropagation(); if (confirm(tr("confirmDelete"))) deleteMut.mutate(r.id); }}>
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
                    <tr key={r.id}
                      data-testid={`row-purchase-return-${r.id}`}
                      data-status={r.status}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? SEL_TONE : rowToneFor({ status: r.status }),
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(rid);
                      }}
                      onDoubleClick={() => startEdit(r.id)}
                      title={buildToneTooltip({ status: r.status })}
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
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
          unitLabel="مردود"
        />
      </div>

      <PurchasePrintModal
        open={!!printData}
        onClose={() => setPrintData(null)}
        data={printData}
      />
    </div>
  );
}
