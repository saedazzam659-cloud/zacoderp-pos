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
import {
  BookOpenCheck,
  Link2,
  FileText,
  ExternalLink,
  Loader2,
  Info,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface ReturnDocumentDetailsProps {
  /** The saved return id (null for a brand-new unsaved return). */
  docId: number | null;
  /** The loaded return row (carries journalEntryId, status, totals, invoiceId…). */
  doc: any;
  /** Resolved company id (undefined for superadmin multi-company view). */
  cid?: number;
  token: string;
  /** wouter navigate — used by the "open in full screen" affordance. */
  navigate: (to: string) => void;
  /** Source-invoice id this return was raised against (null if standalone). */
  sourceInvoiceId?: number | null;
  /** Human label for the source invoice card, e.g. "فاتورة الشراء المصدر". */
  sourceInvoiceLabel: string;
  /** Display prefix for the source invoice number, e.g. "PI-" / "INV-". */
  sourceInvoicePrefix: string;
  /** Route to open the source invoice read-only, e.g. "/purchasing/invoices". */
  sourceInvoiceRoute: string;
  /** Friendly empty-state copy describing what will appear once saved+posted. */
  emptyStateText: string;
}

/**
 * التفاصيل (SAP-style "Details" tab) shared by purchase & sales RETURNS.
 *
 * A posted return has a real accounting footprint, and it is almost always
 * raised against a source invoice. This tab honestly surfaces — read-only and
 * on demand — both links of the saved return:
 *   • القيد المحاسبي الناتج (resulting journal entry, expandable in a modal)
 *   • الفاتورة المصدر (source invoice, clickable → opens read-only full screen)
 *
 * A new (unsaved) return shows a friendly placeholder instead.
 */
export default function ReturnDocumentDetails({
  docId,
  doc,
  cid,
  token,
  navigate,
  sourceInvoiceId,
  sourceInvoiceLabel,
  sourceInvoicePrefix,
  sourceInvoiceRoute,
  emptyStateText,
}: ReturnDocumentDetailsProps) {
  const { fmt, isRtl } = useFormatters();
  const authH = { Authorization: `Bearer ${token}` };
  const qp = cid ? `?companyId=${cid}` : "";

  const [openJe, setOpenJe] = useState(false);

  const jeId = doc?.journalEntryId ?? null;

  // Resulting journal entry (header + lines).
  const { data: je, isLoading: jeLoading } = useQuery<any>({
    queryKey: ["ret-doc-details-je", jeId],
    enabled: !!jeId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/journal-entries/${jeId}${qp}`, { headers: authH });
      return r.ok ? r.json() : null;
    },
  });

  // Chart of accounts → resolve account names for the JE lines.
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["ret-doc-details-accounts", cid],
    enabled: !!jeId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts${qp || ""}${qp ? "&" : "?"}limit=5000`, { headers: authH });
      const j = r.ok ? await r.json() : [];
      return Array.isArray(j) ? j : [];
    },
  });

  const accName = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts as any[]) {
      m.set(Number(a.id), `${a.code ? a.code + " — " : ""}${isRtl ? (a.nameAr ?? a.nameEn) : (a.nameEn ?? a.nameAr)}`);
    }
    return m;
  }, [accounts, isRtl]);

  // ── empty state: nothing to show yet ──────────────────────────────────
  if (!docId) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <Info className="h-7 w-7 text-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">لا توجد تفاصيل بعد</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{emptyStateText}</p>
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
            <p className="text-[11px] text-muted-foreground">القيد التلقائي المُرحَّل عن هذا المرتجع</p>
          </div>
        </div>

        {!jeId ? (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
            لم يُرحَّل هذا المرتجع بعد — لا يوجد قيد محاسبي. سيظهر القيد فور الترحيل.
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

      {/* ═══ الفاتورة المصدر ════════════════════════════════════════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100">
            <Link2 className="h-4 w-4 text-amber-700" />
          </div>
          <div>
            <h3 className="text-sm font-bold">الفاتورة المصدر</h3>
            <p className="text-[11px] text-muted-foreground">الفاتورة التي صدر عنها هذا المرتجع</p>
          </div>
        </div>

        {sourceInvoiceId ? (
          <button
            type="button"
            onClick={() => navigate(`${sourceInvoiceRoute}/${sourceInvoiceId}?view=1`)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-right transition-all hover:border-primary/40 hover:shadow-sm"
            data-testid="details-card-source-invoice"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{sourceInvoiceLabel}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {`${sourceInvoicePrefix}${sourceInvoiceId}`}
              </span>
            </div>
            <span className="text-[11px] text-primary">فتح الفاتورة ←</span>
          </button>
        ) : (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
            هذا المرتجع غير مرتبط بفاتورة مصدر (مرتجع مباشر).
          </div>
        )}
      </section>

      {/* ════════════════════ MODAL: JE breakdown ════════════════════ */}
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
    </div>
  );
}
