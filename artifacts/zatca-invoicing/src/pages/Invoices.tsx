import { useListInvoices } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Search, FileText, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function Invoices() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
  const { data: invoices, isLoading } = useListInvoices(
    statusFilter !== "all" ? { status: statusFilter as any } : undefined, 
    { query: { queryKey: ["invoices", statusFilter] } }
  );

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(amount);
  };

  const filteredInvoices = invoices?.filter(inv => 
    inv.invoiceNumber.includes(search) || 
    (inv.customer?.nameAr.includes(search))
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'issued':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-transparent dark:bg-green-900/30 dark:text-green-400">مصدرة</Badge>;
      case 'draft':
        return <Badge variant="secondary">مسودة</Badge>;
      case 'cancelled':
        return <Badge variant="destructive" className="bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400">ملغاة</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getZatcaBadge = (status?: string) => {
    if (!status) return null;
    switch (status) {
      case 'cleared':
      case 'reported':
        return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 border-transparent dark:bg-blue-900/30 dark:text-blue-400">ZATCA ✓</Badge>;
      case 'rejected':
        return <Badge variant="destructive" className="bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400">ZATCA ✕</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-transparent dark:bg-yellow-900/30 dark:text-yellow-400">ZATCA ⟳</Badge>;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">الفواتير</h1>
          <p className="text-muted-foreground mt-1">إدارة فواتير المبيعات الإلكترونية</p>
        </div>
        <Button asChild>
          <Link href="/invoices/new" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <span>إنشاء فاتورة جديدة</span>
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="relative w-full md:w-80">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="رقم الفاتورة، اسم العميل..." 
              className="pl-4 pr-10" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-40">
                <SelectValue placeholder="الحالة" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="issued">مصدرة</SelectItem>
                <SelectItem value="draft">مسودة</SelectItem>
                <SelectItem value="cancelled">ملغاة</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b bg-muted/30">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">رقم الفاتورة</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">تاريخ الإصدار</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">العميل</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">المبلغ الإجمالي</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">الحالة</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">هيئة الزكاة</th>
                  <th className="h-12 px-6 text-right align-middle font-medium text-muted-foreground">إجراءات</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b transition-colors">
                      <td className="p-6"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-32" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-40" /></td>
                      <td className="p-6"><Skeleton className="h-4 w-24" /></td>
                      <td className="p-6"><Skeleton className="h-6 w-16 rounded-full" /></td>
                      <td className="p-6"><Skeleton className="h-6 w-16 rounded-full" /></td>
                      <td className="p-6"><Skeleton className="h-8 w-20" /></td>
                    </tr>
                  ))
                ) : filteredInvoices?.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-muted-foreground">
                      <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p>لا توجد فواتير مطابقة للبحث</p>
                    </td>
                  </tr>
                ) : (
                  filteredInvoices?.map((invoice) => (
                    <tr key={invoice.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-6 font-medium" dir="ltr">{invoice.invoiceNumber}</td>
                      <td className="p-6">{format(new Date(invoice.issueDate), 'PP', { locale: arSA })}</td>
                      <td className="p-6">{invoice.customer?.nameAr || 'عميل نقدي'}</td>
                      <td className="p-6 font-bold">{formatCurrency(invoice.grandTotal)}</td>
                      <td className="p-6">{getStatusBadge(invoice.status)}</td>
                      <td className="p-6">{getZatcaBadge(invoice.zatcaStatus)}</td>
                      <td className="p-6 flex items-center gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/invoices/${invoice.id}`}>عرض</Link>
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
