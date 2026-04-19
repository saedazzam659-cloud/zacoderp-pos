import { useState } from "react";
import { useParams, Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, Building2, Users, FileText, Package, CheckCircle2,
  XCircle, Plus, Trash2, RefreshCw, Calendar, ShieldCheck,
  UserPlus, Eye, EyeOff, TrendingUp, AlertTriangle, Pencil,
  UserCheck, UserX, Truck, BarChart3, Key, Link2
} from "lucide-react";
import ZatcaIntegration from "@/pages/ZatcaIntegration";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLAN_LABELS: Record<string, { label: string; color: string }> = {
  starter:      { label: "مبتدئ",   color: "bg-blue-50 text-blue-700 border-blue-200" },
  professional: { label: "احترافي", color: "bg-primary/10 text-primary border-primary/20" },
  enterprise:   { label: "مؤسسي",   color: "bg-amber-50 text-amber-700 border-amber-200" },
};

function StatCard({ label, value, icon: Icon, iconBg, iconColor, sub, warn }: any) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 flex items-center gap-3", warn && "border-amber-300 bg-amber-50/50")}>
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

function InfoRow({ label, value, ltr }: { label: string; value: any; ltr?: boolean }) {
  return (
    <div className="flex justify-between items-center border-b pb-2 last:border-0 py-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="font-medium text-sm" dir={ltr ? "ltr" : undefined}>{value ?? "—"}</span>
    </div>
  );
}

function TabBtn({ active, onClick, children, count }: any) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
      )}
    >
      {children}
      {count != null && (
        <span className={cn("text-xs rounded-full px-1.5 py-0 tabular-nums font-semibold",
          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
          {count}
        </span>
      )}
    </button>
  );
}

