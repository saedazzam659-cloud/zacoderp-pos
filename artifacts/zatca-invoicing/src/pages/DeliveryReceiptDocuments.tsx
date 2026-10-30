// Standalone list + reports screen for goods receipt (استلام) / delivery
// (تسليم) documents. PURE archive — no GL/stock impact. Filter, search, view a
// KPI summary, and open any document (create/edit/print/share) via the shared
// dialog. Rendered by two routes (kind=receipt | delivery).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/ui/date-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import DeliveryReceiptDocDialog, { type DRKind } from "@/components/DeliveryReceiptDocDialog";
import {
  Plus, Search, Loader2, FileText, CheckCircle2, Trash2, PenLine, ClipboardList, Settings2, Save,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const DEFAULT_PRINT_OPTIONS = {
  showCompanyDetails: true, showBranch: true, showWarehouse: true, showInvoice: true,
  showRecipient: true, showLineNotes: true, showNotes: true, showSignature: true,
  termsAr: "", termsEn: "",
};

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
  const { token, user, setUser } = useAuth() as any;
  const { toast } = useToast();
  const companyId = user?.company?.id;
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
  const [printSettingsOpen, setPrintSettingsOpen] = useState(false);
  const [printSaving, setPrintSaving] = useState(false);
  const [printOptions, setPrintOptions] = useState({ ...DEFAULT_PRINT_OPTIONS });
  useEffect(() => {
    setPrintOptions({ ...DEFAULT_PRINT_OPTIONS, ...(user?.company?.deliveryReceiptPrintOptions ?? {}) });
  }, [companyId, user?.company?.deliveryReceiptPrintOptions]);

  async function savePrintOptions() {
    if (!companyId) return;
    setPrintSaving(true);
    try {
      const response = await fetch(`${API}/api/companies/${companyId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryReceiptPrintOptions: printOptions }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "تعذر حفظ الإعدادات");
      setUser?.((current: any) => current ? {
        ...current,
        company: { ...current.company, deliveryReceiptPrintOptions: data.deliveryReceiptPrintOptions ?? printOptions },
      } : current);
      toast({ title: "تم الحفظ", description: "تم تحديث نموذج الطباعة للشركة" });
      setPrintSettingsOpen(false);
    } catch (error: any) {
      toast({ title: "خطأ", description: error?.message ?? "تعذر حفظ الإعدادات", variant: "destructive" });
    } finally { setPrintSaving(false); }
  }

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

  if (dlgOpen) {
    return (
      <DeliveryReceiptDocDialog
        open onOpenChange={setDlgOpen} kind={kind} editId={editId} onSaved={load}
      />
    );
  }

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
        <div className="flex gap-2">
          {(user?.role === "admin" || user?.role === "superadmin") && companyId && (
            <Button variant="outline" className="gap-1" onClick={() => setPrintSettingsOpen(true)}>
              <Settings2 className="h-4 w-4" />إعدادات نموذج الطباعة
            </Button>
          )}
          <Button className="gap-1" onClick={() => { setEditId(null); setDlgOpen(true); }}>
            <Plus className="h-4 w-4" />{label} جديد
          </Button>
        </div>
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

      <Dialog open={printSettingsOpen} onOpenChange={setPrintSettingsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>إعدادات نموذج الاستلام والتسليم</DialogTitle>
            <DialogDescription>تُحفظ هذه الخيارات للشركة وتُستخدم عند طباعة السندين.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ["showCompanyDetails", "بيانات الشركة والشعار"],
              ["showBranch", "الفرع"],
              ["showWarehouse", "المخزن"],
              ["showInvoice", "الفاتورة المرتبطة"],
              ["showRecipient", "بيانات المستلِم"],
              ["showLineNotes", "ملاحظات الأصناف"],
              ["showNotes", "ملاحظات السند"],
              ["showSignature", "مربعات التوقيع"],
            ] as const).map(([key, text]) => (
              <label key={key} className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                <input type="checkbox" checked={printOptions[key]}
                  onChange={event => setPrintOptions(current => ({ ...current, [key]: event.target.checked }))} />
                {text}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <input type="checkbox" checked={!!(printOptions.termsAr || printOptions.termsEn)}
              onChange={event => {
                if (!event.target.checked) setPrintOptions(current => ({ ...current, termsAr: "", termsEn: "" }));
              }} />
            الشروط والأحكام
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2"><Label>الشروط بالعربية</Label>
              <Textarea maxLength={8000} rows={4} value={printOptions.termsAr}
                onChange={event => setPrintOptions(current => ({ ...current, termsAr: event.target.value }))} />
            </div>
            <div className="space-y-2"><Label>الشروط بالإنجليزية</Label>
              <Textarea maxLength={8000} rows={4} dir="ltr" value={printOptions.termsEn}
                onChange={event => setPrintOptions(current => ({ ...current, termsEn: event.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPrintSettingsOpen(false)}>إغلاق</Button>
            <Button type="button" onClick={savePrintOptions} disabled={printSaving}>
              {printSaving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}
              حفظ إعدادات الشركة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
