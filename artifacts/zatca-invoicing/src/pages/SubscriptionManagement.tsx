import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Package, Search, RefreshCw, Pencil, CheckCircle2, XCircle,
  Building2, Calendar, Users, FileText, ChevronDown, ChevronUp, BadgeCheck
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLANS = [
  { key: "starter",      label: "مبتدئ",     color: "bg-blue-50 text-blue-700 border-blue-200",    maxUsers: 1,   maxInvoices: 50,     price: "99" },
  { key: "professional", label: "احترافي",   color: "bg-primary/10 text-primary border-primary/20", maxUsers: 5,   maxInvoices: 500,    price: "299" },
  { key: "enterprise",   label: "مؤسسي",     color: "bg-amber-50 text-amber-700 border-amber-200",  maxUsers: 999, maxInvoices: 999999, price: "899" },
];

const PLAN_MAP = Object.fromEntries(PLANS.map(p => [p.key, p]));

function StatCard({ label, value, sub, icon: Icon, iconBg, iconColor, border }: any) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 flex items-center gap-3", border)}>
      <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
        <Icon className={cn("h-5 w-5", iconColor)} />
      </div>
      <div>
        <p className="text-2xl font-bold tabular-nums">{value ?? "—"}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function SubscriptionManagement() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch]             = useState("");
  const [planFilter, setPlanFilter]     = useState("all");
  const [expandedRow, setExpandedRow]   = useState<number | null>(null);
  const [editDialog, setEditDialog]     = useState<any | null>(null);
  const [editForm, setEditForm]         = useState<any>({});

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-subscriptions"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/subscriptions`, { headers });
      return res.json();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/${id}`, {
        method: "PUT", headers, body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم تحديث الاشتراك بنجاح" });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      setEditDialog(null);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const filtered = rows.filter((r: any) => {
    const matchSearch =
      r.company?.nameAr?.includes(search) ||
      r.company?.vatNumber?.includes(search);
    const matchPlan =
      planFilter === "all" || r.subscription?.plan === planFilter;
    return matchSearch && matchPlan;
  });

  // Stats
  const total   = rows.length;
  const active  = rows.filter((r: any) => r.subscription?.isActive).length;
  const byPlan  = (plan: string) => rows.filter((r: any) => r.subscription?.plan === plan).length;
  const revenue = rows
    .filter((r: any) => r.subscription?.isActive)
    .reduce((s: number, r: any) => s + Number(r.subscription?.price ?? 0), 0);

  const openEdit = (row: any) => {
    setEditForm({ ...row.subscription });
    setEditDialog(row);
  };

  const applyPlanDefaults = (plan: string) => {
    const p = PLAN_MAP[plan];
    if (!p) return;
    setEditForm((f: any) => ({ ...f, plan, maxUsers: p.maxUsers, maxInvoices: p.maxInvoices, price: p.price }));
  };

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6 text-primary" />إدارة الاشتراكات والباقات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">تعديل باقات الشركات المشتركة وبيانات الاشتراك</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="إجمالي الاشتراكات" value={total}   icon={Package}      iconBg="bg-primary/10"  iconColor="text-primary" />
        <StatCard label="اشتراكات نشطة"     value={active}  icon={CheckCircle2} iconBg="bg-green-100"   iconColor="text-green-600" />
        <StatCard label="الإيراد الشهري"    value={`${revenue.toLocaleString("ar-SA")} ر.س`} icon={BadgeCheck} iconBg="bg-amber-100" iconColor="text-amber-600" sub="الاشتراكات النشطة فقط" />
        <StatCard label="مؤسسي"             value={byPlan("enterprise")} icon={Users} iconBg="bg-purple-100" iconColor="text-purple-600" sub={`احترافي: ${byPlan("professional")} | مبتدئ: ${byPlan("starter")}`} />
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث باسم الشركة أو الرقم الضريبي..."
            className="pr-10 h-9 text-sm" />
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {[{ key: "all", label: "الكل" }, ...PLANS.map(p => ({ key: p.key, label: p.label }))].map((tab, i) => (
            <button key={tab.key} onClick={() => setPlanFilter(tab.key)}
              className={cn("px-3 py-1.5 font-medium transition-colors", i > 0 && "border-r",
                planFilter === tab.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Column headers */}
        <div className="grid items-center gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none"
          style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 0.7fr auto" }}>
          <span>الشركة</span>
          <span>الباقة</span>
          <span>المستخدمون</span>
          <span>الفواتير</span>
          <span>انتهاء الاشتراك</span>
          <span>الحالة</span>
          <span className="text-center w-8">—</span>
        </div>

        {/* Skeleton */}
        {isLoading && (
          <div className="divide-y">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-4 px-4 py-4 animate-pulse">
                <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                <Skeleton className="h-4 w-40 flex-1" />
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        )}

        {/* Empty */}
        {!isLoading && filtered.length === 0 && (
          <div className="py-20 text-center">
            <Package className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">لا توجد اشتراكات{search ? " مطابقة" : ""}</p>
          </div>
        )}

        {/* Rows */}
        <div className="divide-y">
          {filtered.map((row: any) => {
            const sub     = row.subscription;
            const company = row.company;
            const plan    = PLAN_MAP[sub?.plan] ?? PLAN_MAP.starter;
            const isExp   = expandedRow === sub?.id;
            const expired = sub?.endDate && new Date(sub.endDate) < new Date();

            return (
              <div key={sub?.id} className={cn("transition-colors", !sub?.isActive && "bg-muted/20")}>
                {/* Main row */}
                <div
                  className="grid items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-muted/20 transition-colors"
                  style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 0.7fr auto" }}
                  onClick={() => setExpandedRow(isExp ? null : sub?.id)}
                >
                  {/* Company */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                      {company?.nameAr?.[0] ?? "ش"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate">{company?.nameAr}</p>
                      <p className="text-[11px] font-mono text-muted-foreground truncate">{company?.vatNumber}</p>
                    </div>
                  </div>

                  {/* Plan badge */}
                  <span className={cn("inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-semibold w-fit", plan.color)}>
                    <Package className="h-3 w-3 shrink-0" />{plan.label}
                  </span>

                  {/* Users */}
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Users className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs">{sub?.maxUsers === 999 ? "∞" : sub?.maxUsers}</span>
                  </div>

                  {/* Invoices */}
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs">{sub?.maxInvoices === 999999 ? "∞" : sub?.maxInvoices?.toLocaleString()}</span>
                  </div>

                  {/* End date */}
                  <div className={cn("flex items-center gap-1 text-xs", expired ? "text-red-600 font-medium" : "text-muted-foreground")}>
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    {sub?.endDate ?? "—"}
                    {expired && <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 rounded px-1">منتهي</span>}
                  </div>

                  {/* Status */}
                  <span className={cn("inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit",
                    sub?.isActive
                      ? "bg-green-50 text-green-700 border-green-200"
                      : "bg-red-50 text-red-700 border-red-200")}>
                    {sub?.isActive ? <><CheckCircle2 className="h-3 w-3" />نشط</> : <><XCircle className="h-3 w-3" />موقوف</>}
                  </span>

                  {/* Expand */}
                  <button className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
                    onClick={e => { e.stopPropagation(); setExpandedRow(isExp ? null : sub?.id); }}>
                    {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {/* Expanded */}
                {isExp && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      {[
                        { label: "الباقة",             value: plan.label },
                        { label: "دورة الفوترة",        value: sub?.billingCycle === "annual" ? "سنوية" : "شهرية" },
                        { label: "السعر",              value: `${sub?.price} ر.س / ${sub?.billingCycle === "annual" ? "سنة" : "شهر"}` },
                        { label: "تاريخ البداية",       value: sub?.startDate },
                        { label: "تاريخ الانتهاء",     value: sub?.endDate },
                        { label: "الحد الأقصى للمستخدمين", value: sub?.maxUsers === 999 ? "غير محدود" : sub?.maxUsers },
                        { label: "الحد الأقصى للفواتير",   value: sub?.maxInvoices === 999999 ? "غير محدود" : sub?.maxInvoices?.toLocaleString() },
                        { label: "حالة الاشتراك",       value: sub?.isActive ? "نشط" : "موقوف" },
                      ].map(item => (
                        <div key={item.label} className="flex items-start gap-2 bg-background/60 rounded-lg p-2.5 border">
                          <div>
                            <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wide font-semibold">{item.label}</p>
                            <p className="text-xs font-medium mt-0.5">{item.value ?? "—"}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="gap-1.5 h-8" onClick={() => openEdit(row)}>
                        <Pencil className="h-3.5 w-3.5" />تعديل الاشتراك
                      </Button>
                      <Button size="sm" variant="outline" className={cn("gap-1.5 h-8",
                        sub?.isActive ? "border-red-300 text-red-700 hover:bg-red-50" : "border-green-300 text-green-700 hover:bg-green-50")}
                        onClick={() => updateMutation.mutate({ id: sub.id, data: { isActive: !sub.isActive } })}>
                        {sub?.isActive ? <><XCircle className="h-3.5 w-3.5" />إيقاف</> : <><CheckCircle2 className="h-3.5 w-3.5" />تفعيل</>}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
            <span>عدد الاشتراكات: <strong>{filtered.length}</strong></span>
            <span className="text-muted-foreground/60">انقر على أي صف لعرض التفاصيل والإجراءات</span>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editDialog} onOpenChange={() => setEditDialog(null)}>
        <DialogContent dir="rtl" className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-primary" />
              تعديل اشتراك: {editDialog?.company?.nameAr}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Plan selector */}
            <div className="space-y-2">
              <Label>الباقة</Label>
              <div className="grid grid-cols-3 gap-2">
                {PLANS.map(p => (
                  <button key={p.key} type="button"
                    onClick={() => applyPlanDefaults(p.key)}
                    className={cn("rounded-lg border p-3 text-center transition-all text-sm font-semibold",
                      editForm.plan === p.key
                        ? "border-primary bg-primary/10 text-primary ring-2 ring-primary/30"
                        : "border-border hover:border-primary/50 text-muted-foreground")}>
                    {p.label}
                    <p className="text-xs font-normal mt-0.5">{p.price} ر.س</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Billing cycle */}
            <div className="space-y-2">
              <Label>دورة الفوترة</Label>
              <div className="flex rounded-lg border overflow-hidden">
                {[{ v: "monthly", l: "شهرية" }, { v: "annual", l: "سنوية (20% خصم)" }].map((opt, i) => (
                  <button key={opt.v} type="button"
                    onClick={() => setEditForm((f: any) => ({ ...f, billingCycle: opt.v }))}
                    className={cn("flex-1 py-2 text-sm font-medium transition-colors", i > 0 && "border-r",
                      editForm.billingCycle === opt.v
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted/60")}>
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid of fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">الحد الأقصى للمستخدمين</Label>
                <Input type="number" value={editForm.maxUsers ?? ""} min={1}
                  onChange={e => setEditForm((f: any) => ({ ...f, maxUsers: parseInt(e.target.value) }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">الحد الأقصى للفواتير</Label>
                <Input type="number" value={editForm.maxInvoices ?? ""} min={1}
                  onChange={e => setEditForm((f: any) => ({ ...f, maxInvoices: parseInt(e.target.value) }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">السعر (ر.س)</Label>
                <Input type="number" value={editForm.price ?? ""} min={0}
                  onChange={e => setEditForm((f: any) => ({ ...f, price: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">الحالة</Label>
                <div className="flex rounded-lg border overflow-hidden h-9">
                  <button type="button" onClick={() => setEditForm((f: any) => ({ ...f, isActive: true }))}
                    className={cn("flex-1 text-sm font-medium border-r transition-colors",
                      editForm.isActive ? "bg-green-600 text-white" : "text-muted-foreground hover:bg-muted/60")}>
                    نشط
                  </button>
                  <button type="button" onClick={() => setEditForm((f: any) => ({ ...f, isActive: false }))}
                    className={cn("flex-1 text-sm font-medium transition-colors",
                      !editForm.isActive ? "bg-red-600 text-white" : "text-muted-foreground hover:bg-muted/60")}>
                    موقوف
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">تاريخ البداية</Label>
                <Input type="date" value={editForm.startDate ?? ""}
                  onChange={e => setEditForm((f: any) => ({ ...f, startDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">تاريخ الانتهاء</Label>
                <Input type="date" value={editForm.endDate ?? ""}
                  onChange={e => setEditForm((f: any) => ({ ...f, endDate: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditDialog(null)}>إلغاء</Button>
            <Button className="gap-2"
              onClick={() => updateMutation.mutate({ id: editDialog.subscription.id, data: editForm })}
              disabled={updateMutation.isPending}>
              <CheckCircle2 className="h-4 w-4" />
              {updateMutation.isPending ? "جاري الحفظ..." : "حفظ التغييرات"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
