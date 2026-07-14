import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useFormatters } from "@/lib/format";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Wallet, Plus, ExternalLink, CircleCheck, CircleAlert, CircleX, Info,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PurchaseInvoicePaymentsTabProps {
  /** Saved invoice id — null while the invoice is still a new/unsaved draft. */
  invoiceId: number | null;
  /** Human invoice number, only for labels. */
  docNumber?: string;
  companyId?: number;
  token?: string | null;
  supplierId?: string;
  supplierName?: string;
  /** Invoice grand total (incl. loaded LC expenses) in document currency. */
  invoiceTotal: number;
  /** Invoice exchange rate (document currency → base). Defaults to 1 (base). */
  invoiceExchangeRate?: number;
  /** Header payment context — used to prefill the payment voucher. */
  paymentType?: string;
  cashBoxId?: string;
  bankAccountId?: string;
}

function paymentTypeLabel(pt?: string): string {
  if (pt === "cash") return "نقدي";
  if (pt === "bank") return "بنكي";
  return "آجل";
}

export default function PurchaseInvoicePaymentsTab({
  invoiceId, docNumber, companyId, token,
  supplierId, supplierName, invoiceTotal, invoiceExchangeRate = 1,
  paymentType, cashBoxId, bankAccountId,
}: PurchaseInvoicePaymentsTabProps) {
  const { fmt } = useFormatters();
  const [, navigate] = useLocation();
  const authH = { Authorization: `Bearer ${token}` };

  // Payment vouchers linked to THIS invoice (header or line link).
  const { data: vouchers = [], isLoading: loadingVouchers } = useQuery<any[]>({
    queryKey: ["invoice-payment-vouchers", invoiceId, companyId],
    queryFn: () => fetchJsonArray(
      `${API}/api/payment-vouchers?companyId=${companyId}&purchaseInvoiceId=${invoiceId}`,
      authH,
    ),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  // Purchase returns against this invoice reduce the amount due.
  const { data: allReturns = [] } = useQuery<any[]>({
    queryKey: ["purchase-returns-for-invoice", companyId],
    queryFn: () => fetchJsonArray(`${API}/api/purchasing/purchase-returns?companyId=${companyId}`, authH),
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
    const paid = postedRows.reduce((s, v) => s + toDoc(Number(v.amount) || 0, v.exchangeRate), 0);
    const pending = draftRows.reduce((s, v) => s + toDoc(Number(v.amount) || 0, v.exchangeRate), 0);
    const returns = (allReturns as any[])
      .filter(r => String(r.invoiceId ?? r.purchaseInvoiceId) === String(invoiceId))
      .reduce((s, r) => s + toDoc(Number(r.totalAmount) || 0, r.exchangeRate), 0);
    const netDue = Math.max(0, total - returns);
    const remaining = Math.max(0, netDue - paid);
    // Drafts count against the payable balance too (server enforces the same
    // rule): the CTA may only seed what is left AFTER posted + draft vouchers.
    const available = Math.max(0, netDue - paid - pending);
    const percent = netDue > 0 ? Math.min(100, (paid / netDue) * 100) : 0;
    const lastPaidDate = postedRows
      .map((v) => String(v.date ?? ""))
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    return { total, paid, pending, returns, netDue, remaining, available, percent, count: postedRows.length, lastPaidDate };
  }, [vouchers, allReturns, invoiceTotal, invoiceExchangeRate, invoiceId]);

  // Payment status pill.
  const status = useMemo(() => {
    if (summary.netDue <= 0.005) {
      return { label: "لا يوجد مستحق", tone: "muted" as const, Icon: Info };
    }
    if (summary.remaining <= 0.005) {
      return { label: "مسدَّدة بالكامل", tone: "green" as const, Icon: CircleCheck };
    }
    if (summary.paid > 0.005) {
      return { label: "مسدَّدة جزئياً", tone: "amber" as const, Icon: CircleAlert };
    }
    return { label: "غير مسدَّدة", tone: "red" as const, Icon: CircleX };
  }, [summary]);

  function openNewVoucher() {
    if (!invoiceId) return;
    const params = new URLSearchParams();
    params.set("purchaseInvoiceId", String(invoiceId));
    if (supplierId) params.set("entityId", supplierId);
    if (supplierName) params.set("entityName", supplierName);
    // Cap the prefilled amount at the balance left AFTER posted + draft
    // vouchers (server rejects anything above it).
    if (summary.available > 0) params.set("amount", summary.available.toFixed(2));
    const pt = paymentType === "bank" ? "bank" : "cash";
    params.set("paymentType", pt);
    if (pt === "cash" && cashBoxId) params.set("cashBoxId", cashBoxId);
    if (pt === "bank" && bankAccountId) params.set("bankAccountId", bankAccountId);
    navigate(`/cash/payment-vouchers/new?${params.toString()}`);
  }

  // ── New / unsaved invoice: nothing to settle yet ──────────────────
  if (!invoiceId) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center space-y-2">
        <Wallet className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="text-sm font-medium">إدارة السداد</p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          احفظ الفاتورة أولاً لتتمكن من إنشاء سندات الصرف وتتبّع المدفوعات والرصيد المتبقّي من هنا مباشرة.
        </p>
      </div>
    );
  }

  const toneClasses: Record<string, string> = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red:   "bg-red-50 text-red-700 border-red-200",
    muted: "bg-muted text-muted-foreground border-border",
  };

  return (
    <div className="space-y-5">
      {/* Header: status pill + pay button */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${toneClasses[status.tone]}`}>
            <status.Icon className="h-3.5 w-3.5" />
            {status.label}
          </div>
          <span className="text-xs text-muted-foreground">
            طريقة السداد: <span className="font-medium text-foreground">{paymentTypeLabel(paymentType)}</span>
          </span>
          {summary.count > 0 && (
            <span className="text-xs text-muted-foreground">
              عدد الدفعات: <span className="font-medium text-foreground">{summary.count}</span>
              {summary.lastPaidDate && (
                <> · آخر سداد: <span className="font-medium text-foreground" dir="ltr">{summary.lastPaidDate}</span></>
              )}
            </span>
          )}
        </div>
        {paymentType === "cash" || paymentType === "bank" ? (
          // Cash/bank invoices settle automatically on posting — manual
          // payment vouchers are for CREDIT invoices only.
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200"
            title="سند السداد يُنشأ تلقائياً عند ترحيل الفاتورة النقدية/البنكية — تسجيل الدفعات اليدوي متاح للفواتير الآجلة فقط"
            data-testid="badge-paid-by-type"
          >
            <CircleCheck className="h-3.5 w-3.5" />
            {paymentType === "bank" ? "مسدَّدة بنكياً" : "مسدَّدة نقداً"}
          </div>
        ) : (
          <Button
            size="sm"
            onClick={openNewVoucher}
            disabled={summary.available <= 0.005}
            title={summary.available <= 0.005
              ? (summary.pending > 0.005
                ? "قيمة الفاتورة مغطّاة بالكامل بسندات (مرحّلة + مسودّات) — رحّل أو عدّل المسودات أولاً"
                : "الفاتورة مسدَّدة بالكامل — لا يوجد مبلغ متبقٍّ")
              : undefined}
            data-testid="btn-pay-supplier"
          >
            <Plus className="h-4 w-4" />
            تسجيل دفعة (سند صرف)
          </Button>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="إجمالي الفاتورة" value={fmt(summary.total)} />
        {summary.returns > 0.005 && (
          <SummaryCard label="مرتجعات" value={`− ${fmt(summary.returns)}`} tone="amber" />
        )}
        <SummaryCard label="المسدَّد (مرحّل)" value={fmt(summary.paid)} tone="green" />
        <SummaryCard label="المتبقّي" value={fmt(summary.remaining)} tone={summary.remaining > 0.005 ? "red" : "green"} />
      </div>

      {summary.pending > 0.005 && (
        <p className="text-[11px] text-amber-600 flex items-center gap-1.5">
          <CircleAlert className="h-3.5 w-3.5" />
          يوجد {fmt(summary.pending)} في سندات صرف غير مرحّلة (مسودّات) — لا تُحتسب ضمن المسدَّد حتى تُرحَّل.
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
        <p className="text-xs font-medium text-muted-foreground">سندات الصرف المرتبطة</p>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">الرقم</TableHead>
                <TableHead className="text-xs">التاريخ</TableHead>
                <TableHead className="text-xs">الطريقة</TableHead>
                <TableHead className="text-xs text-left">المبلغ</TableHead>
                <TableHead className="text-xs">الحالة</TableHead>
                <TableHead className="text-xs w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingVouchers && (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
              )}
              {!loadingVouchers && (vouchers as any[]).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">لا توجد سندات صرف مرتبطة بهذه الفاتورة بعد.</TableCell></TableRow>
              )}
              {(vouchers as any[]).map((v: any) => (
                <TableRow
                  key={v.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onDoubleClick={() => navigate(`/cash/payment-vouchers/${v.id}`)}
                  data-testid={`payment-voucher-row-${v.id}`}
                >
                  <TableCell className="text-xs font-medium" dir="ltr">{v.code ?? `#${v.id}`}</TableCell>
                  <TableCell className="text-xs">{v.date ?? "—"}</TableCell>
                  <TableCell className="text-xs">{paymentTypeLabel(v.paymentType)}</TableCell>
                  <TableCell className="text-xs text-left" dir="ltr">{fmt(Number(v.amount) || 0)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={v.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                      {v.status === "posted" ? "مرحّل" : "مسودّة"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7"
                      onClick={(e) => { e.stopPropagation(); navigate(`/cash/payment-vouchers/${v.id}`); }}
                      title="فتح السند"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
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
