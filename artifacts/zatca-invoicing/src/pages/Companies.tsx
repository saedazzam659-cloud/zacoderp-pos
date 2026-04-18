import { useListCompanies } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Building2, ExternalLink } from "lucide-react";
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
                
                <div className="pt-4 border-t flex items-center justify-end">
                  <Button asChild variant="ghost" size="sm" className="gap-2">
                    <Link href={`/companies/${company.id}`}>
                      <span>التفاصيل والإعدادات</span>
                      <ExternalLink className="h-4 w-4" />
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
