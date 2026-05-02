import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Search, FileText, X } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type InvItem = {
  id?: number; description: string; serviceCode: string;
  qty: string; unitPrice: string;
};
type Invoice = {
  id: number; docNumber: string;
  patientId: number; doctorId: number | null; appointmentId: number | null; hospitalId: number | null;
  totalAmount: string; insuranceCoverage: string; patientShare: string; paidAmount: string;
  status: string; issuedAt: string | null; notes: string | null;
};

const STATUSES = [
  ["draft","مسودة"], ["issued","صادرة"], ["partial","سداد جزئي"],
  ["paid","مدفوعة"], ["cancelled","ملغاة"],
] as const;

const EMPTY: {
  docNumber: string; patientId: string; doctorId: string;
  appointmentId: string; hospitalId: string;
  insuranceCoverage: string; patientShare: string; paidAmount: string;
  status: string; notes: string; items: InvItem[];
} = {
  docNumber:"", patientId:"", doctorId:"", appointmentId:"", hospitalId:"",
  insuranceCoverage:"0", patientShare:"0", paidAmount:"0",
  status:"draft", notes:"",
  items: [{ description:"كشف طبي", serviceCode:"", qty:"1", unitPrice:"0" }],
};

export default function HospitalInvoices() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Invoice | null>(null);

  const { data: rows = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ["hospital/invoices", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/invoices?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الفواتير");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: patients = [] } = useQuery<any[]>({
    queryKey: ["hospital/patients", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/patients?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });
  const { data: doctors = [] } = useQuery<any[]>({
    queryKey: ["hospital/doctors", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/doctors?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });
  const { data: hospitals = [] } = useQuery<any[]>({
    queryKey: ["hospital/hospitals", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/hospitals?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });
  const { data: appointments = [] } = useQuery<any[]>({
    queryKey: ["hospital/appointments", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/appointments?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const patientName = (id: number) => patients.find((p:any)=>p.id===id)?.fullNameAr || `#${id}`;
  const doctorName  = (id: number | null) =>
    id ? (doctors.find((d:any)=>d.id===id)?.nameAr || `#${id}`) : "—";

  const filtered = rows.filter(i => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      i.docNumber?.toLowerCase().includes(q) ||
      patientName(i.patientId).includes(search) ||
      doctorName(i.doctorId).includes(search)
    );
  });

  function openNew()  {
    setEditing(null);
    setForm(EMPTY);
    setShowForm(true);
  }

  async function loadInvoiceDetail(id: number) {
    const r = await fetch(`${API}/api/hospital/invoices/${id}?companyId=${cid}`, { headers });
    if (!r.ok) return null;
    return r.json();
  }

  async function openEdit(i: Invoice) {
    setEditing(i);
    const detail = await loadInvoiceDetail(i.id);
    setForm({
      docNumber: i.docNumber ?? "",
      patientId: String(i.patientId),
      doctorId:   i.doctorId ? String(i.doctorId) : "",
      appointmentId: i.appointmentId ? String(i.appointmentId) : "",
      hospitalId: i.hospitalId ? String(i.hospitalId) : "",
      insuranceCoverage: String(i.insuranceCoverage ?? "0"),
      patientShare: String(i.patientShare ?? "0"),
      paidAmount: String(i.paidAmount ?? "0"),
      status: i.status, notes: i.notes ?? "",
      items: detail?.items?.length ? detail.items.map((it: any) => ({
        description: it.description, serviceCode: it.serviceCode ?? "",
        qty: String(it.qty), unitPrice: String(it.unitPrice),
      })) : EMPTY.items,
    });
    setShowForm(true);
  }

  const computedTotal = form.items.reduce((s, it) =>
    s + Number(it.qty || 0) * Number(it.unitPrice || 0), 0);

  function setItem(idx: number, patch: Partial<InvItem>) {
    setForm(f => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, ...patch } : it) }));
  }
  function addItem()   { setForm(f => ({ ...f, items: [...f.items, { description:"", serviceCode:"", qty:"1", unitPrice:"0" }] })); }
  function delItem(i: number) { setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) })); }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.patientId) throw new Error("المريض مطلوب");
      if (form.items.length === 0) throw new Error("أضف بنداً واحداً على الأقل");
      const items = form.items.map(it => ({
        description: it.description, serviceCode: it.serviceCode || null,
        qty: Number(it.qty || 1), unitPrice: Number(it.unitPrice || 0),
      }));
      const totalAmount = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
      const body = { ...form, companyId: cid,
        patientId: Number(form.patientId),
        doctorId: form.doctorId ? Number(form.doctorId) : null,
        appointmentId: form.appointmentId ? Number(form.appointmentId) : null,
        hospitalId: form.hospitalId ? Number(form.hospitalId) : null,
        totalAmount,
        insuranceCoverage: Number(form.insuranceCoverage || 0),
        patientShare: Number(form.patientShare || 0) ||
          Math.max(0, totalAmount - Number(form.insuranceCoverage || 0)),
        paidAmount: Number(form.paidAmount || 0),
        items };
      const url = editing ? `${API}/api/hospital/invoices/${editing.id}` : `${API}/api/hospital/invoices`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/invoices", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hospital/invoices/${del.id}?companyId=${cid}`,
        { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/invoices", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const fmtSAR = (v: any) => Number(v || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
  const statusLabel = (s: string) => STATUSES.find(x => x[0] === s)?.[1] ?? s;
  const statusColor = (s: string) =>
    s === "paid"      ? "bg-emerald-100 text-emerald-800" :
    s === "issued"    ? "bg-sky-100 text-sky-800" :
    s === "partial"   ? "bg-amber-100 text-amber-800" :
    s === "cancelled" ? "bg-rose-100 text-rose-800" :
                        "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-amber-600" />
            الفواتير الطبية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">فواتير الخدمات الطبية وتغطية التأمين — {rows.length} فاتورة</p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-invoice" className="bg-amber-600 hover:bg-amber-700">
          <Plus className="h-4 w-4 ms-2" />فاتورة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم الفاتورة، المريض، الطبيب…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الفاتورة: ${editing.docNumber}` : "فاتورة جديدة"}
          subtitle={editing ? `الكود: ${editing.docNumber}` : "املأ بيانات الفاتورة — رقم المستند يُولَّد تلقائياً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>رقم الفاتورة</Label>
              <Input value={form.docNumber} onChange={(e)=>setForm({...form, docNumber:e.target.value})} placeholder="تلقائي HINV0001" /></div>
            <div><Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e)=>setForm({...form, status:e.target.value})}>
                {STATUSES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>المريض *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.patientId} onChange={(e)=>setForm({...form, patientId:e.target.value})} data-testid="select-patient">
                <option value="">— اختر المريض —</option>
                {patients.map((p:any) => <option key={p.id} value={p.id}>{p.fullNameAr} ({p.code})</option>)}
              </select></div>
            <div><Label>الطبيب</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.doctorId} onChange={(e)=>setForm({...form, doctorId:e.target.value})}>
                <option value="">— غير محدد —</option>
                {doctors.map((d:any) => <option key={d.id} value={d.id}>{d.nameAr}</option>)}
              </select></div>
            <div><Label>الموعد</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.appointmentId} onChange={(e)=>setForm({...form, appointmentId:e.target.value})}>
                <option value="">— غير مرتبط —</option>
                {appointments.map((a:any) => <option key={a.id} value={a.id}>{a.docNumber}</option>)}
              </select></div>
            <div><Label>المنشأة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.hospitalId} onChange={(e)=>setForm({...form, hospitalId:e.target.value})}>
                <option value="">— غير محدد —</option>
                {hospitals.map((h:any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select></div>

            <div className="md:col-span-2 mt-2 pt-3 border-t">
              <h3 className="text-sm font-semibold text-amber-700 mb-2">بنود الفاتورة (الخدمات الطبية)</h3>
              <div className="space-y-2">
                {form.items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-end p-2 border rounded-md bg-amber-50/30">
                    <div className="col-span-5"><Label className="text-xs">الوصف</Label>
                      <Input value={it.description} onChange={(e)=>setItem(idx, { description: e.target.value })} /></div>
                    <div className="col-span-2"><Label className="text-xs">كود الخدمة</Label>
                      <Input value={it.serviceCode} onChange={(e)=>setItem(idx, { serviceCode: e.target.value })} placeholder="LAB-CBC" /></div>
                    <div className="col-span-1"><Label className="text-xs">الكمية</Label>
                      <Input type="number" min={1} value={it.qty} onChange={(e)=>setItem(idx, { qty: e.target.value })} /></div>
                    <div className="col-span-2"><Label className="text-xs">السعر</Label>
                      <Input type="number" min={0} step="0.01" value={it.unitPrice} onChange={(e)=>setItem(idx, { unitPrice: e.target.value })} /></div>
                    <div className="col-span-1 text-xs font-mono pb-2 text-right">
                      {fmtSAR(Number(it.qty||0) * Number(it.unitPrice||0))}
                    </div>
                    <div className="col-span-1">
                      <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0 text-rose-600" onClick={()=>delItem(idx)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-3.5 w-3.5 ms-1" />إضافة بند
                </Button>
              </div>
              <div className="mt-3 flex justify-end font-semibold text-base">
                الإجمالي: <span className="font-mono ms-2 text-amber-700">{fmtSAR(computedTotal)} ر.س</span>
              </div>
            </div>

            <div><Label>تغطية التأمين (ر.س)</Label>
              <Input type="number" min={0} step="0.01" value={form.insuranceCoverage}
                onChange={(e)=>setForm({...form, insuranceCoverage:e.target.value})} /></div>
            <div><Label>حصة المريض (ر.س — احتسب تلقائياً إن تركته 0)</Label>
              <Input type="number" min={0} step="0.01" value={form.patientShare}
                onChange={(e)=>setForm({...form, patientShare:e.target.value})} /></div>
            <div><Label>المدفوع (ر.س)</Label>
              <Input type="number" min={0} step="0.01" value={form.paidAmount}
                onChange={(e)=>setForm({...form, paidAmount:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-amber-50 to-amber-100 text-amber-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الرقم</th>
                <th className="px-3 py-2 text-start font-semibold">المريض</th>
                <th className="px-3 py-2 text-start font-semibold">الطبيب</th>
                <th className="px-3 py-2 text-start font-semibold">الإجمالي</th>
                <th className="px-3 py-2 text-start font-semibold">تغطية التأمين</th>
                <th className="px-3 py-2 text-start font-semibold">حصة المريض</th>
                <th className="px-3 py-2 text-start font-semibold">المدفوع</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد فواتير</td></tr>}
              {filtered.map((i) => (
                <tr key={i.id} className="hover:bg-amber-50/40" data-testid={`row-invoice-${i.id}`}>
                  <td className="px-3 py-2 font-mono">{i.docNumber}</td>
                  <td className="px-3 py-2 font-semibold">{patientName(i.patientId)}</td>
                  <td className="px-3 py-2">{doctorName(i.doctorId)}</td>
                  <td className="px-3 py-2 font-mono">{fmtSAR(i.totalAmount)}</td>
                  <td className="px-3 py-2 font-mono text-emerald-700">{fmtSAR(i.insuranceCoverage)}</td>
                  <td className="px-3 py-2 font-mono text-amber-700">{fmtSAR(i.patientShare)}</td>
                  <td className="px-3 py-2 font-mono">{fmtSAR(i.paidAmount)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColor(i.status)}`}>
                      {statusLabel(i.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(i)} data-testid={`btn-edit-${i.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(i)} data-testid={`btn-delete-${i.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الفاتورة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف الفاتورة «{del?.docNumber}» نهائياً؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={()=>delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
