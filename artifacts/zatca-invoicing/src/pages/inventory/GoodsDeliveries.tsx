import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
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
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus, Trash2, PackageMinus, CheckCircle2, Printer, Pencil, FileText,
  ListOrdered, Copy, FileSpreadsheet, FileDown, X, Loader2, Undo2,
  ArrowRightCircle, ExternalLink,
} from "lucide-react";
import * as XLSX from "xlsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { DiscountRow } from "@/components/DiscountRow";
import { cn } from "@/lib/utils";
import { downloadCsv, matchCol, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
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

interface DeliveryLine {
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

function newLine(): DeliveryLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", unitPrice: "0", discount: "0", vatRate: "15", lineTotal: "0",
    notes: "",
  };
}

const EMPTY = {
  docNumber: "", customerOrderNumber: "", deliveryDate: today(),
  customerId: "", branchId: "",
  currencyCode: "", exchangeRate: "1", notes: "",
  discountAmount: "0",
  priceIncludesVat: false,
};

export default function GoodsDeliveries() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`warehousePages.goodsDeliveries.${k}`, opts) as string;
  const custName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
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
  const [lines, setLines] = useState<DeliveryLine[]>([newLine()]);

  const seqPeek = useNextSequenceNumber("goods_delivery", showForm && editingId == null);
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

  // ── Data queries ─────────────────────────────────────────
  const { data: deliveries = [], isLoading } = useQuery<any[]>({
    queryKey: ["goods-deliveries", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/goods-deliveries?companyId=${cid}` : `${API}/api/goods-deliveries`, { headers: authH });
      return r.json();
    },
    enabled: !!user,
  });

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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["goods-deliveries"] });

  // ── Mutations ────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const isEdit = !!editingId;
      const url = isEdit
        ? `${API}/api/goods-deliveries/${editingId}`
        : `${API}/api/goods-deliveries`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST", headers, body: JSON.stringify({ ...data, companyId: cid }),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      // Auto-post on create — keeps the GDN useful (stock updated) without a
      // separate click. Edits stay as-is so users can tweak drafts freely.
      if (!isEdit && j?.id && (j.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/goods-deliveries/${j.id}/post`, { method: "PATCH", headers });
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
      const res = await fetch(`${API}/api/goods-deliveries/${id}/post`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/goods-deliveries/${id}/unpost`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.unposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/goods-deliveries/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Convert dialog state — opens with the GDN id; user picks paymentType +
  // customer (credit) or cashBox/bank (cash/bank); on submit we POST to the
  // convert endpoint and navigate to the new sales invoice's edit page.
  const [convertGdnId, setConvertGdnId] = useState<number | null>(null);
  const [convertForm, setConvertForm] = useState<{ paymentType: string; customerId: string; cashBoxId: string; bankAccountId: string; }>({
    paymentType: "credit", customerId: "", cashBoxId: "", bankAccountId: "",
  });

  function openConvertDialog(gdn: any) {
    setConvertGdnId(Number(gdn.id));
    setConvertForm({
      paymentType: "credit",
      customerId: gdn.customerId ? String(gdn.customerId) : "",
      cashBoxId: "", bankAccountId: "",
    });
  }

  const convertMut = useMutation({
    mutationFn: async (payload: { id: number; body: any }) => {
      const res = await fetch(`${API}/api/goods-deliveries/${payload.id}/convert-to-invoice`, {
        method: "POST", headers, body: JSON.stringify(payload.body),
      });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (inv: any) => {
      qc.invalidateQueries({ queryKey: ["goods-deliveries"] });
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
      toast({ title: tr("toasts.converted") });
      setConvertGdnId(null);
      if (inv?.id) navigate(`/sales/invoices/${inv.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  async function startEdit(gdnId: number) {
    try {
      const res = await fetch(`${API}/api/goods-deliveries/${gdnId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(gdnId);
      setForm({
        docNumber:    full.docNumber ?? "",
        customerOrderNumber: full.customerOrderNumber ?? "",
        deliveryDate: full.deliveryDate ?? today(),
        customerId:   full.customerId ? String(full.customerId) : "",
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
        notes:       l.notes ?? "",
      })) : [newLine()]);
      setShowForm(true);
    } catch (e: any) {
      toast({ title: e.message || tr("toasts.loadError"), variant: "destructive" });
    }
  }

  async function duplicateDelivery(gdnId: number) {
    try {
      const res = await fetch(`${API}/api/goods-deliveries/${gdnId}`, { headers: authH });
      if (!res.ok) { toast({ title: tr("toasts.loadFail"), variant: "destructive" }); return; }
      const full = await res.json();
      setEditingId(null);
      setForm({
        docNumber:    "",
        customerOrderNumber: full.customerOrderNumber ?? "",
        deliveryDate: today(),
        customerId:   full.customerId ? String(full.customerId) : "",
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
    setEditingId(null);
    setShowForm(false);
  }

  function calcLineTotal(l: DeliveryLine, priceIncludesVat = false) {
    const qty   = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const disc  = Number(l.discount) || 0;
    const rate  = (Number(l.vatRate) || 0) / 100;
    const gross = qty * price * (1 - disc / 100);
    if (priceIncludesVat) return gross;
    return gross * (1 + rate);
  }
  function calcLineParts(l: DeliveryLine, priceIncludesVat = false) {
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

  function updateLine(id: string, field: keyof DeliveryLine, value: string) {
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
      const updated: DeliveryLine = {
        ...l,
        unitId: newUnitId,
        unit: unitName(row?.unit) || unitName(globalUnit) || "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.salePrice != null ? String(row.salePrice) : (row?.costPrice != null ? String(row.costPrice) : l.unitPrice),
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
      const updated: DeliveryLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemName(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitName(base?.unit) || unitName(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: String(base?.salePrice ?? item.salePrice ?? base?.costPrice ?? item.costPrice ?? "0"),
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
      customerId: form.customerId || null,
      branchId:   form.branchId   || null,
      discountAmount: docDiscountAmt.toFixed(2),
      subtotal:    subtotalNet.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      vatAmount:   vatAmount.toFixed(2),
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  const customerItems = [
    { value: "", label: tr("noCustomerOpt") },
    ...customers.map((s: any) => ({ value: String(s.id), label: custName(s) })),
  ];
  const itemComboItems = [
    { value: "", label: tr("selectItemOpt") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      label: i.code ? `${i.code} — ${itemName(i)}` : itemName(i),
    })),
  ];
  const custMap = Object.fromEntries(customers.map((s: any) => [s.id, custName(s)]));

  const lineColHeaders = [
    tr("lineCols.item"), tr("lineCols.itemCode"), tr("lineCols.warehouse"),
    tr("lineCols.unit"), tr("lineCols.qty"), tr("lineCols.price"),
    tr("lineCols.discount"), tr("lineCols.vat"), tr("lineCols.total"),
    tr("lineCols.notes"), "",
  ];

  // ── Audit grid ───────────────────────────────────────────
  const [tableSearch, setTableSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "invoiced">("all");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPrintBusy, setBulkPrintBusy] = useState(false);

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : s === "posted" ? tr("postedM") : s === "invoiced" ? tr("invoicedM") : tr("draft");

  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                     type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                    type: "none", valueOf: () => "" },
    { key: "doc",      label: tr("listCols.number"),  type: "text", valueOf: (r) => r.docNumber ?? `GDN-${r.id}` },
    { key: "date",     label: tr("listCols.date"),    type: "text", valueOf: (r) => r.deliveryDate ?? "" },
    { key: "customer", label: tr("listCols.customer"),type: "text", valueOf: (r) => custMap[r.customerId] ?? "" },
    { key: "currency", label: tr("listCols.currency"),type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: tr("listCols.subtotal"),type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0) },
    { key: "vat",      label: tr("listCols.vat"),     type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: tr("listCols.total"),   type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "journal",  label: tr("listCols.journal"), type: "text", valueOf: (r) => r.journalEntryId ? `JE-${r.journalEntryId}` : "" },
    { key: "linkedInvoice", label: tr("listCols.linkedInvoice"), type: "text", valueOf: (r) => r.linkedInvoiceId ? `SI-${r.linkedInvoiceId}` : "" },
    { key: "status",   label: tr("listCols.status"),  type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "_act",     label: tr("listCols.actions"), type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "goodsDeliveriesAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, footerTheme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;

  const filteredDeliveries = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (deliveries as any[]).filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [
          r.docNumber, `GDN-${r.id}`, r.deliveryDate, custMap[r.customerId],
          r.currencyCode, r.notes, r.customerOrderNumber,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const f = colFilters[col.key];
        if (!f) continue;
        if (!matchCol(col.valueOf(r), f, col.type)) return false;
      }
      return true;
    });
  }, [deliveries, tableSearch, statusFilter, colFilters, custMap]);

  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredDeliveries.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedDeliveries = useMemo(
    () => pageSize === 0 ? filteredDeliveries : filteredDeliveries.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredDeliveries, pageSize, safePage],
  );
  const pageStart = filteredDeliveries.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredDeliveries.length : Math.min(safePage * pageSize, filteredDeliveries.length);

  const totals = useMemo(() => filteredDeliveries.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredDeliveries]);

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
      toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بفتح النوافذ المنبثقة من المتصفح للطباعة", variant: "destructive" });
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  };

  const buildListHtml = (source: any[] = filteredDeliveries) => {
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
<div class="meta">تاريخ التقرير: ${reportDate} — عدد الأذونات: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم الإذن</th><th>التاريخ</th><th>العميل</th><th>العملة</th>
  <th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>القيد</th><th>الفاتورة</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `GDN-${r.id}`)}</td>
  <td>${escapeHtml(r.deliveryDate ?? "")}</td>
  <td>${escapeHtml(custMap[r.customerId] ?? "")}</td>
  <td>${escapeHtml(r.currencyCode ?? "")}</td>
  <td class="num">${(Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2)}</td>
  <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
  <td>${r.journalEntryId ? `JE-${escapeHtml(r.journalEntryId)}` : ""}</td>
  <td>${r.linkedInvoiceId ? `SI-${escapeHtml(r.linkedInvoiceId)}` : ""}</td>
  <td>${escapeHtml(statusLabel(r.status))}</td>
</tr>`).join("")}
</tbody><tfoot><tr>
  <td colspan="5">الإجمالي العام</td>
  <td class="num">${sumSub.toFixed(2)}</td>
  <td class="num">${sumVat.toFixed(2)}</td>
  <td class="num">${sumTot.toFixed(2)}</td>
  <td colspan="3"></td>
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
      const docNo  = d.docNumber ?? `GDN-${d.id}`;
      const linesHtml = lns.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">لا توجد بنود لهذا الإذن.</td></tr>`
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
          <span class="badge b-doc">رقم الإذن: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">التاريخ: ${escapeHtml(d.deliveryDate ?? "")}</span>
          <span class="badge b-cust">العميل: ${escapeHtml(custMap[d.customerId] ?? "—")}</span>
          <span class="badge b-status s-${escapeHtml(d.status)}">${escapeHtml(statusLabel(d.status))}</span>
        </div>
        ${d.notes ? `<div class="desc">${escapeHtml(d.notes)}</div>` : ""}
        <table>
          <thead><tr>
            <th style="width:30px;">#</th><th>الصنف</th>
            <th style="width:70px;">الكمية</th><th style="width:80px;">السعر</th>
            <th style="width:60px;">الضريبة</th><th style="width:90px;">الإجمالي</th>
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
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة أذونات التسليم المحدّدة</title>
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
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">${logoHtml}${companyHtml}<h1>أذونات التسليم المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${reportDate} — عدد الأذونات: ${docs.length}</div></div>
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
    if (filteredDeliveries.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const rows = filteredDeliveries.map((r: any) => ({
      "رقم الإذن": r.docNumber ?? `GDN-${r.id}`,
      "التاريخ": r.deliveryDate ?? "",
      "العميل": custMap[r.customerId] ?? "",
      "العملة": r.currencyCode ?? "",
      "المجموع": (Number(r.totalAmount ?? 0) - Number(r.vatAmount ?? 0)).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "القيد": r.journalEntryId ? `JE-${r.journalEntryId}` : "",
      "الفاتورة": r.linkedInvoiceId ? `SI-${r.linkedInvoiceId}` : "",
      "الحالة": statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "أذونات التسليم");
    XLSX.writeFile(wb, `goods-deliveries-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      const ordered = (filteredDeliveries as any[]).filter((r) => idSet.has(Number(r.id)));
      let failed = 0;
      const docs = await Promise.all(
        ordered.map(async (row: any) => {
          try {
            const res = await fetch(`${API}/api/goods-deliveries/${row.id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
          } catch { failed += 1; return { ...row, lines: [] }; }
        }),
      );
      openPrintWindow(buildBulkHtml(docs));
      if (failed > 0) {
        toast({ title: "تعذّر تحميل تفاصيل بعض الأذونات", description: `تمت طباعة ${docs.length} مع ${failed} بدون بنود تفصيلية`, variant: "destructive" });
      }
    } finally { setBulkPrintBusy(false); }
  }

  function exportCsv() {
    if (filteredDeliveries.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredDeliveries.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`goods-deliveries-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  const allFilteredIds: number[] = useMemo(
    () => filteredDeliveries.map((r: any) => Number(r.id)),
    [filteredDeliveries],
  );
  const selectedRows = useMemo(
    () => (deliveries as any[]).filter((r) => isSelected(Number(r.id))),
    [deliveries, isSelected],
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
        const res = await fetch(`${API}/api/goods-deliveries/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-deliveries"] });
      if (failed.length === 0) toast({ title: `تم ترحيل ${ok} إذن` });
      else toast({ title: `ترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnpost() {
    const ids = selectedUnpostable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد أذونات مرحَّلة ضمن المحدَّد", variant: "destructive" }); return; }
    if (!window.confirm(`إلغاء ترحيل ${ids.length} إذن؟`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/goods-deliveries/${id}/unpost`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-deliveries"] });
      if (failed.length === 0) toast({ title: `تم إلغاء ترحيل ${ok} إذن` });
      else toast({ title: `إلغاء: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا يمكن حذف الأذونات المرحَّلة", variant: "destructive" }); return; }
    if (!window.confirm(`حذف ${ids.length} إذن نهائياً؟ لا يمكن التراجع.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/goods-deliveries/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      qc.invalidateQueries({ queryKey: ["goods-deliveries"] });
      if (failed.length === 0) toast({ title: `تم حذف ${ok} إذن` });
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
            <PackageMinus className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => { reset(); setShowForm(true); }}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
            data-testid="new-gdn-btn"
          >
            <Plus className="h-4 w-4" />
            {tr("newDelivery")}
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
        const currentGdn = editingId
          ? (deliveries as any[]).find((r: any) => Number(r.id) === Number(editingId))
          : null;
        const customerNameById = (id: any) => {
          const s = (customers as any[]).find((s: any) => Number(s.id) === Number(id));
          return s ? (s.nameAr ?? s.nameEn ?? `#${s.id}`) : "—";
        };
        return (
        <>
          {editingId && (deliveries as any[]).length > 0 && (
            <div className="flex justify-end">
              <DocNavigator
                items={(deliveries as any[]).map((d: any) => ({
                  id: d.id,
                  docNumber: d.docNumber,
                  partyName: customerNameById(d.customerId),
                  date: d.deliveryDate ?? "",
                  total: d.totalAmount ?? 0,
                  currencyCode: d.currencyCode ?? "",
                }))}
                currentId={editingId}
                onSelect={(id) => startEdit(Number(id))}
                fallbackPrefix="GDN-"
              />
            </div>
          )}
          <FormPanel
            icon={PackageMinus}
            title={
              <span className="inline-flex items-center gap-2 flex-wrap">
                {editingId ? tr("editTitle") : tr("newTitle")}
                {currentGdn && <DocStatusBadge status={currentGdn.status} />}
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
                  <Field label={tr("deliveryNumber")}>
                    <Input
                      value={form.docNumber}
                      onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))}
                      placeholder={seqPeek.hasSequence ? (seqPeek.number ?? tr("deliveryNumberPh")) : tr("deliveryNumberPh")}
                      readOnly={!editingId && seqPeek.hasSequence}
                    />
                  </Field>
                  <Field label={tr("deliveryDate")} required>
                    <Input type="date" value={form.deliveryDate}
                      onChange={e => setForm((p: any) => ({ ...p, deliveryDate: e.target.value }))} />
                  </Field>
                  <Field label={tr("customer")}>
                    <SearchCombobox items={customerItems} value={form.customerId}
                      onValueChange={v => setForm((p: any) => ({ ...p, customerId: v }))}
                      placeholder={tr("customerPh")} />
                  </Field>
                  <Field label={tr("customerOrderNumber")}>
                    <Input value={form.customerOrderNumber}
                      onChange={e => setForm((p: any) => ({ ...p, customerOrderNumber: e.target.value }))}
                      placeholder={tr("customerOrderNumberPh")} />
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
                  <Field label={tr("currency")}>
                    <SearchCombobox
                      items={currencies.map((c: any) => ({ value: c.code, label: `${c.code} — ${isRtl ? c.nameAr : c.nameEn}` }))}
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
                    const GRID_COLS_GD = "220px 110px 160px 120px 90px 110px 80px 80px 130px 180px 40px";
                    return (
                  <div className="rounded-xl border bg-card overflow-x-auto" dir={isRtl ? "rtl" : "ltr"}>
                    <div className="min-w-max">
                  <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: GRID_COLS_GD }}>
                    {lineColHeaders.map((h, i) => (
                      <p key={i} className={cn("text-[11px] font-medium truncate", h === tr("lineCols.total") ? "font-semibold text-primary" : "text-muted-foreground")} title={h}>{h}</p>
                    ))}
                  </div>
                  <div className="divide-y">
                  {lines.map(l => (
                    <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                      <div className="grid gap-2 items-center" style={{ gridTemplateColumns: GRID_COLS_GD }}>
                        {inventoryItems.length > 0 ? (
                          <SearchCombobox items={itemComboItems} value={l.itemId}
                            onValueChange={v => selectItem(l._id, v)}
                            placeholder={tr("selectItemCombo")} />
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
                                label: unitName(iu.unit) || `#${iu.unitId}`,
                              }))
                            : units.map((u: any) => ({ value: String(u.id), label: unitName(u) || `#${u.id}` }));
                          return (
                            <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                              <SelectContent>
                                {opts.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          );
                        })()}
                        <Input className="h-8 text-xs text-end" inputMode="decimal" value={l.qty}
                          onChange={e => updateLine(l._id, "qty", e.target.value)} />
                        <Input className="h-8 text-xs text-end" inputMode="decimal" value={l.unitPrice}
                          onChange={e => updateLine(l._id, "unitPrice", e.target.value)} />
                        <Input className="h-8 text-xs text-end" inputMode="decimal" value={l.discount}
                          onChange={e => updateLine(l._id, "discount", e.target.value)} />
                        <Input className="h-8 text-xs text-end" inputMode="decimal" value={l.vatRate}
                          onChange={e => updateLine(l._id, "vatRate", e.target.value)} />
                        <Input className="h-8 text-xs text-end font-semibold text-primary bg-primary/5" readOnly value={fmt(l.lineTotal)} />
                        <Input className="h-8 text-xs" value={l.notes}
                          onChange={e => updateLine(l._id, "notes", e.target.value)} placeholder={tr("lineCols.notes")} />
                        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-rose-700 hover:bg-rose-50"
                          onClick={() => setLines(prev => prev.filter(x => x._id !== l._id))}
                          disabled={lines.length === 1}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  </div>
                  <div className="px-3 py-2 border-t bg-muted/20">
                    <Button type="button" size="sm" variant="ghost" onClick={addLine} className="gap-1 text-xs h-7">
                      <Plus className="h-3.5 w-3.5" /> {tr("addLine")}
                    </Button>
                  </div>
                  </div>
                  </div>
                    );
                  })()}
                </div>

                {/* Totals */}
                <div className="flex flex-wrap gap-4 justify-between border-t pt-4">
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!!form.priceIncludesVat}
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
                    <DiscountRow gross={grossTotal} value={form.discountAmount ?? "0"} onChange={v => setForm((p: any) => ({ ...p, discountAmount: v }))} />
                    <div className="flex justify-between font-bold border-t pt-2 text-base">
                      <span>{tr("totalLabel")}</span>
                      <span className="font-mono text-primary" data-testid="gdn-total">{fmt(totalAmount)}</span>
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
            <PackageMinus className="h-4 w-4 opacity-90" />
            جرد أذونات التسليم
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
            placeholder="بحث (مستند، عميل، عملة)…"
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
            {filteredDeliveries.length} إذن
            {filteredDeliveries.length !== deliveries.length && <span className="text-slate-400"> / {deliveries.length}</span>}
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
            title={selectedPostable.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedPostable.length} إذن`}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            ترحيل ({selectedPostable.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد إذنًا واحدًا فقط للتعديل", variant: "destructive" }); return; }
              startEdit(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "فتح/تعديل الإذن المحدَّد" : "حدِّد إذنًا واحدًا فقط"}>
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد إذنًا واحدًا فقط للنسخ", variant: "destructive" }); return; }
              duplicateDelivery(Number(Array.from(layout.selected)[0]));
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "إنشاء نسخة مماثلة من الإذن المحدَّد" : "حدِّد إذنًا واحدًا فقط"}>
            <Copy className="h-3.5 w-3.5" />
            نسخة مماثلة
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkUnpost}
            disabled={bulkBusy || selectedUnpostable.length === 0}
            title={selectedUnpostable.length === 0 ? "لا توجد أذونات مرحَّلة ضمن المحدَّد" : `إلغاء ترحيل ${selectedUnpostable.length} إذن`}>
            <Undo2 className="h-3.5 w-3.5" />
            إلغاء الترحيل ({selectedUnpostable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف الأذونات المرحَّلة"
              : `حذف ${selectedDeletable.length} إذن`}>
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── List ─────────────────────────────────────────── */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filteredDeliveries.filter((r: any) => r.status === "draft").length },
          { kind: "posted",    count: filteredDeliveries.filter((r: any) => r.status === "posted").length },
          { kind: "cancelled", count: filteredDeliveries.filter((r: any) => r.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
          ) : filteredDeliveries.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {deliveries.length === 0 ? tr("noDeliveries") : "لا توجد أذونات ضمن التصفية الحالية"}
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
                      ) : col.label}
                      {col.key !== "_sel" && (
                        <span {...gripProps(col.key, idx)}
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
                          className="h-6 text-[10.5px] px-1.5"
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedDeliveries.map((r: any, idx: number) => {
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
                      data-testid={`gdn-row-${r.id}`}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(Number(r.id))}
                                ariaLabel={`تحديد الإذن ${r.docNumber ?? `GDN-${r.id}`}`}
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
                                    data-testid={`convert-gdn-${r.id}`}>
                                    <ArrowRightCircle className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.linkedInvoiceId && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-indigo-700 hover:bg-indigo-50"
                                    onClick={() => navigate(`/sales/invoices/${r.linkedInvoiceId}`)}
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
                                  onClick={() => duplicateDelivery(r.id)} title={tr("duplicateTip")}>
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                                {editable && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-rose-700 hover:bg-rose-50"
                                    onClick={() => { if (window.confirm(tr("confirmDelete"))) deleteMut.mutate(Number(r.id)); }}
                                    title={"حذف"}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {r.journalEntryId && (
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-slate-600 hover:bg-slate-100"
                                    onClick={() => navigate(`/accounting/journal-entries?id=${r.journalEntryId}`)}
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
                    if (col.key === "doc")      return <td key={col.key} className="px-2 py-1.5 border border-slate-300 text-start">الإجمالي</td>;
                    return <td key={col.key} className="px-2 py-1.5 border border-slate-300" />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        <AuditGridPagination
          layout={layout}
          totalRows={filteredDeliveries.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="إذن"
        />
      </div>

      {/* ── Convert-to-invoice dialog ──────────────────────── */}
      <Dialog open={convertGdnId !== null} onOpenChange={(o) => !o && setConvertGdnId(null)}>
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
              <Field label={tr("convertDialog.customer")} required>
                <SearchCombobox
                  items={[
                    { value: "", label: tr("convertDialog.customerPh") },
                    ...customers.map((s: any) => ({ value: String(s.id), label: custName(s) })),
                  ]}
                  value={convertForm.customerId}
                  onValueChange={(v) => setConvertForm(p => ({ ...p, customerId: v }))}
                  placeholder={tr("convertDialog.customerPh")} />
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
            <Button variant="outline" onClick={() => setConvertGdnId(null)}>{tr("convertDialog.cancel")}</Button>
            <Button
              data-testid="confirm-convert-gdn-btn"
              disabled={
                convertMut.isPending ||
                (convertForm.paymentType === "credit" && !convertForm.customerId) ||
                (convertForm.paymentType === "cash" && !convertForm.cashBoxId) ||
                (convertForm.paymentType === "bank" && !convertForm.bankAccountId)
              }
              onClick={() => convertGdnId && convertMut.mutate({
                id: convertGdnId,
                body: {
                  paymentType: convertForm.paymentType,
                  customerId:  convertForm.paymentType === "credit" ? convertForm.customerId  : null,
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
