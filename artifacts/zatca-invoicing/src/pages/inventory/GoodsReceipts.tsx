import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useCompanyTaxes } from "@/hooks/useCompanyTaxes";
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus, Trash2, PackagePlus, CheckCircle2, Printer, Pencil, FileText,
  ListOrdered, Copy, FileSpreadsheet, FileDown, X, Loader2, Undo2,
  ArrowRightCircle, ExternalLink, User,
} from "lucide-react";
import * as XLSX from "xlsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { DiscountRow } from "@/components/DiscountRow";
import { currencySymbol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { downloadCsv, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
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

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface ReceiptLine {
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
  batchNumber: string;
  expiryDate: string;
  notes: string;
}

function newLine(): ReceiptLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", unitPrice: "0", discount: "0", vatRate: "15", lineTotal: "0",
    batchNumber: "", expiryDate: "", notes: "",
  };
}

const EMPTY = {
  docNumber: "", supplierInvoiceNumber: "", receiptDate: today(),
  supplierId: "", branchId: "",
  currencyCode: "", exchangeRate: "1", notes: "",
  discountAmount: "0",
  priceIncludesVat: false,
};

export default function GoodsReceipts() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`purchasingPages.goodsReceipts.${k}`, opts) as string;
  const tg = (k: string, opts?: any): string => t(`goodsReceiptsPage.${k}`, opts) as string;
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const itemName = (i: any) => isRtl ? (i?.nameAr ?? i?.nameEn ?? "") : (i?.nameEn ?? i?.nameAr ?? "");
  const branchName = (b: any) => isRtl ? (b?.nameAr ?? b?.nameEn ?? `#${b?.id}`) : (b?.nameEn ?? b?.nameAr ?? `#${b?.id}`);
  const unitName = (u: any) => isRtl ? (u?.nameAr ?? u?.nameEn ?? "") : (u?.nameEn ?? u?.nameAr ?? "");
  const warehouseName = (w: any) => isRtl ? (w?.nameAr ?? w?.nameEn ?? "") : (w?.nameEn ?? w?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<any>({ ...EMPTY, priceIncludesVat: stickyPriceIncl.initial });
  const [lines, setLines] = useState<ReceiptLine[]>([newLine()]);

  const seqPeek = useNextSequenceNumber("goods_receipt", showForm && editingId == null, undefined, form.branchId);
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
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  const { containerRef: enterNavRef, onKeyDown: enterNavKey } = useEnterNavigation(
    () => handleSubmit({ preventDefault() {} } as any),
  );

  // ── Data queries ─────────────────────────────────────────
  const { data: receipts = [], isLoading } = useQuery<any[]>({
    queryKey: ["goods-receipts", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/goods-receipts?companyId=${cid}` : `${API}/api/goods-receipts`, { headers: authH });
      return r.json();
    },
    enabled: !!user,
  });

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

  // Convert dialog needs cash boxes / bank accounts only when opened — load
  // eagerly so the dialog renders instantly without an extra fetch round-trip.
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => { const r = await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: authH }); return r.json(); },
    enabled: !!user && !!cid,
  });

  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  useEffect(() => {
    if (!showForm || !defaultBranch || form.branchId) return;
    setForm((p: any) => ({ ...p, branchId: String(defaultBranch.id) }));
  }, [showForm, defaultBranch?.id]);

  const defaultWarehouse = (warehouses as any[]).find((w: any) => w.isDefault) ?? (warehouses as any[])[0];
  // Header-level warehouse picker — broadcast to every line on change.
  const [headerWarehouseId, setHeaderWarehouseId] = useState<string>("");
  const isNewGR = showForm && editingId == null;
  useEffect(() => {
    if (!isNewGR || !defaultWarehouse || headerWarehouseId) return;
    setHeaderWarehouseId(String(defaultWarehouse.id));
  }, [isNewGR, defaultWarehouse?.id]);
  useEffect(() => {
    if (isNewGR || headerWarehouseId) return;
    const firstWh = lines.find((l: any) => l.warehouseId)?.warehouseId;
    if (firstWh) setHeaderWarehouseId(String(firstWh));
  }, [isNewGR, lines, headerWarehouseId]);
  // Clear header picker when the form is closed so re-opening starts fresh.
  useEffect(() => {
    if (!showForm) { setHeaderWarehouseId(""); setHeaderTaxId(""); }
  }, [showForm]);
  const hasEmptyWarehouse = lines.some((l: any) => !l.warehouseId);
  useEffect(() => {
    if (!headerWarehouseId || !hasEmptyWarehouse) return;
    setLines(prev => prev.map((l: any) => l.warehouseId ? l : { ...l, warehouseId: headerWarehouseId }));
  }, [headerWarehouseId, hasEmptyWarehouse]);
  function applyHeaderWarehouse(v: string) {
    setHeaderWarehouseId(v);
    if (!v) return;
    setLines(prev => prev.map((l: any) => ({ ...l, warehouseId: v })));
  }

  // Header-level tax picker — dynamic tax catalog (الضرائب). Selecting a
  // percent tax broadcasts its rate to every line's editable vatRate; the
  // chosen taxId is persisted on the document header. ZATCA SAFETY: this only
  // pre-fills the editable rate before issue; it never touches the stored
  // vat_rate/vat_amount/tax_category that ZATCA XML/QR read at/after issue.
  const { taxes: taxCatalog, defaultPercentTax: defaultTax, comboItemsPercent: taxComboItems, percentRateOf } = useCompanyTaxes();
  const [headerTaxId, setHeaderTaxId] = useState<string>("");
  useEffect(() => {
    if (!isNewGR || !defaultTax || headerTaxId) return;
    applyHeaderTax(String(defaultTax.id));
  }, [isNewGR, defaultTax?.id]);
  function applyHeaderTax(v: string) {
    setHeaderTaxId(v);
    const rate = percentRateOf(v);
    if (rate === null) return; // fixed/none → leave line rates untouched
    setLines(prev => prev.map(l => {
      const u = { ...l, vatRate: String(rate) };
      return { ...u, lineTotal: calcLineTotal(u, !!form.priceIncludesVat).toFixed(2) };
    }));
  }

  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!currencies.length) return "1";
    const selected = currencies.find((c: any) => c.code === selectedCode);
    const base = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id),
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["goods-receipts"] });

  // ── Mutations ────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const isEdit = !!editingId;
      const url = isEdit
        ? `${API}/api/goods-receipts/${editingId}`
        : `${API}/api/goods-receipts`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST", headers, body: JSON.stringify({ ...data, companyId: cid }),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      // Auto-post on create — keeps the GRN useful (stock updated) without a
      // separate click. Edits stay as-is so users can tweak drafts freely.
      if (!isEdit && j?.id && (j.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/goods-receipts/${j.id}/post`, { method: "PATCH", headers });
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
      const res = await fetch(`${API}/api/goods-receipts/${id}/post`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/goods-receipts/${id}/unpost`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.unposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/goods-receipts/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Convert dialog state — opens with the GRN id; user picks paymentType +
  // supplier (credit) or cashBox/bank (cash/bank); on submit we POST to the
  // convert endpoint and navigate to the new invoice's edit page.
  const [convertGrnId, setConvertGrnId] = useState<number | null>(null);
  const [convertForm, setConvertForm] = useState<{ paymentType: string; supplierId: string; cashBoxId: string; bankAccountId: string; }>({
    paymentType: "credit", supplierId: "", cashBoxId: "", bankAccountId: "",
  });

  function openConvertDialog(grn: any) {
    setConvertGrnId(Number(grn.id));
    setConvertForm({
      paymentType: "credit",
      supplierId: grn.supplierId ? String(grn.supplierId) : "",
      cashBoxId: "", bankAccountId: "",
    });
  }

  const convertMut = useMutation({
    mutationFn: async (payload: { id: number; body: any }) => {
      const res = await fetch(`${API}/api/goods-receipts/${payload.id}/convert-to-invoice`, {
        method: "POST", headers, body: JSON.stringify(payload.body),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (inv: any) => {
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: tr("toasts.converted") });
      setConvertGrnId(null);
      if (inv?.id) navigate(`/purchasing/invoices/${inv.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  async function startEdit(grnId: number) {
    try {
      const res = await fetch(`${API}/api/goods-receipts/${grnId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(grnId);
      setForm({
        docNumber:    full.docNumber ?? "",
        supplierInvoiceNumber: full.supplierInvoiceNumber ?? "",
        receiptDate:  full.receiptDate ?? today(),
        supplierId:   full.supplierId ? String(full.supplierId) : "",
        branchId:     full.branchId   ? String(full.branchId)   : "",
        currencyCode: full.currencyCode ?? "",
        exchangeRate: full.exchangeRate ? String(full.exchangeRate) : "1",
        notes:        full.notes ?? "",
        discountAmount: String(full.discountAmount ?? "0"),
        priceIncludesVat: !!full.priceIncludesVat,
      });
      setHeaderTaxId((full as any).taxId != null ? String((full as any).taxId) : "");
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
        vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
        lineTotal:   String(l.lineTotal ?? "0"),
        batchNumber: l.batchNumber ?? "",
        expiryDate:  l.expiryDate  ?? "",
        notes:       l.notes ?? "",
      })) : [newLine()]);
      setShowForm(true);
    } catch (e: any) {
      toast({ title: e.message || tr("toasts.loadError"), variant: "destructive" });
    }
  }

  async function duplicateReceipt(grnId: number) {
    try {
      const res = await fetch(`${API}/api/goods-receipts/${grnId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(null);
      setForm({
        docNumber:    "",
        supplierInvoiceNumber: full.supplierInvoiceNumber ?? "",
        receiptDate:  today(),
        supplierId:   full.supplierId ? String(full.supplierId) : "",
        branchId:     full.branchId   ? String(full.branchId)   : "",
        currencyCode: full.currencyCode ?? "",
        exchangeRate: full.exchangeRate ? String(full.exchangeRate) : "1",
        notes:        full.notes ?? "",
        discountAmount: String(full.discountAmount ?? "0"),
        priceIncludesVat: !!full.priceIncludesVat,
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
        vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
        lineTotal:   String(l.lineTotal ?? "0"),
        batchNumber: l.batchNumber ?? "",
        expiryDate:  l.expiryDate  ?? "",
        notes:       l.notes ?? "",
      })) : [newLine()]);
      setShowForm(true);
      toast({ title: tr("toasts.duplicated") });
    } catch (e: any) {
      toast({ title: e.message || tr("toasts.loadError"), variant: "destructive" });
    }
  }

  function reset() {
    setForm({ ...EMPTY, priceIncludesVat: stickyPriceIncl.read() });
    setLines([newLine()]);
    setHeaderTaxId("");
    setEditingId(null);
    setShowForm(false);
  }

  function calcLineTotal(l: ReceiptLine, priceIncludesVat = false) {
    const qty   = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const disc  = Number(l.discount) || 0;
    const rate  = (Number(l.vatRate) || 0) / 100;
    const gross = qty * price * (1 - disc / 100);
    if (priceIncludesVat) return gross;
    return gross * (1 + rate);
  }
  function calcLineParts(l: ReceiptLine, priceIncludesVat = false) {
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

  function updateLine(id: string, field: keyof ReceiptLine, value: string) {
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
      const updated: ReceiptLine = {
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
      const updated: ReceiptLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemName(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitName(base?.unit) || unitName(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: String(base?.costPrice ?? item.costPrice ?? "0"),
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
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
  const subtotalNet    = totalAmount - vatAmount;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({
      ...form,
      supplierId: form.supplierId || null,
      branchId:   form.branchId   || null,
      discountAmount: docDiscountAmt.toFixed(2),
      subtotal:    subtotalNet.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      vatAmount:   vatAmount.toFixed(2),
      taxId: headerTaxId ? Number(headerTaxId) : null,
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
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
    tr("lineCols.itemCode"), tr("lineCols.item"), tr("lineCols.warehouse"),
    tr("lineCols.unit"), tr("lineCols.qty"), tr("lineCols.price"),
    tr("lineCols.discount"), tr("lineCols.vat"), tr("lineCols.total"),
    tg("batchNumber"), tg("expiryDate"),
    tr("lineCols.notes"), "",
  ];

  // ── Audit grid ───────────────────────────────────────────
  const searchString = useSearch();
  const initialParams = useMemo(() => new URLSearchParams(searchString || ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tableSearch, setTableSearch] = useState(initialParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "invoiced">(
    (initialParams.get("status") as any) || "all"
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPrintBusy, setBulkPrintBusy] = useState(false);

  // Mirror filter state into the URL so navigating to a JE and pressing
  // browser-back returns here with the same search/status filters.
  // `replace: true` keeps history clean — only the JE click pushes.
  useEffect(() => {
    const next = new URLSearchParams();
    if (tableSearch) next.set("q", tableSearch);
    if (statusFilter !== "all") next.set("status", statusFilter);
    const nextStr = next.toString();
    const currentStr = new URLSearchParams(searchString || "").toString();
    if (nextStr !== currentStr) {
      navigate(`/inventory/goods-receipts${nextStr ? "?" + nextStr : ""}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableSearch, statusFilter]);

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : s === "posted" ? tr("postedM") : s === "invoiced" ? tr("invoicedM") : tr("draft");

  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                     type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                    type: "none", valueOf: () => "" },
    { key: "doc",      label: tr("listCols.number"),  type: "text", valueOf: (r) => r.docNumber ?? `GRN-${r.id}` },
    { key: "date",     label: tr("listCols.date"),    type: "text", valueOf: (r) => r.receiptDate ?? "" },
    { key: "supplier", label: tr("listCols.supplier"),type: "text", valueOf: (r) => supMap[r.supplierId] ?? "" },
    { key: "currency", label: tr("listCols.currency"),type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: tr("listCols.subtotal"),type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0) },
    { key: "vat",      label: tr("listCols.vat"),     type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: tr("listCols.total"),   type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "journal",  label: tr("listCols.journal"), type: "text", valueOf: (r) => r.journalEntryId ? `JE-${r.journalEntryId}` : "" },
    { key: "linkedInvoice", label: tr("listCols.linkedInvoice"), type: "text", valueOf: (r) => r.linkedInvoiceId ? `PI-${r.linkedInvoiceId}` : "" },
    { key: "status",   label: tr("listCols.status"),  type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "createdBy", label: tg("listColsCreatedBy"), type: "text", valueOf: (r) => r.createdByName ?? "" },
    { key: "postedBy",  label: tg("listColsPostedBy"),  type: "text", valueOf: (r) => r.postedByName ?? "" },
    { key: "_act",     label: tr("listCols.actions"), type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "goodsReceiptsAuditGrid",
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
  const filteredReceipts = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (receipts as any[]).filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [
          r.docNumber, `GRN-${r.id}`, r.receiptDate, supMap[r.supplierId],
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
  }, [receipts, tableSearch, statusFilter, colAdv, supMap]);

  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredReceipts.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedReceipts = useMemo(
    () => pageSize === 0 ? filteredReceipts : filteredReceipts.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredReceipts, pageSize, safePage],
  );
  const pageStart = filteredReceipts.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredReceipts.length : Math.min(safePage * pageSize, filteredReceipts.length);

  const totals = useMemo(() => filteredReceipts.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredReceipts]);

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

  // ── Print / export helpers ───────────────────────────────
  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const safeLogo = safeLogoSrc((user?.company as any)?.logo) ?? "";
  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      toast({ title: tg("popupBlockedTitle"), description: tg("popupBlockedDesc"), variant: "destructive" });
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  };

  const buildListHtml = (source: any[] = filteredReceipts) => {
    const reportDate = new Date().toLocaleDateString(isRtl ? "ar-SA" : "en-US");
    const sumSub = source.reduce((a, r: any) => a + (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)), 0);
    const sumVat = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTot = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = pickName(user?.company?.nameAr, user?.company?.nameEn)
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(pickName(user.company.nameAr, user.company.nameEn))}</div>` : "";
    return `<!DOCTYPE html><html dir="${isRtl ? "rtl" : "ltr"}" lang="${isRtl ? "ar" : "en"}"><head><meta charset="utf-8"><title>${escapeHtml(tr("title"))}</title>
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
<button class="print-btn" onclick="window.print()">${tg("printBtn")}</button>
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(tr("title"))}</h1>
<div class="meta">${tg("reportDateLabel")}: ${reportDate} — ${tg("receiptsCountLabel")}: ${source.length}</div></div>
<div class="totals">
  <span>${tg("totalSumLabel")}: <b>${sumSub.toFixed(2)}</b></span>
  <span>${tg("totalVatLabel")}: <b>${sumVat.toFixed(2)}</b></span>
  <span>${tg("grandTotalShort")}: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>${tg("printColNumber")}</th><th>${tg("printColDate")}</th><th>${tg("printColSupplier")}</th><th>${tg("printColCurrency")}</th>
  <th>${tg("printColSubtotal")}</th><th>${tg("printColVat")}</th><th>${tg("printColTotal")}</th><th>${tg("printColJournal")}</th><th>${tg("printColInvoice")}</th><th>${tg("printColStatus")}</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `GRN-${r.id}`)}</td>
  <td>${escapeHtml(r.receiptDate ?? "")}</td>
  <td>${escapeHtml(supMap[r.supplierId] ?? "")}</td>
  <td>${escapeHtml(r.currencyCode ?? "")}</td>
  <td class="num">${(Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2)}</td>
  <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
  <td>${r.journalEntryId ? `JE-${escapeHtml(r.journalEntryId)}` : ""}</td>
  <td>${r.linkedInvoiceId ? `PI-${escapeHtml(r.linkedInvoiceId)}` : ""}</td>
  <td>${escapeHtml(statusLabel(r.status))}</td>
</tr>`).join("")}
</tbody><tfoot><tr>
  <td colspan="5">${tg("grandTotalLabel")}</td>
  <td class="num">${sumSub.toFixed(2)}</td>
  <td class="num">${sumVat.toFixed(2)}</td>
  <td class="num">${sumTot.toFixed(2)}</td>
  <td colspan="3"></td>
</tr></tfoot></table>
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  const buildBulkHtml = (docs: any[]) => {
    const reportDate = new Date().toLocaleDateString(isRtl ? "ar-SA" : "en-US");
    const grandSub = docs.reduce((a, d: any) => a + (Number(d.totalAmount ?? 0) - Number(d.vatAmount ?? 0)), 0);
    const grandVat = docs.reduce((a, d: any) => a + Number(d.vatAmount ?? 0), 0);
    const grandTot = docs.reduce((a, d: any) => a + Number(d.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = pickName(user?.company?.nameAr, user?.company?.nameEn)
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;text-align:center;">${escapeHtml(pickName(user.company.nameAr, user.company.nameEn))}</div>` : "";
    const sections = docs.map((d: any) => {
      const lns: any[] = Array.isArray(d.lines) ? d.lines : [];
      const docNo  = d.docNumber ?? `GRN-${d.id}`;
      const linesHtml = lns.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">${tg("noLinesForReceipt")}</td></tr>`
        : lns.map((l: any, i: number) => {
            const itemLabel = l.itemName ?? `#${l.itemId ?? ""}`;
            const qty = Number(l.qty ?? 0);
            const up  = Number(l.unitPrice ?? 0);
            const vat = Number(l.vatRate ?? 0);
            const ttl = Number(l.lineTotal ?? 0);
            return `<tr>
              <td style="text-align:center;">${i + 1}</td>
              <td>${escapeHtml(itemLabel)}</td>
              <td class="num">${qty.toFixed(2)}</td>
              <td class="num">${up.toFixed(2)}</td>
              <td class="num">${vat.toFixed(2)}%</td>
              <td class="num">${ttl.toFixed(2)}</td>
            </tr>`;
          }).join("");
      return `<section class="doc">
        <div class="doc-head">
          <span class="badge b-doc">${tg("printColNumber")}: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">${tg("printColDate")}: ${escapeHtml(d.receiptDate ?? "")}</span>
          <span class="badge b-cust">${tg("printColSupplier")}: ${escapeHtml(supMap[d.supplierId] ?? "—")}</span>
          <span class="badge b-status s-${escapeHtml(d.status)}">${escapeHtml(statusLabel(d.status))}</span>
        </div>
        ${d.notes ? `<div class="desc">${escapeHtml(d.notes)}</div>` : ""}
        <table>
          <thead><tr>
            <th style="width:30px;">#</th><th>${tg("printItemCol")}</th>
            <th style="width:70px;">${tg("printQtyCol")}</th><th style="width:80px;">${tg("printPriceCol")}</th>
            <th style="width:60px;">${tg("printColVat")}</th><th style="width:90px;">${tg("printColTotal")}</th>
          </tr></thead>
          <tbody>${linesHtml}</tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:left;">${tg("printSubtotal")}</td>
            <td class="num">${Number(d.vatAmount ?? 0).toFixed(2)}</td>
            <td class="num">${Number(d.totalAmount ?? 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
      </section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="${isRtl ? "rtl" : "ltr"}" lang="${isRtl ? "ar" : "en"}"><head><meta charset="utf-8"><title>${tg("bulkPrintTitle")}</title>
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
.b-status.s-invoiced{background:#dbeafe;border-color:#60a5fa;color:#1e40af;}
.desc { font-size:11px; color:#475569; padding:4px 6px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:4px; margin-bottom:6px; }
table { width:100%; border-collapse:collapse; font-size:10.5px; }
thead th { background:#1e3a8a; color:#fff; padding:5px 6px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:4px 6px; border:1px solid #d1d5db; text-align:right; }
tfoot td { padding:5px 6px; border:1px solid #1e3a8a; background:#eef2ff; font-weight:700; }
.num { font-family:"Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">${tg("printBtn")}</button>
<div class="h">${logoHtml}${companyHtml}<h1>${tg("bulkPrintHeading")}</h1>
<div class="meta">${tg("reportDateLabel")}: ${reportDate} — ${tg("receiptsCountLabel")}: ${docs.length}</div></div>
<div class="grand">
  <span>${tg("totalSumLabel")}: <b>${grandSub.toFixed(2)}</b></span>
  <span>${tg("totalVatLabel")}: <b>${grandVat.toFixed(2)}</b></span>
  <span>${tg("grandTotalLabel")}: <b>${grandTot.toFixed(2)}</b></span>
</div>
${sections}
<script>setTimeout(()=>window.print(),350);</script></body></html>`;
  };

  const handleExportPDF = () => openPrintWindow(buildListHtml());
  const handlePrint    = () => openPrintWindow(buildListHtml());
  const handleExportExcel = () => {
    if (filteredReceipts.length === 0) { toast({ title: tg("noDataToExport"), variant: "destructive" }); return; }
    const rows = filteredReceipts.map((r: any) => ({
      [tg("printColNumber")]: r.docNumber ?? `GRN-${r.id}`,
      [tg("printColDate")]: r.receiptDate ?? "",
      [tg("printColSupplier")]: supMap[r.supplierId] ?? "",
      [tg("printColCurrency")]: r.currencyCode ?? "",
      [tg("printColSubtotal")]: (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2),
      [tg("printColVat")]: Number(r.vatAmount ?? 0).toFixed(2),
      [tg("printColTotal")]: Number(r.totalAmount ?? 0).toFixed(2),
      [tg("printColJournal")]: r.journalEntryId ? `JE-${r.journalEntryId}` : "",
      [tg("printColInvoice")]: r.linkedInvoiceId ? `PI-${r.linkedInvoiceId}` : "",
      [tg("printColStatus")]: statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tg("excelSheetName"));
    XLSX.writeFile(wb, `goods-receipts-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  async function bulkRun(
    ids: number[],
    perId: (id: number) => Promise<void>,
  ): Promise<{ ok: number; failed: Array<{ id: number; error: string }> }> {
    let ok = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      try { await perId(id); ok++; }
      catch (e: any) { failed.push({ id, error: e?.message ?? tg("errorFallback") }); }
    }
    return { ok, failed };
  }

  async function handleBulkPrint() {
    const ids = Array.from(layout.selected);
    if (ids.length === 0) return;
    setBulkPrintBusy(true);
    try {
      const idSet = new Set(ids.map(Number));
      const ordered = (filteredReceipts as any[]).filter((r) => idSet.has(Number(r.id)));
      let failed = 0;
      const docs = await Promise.all(
        ordered.map(async (row: any) => {
          try {
            const res = await fetch(`${API}/api/goods-receipts/${row.id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
          } catch { failed += 1; return { ...row, lines: [] }; }
        }),
      );
      openPrintWindow(buildBulkHtml(docs));
      if (failed > 0) {
        toast({ title: tg("bulkPrintPartialTitle"), description: tg("bulkPrintPartialDesc", { printed: docs.length, failed }), variant: "destructive" });
      }
    } finally { setBulkPrintBusy(false); }
  }

  function exportCsv() {
    if (filteredReceipts.length === 0) { toast({ title: tg("noDataToExport"), variant: "destructive" }); return; }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredReceipts.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`goods-receipts-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: tg("csvExportSuccess") });
  }

  const allFilteredIds: number[] = useMemo(
    () => filteredReceipts.map((r: any) => Number(r.id)),
    [filteredReceipts],
  );
  const selectedRows = useMemo(
    () => (receipts as any[]).filter((r) => isSelected(Number(r.id))),
    [receipts, isSelected],
  );
  // Bulk actions: posted-only-not-invoiced rows can be unposted. Drafts can
  // be posted or deleted. Invoiced rows are read-only at GRN level — must
  // delete/unpost the linked invoice first to free them.
  const selectedPostable    = selectedRows.filter((r) => r.status === "draft");
  const selectedUnpostable  = selectedRows.filter((r) => r.status === "posted");
  const selectedDeletable   = selectedRows.filter((r) => r.status === "draft");

  async function bulkPost() {
    const ids = selectedPostable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: tg("noDraftsSelected"), variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/goods-receipts/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      if (failed.length === 0) toast({ title: tg("postedCount", { count: ok }) });
      else toast({ title: tg("postResult", { ok, failed: failed.length }), description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnpost() {
    const ids = selectedUnpostable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: tg("noPostedSelected"), variant: "destructive" }); return; }
    if (!window.confirm(tg("confirmBulkUnpost", { count: ids.length }))) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/goods-receipts/${id}/unpost`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      if (failed.length === 0) toast({ title: tg("unpostedCount", { count: ok }) });
      else toast({ title: tg("unpostResult", { ok, failed: failed.length }), description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: tg("cannotDeletePosted"), variant: "destructive" }); return; }
    if (!window.confirm(tg("confirmBulkDelete", { count: ids.length }))) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/goods-receipts/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      if (failed.length === 0) toast({ title: tg("deletedCount", { count: ok }) });
      else toast({ title: tg("deleteResult", { ok, failed: failed.length }), description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PackagePlus className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => { reset(); setShowForm(true); }}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
            data-testid="new-grn-btn"
          >
            <Plus className="h-4 w-4" />
            {tr("newReceipt")}
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
              <Printer className="h-4 w-4" /> {tg("printBtn")}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Form ────────────────────────────────────────── */}
      {showForm && (() => {
        const currentGrn = editingId
          ? (receipts as any[]).find((r: any) => Number(r.id) === Number(editingId))
          : null;
        const supplierNameById = (id: any) => {
          const s = (suppliers as any[]).find((s: any) => Number(s.id) === Number(id));
          return s ? (pickName(s.nameAr, s.nameEn) || `#${s.id}`) : "—";
        };
        return (
        <>
          {editingId && (receipts as any[]).length > 0 && (
            <div className="flex justify-end">
              <DocNavigator
                items={(receipts as any[]).map((d: any) => ({
                  id: d.id,
                  docNumber: d.docNumber,
                  partyName: supplierNameById(d.supplierId),
                  date: d.receiptDate ?? "",
                  total: d.totalAmount ?? 0,
                  currencyCode: d.currencyCode ?? "",
                }))}
                currentId={editingId}
                onSelect={(id) => startEdit(Number(id))}
                fallbackPrefix="GRN-"
              />
            </div>
          )}
          <FormPanel
            icon={PackagePlus}
            title={
              <span className="inline-flex items-center gap-2 flex-wrap">
                {editingId ? tr("editTitle") : tr("newTitle")}
                {currentGrn && <DocStatusBadge status={currentGrn.status} />}
              </span>
            }
            width="6xl"
            onClose={reset}
            onSave={() => handleSubmit({ preventDefault() {} } as any)}
            saveLabel={tr("saveLabel")}
            saving={saveMut.isPending}
            saveDisabled={lines.filter(l => l.itemName).length === 0}
          >
            <Tabs defaultValue="header" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="header">{tr("headerData")}</TabsTrigger>
              </TabsList>

              <TabsContent value="header" className="mt-0 space-y-5">
                <FormGrid>
                  <Field label={tr("receiptNumber")}>
                    <Input
                      value={form.docNumber}
                      onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))}
                      placeholder={seqPeek.hasSequence ? (seqPeek.number ?? tr("receiptNumberPh")) : tr("receiptNumberPh")}
                      readOnly={!editingId && seqPeek.hasSequence}
                    />
                  </Field>
                  <Field label={tr("receiptDate")} required>
                    <Input type="date" value={form.receiptDate}
                      onChange={e => setForm((p: any) => ({ ...p, receiptDate: e.target.value }))} />
                  </Field>
                  <Field label={tr("supplier")}>
                    <SearchCombobox items={supplierItems} value={form.supplierId}
                      onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))}
                      placeholder={tr("supplierPh")} />
                  </Field>
                  <Field label={tr("supplierInvoiceNumber")}>
                    <Input value={form.supplierInvoiceNumber}
                      onChange={e => setForm((p: any) => ({ ...p, supplierInvoiceNumber: e.target.value }))}
                      placeholder={tr("supplierInvoiceNumberPh")} />
                  </Field>
                  <Field label={tr("branch")}>
                    <Select value={form.branchId || undefined}
                      onValueChange={v => setForm((p: any) => ({ ...p, branchId: v }))}>
                      <SelectTrigger><SelectValue placeholder={tr("branch")} /></SelectTrigger>
                      <SelectContent>
                        {branches.map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {branchName(b)}{b.isMain ? tr("mainBranch") : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={tg("warehouse")}>
                    <SearchCombobox
                      items={(warehouses as any[]).map((w: any) => ({
                        value: String(w.id),
                        label: warehouseName(w) || `#${w.id}`,
                      }))}
                      value={headerWarehouseId}
                      onValueChange={applyHeaderWarehouse}
                      placeholder={tg("warehousePh")}
                    />
                  </Field>
                  {taxCatalog.length > 0 && (
                    <Field label={tg("tax")}>
                      <SearchCombobox
                        items={taxComboItems}
                        value={headerTaxId}
                        onValueChange={applyHeaderTax}
                        placeholder={tg("taxPh")}
                      />
                      <p className="text-[10px] text-muted-foreground">{tg("taxHint")}</p>
                    </Field>
                  )}
                  <Field label={tr("currency")}>
                    <SearchCombobox
                      items={currencies.map((c: any) => ({ value: c.code, label: `${c.code} — ${pickName(c.nameAr, c.nameEn)}` }))}
                      value={form.currencyCode} onValueChange={handleCurrencyChange} placeholder={tr("currencyPh")} />
                  </Field>
                  {form.currencyCode && form.currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                    <Field label={tr("exchangeRate")}>
                      <Input type="text" inputMode="decimal" value={form.exchangeRate}
                        onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
                    </Field>
                  )}
                </FormGrid>

                <Field label={tr("notes")}>
                  <Textarea rows={2} value={form.notes}
                    onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))}
                    placeholder={tr("notesPh")} />
                </Field>

                {/* Lines */}
                <div data-enter-nav-container="lines" className="space-y-1.5">
                  <div className="border-t pt-4 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                    <ListOrdered className="h-4 w-4" />
                    <span>{tr("linesTitle")} ({lines.filter(l => l.itemId || l.itemName).length})</span>
                  </div>
                  {(() => {
                    const GRID_COLS_GR = "110px minmax(260px,1.4fr) 160px 120px 90px 110px 80px 80px 130px 120px 130px 180px 40px";
                    return (
                  <div className="rounded-xl border bg-card overflow-x-auto" dir={isRtl ? "rtl" : "ltr"}>
                    <div className="min-w-max">
                  <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: GRID_COLS_GR }}>
                    {lineColHeaders.map((h, i) => (
                      <p key={i} className={cn("text-[11px] font-medium truncate", h === tr("lineCols.total") ? "font-semibold text-primary" : "text-muted-foreground")} title={h}>{h}</p>
                    ))}
                  </div>
                  <div className="divide-y">
                  {lines.map(l => (
                    <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                      <div className="grid gap-2 items-center" style={{ gridTemplateColumns: GRID_COLS_GR }}>
                        <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
                          onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                        {inventoryItems.length > 0 ? (
                          <SearchCombobox items={itemComboItems} value={l.itemId}
                            onValueChange={v => selectItem(l._id, v)}
                            placeholder={tr("selectItemCombo")}
                            searchPlaceholder={tg("itemSearchPh")} />
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
                        <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice}
                          onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                        <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.discount}
                          onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                        <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate}
                          onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                        <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.lineTotal)} />
                        <Input className="h-8 text-xs" placeholder={tg("batchNumber")} value={l.batchNumber}
                          onChange={e => updateLine(l._id, "batchNumber", e.target.value)} />
                        <Input className="h-8 text-xs" type="date" value={l.expiryDate}
                          onChange={e => updateLine(l._id, "expiryDate", e.target.value)} />
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
                </div>

                {/* Totals */}
                <div className="mt-5 flex flex-wrap justify-between gap-4">
                  <label
                    data-testid="price-includes-vat-toggle"
                    className={cn(
                      "flex items-start gap-2.5 rounded-xl border-2 p-3 cursor-pointer select-none transition-colors max-w-sm",
                      priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
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
                      <div className="flex justify-between text-rose-700">
                        <span className="text-muted-foreground">{tr("itemDiscount")}</span>
                        <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                      </div>
                    )}
                    <DiscountRow gross={grossTotal} value={form.discountAmount ?? "0"} onChange={v => setForm((p: any) => ({ ...p, discountAmount: v }))} currencySymbol={currencySymbol(form.currencyCode, currencies)} />
                    <div className="flex justify-between font-bold border-t pt-2 text-base">
                      <span>{tr("totalLabel")}</span>
                      <span className="font-mono text-primary" data-testid="grn-total">{fmt(totalAmount)}</span>
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
            <PackagePlus className="h-4 w-4 opacity-90" />
            {tg("gridTitle")}
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button type="button" size="sm" variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)} onClick={exportCsv}>
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {tg("exportCsvBtn")}
            </Button>
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir={isRtl ? "rtl" : "ltr"}>
          <Input
            placeholder={tg("tableSearchPh")}
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "posted", "invoiced"] as const).map((s) => (
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
              onClick={clearAllColFilters} title={tg("clearColFilters")}>
              <X className="h-3.5 w-3.5 me-1" />
              {tg("clearColFilters")}
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filteredReceipts.length} {tg("receiptUnit")}
            {filteredReceipts.length !== receipts.length && <span className="text-slate-400"> / {receipts.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection} busy={bulkBusy}>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-blue-700 hover:bg-blue-600 text-white"
            onClick={handleBulkPrint}
            disabled={layout.selected.size === 0 || bulkPrintBusy}
            title={`${tg("printBtn")} (${layout.selected.size})`}>
            {bulkPrintBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
            {tg("printBtn")} ({layout.selected.size})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkPost}
            disabled={bulkBusy || selectedPostable.length === 0}
            title={selectedPostable.length === 0 ? tg("noDraftsSelected") : tg("postTooltip", { count: selectedPostable.length })}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {tg("bulkPostLabel")} ({selectedPostable.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: tg("selectOneToEdit"), variant: "destructive" }); return; }
              startEdit(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? tg("openSelectedTip") : tg("selectOneOnly")}>
            <Pencil className="h-3.5 w-3.5" />
            {t("common.edit")}
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: tg("selectOneToDuplicate"), variant: "destructive" }); return; }
              duplicateReceipt(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? tg("duplicateSelectedTip") : tg("selectOneOnly")}>
            <Copy className="h-3.5 w-3.5" />
            {t("common.duplicate")}
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkUnpost}
            disabled={bulkBusy || selectedUnpostable.length === 0}
            title={selectedUnpostable.length === 0 ? tg("noPostedInSelection") : tg("unpostTooltip", { count: selectedUnpostable.length })}>
            <Undo2 className="h-3.5 w-3.5" />
            {tg("bulkUnpostLabel")} ({selectedUnpostable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? tg("cannotDeletePosted")
              : tg("deleteTooltip", { count: selectedDeletable.length })}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.delete")} ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── List ─────────────────────────────────────────── */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filteredReceipts.filter((r: any) => r.status === "draft").length },
          { kind: "posted",    count: filteredReceipts.filter((r: any) => r.status === "posted").length },
          { kind: "cancelled", count: filteredReceipts.filter((r: any) => r.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
          ) : filteredReceipts.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {receipts.length === 0 ? tr("noReceipts") : tg("noReceiptsInFilter")}
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
                {pagedReceipts.map((r: any, idx: number) => {
                  const sel = isSelected(Number(r.id));
                  const editable = r.status === "draft";
                  return (
                    <tr key={r.id}
                      data-status={r.status}
                      className={cn(
                        "border-b border-slate-200 transition-colors",
                        sel ? SEL_TONE : rowToneFor({ status: r.status }),
                      )}
                      onDoubleClick={() => editable ? startEdit(r.id) : null}
                      title={buildToneTooltip({ status: r.status })}
                      data-testid={`grn-row-${r.id}`}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(Number(r.id))}
                                ariaLabel={tg("selectReceiptAria", { doc: r.docNumber ?? `GRN-${r.id}` })}
                              />
                            </td>
                          );
                        }
                        if (col.key === "_idx") {
                          return <td key={col.key} className="px-1 py-1 border border-slate-200 text-center text-slate-500">{pageStart + idx}</td>;
                        }
                        if (col.key === "status") {
                          return (
                            <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                              <DocStatusBadge status={r.status} />
                            </td>
                          );
                        }
                        if (col.key === "createdBy") {
                          return (
                            <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                              {r.createdByName ? (
                                <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                                  <User className="h-2.5 w-2.5" />{r.createdByName}
                                </span>
                              ) : <span className="text-slate-400 text-xs">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "postedBy") {
                          return (
                            <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                              {r.postedByName ? (
                                <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200">
                                  <User className="h-2.5 w-2.5" />{r.postedByName}
                                </span>
                              ) : <span className="text-slate-400 text-xs">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "_act") {
                          return (
                            <td key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                              <div className="flex items-center justify-center gap-0.5">
                                {r.status === "draft" && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-emerald-700 hover:bg-emerald-50"
                                    onClick={() => postMut.mutate(Number(r.id))} title={tr("postShort")}>
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.status === "posted" && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-amber-700 hover:bg-amber-50"
                                    onClick={() => { if (window.confirm(tr("confirmUnpost"))) unpostMut.mutate(Number(r.id)); }}
                                    title={tr("unpostShort")}>
                                    <Undo2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.status === "posted" && !r.linkedInvoiceId && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-blue-700 hover:bg-blue-50"
                                    onClick={() => openConvertDialog(r)} title={tr("convertTip")}
                                    data-testid={`convert-grn-${r.id}`}>
                                    <ArrowRightCircle className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.linkedInvoiceId && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-indigo-700 hover:bg-indigo-50"
                                    onClick={() => navigate(`/purchasing/invoices/${r.linkedInvoiceId}`)}
                                    title={tr("openInvoiceTip")}>
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {editable && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-slate-700 hover:bg-slate-100"
                                    onClick={() => startEdit(r.id)} title={tr("editTip")}>
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-slate-600 hover:bg-slate-100"
                                  onClick={() => duplicateReceipt(r.id)} title={tr("duplicateTip")}>
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                                {editable && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-rose-700 hover:bg-rose-50"
                                    onClick={() => { if (window.confirm(tr("confirmDelete"))) deleteMut.mutate(Number(r.id)); }}
                                    title={t("common.delete")}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.journalEntryId && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-slate-600 hover:bg-slate-100"
                                    onClick={() => navigate(`/accounting/journals/${r.journalEntryId}`)}
                                    title={tr("viewJournalTip")}>
                                    <FileText className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            </td>
                          );
                        }
                        const v = col.valueOf(r);
                        const cls = col.type === "num" ? "px-2 py-1 border border-slate-200 text-end font-mono" : "px-2 py-1 border border-slate-200 text-start";
                        return <td key={col.key} className={cls}>{col.type === "num" ? fmt(v) : String(v ?? "")}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className={cn("sticky bottom-0", footerTheme.bg, footerTheme.text)}>
                <tr className="font-bold">
                  {visibleColumns.map((col) => {
                    if (col.key === "_sel" || col.key === "_idx" || col.key === "_act") {
                      return <td key={col.key} className="px-2 py-1.5 border border-slate-300" />;
                    }
                    if (col.key === "subtotal") return <td key={col.key} className="px-2 py-1.5 border border-slate-300 text-end font-mono">{fmt(totals.subtotal)}</td>;
                    if (col.key === "vat")      return <td key={col.key} className="px-2 py-1.5 border border-slate-300 text-end font-mono">{fmt(totals.vat)}</td>;
                    if (col.key === "total")    return <td key={col.key} className="px-2 py-1.5 border border-slate-300 text-end font-mono">{fmt(totals.total)}</td>;
                    if (col.key === "doc")      return <td key={col.key} className="px-2 py-1.5 border border-slate-300 text-start">{t("common.total")}</td>;
                    return <td key={col.key} className="px-2 py-1.5 border border-slate-300" />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        <AuditGridPagination
          layout={layout}
          totalRows={filteredReceipts.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel={tg("receiptUnit")}
        />
      </div>

      {/* ── Convert-to-invoice dialog ──────────────────────── */}
      <Dialog open={convertGrnId !== null} onOpenChange={(o) => !o && setConvertGrnId(null)}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightCircle className="h-5 w-5 text-blue-700" />
              {tr("convertDialog.title")}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {tr("convertDialog.subtitle")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Field label={tr("convertDialog.paymentType")} required>
              <Select value={convertForm.paymentType}
                onValueChange={(v) => setConvertForm(p => {
                  const next = { ...p, paymentType: v };
                  if (v === "cash") {
                    next.bankAccountId = "";
                    if (!p.cashBoxId) {
                      const first = [...(cashBoxes as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                      if (first) next.cashBoxId = String(first.id);
                    }
                  } else if (v === "bank") {
                    next.cashBoxId = "";
                    if (!p.bankAccountId) {
                      const first = [...(bankAccounts as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                      if (first) next.bankAccountId = String(first.id);
                    }
                  } else {
                    next.cashBoxId = "";
                    next.bankAccountId = "";
                  }
                  return next;
                })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">{tr("convertDialog.paymentCredit")}</SelectItem>
                  <SelectItem value="cash">{tr("convertDialog.paymentCash")}</SelectItem>
                  <SelectItem value="bank">{tr("convertDialog.paymentBank")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {convertForm.paymentType === "credit" && (
              <Field label={tr("convertDialog.supplier")} required>
                <SearchCombobox
                  items={[
                    { value: "", label: tr("convertDialog.supplierPh") },
                    ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) })),
                  ]}
                  value={convertForm.supplierId}
                  onValueChange={(v) => setConvertForm(p => ({ ...p, supplierId: v }))}
                  placeholder={tr("convertDialog.supplierPh")} />
              </Field>
            )}

            {convertForm.paymentType === "cash" && (
              <Field label={tr("convertDialog.cashBox")} required>
                <Select value={convertForm.cashBoxId || undefined}
                  onValueChange={(v) => setConvertForm(p => ({ ...p, cashBoxId: v }))}>
                  <SelectTrigger><SelectValue placeholder={tr("convertDialog.cashBoxPh")} /></SelectTrigger>
                  <SelectContent>
                    {(cashBoxes as any[]).filter((b: any) => b.isActive).map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{branchName(b)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {convertForm.paymentType === "bank" && (
              <Field label={tr("convertDialog.bankAccount")} required>
                <Select value={convertForm.bankAccountId || undefined}
                  onValueChange={(v) => setConvertForm(p => ({ ...p, bankAccountId: v }))}>
                  <SelectTrigger><SelectValue placeholder={tr("convertDialog.bankAccountPh")} /></SelectTrigger>
                  <SelectContent>
                    {(bankAccounts as any[]).map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {isRtl ? (b.bankNameAr ?? b.accountName ?? `#${b.id}`) : (b.bankNameEn ?? b.accountName ?? `#${b.id}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertGrnId(null)}>{tr("convertDialog.cancel")}</Button>
            <Button
              data-testid="confirm-convert-btn"
              disabled={
                convertMut.isPending ||
                (convertForm.paymentType === "credit" && !convertForm.supplierId) ||
                (convertForm.paymentType === "cash" && !convertForm.cashBoxId) ||
                (convertForm.paymentType === "bank" && !convertForm.bankAccountId)
              }
              onClick={() => convertGrnId && convertMut.mutate({
                id: convertGrnId,
                body: {
                  paymentType: convertForm.paymentType,
                  supplierId:  convertForm.paymentType === "credit" ? convertForm.supplierId  : null,
                  cashBoxId:   convertForm.paymentType === "cash"   ? convertForm.cashBoxId   : null,
                  bankAccountId: convertForm.paymentType === "bank" ? convertForm.bankAccountId : null,
                },
              })}
              className="bg-blue-700 hover:bg-blue-600 text-white gap-2"
            >
              {convertMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {tr("convertDialog.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
