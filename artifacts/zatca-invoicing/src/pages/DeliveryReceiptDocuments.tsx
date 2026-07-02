// Standalone list + reports screen for goods receipt (استلام) / delivery
// (تسليم) documents. PURE archive — no GL/stock impact. Filter, search, view a
// KPI summary, and open any document (create/edit/print/share) via the shared
// dialog. Rendered by two routes (kind=receipt | delivery).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/ui/date-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import DeliveryReceiptDocDialog, { type DRKind } from "@/components/DeliveryReceiptDocDialog";
import {
  Plus, Search, Loader2, FileText, CheckCircle2, Trash2, PenLine, ClipboardList,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_OPTS = [
  { value: "", label: "كل الحالات" },
  { value: "full", label: "كامل" },
  { value: "partial", label: "جزئي" },
  { value: "damaged", label: "به تلفيات" },
  { value: "approved", label: "معتمد" },
];
const STATUS_LABEL: Record<string, string> = {
  full: "كامل", partial: "جزئي", damaged: "به تلفيات", approved: "معتمد",
};

export default function DeliveryReceiptDocuments({ kind }: { kind: DRKind }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const title = kind === "receipt" ? "سندات الاستلام" : "سندات التسليم";
  const label = kind === "receipt" ? "سند استلام" : "سند تسليم";

  const [rows, setRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ kind });
      if (q) p.set("q", q);
      if (status) p.set("status", status);
      if (from) p.set("from", new Date(from).toISOString());
      if (to) p.set("to", to);
      const [lr, sr] = await Promise.all([
        fetch(`${API}/api/delivery-receipt-documents?${p.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/delivery-receipt-documents/reports/summary?${p.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      setRows(lr.ok ? await lr.json() : []);
      setSummary(sr.ok ? await sr.json() : []);
    } catch {
      setRows([]); setSummary([]);
    } finally { setLoading(false); }
  }, [kind, q, status, from, to, token]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kind]);

  const kpi = useMemo(() => {
    let total = 0, approved = 0, withSig = 0, incomplete = 0;
    for (const r of summary) {
      const n = Number(r.n ?? 0);
      total += n;
      if (r.isApproved) approved += n;
      if (Number(r.hasSignature) === 1) withSig += n;
      if (r.status === "partial" || r.status === "damaged") incomplete += n;
    }
    return { total, approved, withSig, incomplete };
  }, [summary]);

  async function del(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("حذف هذا السند نهائياً؟")) return;
    try {
      const r = await fetch(`${API}/api/delivery-receipt-documents/${id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error();
      toast({ title: "تم الحذف" });
      load();
    } catch { toast({ title: "خطأ", description: "تعذّر الحذف", variant: "destructive" }); }
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><ClipboardList className="h-5 w-5 text-primary" />{title}</h1>
        <Button className="gap-1" onClick={() => { setEditId(null); setDlgOpen(true); }}>
          <Plus className="h-4 w-4" />{label} جديد
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "إجمالي السندات", value: kpi.total, icon: FileText, cls: "text-primary" },
          { label: "معتمدة", value: kpi.approved, icon: CheckCircle2, cls: "text-emerald-600" },
          { label: "موقّعة", value: kpi.withSig, icon: PenLine, cls: "text-blue-600" },
          { label: "غير مكتملة/تالفة", value: kpi.incomplete, icon: ClipboardList, cls: "text-amber-600" },
        ].map((c, i) => (
          <Card key={i}>
            <CardContent className="p-4 flex items-center justify-between">
              <div><div className="text-xs text-muted-foreground">{c.label}</div>
                <div className={`text-2xl font-bold ${c.cls}`}>{c.value}</div></div>
              <c.icon className={`h-7 w-7 opacity-40 ${c.cls}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">بحث وتصفية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div className="space-y-1 md:col-span-2"><Label className="text-xs">بحث</Label>
            <Input className="h-9 text-sm" placeholder="رقم السند / الجهة / الفاتورة / المستلِم" value={q}
              onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && load()} /></div>
          <div className="space-y-1"><Label className="text-xs">الحالة</Label>
            <Select value={status || "all"} onValueChange={v => setStatus(v === "all" ? "" : v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUS_OPTS.map(o => <SelectItem key={o.value || "all"} value={o.value || "all"}>{o.label}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label className="text-xs">من تاريخ</Label>
            <DateField className="h-9 text-sm" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label className="text-xs">إلى تاريخ</Label>
            <DateField className="h-9 text-sm" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div className="md:col-span-5 flex justify-end">
            <Button size="sm" className="gap-1" onClick={load}><Search className="h-4 w-4" />تطبيق</Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-16 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">لا توجد سندات.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-right">رقم السند</th>
                    <th className="p-3 text-right">التاريخ</th>
                    <th className="p-3 text-right">الجهة</th>
                    <th className="p-3 text-right">المستلِم</th>
                    <th className="p-3 text-right">الفاتورة</th>
                    <th className="p-3">الحالة</th>
                    <th className="p-3 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(d => (
                    <tr key={d.id} className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => { setEditId(d.id); setDlgOpen(true); }}>
                      <td className="p-3 font-medium" dir="ltr">{d.docNumber}</td>
                      <td className="p-3" dir="ltr">{d.docDate ? new Date(d.docDate).toLocaleDateString("en-GB") : "—"}</td>
                      <td className="p-3">{d.partyName || "—"}</td>
                      <td className="p-3">{d.recipientName || "—"}</td>
                      <td className="p-3" dir="ltr">{d.invoiceNumber || "—"}</td>
                      <td className="p-3 text-center">
                        {(d.status === "approved" || d.isApproved)
                          ? <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />معتمد</Badge>
                          : <Badge variant="outline">{STATUS_LABEL[d.status] ?? d.status}</Badge>}
                      </td>
                      <td className="p-3 text-center">
                        <button onClick={e => del(d.id, e)} className="text-destructive"><Trash2 className="h-4 w-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {dlgOpen && (
        <DeliveryReceiptDocDialog open={dlgOpen} onOpenChange={setDlgOpen} kind={kind} editId={editId} onSaved={load} />
      )}
    </div>
  );
}
