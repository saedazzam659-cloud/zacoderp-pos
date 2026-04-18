import { useParams, Link } from "wouter";
import { useGetCompany } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Building2, CheckCircle2, XCircle, AlertTriangle, Fingerprint, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";

export default function CompanyDetails() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);

  const { data: company, isLoading } = useGetCompany(id, {
    query: { enabled: !!id, queryKey: ["company", id] }
  });

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (!company) {
    return <div className="p-8 text-center">الشركة غير موجودة</div>;
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="icon">
            <Link href="/companies">
              <ArrowRight className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{company.nameAr}</h1>
              <Badge variant={company.isSandbox ? "outline" : "default"}>
                {company.isSandbox ? "Sandbox محاكاة" : "Production إنتاج"}
              </Badge>
              {company.zatcaPcsid && (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                  <CheckCircle2 className="h-3 w-3 mr-1 ml-1" />
                  مكتمل الربط
                </Badge>
              )}
            </div>
            {company.nameEn && <p className="text-muted-foreground mt-1">{company.nameEn}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/invoices?companyId=${company.id}`}>الفواتير</Link>
          </Button>
          <Button asChild>
            <Link href={`/invoices/new?companyId=${company.id}`}>إنشاء فاتورة</Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general" className="w-full" dir="rtl">
        <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-6">
          <TabsTrigger value="general" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 font-medium">
            عام
          </TabsTrigger>
          <TabsTrigger value="settings" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 font-medium">
            المفتاح والإعدادات
          </TabsTrigger>
          <TabsTrigger value="csid" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 font-medium">
            الشهادة الأولية CSID
          </TabsTrigger>
          <TabsTrigger value="pcsid" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 font-medium">
            الشهادة النهائية PCSID
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="general" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  بيانات الشركة
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">الرقم الضريبي:</span>
                  <span className="font-medium" dir="ltr">{company.vatNumber}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">رقم السجل التجاري:</span>
                  <span className="font-medium" dir="ltr">{company.crNumber}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">مجال الصناعة:</span>
                  <span className="font-medium">{company.industryName || '-'}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">تاريخ التسجيل:</span>
                  <span className="font-medium" dir="ltr">
                    {company.createdAt ? format(new Date(company.createdAt), 'PPP', { locale: arSA }) : '-'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">أنواع الفواتير:</span>
                  <span className="font-medium">
                    {company.invoiceType === 'both' ? 'ضريبية ومبسطة' : 
                     company.invoiceType === 'standard' ? 'ضريبية فقط' : 'مبسطة فقط'}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">العنوان الوطني</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">المدينة:</span>
                  <span className="font-medium">{company.city}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">الحي:</span>
                  <span className="font-medium">{company.district || '-'}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">الشارع والمبنى:</span>
                  <span className="font-medium">{company.street} - {company.buildingNumber}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm border-b pb-2">
                  <span className="text-muted-foreground">الرمز البريدي:</span>
                  <span className="font-medium" dir="ltr">{company.postalCode}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">الرقم الإضافي:</span>
                  <span className="font-medium" dir="ltr">{company.additionalNumber || '-'}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Fingerprint className="h-5 w-5 text-primary" />
                أرقام السيريال المميزة
              </CardTitle>
              <CardDescription>هذه الأرقام تستخدم في إنشاء مفاتيح الربط مع هيئة الزكاة</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-muted/30 rounded-lg p-4 border font-mono text-sm" dir="ltr">
                {company.serialNumber || (company.deviceSerial1 && `${company.deviceSerial1}|${company.deviceSerial2}|${company.deviceSerial3}`) || 'غير محدد'}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="csid" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                حالة الشهادة الأولية (CSID)
              </CardTitle>
              <CardDescription>الشهادة اللازمة لإصدار الفواتير التجريبية والمراجعة</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {company.zatcaCsid ? (
                <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-900/30 rounded-lg p-4 flex items-start gap-4">
                  <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-500 shrink-0 mt-1" />
                  <div>
                    <h4 className="font-medium text-green-900 dark:text-green-400 mb-1">الشهادة الأولية مُصدرة وصالحة</h4>
                    <p className="text-sm text-green-700 dark:text-green-500/80 mb-3">تم إصدار الشهادة بنجاح والشركة جاهزة لمرحلة الاختبار.</p>
                    <div className="bg-white dark:bg-black/20 p-2 rounded text-xs font-mono break-all text-muted-foreground border border-green-100 dark:border-green-900/20">
                      {company.zatcaCsid.substring(0, 40)}...
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-900/30 rounded-lg p-4 flex items-start gap-4">
                  <AlertTriangle className="h-6 w-6 text-yellow-600 dark:text-yellow-500 shrink-0 mt-1" />
                  <div>
                    <h4 className="font-medium text-yellow-900 dark:text-yellow-400 mb-1">الشهادة الأولية غير متوفرة</h4>
                    <p className="text-sm text-yellow-700 dark:text-yellow-500/80 mb-3">يجب إصدار الشهادة الأولية للتمكن من ربط المنشأة.</p>
                    <Button variant="outline" className="bg-white dark:bg-black/20 hover:bg-yellow-100 dark:hover:bg-yellow-900/30">
                      إصدار شهادة CSID الآن
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pcsid" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                حالة الشهادة النهائية (PCSID)
              </CardTitle>
              <CardDescription>الشهادة النهائية اللازمة لإصدار واعتماد الفواتير في بيئة الإنتاج</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!company.zatcaCsid ? (
                <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-lg p-4 flex items-start gap-4">
                  <XCircle className="h-6 w-6 text-red-600 dark:text-red-500 shrink-0 mt-1" />
                  <div>
                    <h4 className="font-medium text-red-900 dark:text-red-400 mb-1">متطلبات غير مكتملة</h4>
                    <p className="text-sm text-red-700 dark:text-red-500/80">يجب استخراج الشهادة الأولية (CSID) أولاً قبل طلب الشهادة النهائية.</p>
                  </div>
                </div>
              ) : company.zatcaPcsid ? (
                <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-900/30 rounded-lg p-4 flex items-start gap-4">
                  <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-500 shrink-0 mt-1" />
                  <div>
                    <h4 className="font-medium text-green-900 dark:text-green-400 mb-1">الشهادة النهائية مُصدرة</h4>
                    <p className="text-sm text-green-700 dark:text-green-500/80 mb-3">الشركة مرتبطة بنجاح بنظام هيئة الزكاة وجاهزة لإصدار الفواتير.</p>
                    <div className="bg-white dark:bg-black/20 p-2 rounded text-xs font-mono break-all text-muted-foreground border border-green-100 dark:border-green-900/20">
                      {company.zatcaPcsid.substring(0, 40)}...
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-900/30 rounded-lg p-4 flex items-start gap-4">
                  <AlertTriangle className="h-6 w-6 text-blue-600 dark:text-blue-500 shrink-0 mt-1" />
                  <div>
                    <h4 className="font-medium text-blue-900 dark:text-blue-400 mb-1">جاهز لطلب الشهادة النهائية</h4>
                    <p className="text-sm text-blue-700 dark:text-blue-500/80 mb-3">الشهادة الأولية متوفرة. يمكنك الآن طلب الشهادة النهائية للربط مع بيئة {company.isSandbox ? "المحاكاة" : "الإنتاج"}.</p>
                    <Button className="bg-blue-600 hover:bg-blue-700 text-white">
                      طلب شهادة PCSID
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
