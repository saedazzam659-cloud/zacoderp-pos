import { useMemo, useState } from "react";
import EmbeddedPaymentForm from "@/components/documents/EmbeddedPaymentForm";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useFormatters } from "@/lib/format";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Wallet, Plus, ExternalLink, CircleCheck, CircleAlert, CircleX, Info, Link2, Unlink,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface InvoicePaymentsTabProps {
  /** Saved invoice id — null while the invoice is still a new/unsaved draft. */
  invoiceId: number | null;
  /** Human invoice number, only for labels. */
  docNumber?: string;
  companyId?: number;
  token?: string | null;
  customerId?: string;
  customerName?: string;
  /** Invoice grand total (net of header/line discounts) in document currency. */
  invoiceTotal: number;
  /** Invoice exchange rate (document currency → base). Defaults to 1 (base). */
  invoiceExchangeRate?: number;
  /** Header payment context — used to prefill the receipt voucher. */
  paymentType?: string;
  cashBoxId?: string;
  bankAccountId?: string;
  /** كود عملة الفاتورة — يُمرَّر لنموذج الدفعة المضمَّن. */
  currencyCode?: string;
}

function paymentTypeLabel(pt?: string): string {
  if (pt === "cash") return "نقدي";
  if (pt === "bank") return "بنكي";
  return "آجل";
}

