import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, ShoppingBag, Eye, Trash2, CheckCircle, FileText, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:     { label: "مسودة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  posted:    { label: "مرحّلة", cls: "bg-green-50 text-green-700 border-green-200" },
  cancelled: { label: "ملغية", cls: "bg-muted text-muted-foreground border-border" },
};

export default function SalesInvoices() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-invoices?companyId=${cid}` : `${API}/api/sales/sales-invoices`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-invoices"] });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم ترحيل الفاتورة وخصم المخزون" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم فك ترحيل الفاتورة" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    const matchText = !search || (inv.docNumber ?? "").includes(q) || (cusMap[inv.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || inv.status === filterStatus;
    return matchText && matchStatus;
  });

  const totalPosted = invoices.filter(i => i.status === "posted").reduce((s, i) => s + Number(i.totalAmount || 0), 0);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingBag className="h-6 w-6 text-primary" />فواتير المبيعات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة فواتير المبيعات — عند الترحيل يُخصم رصيد المخزون تلقائياً</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/sales/invoices/new")}>
          <Plus className="h-4 w-4" />فاتورة جديدة
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "إجمالي الفواتير", value: invoices.length, color: "text-primary" },
          { label: "مرحّلة", value: invoices.filter(i => i.status === "posted").length, color: "text-green-700" },
          { label: "مسودات", value: invoices.filter(i => i.status === "draft").length, color: "text-amber-700" },
          { label: "إجمالي المبيعات", value: `${fmt(totalPosted)} ريال`, color: "text-primary" },
        ].map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
            <p className={cn("text-xl font-bold font-mono", c.color)}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث برقم الفاتورة أو العميل..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "draft", "posted", "cancelled"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}>
              {s === "all" ? "الكل" : STATUS[s]?.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-muted-foreground text-sm">لا توجد فواتير مبيعات</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/sales/invoices/new")}>
              <Plus className="h-4 w-4" />إنشاء أول فاتورة
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {["رقم الفاتورة","التاريخ","العميل","نوع الدفع","العملة","المجموع","الضريبة","الإجمالي","القيد","الحالة","إجراءات"].map(h => (
                    <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  return (
                    <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onDoubleClick={() => navigate(`/sales/invoices/${inv.id}`)}
                      title="انقر مرتين للفتح والتعديل">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{inv.docNumber ?? `SI-${inv.id}`}</td>
                      <td className="px-3 py-2.5">{inv.invoiceDate}</td>
                      <td className="px-3 py-2.5">{cusMap[inv.customerId] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{inv.paymentType === "cash" ? "نقدي" : "آجل"}</td>
                      <td className="px-3 py-2.5">{inv.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(inv.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(inv.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(inv.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        {inv.journalEntryId ? (
                          <button onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)}
                            className="font-mono text-xs text-blue-600 hover:underline">
                            JE-{inv.journalEntryId}
                          </button>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="عرض / تعديل"
                            onClick={() => navigate(`/sales/invoices/${inv.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                              title="إنشاء مرتجع من هذه الفاتورة"
                              onClick={() => navigate(`/sales/returns?fromInvoice=${inv.id}`)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              title="فك الترحيل (إلغاء القيد وإعادة المخزون)"
                              onClick={() => { if (confirm("فك ترحيل الفاتورة؟ سيتم حذف القيد المحاسبي وإعادة الكميات إلى المخزون.")) unpostMut.mutate(inv.id); }}>
                              <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title="ترحيل"
                              onClick={() => { if (confirm("ترحيل الفاتورة؟ سيتم خصم الكميات من المخزون.")) postMut.mutate(inv.id); }}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm("حذف الفاتورة؟")) deleteMut.mutate(inv.id); }}>
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
          </div>
        )}
      </div>
    </div>
  );
}
