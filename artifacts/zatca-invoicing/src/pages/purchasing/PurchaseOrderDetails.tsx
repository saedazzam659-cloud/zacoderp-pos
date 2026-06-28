import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  BookOpenCheck,
  Link2,
  FileCheck2,
  ExternalLink,
  Loader2,
  Info,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface PurchaseOrderDetailsProps {
  /** The saved order id (null for a brand-new unsaved order). */
  docId: number | null;
  /** The purchase invoice this order was converted into (null otherwise). */
  convertedInvoiceId: number | null;
  /** Resolved company id (undefined for superadmin multi-company view). */
  cid?: number;
  token: string;
  /** wouter navigate — used by the "open in full screen" affordance. */
  navigate: (to: string) => void;
}

/**
 * التفاصيل (SAP-style "Details" tab) for a purchase ORDER.
 *
 * Purchase orders are deliberately finance-FREE — saving one writes no
 * journal entry, stock movement, voucher, or supplier balance. The only
 * downstream effect an order can have is being CONVERTED into a (draft)
 * purchase invoice. So this tab honestly shows:
 *   • a note that the order itself produces no accounting entry, and
 *   • the linked purchase invoice (clickable → in-screen modal) once converted.
 *
 * A new (unsaved) order shows a friendly placeholder instead.
 */
export default function PurchaseOrderDetails({
  docId,
  convertedInvoiceId,
  cid,
  token,
  navigate,
}: PurchaseOrderDetailsProps) {
  const { fmt, isRtl } = useFormatters();
  const authH = { Authorization: `Bearer ${token}` };
  const qp = cid ? `?companyId=${cid}` : "";

  const [openInvoice, setOpenInvoice] = useState(false);

  // Linked purchase invoice — fetched lazily only when the user opens its
  // in-screen modal.
  const { data: invoice, isLoading: invLoading } = useQuery<any>({
    queryKey: ["po-details-invoice", convertedInvoiceId, cid],
    enabled: !!convertedInvoiceId && openInvoice,
    queryFn: async () => {
      const r = await fetch(`${API}/api/purchasing/purchase-invoices/${convertedInvoiceId}${qp}`, { headers: authH });
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
          ستظهر هنا تفاصيل العمليات المرتبطة بأمر الشراء — مثل فاتورة الشراء
          الناتجة عن تحويله — بعد حفظ الأمر وتحويله إلى فاتورة.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ═══ القيد المحاسبي ════════════════════════════════════════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <BookOpenCheck className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-bold">القيد المحاسبي</h3>
            <p className="text-[11px] text-muted-foreground">الأثر المحاسبي لأمر الشراء</p>
          </div>
        </div>
        <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
          أوامر الشراء عمليات تشغيلية لا تُنشئ قيوداً محاسبية أو حركات مخزنية.
          يظهر الأثر المحاسبي عند تحويل الأمر إلى فاتورة شراء وترحيلها.
        </div>
      </section>

      {/* ═══ العمليات المرتبطة ══════════════════════════════════════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100">
            <Link2 className="h-4 w-4 text-amber-700" />
          </div>
          <div>
            <h3 className="text-sm font-bold">العمليات المرتبطة</h3>
            <p className="text-[11px] text-muted-foreground">المستندات الناشئة عن هذا الأمر</p>
          </div>
        </div>

        {convertedInvoiceId ? (
          <button
            type="button"
            onClick={() => setOpenInvoice(true)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-right transition-all hover:border-green-300 hover:shadow-sm"
            data-testid="details-card-purchase-invoice"
          >
            <div className="flex items-center gap-2">
              <FileCheck2 className="h-4 w-4 text-green-700" />
              <span className="text-sm">فاتورة الشراء الناتجة</span>
              <span className="font-mono text-[11px] text-muted-foreground">INV-{convertedInvoiceId}</span>
            </div>
            <span className="text-[11px] text-primary">عرض التفاصيل ←</span>
          </button>
        ) : (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
            لا توجد عمليات مرتبطة بهذا الأمر حتى الآن — لم يُحوَّل إلى فاتورة بعد.
          </div>
        )}
      </section>

      {/* ════════════════════ MODALS ════════════════════ */}

      {/* Purchase-invoice breakdown */}
      <Dialog open={openInvoice} onOpenChange={setOpenInvoice}>
        <DialogContent className="max-w-2xl" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCheck2 className="h-5 w-5 text-green-700" />
              فاتورة الشراء {invoice?.docNumber ? `— ${invoice.docNumber}` : `INV-${convertedInvoiceId ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {invoice?.invoiceDate ?? invoice?.date ?? ""}
            </DialogDescription>
          </DialogHeader>
          {invLoading ? (
            <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل الفاتورة…
            </div>
          ) : !invoice ? (
            <div className="px-1 py-6 text-center text-xs text-muted-foreground">
              تعذّر تحميل فاتورة الشراء.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <DetailRow label="الحالة" value={invoice.status === "posted" ? "مُرحَّلة" : "مسودة"} />
                <DetailRow label="الإجمالي" value={fmt(Number(invoice.totalAmount ?? 0))} mono />
                <DetailRow label="الضريبة" value={fmt(Number(invoice.vatAmount ?? 0))} mono />
                <DetailRow label="عدد السطور" value={String((invoice.lines ?? []).length)} />
              </div>
              {(invoice.lines ?? []).length > 0 && (
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
                      {(invoice.lines ?? []).map((l: any, i: number) => (
                        <tr key={l.id ?? i} className="border-t">
                          <td className="px-3 py-2 text-right">{l.itemName ?? l.description ?? "—"}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{Number(l.qty ?? 0)}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{fmt(Number(l.unitPrice ?? 0))}</td>
                          <td className="px-3 py-2 text-left font-mono" dir="ltr">{fmt(Number(l.lineTotal ?? 0))}</td>
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
              onClick={() => convertedInvoiceId && navigate(`/purchasing/invoices/${convertedInvoiceId}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> فتح الفاتورة كاملة
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/20 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-sm font-semibold" : "text-sm font-medium"} dir={mono ? "ltr" : undefined}>
        {value}
      </span>
    </div>
  );
}
