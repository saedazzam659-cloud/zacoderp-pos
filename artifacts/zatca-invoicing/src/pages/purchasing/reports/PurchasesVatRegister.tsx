import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { useTranslation } from "react-i18next";
import { useFmt } from "@/hooks/use-fmt";
import { toast } from "@/hooks/use-toast";
import { saveWorkbook, saveBlob } from "@/lib/saveFile";
import { htmlToPdfBlob } from "@/lib/deliveryReceiptPrint";
import { openWhatsApp } from "@/lib/whatsapp";
import { FileSpreadsheet, FileText, Printer, Send, Search, MessageCircle, ClipboardList } from "lucide-react";
import * as XLSX from "xlsx";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface RegisterRow {
  serial: number;
  entryDate: string;
  entryNumber: string;
  invoiceDate: string;
  invoiceNumber: string;
  supplierName: string;
  supplierVatNumber: string;
  statement: string;
  taxRate: number;
  base: number;
  vat: number;
  gross: number;
  notes: string;
  id: number;
}
interface RegisterData {
  period: { from: string; to: string };
  items: RegisterRow[];
  totals: { base: number; vat: number; gross: number; count: number };
  dominantRate: number;
}

export default function PurchasesVatRegister() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const companyName =
    (isRtl ? user?.company?.nameAr : user?.company?.nameEn) || user?.company?.name || "";

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [searched, setSearched] = useState(false);

  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [sending, setSending] = useState(false);

  const tr = (k: string, opts?: any): string => t(`purchasingReports.vatRegister.${k}`, opts) as string;

  const { data, isLoading, refetch, isFetching } = useQuery<RegisterData>({
    queryKey: ["purchases-vat-register", cid, from, to, token],
    enabled: !!token && searched,
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const qs = new URLSearchParams({ from, to });
      if (cid) qs.set("companyId", String(cid));
      const r = await fetch(`${API}/api/reports/purchases-vat-register?${qs.toString()}`, {
        headers, credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "فشل تحميل التقرير");
      return r.json();
    },
  });

  const items = data?.items ?? [];
  const totals = data?.totals ?? { base: 0, vat: 0, gross: 0, count: 0 };
  const rate = data?.dominantRate ?? 15;
  const reportTitle = tr("reportTitle", { rate });

  const cols = [
    { key: "serial",            header: tr("col.serial"),        num: false },
    { key: "entryDate",         header: tr("col.entryDate"),     num: false },
    { key: "entryNumber",       header: tr("col.entryNumber"),   num: false },
    { key: "invoiceDate",       header: tr("col.invoiceDate"),   num: false },
    { key: "invoiceNumber",     header: tr("col.invoiceNumber"), num: false },
    { key: "supplierName",      header: tr("col.supplier"),      num: false },
    { key: "supplierVatNumber", header: tr("col.supplierVat"),   num: false },
    { key: "statement",         header: tr("col.statement"),     num: false },
    { key: "taxRate",           header: tr("col.taxRate"),       num: true  },
    { key: "base",              header: tr("col.base"),          num: true  },
    { key: "vat",               header: tr("col.vat"),           num: true  },
    { key: "gross",             header: tr("col.gross"),         num: true  },
    { key: "notes",             header: tr("col.notes"),         num: false },
  ] as const;

  const cell = (r: RegisterRow, key: string): string => {
    switch (key) {
      case "serial":  return String(r.serial);
      case "taxRate": return `${fmt(r.taxRate)}%`;
      case "base":    return fmt(r.base);
      case "vat":     return fmt(r.vat);
      case "gross":   return fmt(r.gross);
      default:        return String((r as any)[key] ?? "");
    }
  };

  function buildHtml(): string {
    const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    const head = cols.map(c => `<th>${esc(c.header)}</th>`).join("");
    const body = items.map(r => `<tr>${cols.map(c => `<td class="${c.num ? "num" : ""}">${esc(cell(r, c.key))}</td>`).join("")}</tr>`).join("");
    const totalRow = `<tr class="totals">
      <td colspan="9">${esc(tr("total"))}</td>
      <td class="num">${esc(fmt(totals.base))}</td>
      <td class="num">${esc(fmt(totals.vat))}</td>
      <td class="num">${esc(fmt(totals.gross))}</td>
      <td></td>
    </tr>`;
    return `<!doctype html><html dir="${isRtl ? "rtl" : "ltr"}" lang="${isRtl ? "ar" : "en"}"><head><meta charset="utf-8">
      <title>${esc(reportTitle)}</title>
      <style>
        *{box-sizing:border-box} body{font-family:Arial,"Segoe UI",sans-serif;margin:16px;color:#111}
        h1{font-size:16px;text-align:center;margin:0 0 4px} .sub{text-align:center;font-size:12px;color:#444;margin:0 0 12px}
        .company{text-align:center;font-size:13px;font-weight:bold;margin:0 0 6px}
        table{width:100%;border-collapse:collapse;font-size:11px}
        th,td{border:1px solid #333;padding:5px 6px;text-align:${isRtl ? "right" : "left"}}
        th{background:#2563eb;color:#fff;font-weight:bold;text-align:center}
        td.num{text-align:center;font-variant-numeric:tabular-nums}
        tr:nth-child(even) td{background:#f7f7f7}
        tr.totals td{background:#fde047;font-weight:bold;text-align:center}
        @media print{body{margin:6px}}
      </style></head><body>
      ${companyName ? `<div class="company">${esc(companyName)}</div>` : ""}
      <h1>${esc(reportTitle)}</h1>
      <div class="sub">${esc(tr("periodLabel", { from, to }))}</div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}${items.length ? totalRow : ""}</tbody></table>
      </body></html>`;
  }

  function fileBase() { return `purchases-vat-register-${from}_${to}`; }

  function handlePrint() {
    const w = window.open("", "_blank", "width=1200,height=800");
    if (!w) { toast({ title: tr("popupBlocked"), variant: "destructive" }); return; }
    w.document.write(buildHtml());
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  function handleExcel() {
    const aoa: any[][] = [];
    if (companyName) aoa.push([companyName]);
    aoa.push([reportTitle]);
    aoa.push([tr("periodLabel", { from, to })]);
    aoa.push([]);
    aoa.push(cols.map(c => c.header));
    for (const r of items) aoa.push(cols.map(c => (c.num && c.key !== "taxRate" ? (r as any)[c.key] : c.key === "taxRate" ? r.taxRate : (r as any)[c.key] ?? "")));
    aoa.push([tr("total"), "", "", "", "", "", "", "", "", totals.base, totals.vat, totals.gross, ""]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "VAT");
    void saveWorkbook(wb, `${fileBase()}.xlsx`);
  }

  async function handlePdf(): Promise<Blob> {
    const blob = await htmlToPdfBlob(buildHtml());
    return blob;
  }

  async function handlePdfDownload() {
    const blob = await handlePdf();
    await saveBlob(blob, `${fileBase()}.pdf`);
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = String(reader.result || "");
        resolve(res.includes(",") ? res.split(",")[1] : res); // strip data: prefix → RAW base64 (WAF-safe)
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function handleSendEmail() {
    if (!emailTo.trim()) { toast({ title: tr("emailRequired"), variant: "destructive" }); return; }
    setSending(true);
    try {
      const blob = await handlePdf();
      const b64 = await blobToBase64(blob);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const r = await fetch(`${API}/api/reports/email`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({
          to: emailTo.trim(),
          subject: reportTitle,
          body: `${companyName ? companyName + "<br/>" : ""}${reportTitle}<br/>${tr("periodLabel", { from, to })}`,
          attachmentBase64: b64,
          attachmentName: `${fileBase()}.pdf`,
          attachmentMime: "application/pdf",
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || tr("emailFailed"));
      toast({ title: tr("emailSent") });
      setEmailOpen(false);
      setEmailTo("");
    } catch (e: any) {
      toast({ title: e?.message || tr("emailFailed"), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  function handleWhatsApp() {
    const lines = [
      companyName,
      reportTitle,
      tr("periodLabel", { from, to }),
      `${tr("col.base")}: ${fmt(totals.base)}`,
      `${tr("col.vat")}: ${fmt(totals.vat)}`,
      `${tr("col.gross")}: ${fmt(totals.gross)}`,
      `${tr("invoiceCount")}: ${totals.count}`,
    ].filter(Boolean);
    openWhatsApp(lines.join("\n"));
  }

  const hasData = items.length > 0;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        {hasData && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handlePrint}><Printer className="h-4 w-4" />{tr("print")}</Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExcel}><FileSpreadsheet className="h-4 w-4" />Excel</Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handlePdfDownload}><FileText className="h-4 w-4" />PDF</Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleWhatsApp}><MessageCircle className="h-4 w-4" />WhatsApp</Button>
            <Button size="sm" className="gap-1.5" onClick={() => setEmailOpen(true)}><Send className="h-4 w-4" />{tr("sendToZatca")}</Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.fromDate")}</Label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.toDate")}</Label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Button className="w-full gap-1.5" onClick={() => { setSearched(true); refetch(); }} disabled={isFetching}>
            <Search className="h-4 w-4" />{tr("show")}
          </Button>
        </div>
      </div>

      {hasData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">{tr("invoiceCount")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{totals.count}</p>
          </div>
          <div className="rounded-xl border bg-blue-50 border-blue-200 p-3">
            <p className="text-[11px] text-blue-700">{tr("col.base")}</p>
            <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.base)}</p>
          </div>
          <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
            <p className="text-[11px] text-amber-700">{tr("col.vat")}</p>
            <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.vat)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
            <p className="text-[11px] text-muted-foreground">{tr("col.gross")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.gross)}</p>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        {searched && (
          <div className="px-4 py-3 border-b bg-muted/30 text-center">
            <p className="font-bold text-sm">{reportTitle}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{tr("periodLabel", { from, to })}</p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1100px]">
            <thead className="bg-blue-600 text-white">
              <tr>
                {cols.map(c => (
                  <th key={c.key} className={`px-2 py-2 font-semibold whitespace-nowrap ${c.num ? "text-center" : isRtl ? "text-right" : "text-left"}`}>{c.header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {!searched
                ? <tr><td colSpan={cols.length} className="py-12 text-center text-muted-foreground">{tr("pickPeriod")}</td></tr>
                : isLoading || isFetching
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={cols.length} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : !hasData
                ? <tr><td colSpan={cols.length} className="py-12 text-center text-muted-foreground">{tr("noData")}</td></tr>
                : items.map(r => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      {cols.map(c => (
                        <td key={c.key} className={`px-2 py-2 whitespace-nowrap ${c.num ? "text-center tabular-nums" : isRtl ? "text-right" : "text-left"}`}>{cell(r, c.key)}</td>
                      ))}
                    </tr>
                  ))}
            </tbody>
            {hasData && (
              <tfoot>
                <tr className="bg-yellow-300 font-bold">
                  <td colSpan={9} className="px-2 py-2 text-center">{tr("total")}</td>
                  <td className="px-2 py-2 text-center tabular-nums">{fmt(totals.base)}</td>
                  <td className="px-2 py-2 text-center tabular-nums">{fmt(totals.vat)}</td>
                  <td className="px-2 py-2 text-center tabular-nums">{fmt(totals.gross)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle>{tr("emailTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{tr("emailTo")}</Label>
            <Input
              type="email"
              value={emailTo}
              onChange={e => setEmailTo(e.target.value)}
              placeholder={tr("emailToPh")}
            />
            <p className="text-xs text-muted-foreground">{tr("emailHint")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailOpen(false)} disabled={sending}>{tr("cancel")}</Button>
            <Button onClick={handleSendEmail} disabled={sending} className="gap-1.5">
              <Send className="h-4 w-4" />{sending ? tr("sending") : tr("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
