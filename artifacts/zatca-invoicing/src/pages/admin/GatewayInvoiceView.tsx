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
  const currency = canonical.invoice?.currency || "SAR";
  const sellerInitial = (c.nameAr || "?").trim().charAt(0);
  const issueDateObj = inv.invoiceDate ? new Date(inv.invoiceDate) : null;
  const dateGregorian = issueDateObj ? issueDateObj.toLocaleDateString("en-GB") : "—";
  // Hijri date — graceful fallback if Intl locale unavailable
  const dateHijri = issueDateObj
    ? (() => {
        try {
          return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", {
            year: "numeric", month: "long", day: "numeric",
          }).format(issueDateObj);
        } catch { return ""; }
      })()
    : "";
  const totalInWords = numberToArabicWords(Number(inv.totalAmount ?? 0), currency);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-stone-100 to-slate-200 py-6 px-4 print:bg-white print:py-0 print:px-0" dir="rtl">
      {/* Top action bar — hidden when printing */}
      <div className="max-w-[210mm] mx-auto mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link href={`${BASE}admin/gateway-clients`}>
          <Button variant="outline" size="sm" className="border-slate-300"><ArrowRight className="h-4 w-4 ml-2" /> رجوع لقائمة العملاء</Button>
        </Link>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/admin/gateway-clients/${clientId}/invoices/${invId}/ubl`, "_blank")}>
            <Download className="h-4 w-4 ml-2" /> تنزيل UBL XML
          </Button>
          <Button variant="outline" size="sm" onClick={downloadTextPdf}>
            <FileText className="h-4 w-4 ml-2" /> PDF (نص)
          </Button>
          <Button size="sm" onClick={downloadPdf} disabled={downloading}
            className="bg-gradient-to-l from-[#0d4d4d] to-[#0a6b5e] hover:from-[#063838] hover:to-[#075048] text-white shadow-lg">
            {downloading ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Printer className="h-4 w-4 ml-2" />}
            طباعة / حفظ PDF
          </Button>
        </div>
      </div>

      {/* The A4 sheet */}
      <div
        id="invoice-sheet"
        ref={sheetRef}
        className="bg-white max-w-[210mm] min-h-[297mm] mx-auto shadow-2xl print:shadow-none rounded-xl overflow-hidden relative"
        style={{ fontFamily: '"Noto Naskh Arabic","Cairo","Segoe UI",system-ui,sans-serif' }}
      >
        {/* Decorative top accent — gold strip */}
        <div className="h-1.5 bg-gradient-to-l from-[#c9a961] via-[#e6c578] to-[#c9a961]" />

        {/* HEADER — royal teal with corner ornament */}
        <div className="relative bg-gradient-to-bl from-[#0a4f4a] via-[#0d6962] to-[#0a4f4a] text-white px-10 pt-8 pb-9 overflow-hidden">
          {/* Decorative corner SVG (Islamic-inspired star) */}
          <svg viewBox="0 0 200 200" className="absolute -left-8 -top-8 w-44 h-44 text-white/[0.06]" fill="currentColor">
            <path d="M100 10l25 50 55 8-40 38 9 55-49-26-49 26 9-55-40-38 55-8z" />
          </svg>
          <svg viewBox="0 0 200 200" className="absolute -right-12 -bottom-16 w-56 h-56 text-white/[0.05]" fill="currentColor">
            <circle cx="100" cy="100" r="80" stroke="currentColor" strokeWidth="2" fill="none" />
            <circle cx="100" cy="100" r="55" stroke="currentColor" strokeWidth="2" fill="none" />
            <circle cx="100" cy="100" r="30" stroke="currentColor" strokeWidth="2" fill="none" />
          </svg>

          <div className="relative flex items-start justify-between gap-6">
            {/* Right block (RTL): logo monogram + seller info */}
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="shrink-0 w-16 h-16 rounded-xl bg-white/95 border-2 border-[#e6c578] flex items-center justify-center text-[#0a4f4a] text-3xl font-black shadow-xl">
                {sellerInitial}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.3em] text-[#e6c578] mb-1">{isSimplified ? "Simplified Tax Invoice" : "Tax Invoice"}</div>
                <h1 className="text-2xl font-extrabold leading-tight">فاتورة ضريبية{isSimplified ? " مبسطة" : ""}</h1>
                <div className="mt-2 space-y-0.5 text-sm">
                  <div className="font-bold text-base text-white">{c.nameAr}</div>
                  {c.nameEn && <div className="text-xs text-white/75 font-medium">{c.nameEn}</div>}
                  {c.addressAr && <div className="text-xs text-white/85">{c.addressAr}{c.city ? ` — ${c.city}` : ""}</div>}
                  <div className="font-mono text-[11px] text-white/80 pt-0.5" dir="ltr">
                    VAT {c.vatNumber}{c.crNumber ? ` · CR ${c.crNumber}` : ""}
                  </div>
                </div>
              </div>
            </div>

            {/* Left block (RTL): invoice number plate + clearance stamp */}
            <div className="text-left shrink-0">
              <div className="bg-white/95 text-[#0a4f4a] rounded-lg px-5 py-3 shadow-lg border-r-4 border-[#c9a961]">
                <div className="text-[9px] uppercase tracking-[0.2em] opacity-70">رقم الفاتورة</div>
                <div className="font-mono text-xl font-extrabold" dir="ltr">{inv.invoiceNumber || `#${inv.id}`}</div>
              </div>
              {isCleared && (
                <div className="mt-2 flex justify-end">
                  <div className="inline-flex items-center gap-1.5 bg-[#e6c578] text-[#3d2c0a] text-[10px] font-extrabold px-3 py-1.5 rounded-full shadow-md">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {inv.status === "sandbox_cleared" ? "مجاز (وضع التجربة)" : "مجاز من هيئة الزكاة"}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Gold separator */}
        <div className="h-px bg-gradient-to-l from-transparent via-[#c9a961] to-transparent" />

        {/* META strip — 5 cells */}
        <div className="grid grid-cols-5 bg-[#fbf8f0] text-[10px]">
          {[
            { l: "تاريخ الإصدار", v: dateGregorian },
            { l: "التاريخ الهجري", v: dateHijri || "—" },
            { l: "الوقت", v: issueTime || "—" },
            { l: "تسلسل (ICV)", v: inv.icv ?? "—" },
            { l: "العملة", v: currency },
          ].map((m, i) => (
            <div key={i} className={`px-3 py-2.5 ${i < 4 ? "border-l border-[#e6dcc0]/70" : ""}`}>
              <div className="text-[#8a7a55] uppercase tracking-wider mb-1">{m.l}</div>
              <div className="font-mono font-bold text-[#3d2c0a] text-xs" dir="ltr">{m.v}</div>
            </div>
          ))}
        </div>

        {/* SELLER + CUSTOMER blocks */}
        <div className="px-10 pt-7 pb-2 grid grid-cols-2 gap-5">
          <PartyCard title="المورّد" subtitle="Seller" accent>
            <div className="font-bold text-slate-900 text-sm">{c.nameAr}</div>
            {c.nameEn && <div className="text-[11px] text-slate-500">{c.nameEn}</div>}
            <div className="mt-2 space-y-0.5">
              <KV k="VAT" v={c.vatNumber} />
              {c.crNumber && <KV k="CR" v={c.crNumber} />}
              {c.addressAr && <div className="text-[11px] text-slate-600 mt-1">{c.addressAr}</div>}
            </div>
          </PartyCard>
          <PartyCard title="العميل" subtitle="Customer">
            <div className="font-bold text-slate-900 text-sm">{buyer.name || (isSimplified ? "عميل أفراد" : "—")}</div>
            {buyer.vat && <div className="mt-2"><KV k="VAT" v={buyer.vat} /></div>}
            {!buyer.name && isSimplified && (
              <div className="text-[10px] text-slate-400 italic mt-1">فاتورة مبسطة B2C — لا تتطلب بيانات تفصيلية</div>
            )}
          </PartyCard>
        </div>

        {/* LINE ITEMS table */}
        <div className="px-10 mt-5">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#0a4f4a] text-white text-[11px] uppercase tracking-wider">
                <th className="p-3 text-right rounded-tr-lg w-[8%]">#</th>
                <th className="p-3 text-right w-[42%]">وصف الصنف / Description</th>
                <th className="p-3 text-center">الكمية</th>
                <th className="p-3 text-center">سعر الوحدة</th>
                <th className="p-3 text-center">الضريبة</th>
                <th className="p-3 text-center rounded-tl-lg">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-200 hover:bg-[#fbf8f0]/50">
                <td className="p-3 text-right text-slate-400 font-mono">01</td>
                <td className="p-3 text-right text-slate-800">{line.item || "—"}</td>
                <td className="p-3 text-center font-mono text-slate-700">{fmt(line.qty)}</td>
                <td className="p-3 text-center font-mono text-slate-700">{fmt(line.unitPrice)}</td>
                <td className="p-3 text-center font-mono text-slate-700">{fmt(line.vatAmount)}</td>
                <td className="p-3 text-center font-mono font-bold text-[#0a4f4a]">{fmt(line.totalInclVat)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* TOTALS + QR */}
        <div className="px-10 mt-6 grid grid-cols-5 gap-5 items-start">
          {/* QR card — left in RTL = visual right of totals */}
          <div className="col-span-2">
            <div className="rounded-xl bg-gradient-to-br from-[#fbf8f0] to-white border-2 border-[#e6dcc0] p-4 text-center">
              <div className="text-[9px] uppercase tracking-[0.2em] text-[#8a7a55] mb-2 flex items-center justify-center gap-1">
                <ShieldCheck className="h-3 w-3 text-[#c9a961]" /> امسح للتحقق — ZATCA QR
              </div>
              {inv.qrTlv ? (
                <div className="inline-block bg-white p-2 rounded-lg border border-[#e6dcc0]">
                  <QRCodeSVG value={inv.qrTlv} size={130} level="M" includeMargin={false} fgColor="#0a4f4a" />
                </div>
              ) : <div className="text-xs text-rose-500 py-8">QR غير متاح</div>}
              {inv.zatcaUuid && (
                <div className="mt-2 text-[8px] font-mono text-[#8a7a55] break-all leading-tight" dir="ltr">{inv.zatcaUuid}</div>
              )}
            </div>
          </div>

          {/* Totals panel */}
          <div className="col-span-3">
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              {(() => {
                const vatRate = Number(line.vatRate ?? 15);
                const vatCat = line.vatCategory || "S";
                const vatLabel = vatCat === "E" ? "ضريبة القيمة المضافة (معفاة)"
                  : vatCat === "Z" ? "ضريبة القيمة المضافة (صفرية)"
                  : vatCat === "O" ? "ضريبة القيمة المضافة (خارج النطاق)"
                  : `ضريبة القيمة المضافة (${vatRate}%)`;
                return <>
                  <Row label="المجموع قبل الضريبة" value={fmt(line.totalExclVat)} suffix={currency} />
                  <Row label={vatLabel} value={fmt(inv.vatAmount)} suffix={currency} />
                  <div className="bg-gradient-to-l from-[#0a4f4a] to-[#0d6962] text-white px-5 py-4 flex items-center justify-between">
                    <span className="text-sm font-bold tracking-wide">الإجمالي شامل الضريبة</span>
                    <span className="font-mono text-xl font-extrabold" dir="ltr">{fmt(inv.totalAmount)} <span className="text-[#e6c578] text-sm">{currency}</span></span>
                  </div>
                </>;
              })()}
            </div>

            {/* Amount in words */}
            <div className="mt-3 rounded-lg bg-[#fbf8f0] border-r-4 border-[#c9a961] px-4 py-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[#8a7a55] mb-0.5">المبلغ كتابةً</div>
              <div className="text-xs font-semibold text-[#3d2c0a] leading-relaxed">{totalInWords}</div>
            </div>
          </div>
        </div>

        {/* Signature / notes strip */}
        <div className="px-10 mt-6 grid grid-cols-2 gap-5 text-[10px]">
          <div className="border-t-2 border-dashed border-slate-300 pt-2">
            <div className="text-slate-500">توقيع المورّد / Authorized Signature</div>
          </div>
          <div className="border-t-2 border-dashed border-slate-300 pt-2 text-left">
            <div className="text-slate-500">ختم الشركة / Company Seal</div>
          </div>
        </div>

        {/* FOOTER */}
        <div className="mt-6 border-t border-[#e6dcc0]">
          <div className="bg-[#fbf8f0] px-10 py-3 text-[10px] text-[#8a7a55] flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isCleared && <span className="inline-flex items-center gap-1 text-[#0a4f4a] font-semibold"><ShieldCheck className="h-3 w-3" /> تم الإقرار لزاتكا</span>}
              <span>·</span>
              <span>وضع: <span className="font-bold text-[#3d2c0a]">{c.zatcaEnv === "production" ? "إنتاج" : "تجربة"}</span></span>
              {c.contactPhone && <><span>·</span><span dir="ltr" className="font-mono">{c.contactPhone}</span></>}
              {c.contactEmail && <><span>·</span><span dir="ltr" className="font-mono">{c.contactEmail}</span></>}
            </div>
            <div className="font-mono" dir="ltr">{new Date(inv.receivedAt).toLocaleString("en-GB")}</div>
          </div>
          <div className="h-1 bg-gradient-to-l from-[#c9a961] via-[#e6c578] to-[#c9a961]" />
        </div>
      </div>

      {/* Status badges — UI only */}
      <div className="max-w-[210mm] mx-auto mt-4 print:hidden">
        <div className="bg-white rounded-lg border border-slate-200 p-3 flex items-center gap-2 text-xs text-slate-600 flex-wrap">
          <Badge variant="outline" className="bg-[#0a4f4a]/5 text-[#0a4f4a] border-[#0a4f4a]/30">{c.nameAr}</Badge>
          <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">{isSimplified ? "B2C — مبسطة" : "B2B — قياسية"}</Badge>
          {inv.clearanceStatus && <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">حالة الإقرار: {inv.clearanceStatus}</Badge>}
          <span className="text-slate-400 mr-auto">يمكنك مشاركة هذا الرابط مع العميل — يحتاج صلاحية SuperAdmin للعرض</span>
        </div>
      </div>
    </div>
  );
}

// ─── Small presentational helpers ───────────────────────────────────────

function PartyCard({ title, subtitle, accent, children }: { title: string; subtitle: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border ${accent ? "border-[#e6dcc0] bg-gradient-to-bl from-[#fbf8f0]/60 to-white" : "border-slate-200 bg-white"} p-4`}>
      <div className="flex items-baseline justify-between mb-2">
        <span className={`text-xs font-bold ${accent ? "text-[#0a4f4a]" : "text-slate-700"}`}>{title}</span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-slate-400 font-mono">{k}:</span>
      <span className="font-mono text-slate-700" dir="ltr">{v}</span>
    </div>
  );
}

function Row({ label, value, suffix, bold }: { label: string; value: string; suffix?: string; bold?: boolean }) {
  return (
    <div className={`px-5 py-2.5 flex items-center justify-between border-b last:border-b-0 border-slate-100 ${bold ? "text-base font-bold text-[#0a4f4a] bg-[#fbf8f0]" : "text-sm text-slate-700"}`}>
      <span>{label}</span>
      <span className="font-mono" dir="ltr">{value}{suffix && <span className="text-slate-400 text-xs mr-1">{suffix}</span>}</span>
    </div>
  );
}

// ─── Arabic number-to-words (whole + halalas) ───────────────────────────
// Lightweight in-house implementation: covers 0 – 999,999,999.99 which
// safely exceeds any single ZATCA invoice amount. No external deps.
function numberToArabicWords(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount < 0) return "—";
  const riyals = Math.floor(amount);
  const halalas = Math.round((amount - riyals) * 100);
  const currencyName = currency === "SAR" ? "ريال سعودي" : currency;
  const subUnit = currency === "SAR" ? "هللة" : "";

  const main = numToArabic(riyals);
  let out = `${main} ${currencyName}`;
  if (halalas > 0 && subUnit) out += ` و${numToArabic(halalas)} ${subUnit}`;
  return `${out} فقط لا غير`;
}

function numToArabic(n: number): string {
  if (n === 0) return "صفر";
  const ones = ["","واحد","اثنان","ثلاثة","أربعة","خمسة","ستة","سبعة","ثمانية","تسعة","عشرة","أحد عشر","اثنا عشر","ثلاثة عشر","أربعة عشر","خمسة عشر","ستة عشر","سبعة عشر","ثمانية عشر","تسعة عشر"];
  const tens = ["","","عشرون","ثلاثون","أربعون","خمسون","ستون","سبعون","ثمانون","تسعون"];
  const hundreds = ["","مائة","مئتان","ثلاثمائة","أربعمائة","خمسمائة","ستمائة","سبعمائة","ثمانمائة","تسعمائة"];

  const under1000 = (x: number): string => {
    if (x === 0) return "";
    const h = Math.floor(x / 100);
    const r = x % 100;
    const parts: string[] = [];
    if (h) parts.push(hundreds[h]);
    if (r < 20) { if (r) parts.push(ones[r]); }
    else {
      const t = Math.floor(r / 10), o = r % 10;
      if (o) parts.push(`${ones[o]} و${tens[t]}`);
      else parts.push(tens[t]);
    }
    return parts.join(" و");
  };

  if (n < 1000) return under1000(n);

  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) {
    parts.push(millions === 1 ? "مليون" : millions === 2 ? "مليونان" : `${under1000(millions)} ${millions <= 10 ? "ملايين" : "مليون"}`);
  }
  if (thousands) {
    parts.push(thousands === 1 ? "ألف" : thousands === 2 ? "ألفان" : `${under1000(thousands)} ${thousands <= 10 ? "آلاف" : "ألف"}`);
  }
  if (rest) parts.push(under1000(rest));
  return parts.join(" و");
}
