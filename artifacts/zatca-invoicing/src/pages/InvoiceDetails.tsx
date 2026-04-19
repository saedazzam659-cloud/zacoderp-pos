import { useState } from "react";
import { useParams, Link } from "wouter";
import { useGetInvoice, useIssueInvoice, useCancelInvoice } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, FileText, CheckCircle2, AlertTriangle, XCircle,
  Send, Printer, Ban, Upload, Loader2, Copy, FileCode2, Clock
} from "lucide-react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import { QRCodeSVG } from "qrcode.react";

function ZatcaQrCode({ base64Tlv }: { base64Tlv: string }) {
  const binaryStr = atob(base64Tlv);
  return (
    <QRCodeSVG
      value={binaryStr}
      size={192}
      level="M"
      className="block"
    />
  );
}

export default function InvoiceDetails() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submittingZatca, setSubmittingZatca] = useState(false);
  const [showXml, setShowXml] = useState(false);

  const { data: invoice, isLoading } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: ["invoice", id] }
  });

  const issueInvoice = useIssueInvoice();
  const cancelInvoice = useCancelInvoice();

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(amount);

  const handleIssue = () => {
    if (!confirm("هل أنت متأكد من إصدار هذه الفاتورة؟ سيتم توليد XML وQR Code ولا يمكن تعديلها بعد ذلك.")) return;
    issueInvoice.mutate({ data: { invoiceId: id } }, {
      onSuccess: () => {
        toast({ title: "تم الإصدار بنجاح", description: "تم توليد QR Code وXML UBL 2.1 بنجاح." });
        queryClient.invalidateQueries({ queryKey: ["invoice", id] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
      },
      onError: (err) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "لم نتمكن من إصدار الفاتورة.";
        toast({ title: "حدث خطأ", description: msg, variant: "destructive" });
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

  const handleSubmitZatca = async () => {
    if (!confirm("هل تريد إرسال الفاتورة إلى منصة ZATCA؟ تأكد من أن الشركة لديها شهادة CSID أو PCSID.")) return;
    setSubmittingZatca(true);
    try {
      const res = await fetch(`/api/invoices/${id}/submit`, { method: "POST" });
      const data = await res.json() as {
        success?: boolean;
        zatcaStatus?: string;
        message?: string;
        error?: string;
        hint?: string;
        warningMessages?: Array<{ code: string; message: string }>;
      };
      if (data.success) {
        toast({ title: "تم الإرسال بنجاح", description: data.message });
      } else {
        toast({
          title: "فشل الإرسال إلى ZATCA",
          description: data.error ?? "خطأ غير معروف",
          variant: "destructive"
        });
      }
      queryClient.invalidateQueries({ queryKey: ["invoice", id] });
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setSubmittingZatca(false);
    }
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-[600px] w-full" /></div>;
  }

  if (!invoice) {
    return <div className="p-8 text-center">الفاتورة غير موجودة</div>;
  }

  const inv = invoice as typeof invoice & {
    xmlContent?: string | null;
    invoiceCounterValue?: number | null;
    previousInvoiceHash?: string | null;
    zatcaWarningMessages?: string | null;
    zatcaErrorMessages?: string | null;
    zatcaClearanceStatus?: string | null;
  };

  const warningMessages = inv.zatcaWarningMessages ? JSON.parse(inv.zatcaWarningMessages) as Array<{ code: string; message: string }> : [];
  const errorMessages = inv.zatcaErrorMessages ? JSON.parse(inv.zatcaErrorMessages) as Array<{ code: string; message: string }> : [];

  const zatcaDone = inv.zatcaStatus === "cleared" || inv.zatcaStatus === "reported";
  const zatcaRejected = inv.zatcaStatus === "rejected";
  const zatcaPending = inv.zatcaStatus === "pending";

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="icon">
            <Link href="/invoices"><ArrowRight className="h-5 w-5" /></Link>
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold" dir="ltr">{invoice.invoiceNumber}</h1>
              <Badge variant={invoice.status === "issued" ? "default" : invoice.status === "draft" ? "secondary" : "destructive"}>
                {invoice.status === "issued" ? "مصدرة" : invoice.status === "draft" ? "مسودة" : "ملغاة"}
              </Badge>
              {zatcaDone && <Badge className="bg-green-100 text-green-800">ZATCA ✓</Badge>}
              {zatcaRejected && <Badge variant="destructive">ZATCA مرفوضة</Badge>}
              {zatcaPending && <Badge className="bg-yellow-100 text-yellow-800"><Clock className="h-3 w-3 mr-1" />بانتظار ZATCA</Badge>}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {format(new Date(invoice.issueDate), "PPPP", { locale: arSA })}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          {invoice.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={cancelInvoice.isPending}>
                <Ban className="h-4 w-4 ml-1.5" />إلغاء المسودة
              </Button>
              <Button size="sm" onClick={handleIssue} disabled={issueInvoice.isPending}>
                {issueInvoice.isPending ? <><Loader2 className="h-4 w-4 animate-spin ml-1.5" />جاري الإصدار...</> : <><Send className="h-4 w-4 ml-1.5" />إصدار واعتماد</>}
              </Button>
            </>
          )}
          {invoice.status === "issued" && (
            <>
              {zatcaPending && (
                <Button
                  size="sm"
                  onClick={handleSubmitZatca}
                  disabled={submittingZatca}
                  className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
                >
                  {submittingZatca ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الإرسال...</> : <><Upload className="h-4 w-4" />إرسال لـ ZATCA</>}
                </Button>
              )}
              {inv.xmlContent && (
                <Button size="sm" variant="outline" onClick={() => setShowXml(!showXml)} className="gap-1.5">
                  <FileCode2 className="h-4 w-4" />
                  {showXml ? "إخفاء XML" : "عرض XML"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => window.print()} className="gap-1.5">
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          )}
        </div>
      </div>

      {/* XML Viewer */}
      {showXml && inv.xmlContent && (
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileCode2 className="h-5 w-5 text-primary" /> UBL 2.1 XML — فاتورة ZATCA
            </CardTitle>
            <Button size="sm" variant="ghost" className="gap-1.5 text-xs"
              onClick={() => navigator.clipboard.writeText(inv.xmlContent!).then(() => toast({ title: "تم نسخ XML" }))}>
              <Copy className="h-3 w-3" /> نسخ
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/30 rounded border p-4 text-xs font-mono overflow-auto max-h-96 text-left whitespace-pre" dir="ltr">
              {inv.xmlContent}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ZATCA Errors/Warnings */}
      {(errorMessages.length > 0 || warningMessages.length > 0) && (
        <div className="space-y-2">
          {errorMessages.map((err, i) => (
            <div key={i} className="flex gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
              <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <div><span className="font-mono text-red-700">[{err.code}]</span> {err.message}</div>
            </div>
          ))}
          {warningMessages.map((w, i) => (
            <div key={i} className="flex gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
              <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
              <div><span className="font-mono text-yellow-700">[{w.code}]</span> {w.message}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Invoice Document */}
        <Card className="lg:col-span-2 overflow-hidden print:shadow-none print:border-0">
          <CardHeader className="bg-muted/20 border-b border-dashed print:bg-transparent">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-xl font-bold">{invoice.company?.nameAr}</h2>
                {invoice.company?.nameEn && <p className="text-sm text-muted-foreground">{invoice.company.nameEn}</p>}
                <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                  <p>الرقم الضريبي: <span dir="ltr">{invoice.company?.vatNumber}</span></p>
                  <p>العنوان: {invoice.company?.city} - {invoice.company?.street}</p>
                </div>
              </div>
              <div className="text-left">
                <h2 className="text-xl font-bold text-primary">
                  {invoice.invoiceType === "standard" ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة"}
                </h2>
                <p className="text-sm text-muted-foreground mt-1 font-medium" dir="ltr">{invoice.invoiceNumber}</p>
                <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                  <p>التاريخ: {format(new Date(invoice.issueDate), "yyyy-MM-dd")}</p>
                  {inv.invoiceCounterValue && <p>رقم متسلسل: {inv.invoiceCounterValue}</p>}
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
              <table className="w-full text-sm border-collapse">
                <thead className="bg-muted/30">
                  <tr className="border-b">
                    <th className="h-10 px-4 text-right font-medium">الوصف</th>
                    <th className="h-10 px-4 text-right font-medium">الكمية</th>
                    <th className="h-10 px-4 text-right font-medium">السعر</th>
                    <th className="h-10 px-4 text-right font-medium">الخصم</th>
                    <th className="h-10 px-4 text-right font-medium">الضريبة</th>
                    <th className="h-10 px-4 text-right font-medium">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems?.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="p-4 py-3">{item.description}</td>
                      <td className="p-4 py-3" dir="ltr">{item.quantity}</td>
                      <td className="p-4 py-3" dir="ltr">{formatCurrency(item.unitPrice)}</td>
                      <td className="p-4 py-3" dir="ltr">{item.discountAmount ? formatCurrency(item.discountAmount) : "-"}</td>
                      <td className="p-4 py-3" dir="ltr">{item.vatRate}%</td>
                      <td className="p-4 py-3 font-medium" dir="ltr">{formatCurrency(item.total || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-8 flex justify-end">
              <div className="w-full sm:w-1/2 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">المجموع قبل الضريبة:</span>
                  <span dir="ltr">{formatCurrency(invoice.subtotal)}</span>
                </div>
                {Number(invoice.discountTotal) > 0 && (
                  <div className="flex justify-between text-sm text-red-600">
                    <span>الخصم الإجمالي:</span>
                    <span dir="ltr">- {formatCurrency(invoice.discountTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">ضريبة القيمة المضافة (15%):</span>
                  <span dir="ltr">{formatCurrency(invoice.vatTotal)}</span>
                </div>
                <div className="h-px border-b border-dashed" />
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

        {/* Sidebar */}
        <div className="space-y-6 print:hidden">
          {/* QR Code */}
          {invoice.qrCode ? (
            <Card>
              <CardHeader className="pb-2 text-center">
                <CardTitle className="text-sm font-medium flex items-center justify-center gap-2">
                  <FileText className="h-4 w-4" />
                  رمز QR Code (TLV / ZATCA)
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center p-4 pt-2">
                <div className="bg-white p-4 rounded-lg shadow-sm border inline-block mb-3">
                  <ZatcaQrCode base64Tlv={invoice.qrCode} />
                </div>
                <p className="text-xs text-center text-muted-foreground leading-relaxed">
                  مشفّر بصيغة TLV (Annex B)<br />
                  متوافق مع متطلبات ZATCA الفنية
                </p>
                <div className="mt-3 w-full text-xs space-y-1 bg-muted/20 rounded p-2">
                  <p className="font-mono break-all text-muted-foreground text-[9px]" dir="ltr">
                    {invoice.qrCode.substring(0, 64)}...
                  </p>
                  <Button size="sm" variant="ghost" className="h-6 text-xs w-full gap-1"
                    onClick={() => navigator.clipboard.writeText(invoice.qrCode!).then(() => toast({ title: "تم نسخ TLV" }))}>
                    <Copy className="h-3 w-3" />نسخ TLV Base64
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : invoice.status === "draft" ? (
            <Card className="border-dashed bg-muted/10">
              <CardContent className="flex flex-col items-center p-8 text-center">
                <div className="h-24 w-24 border-2 border-dashed rounded-lg border-muted-foreground/30 flex items-center justify-center mb-4">
                  <FileText className="h-8 w-8 text-muted-foreground/30" />
                </div>
                <p className="text-sm font-medium">QR Code غير متاح بعد</p>
                <p className="text-xs text-muted-foreground mt-1">يُولَّد عند إصدار الفاتورة</p>
              </CardContent>
            </Card>
          ) : null}

          {/* ZATCA Status Panel */}
          {invoice.status === "issued" && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">حالة ZATCA</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-3">
                  {zatcaDone ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                  ) : zatcaRejected ? (
                    <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {inv.zatcaStatus === "cleared" ? "تم الفسح (Cleared)" :
                        inv.zatcaStatus === "reported" ? "تم التبليغ (Reported)" :
                          inv.zatcaStatus === "rejected" ? "مرفوضة" :
                            "بانتظار الإرسال"}
                    </p>
                    {inv.zatcaClearanceStatus && (
                      <p className="text-xs text-muted-foreground mt-0.5">{inv.zatcaClearanceStatus}</p>
                    )}
                  </div>
                </div>

                {/* Hash chain */}
                {invoice.invoiceHash && (
                  <div className="pt-2 border-t space-y-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Hash SHA-256 (Base64):</p>
                      <p className="text-[10px] font-mono break-all text-muted-foreground bg-muted p-2 rounded">
                        {invoice.invoiceHash}
                      </p>
                    </div>
                    {inv.previousInvoiceHash && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Hash الفاتورة السابقة:</p>
                        <p className="text-[10px] font-mono break-all text-muted-foreground bg-muted p-2 rounded">
                          {inv.previousInvoiceHash.substring(0, 50)}...
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Submit button if pending */}
                {zatcaPending && !zatcaDone && (
                  <Button
                    size="sm"
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white gap-2 mt-2"
                    onClick={handleSubmitZatca}
                    disabled={submittingZatca}
                  >
                    {submittingZatca
                      ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الإرسال...</>
                      : <><Upload className="h-4 w-4" />إرسال لـ ZATCA</>}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
