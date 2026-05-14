import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi, type FieldServiceTicket } from "@/lib/fieldServiceApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FormPanel } from "@/components/FormPanel";
import { useToast } from "@/hooks/use-toast";
import {
  Wrench, Plus, Search, Eye, AlertTriangle, CheckCircle2,
  ArrowRight, X,
} from "lucide-react";
import { Link } from "wouter";

const PRIORITIES = [
  ["urgent", "عاجل",  "bg-rose-100 text-rose-800"],
  ["high",   "مرتفع", "bg-orange-100 text-orange-800"],
  ["medium", "متوسط", "bg-amber-100 text-amber-800"],
  ["low",    "منخفض", "bg-slate-100 text-slate-700"],
] as const;

const STATUSES = [
  ["open",        "مفتوحة",     "bg-blue-100 text-blue-800"],
  ["assigned",    "مُسندة",     "bg-violet-100 text-violet-800"],
  ["in_progress", "قيد التنفيذ", "bg-amber-100 text-amber-800"],
  ["on_hold",     "معلّقة",     "bg-slate-100 text-slate-700"],
  ["resolved",    "محلولة",     "bg-emerald-100 text-emerald-800"],
  ["closed",      "مغلقة",      "bg-zinc-100 text-zinc-700"],
  ["cancelled",   "ملغاة",      "bg-rose-100 text-rose-800"],
] as const;

const CATEGORIES = [
  ["installation", "تركيب"],
  ["repair",       "إصلاح"],
  ["preventive",   "صيانة وقائية"],
  ["inspection",   "تفتيش"],
  ["complaint",    "شكوى"],
  ["other",        "أخرى"],
] as const;

const EMPTY_FORM = {
  title: "", description: "",
  category: "repair", priority: "medium",
  assetId: "",
};

