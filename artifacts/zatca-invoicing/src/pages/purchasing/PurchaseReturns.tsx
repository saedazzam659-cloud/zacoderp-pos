import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

interface ReturnLine { _id: string; itemName: string; itemCode: string; unit: string; qty: string; unitPrice: string; vatRate: string; lineTotal: string; }
function newLine(): ReturnLine { return { _id: crypto.randomUUID(), itemName: "", itemCode: "", unit: "", qty: "1", unitPrice: "0", vatRate: "15", lineTotal: "0" }; }

const EMPTY = { docNumber: "", returnDate: today(), supplierId: "", invoiceId: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

export default function PurchaseReturns() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);
  const [lines, setLines]       = useState<ReturnLine[]>([newLine()]);

  const { data: returns_ = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-returns", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/purchasing/purchase-returns?companyId=${cid}` : `${API}/api/purchasing/purchase-returns`, { headers: authH }); return r.json(); },
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-returns"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/purchasing/purchase-returns`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "✓ تم إنشاء المرتجع" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-returns/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setLines([newLine()]); setShowForm(false); }

  function updateLine(id: string, field: keyof ReturnLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const u = { ...l, [field]: value };
      const lineTotal = (Number(u.qty) || 0) * (Number(u.unitPrice) || 0) * (1 + (Number(u.vatRate) || 0) / 100);
      return { ...u, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  const totalAmount = lines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);
  const vatAmount = lines.reduce((s, l) => {
    const sub = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    return s + sub * ((Number(l.vatRate) || 0) / 100);
  }, 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, supplierId: form.supplierId || null, invoiceId: form.invoiceId || null,
      totalAmount: totalAmount.toFixed(2), vatAmount: vatAmount.toFixed(2),
      lines: lines.filter(l => l.itemName).map(l => ({ ...l, _id: undefined })) });
  }

  const supplierItems = [{ value: "", label: "— بدون مورد —" }, ...suppliers.map((s: any) => ({ value: String(s.id), label: s.nameAr }))];
  const invoiceItems  = [{ value: "", label: "— بدون فاتورة —" }, ...invoices.map((i: any) => ({ value: String(i.id), label: i.docNumber ?? `PI-${i.id}` }))];
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, s.nameAr]));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><RotateCcw className="h-6 w-6 text-primary" />مرتجعات المشتريات</h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة مرتجعات الموردين وعكس الحركات</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />مرتجع جديد
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between px-5 py-3 border-b">
            <h2 className="font-semibold">مرتجع مشتريات جديد</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label>رقم المرتجع</Label>
                <Input placeholder="تلقائي" value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>التاريخ *</Label>
                <Input type="date" value={form.returnDate} onChange={e => setForm((p: any) => ({ ...p, returnDate: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>المورد</Label>
                <SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder="المورد..." />
              </div>
              <div className="space-y-1.5">
                <Label>فاتورة المشتريات</Label>
                <SearchCombobox items={invoiceItems} value={form.invoiceId} onValueChange={v => setForm((p: any) => ({ ...p, invoiceId: v }))} placeholder="رقم الفاتورة..." />
              </div>
            </div>

            {/* Lines */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">أصناف المرتجع</Label>
              {lines.map(l => (
                <div key={l._id} className="grid gap-2 p-3 rounded-lg border bg-muted/20" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto" }}>
                  <div><p className="text-[10px] text-muted-foreground mb-1">الصنف</p>
                    <Input className="h-8 text-xs" value={l.itemName} onChange={e => updateLine(l._id, "itemName", e.target.value)} /></div>
                  <div><p className="text-[10px] text-muted-foreground mb-1">الكمية</p>
                    <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.qty} onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9.]/g, ""))} /></div>
                  <div><p className="text-[10px] text-muted-foreground mb-1">السعر</p>
                    <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice} onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} /></div>
                  <div><p className="text-[10px] text-muted-foreground mb-1">ضريبة%</p>
                    <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate} onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} /></div>
                  <div><p className="text-[10px] text-muted-foreground mb-1">الإجمالي</p>
                    <Input className="h-8 text-xs bg-muted/40" readOnly value={fmt(l.lineTotal)} /></div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive self-end" onClick={() => setLines(p => p.filter(x => x._id !== l._id))} disabled={lines.length <= 1}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setLines(p => [...p, newLine()])}>
                <Plus className="h-4 w-4" />إضافة صنف
              </Button>
            </div>

            <div className="flex justify-between items-end">
              <div />
              <div className="text-sm border rounded-xl p-3 bg-muted/30 space-y-1 w-60">
                <div className="flex justify-between"><span className="text-muted-foreground">الضريبة</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                <div className="flex justify-between font-bold border-t pt-1"><span>الإجمالي</span><span className="font-mono text-primary">{fmt(totalAmount)}</span></div>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={saveMut.isPending}>حفظ المرتجع</Button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
          : returns_.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">لا توجد مرتجعات بعد</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {["رقم المرتجع","التاريخ","المورد","العملة","الضريبة","الإجمالي","الحالة","إجراءات"].map(h =>
                <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns_.map(r => (
                <tr key={r.id} className="border-b hover:bg-muted/30">
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber ?? `PR-${r.id}`}</td>
                  <td className="px-3 py-2.5">{r.returnDate}</td>
                  <td className="px-3 py-2.5">{supMap[r.supplierId] ?? "—"}</td>
                  <td className="px-3 py-2.5">{r.currencyCode}</td>
                  <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(r.vatAmount)}</td>
                  <td className="px-3 py-2.5 font-mono font-semibold">{fmt(r.totalAmount)}</td>
                  <td className="px-3 py-2.5"><span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                    r.status === "posted" ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
                  )}>{r.status === "posted" ? "مرحّل" : "مسودة"}</span></td>
                  <td className="px-3 py-2.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => { if (confirm("حذف المرتجع؟")) deleteMut.mutate(r.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
