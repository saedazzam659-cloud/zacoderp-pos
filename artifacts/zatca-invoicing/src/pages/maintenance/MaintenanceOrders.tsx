import { useState, useEffect } from "react";
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
import { Plus, Pencil, Trash2, Search, ClipboardList, Eye, X, Wrench, Calendar, User, ChevronLeft } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Order = {
  id: number; docNumber: string; assetId: number; technicianId: number | null;
  orderType: string; priority: string; status: string;
  reportedDate: string; scheduledDate: string | null; startDate: string | null; completionDate: string | null;
  problemDescription: string; diagnosis: string | null; workPerformed: string | null;
  laborHours: string; laborCost: string; partsCost: string; totalCost: string;
  reportedBy: string | null; notes: string | null; branchId: number | null;
  assetCode?: string; assetName?: string; techName?: string;
};

type Part = { id: number; itemId: number; quantity: string; unitCost: string; total: string; itemCode?: string; itemName?: string; notes?: string | null };

const TYPES = [
  ["preventive", "وقائية", "bg-blue-100 text-blue-800"],
  ["corrective", "تصحيحية", "bg-amber-100 text-amber-800"],
  ["emergency", "طارئة", "bg-rose-100 text-rose-800"],
  ["inspection", "فحص", "bg-slate-100 text-slate-700"],
] as const;

const PRIORITIES = [
  ["low", "منخفضة", "bg-slate-100 text-slate-700"],
  ["medium", "متوسطة", "bg-blue-100 text-blue-800"],
  ["high", "عالية", "bg-orange-100 text-orange-800"],
  ["urgent", "عاجلة", "bg-rose-100 text-rose-800"],
] as const;

const STATUSES = [
  ["draft", "مسودة", "bg-slate-100 text-slate-700"],
  ["scheduled", "مجدول", "bg-blue-100 text-blue-800"],
  ["in_progress", "قيد التنفيذ", "bg-amber-100 text-amber-800"],
  ["completed", "مكتمل", "bg-emerald-100 text-emerald-800"],
  ["cancelled", "ملغي", "bg-rose-100 text-rose-800"],
] as const;

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM = {
  docNumber: "", assetId: "", technicianId: "",
  orderType: "corrective", priority: "medium", status: "draft",
  reportedDate: today(), scheduledDate: "", startDate: "", completionDate: "",
  problemDescription: "", diagnosis: "", workPerformed: "",
  laborHours: "0", laborCost: "0",
  reportedBy: "", branchId: "", notes: "",
};