export default function FieldServiceTickets() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [viewingId, setViewingId] = useState<number | null>(null);

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ["fsm-tickets"],
    queryFn: () => fieldApi.listTickets({}),
  });

  const { data: detail } = useQuery({
    queryKey: ["fsm-ticket", viewingId],
    queryFn: () => viewingId ? fieldApi.getTicket(viewingId) : Promise.resolve(null),
    enabled: !!viewingId,
  });

  const { data: assets } = useQuery<Array<{ id: number; code: string; nameAr: string; status: string }>>({
    queryKey: ["fsm-maint-assets"],
    queryFn: async () => {
      const session = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const r = await fetch("/api/maintenance/assets", {
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session}` } : {}),
          ...(acting ? { "x-acting-company-id": acting } : {}),
        },
      });
      return r.ok ? r.json() : [];
    },
  });

  const { data: employees } = useQuery<Array<{ id: number; nameAr: string }>>({
    queryKey: ["fsm-employees-all"],
    queryFn: async () => {
      const session = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const r = await fetch("/api/employees?status=active", {
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session}` } : {}),
          ...(acting ? { "x-acting-company-id": acting } : {}),
        },
      });
      return r.ok ? r.json() : [];
    },
  });

  const filtered = useMemo(() => {
    return (tickets ?? []).filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        t.ticketNo?.toLowerCase().includes(q) ||
        t.title?.toLowerCase().includes(q) ||
        t.customerName?.toLowerCase().includes(q) ||
        t.assignedToName?.toLowerCase().includes(q)
      );
    });
  }, [tickets, search, statusFilter]);

  const createMut = useMutation({
    mutationFn: async () => {
      if (!form.title.trim()) throw new Error("العنوان مطلوب");
      return fieldApi.createTicket({
        title: form.title.trim(),
        description: form.description || null,
        category: form.category,
        priority: form.priority as any,
        assetId: form.assetId ? Number(form.assetId) : null,
      } as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      toast({ title: "تم إنشاء التذكرة" });
      setShowForm(false); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const assignMut = useMutation({
    mutationFn: ({ id, employeeId }: { id: number; employeeId: number }) => fieldApi.assignTicket(id, employeeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الإسناد" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution?: string }) => fieldApi.resolveTicket(id, resolution),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الحل" });
    },
  });

  const closeMut = useMutation({
    mutationFn: ({ id, rating }: { id: number; rating?: number }) => fieldApi.closeTicket(id, rating),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الإغلاق" });
      setViewingId(null);
    },
  });

  const convertMut = useMutation({
    mutationFn: (id: number) => fieldApi.convertTicketToMaintenanceOrder(id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({
        title: data.alreadyExisted ? "أمر الصيانة موجود مسبقاً" : "تم إنشاء أمر الصيانة",
        description: `رقم الأمر: ${data.order.docNumber}`,
      });
    },
    onError: (e: any) => toast({ title: "تعذّر التحويل", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 p-4" dir="rtl" data-testid="page-field-tickets">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wrench className="h-6 w-6 text-emerald-600" />
            تذاكر الخدمة الميدانية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            طلبات صيانة وفنية مع SLA — مطابقة لمعايير ITIL/FSM — {tickets.length} تذكرة
          </p>
        </div>
        <Button onClick={() => { setForm(EMPTY_FORM); setShowForm(true); }} data-testid="btn-new-ticket">
          <Plus className="h-4 w-4 ms-2" /> تذكرة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم، العنوان، العميل، المُسند…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="select-status-filter">
          <option value="">جميع الحالات</option>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} من {tickets.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={Plus}
          title="تذكرة خدمة جديدة"
          subtitle="املأ بيانات التذكرة — سيُحسب SLA تلقائياً حسب الأولوية"
          width="3xl"
          onClose={() => setShowForm(false)}
          onSave={() => createMut.mutate()}
          saving={createMut.isPending}
          saveLabel="إنشاء" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label>العنوان *</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="input-title" />
            </div>
            <div className="md:col-span-2">
              <Label>الوصف</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
            </div>
            <div>
              <Label>الفئة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>الأولوية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>الأصل (موديل الصيانة)</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })}>
                <option value="">— بدون أصل —</option>
                {(assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">ربط التذكرة بأصل يتيح تحويلها لأمر صيانة لاحقاً</p>
            </div>
            <div className="md:col-span-2 text-xs text-muted-foreground bg-muted/30 rounded p-2">
              SLA افتراضي: عاجل 30/240 د • مرتفع 60/480 د • متوسط 4/24 س • منخفض 8/72 س
            </div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم التذكرة</th>
                <th className="px-3 py-2 text-start font-semibold">العنوان</th>
                <th className="px-3 py-2 text-start font-semibold">الفئة</th>
                <th className="px-3 py-2 text-start font-semibold">العميل</th>
                <th className="px-3 py-2 text-start font-semibold">المُسند إليه</th>
                <th className="px-3 py-2 text-start font-semibold">الأولوية</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-start font-semibold">SLA</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد تذاكر</td></tr>
              )}
              {filtered.map((t) => {
                const pr = PRIORITIES.find(([v]) => v === t.priority);
                const st = STATUSES.find(([v]) => v === t.status);
                const cat = CATEGORIES.find(([v]) => v === t.category);
                const breached = t.slaResponseBreached || t.slaResolutionBreached;
                return (
                  <tr key={t.id} className="hover:bg-emerald-50/40" data-testid={`row-ticket-${t.id}`}>
                    <td className="px-3 py-2 font-mono font-bold">{t.ticketNo}</td>
                    <td className="px-3 py-2 max-w-[220px] truncate" title={t.title}>{t.title}</td>
                    <td className="px-3 py-2">{cat?.[1] ?? t.category}</td>
                    <td className="px-3 py-2">{t.customerName ?? "—"}</td>
                    <td className="px-3 py-2">{t.assignedToName ?? "—"}</td>
                    <td className="px-3 py-2">
                      {pr && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${pr[2]}`}>{pr[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {st && <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${st[2]}`}>{st[1]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {breached ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-100 text-rose-800">
                          <AlertTriangle className="h-3 w-3" /> خرق
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800">
                          <CheckCircle2 className="h-3 w-3" /> ضمن SLA
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => setViewingId(t.id)} data-testid={`btn-view-${t.id}`} title="عرض">
                          <Eye className="h-3.5 w-3.5" />
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

      {/* Detail viewer */}
      {viewingId && detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewingId(null)}>
          <div className="bg-white rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-l from-emerald-600 to-emerald-700 text-white p-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Wrench className="h-5 w-5" />
                  {detail.ticketNo} — {detail.title}
                </h2>
                <p className="text-sm opacity-90 mt-1">
                  {STATUSES.find(s => s[0] === detail.status)?.[1] ?? detail.status}
                  {detail.customerName ? ` — ${detail.customerName}` : ""}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setViewingId(null)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="p-4 space-y-4 text-sm">
              <div className="flex flex-wrap gap-2">
                {(() => {
                  const pr = PRIORITIES.find(([v]) => v === detail.priority);
                  return pr ? <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${pr[2]}`}>{pr[1]}</span> : null;
                })()}
                {detail.slaResponseBreached && <Badge variant="destructive">خرق استجابة</Badge>}
                {detail.slaResolutionBreached && <Badge variant="destructive">خرق حل</Badge>}
              </div>

              {detail.description && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">الوصف</div>
                  <p className="text-muted-foreground whitespace-pre-wrap">{detail.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><div className="text-muted-foreground">المُسند إليه</div><div className="font-medium">{detail.assignedToName ?? "—"}</div></div>
                <div><div className="text-muted-foreground">العميل</div><div className="font-medium">{detail.customerName ?? "—"}</div></div>
                <div><div className="text-muted-foreground">SLA استجابة</div><div className="tabular-nums">{detail.slaResponseMin} د</div></div>
                <div><div className="text-muted-foreground">SLA حل</div><div className="tabular-nums">{detail.slaResolutionMin} د</div></div>
                <div><div className="text-muted-foreground">فُتحت</div><div>{new Date(detail.openedAt).toLocaleString("ar-SA")}</div></div>
                {detail.respondedAt && <div><div className="text-muted-foreground">رُد عليها</div><div>{new Date(detail.respondedAt).toLocaleString("ar-SA")}</div></div>}
                {detail.resolvedAt && <div><div className="text-muted-foreground">حُلّت</div><div>{new Date(detail.resolvedAt).toLocaleString("ar-SA")}</div></div>}
              </div>

              {/* Assign */}
              {(detail.status === "open" || detail.status === "assigned") && (
                <div className="border-t pt-3">
                  <Label>إسناد إلى موظف</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm mt-1"
                    defaultValue=""
                    onChange={(e) => e.target.value && assignMut.mutate({ id: detail.id, employeeId: Number(e.target.value) })}>
                    <option value="">{detail.assignedToName ?? "اختر فني"}</option>
                    {(employees ?? []).map((emp) => <option key={emp.id} value={emp.id}>{emp.nameAr}</option>)}
                  </select>
                </div>
              )}

              {/* Linked visits */}
              {detail.visits && detail.visits.length > 0 && (
                <div className="border-t pt-3">
                  <h4 className="font-semibold mb-2">الزيارات المرتبطة</h4>
                  <div className="space-y-1">
                    {detail.visits.map((v) => (
                      <div key={v.id} className="flex items-center gap-2 text-xs border-b py-1">
                        <Badge variant="outline">{v.status}</Badge>
                        <span className="flex-1">{new Date(v.arrivedAt).toLocaleString("ar-SA")}</span>
                        {v.durationMin && <span className="text-muted-foreground">{v.durationMin} د</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Maintenance asset */}
              {detail.assetId && (
                <div className="border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs">
                      <span className="text-muted-foreground">الأصل المرتبط: </span>
                      <span className="font-mono">{assets?.find(a => a.id === detail.assetId)?.code ?? `#${detail.assetId}`}</span>
                      {" — "}
                      {assets?.find(a => a.id === detail.assetId)?.nameAr ?? ""}
                    </div>
                    <Link href="/maintenance/assets">
                      <Button size="sm" variant="ghost" className="text-xs">
                        فتح في الصيانة <ArrowRight className="h-3 w-3 ms-1" />
                      </Button>
                    </Link>
                  </div>
                  <Button size="sm" variant="outline" className="mt-2"
                    onClick={() => convertMut.mutate(detail.id)} disabled={convertMut.isPending}>
                    <Wrench className="h-4 w-4 ms-2" /> تحويل لأمر صيانة
                  </Button>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 border-t pt-3 flex-wrap">
                {detail.status !== "resolved" && detail.status !== "closed" && (
                  <Button size="sm" onClick={() => {
                    const r = prompt("ما الحل المُطبَّق؟") || undefined;
                    resolveMut.mutate({ id: detail.id, resolution: r });
                  }}>
                    <CheckCircle2 className="h-4 w-4 ms-2" /> وضع كمحلولة
                  </Button>
                )}
                {detail.status === "resolved" && (
                  <Button size="sm" variant="outline" onClick={() => {
                    const r = prompt("تقييم العميل (1-5)؟");
                    const n = r ? Number(r) : undefined;
                    closeMut.mutate({ id: detail.id, rating: n && n >= 1 && n <= 5 ? n : undefined });
                  }}>
                    إغلاق التذكرة
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