export default function InvoicePaymentsTab({
  invoiceId, docNumber, companyId, token,
  customerId, customerName, invoiceTotal, invoiceExchangeRate = 1,
  paymentType, cashBoxId, bankAccountId, currencyCode,
}: InvoicePaymentsTabProps) {
  const { fmt } = useFormatters();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const authH = { Authorization: `Bearer ${token}` };

  // Receipt vouchers linked to THIS invoice (header or line link).
  const { data: vouchers = [], isLoading: loadingVouchers } = useQuery<any[]>({
    queryKey: ["invoice-receipt-vouchers", invoiceId, companyId],
    queryFn: () => fetchJsonArray(
      `${API}/api/receipt-vouchers?companyId=${companyId}&salesInvoiceId=${invoiceId}`,
      authH,
    ),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  // Manual journal entries that settle this invoice (سداد بقيد محاسبي).
  // Same policy as vouchers: posted count as collected, drafts as pending.
  const { data: settleJes = [], isLoading: loadingJes } = useQuery<any[]>({
    queryKey: ["invoice-settlement-jes", "sales", invoiceId, companyId],
    queryFn: () => fetchJsonArray(
      `${API}/api/journal-entries/for-invoice?companyId=${companyId}&salesInvoiceId=${invoiceId}`,
      authH,
    ),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  // Manual JEs on the CUSTOMER's account not yet linked to any invoice —
  // candidates the user can APPLY as settlement (no new JE is created).
  const { data: candidates = [], isLoading: loadingCandidates } = useQuery<any[]>({
    queryKey: ["je-settlement-candidates", "sales", invoiceId, companyId],
    queryFn: () => fetchJsonArray(
      `${API}/api/journal-entries/settlement-candidates?companyId=${companyId}&salesInvoiceId=${invoiceId}`,
      authH,
    ),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  // Receipt vouchers collected from the CUSTOMER not yet linked to any
  // invoice — candidates the user can APPLY as settlement (link only).
  const { data: voucherCandidates = [], isLoading: loadingVCandidates } = useQuery<any[]>({
    queryKey: ["rv-settlement-candidates", invoiceId, companyId],
    queryFn: () => fetchJsonArray(
      `${API}/api/receipt-vouchers/settlement-candidates?companyId=${companyId}&salesInvoiceId=${invoiceId}`,
      authH,
    ),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  function invalidateSettleQueries() {
    qc.invalidateQueries({ queryKey: ["invoice-settlement-jes", "sales", invoiceId, companyId] });
    qc.invalidateQueries({ queryKey: ["je-settlement-candidates", "sales", invoiceId, companyId] });
    qc.invalidateQueries({ queryKey: ["rv-settlement-candidates", invoiceId, companyId] });
    qc.invalidateQueries({ queryKey: ["invoice-receipt-vouchers", invoiceId, companyId] });
  }

  // «إضافة» — link an existing unlinked voucher as settlement. Unlike JEs the
  // voucher's FULL amount counts, so the server rejects when it exceeds المتبقّي.
  const applyVoucherMut = useMutation({
    mutationFn: async (vId: number) => {
      const res = await fetch(`${API}/api/receipt-vouchers/${vId}/apply-settlement`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, salesInvoiceId: invoiceId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل إضافة السند كسداد");
      return j;
    },
    onSuccess: (r: any) => {
      invalidateSettleQueries();
      toast({
        title: r?.partial ? "تم سداد جزء" : "تم السداد بالكامل",
        description: r?.partial
          ? `أُضيف السند (${fmt(Number(r.applied) || 0)}) كسداد — المتبقّي ${fmt(Number(r.remainingAfter) || 0)}`
          : `أُضيف السند (${fmt(Number(r.applied) || 0)}) وسُدِّدت الفاتورة بالكامل`,
      });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // فكّ ارتباط سند مرتبط من رأس السند (لا يحذف السند ولا قيده).
  const unlinkVoucherMut = useMutation({
    mutationFn: async (vId: number) => {
      const res = await fetch(`${API}/api/receipt-vouchers/${vId}/unlink-settlement`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        // salesInvoiceId lets the server remove PARTIAL links (سداد جزئي)
        // when the voucher isn't header-linked.
        body: JSON.stringify({ companyId, salesInvoiceId: invoiceId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل فكّ الارتباط");
      return j;
    },
    onSuccess: () => { invalidateSettleQueries(); toast({ title: "تم فكّ ارتباط السند بالفاتورة" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // "إضافة" — link an existing JE as settlement (server clamps ≤ المتبقي).
  const applyMut = useMutation({
    mutationFn: async (jeId: number) => {
      const res = await fetch(`${API}/api/journal-entries/${jeId}/apply-settlement`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, salesInvoiceId: invoiceId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل إضافة القيد كسداد");
      return j;
    },
    onSuccess: (r: any) => {
      invalidateSettleQueries();
      toast({
        title: r?.partial ? "تم سداد جزء" : "تم السداد بالكامل",
        description: r?.partial
          ? `أُضيف ${fmt(Number(r.applied) || 0)} من القيد كسداد — المتبقّي ${fmt(Number(r.remainingAfter) || 0)}`
          : `أُضيف ${fmt(Number(r.applied) || 0)} من القيد وسُدِّدت الفاتورة بالكامل`,
      });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // فكّ ارتباط قيد سداد (يزيل احتسابه من المُحصَّل دون حذف القيد).
  const unlinkMut = useMutation({
    mutationFn: async ({ jeId, linkId }: { jeId: number; linkId?: number }) => {
      const res = await fetch(`${API}/api/journal-entries/${jeId}/unlink-settlement`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        // linkId → remove ONE partial settlement link; absent → legacy header unlink.
        body: JSON.stringify({ companyId, ...(linkId ? { linkId } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل فكّ الارتباط");
      return j;
    },
    onSuccess: () => { invalidateSettleQueries(); toast({ title: "تم فكّ ارتباط القيد بالفاتورة" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Sales returns against this invoice reduce the amount due.
  const { data: allReturns = [] } = useQuery<any[]>({
    queryKey: ["sales-returns-for-invoice", companyId],
    queryFn: () => fetchJsonArray(`${API}/api/sales/sales-returns?companyId=${companyId}`, authH),
    enabled: !!invoiceId && !!companyId,
    staleTime: 30_000,
  });

  const summary = useMemo(() => {
    const invRate = Number(invoiceExchangeRate) || 1;
    const total = Number(invoiceTotal) || 0;
    // Convert a foreign amount into THIS invoice's document currency so the
    // summary stays consistent with the invoice total the user sees:
    //   base = native × nativeRate ; doc = base / invoiceRate
    const toDoc = (native: number, nativeRate: any) => {
      const r = Number(nativeRate) || invRate; // no rate ⇒ assume invoice currency
      return invRate > 0 ? (native * r) / invRate : native;
    };
    const postedRows = (vouchers as any[]).filter(v => v.status === "posted");
    const draftRows = (vouchers as any[]).filter(v => v.status !== "posted");
    // Amount a voucher contributes to THIS invoice — partial links/lines carry
    // their own amount (appliedForInvoice); fall back to the full amount.
    const vAmt = (v: any) => v.appliedForInvoice != null ? (Number(v.appliedForInvoice) || 0) : (Number(v.amount) || 0);
    // Settlement JEs count with the same posted/draft split as vouchers.
    const jePosted = (settleJes as any[])
      .filter(j => j.status === "posted")
      .reduce((s, j) => s + toDoc(Number(j.settlementAmount) || 0, j.exchangeRate), 0);
    const jePending = (settleJes as any[])
      .filter(j => j.status !== "posted")
      .reduce((s, j) => s + toDoc(Number(j.settlementAmount) || 0, j.exchangeRate), 0);
    const collected = postedRows.reduce((s, v) => s + toDoc(vAmt(v), v.exchangeRate), 0) + jePosted;
    const pending = draftRows.reduce((s, v) => s + toDoc(vAmt(v), v.exchangeRate), 0) + jePending;
    const returns = (allReturns as any[])
      .filter(r => String(r.invoiceId ?? r.salesInvoiceId) === String(invoiceId))
      .reduce((s, r) => s + toDoc(Number(r.totalAmount) || 0, r.exchangeRate), 0);
    const netDue = Math.max(0, total - returns);
    const remaining = Math.max(0, netDue - collected);
    // Drafts count against the collectible balance too (server enforces the
    // same rule): the CTA may only seed what's left AFTER posted + drafts.
    const available = Math.max(0, netDue - collected - pending);
    const percent = netDue > 0 ? Math.min(100, (collected / netDue) * 100) : 0;
    return { total, collected, pending, returns, netDue, remaining, available, percent, jePaid: jePosted + jePending };
  }, [vouchers, settleJes, allReturns, invoiceTotal, invoiceExchangeRate, invoiceId]);

  // Payment status pill.
  const status = useMemo(() => {
    if (summary.netDue <= 0.005) {
      return { label: "لا يوجد مستحق", tone: "muted" as const, Icon: Info };
    }
    if (summary.remaining <= 0.005) {
      return { label: "مدفوعة بالكامل", tone: "green" as const, Icon: CircleCheck };
    }
    if (summary.collected > 0.005 || summary.pending > 0.005) {
      // Blue "تم سداد جزء" when part of the payment came from linked
      // journal entries (طلب المستخدم: جزء مسدَّد بقيد ⇒ أزرق).
      if (summary.jePaid > 0.005) {
        return { label: "تم سداد جزء", tone: "blue" as const, Icon: CircleAlert };
      }
      if (summary.collected > 0.005) {
        return { label: "مدفوعة جزئياً", tone: "amber" as const, Icon: CircleAlert };
      }
    }
    return { label: "غير مدفوعة", tone: "red" as const, Icon: CircleX };
  }, [summary]);

  // نموذج تسجيل الدفعة المضمَّن — بدلاً من التحويل لشاشة السندات.
  const [showPayForm, setShowPayForm] = useState(false);

  // ── New / unsaved invoice: nothing to settle yet ──────────────────
  if (!invoiceId) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center space-y-2">
        <Wallet className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="text-sm font-medium">إدارة المدفوعات</p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          احفظ الفاتورة أولاً لتتمكن من إنشاء سندات القبض وتتبّع التحصيلات والرصيد المتبقّي من هنا مباشرة.
        </p>
      </div>
    );
  }

  const toneClasses: Record<string, string> = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    blue:  "bg-blue-50 text-blue-700 border-blue-200",
    red:   "bg-red-50 text-red-700 border-red-200",
    muted: "bg-muted text-muted-foreground border-border",
  };

  return (
    <div className="space-y-5">
      {/* Header: status pill + collect button */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${toneClasses[status.tone]}`}>
            <status.Icon className="h-3.5 w-3.5" />
            {status.label}
          </div>
          <span className="text-xs text-muted-foreground">
            طريقة السداد: <span className="font-medium text-foreground">{paymentTypeLabel(paymentType)}</span>
          </span>
        </div>
        {paymentType === "cash" || paymentType === "bank" ? (
          // Cash/bank invoices settle automatically on posting — manual
          // receipt vouchers are for CREDIT invoices only.
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200"
            title="سند القبض يُنشأ تلقائياً عند ترحيل الفاتورة النقدية/البنكية — تسجيل الدفعات اليدوي متاح للفواتير الآجلة فقط"
            data-testid="badge-paid-by-type"
          >
            <CircleCheck className="h-3.5 w-3.5" />
            {paymentType === "bank" ? "مسدَّدة بنكياً" : "مسدَّدة نقداً"}
          </div>
        ) : (
          <Button
            size="sm"
            onClick={() => setShowPayForm(true)}
            disabled={showPayForm || summary.available <= 0.005}
            title={summary.available <= 0.005
              ? (summary.pending > 0.005
                ? "قيمة الفاتورة مغطّاة بالكامل بسندات (مرحّلة + مسودّات) — رحّل أو عدّل المسودات أولاً"
                : "الفاتورة مسدّدة بالكامل — لا يوجد مبلغ متبقٍّ")
              : undefined}
            data-testid="btn-collect-payment"
          >
            <Plus className="h-4 w-4" />
            تسجيل دفعة (سند قبض)
          </Button>
        )}
      </div>

      {/* نموذج تسجيل الدفعة المضمَّن (نفس نمط الإشعارات) */}
      {showPayForm && (
        <EmbeddedPaymentForm
          kind="sales"
          invoiceId={invoiceId}
          companyId={companyId}
          token={token}
          entityId={customerId}
          entityName={customerName}
          docNumber={docNumber}
          available={summary.available}
          exchangeRate={invoiceExchangeRate}
          currencyCode={currencyCode}
          onClose={() => setShowPayForm(false)}
          onSaved={invalidateSettleQueries}
        />
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="إجمالي الفاتورة" value={fmt(summary.total)} />
        {summary.returns > 0.005 && (
          <SummaryCard label="مرتجعات" value={`− ${fmt(summary.returns)}`} tone="amber" />
        )}
        <SummaryCard label="المُحصَّل (مرحّل)" value={fmt(summary.collected)} tone="green" />
        <SummaryCard label="المتبقّي" value={fmt(summary.remaining)} tone={summary.remaining > 0.005 ? "red" : "green"} />
      </div>

      {summary.pending > 0.005 && (
        <p className="text-[11px] text-amber-600 flex items-center gap-1.5">
          <CircleAlert className="h-3.5 w-3.5" />
          يوجد {fmt(summary.pending)} في سندات قبض غير مرحّلة (مسودّات) — لا تُحتسب ضمن المُحصَّل حتى تُرحَّل.
        </p>
      )}

      {/* Progress bar */}
      {summary.netDue > 0.005 && (
        <div className="space-y-1">
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${summary.percent}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground text-left" dir="ltr">
            {summary.percent.toFixed(0)}%
          </p>
        </div>
      )}

      {/* Linked vouchers */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">سندات القبض المرتبطة</p>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">الرقم</TableHead>
                <TableHead className="text-xs">التاريخ</TableHead>
                <TableHead className="text-xs">الطريقة</TableHead>
                <TableHead className="text-xs text-end">المبلغ</TableHead>
                <TableHead className="text-xs">الحالة</TableHead>
                <TableHead className="text-xs w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingVouchers && (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
              )}
              {!loadingVouchers && (vouchers as any[]).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">لا توجد سندات قبض مرتبطة بهذه الفاتورة بعد.</TableCell></TableRow>
              )}
              {(vouchers as any[]).map((v: any) => (
                <TableRow
                  key={v.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onDoubleClick={() => navigate(`/cash/receipt-vouchers/${v.id}`)}
                  data-testid={`voucher-row-${v.id}`}
                >
                  <TableCell className="text-xs font-medium" dir="ltr">{v.code ?? `#${v.id}`}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" dir="ltr">{v.date ? String(v.date).slice(0, 10) : "—"}</TableCell>
                  <TableCell className="text-xs">{paymentTypeLabel(v.paymentType)}</TableCell>
                  <TableCell className="text-xs text-end" dir="ltr">
                    {fmt(v.appliedForInvoice != null ? Number(v.appliedForInvoice) || 0 : Number(v.amount) || 0)}
                    {v.appliedForInvoice != null && Math.abs((Number(v.appliedForInvoice) || 0) - (Number(v.amount) || 0)) > 0.005 && (
                      <span className="text-[10px] text-muted-foreground"> / {fmt(Number(v.amount) || 0)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={v.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                      {v.status === "posted" ? "مرحّل" : "مسودّة"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={(e) => { e.stopPropagation(); navigate(`/cash/receipt-vouchers/${v.id}`); }}
                        title="فتح السند"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                      {(Number(v.salesInvoiceId) === Number(invoiceId) || v.appliedForInvoice != null) && (
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600"
                          disabled={unlinkVoucherMut.isPending}
                          onClick={(e) => { e.stopPropagation(); unlinkVoucherMut.mutate(v.id); }}
                          title="فكّ ارتباط السند بالفاتورة (يزيل احتسابه من المُحصَّل دون حذف السند)"
                          data-testid={`btn-unlink-voucher-${v.id}`}
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Linked settlement journal entries */}
      {(loadingJes || (settleJes as any[]).length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">قيود السداد المرتبطة</p>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">رقم القيد</TableHead>
                  <TableHead className="text-xs">التاريخ</TableHead>
                  <TableHead className="text-xs">البيان</TableHead>
                  <TableHead className="text-xs text-end">مبلغ السداد</TableHead>
                  <TableHead className="text-xs">الحالة</TableHead>
                  <TableHead className="text-xs w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingJes && (
                  <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
                )}
                {(settleJes as any[]).map((j: any) => (
                  <TableRow
                    key={j.linkId ? `link-${j.linkId}` : `je-${j.id}`}
                    className="cursor-pointer hover:bg-muted/40"
                    onDoubleClick={() => navigate(`/accounting/journals/${j.id}`)}
                    data-testid={`settlement-je-row-${j.id}`}
                  >
                    <TableCell className="text-xs font-medium" dir="ltr">{j.docNumber ?? `#${j.id}`}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap" dir="ltr">{j.entryDate ? String(j.entryDate).slice(0, 10) : "—"}</TableCell>
                    <TableCell className="text-xs"><span className="block max-w-[280px] truncate" title={j.description ?? ""}>{j.description ?? "—"}</span></TableCell>
                    <TableCell className="text-xs text-end" dir="ltr">{fmt(Number(j.settlementAmount) || 0)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={j.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                        {j.status === "posted" ? "مرحّل" : "مسودّة"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); navigate(`/accounting/journals/${j.id}`); }}
                          title="فتح القيد"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600"
                          disabled={unlinkMut.isPending}
                          onClick={(e) => { e.stopPropagation(); unlinkMut.mutate({ jeId: j.id, linkId: j.linkId }); }}
                          title="فكّ ارتباط القيد بالفاتورة (يزيل احتسابه من المُحصَّل دون حذف القيد)"
                          data-testid={`btn-unlink-je-${j.id}`}
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Unlinked receipt vouchers on the customer — apply as settlement */}
      {paymentType !== "cash" && paymentType !== "bank" && (loadingVCandidates || (voucherCandidates as any[]).length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            سندات قبض على العميل غير مرتبطة بأي فاتورة — اضغط «إضافة» لاحتسابها كسداد لهذه الفاتورة (بدون إنشاء سند جديد)
          </p>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">رقم السند</TableHead>
                  <TableHead className="text-xs">التاريخ</TableHead>
                  <TableHead className="text-xs">الطريقة</TableHead>
                  <TableHead className="text-xs text-end">المبلغ</TableHead>
                  <TableHead className="text-xs">الحالة</TableHead>
                  <TableHead className="text-xs w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingVCandidates && (
                  <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
                )}
                {(voucherCandidates as any[]).map((v: any) => {
                  // `amount` من الخادم = المتاح المتبقّي من السند (سداد جزئي).
                  const vAvail = Number(v.amount) || 0;
                  const vTotal = Number(v.totalAmount ?? v.amount) || 0;
                  return (
                    <TableRow key={v.id} data-testid={`voucher-candidate-row-${v.id}`}>
                      <TableCell className="text-xs font-medium" dir="ltr">{v.code ?? `#${v.id}`}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap" dir="ltr">{v.date ? String(v.date).slice(0, 10) : "—"}</TableCell>
                      <TableCell className="text-xs">{paymentTypeLabel(v.paymentType)}</TableCell>
                      <TableCell className="text-xs text-end" dir="ltr">
                        {fmt(vAvail)}
                        {Math.abs(vTotal - vAvail) > 0.005 && (
                          <span className="text-[10px] text-muted-foreground"> / {fmt(vTotal)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant={v.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                          {v.status === "posted" ? "مرحّل" : "مسودّة"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm" variant="outline" className="h-7 px-2 text-xs"
                          disabled={applyVoucherMut.isPending || summary.available <= 0.005}
                          onClick={() => applyVoucherMut.mutate(v.id)}
                          title={summary.available <= 0.005
                            ? "الفاتورة مسدَّدة بالكامل (بما فيها المسودّات)"
                            : "إضافة هذا السند كسداد — يُحتسب حتى المتبقّي فقط والباقي من السند يبقى متاحاً"}
                          data-testid={`btn-apply-voucher-${v.id}`}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          إضافة
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Unlinked manual JEs on the customer's account — apply as settlement */}
      {paymentType !== "cash" && paymentType !== "bank" && (loadingCandidates || (candidates as any[]).length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            قيود محاسبية على العميل غير مرتبطة بأي فاتورة — اضغط «إضافة» لاحتسابها كسداد لهذه الفاتورة (بدون إنشاء قيد جديد)
          </p>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">رقم القيد</TableHead>
                  <TableHead className="text-xs">التاريخ</TableHead>
                  <TableHead className="text-xs">البيان</TableHead>
                  <TableHead className="text-xs text-end">المبلغ على العميل</TableHead>
                  <TableHead className="text-xs">الحالة</TableHead>
                  <TableHead className="text-xs w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingCandidates && (
                  <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
                )}
                {(candidates as any[]).map((j: any) => (
                  <TableRow key={j.id} data-testid={`je-candidate-row-${j.id}`}>
                    <TableCell className="text-xs font-medium" dir="ltr">{j.docNumber ?? `#${j.id}`}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap" dir="ltr">{j.entryDate ? String(j.entryDate).slice(0, 10) : "—"}</TableCell>
                    <TableCell className="text-xs"><span className="block max-w-[280px] truncate" title={j.description ?? ""}>{j.description ?? "—"}</span></TableCell>
                    <TableCell className="text-xs text-end" dir="ltr">{fmt(Number(j.amount) || 0)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={j.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                        {j.status === "posted" ? "مرحّل" : "مسودّة"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm" variant="outline" className="h-7 px-2 text-xs"
                        disabled={applyMut.isPending || summary.remaining <= 0.005}
                        onClick={() => applyMut.mutate(j.id)}
                        title={summary.remaining <= 0.005
                          ? "الفاتورة مسدَّدة بالكامل"
                          : "إضافة هذا القيد كسداد — يُحتسب حتى المتبقّي فقط ولا يُنشئ قيداً جديداً"}
                        data-testid={`btn-apply-je-${j.id}`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        إضافة
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" | "amber" }) {
  const toneText: Record<string, string> = {
    green: "text-emerald-600",
    red: "text-red-600",
    amber: "text-amber-600",
  };
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone ? toneText[tone] : ""}`} dir="ltr">{value}</p>
    </div>
  );
}
