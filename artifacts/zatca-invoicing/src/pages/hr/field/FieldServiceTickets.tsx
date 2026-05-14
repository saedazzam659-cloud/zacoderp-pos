import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi, type FieldServiceTicket } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Wrench, Plus, AlertTriangle, CheckCircle2, Clock, UserCheck, ArrowRight } from "lucide-react";
import { Link } from "wouter";

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "bg-rose-500", high: "bg-orange-500", medium: "bg-amber-500", low: "bg-zinc-500",
};
const PRIORITY_LABEL: Record<string, string> = {
  urgent: "عاجل", high: "مرتفع", medium: "متوسط", low: "منخفض",
};
const STATUS_LABEL: Record<string, string> = {
  open: "مفتوحة", assigned: "مُسندة", in_progress: "قيد التنفيذ",
  on_hold: "معلّقة", resolved: "محلولة", closed: "مغلقة", cancelled: "ملغاة",
};
const CATEGORIES = [
  { v: "installation", l: "تركيب" },
  { v: "repair",       l: "إصلاح" },
  { v: "preventive",   l: "صيانة وقائية" },
  { v: "inspection",   l: "تفتيش" },
  { v: "complaint",    l: "شكوى" },
  { v: "other",        l: "أخرى" },
];

export default function FieldServiceTickets() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [form, setForm] = useState<Partial<FieldServiceTicket>>({ priority: "medium", category: "repair" });

  const { data, isLoading } = useQuery({
    queryKey: ["fsm-tickets", filter],
    queryFn: () => fieldApi.listTickets({ status: filter || undefined }),
  });

  const { data: detail } = useQuery({
    queryKey: ["fsm-ticket", detailId],
    queryFn: () => detailId ? fieldApi.getTicket(detailId) : Promise.resolve(null),
    enabled: !!detailId,
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

  const convert = useMutation({
    mutationFn: (id: number) => fieldApi.convertTicketToMaintenanceOrder(id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({
        title: data.alreadyExisted ? "أمر الصيانة موجود مسبقاً" : "تم إنشاء أمر الصيانة",
        description: `رقم الأمر: ${data.order.docNumber}`,
      });
    },
    onError: (e: any) => toast({ title: "تعذّر التحويل", description: e.message, variant: "destructive" }),
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

  const create = useMutation({
    mutationFn: (b: any) => fieldApi.createTicket(b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      setCreateOpen(false); setForm({ priority: "medium", category: "repair" });
      toast({ title: "تم إنشاء التذكرة" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const assign = useMutation({
    mutationFn: ({ id, employeeId }: { id: number; employeeId: number }) => fieldApi.assignTicket(id, employeeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الإسناد" });
    },
  });

  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution?: string }) => fieldApi.resolveTicket(id, resolution),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الحل" });
    },
  });

  const close = useMutation({
    mutationFn: ({ id, rating }: { id: number; rating?: number }) => fieldApi.closeTicket(id, rating),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fsm-tickets"] });
      qc.invalidateQueries({ queryKey: ["fsm-ticket"] });
      toast({ title: "تم الإغلاق" });
      setDetailId(null);
    },
  });

  return (
    <div className="p-6 space-y-4" dir="rtl" data-testid="page-field-tickets">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wrench className="h-6 w-6" /> تذاكر الخدمة الميدانية</h1>
          <p className="text-sm text-muted-foreground mt-1">طلبات صيانة وفنية مع SLA — مطابقة لمعايير ITIL/FSM</p>
        </div>
        <div className="flex gap-2">
          <Select value={filter || "all"} onValueChange={(v) => setFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-40"><SelectValue placeholder="كل الحالات" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الحالات</SelectItem>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 ms-2" /> تذكرة جديدة</Button>
        </div>
      </div>

      {isLoading ? <div className="text-center text-muted-foreground py-8">جاري التحميل...</div> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-right p-2">رقم</th>
                <th className="text-right p-2">العنوان</th>
                <th className="text-right p-2">العميل</th>
                <th className="text-right p-2">المُسند إليه</th>
                <th className="text-right p-2">الأولوية</th>
                <th className="text-right p-2">الحالة</th>
                <th className="text-right p-2">SLA</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((t) => (
                <tr key={t.id} className="border-t hover:bg-muted/30 cursor-pointer" onClick={() => setDetailId(t.id)}>
                  <td className="p-2 font-mono text-xs">{t.ticketNo}</td>
                  <td className="p-2">{t.title}</td>
                  <td className="p-2 text-xs">{t.customerName ?? "—"}</td>
                  <td className="p-2 text-xs">{t.assignedToName ?? "—"}</td>
                  <td className="p-2"><Badge className={`${PRIORITY_COLOR[t.priority]} text-white`}>{PRIORITY_LABEL[t.priority]}</Badge></td>
                  <td className="p-2"><Badge variant="outline">{STATUS_LABEL[t.status] ?? t.status}</Badge></td>
                  <td className="p-2">
                    {(t.slaResponseBreached || t.slaResolutionBreached) ? (
                      <Badge variant="destructive" className="text-xs"><AlertTriangle className="h-3 w-3 ms-1" /> خرق</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs"><CheckCircle2 className="h-3 w-3 ms-1" /> ضمن SLA</Badge>
                    )}
                  </td>
                  <td className="p-2"><Button size="sm" variant="ghost">عرض</Button></td>
                </tr>
              ))}
              {(data ?? []).length === 0 && <tr><td colSpan={8} className="text-center text-muted-foreground py-8">لا توجد تذاكر</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>تذكرة خدمة جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>العنوان</Label><Input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div><Label>الوصف</Label><Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>الفئة</Label>
                <Select value={form.category ?? "repair"} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c.v} value={c.v}>{c.l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>الأولوية</Label>
                <Select value={form.priority ?? "medium"} onValueChange={(v) => setForm({ ...form, priority: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>الأصل (موديل الصيانة)</Label>
              <Select value={form.assetId ? String(form.assetId) : "none"}
                onValueChange={(v) => setForm({ ...form, assetId: v === "none" ? null : Number(v) })}>
                <SelectTrigger><SelectValue placeholder="بدون أصل" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— بدون أصل —</SelectItem>
                  {(assets ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.code} — {a.nameAr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                ربط التذكرة بأصل يتيح تحويلها لأمر صيانة لاحقاً
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              SLA افتراضي: عاجل 30/240 د • مرتفع 60/480 د • متوسط 4/24 س • منخفض 8/72 س
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button>
            <Button onClick={() => create.mutate(form)} disabled={!form.title || create.isPending}>إنشاء</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail */}
      <Dialog open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{detail?.ticketNo} — {detail?.title}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge className={`${PRIORITY_COLOR[detail.priority]} text-white`}>{PRIORITY_LABEL[detail.priority]}</Badge>
                <Badge variant="outline">{STATUS_LABEL[detail.status]}</Badge>
                {detail.slaResponseBreached && <Badge variant="destructive">خرق استجابة</Badge>}
                {detail.slaResolutionBreached && <Badge variant="destructive">خرق حل</Badge>}
              </div>
              {detail.description && <p className="text-muted-foreground">{detail.description}</p>}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-muted-foreground">العميل:</span> {detail.customerName ?? "—"}</div>
                <div><span className="text-muted-foreground">المُسند:</span> {detail.assignedToName ?? "—"}</div>
                <div><span className="text-muted-foreground">SLA استجابة:</span> {detail.slaResponseMin} د</div>
                <div><span className="text-muted-foreground">SLA حل:</span> {detail.slaResolutionMin} د</div>
                <div><span className="text-muted-foreground">فُتحت:</span> {new Date(detail.openedAt).toLocaleString("ar-SA")}</div>
                {detail.respondedAt && <div><span className="text-muted-foreground">رُد عليها:</span> {new Date(detail.respondedAt).toLocaleString("ar-SA")}</div>}
                {detail.resolvedAt && <div><span className="text-muted-foreground">حُلّت:</span> {new Date(detail.resolvedAt).toLocaleString("ar-SA")}</div>}
              </div>

              {/* Assign */}
              {(detail.status === "open" || detail.status === "assigned") && (
                <div className="border-t pt-3">
                  <Label>إسناد إلى موظف</Label>
                  <Select onValueChange={(v) => assign.mutate({ id: detail.id, employeeId: Number(v) })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder={detail.assignedToName ?? "اختر فني"} /></SelectTrigger>
                    <SelectContent>
                      {(employees ?? []).map((e) => <SelectItem key={e.id} value={String(e.id)}>{e.nameAr}</SelectItem>)}
                    </SelectContent>
                  </Select>
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

              {/* Maintenance asset link */}
              {detail.assetId && (
                <div className="border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs">
                      <span className="text-muted-foreground">الأصل المرتبط: </span>
                      <span className="font-mono">
                        {assets?.find(a => a.id === detail.assetId)?.code ?? `#${detail.assetId}`}
                      </span>
                      {" — "}
                      {assets?.find(a => a.id === detail.assetId)?.nameAr ?? ""}
                    </div>
                    <Link href={`/maintenance/assets`}>
                      <Button size="sm" variant="ghost" className="text-xs">
                        فتح في الصيانة <ArrowRight className="h-3 w-3 ms-1" />
                      </Button>
                    </Link>
                  </div>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => convert.mutate(detail.id)}
                    disabled={convert.isPending}>
                    <Wrench className="h-4 w-4 ms-2" /> تحويل لأمر صيانة
                  </Button>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 border-t pt-3 flex-wrap">
                {detail.status !== "resolved" && detail.status !== "closed" && (
                  <Button size="sm" onClick={() => {
                    const r = prompt("ما الحل المُطبَّق؟") || undefined;
                    resolve.mutate({ id: detail.id, resolution: r });
                  }}>
                    <CheckCircle2 className="h-4 w-4 ms-2" /> وضع كمحلولة
                  </Button>
                )}
                {detail.status === "resolved" && (
                  <Button size="sm" variant="outline" onClick={() => {
                    const r = prompt("تقييم العميل (1-5)؟");
                    const n = r ? Number(r) : undefined;
                    close.mutate({ id: detail.id, rating: n && n >= 1 && n <= 5 ? n : undefined });
                  }}>
                    إغلاق التذكرة
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
