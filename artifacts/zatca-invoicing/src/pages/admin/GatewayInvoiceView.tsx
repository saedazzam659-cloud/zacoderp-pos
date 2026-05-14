/**
 * Gateway Invoice Viewer (Phase 1C)
 * --------------------------------------------------------------
 * Beautiful A4 RTL invoice for clients without an external API
 * integration. Shows: company header, customer block, single-line
 * details, totals, ZATCA TLV QR (rendered client-side from base64),
 * and a "Download PDF" button (jsPDF + html2canvas-style direct render).
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Loader2, Download, ArrowRight, FileText, ShieldCheck, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import jsPDF from "jspdf";

const BASE = (import.meta as any).env?.BASE_URL ?? "/";

async function api<T>(path: string): Promise<T> {
  const tok = localStorage.getItem("zatca_token");
  const r = await fetch(path, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    credentials: "include",
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

interface RenderResp {
  invoice: {
    id: number;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    totalAmount: string | null;
    vatAmount: string | null;
    status: string;
    clearanceStatus: string | null;
    zatcaUuid: string | null;
    zatcaSubmittedAt: string | null;
    icv: number | null;
    invoiceFlow: string | null;
    invoiceType: string | null;
    receivedAt: string;
    canonical: any;
    qrTlv: string | null;
  };
  client: {
    id: number;
    nameAr: string;
    nameEn: string | null;
    vatNumber: string;
    crNumber: string | null;
    addressAr: string | null;
    city: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    zatcaEnv: string;
  };
}

const fmt = (n: number | string | null | undefined) =>
  Number(n ?? 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function GatewayInvoiceView() {
  const params = useParams<{ id: string; invId: string }>();
  const clientId = Number(params.id);
  const invId = Number(params.invId);
  const { toast } = useToast();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading, error } = useQuery<RenderResp>({
    queryKey: ["gateway-invoice-render", clientId, invId],
    queryFn: () => api(`/api/admin/gateway-clients/${clientId}/invoices/${invId}/render`),
    enabled: Number.isFinite(clientId) && Number.isFinite(invId),
  });

  // Inject @page CSS once for clean print output
  useEffect(() => {
    const styleId = "gateway-invoice-print-style";
    if (document.getElementById(styleId)) return;
    const el = document.createElement("style");
    el.id = styleId;
    el.textContent = `
      @media print {
        body * { visibility: hidden; }
        #invoice-sheet, #invoice-sheet * { visibility: visible; }
        #invoice-sheet { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; }
        @page { size: A4; margin: 10mm; }
      }
    `;
    document.head.appendChild(el);
  }, []);

  const downloadPdf = async () => {
    if (!sheetRef.current || !data) return;
    setDownloading(true);
    try {
      // Use the browser print path for the highest-fidelity PDF (true RTL +
      // arabic shaping). jsPDF text rendering of Arabic is unreliable, so
      // we lean on the print dialog → "Save as PDF". A direct jsPDF export
      // is also wired below as a backup textual receipt.
      window.print();
    } catch (e) {
      toast({ title: "فشل التنزيل", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const downloadTextPdf = async () => {
    if (!data) return;
    const inv = data.invoice; const c = data.client;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    doc.setFontSize(14);
    doc.text(`Tax Invoice / فاتورة ضريبية`, 105, 15, { align: "center" });
    doc.setFontSize(10);
    doc.text(`Seller: ${c.nameEn || c.nameAr}`, 15, 30);
    doc.text(`VAT #: ${c.vatNumber}`, 15, 36);
    if (c.crNumber) doc.text(`CR #: ${c.crNumber}`, 15, 42);
    doc.text(`Invoice #: ${inv.invoiceNumber ?? ""}`, 15, 55);
    doc.text(`Date: ${inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString("en-GB") : ""}`, 15, 61);
    doc.text(`UUID: ${inv.zatcaUuid ?? ""}`, 15, 67);
    doc.text(`ICV: ${inv.icv ?? ""}`, 15, 73);
    doc.text(`---------------------------------------`, 15, 85);
    const vatRate = Number(inv.canonical?.line?.vatRate ?? 15);
    doc.text(`Subtotal:  ${fmt(inv.canonical?.line?.totalExclVat)} SAR`, 15, 95);
    doc.text(`VAT ${vatRate}%:   ${fmt(inv.vatAmount)} SAR`, 15, 102);
    doc.setFontSize(12);
    doc.text(`TOTAL:     ${fmt(inv.totalAmount)} SAR`, 15, 112);
    doc.save(`invoice-${inv.invoiceNumber || inv.id}.pdf`);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-indigo-600" /></div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <FileText className="h-16 w-16 text-slate-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-slate-700 mb-2">تعذّر تحميل الفاتورة</h2>
        <p className="text-slate-500 mb-4">{(error as Error)?.message || "غير معروف"}</p>
        <Link href={`${BASE}admin/gateway-clients`}>
          <Button variant="outline"><ArrowRight className="h-4 w-4 ml-2" /> رجوع</Button>
        </Link>
      </div>
    );
  }

  const inv = data.invoice;
  const c = data.client;
  const canonical = inv.canonical || {};
  const line = canonical.line || {};
  const buyer = canonical.buyer || {};
  const isCleared = inv.status === "cleared" || inv.status === "sandbox_cleared";
  const isSimplified = inv.invoiceFlow === "simplified";
  const issueTime = canonical.invoice?.issueTime || "";

  return (
    <div className="min-h-screen bg-slate-100 py-6 px-4 print:bg-white print:py-0 print:px-0" dir="rtl">
      {/* Top action bar — hidden when printing */}
      <div className="max-w-[210mm] mx-auto mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link href={`${BASE}admin/gateway-clients`}>
          <Button variant="outline" size="sm"><ArrowRight className="h-4 w-4 ml-2" /> رجوع لقائمة العملاء</Button>
        </Link>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/admin/gateway-clients/${clientId}/invoices/${invId}/ubl`, "_blank")}>
            <Download className="h-4 w-4 ml-2" /> تنزيل UBL XML
          </Button>
          <Button variant="outline" size="sm" onClick={downloadTextPdf}>
            <FileText className="h-4 w-4 ml-2" /> PDF (نص)
          </Button>
          <Button size="sm" onClick={downloadPdf} disabled={downloading} className="bg-indigo-600 hover:bg-indigo-700">
            {downloading ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Printer className="h-4 w-4 ml-2" />}
            طباعة / حفظ PDF
          </Button>
        </div>
      </div>

      {/* The A4 sheet */}
      <div
        id="invoice-sheet"
        ref={sheetRef}
        className="bg-white max-w-[210mm] min-h-[297mm] mx-auto shadow-xl print:shadow-none rounded-lg overflow-hidden"
      >
        {/* Header band */}
        <div className="bg-gradient-to-l from-indigo-600 via-indigo-700 to-violet-700 text-white p-8 relative">
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1">
              <div className="text-xs uppercase tracking-widest opacity-80 mb-1">{isSimplified ? "Simplified Tax Invoice" : "Tax Invoice"}</div>
              <h1 className="text-3xl font-extrabold leading-tight">فاتورة ضريبية{isSimplified ? " مبسطة" : ""}</h1>
              <div className="mt-3 text-sm opacity-90 space-y-0.5">
                <div className="font-semibold text-base">{c.nameAr}</div>
                {c.nameEn && <div className="text-xs opacity-80">{c.nameEn}</div>}
                {c.addressAr && <div>{c.addressAr}{c.city ? ` — ${c.city}` : ""}</div>}
                <div className="font-mono text-xs opacity-80" dir="ltr">VAT: {c.vatNumber}{c.crNumber ? ` · CR: ${c.crNumber}` : ""}</div>
              </div>
            </div>
            <div className="text-left">
              <div className="bg-white/15 backdrop-blur rounded-lg px-4 py-3 text-xs uppercase tracking-wider">
                <div className="opacity-70 mb-1">Invoice #</div>
                <div className="font-mono text-lg font-bold" dir="ltr">{inv.invoiceNumber || `#${inv.id}`}</div>
              </div>
              {isCleared && (
                <div className="mt-2 inline-flex items-center gap-1 bg-emerald-400/90 text-emerald-950 text-[11px] font-bold px-3 py-1 rounded-full">
                  <ShieldCheck className="h-3.5 w-3.5" /> {inv.status === "sandbox_cleared" ? "مجاز (تجربة)" : "مجاز من زاتكا"}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Meta strip */}
        <div className="grid grid-cols-4 gap-0 border-y border-slate-200 bg-slate-50 text-[11px]">
          {[
            { l: "تاريخ الإصدار", v: inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString("en-GB") : "—" },
            { l: "الوقت", v: issueTime || "—" },
            { l: "ICV", v: inv.icv ?? "—" },
            { l: "العملة", v: canonical.invoice?.currency || "SAR" },
          ].map((m, i) => (
            <div key={i} className={`p-3 ${i < 3 ? "border-l border-slate-200" : ""}`}>
              <div className="text-slate-500 uppercase tracking-wider mb-0.5">{m.l}</div>
              <div className="font-mono font-semibold text-slate-800" dir="ltr">{m.v}</div>
            </div>
          ))}
        </div>

        {/* Customer block */}
        <div className="p-8 grid grid-cols-2 gap-6">
          <div className="border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">المورّد / Seller</div>
            <div className="font-semibold text-slate-800">{c.nameAr}</div>
            {c.nameEn && <div className="text-xs text-slate-500">{c.nameEn}</div>}
            <div className="text-xs text-slate-600 mt-1.5 font-mono" dir="ltr">VAT: {c.vatNumber}</div>
            {c.crNumber && <div className="text-xs text-slate-600 font-mono" dir="ltr">CR: {c.crNumber}</div>}
            {c.addressAr && <div className="text-xs text-slate-500 mt-1">{c.addressAr}</div>}
          </div>
          <div className="border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">العميل / Customer</div>
            <div className="font-semibold text-slate-800">{buyer.name || (isSimplified ? "عميل أفراد" : "—")}</div>
            {buyer.vat && <div className="text-xs text-slate-600 mt-1.5 font-mono" dir="ltr">VAT: {buyer.vat}</div>}
          </div>
        </div>

        {/* Line items */}
        <div className="px-8">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100 text-slate-700 text-xs uppercase tracking-wider">
                <th className="p-2.5 text-right border border-slate-200 w-[48%]">الصنف</th>
                <th className="p-2.5 text-center border border-slate-200">الكمية</th>
                <th className="p-2.5 text-center border border-slate-200">السعر</th>
                <th className="p-2.5 text-center border border-slate-200">الضريبة</th>
                <th className="p-2.5 text-center border border-slate-200">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2.5 border border-slate-200">{line.item || "—"}</td>
                <td className="p-2.5 border border-slate-200 text-center font-mono">{fmt(line.qty)}</td>
                <td className="p-2.5 border border-slate-200 text-center font-mono">{fmt(line.unitPrice)}</td>
                <td className="p-2.5 border border-slate-200 text-center font-mono">{fmt(line.vatAmount)}</td>
                <td className="p-2.5 border border-slate-200 text-center font-mono font-semibold">{fmt(line.totalInclVat)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Totals + QR */}
        <div className="p-8 grid grid-cols-3 gap-6 items-start">
          <div className="col-span-1 flex flex-col items-center justify-center border border-slate-200 rounded-lg p-4 bg-slate-50">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">رمز QR — زاتكا</div>
            {inv.qrTlv ? (
              <div className="bg-white p-2 rounded">
                <QRCodeSVG value={inv.qrTlv} size={140} level="M" includeMargin={false} />
              </div>
            ) : <div className="text-xs text-rose-500">QR غير متاح</div>}
            {inv.zatcaUuid && (
              <div className="mt-3 text-[9px] font-mono text-slate-500 break-all text-center" dir="ltr">{inv.zatcaUuid}</div>
            )}
          </div>

          <div className="col-span-2 space-y-1.5 text-sm">
            {/* VAT rate is read from canonical line — never hardcoded — so
                exempt (E), zero-rated (Z), and out-of-scope (O) invoices
                display the actual percentage instead of "15%". */}
            {(() => {
              const vatRate = Number(line.vatRate ?? 15);
              const vatCat = line.vatCategory || "S";
              const vatLabel = vatCat === "E" ? "ضريبة القيمة المضافة (معفاة)"
                : vatCat === "Z" ? "ضريبة القيمة المضافة (صفرية)"
                : vatCat === "O" ? "ضريبة القيمة المضافة (خارج النطاق)"
                : `ضريبة القيمة المضافة (${vatRate}%)`;
              return <>
                <Row label="المجموع قبل الضريبة" value={`${fmt(line.totalExclVat)} ${canonical.invoice?.currency || "SAR"}`} />
                <Row label={vatLabel} value={`${fmt(inv.vatAmount)} ${canonical.invoice?.currency || "SAR"}`} />
                <div className="border-t border-slate-300 my-2" />
                <Row label="الإجمالي شامل الضريبة" value={`${fmt(inv.totalAmount)} ${canonical.invoice?.currency || "SAR"}`} bold />
              </>;
            })()}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-8 py-4 text-[10px] text-slate-500 flex items-center justify-between">
          <div>
            {isCleared && <span className="inline-flex items-center gap-1 text-emerald-700"><ShieldCheck className="h-3 w-3" /> تم الإقرار لزاتكا</span>}
            <span className="mx-2">·</span>
            <span>وضع: {c.zatcaEnv === "production" ? "إنتاج" : "تجربة"}</span>
          </div>
          <div className="font-mono" dir="ltr">Gateway · {new Date(inv.receivedAt).toLocaleString("en-GB")}</div>
        </div>
      </div>

      {/* Status badge bar */}
      <div className="max-w-[210mm] mx-auto mt-4 print:hidden">
        <div className="bg-white rounded-lg border p-3 flex items-center gap-2 text-xs text-slate-600">
          <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">{c.nameAr}</Badge>
          <Badge variant="outline">{isSimplified ? "B2C — مبسطة" : "B2B — قياسية"}</Badge>
          {inv.clearanceStatus && <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">حالة الإقرار: {inv.clearanceStatus}</Badge>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${bold ? "text-base font-bold text-indigo-700" : "text-slate-700"}`}>
      <span>{label}</span>
      <span className="font-mono" dir="ltr">{value}</span>
    </div>
  );
}
