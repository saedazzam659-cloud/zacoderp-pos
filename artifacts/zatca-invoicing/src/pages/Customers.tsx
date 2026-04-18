import { useListCustomers } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Users, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";

export default function Customers() {
  const [search, setSearch] = useState("");
  
  const { data: customers, isLoading } = useListCustomers(undefined, {
    query: { queryKey: ["customers"] }
  });

  const filteredCustomers = customers?.filter(c => 
    c.nameAr.includes(search) || 
    (c.nameEn && c.nameEn.toLowerCase().includes(search.toLowerCase())) ||
    (c.vatNumber && c.vatNumber.includes(search))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">العملاء</h1>
          <p className="text-muted-foreground mt-1">إدارة بيانات العملاء لإصدار الفواتير لهم</p>
        </div>
        <Button asChild>
          <Link href="/customers/new" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <span>إضافة عميل</span>
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="relative max-w-sm">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="ابحث بالاسم، أو الرقم الضريبي..." 
              className="pl-4 pr-10" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b bg-muted/30">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">الاسم</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">الرقم الضريبي</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">البريد الإلكتروني</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">رقم الهاتف</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">المدينة</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">إجراءات</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b transition-colors">
                      <td className="p-6"><Skeleton className="h-4 w-32" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-32" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-20" /></td>
                      <td className="p-6"><Skeleton className="h-8 w-16" /></td>
                    </tr>
                  ))
                ) : filteredCustomers?.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-12 text-center text-muted-foreground">
                      <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p>لم يتم العثور على عملاء</p>
                    </td>
                  </tr>
                ) : (
                  filteredCustomers?.map((customer) => (
                    <tr key={customer.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-6">
                        <div className="font-medium text-foreground">{customer.nameAr}</div>
                        {customer.nameEn && <div className="text-xs text-muted-foreground">{customer.nameEn}</div>}
                      </td>
                      <td className="p-6" dir="ltr">{customer.vatNumber || '-'}</td>
                      <td className="p-6" dir="ltr">{customer.email || '-'}</td>
                      <td className="p-6" dir="ltr">{customer.phone || '-'}</td>
                      <td className="p-6">{customer.city || '-'}</td>
                      <td className="p-6">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/invoices/new?customerId=${customer.id}`}>فاتورة جديدة</Link>
                        </Button>
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
