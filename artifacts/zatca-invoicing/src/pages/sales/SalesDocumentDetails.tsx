import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFormatters } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  BookOpenCheck,
  Receipt,
  Banknote,
  Link2,
  FileText,
  Undo2,
  Truck,
  ExternalLink,
  Loader2,
  Info,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SalesDocumentDetailsProps {
  /** The saved document id (null for a brand-new unsaved doc). */
  docId: number | null;
  /** The loaded document object (carries journalEntryId, status, totals, …). */
  doc: any;
  isInvoice: boolean;
  isOrder: boolean;
  isQuotation: boolean;
  /** Resolved company id (undefined for superadmin multi-company view). */
  cid?: number;
  token: string;
  /** wouter navigate — used by the "open in full screen" affordance. */
  navigate: (to: string) => void;
}

/**
 * التفاصيل (SAP-style "Details" tab) for a sales document.
 *
 * Shows — read-only and on demand — every downstream effect of the saved
 * document:
 *   • القيد المحاسبي الناتج (resulting journal entry)
 *   • سندات القبض/الدفع المرتبطة (linked receipt / payment vouchers)
 *   • العمليات المرتبطة (linked operations: source quotation, sales returns,
 *     goods-delivery notes)
 *
 * Each operation is a clickable card that opens an in-screen modal with the
 * full breakdown — the user never leaves the form. A new (unsaved) document
 * shows a friendly placeholder instead.
 */
