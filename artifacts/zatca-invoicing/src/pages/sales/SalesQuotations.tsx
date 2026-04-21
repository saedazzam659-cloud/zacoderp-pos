import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileSignature, Eye, Trash2, FileText, ArrowRightLeft, CheckCircle, XCircle, Send } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:     { label: "مسودة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  sent:      { label: "مُرسل",  cls: "bg-blue-50 text-blue-700 border-blue-200" },
  accepted:  { label: "مقبول",  cls: "bg-green-50 text-green-700 border-green-200" },
  rejected:  { label: "مرفوض",  cls: "bg-red-50 text-red-700 border-red-200" },
  converted: { label: "مُحوَّل لفاتورة", cls: "bg-primary/10 text-primary border-primary/30" },
};

export default function SalesQuotations() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");

  const { data: quotations = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-quotations", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-quotations?companyId=${cid}` : `${API}/api/sales/sales-quotations`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-quotations"] });

  const statusMut = useMutation({
    mutationFn: async (args: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${args.id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: args.status }) });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم تحديث الحالة" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}/convert`, { method: "POST", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (j) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
      toast({ title: "✓ تم تحويل العرض إلى فاتورة" });
      navigate(`/sales/invoices/${j.invoice.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = quotations.filter(q => {
    const s = search.toLowerCase();
    const matchText = !search || (q.docNumber ?? "").includes(s) || (cusMap[q.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || q.status === filterStatus;
    return matchText && matchStatus;
  });

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSignature className="h-6 w-6 text-primary" />عروض الأسعار
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة عروض الأسعار للعملاء وتحويلها إلى فواتير مبيعات</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/sales/quotations/new")}>
          <Plus className="h-4 w-4" />عرض جديد
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: "الإجمالي", v: quotations.length, c: "text-primary" },
          { label: "مسودات", v: quotations.filter(q => q.status === "draft").length, c: "text-amber-700" },
          { label: "مُرسلة", v: quotations.filter(q => q.status === "sent").length, c: "text-blue-700" },
          { label: "مقبولة", v: quotations.filter(q => q.status === "accepted").length, c: "text-green-700" },
          { label: "محوَّلة", v: quotations.filter(q => q.status === "converted").length, c: "text-primary" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <p className={cn("text-xl font-bold", s.c)}>{s.v}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث برقم العرض أو العميل..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 flex-wrap">
          {["all","draft","sent","accepted","rejected","converted"].map(s => (
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
            <p className="text-muted-foreground text-sm">لا توجد عروض أسعار</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/sales/quotations/new")}>
              <Plus className="h-4 w-4" />إنشاء أول عرض
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {["رقم العرض","التاريخ","صالح حتى","العميل","العملة","المجموع","الضريبة","الإجمالي","الحالة","إجراءات"].map(h => (
                    <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(q => {
                  const st = STATUS[q.status] ?? STATUS.draft;
                  return (
                    <tr key={q.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{q.docNumber ?? `SQ-${q.id}`}</td>
                      <td className="px-3 py-2.5">{q.quotationDate}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{q.validUntil ?? "—"}</td>
                      <td className="px-3 py-2.5">{cusMap[q.customerId] ?? "—"}</td>
                      <td className="px-3 py-2.5">{q.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(q.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(q.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(q.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="عرض / تعديل"
                            onClick={() => navigate(`/sales/quotations/${q.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {q.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600" title="إرسال"
                              onClick={() => statusMut.mutate({ id: q.id, status: "sent" })}>
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "draft") && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title="قبول"
                              onClick={() => statusMut.mutate({ id: q.id, status: "accepted" })}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "draft") && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" title="رفض"
                              onClick={() => statusMut.mutate({ id: q.id, status: "rejected" })}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {q.status === "accepted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title="تحويل لفاتورة"
                              onClick={() => { if (confirm("تحويل العرض إلى فاتورة مبيعات؟")) convertMut.mutate(q.id); }}>
                              <ArrowRightLeft className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {q.status !== "converted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm("حذف العرض؟")) deleteMut.mutate(q.id); }}>
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
