import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, CheckCircle2 } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
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
  warehouseId: string;
  qty: string;
  unitPrice: string;
  vatRate: string;
  lineTotal: string;
}

function newLine(): ReturnLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", warehouseId: "",
    qty: "1", unitPrice: "0", vatRate: "15", lineTotal: "0",
  };
}

const EMPTY = {
  docNumber: "", returnDate: today(), customerId: "", branchId: "", invoiceId: "",
  paymentType: "credit", cashBoxId: "",
  currencyCode: "", exchangeRate: "1", notes: "",
};

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:  { label: "مسودة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  posted: { label: "مرحّل",  cls: "bg-green-50 text-green-700 border-green-200" },
};

export default function SalesReturns() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);
  const [lines, setLines]       = useState<ReturnLine[]>([newLine()]);

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
      const res = await fetch(`${API}/api/sales/sales-returns`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "✓ تم إنشاء المرتجع" }); },
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

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-returns/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() {
    setForm({ ...EMPTY });
    setLines([newLine()]);
    setShowForm(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("fromInvoice");
    window.history.replaceState({}, "", url.toString());
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
        });
        if (inv.lines?.length) {
          setLines(inv.lines.map((l: any) => ({
            _id: crypto.randomUUID(),
            itemId:      l.itemId      ? String(l.itemId)      : "",
            itemName:    l.itemName    ?? "",
            itemCode:    l.itemCode    ?? "",
            unitId:      l.unitId      ? String(l.unitId)      : "",
            unit:        l.unit        ?? "",
            warehouseId: l.warehouseId ? String(l.warehouseId) : "",
            qty:         String(Math.round(Number(l.qty ?? 1))),
            unitPrice:   String(l.unitPrice ?? 0),
            vatRate:     String(l.vatRate   ?? 15),
            lineTotal:   String(l.lineTotal ?? 0),
          })));
        }
        setShowForm(true);
      } catch (_) { /* silent */ }
    })();
  }, [user, currencies.length]);

  function calcLineTotal(l: ReturnLine) {
    return (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 + (Number(l.vatRate) || 0) / 100);
  }

  function updateLine(id: string, field: keyof ReturnLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const u = { ...l, [field]: value };
      return { ...u, lineTotal: calcLineTotal(u).toFixed(2) };
    }));
  }

  function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) return;
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const unit = units.find((u: any) => u.id === item.unitId);
      const updated: ReturnLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  item.nameAr ?? "",
        itemCode:  item.code   ?? "",
        unitId:    item.unitId ? String(item.unitId) : "",
        unit:      unit?.nameAr ?? "",
        unitPrice: String(item.sellPrice ?? item.price ?? "0"),
        vatRate:   String(item.vatRate   ?? "15"),
      };
      return { ...updated, lineTotal: calcLineTotal(updated).toFixed(2) };
    }));
  }

  const totalAmount = lines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);
  const vatAmount   = lines.reduce((s, l) => {
    const sub = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    return s + sub * ((Number(l.vatRate) || 0) / 100);
  }, 0);

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
          <div className="space-y-5">
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

            <div className="space-y-3">
              <h3 className="text-sm font-semibold">أصناف المرتجع</h3>
              {lines.map(l => (
                <div key={l._id} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="grid gap-2" style={{ gridTemplateColumns: "3fr 1.2fr 1fr 1fr 0.8fr auto" }}>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">الصنف</p>
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox items={itemComboItems} value={l.itemId} onValueChange={v => selectItem(l._id, v)} placeholder="اختر صنف..." />
                      ) : (
                        <Input className="h-8 text-xs" placeholder="اسم الصنف" value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">الوحدة</p>
                      {units.length > 0 ? (
                        <Select value={l.unitId || undefined} onValueChange={v => {
                          const u = units.find((u: any) => String(u.id) === v);
                          setLines(prev => prev.map(x => x._id === l._id ? { ...x, unitId: v, unit: u?.nameAr ?? "" } : x));
                        }}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="الوحدة" /></SelectTrigger>
                          <SelectContent>
                            {units.map((u: any) => <SelectItem key={u.id} value={String(u.id)}>{u.nameAr}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input className="h-8 text-xs" placeholder="وحدة" value={l.unit}
                          onChange={e => updateLine(l._id, "unit", e.target.value)} />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">الكمية</p>
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" dir="ltr" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">السعر</p>
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">ضريبة%</p>
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" dir="ltr" value={l.vatRate}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                    </div>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive self-end"
                      onClick={() => setLines(p => p.filter(x => x._id !== l._id))} disabled={lines.length <= 1}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: "2fr 1.2fr 1fr auto" }}>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        المستودع
                        {!l.warehouseId && l.itemId && (
                          <span className="text-amber-600 text-[9px]">⚠ مطلوب لإرجاع المخزون</span>
                        )}
                      </p>
                      {warehouses.length > 0 ? (
                        <Select value={l.warehouseId || undefined} onValueChange={v => updateLine(l._id, "warehouseId", v)}>
                          <SelectTrigger className={cn("h-7 text-xs", l.itemId && !l.warehouseId && "border-amber-400")}>
                            <SelectValue placeholder="اختر مستودع..." />
                          </SelectTrigger>
                          <SelectContent>
                            {warehouses.map((w: any) => (
                              <SelectItem key={w.id} value={String(w.id)}>{w.nameAr}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input className="h-7 text-xs" placeholder="—" readOnly />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">كود الصنف</p>
                      <Input className="h-7 text-xs bg-muted/40" readOnly={!!l.itemId} placeholder="تلقائي" value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">الإجمالي</p>
                      <Input className="h-7 text-xs bg-muted/40 font-mono" dir="ltr" readOnly value={fmt(l.lineTotal)} />
                    </div>
                    <div />
                  </div>
                </div>
              ))}

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setLines(p => [...p, newLine()])}>
                <Plus className="h-4 w-4" />إضافة صنف
              </Button>
            </div>

            <div className="flex justify-end">
              <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                <div className="flex justify-between"><span className="text-muted-foreground">المجموع شامل الضريبة</span><span className="font-mono">{fmt(totalAmount)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">قيمة الضريبة</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
              </div>
            </div>
          </div>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
          : returns_.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">لا توجد مرتجعات بعد</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {["رقم المرتجع","التاريخ","العميل","الفاتورة","الإجمالي","الضريبة","العملة","الحالة","إجراءات"].map(h =>
                <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns_.map((r: any) => {
                const st = STATUS[r.status] ?? STATUS.draft;
                const inv = invoices.find((i: any) => i.id === r.invoiceId);
                return (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber ?? `SR-${r.id}`}</td>
                    <td className="px-3 py-2.5">{r.returnDate}</td>
                    <td className="px-3 py-2.5">{cusMap[r.customerId] ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv?.docNumber ?? (r.invoiceId ? `SI-${r.invoiceId}` : "—")}</td>
                    <td className="px-3 py-2.5 font-mono font-semibold">{fmt(r.totalAmount)}</td>
                    <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(r.vatAmount)}</td>
                    <td className="px-3 py-2.5">{r.currencyCode}</td>
                    <td className="px-3 py-2.5"><span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        {r.status === "draft" && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title="ترحيل"
                            onClick={() => { if (confirm("ترحيل المرتجع؟ سيتم زيادة رصيد المخزون.")) postMut.mutate(r.id); }}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
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