export default function SalesDocumentDetails({
  docId,
  doc,
  isInvoice,
  cid,
  token,
  navigate,
}: SalesDocumentDetailsProps) {
  const { fmt, isRtl } = useFormatters();
  const authH = { Authorization: `Bearer ${token}` };
  const qp = cid ? `?companyId=${cid}` : "";

  // ── modal state: which operation is expanded ──────────────────────────
  const [openJe, setOpenJe] = useState(false);
  const [openVoucher, setOpenVoucher] = useState<any | null>(null);
  const [openReturn, setOpenReturn] = useState<any | null>(null);
  const [openQuotation, setOpenQuotation] = useState(false);

  const jeId = doc?.journalEntryId ?? null;

  // Resulting journal entry (header + lines).
  const { data: je, isLoading: jeLoading } = useQuery<any>({
    queryKey: ["sales-doc-details-je", jeId],
    enabled: !!jeId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/journal-entries/${jeId}${qp}`, { headers: authH });
      return r.ok ? r.json() : null;
    },
  });

  // Chart of accounts → resolve account names for the JE lines.
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["sales-doc-details-accounts", cid],
    enabled: !!jeId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts${qp || ""}${qp ? "&" : "?"}limit=5000`, { headers: authH });
      return r.ok ? r.json() : [];
    },
  });

  const accName = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts as any[]) {
      m.set(Number(a.id), `${a.code ? a.code + " — " : ""}${isRtl ? (a.nameAr ?? a.nameEn) : (a.nameEn ?? a.nameAr)}`);
    }
    return m;
  }, [accounts, isRtl]);

  // Linked receipt vouchers (invoice only) — filtered client-side by the FK.
  const { data: allVouchers = [], isLoading: vLoading } = useQuery<any[]>({
    queryKey: ["sales-doc-details-vouchers", cid],
    enabled: !!docId && isInvoice,
    queryFn: async () => {
      const r = await fetch(`${API}/api/receipt-vouchers${qp}`, { headers: authH });
      const j = r.ok ? await r.json() : [];
      return Array.isArray(j) ? j : [];
    },
  });
  const vouchers = useMemo(
    () => (allVouchers as any[]).filter((v) => Number(v.salesInvoiceId) === Number(docId)),
    [allVouchers, docId],
  );

  // Linked sales returns (invoice only) — filtered client-side by invoiceId.
  const { data: allReturns = [], isLoading: rLoading } = useQuery<any[]>({
    queryKey: ["sales-doc-details-returns", cid],
    enabled: !!docId && isInvoice,
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales/sales-returns${qp}`, { headers: authH });
      const j = r.ok ? await r.json() : [];
      return Array.isArray(j) ? j : [];
    },
  });
  const returns = useMemo(
    () => (allReturns as any[]).filter((x) => Number(x.invoiceId) === Number(docId)),
    [allReturns, docId],
  );

  // Source quotation (when this invoice was converted from one) — fetched
  // lazily only when the user opens its in-screen modal.
  const srcQuotationId = doc?.sourceQuotationId ?? null;
  const { data: srcQuotation, isLoading: qLoading } = useQuery<any>({
    queryKey: ["sales-doc-details-src-quotation", srcQuotationId, cid],
    enabled: !!srcQuotationId && openQuotation,
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales/sales-quotations/${srcQuotationId}${qp}`, { headers: authH });
      return r.ok ? r.json() : null;
    },
  });

  // ── empty state: nothing to show yet ──────────────────────────────────
  if (!docId) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <Info className="h-7 w-7 text-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">لا توجد تفاصيل بعد</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          ستظهر هنا تفاصيل العمليات الناتجة عن هذا المستند — القيد المحاسبي،
          وسندات القبض/الدفع، والعمليات المرتبطة — بعد حفظ المستند وترحيله.
        </p>
      </div>
    );
  }

  const jeBalanced = je
    ? Math.abs((je.lines ?? []).reduce((s: number, l: any) => s + Number(l.debit ?? 0), 0) -
        (je.lines ?? []).reduce((s: number, l: any) => s + Number(l.credit ?? 0), 0)) < 0.01
    : false;

  return (
    <div className="space-y-6">
      {/* ═══ القيد المحاسبي الناتج ═══════════════════════════════════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <BookOpenCheck className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-bold">القيد المحاسبي الناتج</h3>
            <p className="text-[11px] text-muted-foreground">القيد التلقائي المُرحَّل عن هذا المستند</p>
          </div>
        </div>

        {!jeId ? (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
            لم يُرحَّل هذا المستند بعد — لا يوجد قيد محاسبي. سيظهر القيد فور ترحيل المستند.
          </div>
        ) : jeLoading ? (
          <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل القيد…
          </div>
        ) : !je ? (
          <div className="rounded-xl border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
            تعذّر تحميل القيد المحاسبي.
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpenJe(true)}
            className="w-full rounded-xl border bg-card p-4 text-right transition-all hover:border-primary/40 hover:shadow-sm"
            data-testid="details-card-je"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-sm font-semibold">{je.docNumber ?? `JE-${je.id}`}</span>
                <Badge variant="outline" className="text-[10px]">
                  {je.status === "posted" ? "مُرحَّل" : "مسودة"}
                </Badge>
                {jeBalanced && (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">متوازن</Badge>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground">{je.entryDate ?? ""}</span>
            </div>
            <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span>{(je.lines ?? []).length} سطر</span>
              <span dir="ltr" className="font-mono">
                {fmt((je.lines ?? []).reduce((s: number, l: any) => s + Number(l.debit ?? 0), 0))}
              </span>
              <span className="text-primary">عرض التفاصيل ←</span>
            </div>
          </button>
        )}
      </section>

      {/* ═══ سندات القبض / الدفع ════════════════════════════════════════ */}
      {isInvoice && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
              <Banknote className="h-4 w-4 text-emerald-700" />
            </div>
            <div>
              <h3 className="text-sm font-bold">سندات القبض المرتبطة</h3>
              <p className="text-[11px] text-muted-foreground">المبالغ المُحصَّلة على هذه الفاتورة</p>
            </div>
          </div>

          {vLoading ? (
            <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
            </div>
          ) : vouchers.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
              لا توجد سندات قبض مرتبطة بهذه الفاتورة.
            </div>
          ) : (
            <div className="space-y-2">
              {vouchers.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setOpenVoucher(v)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-right transition-all hover:border-emerald-300 hover:shadow-sm"
                  data-testid={`details-card-voucher-${v.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-emerald-700" />
                    <span className="font-mono text-sm font-semibold">{v.voucherNumber ?? v.docNumber ?? `RV-${v.id}`}</span>
                    <span className="text-[11px] text-muted-foreground">{v.voucherDate ?? v.date ?? ""}</span>
                  </div>
                  <span dir="ltr" className="font-mono text-sm font-semibold text-emerald-700">
                    {fmt(Number(v.amount ?? 0))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ═══ العمليات المرتبطة ══════════════════════════════════════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100">
            <Link2 className="h-4 w-4 text-amber-700" />
          </div>
          <div>
            <h3 className="text-sm font-bold">العمليات المرتبطة</h3>
            <p className="text-[11px] text-muted-foreground">المستندات الناشئة عن هذا المستند أو المصدر له</p>
          </div>
        </div>

        <div className="space-y-2">
          {/* المصدر: عرض سعر */}
          {srcQuotationId && (
            <button
              type="button"
              onClick={() => setOpenQuotation(true)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-right transition-all hover:border-primary/40 hover:shadow-sm"
              data-testid="details-card-source-quotation"
            >
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">عرض السعر المصدر</span>
                <span className="font-mono text-[11px] text-muted-foreground">#{srcQuotationId}</span>
              </div>
              <span className="text-[11px] text-primary">عرض التفاصيل ←</span>
            </button>
          )}

          {/* مرتجعات المبيعات */}
          {isInvoice && (rLoading ? (
            <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل المرتجعات…
            </div>
          ) : returns.length > 0 ? (
            returns.map((rt) => (
              <button
                key={rt.id}
                type="button"
                onClick={() => setOpenReturn(rt)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-right transition-all hover:border-rose-300 hover:shadow-sm"
                data-testid={`details-card-return-${rt.id}`}
              >
                <div className="flex items-center gap-2">
                  <Undo2 className="h-4 w-4 text-rose-600" />
                  <span className="text-sm">مرتجع مبيعات</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{rt.docNumber ?? `SR-${rt.id}`}</span>
                  <span className="text-[11px] text-muted-foreground">{rt.returnDate ?? rt.date ?? ""}</span>
                </div>
                <span dir="ltr" className="font-mono text-sm font-semibold text-rose-600">
                  {fmt(Number(rt.totalAmount ?? 0))}
                </span>
              </button>
            ))
          ) : null)}

          {/* لا شيء */}
          {!srcQuotationId && !(isInvoice && returns.length > 0) && !rLoading && (
            <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
              لا توجد عمليات مرتبطة بهذا المستند حتى الآن.
            </div>
          )}
        </div>
      </section>

      {/* ════════════════════ MODALS ════════════════════ */}

      {/* JE breakdown */}
      <Dialog open={openJe} onOpenChange={setOpenJe}>
        <DialogContent className="max-w-3xl" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpenCheck className="h-5 w-5 text-primary" />
              القيد المحاسبي {je?.docNumber ? `— ${je.docNumber}` : ""}
            </DialogTitle>
            <DialogDescription>
              {je?.entryDate ?? ""} · {je?.description ?? ""}
            </DialogDescription>
          </DialogHeader>
          {je && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">الحساب</th>
                    <th className="px-3 py-2 text-right font-medium">البيان</th>
                    <th className="px-3 py-2 text-left font-medium">مدين</th>
                    <th className="px-3 py-2 text-left font-medium">دائن</th>
                  </tr>
                </thead>
                <tbody>
                  {(je.lines ?? []).map((l: any, i: number) => (
                    <tr key={l.id ?? i} className="border-t">
                      <td className="px-3 py-2 text-right">{accName.get(Number(l.accountId)) ?? `#${l.accountId}`}</td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{l.description ?? ""}</td>
                      <td className="px-3 py-2 text-left font-mono" dir="ltr">{Number(l.debit ?? 0) ? fmt(Number(l.debit)) : ""}</td>
                      <td className="px-3 py-2 text-left font-mono" dir="ltr">{Number(l.credit ?? 0) ? fmt(Number(l.credit)) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-3 py-2 text-right" colSpan={2}>الإجمالي</td>
                    <td className="px-3 py-2 text-left font-mono" dir="ltr">
                      {fmt((je.lines ?? []).reduce((s: number, l: any) => s + Number(l.debit ?? 0), 0))}
                    </td>
                    <td className="px-3 py-2 text-left font-mono" dir="ltr">
                      {fmt((je.lines ?? []).reduce((s: number, l: any) => s + Number(l.credit ?? 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-1.5"
              onClick={() => je && navigate(`/accounting/journal-entries/${je.id}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> فتح القيد كاملاً
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Voucher breakdown */}
      <Dialog open={!!openVoucher} onOpenChange={(o) => !o && setOpenVoucher(null)}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-emerald-700" />
              سند قبض {openVoucher?.voucherNumber ? `— ${openVoucher.voucherNumber}` : ""}
            </DialogTitle>
          </DialogHeader>
          {openVoucher && (
            <div className="space-y-2 text-sm">
              <DetailRow label="التاريخ" value={openVoucher.voucherDate ?? openVoucher.date ?? "—"} />
              <DetailRow label="المبلغ" value={fmt(Number(openVoucher.amount ?? 0))} mono />
              <DetailRow label="طريقة الدفع" value={openVoucher.paymentMethod === "bank" ? "بنك" : openVoucher.paymentMethod === "cash" ? "نقدي" : (openVoucher.paymentMethod ?? "—")} />
              {openVoucher.notes && <DetailRow label="ملاحظات" value={openVoucher.notes} />}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-1.5"
              onClick={() => openVoucher && navigate(`/cash/receipt-vouchers/${openVoucher.id}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> فتح السند
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Return breakdown */}
      <Dialog open={!!openReturn} onOpenChange={(o) => !o && setOpenReturn(null)}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Undo2 className="h-5 w-5 text-rose-600" />
              مرتجع مبيعات {openReturn?.docNumber ? `— ${openReturn.docNumber}` : ""}
            </DialogTitle>
          </DialogHeader>
          {openReturn && (
            <div className="space-y-2 text-sm">
              <DetailRow label="التاريخ" value={openReturn.returnDate ?? openReturn.date ?? "—"} />
              <DetailRow label="الإجمالي" value={fmt(Number(openReturn.totalAmount ?? 0))} mono />
              {openReturn.status && <DetailRow label="الحالة" value={openReturn.status === "posted" ? "مُرحَّل" : "مسودة"} />}
              {openReturn.notes && <DetailRow label="ملاحظات" value={openReturn.notes} />}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-1.5"
              onClick={() => openReturn && navigate(`/sales/returns/${openReturn.id}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> فتح المرتجع
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Source-quotation breakdown */}
      <Dialog open={openQuotation} onOpenChange={setOpenQuotation}>
        <DialogContent className="max-w-2xl" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              عرض السعر المصدر {srcQuotation?.docNumber ? `— ${srcQuotation.docNumber}` : `#${srcQuotationId ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {srcQuotation?.docDate ?? srcQuotation?.date ?? ""}
            </DialogDescription>
          </DialogHeader>
          {qLoading ? (
            <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل عرض السعر…
            </div>
          ) : !srcQuotation ? (
            <div className="px-1 py-6 text-center text-xs text-muted-foreground">
              تعذّر تحميل عرض السعر المصدر.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <DetailRow label="العميل" value={srcQuotation.customerName ?? "—"} />
                <DetailRow label="الحالة" value={srcQuotation.status === "converted" ? "محوَّل" : srcQuotation.status === "accepted" ? "مقبول" : (srcQuotation.status ?? "—")} />
                <DetailRow label="الإجمالي" value={fmt(Number(srcQuotation.totalAmount ?? 0))} mono />
                <DetailRow label="عدد السطور" value={String((srcQuotation.lines ?? []).length)} />
              </div>
              {(srcQuotation.lines ?? []).length > 0 && (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium">الصنف</th>
                        <th className="px-3 py-2 text-left font-medium">الكمية</th>
                        <th className="px-3 py-2 text-left font-medium">السعر</th>
                        <th className="px-3 py-2 text-left font-medium">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(srcQuotation.lines ?? []).map((l: any, i: number) => (
                        <tr key={l.id ?? i} className="border-t">
                          <td className="px-3 py-2 text-right">{l.itemName ?? l.description ?? `#${l.itemId ?? ""}`}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{Number(l.quantity ?? 0) || ""}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{fmt(Number(l.unitPrice ?? 0))}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{fmt(Number(l.lineTotal ?? l.total ?? 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-1.5"
              onClick={() => srcQuotationId && navigate(`/sales/quotations/${srcQuotationId}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> فتح عرض السعر كاملاً
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-medium", mono && "font-mono")} dir={mono ? "ltr" : undefined}>{value}</span>
    </div>
  );
}
