import React from "react";
import { 
  useGetDashboardSummary, 
  useGetRecentInvoices,
  useGetMonthlyStats 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, CheckCircle2, XCircle, FileWarning, TrendingUp, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useListCompanies } from "@workspace/api-client-react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useAuth } from "@/contexts/AuthContext";

export default function Dashboard() {
  const { user } = useAuth();
  const companyId = user?.companyId;

  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary(undefined, {
    query: { queryKey: ["dashboard-summary", companyId] }
  });

  const { data: companies } = useListCompanies({ query: { queryKey: ["companies"] } });
  const unregisteredCompanies = companies?.filter(c => !c.zatcaPcsid) ?? [];

  const { data: recentInvoices, isLoading: loadingRecent } = useGetRecentInvoices(undefined, {
    query: { queryKey: ["recent-invoices", companyId] }
  });

  const { data: monthlyStats, isLoading: loadingStats } = useGetMonthlyStats(undefined, {
    query: { queryKey: ["monthly-stats", companyId] }
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(amount);
  };

  const chartData = monthlyStats?.map(stat => ({
    name: stat.month,
    الإيرادات: stat.revenue,
    الضريبة: stat.vatAmount,
    الفواتير: stat.invoiceCount
  })) || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">لوحة التحكم</h1>
        <p className="text-muted-foreground mt-1">نظرة عامة على أداء نظام الفوترة الإلكترونية</p>
      </div>

      {/* ZATCA onboarding banner */}
      {unregisteredCompanies.length > 0 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 rounded-xl border border-amber-200 bg-amber-50">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-800 text-sm">
              {unregisteredCompanies.length === 1
                ? `شركة "${unregisteredCompanies[0].nameAr}" لم تكتمل عملية الربط مع هيئة الزكاة والدخل`
                : `${unregisteredCompanies.length} شركات لم تكتمل عملية الربط مع هيئة الزكاة والدخل`}
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              يجب ربط كل شركة بمنظومة فاتورة قبل إصدار فواتير رسمية
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {unregisteredCompanies.length === 1 ? (
              <Button asChild size="sm" className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
                <Link href={`/companies/${unregisteredCompanies[0].id}?tab=zatca`}>
                  <ShieldCheck className="h-4 w-4" />
                  ربط الشركة الآن
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline" className="gap-2 border-amber-300 text-amber-700 hover:bg-amber-100">
                <Link href="/companies">
                  عرض الشركات
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}

      {loadingSummary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">إجمالي الإيرادات</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(summary?.totalRevenue || 0)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                إجمالي الضريبة: {formatCurrency(summary?.totalVat || 0)}
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">الفواتير المصدرة</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.issuedCount || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">فاتورة معتمدة من هيئة الزكاة</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">مسودات</CardTitle>
              <FileWarning className="h-4 w-4 text-yellow-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.draftCount || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">بانتظار الإصدار</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">الفواتير الملغاة</CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.cancelledCount || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">تم إلغاؤها أو إرجاعها</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Monthly Stats Chart */}
      <Card className="col-span-1">
        <CardHeader>
          <CardTitle>إحصائيات الإيرادات الشهرية</CardTitle>
          <CardDescription>ملخص الإيرادات والضرائب لآخر 12 شهراً</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingStats ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <div className="h-[300px] w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false}
                    tickFormatter={(value) => `${value / 1000}k`}
                  />
                  <Tooltip 
                    cursor={{ fill: 'hsl(var(--muted)/0.5)' }}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                  />
                  <Legend wrapperStyle={{ paddingTop: '20px' }} />
                  <Bar dataKey="الإيرادات" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="الضريبة" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Invoices Table */}
      <Card>
        <CardHeader>
          <CardTitle>أحدث الفواتير</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">رقم الفاتورة</th>
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">التاريخ</th>
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">العميل</th>
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">المبلغ</th>
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">الحالة</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {loadingRecent ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b transition-colors">
                      <td className="p-4"><Skeleton className="h-4 w-20" /></td>
                      <td className="p-4"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-4"><Skeleton className="h-4 w-32" /></td>
                      <td className="p-4"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-4"><Skeleton className="h-6 w-16 rounded-full" /></td>
                    </tr>
                  ))
                ) : recentInvoices?.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      لا توجد فواتير حديثة
                    </td>
                  </tr>
                ) : (
                  recentInvoices?.map((invoice) => (
                    <tr key={invoice.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 font-medium">{invoice.invoiceNumber}</td>
                      <td className="p-4">{format(new Date(invoice.issueDate), 'PP', { locale: arSA })}</td>
                      <td className="p-4">{invoice.customer?.nameAr || 'عميل نقدي'}</td>
                      <td className="p-4 font-medium">{formatCurrency(invoice.grandTotal)}</td>
                      <td className="p-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          invoice.status === 'issued' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                          invoice.status === 'draft' ? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' :
                          'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                        }`}>
                          {invoice.status === 'issued' ? 'مصدرة' : invoice.status === 'draft' ? 'مسودة' : 'ملغاة'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
