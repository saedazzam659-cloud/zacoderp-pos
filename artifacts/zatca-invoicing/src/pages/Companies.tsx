import { useListCompanies } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Building2, ExternalLink, ShieldCheck, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Companies() {
  const { data: companies, isLoading } = useListCompanies({
    query: { queryKey: ["companies"] }
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">الشركات</h1>
          <p className="text-muted-foreground mt-1">إدارة الشركات المسجلة في نظام الفوترة الإلكترونية</p>
        </div>
        <Button asChild>
          <Link href="/companies/new" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <span>إضافة شركة</span>
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4 mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <div className="pt-4 flex justify-between">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </CardContent>
            </Card>
          ))
        ) : companies?.length === 0 ? (
          <div className="col-span-full py-12 text-center border rounded-lg bg-card text-muted-foreground border-dashed">
            <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <h3 className="text-lg font-medium text-foreground mb-1">لا توجد شركات مسجلة</h3>
            <p className="mb-4">ابدأ بإضافة أول شركة لنظام الفوترة الإلكترونية الخاص بك</p>
            <Button asChild variant="outline">
              <Link href="/companies/new">إضافة شركة جديدة</Link>
            </Button>
          </div>
        ) : (
          companies?.map((company) => (
            <Card key={company.id} className="flex flex-col hover:border-primary transition-colors">
              <CardHeader>
                <div className="flex justify-between items-start mb-2">
                  <CardTitle className="text-lg">{company.nameAr}</CardTitle>
                  <Badge variant={company.zatcaPcsid ? "default" : "secondary"} className="shrink-0">
                    {company.zatcaPcsid ? "مسجلة ZATCA" : "غير مسجلة"}
                  </Badge>
                </div>
                {company.nameEn && <CardDescription>{company.nameEn}</CardDescription>}
              </CardHeader>
              <CardContent className="flex-1 flex flex-col space-y-4">
                <div className="space-y-2 text-sm flex-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">الرقم الضريبي:</span>
                    <span className="font-medium">{company.vatNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">السجل التجاري:</span>
                    <span className="font-medium">{company.crNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">نوع الفاتورة:</span>
                    <span className="font-medium">
                      {company.invoiceType === 'standard' ? 'ضريبية' : 
                       company.invoiceType === 'simplified' ? 'مبسطة' : 'ضريبية ومبسطة'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">البيئة:</span>
                    <Badge variant={company.isSandbox ? "outline" : "default"} className="text-[10px] px-1.5 h-4">
                      {company.isSandbox ? "محاكاة Sandbox" : "إنتاج Production"}
                    </Badge>
                  </div>
                </div>
                
                {/* ZATCA status bar */}
                {!company.zatcaPcsid && (
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
                    ${company.zatcaCsid ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-amber-50 text-amber-700 border border-amber-200"}`}>
                    {company.zatcaCsid
                      ? <><ShieldCheck className="h-3.5 w-3.5 shrink-0" /> اكتملت CSID — أكمل الخطوة الأخيرة (PCSID)</>
                      : <><AlertCircle className="h-3.5 w-3.5 shrink-0" /> لم يكتمل الربط مع هيئة الزكاة</>
                    }
                  </div>
                )}
                {company.zatcaPcsid && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> مسجّلة وجاهزة لإصدار الفواتير
                  </div>
                )}
                
                <div className="pt-3 border-t flex items-center gap-2">
                  {!company.zatcaPcsid && (
                    <Button asChild size="sm" className="flex-1 gap-1.5">
                      <Link href={`/companies/${company.id}?tab=zatca`}>
                        <ShieldCheck className="h-3.5 w-3.5" />
                        ربط ZATCA
                      </Link>
                    </Button>
                  )}
                  <Button asChild variant="ghost" size="sm" className={`gap-1.5 ${!company.zatcaPcsid ? "" : "flex-1"}`}>
                    <Link href={`/companies/${company.id}`}>
                      <span>التفاصيل</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
