import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, XCircle, Trash2, Clock, Building2, User,
  Search, MapPin, BadgeCheck, AlertTriangle, RefreshCw,
  Package, ChevronDown, ChevronUp, MoreVertical, Wifi
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_CONFIG: Record<string, { label: string; variant: string; icon: any; rowBg: string }> = {
  pending:  { label: "معلق",  variant: "bg-amber-100 text-amber-800 border-amber-300",  icon: Clock,         rowBg: "bg-amber-50/40 hover:bg-amber-50/70" },
  active:   { label: "مقبول", variant: "bg-green-100 text-green-800 border-green-300",  icon: CheckCircle2,  rowBg: "bg-white hover:bg-green-50/30" },
  rejected: { label: "مرفوض", variant: "bg-red-100 text-red-800 border-red-300",         icon: XCircle,       rowBg: "bg-red-50/20 hover:bg-red-50/40" },
};

const PLAN_LABELS: Record<string, string> = {
  starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي",
};

const PLAN_BADGE: Record<string, string> = {
  starter: "bg-blue-50 text-blue-700 border-blue-200",
  professional: "bg-primary/10 text-primary border-primary/20",
  enterprise: "bg-amber-50 text-amber-700 border-amber-200",
};

function StatCard({ label, value, color, border }: any) {
  return (
    <div className={cn("flex-1 min-w-[120px] rounded-xl border px-5 py-4 text-center", border)}>
      <p className={cn("text-3xl font-bold tabular-nums", color)}>{value ?? "—"}</p>
      <p className="text-xs text-muted-foreground mt-1 font-medium">{label}</p>
    </div>
  );
}

