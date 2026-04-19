import { useState } from "react";
import { useParams, Link } from "wouter";
import { useGetInvoice, useIssueInvoice, useCancelInvoice } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, FileText, CheckCircle2, AlertTriangle, XCircle,
  Send, Printer, Ban, Upload, Loader2, Copy, FileCode2, Clock,
  QrCode, Receipt, Shield
} from "lucide-react";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import { QRCodeSVG } from "qrcode.react";
import InvoicePrintDialog from "@/components/InvoicePrintDialog";

function ZatcaQrCode({ base64Tlv }: { base64Tlv: string }) {
  const binaryStr = atob(base64Tlv);
  return <QRCodeSVG value={binaryStr} size={192} level="M" className="block" />;
}

const TABS = [
  { key: "invoice", label: "الفاتورة",     icon: Receipt },
  { key: "zatca",   label: "ZATCA",         icon: Shield  },
  { key: "xml",     label: "XML الفني",     icon: FileCode2 },
];

const PAYMENT_LABELS: Record<string, string> = {
  "10": "نقدي",
  "30": "تحويل بنكي",
  "42": "حساب بنكي",
  "48": "بطاقة بنكية",
  "1":  "أخرى",
};

export default function InvoiceDetails() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submittingZatca, setSubmittingZatca] = useState(false);
  const [activeTab, setActiveTab] = useState("invoice");
  const [printOpen, setPrintOpen] = useState(false);

  const { data: invoice, isLoading } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: ["invoice", id] }
  });

  const issueInvoice = useIssueInvoice();
  const cancelInvoice = useCancelInvoice();

  const formatCurrency = (amount: number | string) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(Number(amount));

  const handleIssue = () => {
    if (!confirm("هل أنت متأكد من إصدار هذه الفاتورة؟ سيتم توليد XML وQR Code ولا يمكن تعديلها بعد ذلك.")) return;
    issueInvoice.mutate({ data: { invoiceId: id } }, {
      onSuccess: () => {
        toast({ title: "تم الإصدار بنجاح", description: "تم توليد QR Code وXML UBL 2.1 بنجاح." });
        queryClient.invalidateQueries({ queryKey: ["invoice", id] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
        setActiveTab("zatca");
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
    if (!confirm("هل تريد إرسال الفاتورة إلى منصة ZATCA؟")) return;
    setSubmittingZatca(true);
    try {
      const res = await fetch(`/api/invoices/${id}/submit`, { method: "POST" });
      const data = await res.json() as {
        success?: boolean;
        zatcaStatus?: string;
        message?: string;
        error?: string;
      };
      if (data.success) {
        toast({ title: "تم الإرسال بنجاح", description: data.message });
      } else {
        toast({ title: "فشل الإرسال إلى ZATCA", description: data.error ?? "خطأ غير معروف", variant: "destructive" });
      }
      queryClient.invalidateQueries({ queryKey: ["invoice", id] });
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setSubmittingZatca(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-[600px] w-full rounded-xl" />
      </div>
    );
  }

  if (!invoice) {
    return <div className="p-12 text-center text-muted-foreground">الفاتورة غير موجودة</div>;
  }

  const inv = invoice as typeof invoice & {
    xmlContent?: string | null;
    invoiceCounterValue?: number | null;
    previousInvoiceHash?: string | null;
    zatcaWarningMessages?: string | null;
    zatcaErrorMessages?: string | null;
    zatcaClearanceStatus?: string | null;
    paymentMethod?: string | null;
  };

  const warningMessages = inv.zatcaWarningMessages ? JSON.parse(inv.zatcaWarningMessages) as Array<{ code: string; message: string }> : [];
  const errorMessages = inv.zatcaErrorMessages ? JSON.parse(inv.zatcaErrorMessages) as Array<{ code: string; message: string }> : [];
  const zatcaDone = inv.zatcaStatus === "cleared" || inv.zatcaStatus === "reported";
  const zatcaRejected = inv.zatcaStatus === "rejected";
  const zatcaPending = inv.zatcaStatus === "pending";

  const statusColor = invoice.status === "issued" ? "bg-emerald-500" :
    invoice.status === "draft" ? "bg-amber-400" : "bg-red-400";
  const statusLabel = invoice.status === "issued" ? "مصدرة" :
    invoice.status === "draft" ? "مسودة" : "ملغاة";

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="-mr-1">
            <Link href="/invoices"><ArrowRight className="h-5 w-5" /></Link>
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold font-mono tracking-tight" dir="ltr">{invoice.invoiceNumber}</h1>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white ${statusColor}`}>
                {statusLabel}
              </span>
              {zatcaDone && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-200">✓ ZATCA</span>}
              {zatcaRejected && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 border border-red-200">✕ ZATCA مرفوضة</span>}
              {zatcaPending && invoice.status === "issued" && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 border border-yellow-200">⟳ بانتظار ZATCA</span>}
            </div>
            <p className="text-muted-foreground text-sm mt-0.5">
              {format(new Date(invoice.issueDate), "PPPP", { locale: arSA })}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-wrap justify-end print:hidden">
          {invoice.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={cancelInvoice.isPending}>
                <Ban className="h-4 w-4 ml-1.5" />إلغاء
              </Button>
              <Button size="sm" onClick={handleIssue} disabled={issueInvoice.isPending} className="gap-1.5">
                {issueInvoice.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الإصدار...</>
                  : <><Send className="h-4 w-4" />إصدار واعتماد</>}
              </Button>
            </>
          )}
          {invoice.status === "issued" && (
            <>
              {zatcaPending && (
                <Button size="sm" onClick={handleSubmitZatca} disabled={submittingZatca}
                  className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
                  {submittingZatca
                    ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الإرسال...</>
                    : <><Upload className="h-4 w-4" />إرسال لـ ZATCA</>}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setPrintOpen(true)} className="gap-1.5">
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tab Strip */}
      <div className="rounded-xl border bg-card overflow-hidden print:hidden">
        <div className="flex border-b bg-muted/10">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium transition-colors border-b-2 -mb-px flex-1 justify-center ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* ─────────────────────────── TAB 1: INVOICE TAPE ─────────────────────────── */}
        {activeTab === "invoice" && (
          <div className="p-0">
            {/* Tape document */}
            <div className="mx-auto max-w-2xl">
              {/* Company header */}
              <div className="px-8 pt-8 pb-6 text-center border-b border-dashed">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-3">
                  <FileText className="h-6 w-6 text-primary" />
                </div>
                <h2 className="text-xl font-bold">{invoice.company?.nameAr}</h2>
                {invoice.company?.nameEn && <p className="text-sm text-muted-foreground">{invoice.company.nameEn}</p>}
                <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                  {invoice.company?.vatNumber && (
                    <p>الرقم الضريبي: <span className="font-mono" dir="ltr">{invoice.company.vatNumber}</span></p>
                  )}
                  {invoice.company?.city && (
                    <p>{invoice.company.city}{invoice.company.street ? ` — ${invoice.company.street}` : ""}</p>
                  )}
                </div>
              </div>

              {/* Invoice meta */}
              <div className="px-8 py-5 border-b border-dashed grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">نوع الفاتورة</p>
                  <p className="font-semibold">
                    {invoice.invoiceType === "standard" ? "فاتورة ضريبية (B2B)" : "فاتورة مبسطة (B2C)"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">رقم الفاتورة</p>
                  <p className="font-mono font-semibold text-xs" dir="ltr">{invoice.invoiceNumber}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">تاريخ الإصدار</p>
                  <p className="font-medium">{format(new Date(invoice.issueDate), "yyyy/MM/dd")}</p>
                </div>
                {invoice.supplyDate && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">تاريخ التوريد</p>
                    <p className="font-medium">{format(new Date(invoice.supplyDate), "yyyy/MM/dd")}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">طريقة الدفع</p>
                  <p className="font-medium">{PAYMENT_LABELS[inv.paymentMethod ?? "10"] ?? inv.paymentMethod ?? "نقدي"}</p>
                </div>
                {inv.invoiceCounterValue && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">الرقم المتسلسل</p>
                    <p className="font-mono font-medium">{inv.invoiceCounterValue}</p>
                  </div>
                )}
              </div>

              {/* Customer */}
              {invoice.customer && (
                <div className="px-8 py-5 border-b border-dashed">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">فاتورة إلى</p>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                    <div>
                      <p className="font-semibold">{invoice.customer.nameAr}</p>
                      {invoice.customer.nameEn && <p className="text-muted-foreground text-xs">{invoice.customer.nameEn}</p>}
                    </div>
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      {invoice.customer.vatNumber && (
                        <p>ر. ضريبي: <span className="font-mono" dir="ltr">{invoice.customer.vatNumber}</span></p>
                      )}
                      {invoice.customer.crNumber && (
                        <p>س. تجاري: <span className="font-mono" dir="ltr">{invoice.customer.crNumber}</span></p>
                      )}
                      {invoice.customer.city && <p>{invoice.customer.city}</p>}
                    </div>
                  </div>
                </div>
              )}

              {/* Line items */}
              <div className="px-8 py-5 border-b border-dashed">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">الأصناف والخدمات</p>
                <div className="space-y-3">
                  {invoice.lineItems?.map((item, idx) => (
                    <div key={item.id} className="text-sm">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground font-mono w-4">{idx + 1}.</span>
                            <p className="font-medium truncate">{item.description}</p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 mr-6">
                            {Number(item.quantity)} {item.unitCode ?? "PCE"} × {formatCurrency(item.unitPrice)}
                            {Number(item.discountAmount) > 0 && ` — خصم ${formatCurrency(item.discountAmount)}`}
                            {" "}<span className={`inline-block px-1 rounded text-[10px] font-medium ${
                              (item as { taxCategory?: string }).taxCategory === "Z" ? "bg-blue-100 text-blue-700" :
                              (item as { taxCategory?: string }).taxCategory === "E" ? "bg-gray-100 text-gray-600" :
                              "bg-primary/10 text-primary"
                            }`}>{(item as { taxCategory?: string }).taxCategory ?? "S"} {item.vatRate}%</span>
                          </p>
                        </div>
                        <p className="font-semibold shrink-0 tabular-nums" dir="ltr">{formatCurrency(item.total || 0)}</p>
                      </div>
                      {idx < (invoice.lineItems?.length ?? 0) - 1 && (
                        <div className="mt-3 border-t border-dotted" />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Totals */}
              <div className="px-8 py-5 border-b border-dashed">
                <div className="space-y-2.5 text-sm">
                  <div className="flex justify-between text-muted-foreground">
                    <span>المجموع قبل الضريبة</span>
                    <span dir="ltr">{formatCurrency(invoice.subtotal)}</span>
                  </div>
                  {Number(invoice.discountTotal) > 0 && (
                    <div className="flex justify-between text-red-600">
                      <span>الخصم الإجمالي</span>
                      <span dir="ltr">− {formatCurrency(invoice.discountTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-muted-foreground">
                    <span>ضريبة القيمة المضافة</span>
                    <span dir="ltr">+ {formatCurrency(invoice.vatTotal)}</span>
                  </div>
                  <div className="pt-3 border-t border-dashed flex justify-between font-bold text-base">
                    <span>الإجمالي المستحق</span>
                    <span dir="ltr">{formatCurrency(invoice.grandTotal)}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              {invoice.notes && (
                <div className="px-8 py-4 border-b border-dashed text-sm text-muted-foreground">
                  <p className="text-xs font-semibold uppercase tracking-wider mb-1">ملاحظات</p>
                  <p className="leading-relaxed">{invoice.notes}</p>
                </div>
              )}

              {/* QR code (B2C) */}
              {invoice.qrCode && invoice.invoiceType === "simplified" && (
                <div className="px-8 py-6 text-center border-b border-dashed">
                  <p className="text-xs text-muted-foreground mb-4">امسح رمز QR للتحقق من الفاتورة</p>
                  <div className="inline-block bg-white p-4 rounded-xl border shadow-sm">
                    <ZatcaQrCode base64Tlv={invoice.qrCode} />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-3">ZATCA TLV — Annex B</p>
                </div>
              )}

              {/* Footer tape */}
              <div className="px-8 py-5 text-center">
                <div className="text-[10px] text-muted-foreground/50 font-mono tracking-widest">
                  ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦
                </div>
                <p className="text-xs text-muted-foreground mt-2">شكراً لتعاملكم معنا</p>
                <p className="text-[10px] text-muted-foreground/50 mt-1">نظام الفاتورة الإلكترونية — ZATCA Phase 2</p>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────── TAB 2: ZATCA ─────────────────────────── */}
        {activeTab === "zatca" && (
          <div className="p-6 space-y-6">
            {/* ZATCA messages */}
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* QR Code card */}
              <div className="rounded-xl border p-6 flex flex-col items-center text-center">
                <div className="flex items-center gap-2 mb-5 self-start">
                  <QrCode className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">رمز QR Code</h3>
                </div>
                {invoice.qrCode ? (
                  <>
                    <div className="bg-white p-5 rounded-xl border shadow-sm inline-block mb-4">
                      <ZatcaQrCode base64Tlv={invoice.qrCode} />
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      مشفّر بصيغة TLV (Annex B) — متوافق مع ZATCA
                    </p>
                    <div className="w-full bg-muted/20 rounded-lg p-3 text-right">
                      <p className="font-mono break-all text-muted-foreground text-[9px] mb-2" dir="ltr">
                        {invoice.qrCode.substring(0, 80)}…
                      </p>
                      <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 w-full"
                        onClick={() => navigator.clipboard.writeText(invoice.qrCode!).then(() => toast({ title: "تم نسخ TLV" }))}>
                        <Copy className="h-3 w-3" />نسخ TLV Base64
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center py-8 text-muted-foreground">
                    <div className="h-20 w-20 border-2 border-dashed rounded-xl border-muted-foreground/20 flex items-center justify-center mb-4">
                      <QrCode className="h-8 w-8 opacity-20" />
                    </div>
                    <p className="text-sm font-medium">QR Code غير متاح</p>
                    <p className="text-xs mt-1">يُولَّد عند إصدار الفاتورة</p>
                    {invoice.status === "draft" && (
                      <Button size="sm" onClick={handleIssue} disabled={issueInvoice.isPending} className="mt-4 gap-1.5">
                        <Send className="h-4 w-4" />إصدار الفاتورة
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* ZATCA Status card */}
              <div className="rounded-xl border p-6 space-y-5">
                <div className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">حالة ZATCA</h3>
                </div>

                <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/20 border">
                  {zatcaDone ? (
                    <CheckCircle2 className="h-6 w-6 text-emerald-500 shrink-0 mt-0.5" />
                  ) : zatcaRejected ? (
                    <XCircle className="h-6 w-6 text-red-500 shrink-0 mt-0.5" />
                  ) : (
                    <Clock className="h-6 w-6 text-amber-500 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="font-semibold text-sm">
                      {inv.zatcaStatus === "cleared" ? "تم الفسح (Cleared)" :
                        inv.zatcaStatus === "reported" ? "تم التبليغ (Reported)" :
                          inv.zatcaStatus === "rejected" ? "مرفوضة من ZATCA" :
                            inv.zatcaStatus === "pending" ? "بانتظار الإرسال" :
                              "لم يُصدَر بعد"}
                    </p>
                    {inv.zatcaClearanceStatus && (
                      <p className="text-xs text-muted-foreground mt-1">{inv.zatcaClearanceStatus}</p>
                    )}
                  </div>
                </div>

                {invoice.status === "issued" && zatcaPending && (
                  <Button size="sm" className="w-full bg-blue-600 hover:bg-blue-700 text-white gap-2"
                    onClick={handleSubmitZatca} disabled={submittingZatca}>
                    {submittingZatca
                      ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الإرسال...</>
                      : <><Upload className="h-4 w-4" />إرسال لـ ZATCA</>}
                  </Button>
                )}

                {invoice.invoiceHash && (
                  <div className="border-t pt-4 space-y-3">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Hash SHA-256 (Base64)</p>
                      <div className="relative">
                        <p className="text-[10px] font-mono break-all text-muted-foreground bg-muted/30 rounded-lg p-3 border">
                          {invoice.invoiceHash}
                        </p>
                        <Button size="icon" variant="ghost" className="absolute top-1 left-1 h-6 w-6"
                          onClick={() => navigator.clipboard.writeText(invoice.invoiceHash!).then(() => toast({ title: "تم النسخ" }))}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {inv.previousInvoiceHash && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">Hash الفاتورة السابقة</p>
                        <p className="text-[10px] font-mono break-all text-muted-foreground bg-muted/30 rounded-lg p-3 border">
                          {inv.previousInvoiceHash.substring(0, 64)}…
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────── TAB 3: XML ─────────────────────────── */}
        {activeTab === "xml" && (
          <div className="p-6 space-y-4">
            {inv.xmlContent ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode2 className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">UBL 2.1 XML — فاتورة ZATCA</h3>
                  </div>
                  <Button size="sm" variant="outline" className="gap-1.5"
                    onClick={() => navigator.clipboard.writeText(inv.xmlContent!).then(() => toast({ title: "تم نسخ XML الكامل" }))}>
                    <Copy className="h-3.5 w-3.5" />نسخ XML
                  </Button>
                </div>
                <div className="rounded-xl border overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b">
                    <div className="flex gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                      <div className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                      <div className="h-2.5 w-2.5 rounded-full bg-green-400" />
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">invoice.xml</span>
                  </div>
                  <pre className="bg-[#1e1e1e] text-green-400 text-[11px] font-mono overflow-auto max-h-[500px] p-5 whitespace-pre leading-relaxed" dir="ltr">
                    {inv.xmlContent}
                  </pre>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center py-16 text-muted-foreground">
                <FileCode2 className="h-12 w-12 mb-4 opacity-20" />
                <p className="font-medium">XML غير متاح</p>
                <p className="text-sm mt-1">يُولَّد عند إصدار الفاتورة</p>
                {invoice.status === "draft" && (
                  <Button size="sm" onClick={handleIssue} disabled={issueInvoice.isPending} className="mt-4 gap-1.5">
                    <Send className="h-4 w-4" />إصدار الفاتورة
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Print Dialog */}
      {printOpen && (
        <InvoicePrintDialog
          open={printOpen}
          onClose={() => setPrintOpen(false)}
          invoice={{
            invoiceNumber: invoice.invoiceNumber,
            issueDate: invoice.issueDate,
            supplyDate: invoice.supplyDate,
            paymentMethod: inv.paymentMethod,
            invoiceType: invoice.invoiceType,
            status: invoice.status,
            notes: invoice.notes,
            subtotal: invoice.subtotal,
            taxAmount: invoice.taxAmount,
            total: invoice.total,
            discountAmount: (invoice as any).discountAmount,
            qrCode: invoice.qrCode,
            lineItems: (invoice as any).lineItems ?? [],
            customer: (invoice as any).customer,
            company: (invoice as any).company,
          }}
        />
      )}
    </div>
  );
}
