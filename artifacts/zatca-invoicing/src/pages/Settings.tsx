import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  User, Lock, Eye, EyeOff, CheckCircle2, Shield,
  Building2, Package, BadgeCheck, Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLAN_LABELS: Record<string, string> = {
  starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي",
};

export default function Settings() {
  const { user, token, setUser } = useAuth() as any;
  const { toast } = useToast();
  const isSuperAdmin = user?.role === "superadmin";

  // Username form
  const [usernameForm, setUsernameForm] = useState({
    newUsername: user?.username ?? "",
    currentPassword: "",
  });
  const [showPassU, setShowPassU] = useState(false);

  // Password form
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew]         = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const updateMutation = useMutation({
    mutationFn: async (body: any) => {
      const res = await fetch(`${API}/api/auth/profile`, {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "حدث خطأ");
      return data;
    },
    onSuccess: (data, variables) => {
      toast({ title: "✓ " + data.message });
      if (data.username && setUser) {
        setUser((u: any) => ({ ...u, username: data.username }));
      }
      if (variables.newPassword) {
        setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      }
      if (variables.newUsername) {
        setUsernameForm(f => ({ ...f, currentPassword: "" }));
      }
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  // SuperAdmin opt-out + severity threshold for the maintenance critical-digest
  // email. Both fields are stored on the users row and surfaced via
  // /api/auth/me. The PATCH endpoint accepts either field independently so a
  // toggle change and a threshold change don't have to ship together.
  const notifyMaintenanceEmail = (user as any)?.notifyMaintenanceEmail ?? true;
  const notifyMaintenanceSeverity: "critical" | "warning" | "all" =
    ((user as any)?.notifyMaintenanceSeverity as any) ?? "critical";
  type NotificationsPatch = {
    notifyMaintenanceEmail?: boolean;
    notifyMaintenanceSeverity?: "critical" | "warning" | "all";
  };
  const notificationsMutation = useMutation({
    mutationFn: async (patch: NotificationsPatch) => {
      const res = await fetch(`${API}/api/auth/me/notifications`, {
        method: "PUT", headers,
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "تعذّر تحديث تفضيلات التنبيه");
      return data as {
        ok: boolean;
        notifyMaintenanceEmail: boolean;
        notifyMaintenanceSeverity: "critical" | "warning" | "all";
        message: string;
      };
    },
    // Update the cached user immediately so the switch reflects the new state
    // without waiting for a /me round-trip.
    onSuccess: (data) => {
      toast({ title: "✓ " + data.message });
      if (setUser) setUser((u: any) => (u ? {
        ...u,
        notifyMaintenanceEmail:    data.notifyMaintenanceEmail,
        notifyMaintenanceSeverity: data.notifyMaintenanceSeverity,
      } : u));
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleUsernameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!usernameForm.newUsername.trim()) return;
    if (usernameForm.newUsername === user?.username) {
      toast({ title: "اسم المستخدم لم يتغير", variant: "destructive" }); return;
    }
    updateMutation.mutate({
      currentPassword: usernameForm.currentPassword,
      newUsername: usernameForm.newUsername.trim(),
    });
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast({ title: "كلمة المرور الجديدة وتأكيدها غير متطابقتين", variant: "destructive" }); return;
    }
    if (passwordForm.newPassword.length < 8) {
      toast({ title: "كلمة المرور يجب أن تكون 8 أحرف على الأقل", variant: "destructive" }); return;
    }
    updateMutation.mutate({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });
  };

  const passwordStrength = (p: string) => {
    let score = 0;
    if (p.length >= 8)  score++;
    if (p.length >= 12) score++;
    if (/[A-Z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    return score;
  };
  const strength = passwordStrength(passwordForm.newPassword);
  const strengthLabel = ["", "ضعيفة جداً", "ضعيفة", "متوسطة", "قوية", "قوية جداً"][strength] ?? "";
  const strengthColor = ["", "bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-green-500", "bg-green-600"][strength] ?? "";

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Shield className="h-6 w-6 text-primary" />
          إعدادات الحساب
        </h1>
        <p className="text-sm text-muted-foreground mt-1">إدارة بيانات تسجيل الدخول وأمان حسابك</p>
      </div>

      {/* Account info card */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />معلومات الحساب
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-4 py-3">
            <div className={cn("h-10 w-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0",
              isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary/10 text-primary")}>
              {user?.username?.[0]?.toUpperCase() ?? "م"}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide">اسم المستخدم</p>
              <p className="font-semibold text-sm font-mono truncate">{user?.username}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-4 py-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
              <BadgeCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide">الدور</p>
              <p className="font-semibold text-sm">
                {isSuperAdmin ? "مشرف عام" : user?.role === "admin" ? "مدير" : "مستخدم"}
              </p>
            </div>
          </div>
          {!isSuperAdmin && user?.company && (
            <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-4 py-3">
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Building2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide">الشركة</p>
                <p className="font-semibold text-sm truncate">{user.company.nameAr}</p>
              </div>
            </div>
          )}
          {!isSuperAdmin && user?.subscription && (
            <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-4 py-3">
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Package className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide">الباقة</p>
                <p className="font-semibold text-sm">{PLAN_LABELS[user.subscription.plan] ?? user.subscription.plan}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SuperAdmin notification preferences — opt-out for the maintenance
          critical-digest email. Hidden for non-SuperAdmin users since the
          digest only ever targets the SuperAdmin role. */}
      {isSuperAdmin && (
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <h2 className="font-semibold text-base flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            تفضيلات التنبيهات
          </h2>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="notify-maint-email" className="text-sm font-medium">
                تنبيهات بريد صيانة النظام
              </Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                عند التفعيل، تصلك رسالة موجزة عبر البريد الإلكتروني بعد كل فحص يومي يكتشف نتائج حرجة لأي شركة.
                يمكنك إيقاف هذا الإيميل لحسابك دون التأثير على بقية المشرفين العامين.
              </p>
            </div>
            <Switch
              id="notify-maint-email"
              checked={notifyMaintenanceEmail}
              disabled={notificationsMutation.isPending}
              onCheckedChange={(v) => notificationsMutation.mutate({ notifyMaintenanceEmail: v })}
            />
          </div>
          {/* Severity threshold — narrows or widens which sweeps actually email
              this SuperAdmin without touching the global toggle above. Disabled
              while the toggle is off so the choice doesn't look "live" when
              nothing would be sent anyway. */}
          <div className="flex items-start justify-between gap-4 pt-3 border-t">
            <div className="space-y-1">
              <Label htmlFor="notify-maint-severity" className="text-sm font-medium">
                مستوى التنبيهات
              </Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                اختر أدنى مستوى للنتائج التي تستحق إرسال إيميل لك. مثلاً «حرجة فقط» يكتم تحذيرات الفحص اليومي،
                و«جميع الإشعارات» يضيف الأدوات المعطّلة (status=error) إلى التنبيهات.
              </p>
            </div>
            <Select
              value={notifyMaintenanceSeverity}
              disabled={!notifyMaintenanceEmail || notificationsMutation.isPending}
              onValueChange={(v) =>
                notificationsMutation.mutate({
                  notifyMaintenanceSeverity: v as "critical" | "warning" | "all",
                })
              }
            >
              <SelectTrigger
                id="notify-maint-severity"
                className="w-44 shrink-0"
                aria-label="مستوى التنبيهات"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">حرجة فقط</SelectItem>
                <SelectItem value="warning">حرجة وتحذيرات</SelectItem>
                <SelectItem value="all">جميع الإشعارات</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Change username */}
      <div className="rounded-xl border bg-card p-5 space-y-5">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />تغيير اسم المستخدم
        </h2>
        <form onSubmit={handleUsernameSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-username">اسم المستخدم الجديد</Label>
            <Input
              id="new-username"
              value={usernameForm.newUsername}
              onChange={e => setUsernameForm(f => ({ ...f, newUsername: e.target.value }))}
              placeholder="أدخل اسم المستخدم الجديد"
              className="font-mono"
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="current-pass-u">كلمة المرور الحالية (للتحقق)</Label>
            <div className="relative">
              <Input
                id="current-pass-u"
                type={showPassU ? "text" : "password"}
                value={usernameForm.currentPassword}
                onChange={e => setUsernameForm(f => ({ ...f, currentPassword: e.target.value }))}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button type="button"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassU(v => !v)}>
                {showPassU ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <Button type="submit"
            disabled={!usernameForm.newUsername || !usernameForm.currentPassword || updateMutation.isPending}
            className="gap-2 w-full sm:w-auto">
            <CheckCircle2 className="h-4 w-4" />
            {updateMutation.isPending ? "جاري الحفظ..." : "حفظ اسم المستخدم"}
          </Button>
        </form>
      </div>

      {/* Change password */}
      <div className="rounded-xl border bg-card p-5 space-y-5">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />تغيير كلمة المرور
        </h2>
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-pass">كلمة المرور الحالية</Label>
            <div className="relative">
              <Input
                id="current-pass"
                type={showCurrent ? "text" : "password"}
                value={passwordForm.currentPassword}
                onChange={e => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button type="button"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowCurrent(v => !v)}>
                {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-pass">كلمة المرور الجديدة</Label>
            <div className="relative">
              <Input
                id="new-pass"
                type={showNew ? "text" : "password"}
                value={passwordForm.newPassword}
                onChange={e => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                placeholder="••••••••"
                autoComplete="new-password"
              />
              <button type="button"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowNew(v => !v)}>
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {/* Strength meter */}
            {passwordForm.newPassword.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className={cn("h-1.5 flex-1 rounded-full transition-colors",
                      i <= strength ? strengthColor : "bg-muted")} />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  قوة كلمة المرور: <span className="font-medium">{strengthLabel}</span>
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              يجب أن تحتوي على 8 أحرف على الأقل، مزيج من الأحرف والأرقام والرموز
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-pass">تأكيد كلمة المرور الجديدة</Label>
            <div className="relative">
              <Input
                id="confirm-pass"
                type={showConfirm ? "text" : "password"}
                value={passwordForm.confirmPassword}
                onChange={e => setPasswordForm(f => ({ ...f, confirmPassword: e.target.value }))}
                placeholder="••••••••"
                autoComplete="new-password"
                className={cn(
                  passwordForm.confirmPassword && passwordForm.newPassword !== passwordForm.confirmPassword
                    ? "border-destructive focus-visible:ring-destructive"
                    : passwordForm.confirmPassword && passwordForm.newPassword === passwordForm.confirmPassword
                    ? "border-green-500 focus-visible:ring-green-500" : ""
                )}
              />
              <button type="button"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowConfirm(v => !v)}>
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {passwordForm.confirmPassword && passwordForm.newPassword !== passwordForm.confirmPassword && (
              <p className="text-xs text-destructive">كلمتا المرور غير متطابقتين</p>
            )}
            {passwordForm.confirmPassword && passwordForm.newPassword === passwordForm.confirmPassword && (
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />كلمتا المرور متطابقتان
              </p>
            )}
          </div>
          <Button type="submit"
            disabled={
              !passwordForm.currentPassword ||
              !passwordForm.newPassword ||
              !passwordForm.confirmPassword ||
              passwordForm.newPassword !== passwordForm.confirmPassword ||
              updateMutation.isPending
            }
            className="gap-2 w-full sm:w-auto">
            <Lock className="h-4 w-4" />
            {updateMutation.isPending ? "جاري الحفظ..." : "تغيير كلمة المرور"}
          </Button>
        </form>
      </div>

    </div>
  );
}
