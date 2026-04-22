import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, CheckCircle2, Undo2, Calculator, FileText, ListOrdered, Pencil } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import { DiscountRow } from "@/components/DiscountRow";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
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
  paymentType: "credit", cashBoxId: "",
  currencyCode: "", exchangeRate: "1", notes: "",
  priceIncludesVat: false,
  cogsAccountId: "", inventoryAccountId: "", salesAccountId: "", taxAccountId: "", discountAccountId: "",
  discountAmount: "0",
};

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:  { label: "مسودة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  posted: { label: "مرحّل",  cls: "bg-green-50 text-green-700 border-green-200" },
};

export default function SalesReturns() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]         = useState<any>(EMPTY);
  const [lines, setLines]       = useState<ReturnLine[]>([newLine()]);
  useEnterNavContainer({ onAppend: () => setLines(p => [...p, newLine()]) });

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
        if (!pr.ok) throw new Error(`تم الحفظ ولكن فشل الترحيل: ${pj.error || pr.statusText}`);
        return pj;
      }
      return j;
    },
    onSuccess: () => {
      invalidate();
      const wasEdit = editingId != null;
      reset();
      toast({ title: wasEdit ? "✓ تم تعديل المرتجع وترحيله" : "✓ تم إنشاء المرتجع وترحيله" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}/post`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم ترحيل المرتجع وإرجاع المخزون" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم فك ترحيل المرتجع" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
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
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر تحميل المرتجع"); }
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
        discountAmount: r.discountAmount != null ? String(r.discountAmount) : "0",
        notes: r.notes ?? "",
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
            vatRate: String(l.vatRate ?? "15"),
            lineTotal: String(l.lineTotal ?? "0"),
            notes: l.notes ?? "",
          }))
        : [newLine()]);
      setShowForm(true);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    }
  }

  // Pre-fill from sales invoice
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const invId = params.get("fromInvoice");
    if (!invId || !user || !currencies.length) return;
    prefilledRef.current = true;

    (async () => {
      try {
        const res = await fetch(`${API}/api/sales/sales-invoices/${invId}?companyId=${cid}`, { headers: authH });
        if (!res.ok) return;
        const inv = await res.json();
        setForm({
          docNumber: "",
          returnDate: today(),
          customerId: inv.customerId ? String(inv.customerId) : "",
          branchId:   inv.branchId   ? String(inv.branchId)   : "",
          invoiceId:  String(inv.id),
          currencyCode: inv.currencyCode ?? defaultCurrency?.code ?? "",
          exchangeRate: inv.exchangeRate ? String(inv.exchangeRate) : "1",
          notes: `مرتجع من الفاتورة ${inv.docNumber ?? `SI-${inv.id}`}`,
          paymentType: "credit",
          cashBoxId: "",
          priceIncludesVat: !!inv.priceIncludesVat,
          cogsAccountId:      inv.cogsAccountId      ? String(inv.cogsAccountId)      : "",
          inventoryAccountId: inv.inventoryAccountId ? String(inv.inventoryAccountId) : "",
          salesAccountId:     inv.salesAccountId     ? String(inv.salesAccountId)     : "",
          taxAccountId:       inv.taxAccountId       ? String(inv.taxAccountId)       : "",
          discountAccountId:  inv.discountAccountId  ? String(inv.discountAccountId)  : "",
        });
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
            vatRate:     String(l.vatRate   ?? 15),
            lineTotal:   String(l.lineTotal ?? 0),
            notes:       l.notes ?? "",
          })));
        }
        setShowForm(true);
      } catch (_) { /* silent */ }
    })();
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
      paymentType: form.paymentType || "credit",
      cashBoxId:  form.paymentType === "cash" ? (form.cashBoxId || null) : null,
      totalAmount: totalAmount.toFixed(2),
      vatAmount:   vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2),
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })),
    });
  }

  const customerItems = [{ value: "", label: "— بدون عميل —" }, ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` }))];
  const invoiceItems  = [{ value: "", label: "— بدون فاتورة —" }, ...invoices.map((i: any) => ({ value: String(i.id), label: i.docNumber ?? `SI-${i.id}` }))];
  const itemComboItems = [{ value: "", label: "— اختر صنف —" }, ...inventoryItems.map((i: any) => ({ value: String(i.id), label: i.code ? `${i.code} — ${i.nameAr}` : i.nameAr }))];
  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-primary" />مرتجعات المبيعات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة مرتجعات العملاء — عند الترحيل يُزاد رصيد المخزون تلقائياً</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />مرتجع جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={RotateCcw}
          title="مرتجع مبيعات جديد"
          subtitle={form.invoiceId
            ? <>مستند من فاتورة رقم <span className="font-mono text-orange-600">{invoices.find((i: any) => String(i.id) === form.invoiceId)?.docNumber ?? `SI-${form.invoiceId}`}</span> — يمكنك تعديل الكميات قبل الحفظ</>
            : "إرجاع أصناف من فاتورة مبيعات وإعادتها للمخزون"}
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.returnDate}
          saveLabel="حفظ المرتجع"
        >
          <Tabs defaultValue="header" dir="rtl" className="space-y-4">
            <TabsList className="h-9 bg-muted/40 border gap-1">
              <TabsTrigger value="accounts" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <Calculator className="h-3.5 w-3.5" />حسابات القيد
              </TabsTrigger>
              <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <FileText className="h-3.5 w-3.5" />البيانات الرأسية
              </TabsTrigger>
              <TabsTrigger value="lines" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <ListOrdered className="h-3.5 w-3.5" />الأصناف ({lines.filter(l => l.itemId || l.itemName).length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="header" className="mt-0 space-y-5">
            <FormGrid>
              <Field label="رقم المرتجع"><Input placeholder="تلقائي" dir="ltr" className="text-left" value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} /></Field>
              <Field label="التاريخ" required><Input type="date" value={form.returnDate} onChange={e => setForm((p: any) => ({ ...p, returnDate: e.target.value }))} /></Field>
              <Field label="العميل"><SearchCombobox items={customerItems} value={form.customerId} onValueChange={v => setForm((p: any) => ({ ...p, customerId: v }))} placeholder="العميل..." /></Field>
              <Field label="فاتورة المبيعات"><SearchCombobox items={invoiceItems} value={form.invoiceId} onValueChange={v => setForm((p: any) => ({ ...p, invoiceId: v }))} placeholder="رقم الفاتورة..." /></Field>
              <Field label="الفرع">
                <Select value={form.branchId || undefined} onValueChange={(v) => setForm((p: any) => ({ ...p, branchId: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="اختر الفرع..." /></SelectTrigger>
                  <SelectContent>
                    {(branches as any[]).map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? " (الرئيسي)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="العملة">
                {currencies.length > 0 ? (
                  <Select value={form.currencyCode || undefined} onValueChange={handleCurrencyChange}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="العملة..." /></SelectTrigger>
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
              <Field label="سعر الصرف"><Input type="text" inputMode="decimal" dir="ltr" className="text-left" value={form.exchangeRate} onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
              <Field label="نوع الدفع">
                <Select value={form.paymentType} onValueChange={(v) => setForm((p: any) => ({ ...p, paymentType: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">آجل (على الحساب)</SelectItem>
                    <SelectItem value="cash">نقدي (رد للعميل)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {form.paymentType === "cash" && (
                <Field label="الخزنة" required>
                  <Select value={form.cashBoxId || undefined} onValueChange={(v) => setForm((p: any) => ({ ...p, cashBoxId: v }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="اختر الخزنة..." /></SelectTrigger>
                    <SelectContent>
                      {(cashBoxes as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="ملاحظات" className="md:col-span-2"><Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
            </FormGrid>
            </TabsContent>

            <TabsContent value="accounts" className="mt-0">
            <div className="rounded-lg border-2 border-blue-200 bg-blue-50/40 p-4 space-y-4">
              <div className="flex items-center gap-2 text-blue-900">
                <Calculator className="h-4 w-4" />
                <span className="text-xs font-semibold">حسابات القيد المحاسبي (ترحيل المرتجع)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px]">حساب إيراد المبيعات <span className="text-destructive">*</span></Label>
                  <AccountCombobox value={form.salesAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, salesAccountId: v }))}
                    placeholder="اختر حساب الإيراد..." filterTypes={["revenue"]} allowEmpty={false} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">حساب تكلفة البضاعة المباعة <span className="text-destructive">*</span></Label>
                  <AccountCombobox value={form.cogsAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, cogsAccountId: v }))}
                    placeholder="اختر حساب COGS..." filterTypes={["expense"]} allowEmpty={false} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">حساب ضريبة المخرجات (VAT)</Label>
                  <AccountCombobox value={form.taxAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, taxAccountId: v }))}
                    placeholder="اختر حساب ضريبة المخرجات..." filterTypes={["liability"]} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">حساب الخصم المسموح به</Label>
                  <AccountCombobox value={form.discountAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, discountAccountId: v }))}
                    placeholder="اختر حساب الخصم المسموح به..." filterTypes={["expense"]} />
                </div>
              </div>
              <p className="text-[11px] text-blue-900/70">
                إذا تم اختيار فاتورة المبيعات، فسيتم استخدام نفس حسابات الفاتورة تلقائياً.
              </p>
            </div>
            </TabsContent>

            <TabsContent value="lines" className="mt-0 space-y-5">
            <div data-enter-nav-container="lines" className="space-y-1.5">
              <h3 className="text-sm font-semibold">أصناف المرتجع</h3>
              <div className="grid gap-1.5 px-2 pb-1" style={{ gridTemplateColumns: "2.2fr 1fr 1.4fr 1.1fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.4fr auto" }}>
                {["الصنف", "كود الصنف", "المستودع", "الوحدة", "الكمية", "السعر", "خصم%", "ضريبة%", "الإجمالي", "ملاحظات", ""].map((h, i) => (
                  <p key={i} className={cn("text-[10px]", h === "الإجمالي" ? "font-semibold text-primary" : "text-muted-foreground")}>{h}</p>
                ))}
              </div>
              {lines.map(l => (
                <div key={l._id} className="rounded-lg border bg-muted/20 p-2">
                  <div className="grid gap-1.5 items-center" style={{ gridTemplateColumns: "2.2fr 1fr 1.4fr 1.1fr 0.7fr 1fr 0.7fr 0.7fr 1fr 1.4fr auto" }}>
                    {inventoryItems.length > 0 ? (
                      <SearchCombobox items={itemComboItems} value={l.itemId} onValueChange={v => selectItem(l._id, v)} placeholder="اختر صنف..." />
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
                            label: `${iu.unit?.nameAr ?? ""}${Number(iu.conversionFactor) !== 1 ? ` (×${iu.conversionFactor})` : ""}`,
                          }))
                        : (units as any[]).map((u: any) => ({ value: String(u.id), label: u.nameAr }));
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

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setLines(p => [...p, newLine()])}>
                <Plus className="h-4 w-4" />إضافة صنف
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
                <div className="flex justify-between"><span className="text-muted-foreground">المجموع شامل الضريبة</span><span className="font-mono">{fmt(grossTotal)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">قيمة الضريبة</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                {lineDiscountTotal > 0 && (
                  <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                    <span className="text-muted-foreground">خصم الأصناف</span>
                    <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                  </div>
                )}
                <DiscountRow gross={grossTotal} value={form.discountAmount ?? "0"} onChange={v => setForm((p: any) => ({ ...p, discountAmount: v }))} />
                <div className="flex justify-between font-bold border-t pt-2 text-base">
                  <span>الإجمالي{priceIncludesVat ? " (شامل)" : ""}</span>
                  <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                </div>
              </div>
            </div>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
          : returns_.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">لا توجد مرتجعات بعد</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {["رقم المرتجع","التاريخ","العميل","الفاتورة","الإجمالي","الضريبة","العملة","القيد","الحالة","إجراءات"].map(h =>
                <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns_.map((r: any) => {
                const st = STATUS[r.status] ?? STATUS.draft;
                const inv = invoices.find((i: any) => i.id === r.invoiceId);
                return (
                  <tr key={r.id} className="border-b hover:bg-muted/30 cursor-pointer"
                    onDoubleClick={() => editReturn(r.id)}
                    title={r.status === "draft" ? "انقر مرتين للتعديل" : "انقر مرتين للعرض (فك الترحيل أولاً للتعديل)"}>
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber ?? `SR-${r.id}`}</td>
                    <td className="px-3 py-2.5">{r.returnDate}</td>
                    <td className="px-3 py-2.5">{cusMap[r.customerId] ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv?.docNumber ?? (r.invoiceId ? `SI-${r.invoiceId}` : "—")}</td>
                    <td className="px-3 py-2.5 font-mono font-semibold">{fmt(r.totalAmount)}</td>
                    <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(r.vatAmount)}</td>
                    <td className="px-3 py-2.5">{r.currencyCode}</td>
                    <td className="px-3 py-2.5">
                      {r.journalEntryId ? (
                        <button onClick={() => navigate(`/accounting/journals/${r.journalEntryId}?tab=lines`)}
                          className="font-mono text-xs text-blue-600 hover:underline">
                          JE-{r.journalEntryId}
                        </button>
                      ) : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5"><span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title="تعديل"
                            onClick={() => editReturn(r.id)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title="ترحيل"
                            onClick={() => { if (confirm("ترحيل المرتجع؟ سيتم زيادة رصيد المخزون.")) postMut.mutate(r.id); }}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {r.status === "posted" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                            title="فك الترحيل (إلغاء القيد وخصم المخزون مرة أخرى)"
                            onClick={() => { if (confirm("فك ترحيل المرتجع؟ سيتم حذف القيد المحاسبي وعكس حركة المخزون.")) unpostMut.mutate(r.id); }}>
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm("حذف المرتجع؟")) deleteMut.mutate(r.id); }}>
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
    </div>
  );
}