export default function RegistrationRequests() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [rejectDialog, setRejectDialog] = useState<{ id: number; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ id: number; name: string } | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/stats`, { headers });
      return r.json();
    },
  });

  const { data: requests = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-requests", filterStatus],
    queryFn: async () => {
      const url = filterStatus === "all"
        ? `${API}/api/admin/requests`
        : `${API}/api/admin/requests?status=${filterStatus}`;
      const r = await fetch(url, { headers });
      return r.json();
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/requests/${id}/approve`, { method: "POST", headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "✓ تم قبول الطلب", description: "أُنشئ حساب الشركة وأُفعِّل المستخدم." });
      qc.invalidateQueries({ queryKey: ["admin-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const r = await fetch(`${API}/api/admin/requests/${id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ reason }),
      });
      if (!r.ok) throw new Error();
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم رفض الطلب" });
      qc.invalidateQueries({ queryKey: ["admin-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setRejectDialog(null);
      setRejectReason("");
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/api/admin/requests/${id}`, { method: "DELETE", headers });
    },
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      qc.invalidateQueries({ queryKey: ["admin-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setDeleteDialog(null);
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const filtered = requests.filter((r: any) =>
    r.company?.nameAr?.includes(search) ||
    r.company?.vatNumber?.includes(search) ||
    r.user?.username?.includes(search) ||
    r.company?.city?.includes(search)
  );

  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock className="h-6 w-6 text-primary" />
            طلبات تسجيل الشركات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">راجع طلبات الانضمام وتخذ إجراء بالقبول أو الرفض</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* ── Stats row ── */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="الإجمالي"  value={stats?.total}    color="text-foreground"   border="border bg-muted/30" />
        <StatCard label="معلقة"     value={stats?.pending}  color="text-amber-700"    border="border-amber-200 bg-amber-50/60" />
        <StatCard label="مقبولة"    value={stats?.active}   color="text-green-700"    border="border-green-200 bg-green-50/60" />
        <StatCard label="مرفوضة"    value={stats?.rejected} color="text-red-700"      border="border-red-200 bg-red-50/60" />
      </div>

      {/* ── Search + Filter ── */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث بالاسم أو الرقم الضريبي أو المستخدم..."
            className="pr-10 h-9 text-sm" />
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {[
            { key: "all",      label: "الكل",   count: stats?.total },
            { key: "pending",  label: "معلقة",  count: stats?.pending },
            { key: "active",   label: "مقبولة", count: stats?.active },
            { key: "rejected", label: "مرفوضة", count: stats?.rejected },
          ].map((tab, i) => (
            <button key={tab.key}
              onClick={() => setFilterStatus(tab.key)}
              className={cn(
                "px-4 py-1.5 flex items-center gap-1.5 transition-colors font-medium",
                i > 0 && "border-r",
                filterStatus === tab.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}>
              {tab.label}
              <span className={cn("text-[11px] rounded-full px-1.5 py-0 font-bold",
                filterStatus === tab.key ? "bg-white/20" : "bg-muted"
              )}>{tab.count ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Grid table ── */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">

        {/* Column headers */}
        <div className="grid items-center gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none"
          style={{ gridTemplateColumns: "2fr 1.2fr 1fr 1fr 1fr 1fr 0.8fr auto" }}>
          <span>الشركة</span>
          <span>الرقم الضريبي</span>
          <span>المدينة</span>
          <span>المستخدم</span>
          <span>الباقة</span>
          <span>عنوان IP</span>
          <span>الحالة</span>
          <span className="text-center w-8">—</span>
        </div>

        {/* Loading skeleton */}
        {isLoading && (
          <div className="divide-y">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5 animate-pulse">
                <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 bg-muted rounded" />
                  <div className="h-3 w-28 bg-muted/60 rounded" />
                </div>
                <div className="h-3.5 w-32 bg-muted rounded" />
                <div className="h-3.5 w-20 bg-muted rounded" />
                <div className="h-3.5 w-20 bg-muted rounded" />
                <div className="h-6 w-16 bg-muted rounded-full" />
                <div className="h-7 w-7 bg-muted rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filtered.length === 0 && (
          <div className="py-20 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">لا توجد طلبات{search ? " مطابقة" : ""}</p>
          </div>
        )}

        {/* Rows */}
        <div className="divide-y">
          {filtered.map((r: any) => {
            const co = r.company;
            const user = r.user;
            const sub = r.subscription;
            const status = STATUS_CONFIG[co.status] ?? STATUS_CONFIG.pending;
            const StatusIcon = status.icon;
            const isPending = co.status === "pending";
            const isExpanded = expandedRow === co.id;

            return (
              <div key={co.id} className={cn("transition-colors", status.rowBg)}>

                {/* Main row */}
                <div
                  className="grid items-center gap-4 px-4 py-3.5 cursor-pointer"
                  style={{ gridTemplateColumns: "2fr 1.2fr 1fr 1fr 1fr 1fr 0.8fr auto" }}
                  onClick={() => setExpandedRow(isExpanded ? null : co.id)}
                >
                  {/* Company name + avatar */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-bold text-sm",
                      isPending ? "bg-amber-100 text-amber-700" :
                      co.status === "active" ? "bg-green-100 text-green-700" :
                      "bg-red-100 text-red-700"
                    )}>
                      {co.nameAr?.[0] ?? "ش"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate leading-tight">{co.nameAr}</p>
                      {co.nameEn && <p className="text-xs text-muted-foreground truncate leading-tight">{co.nameEn}</p>}
                    </div>
                  </div>

                  {/* VAT */}
                  <span className="font-mono text-xs text-muted-foreground tracking-wide truncate">{co.vatNumber}</span>

                  {/* City */}
                  <span className="text-sm text-foreground/80 truncate">{co.city || "—"}</span>

                  {/* Username */}
                  <span className="font-mono text-xs text-muted-foreground truncate">{user?.username ?? "—"}</span>

                  {/* Plan */}
                  <span>
                    {sub?.plan ? (
                      <span className={cn("text-xs border rounded-full px-2 py-0.5 font-medium", PLAN_BADGE[sub.plan] ?? "bg-muted text-muted-foreground border-border")}>
                        {PLAN_LABELS[sub.plan] ?? sub.plan}
                      </span>
                    ) : <span className="text-muted-foreground/50 text-xs">—</span>}
                  </span>

                  {/* Registration IP */}
                  <span className="flex items-center gap-1 min-w-0">
                    {co.registrationIp ? (
                      <>
                        <Wifi className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                        <span className="font-mono text-xs text-muted-foreground truncate" title={co.registrationIp}>{co.registrationIp}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </span>

                  {/* Status badge */}
                  <span className={cn("inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit", status.variant)}>
                    <StatusIcon className="h-3 w-3 shrink-0" />
                    {status.label}
                  </span>

                  {/* Expand chevron */}
                  <button
                    className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
                    onClick={e => { e.stopPropagation(); setExpandedRow(isExpanded ? null : co.id); }}
                  >
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 space-y-4">
                    {/* Info grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      {[
                        { icon: BadgeCheck, label: "رقم ضريبي",      value: co.vatNumber,    mono: true },
                        { icon: Building2,  label: "سجل تجاري",       value: co.crNumber,     mono: true },
                        { icon: MapPin,     label: "العنوان",          value: [co.street, co.district, co.city].filter(Boolean).join("، ") },
                        { icon: Package,    label: "الباقة والفاتورة", value: sub ? `${PLAN_LABELS[sub.plan] ?? sub.plan} — ${sub.price} ر.س/${sub.billingCycle === "annual" ? "سنة" : "شهر"}` : "—" },
                        { icon: User,       label: "اسم المستخدم",    value: user?.username,  mono: true },
                        { icon: Wifi,       label: "عنوان IP التسجيل", value: co.registrationIp || "غير متاح", mono: true },
                        { icon: Clock,      label: "تاريخ الطلب",      value: new Date(co.createdAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" }) },
                        sub?.startDate && { icon: Clock, label: "بداية الاشتراك", value: sub.startDate },
                        sub?.endDate   && { icon: Clock, label: "نهاية الاشتراك", value: sub.endDate },
                      ].filter(Boolean).map((item: any) => (
                        <div key={item.label} className="flex items-start gap-2 bg-background/60 rounded-lg p-2.5 border">
                          <item.icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wide font-semibold">{item.label}</p>
                            <p className={cn("text-xs font-medium truncate mt-0.5", item.mono ? "font-mono" : "")}>{item.value || "—"}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Rejection reason */}
                    {co.status === "rejected" && co.rejectionReason && (
                      <div className="flex gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
                        <div><span className="font-semibold">سبب الرفض: </span>{co.rejectionReason}</div>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1">
                      {isPending && (
                        <>
                          <Button size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700 h-8"
                            onClick={() => approveMutation.mutate(co.id)}
                            disabled={approveMutation.isPending}>
                            <CheckCircle2 className="h-3.5 w-3.5" />قبول الطلب
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1.5 h-8 border-red-300 text-red-700 hover:bg-red-50"
                            onClick={() => setRejectDialog({ id: co.id, name: co.nameAr })}>
                            <XCircle className="h-3.5 w-3.5" />رفض
                          </Button>
                        </>
                      )}
                      {co.status === "active" && (
                        <Button size="sm" variant="outline" className="gap-1.5 h-8 border-red-300 text-red-700 hover:bg-red-50"
                          onClick={() => setRejectDialog({ id: co.id, name: co.nameAr })}>
                          <XCircle className="h-3.5 w-3.5" />إلغاء التفعيل
                        </Button>
                      )}
                      {co.status === "rejected" && (
                        <Button size="sm" className="gap-1.5 h-8 bg-green-600 hover:bg-green-700"
                          onClick={() => approveMutation.mutate(co.id)}
                          disabled={approveMutation.isPending}>
                          <CheckCircle2 className="h-3.5 w-3.5" />إعادة تفعيل
                        </Button>
                      )}
                      {/* Delete only for rejected requests */}
                      {co.status === "rejected" && (
                        <Button size="sm" variant="ghost" className="gap-1.5 h-8 text-destructive hover:bg-destructive/10 mr-auto"
                          onClick={() => setDeleteDialog({ id: co.id, name: co.nameAr })}>
                          <Trash2 className="h-3.5 w-3.5" />حذف نهائياً
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer count */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
            <span>عدد النتائج: <strong>{filtered.length}</strong></span>
            <span className="text-muted-foreground/60">انقر على أي صف لعرض التفاصيل والإجراءات</span>
          </div>
        )}
      </div>

      {/* ── Reject Dialog ── */}
      <Dialog open={!!rejectDialog} onOpenChange={() => setRejectDialog(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              رفض طلب: {rejectDialog?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">أدخل سبب الرفض (اختياري — سيُعرض للشركة)</p>
            <Input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="سبب الرفض..." />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRejectDialog(null)}>إلغاء</Button>
            <Button variant="destructive" className="gap-2"
              onClick={() => rejectMutation.mutate({ id: rejectDialog!.id, reason: rejectReason || "تم رفض الطلب" })}
              disabled={rejectMutation.isPending}>
              <XCircle className="h-4 w-4" />
              {rejectMutation.isPending ? "جاري الرفض..." : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Dialog ── */}
      <Dialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />حذف نهائي
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            هل أنت متأكد من حذف شركة <strong>{deleteDialog?.name}</strong> بشكل نهائي؟ لا يمكن التراجع.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteDialog(null)}>إلغاء</Button>
            <Button variant="destructive" className="gap-2"
              onClick={() => deleteMutation.mutate(deleteDialog!.id)}
              disabled={deleteMutation.isPending}>
              <Trash2 className="h-4 w-4" />
              {deleteMutation.isPending ? "جاري الحذف..." : "حذف نهائياً"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