export default function MaintenanceOrders() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<Order | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [del, setDel] = useState<Order | null>(null);
  const [viewing, setViewing] = useState<Order | null>(null);

  const { data: orders = [], isLoading } = useQuery<Order[]>({
    queryKey: ["maintenance/orders", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/orders?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الأوامر");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: assets = [] } = useQuery<any[]>({
    queryKey: ["maintenance/assets", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/assets?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 30_000,
  });

  const { data: techs = [] } = useQuery<any[]>({
    queryKey: ["maintenance/technicians", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/technicians?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 30_000,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  // ─── Detail viewer (parts) ────────────────────────────────────────────
  const { data: detail } = useQuery<Order & { parts: Part[] }>({
    queryKey: ["maintenance/orders", viewing?.id, cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/maintenance/orders/${viewing!.id}?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل التفاصيل");
      return r.json();
    },
    enabled: !!viewing && !!cid,
  });

  const { data: items = [] } = useQuery<any[]>({
    queryKey: ["items", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/items?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid && !!viewing, staleTime: 60_000,
  });

  const [partForm, setPartForm] = useState({ itemId: "", quantity: "1", unitCost: "0", notes: "" });
  const addPartMut = useMutation({
    mutationFn: async () => {
      if (!viewing || !partForm.itemId) throw new Error("اختر الصنف");
      const r = await fetch(`${API}/api/maintenance/orders/${viewing.id}/parts?companyId=${cid}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, itemId: Number(partForm.itemId),
          quantity: Number(partForm.quantity) || 1, unitCost: Number(partForm.unitCost) || 0, notes: partForm.notes || null }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الإضافة"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/orders", viewing?.id, cid] });
      qc.invalidateQueries({ queryKey: ["maintenance/orders", cid] });
      setPartForm({ itemId: "", quantity: "1", unitCost: "0", notes: "" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });
  const removePartMut = useMutation({
    mutationFn: async (pid: number) => {
      if (!viewing) return;
      const r = await fetch(`${API}/api/maintenance/orders/${viewing.id}/parts/${pid}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("تعذّر الحذف");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/orders", viewing?.id, cid] });
      qc.invalidateQueries({ queryKey: ["maintenance/orders", cid] });
    },
  });

  // ─── Filters ─────────────────────────────────────────────────────────
  const filtered = orders.filter(o => {
    if (statusFilter && o.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      o.docNumber?.toLowerCase().includes(q) || o.assetName?.includes(search) ||
      o.assetCode?.toLowerCase().includes(q) || o.techName?.includes(search) ||
      o.problemDescription?.includes(search)
    );
  });

  function openNew() { setEditing(null); setForm({ ...EMPTY_FORM, reportedDate: today() }); setShowForm(true); }
  function openEdit(o: Order) {
    setEditing(o);
    setForm({
      docNumber: o.docNumber ?? "", assetId: String(o.assetId), technicianId: o.technicianId ? String(o.technicianId) : "",
      orderType: o.orderType, priority: o.priority, status: o.status,
      reportedDate: o.reportedDate ?? today(),
      scheduledDate: o.scheduledDate ?? "", startDate: o.startDate ?? "", completionDate: o.completionDate ?? "",
      problemDescription: o.problemDescription ?? "", diagnosis: o.diagnosis ?? "", workPerformed: o.workPerformed ?? "",
      laborHours: String(o.laborHours ?? "0"), laborCost: String(o.laborCost ?? "0"),
      reportedBy: o.reportedBy ?? "", branchId: o.branchId ? String(o.branchId) : "", notes: o.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.assetId) throw new Error("الأصل مطلوب");
      if (!form.problemDescription.trim()) throw new Error("وصف المشكلة مطلوب");
      const body = { ...form, companyId: cid,
        assetId: Number(form.assetId),
        technicianId: form.technicianId ? Number(form.technicianId) : null,
        branchId: form.branchId ? Number(form.branchId) : null,
        laborHours: Number(form.laborHours) || 0,
        laborCost: Number(form.laborCost) || 0,
      };
      const url = editing ? `${API}/api/maintenance/orders/${editing.id}` : `${API}/api/maintenance/orders`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/orders", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/maintenance/orders/${del.id}?companyId=${cid}`, { method: "DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance/orders", cid] });
      toast({ title: "تم الحذف" }); setDel(null);
    },
    onError: (e: any) => { toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-emerald-600" />
            أوامر الصيانة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            متابعة أوامر الصيانة وتكاليفها — {orders.length} أمر
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-order">
          <Plus className="h-4 w-4 ms-2" />
          أمر صيانة جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم الأمر، الأصل، الفني، المشكلة…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="select-status-filter">
          <option value="">جميع الحالات</option>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} من {orders.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل أمر الصيانة: ${editing.docNumber}` : "أمر صيانة جديد"}
          subtitle={editing ? `الحالة: ${STATUSES.find(s => s[0] === editing.status)?.[1]}` : "املأ بيانات أمر الصيانة — رقم الأمر يُولَّد تلقائياً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>رقم الأمر</Label>
              <Input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} placeholder="تلقائي MO0001" data-testid="input-docNumber" />
            </div>
            <div>
              <Label>الأصل *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })} data-testid="select-asset">
                <option value="">— اختر الأصل —</option>
                {assets.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>الفني المسؤول</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.technicianId} onChange={(e) => setForm({ ...form, technicianId: e.target.value })} data-testid="select-tech">
                <option value="">— لم يُعيَّن —</option>
                {techs.filter((t: any) => t.isActive).map((t: any) => <option key={t.id} value={t.id}>{t.code} — {t.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>نوع الصيانة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.orderType} onChange={(e) => setForm({ ...form, orderType: e.target.value })}>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الأولوية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} data-testid="select-status">
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>تاريخ البلاغ *</Label>
              <DateField value={form.reportedDate} onChange={(e) => setForm({ ...form, reportedDate: e.target.value })} data-testid="input-reportedDate" />
            </div>
            <div>
              <Label>تاريخ الجدولة</Label>
              <DateField value={form.scheduledDate} onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })} />
            </div>
            <div>
              <Label>تاريخ البدء</Label>
              <DateField value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div>
              <Label>تاريخ الإنجاز</Label>
              <DateField value={form.completionDate} onChange={(e) => setForm({ ...form, completionDate: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <Label>وصف المشكلة *</Label>
              <textarea className="w-full min-h-[60px] px-3 py-2 rounded-md border border-input bg-background text-sm"
                value={form.problemDescription} onChange={(e) => setForm({ ...form, problemDescription: e.target.value })} data-testid="input-problem" />
            </div>
            <div className="md:col-span-2">
              <Label>التشخيص</Label>
              <textarea className="w-full min-h-[60px] px-3 py-2 rounded-md border border-input bg-background text-sm"
                value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <Label>العمل المُنجَز</Label>
              <textarea className="w-full min-h-[60px] px-3 py-2 rounded-md border border-input bg-background text-sm"
                value={form.workPerformed} onChange={(e) => setForm({ ...form, workPerformed: e.target.value })} />
            </div>
            <div>
              <Label>ساعات العمل</Label>
              <Input type="number" step="0.25" min="0" value={form.laborHours}
                onChange={(e) => setForm({ ...form, laborHours: e.target.value })} data-testid="input-laborHours" />
            </div>
            <div>
              <Label>تكلفة العمالة (ر.س)</Label>
              <Input type="number" step="0.01" min="0" value={form.laborCost}
                onChange={(e) => setForm({ ...form, laborCost: e.target.value })} data-testid="input-laborCost" />
            </div>
            <div>
              <Label>المُبلِّغ</Label>
              <Input value={form.reportedBy} onChange={(e) => setForm({ ...form, reportedBy: e.target.value })} />
            </div>
            <div>
              <Label>الفرع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                <option value="">— اختر الفرع —</option>
                {branches.map((b: any) => <option key={b.id} value={b.id}>{b.nameAr || b.nameEn}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
        </FormPanel>
      )}

      {/* ─────── MOBILE CARDS (visible < md only) ─────── */}
      <div className="md:hidden space-y-3" data-testid="mobile-cards-orders">
        {isLoading && (
          <div className="text-center py-8 text-muted-foreground bg-white rounded-lg border">
            جاري التحميل…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-10 text-muted-foreground bg-white rounded-lg border">
            <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
            لا توجد أوامر صيانة
          </div>
        )}
        {filtered.map((o) => {
          const tp = TYPES.find(([v]) => v === o.orderType);
          const pr = PRIORITIES.find(([v]) => v === o.priority);
          const st = STATUSES.find(([v]) => v === o.status);
          return (
            <div
              key={o.id}
              className="bg-white rounded-xl border border-emerald-100 shadow-sm overflow-hidden active:scale-[0.99] transition-transform"
              data-testid={`mobile-card-order-${o.id}`}
            >
              {/* Header strip */}
              <div className="bg-gradient-to-l from-emerald-50 to-emerald-100/50 px-4 py-2.5 flex items-center justify-between border-b border-emerald-100">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-emerald-700" />
                  <span className="font-mono font-bold text-sm text-emerald-900">{o.docNumber}</span>
                </div>
                {st && (
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold ${st[2]}`}>
                    {st[1]}
                  </span>
                )}
              </div>
              {/* Body */}
              <button
                type="button"
                onClick={() => setViewing(o)}
                className="w-full text-start px-4 py-3 space-y-2"
                data-testid={`mobile-open-order-${o.id}`}
              >
                <div className="font-bold text-sm text-slate-900 leading-tight">
                  {o.assetName || `أصل #${o.assetId}`}
                </div>
                {o.assetCode && (
                  <div className="text-[11px] text-muted-foreground font-mono">{o.assetCode}</div>
                )}
                <div className="flex items-center gap-3 text-[11px] text-slate-600 flex-wrap">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> {o.reportedDate}
                  </span>
                  {o.techName && (
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" /> {o.techName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {tp && <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${tp[2]}`}>{tp[1]}</span>}
                  {pr && <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${pr[2]}`}>{pr[1]}</span>}
                </div>
                <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
                  <span className="text-[11px] text-muted-foreground">الإجمالي</span>
                  <span className="font-bold tabular-nums text-emerald-700">
                    {Number(o.totalCost).toFixed(2)} <span className="text-[10px] text-muted-foreground">ر.س</span>
                  </span>
                </div>
              </button>
              {/* Action bar */}
              <div className="border-t border-slate-100 bg-slate-50/60 grid grid-cols-3 divide-x divide-slate-100 [direction:ltr]">
                <button
                  type="button"
                  onClick={() => setDel(o)}
                  className="py-2.5 text-rose-600 hover:bg-rose-50 active:bg-rose-100 flex items-center justify-center gap-1 text-xs"
                  data-testid={`mobile-btn-delete-${o.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> حذف
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(o)}
                  className="py-2.5 text-slate-700 hover:bg-slate-100 active:bg-slate-200 flex items-center justify-center gap-1 text-xs"
                  data-testid={`mobile-btn-edit-${o.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" /> تعديل
                </button>
                <button
                  type="button"
                  onClick={() => setViewing(o)}
                  className="py-2.5 text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100 flex items-center justify-center gap-1 text-xs font-medium"
                  data-testid={`mobile-btn-view-${o.id}`}
                >
                  <Eye className="h-3.5 w-3.5" /> عرض
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─────── DESKTOP TABLE (visible md+ only) ─────── */}
      <div className="hidden md:block border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم الأمر</th>
                <th className="px-3 py-2 text-start font-semibold">تاريخ البلاغ</th>
                <th className="px-3 py-2 text-start font-semibold">الأصل</th>
                <th className="px-3 py-2 text-start font-semibold">الفني</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">الأولوية</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-start font-semibold">الإجمالي</th>
                <th className="px-3 py-2 text-center font-semibold w-32">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد أوامر صيانة</td></tr>}
              {filtered.map((o) => {
                const tp = TYPES.find(([v]) => v === o.orderType);
                const pr = PRIORITIES.find(([v]) => v === o.priority);
                const st = STATUSES.find(([v]) => v === o.status);
                return (
                  <tr key={o.id} className="hover:bg-emerald-50/40" data-testid={`row-order-${o.id}`}>
                    <td className="px-3 py-2 font-mono font-bold">{o.docNumber}</td>
                    <td className="px-3 py-2">{o.reportedDate}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold">{o.assetName || `#${o.assetId}`}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{o.assetCode}</div>
                    </td>
                    <td className="px-3 py-2">{o.techName || "—"}</td>
                    <td className="px-3 py-2">
                      {tp && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${tp[2]}`}>{tp[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {pr && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${pr[2]}`}>{pr[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2 font-bold tabular-nums">{Number(o.totalCost).toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700 hover:bg-emerald-50" onClick={() => setViewing(o)} data-testid={`btn-view-${o.id}`}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(o)} data-testid={`btn-edit-${o.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(o)} data-testid={`btn-delete-${o.id}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail / parts panel */}
      {viewing && detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="bg-white rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-l from-emerald-600 to-emerald-700 text-white p-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <ClipboardList className="h-5 w-5" />
                  أمر الصيانة {detail.docNumber}
                </h2>
                <p className="text-sm opacity-90 mt-1">{detail.assetName} — {STATUSES.find(s => s[0] === detail.status)?.[1]}</p>
              </div>
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setViewing(null)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div className="bg-slate-50 rounded p-2"><div className="text-muted-foreground">تاريخ البلاغ</div><div className="font-semibold">{detail.reportedDate}</div></div>
                <div className="bg-slate-50 rounded p-2"><div className="text-muted-foreground">تاريخ الإنجاز</div><div className="font-semibold">{detail.completionDate || "—"}</div></div>
                <div className="bg-slate-50 rounded p-2"><div className="text-muted-foreground">العمالة</div><div className="font-semibold">{Number(detail.laborCost).toFixed(2)} ر.س</div></div>
                <div className="bg-slate-50 rounded p-2"><div className="text-muted-foreground">الإجمالي</div><div className="font-bold text-emerald-700">{Number(detail.totalCost).toFixed(2)} ر.س</div></div>
              </div>
              {detail.problemDescription && (
                <div>
                  <Label className="text-xs">المشكلة</Label>
                  <p className="text-sm bg-rose-50 border border-rose-200 rounded p-2 mt-1">{detail.problemDescription}</p>
                </div>
              )}
              {detail.workPerformed && (
                <div>
                  <Label className="text-xs">العمل المُنجَز</Label>
                  <p className="text-sm bg-emerald-50 border border-emerald-200 rounded p-2 mt-1">{detail.workPerformed}</p>
                </div>
              )}

              <div>
                <Label className="text-sm font-semibold flex items-center justify-between">
                  <span>قطع الغيار المستخدمة</span>
                  <span className="text-xs font-normal text-muted-foreground">إجمالي القطع: {Number(detail.partsCost).toFixed(2)} ر.س</span>
                </Label>
                <div className="mt-2 border rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-100">
                      <tr>
                        <th className="px-2 py-1.5 text-start">الصنف</th>
                        <th className="px-2 py-1.5 text-start">الكمية</th>
                        <th className="px-2 py-1.5 text-start">سعر الوحدة</th>
                        <th className="px-2 py-1.5 text-start">الإجمالي</th>
                        <th className="w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(!detail.parts || detail.parts.length === 0) && (
                        <tr><td colSpan={5} className="text-center py-3 text-muted-foreground">لا توجد قطع غيار</td></tr>
                      )}
                      {detail.parts?.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50">
                          <td className="px-2 py-1.5">
                            <div className="font-semibold">{p.itemName || `#${p.itemId}`}</div>
                            <div className="text-[10px] font-mono text-muted-foreground">{p.itemCode}</div>
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">{Number(p.quantity).toFixed(2)}</td>
                          <td className="px-2 py-1.5 tabular-nums">{Number(p.unitCost).toFixed(2)}</td>
                          <td className="px-2 py-1.5 tabular-nums font-semibold">{Number(p.total).toFixed(2)}</td>
                          <td className="px-2 py-1.5">
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-rose-600" onClick={() => removePartMut.mutate(p.id)} data-testid={`btn-remove-part-${p.id}`}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-2 grid grid-cols-1 md:grid-cols-5 gap-2 items-end bg-slate-50 p-2 rounded">
                  <div className="md:col-span-2">
                    <Label className="text-xs">الصنف</Label>
                    <select className="w-full h-9 px-2 rounded border border-input bg-white text-xs"
                      value={partForm.itemId} onChange={(e) => setPartForm({ ...partForm, itemId: e.target.value })} data-testid="select-part-item">
                      <option value="">— اختر صنف —</option>
                      {items.map((i: any) => <option key={i.id} value={i.id}>{i.sku} — {i.nameAr}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">الكمية</Label>
                    <Input type="number" step="0.01" min="0" className="h-9 text-xs"
                      value={partForm.quantity} onChange={(e) => setPartForm({ ...partForm, quantity: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">سعر الوحدة</Label>
                    <Input type="number" step="0.01" min="0" className="h-9 text-xs"
                      value={partForm.unitCost} onChange={(e) => setPartForm({ ...partForm, unitCost: e.target.value })} />
                  </div>
                  <Button onClick={() => addPartMut.mutate()} disabled={addPartMut.isPending || !partForm.itemId} size="sm" className="h-9" data-testid="btn-add-part">
                    <Plus className="h-3.5 w-3.5 ms-1" />
                    إضافة
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف أمر الصيانة</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الأمر «{del?.docNumber}» نهائياً؟ سيتم حذف قطع الغيار المرتبطة أيضاً.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─────── MOBILE FAB (floating action button) ─────── */}
      <button
        type="button"
        onClick={openNew}
        className="md:hidden fixed bottom-6 end-6 z-40 group"
        data-testid="mobile-fab-new-order"
        aria-label="أمر صيانة جديد"
      >
        <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-30 group-active:opacity-0 animate-ping" />
        <span className="relative flex items-center justify-center h-14 w-14 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-lg shadow-emerald-500/40 ring-4 ring-white active:scale-95 transition-transform">
          <Plus className="h-7 w-7" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
