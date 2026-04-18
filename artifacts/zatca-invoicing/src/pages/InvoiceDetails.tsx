import { useParams, Link } from "wouter";
import { useGetInvoice, useIssueInvoice, useCancelInvoice } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, FileText, CheckCircle2, AlertTriangle, XCircle, Send, Printer, Ban } from "lucide-react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";

export default function InvoiceDetails() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: invoice, isLoading } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: ["invoice", id] }
  });

  const issueInvoice = useIssueInvoice();
  const cancelInvoice = useCancelInvoice();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(amount);
  };

  const handleIssue = () => {
    if (!confirm("هل أنت متأكد من إصدار هذه الفاتورة؟ سيتم إرسالها لهيئة الزكاة ولا يمكن تعديلها بعد ذلك.")) return;
    
    issueInvoice.mutate({ data: { invoiceId: id } }, {
      onSuccess: () => {
        toast({ title: "تم الإصدار بنجاح", description: "تم إصدار الفاتورة وتوليد QR Code." });
        queryClient.invalidateQueries({ queryKey: ["invoice", id] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
      },
      onError: () => {
        toast({ title: "حدث خطأ", description: "لم نتمكن من إصدار الفاتورة.", variant: "destructive" });
      }
    });
  };

  const handleCancel = () => {
    if (!confirm("هل أنت متأكد من إلغاء هذه الفاتورة؟")) return;
    
    cancelInvoice.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "تم الإلغاء", description: "تم إلغاء الفاتورة." });
        queryClient.invalidateQueries({ queryKey: ["invoice", id] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
      },
      onError: () => {
        toast({ title: "حدث خطأ", description: "لم نتمكن من إلغاء الفاتورة.", variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-[600px] w-full" /></div>;
  }

  if (!invoice) {
    return <div className="p-8 text-center">الفاتورة غير موجودة</div>;
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="icon">
            <Link href="/invoices">
              <ArrowRight className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">فاتورة #{invoice.invoiceNumber}</h1>
              {invoice.status === 'issued' ? (
                <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-transparent dark:bg-green-900/30 dark:text-green-400">مصدرة</Badge>
              ) : invoice.status === 'draft' ? (
                <Badge variant="secondary">مسودة</Badge>
              ) : (
                <Badge variant="destructive">ملغاة</Badge>
              )}
              
              {invoice.zatcaStatus === 'cleared' || invoice.zatcaStatus === 'reported' ? (
                <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 border-transparent dark:bg-blue-900/30 dark:text-blue-400">ZATCA ✓</Badge>
              ) : invoice.zatcaStatus === 'rejected' ? (
                <Badge variant="destructive" className="bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400">ZATCA ✕</Badge>
              ) : invoice.zatcaStatus === 'pending' ? (
                <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-transparent dark:bg-yellow-900/30 dark:text-yellow-400">ZATCA ⟳</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-1">تاريخ الإصدار: {format(new Date(invoice.issueDate), 'PPPP', { locale: arSA })}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {invoice.status === 'draft' && (
            <>
              <Button variant="destructive" onClick={handleCancel} disabled={cancelInvoice.isPending}>
                <Ban className="h-4 w-4 ml-2" />
                إلغاء المسودة
              </Button>
              <Button onClick={handleIssue} disabled={issueInvoice.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                <Send className="h-4 w-4 ml-2" />
                إصدار واعتماد (ZATCA)
              </Button>
            </>
          )}
          {invoice.status === 'issued' && (
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="h-4 w-4 ml-2" />
              طباعة / PDF
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Invoice View */}
        <Card className="lg:col-span-2 overflow-hidden print:shadow-none print:border-0">
          <CardHeader className="bg-muted/20 border-b border-dashed print:bg-transparent">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-xl font-bold">{invoice.company?.nameAr}</h2>
                {invoice.company?.nameEn && <p className="text-sm text-muted-foreground">{invoice.company?.nameEn}</p>}
                <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                  <p>الرقم الضريبي: <span dir="ltr">{invoice.company?.vatNumber}</span></p>
                  <p>العنوان: {invoice.company?.city} - {invoice.company?.street}</p>
                </div>
              </div>
              <div className="text-left">
                <h2 className="text-xl font-bold text-primary">
                  {invoice.invoiceType === 'standard' ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة'}
                </h2>
                <p className="text-sm text-muted-foreground mt-1 font-medium" dir="ltr">{invoice.invoiceNumber}</p>
                <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                  <p>التاريخ: {format(new Date(invoice.issueDate), 'yyyy-MM-dd')}</p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {invoice.customer && (
              <div className="mb-8 p-4 rounded-lg bg-muted/10 border border-muted">
                <h3 className="text-sm font-semibold mb-3">فاتورة إلى:</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="font-medium">{invoice.customer.nameAr}</p>
                    {invoice.customer.nameEn && <p className="text-muted-foreground">{invoice.customer.nameEn}</p>}
                  </div>
                  <div className="text-left">
                    {invoice.customer.vatNumber && <p>الرقم الضريبي: <span dir="ltr">{invoice.customer.vatNumber}</span></p>}
                    {invoice.customer.city && <p>{invoice.customer.city}</p>}
                  </div>
                </div>
              </div>
            )}

            <div className="w-full overflow-auto">
              <table className="w-full caption-bottom text-sm border-collapse">
                <thead className="[&_tr]:border-b bg-muted/30">
                  <tr className="border-b">
                    <th className="h-10 px-4 text-right align-middle font-medium">الوصف</th>
                    <th className="h-10 px-4 text-right align-middle font-medium">الكمية</th>
                    <th className="h-10 px-4 text-right align-middle font-medium">السعر</th>
                    <th className="h-10 px-4 text-right align-middle font-medium">الخصم</th>
                    <th className="h-10 px-4 text-right align-middle font-medium">الضريبة</th>
                    <th className="h-10 px-4 text-right align-middle font-medium">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {invoice.lineItems?.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="p-4 py-3">{item.description}</td>
                      <td className="p-4 py-3" dir="ltr">{item.quantity}</td>
                      <td className="p-4 py-3" dir="ltr">{formatCurrency(item.unitPrice)}</td>
                      <td className="p-4 py-3" dir="ltr">{item.discountAmount ? formatCurrency(item.discountAmount) : '-'}</td>
                      <td className="p-4 py-3" dir="ltr">{item.vatRate}%</td>
                      <td className="p-4 py-3 font-medium" dir="ltr">{formatCurrency(item.total || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-8 flex justify-end">
              <div className="w-full sm:w-1/2 md:w-1/3 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">الإجمالي الخاضع للضريبة:</span>
                  <span dir="ltr">{formatCurrency(invoice.subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">ضريبة القيمة المضافة:</span>
                  <span dir="ltr">{formatCurrency(invoice.vatTotal)}</span>
                </div>
                <div className="h-px bg-border border-b border-dashed"></div>
                <div className="flex justify-between font-bold text-lg">
                  <span>الإجمالي الكلي:</span>
                  <span dir="ltr">{formatCurrency(invoice.grandTotal)}</span>
                </div>
              </div>
            </div>

            {invoice.notes && (
              <div className="mt-8 pt-6 border-t text-sm text-muted-foreground">
                <p className="font-medium mb-1">ملاحظات:</p>
                <p>{invoice.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sidebar / Status / QR */}
        <div className="space-y-6 print:hidden">
          {invoice.qrCode ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-center gap-2">
                  <FileText className="h-4 w-4" />
                  رمز الاستجابة السريعة (QR)
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center justify-center p-6 pt-2">
                <div className="bg-white p-4 rounded-lg shadow-sm border inline-block mb-4">
                  <img src={`data:image/png;base64,${invoice.qrCode}`} alt="QR Code" className="w-48 h-48" />
                </div>
                <p className="text-xs text-center text-muted-foreground">
                  متوافق مع متطلبات هيئة الزكاة والضريبة والجمارك الفنية.
                </p>
              </CardContent>
            </Card>
          ) : invoice.status === 'draft' && (
            <Card className="border-dashed border-muted-foreground/50 bg-muted/10">
              <CardContent className="flex flex-col items-center justify-center p-8 text-center">
                <div className="h-24 w-24 border-2 border-dashed rounded-lg border-muted-foreground/30 flex items-center justify-center mb-4">
                  <FileText className="h-8 w-8 text-muted-foreground/30" />
                </div>
                <p className="text-sm font-medium">الـ QR Code غير متاح حالياً</p>
                <p className="text-xs text-muted-foreground mt-1">سيتم توليد الرمز عند إصدار الفاتورة واعتمادها.</p>
              </CardContent>
            </Card>
          )}

          {invoice.status === 'issued' && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">حالة التكامل (Integration)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-3">
                  {invoice.zatcaStatus === 'cleared' || invoice.zatcaStatus === 'reported' ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                  ) : invoice.zatcaStatus === 'rejected' ? (
                    <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {invoice.zatcaStatus === 'cleared' ? 'تم الفسح (Cleared)' :
                       invoice.zatcaStatus === 'reported' ? 'تم التبليغ (Reported)' :
                       invoice.zatcaStatus === 'rejected' ? 'مرفوضة (Rejected)' :
                       'قيد المعالجة'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {invoice.invoiceHash ? 'تم ختم الفاتورة وتشفيرها بنجاح.' : 'جاري انتظار استجابة منصة هيئة الزكاة.'}
                    </p>
                  </div>
                </div>
                {invoice.invoiceHash && (
                  <div className="pt-3 border-t">
                    <p className="text-xs font-medium mb-1">Hash:</p>
                    <p className="text-[10px] font-mono break-all text-muted-foreground bg-muted p-2 rounded">
                      {invoice.invoiceHash}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
