import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2, XCircle, Trash2, Clock, Building2, User,
  Search, Filter, Package, Phone, MapPin, BadgeCheck, AlertTriangle,
  RefreshCw, ChevronDown
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  pending:  { label: "معلق",  color: "bg-amber-100 text-amber-800 border-amber-200",  icon: Clock },
  active:   { label: "مقبول", color: "bg-green-100 text-green-800 border-green-200",  icon: CheckCircle2 },
  rejected: { label: "مرفوض", color: "bg-red-100 text-red-800 border-red-200",         icon: XCircle },
};

const PLAN_LABELS: Record<string, string> = {
  starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي",
};

export default function RegistrationRequests() {
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [rejectDialog, setRejectDialog] = useState<{ id: number; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ id: number; name: string } | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/stats`, { headers });
      return res.json();
    },
  });

  const { data: requests = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-requests", filterStatus],
    queryFn: async () => {
      const url = filterStatus === "all"
        ? `${API}/api/admin/requests`
        : `${API}/api/admin/requests?status=${filterStatus}`;
      const res = await fetch(url, { headers });
      return res.json();
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/admin/requests/${id}/approve`, { method: "POST", headers });
      if (!res.ok) throw new Error("فشل القبول");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "تم قبول الطلب بنجاح", description: "أُنشئ حساب الشركة وأُفعِّل المستخدم." });
      queryClient.invalidateQueries({ queryKey: ["admin-requests"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await fetch(`${API}/api/admin/requests/${id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error("فشل الرفض");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "تم رفض الطلب" });
      queryClient.invalidateQueries({ queryKey: ["admin-requests"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
      setRejectDialog(null);
      setRejectReason("");
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/admin/requests/${id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error("فشل الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم حذف الطلب" });
      queryClient.invalidateQueries({ queryKey: ["admin-requests"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Clock className="h-6 w-6 text-primary" />طلبات تسجيل الشركات
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">راجع واقبل أو ارفض طلبات انضمام الشركات الجديدة</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-4 w-4" />تحديث
        </Button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "إجمالي الطلبات", value: stats.total,    color: "text-foreground",      bg: "bg-muted/40" },
            { label: "معلقة",          value: stats.pending,  color: "text-amber-700",        bg: "bg-amber-50 border border-amber-200" },
            { label: "مقبولة",         value: stats.active,   color: "text-green-700",        bg: "bg-green-50 border border-green-200" },
            { label: "مرفوضة",         value: stats.rejected, color: "text-red-700",          bg: "bg-red-50 border border-red-200" },
          ].map(s => (
            <div key={s.label} className={cn("rounded-xl p-4 text-center", s.bg)}>
              <p className={cn("text-3xl font-bold", s.color)}>{s.value}</p>
              <p className="text-sm text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث بالاسم، الرقم الضريبي، المستخدم..." className="pr-10" />
        </div>
        <div className="flex gap-2">
          {["all", "pending", "active", "rejected"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("px-3 py-1.5 rounded-lg text-sm font-medium border transition-all",
                filterStatus === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:border-primary/50"
              )}>
              {s === "all" ? "الكل" : STATUS_LABELS[s].label}
              {s !== "all" && stats && (
                <span className="mr-1 text-xs opacity-70">({stats[s === "active" ? "active" : s] ?? 0})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />)}
        </div>
      )}

      {/* Empty */}
      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-20">
          <Clock className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground font-medium">لا توجد طلبات {search ? "مطابقة" : ""}</p>
        </div>
      )}

      {/* Requests grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((r: any) => {
          const company = r.company;
          const user = r.user;
          const sub = r.subscription;
          const statusInfo = STATUS_LABELS[company.status] ?? STATUS_LABELS.pending;
          const StatusIcon = statusInfo.icon;
          const isPending = company.status === "pending";

          return (
            <Card key={company.id} className={cn("border-2 transition-all", isPending && "border-amber-200 bg-amber-50/30")}>
              <CardContent className="pt-5 pb-4 space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg shrink-0">
                      {company.nameAr?.[0] ?? "ش"}
                    </div>
                    <div>
                      <h3 className="font-semibold text-foreground leading-tight">{company.nameAr}</h3>
                      {company.nameEn && <p className="text-xs text-muted-foreground">{company.nameEn}</p>}
                    </div>
                  </div>
                  <span className={cn("flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium shrink-0", statusInfo.color)}>
                    <StatusIcon className="h-3 w-3" />{statusInfo.label}
                  </span>
                </div>

                {/* Details */}
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-green-600" />
                    <span className="font-mono">{company.vatNumber}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono text-[11px]">{company.crNumber}</span>
                  </div>
                  {company.city && (
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span>{company.city}</span>
                    </div>
                  )}
                  {user && (
                    <div className="flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-mono">{user.username}</span>
                    </div>
                  )}
                  {sub && (
                    <div className="flex items-center gap-1.5 col-span-2">
                      <Package className="h-3.5 w-3.5 shrink-0" />
                      <span>{PLAN_LABELS[sub.plan] ?? sub.plan} — {sub.price} ر.س/{sub.billingCycle === "annual" ? "سنة" : "شهر"}</span>
                    </div>
                  )}
                </div>

                {/* Rejection reason */}
                {company.status === "rejected" && company.rejectionReason && (
                  <div className="flex gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-500" />
                    <span>{company.rejectionReason}</span>
                  </div>
                )}

                {/* Timestamp */}
                <p className="text-[11px] text-muted-foreground/60">
                  تاريخ الطلب: {new Date(company.createdAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" })}
                </p>

                {/* Actions */}
                <div className="flex gap-2 pt-1 border-t">
                  {isPending && (
                    <>
                      <Button size="sm" className="flex-1 gap-1.5 bg-green-600 hover:bg-green-700"
                        onClick={() => approveMutation.mutate(company.id)}
                        disabled={approveMutation.isPending}>
                        <CheckCircle2 className="h-3.5 w-3.5" />قبول
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1 gap-1.5 border-red-300 text-red-700 hover:bg-red-50"
                        onClick={() => setRejectDialog({ id: company.id, name: company.nameAr })}>
                        <XCircle className="h-3.5 w-3.5" />رفض
                      </Button>
                    </>
                  )}
                  {company.status === "active" && (
                    <Button size="sm" variant="outline" className="flex-1 gap-1.5 border-red-300 text-red-700 hover:bg-red-50"
                      onClick={() => setRejectDialog({ id: company.id, name: company.nameAr })}>
                      <XCircle className="h-3.5 w-3.5" />إلغاء التفعيل
                    </Button>
                  )}
                  {company.status === "rejected" && (
                    <Button size="sm" className="flex-1 gap-1.5 bg-green-600 hover:bg-green-700"
                      onClick={() => approveMutation.mutate(company.id)}
                      disabled={approveMutation.isPending}>
                      <CheckCircle2 className="h-3.5 w-3.5" />إعادة تفعيل
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 gap-1.5"
                    onClick={() => setDeleteDialog({ id: company.id, name: company.nameAr })}>
                    <Trash2 className="h-3.5 w-3.5" />حذف
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Reject Dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={() => setRejectDialog(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-right">
              <XCircle className="h-5 w-5 text-destructive" />
              رفض طلب: {rejectDialog?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">أدخل سبب الرفض ليظهر للشركة (اختياري)</p>
            <Input
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="سبب الرفض..."
            />
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

      {/* Delete Dialog */}
      <Dialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-right">
              <Trash2 className="h-5 w-5 text-destructive" />حذف الطلب
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            هل أنت متأكد من حذف طلب <strong>{deleteDialog?.name}</strong>؟ لا يمكن التراجع عن هذا الإجراء.
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
