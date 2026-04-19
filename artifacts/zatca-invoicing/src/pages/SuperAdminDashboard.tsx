import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, Clock, CheckCircle2, XCircle, Users,
  ArrowLeft, Plus, Package, TrendingUp, AlertTriangle
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SuperAdminDashboard() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/stats`, { headers });
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: recentRequests = [] } = useQuery({
    queryKey: ["admin-requests-pending"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/requests?status=pending`, { headers });
      return res.json();
    },
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">لوحة التحكم الرئيسية</h1>
        <p className="text-muted-foreground mt-1 text-sm">نظرة عامة على النظام وطلبات التسجيل</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "إجمالي الشركات", value: stats?.total ?? "—", icon: Building2, color: "text-primary", bg: "bg-primary/10" },
          { label: "طلبات معلقة",    value: stats?.pending ?? "—", icon: Clock, color: "text-amber-700", bg: "bg-amber-100",
            alert: (stats?.pending ?? 0) > 0 },
          { label: "شركات نشطة",   value: stats?.active ?? "—",  icon: CheckCircle2, color: "text-green-700", bg: "bg-green-100" },
          { label: "مستخدمون",     value: stats?.users ?? "—",   icon: Users, color: "text-blue-700", bg: "bg-blue-100" },
        ].map(s => (
          <Card key={s.label} className={s.alert ? "border-amber-300 bg-amber-50/50" : ""}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                  <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                </div>
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${s.bg}`}>
                  <s.icon className={`h-5 w-5 ${s.color}`} />
                </div>
              </div>
              {s.alert && (
                <div className="flex items-center gap-1 mt-2 text-xs text-amber-700">
                  <AlertTriangle className="h-3 w-3" />بانتظار المراجعة
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-dashed border-2 hover:border-primary/50 transition-colors">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-foreground">طلبات التسجيل</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {(stats?.pending ?? 0) > 0
                    ? `${stats?.pending} طلب بانتظار المراجعة`
                    : "لا توجد طلبات معلقة"}
                </p>
              </div>
              <Button asChild variant={stats?.pending > 0 ? "default" : "outline"} size="sm" className="gap-1.5">
                <Link href="/admin/requests">
                  عرض الكل <ArrowLeft className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-dashed border-2 hover:border-primary/50 transition-colors">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-foreground">إضافة شركة جديدة</p>
                <p className="text-sm text-muted-foreground mt-1">أضف شركة مباشرة بدون انتظار موافقة</p>
              </div>
              <Button asChild size="sm" className="gap-1.5">
                <Link href="/companies/new">
                  <Plus className="h-3.5 w-3.5" />إضافة
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-dashed border-2 hover:border-primary/50 transition-colors md:col-span-2">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-primary/10">
                  <Package className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-foreground">إدارة الاشتراكات والباقات</p>
                  <p className="text-sm text-muted-foreground mt-0.5">تعديل باقات الشركات وبيانات الاشتراك والأسعار</p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link href="/admin/subscriptions">
                  عرض الاشتراكات <ArrowLeft className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent pending requests */}
      {recentRequests.length > 0 && (
        <Card>
          <CardHeader className="border-b bg-amber-50/50 pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-amber-800">
              <Clock className="h-4 w-4" />
              آخر الطلبات المعلقة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="space-y-3">
              {recentRequests.slice(0, 5).map((r: any) => (
                <div key={r.company.id} className="flex items-center justify-between gap-4 py-2 border-b last:border-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0">
                      {r.company.nameAr?.[0]}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-foreground truncate">{r.company.nameAr}</p>
                      <p className="text-xs text-muted-foreground font-mono">{r.company.vatNumber}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground hidden sm:block">
                      {r.subscription?.plan && <span className="bg-muted px-2 py-0.5 rounded-full">{r.subscription.plan}</span>}
                    </span>
                    <Button size="sm" className="h-7 px-2.5 text-xs bg-green-600 hover:bg-green-700 gap-1" asChild>
                      <Link href="/admin/requests">مراجعة</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {recentRequests.length > 5 && (
              <div className="pt-3 text-center">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/admin/requests">عرض جميع الطلبات ({recentRequests.length})</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {recentRequests.length === 0 && stats?.pending === 0 && (
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="pt-5 pb-4 text-center">
            <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
            <p className="text-green-800 font-medium">لا توجد طلبات معلقة</p>
            <p className="text-sm text-green-700 mt-1">جميع طلبات التسجيل تمت معالجتها</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
