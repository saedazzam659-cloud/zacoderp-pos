import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileText, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";

export default function SisterStatementsHub() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sister-companies"],
    queryFn: () => sisterCompaniesApi.list(),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" /> كشف حساب الشركات الشقيقة
        </h1>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          ) : (
            <table className="w-full text-sm" data-testid="table-sister-statements">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-right">#</th>
                  <th className="p-2 text-right">الاسم</th>
                  <th className="p-2 text-right">الرقم الضريبي</th>
                  <th className="p-2 text-right">السجل</th>
                  <th className="p-2 text-right">الحالة</th>
                  <th className="p-2 text-right">الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                    لا توجد شركات شقيقة بعد —
                    <Link href="/inventory/sister-companies"><a className="text-primary underline mx-1">أضف شركة شقيقة</a></Link>
                    أولاً.
                  </td></tr>
                )}
                {rows.map((r: any, i: number) => (
                  <tr key={r.id} className="border-t hover:bg-muted/30" data-testid={`row-sister-${r.id}`}>
                    <td className="p-2">{i + 1}</td>
                    <td className="p-2 font-medium flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      {r.nameAr}
                      {r.nameEn && <span className="text-muted-foreground text-xs">({r.nameEn})</span>}
                    </td>
                    <td className="p-2">{r.vatNumber ?? "—"}</td>
                    <td className="p-2">{r.crNumber ?? "—"}</td>
                    <td className="p-2">
                      {r.isActive
                        ? <span className="text-green-700">نشطة</span>
                        : <span className="text-gray-500">موقوفة</span>}
                    </td>
                    <td className="p-2">
                      <Link href={`/inventory/sister-companies/${r.id}/statement`}>
                        <Button size="sm" variant="outline" data-testid={`btn-statement-${r.id}`}>
                          <FileText className="h-4 w-4 ml-1" /> فتح كشف الحساب
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