export default function CompanyDetails() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = parseInt(idStr ?? "0");
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState("overview");
  const [showAddUser, setShowAddUser] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", email: "", password: "", role: "admin" });
  const [resetPassDialog, setResetPassDialog] = useState<any | null>(null);
  const [newPass, setNewPass] = useState("");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-company", id],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/companies/${id}`, { headers });
      if (!res.ok) throw new Error("company not found");
      return res.json();
    },
    enabled: !!id,
  });

  const company     = data?.company;
  const subscription = data?.subscription;
  const users       = data?.users ?? [];
  const counts      = data?.counts ?? { invoices: 0, customers: 0, suppliers: 0 };

  const addUserMutation = useMutation({
    mutationFn: async (body: any) => {
      const res = await fetch(`${API}/api/admin/companies/${id}/users`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "خطأ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم إضافة المستخدم" });
      setNewUser({ username: "", email: "", password: "", role: "admin" });
      setShowAddUser(false);
      qc.invalidateQueries({ queryKey: ["admin-company", id] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      await fetch(`${API}/api/admin/companies/${id}/users/${userId}`, { method: "DELETE", headers });
    },
    onSuccess: () => {
      toast({ title: "✓ تم حذف المستخدم" });
      qc.invalidateQueries({ queryKey: ["admin-company", id] });
    },
  });

  const toggleUserMutation = useMutation({
    mutationFn: async ({ userId, isActive }: { userId: number; isActive: boolean }) => {
      const res = await fetch(`${API}/api/admin/companies/${id}/users/${userId}`, {
        method: "PUT", headers, body: JSON.stringify({ isActive }),
      });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-company", id] }),
  });

  const resetPassMutation = useMutation({
    mutationFn: async ({ userId, password }: { userId: number; password: string }) => {
      const res = await fetch(`${API}/api/admin/companies/${id}/users/${userId}`, {
        method: "PUT", headers, body: JSON.stringify({ password }),
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "✓ تم تغيير كلمة المرور" });
      setResetPassDialog(null);
      setNewPass("");
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="text-center py-20">
        <Building2 className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-muted-foreground font-medium">الشركة غير موجودة</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/companies">العودة للشركات</Link>
        </Button>
      </div>
    );
  }

  const planInfo = PLAN_LABELS[subscription?.plan ?? ""] ?? null;
  const subExpired = subscription?.endDate && new Date(subscription.endDate) < new Date();

  return (
    <div className="space-y-5 pb-10" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/companies"><ArrowRight className="h-5 w-5" /></Link>
          </Button>
          <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary font-bold text-lg flex items-center justify-center shrink-0">
            {company.nameAr?.[0] ?? "ش"}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold">{company.nameAr}</h1>
              {company.nameEn && <span className="text-sm text-muted-foreground">{company.nameEn}</span>}
              <Badge className={cn("text-xs border", company.status === "active"
                ? "bg-green-50 text-green-700 border-green-200"
                : company.status === "pending"
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-red-50 text-red-700 border-red-200")}>
                {company.status === "active" ? "نشطة" : company.status === "pending" ? "معلّقة" : "مرفوضة"}
              </Badge>
              {planInfo && (
                <Badge className={cn("text-xs border", planInfo.color)}>
                  <Package className="h-3 w-3 ml-1" />{planInfo.label}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{company.vatNumber}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="المستخدمون" value={users.length} icon={Users} iconBg="bg-blue-100" iconColor="text-blue-600"
          sub={`${users.filter((u: any) => u.isActive).length} نشط`} />
        <StatCard label="الفواتير" value={counts.invoices} icon={FileText} iconBg="bg-primary/10" iconColor="text-primary" />
        <StatCard label="العملاء" value={counts.customers} icon={UserCheck} iconBg="bg-green-100" iconColor="text-green-600" />
        <StatCard label="الموردون" value={counts.suppliers} icon={Truck} iconBg="bg-amber-100" iconColor="text-amber-600" />
      </div>

      {/* Tabs */}
      <div className="border-b flex gap-0 overflow-x-auto">
        <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>
          <Building2 className="h-4 w-4" />نظرة عامة
        </TabBtn>
        <TabBtn active={tab === "users"} onClick={() => setTab("users")} count={users.length}>
          <Users className="h-4 w-4" />المستخدمون
        </TabBtn>
        <TabBtn active={tab === "subscription"} onClick={() => setTab("subscription")}>
          <Package className="h-4 w-4" />الاشتراك
        </TabBtn>
        <TabBtn active={tab === "zatca"} onClick={() => setTab("zatca")}>
          <Link2 className="h-4 w-4" />ربط ZATCA
        </TabBtn>
        <TabBtn active={tab === "data"} onClick={() => setTab("data")}>
          <BarChart3 className="h-4 w-4" />البيانات
        </TabBtn>
      </div>

      {/* ─── Overview Tab ─── */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="rounded-xl border bg-card p-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-primary" />بيانات الشركة
            </h3>
            <div className="space-y-1">
              <InfoRow label="الاسم العربي" value={company.nameAr} />
              <InfoRow label="الاسم الإنجليزي" value={company.nameEn} />
              <InfoRow label="الرقم الضريبي" value={company.vatNumber} ltr />
              <InfoRow label="السجل التجاري" value={company.crNumber} ltr />
              <InfoRow label="مجال الصناعة" value={company.industryName} />
              <InfoRow label="نوع الفواتير" value={
                company.invoiceType === "both" ? "ضريبية ومبسطة"
                : company.invoiceType === "standard" ? "ضريبية فقط" : "مبسطة فقط"
              } />
              <InfoRow label="تاريخ التسجيل" value={company.createdAt
                ? new Date(company.createdAt).toLocaleDateString("ar-SA")
                : "—"} />
            </div>
          </div>
          <div className="rounded-xl border bg-card p-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-primary" />العنوان الوطني
            </h3>
            <div className="space-y-1">
              <InfoRow label="المدينة" value={company.city} />
              <InfoRow label="الحي" value={company.district} />
              <InfoRow label="الشارع" value={company.street} />
              <InfoRow label="رقم المبنى" value={company.buildingNumber} ltr />
              <InfoRow label="الرمز البريدي" value={company.postalCode} ltr />
              <InfoRow label="الرقم الإضافي" value={company.additionalNumber} ltr />
            </div>
          </div>
        </div>
      )}

      {/* ─── Users Tab ─── */}
      {tab === "users" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">مستخدمو الشركة</h3>
              <p className="text-xs text-muted-foreground mt-0.5">إدارة حسابات الدخول المرتبطة بهذه الشركة</p>
            </div>
            <Button size="sm" className="gap-2" onClick={() => setShowAddUser(v => !v)}>
              <UserPlus className="h-4 w-4" />إضافة مستخدم
            </Button>
          </div>

          {/* Add user form */}
          {showAddUser && (
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-5 space-y-4">
              <h4 className="font-semibold text-sm flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" />مستخدم جديد
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">اسم المستخدم *</Label>
                  <Input value={newUser.username} onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                    placeholder="username" dir="ltr" className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">البريد الإلكتروني</Label>
                  <Input value={newUser.email} onChange={e => setNewUser(u => ({ ...u, email: e.target.value }))}
                    placeholder="email@company.sa" dir="ltr" type="email" className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">كلمة المرور *</Label>
                  <div className="relative">
                    <Input value={newUser.password} onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                      type={showPass ? "text" : "password"} placeholder="••••••••" dir="ltr" className="h-9 pl-9" />
                    <button type="button" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      onClick={() => setShowPass(v => !v)}>
                      {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">الصلاحية</Label>
                  <div className="flex rounded-lg border overflow-hidden h-9">
                    {[{ v: "admin", l: "مدير" }, { v: "user", l: "مستخدم" }].map((opt, i) => (
                      <button key={opt.v} type="button"
                        onClick={() => setNewUser(u => ({ ...u, role: opt.v }))}
                        className={cn("flex-1 text-sm font-medium transition-colors", i > 0 && "border-r",
                          newUser.role === opt.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="gap-2"
                  disabled={addUserMutation.isPending || !newUser.username || !newUser.password}
                  onClick={() => addUserMutation.mutate(newUser)}>
                  <Plus className="h-3.5 w-3.5" />
                  {addUserMutation.isPending ? "جاري الإضافة..." : "إضافة"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddUser(false)}>إلغاء</Button>
              </div>
            </div>
          )}

          {/* Users list */}
          <div className="rounded-xl border bg-card overflow-hidden">
            {users.length === 0 ? (
              <div className="py-16 text-center">
                <Users className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground font-medium">لا يوجد مستخدمون بعد</p>
                <p className="text-xs text-muted-foreground mt-1">أضف أول مستخدم للشركة</p>
              </div>
            ) : (
              <div className="divide-y">
                {/* Header */}
                <div className="grid items-center gap-3 px-4 py-2.5 bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                  style={{ gridTemplateColumns: "1fr 1fr 0.7fr 0.7fr auto" }}>
                  <span>المستخدم</span>
                  <span>البريد</span>
                  <span>الصلاحية</span>
                  <span>الحالة</span>
                  <span className="w-20 text-center">إجراءات</span>
                </div>
                {users.map((u: any) => (
                  <div key={u.id} className={cn("grid items-center gap-3 px-4 py-3.5 hover:bg-muted/20 transition-colors",
                    !u.isActive && "bg-muted/10 opacity-70")}
                    style={{ gridTemplateColumns: "1fr 1fr 0.7fr 0.7fr auto" }}>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                        {u.username?.[0]?.toUpperCase() ?? "م"}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{u.username}</p>
                        <p className="text-[11px] text-muted-foreground">
                          آخر دخول: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString("ar-SA") : "لم يدخل بعد"}
                        </p>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground truncate font-mono" dir="ltr">{u.email || "—"}</p>
                    <Badge variant="outline" className="text-xs w-fit">
                      {u.role === "admin" ? "مدير" : "مستخدم"}
                    </Badge>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        checked={u.isActive}
                        onCheckedChange={v => toggleUserMutation.mutate({ userId: u.id, isActive: v })}
                      />
                      <span className={cn("text-xs", u.isActive ? "text-green-700" : "text-muted-foreground")}>
                        {u.isActive ? "نشط" : "موقوف"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 w-20 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title="تغيير كلمة المرور"
                        onClick={() => { setResetPassDialog(u); setNewPass(""); }}>
                        <Key className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                        title="حذف المستخدم"
                        onClick={() => {
                          if (confirm(`حذف المستخدم ${u.username}؟`)) deleteUserMutation.mutate(u.id);
                        }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Subscription Tab ─── */}
      {tab === "subscription" && (
        <div className="space-y-4">
          {!subscription ? (
            <div className="rounded-xl border-2 border-dashed py-16 text-center">
              <Package className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground font-medium">لا يوجد اشتراك مرتبط بهذه الشركة</p>
              <p className="text-xs text-muted-foreground mt-1">يُنشأ الاشتراك تلقائياً عند التسجيل أو يمكن إضافته من صفحة إدارة الاشتراكات</p>
            </div>
          ) : (
            <>
              {/* Subscription summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="الباقة" value={planInfo?.label ?? subscription.plan}
                  icon={Package} iconBg="bg-primary/10" iconColor="text-primary"
                />
                <StatCard
                  label="الحد الأقصى للمستخدمين"
                  value={subscription.maxUsers >= 999 ? "∞" : subscription.maxUsers}
                  icon={Users} iconBg="bg-blue-100" iconColor="text-blue-600"
                  sub={`الحالي: ${users.length}`}
                  warn={users.length >= subscription.maxUsers}
                />
                <StatCard
                  label="الحد الأقصى للفواتير"
                  value={subscription.maxInvoices >= 999999 ? "∞" : subscription.maxInvoices}
                  icon={FileText} iconBg="bg-green-100" iconColor="text-green-600"
                  sub={`الحالي: ${counts.invoices}`}
                  warn={counts.invoices >= subscription.maxInvoices}
                />
                <StatCard
                  label="السعر الشهري"
                  value={`${subscription.price} ر.س`}
                  icon={TrendingUp} iconBg="bg-amber-100" iconColor="text-amber-600"
                  sub={subscription.billingCycle === "annual" ? "دورة سنوية" : "دورة شهرية"}
                />
              </div>

              {/* Details card */}
              <div className="rounded-xl border bg-card p-5">
                <h3 className="font-semibold mb-4 text-sm flex items-center gap-2">
                  <Package className="h-4 w-4 text-primary" />تفاصيل الاشتراك
                </h3>
                <div className="space-y-1">
                  <InfoRow label="الباقة" value={
                    <span className={cn("text-xs border rounded-full px-2 py-0.5 font-semibold", planInfo?.color)}>
                      {planInfo?.label ?? subscription.plan}
                    </span>
                  } />
                  <InfoRow label="دورة الفوترة" value={subscription.billingCycle === "annual" ? "سنوية" : "شهرية"} />
                  <InfoRow label="السعر" value={`${subscription.price} ر.س`} ltr />
                  <InfoRow label="تاريخ البداية" value={subscription.startDate} ltr />
                  <InfoRow label="تاريخ الانتهاء" value={
                    <span className={cn("font-mono text-sm", subExpired ? "text-red-600 font-bold" : "")}>
                      {subscription.endDate}
                      {subExpired && " (منتهي)"}
                    </span>
                  } />
                  <InfoRow label="الحالة" value={
                    <span className={cn("text-xs border rounded-full px-2 py-0.5 font-semibold",
                      subscription.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200")}>
                      {subscription.isActive ? "نشط" : "موقوف"}
                    </span>
                  } />
                </div>
              </div>

              <div className="flex justify-end">
                <Button asChild variant="outline" size="sm" className="gap-2">
                  <Link href="/admin/subscriptions">
                    <Pencil className="h-3.5 w-3.5" />تعديل الاشتراك من صفحة الاشتراكات
                  </Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── ZATCA Tab ─── */}
      {tab === "zatca" && (
        <ZatcaIntegration companyId={id} />
      )}

      {/* ─── Data Tab ─── */}
      {tab === "data" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Invoices */}
            <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-sm">الفواتير</p>
                  <p className="text-2xl font-bold text-primary">{counts.invoices}</p>
                </div>
              </div>
              {counts.invoices === 0 ? (
                <p className="text-xs text-muted-foreground">لا توجد فواتير بعد</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {counts.invoices} فاتورة مسجّلة
                  {subscription?.maxInvoices < 999999 && ` من ${subscription.maxInvoices}`}
                </p>
              )}
            </div>

            {/* Customers */}
            <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-lg bg-green-100 flex items-center justify-center">
                  <UserCheck className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">العملاء</p>
                  <p className="text-2xl font-bold text-green-600">{counts.customers}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {counts.customers === 0 ? "لا يوجد عملاء بعد" : `${counts.customers} عميل مسجّل`}
              </p>
            </div>

            {/* Suppliers */}
            <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-lg bg-amber-100 flex items-center justify-center">
                  <Truck className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">الموردون</p>
                  <p className="text-2xl font-bold text-amber-600">{counts.suppliers}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {counts.suppliers === 0 ? "لا يوجد موردون بعد" : `${counts.suppliers} مورد مسجّل`}
              </p>
            </div>
          </div>

          {/* Empty state notice */}
          {counts.invoices === 0 && counts.customers === 0 && counts.suppliers === 0 && (
            <div className="rounded-xl border-2 border-dashed border-muted p-8 text-center">
              <BarChart3 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground font-medium">الشركة جديدة — البيانات فارغة</p>
              <p className="text-xs text-muted-foreground mt-1">
                ستظهر الفواتير والعملاء والموردون هنا بعد أن يبدأ مستخدمو الشركة العمل
              </p>
            </div>
          )}
        </div>
      )}

      {/* Reset Password Dialog */}
      <Dialog open={!!resetPassDialog} onOpenChange={() => setResetPassDialog(null)}>
        <DialogContent dir="rtl" className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-5 w-5 text-primary" />
              تغيير كلمة مرور: {resetPassDialog?.username}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">كلمة المرور الجديدة</Label>
              <div className="relative">
                <Input
                  type={showPass ? "text" : "password"}
                  value={newPass}
                  onChange={e => setNewPass(e.target.value)}
                  placeholder="••••••••"
                  dir="ltr"
                  className="pl-9"
                />
                <button type="button" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setShowPass(v => !v)}>
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetPassDialog(null)}>إلغاء</Button>
            <Button
              disabled={!newPass || resetPassMutation.isPending}
              onClick={() => resetPassMutation.mutate({ userId: resetPassDialog.id, password: newPass })}>
              <Key className="h-4 w-4 ml-2" />
              {resetPassMutation.isPending ? "جاري الحفظ..." : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
