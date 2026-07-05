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
}

function paymentTypeLabel(pt?: string): string {
  if (pt === "cash") return "نقدي";
  if (pt === "bank") return "بنكي";
  return "آجل";
}

export default function InvoicePaymentsTab({
  invoiceId, docNumber, companyId, token,
  customerId, customerName, invoiceTotal, invoiceExchangeRate = 1,
  paymentType, cashBoxId, bankAccountId,
}: InvoicePaymentsTabProps) {
  const { fmt } = useFormatters();
  const [, navigate] = useLocation();
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
    const collected = postedRows.reduce((s, v) => s + toDoc(Number(v.amount) || 0, v.exchangeRate), 0);
    const pending = draftRows.reduce((s, v) => s + toDoc(Number(v.amount) || 0, v.exchangeRate), 0);
    const returns = (allReturns as any[])
      .filter(r => String(r.invoiceId ?? r.salesInvoiceId) === String(invoiceId))
      .reduce((s, r) => s + toDoc(Number(r.totalAmount) || 0, r.exchangeRate), 0);
    const netDue = Math.max(0, total - returns);
    const remaining = Math.max(0, netDue - collected);
    const percent = netDue > 0 ? Math.min(100, (collected / netDue) * 100) : 0;
    return { total, collected, pending, returns, netDue, remaining, percent };
  }, [vouchers, allReturns, invoiceTotal, invoiceExchangeRate, invoiceId]);

  // Payment status pill.
  const status = useMemo(() => {
    if (summary.netDue <= 0.005) {
      return { label: "لا يوجد مستحق", tone: "muted" as const, Icon: Info };
    }
    if (summary.remaining <= 0.005) {
      return { label: "مدفوعة بالكامل", tone: "green" as const, Icon: CircleCheck };
    }
    if (summary.collected > 0.005) {
      return { label: "مدفوعة جزئياً", tone: "amber" as const, Icon: CircleAlert };
    }
    return { label: "غير مدفوعة", tone: "red" as const, Icon: CircleX };
  }, [summary]);

  function openNewVoucher() {
    if (!invoiceId) return;
    const params = new URLSearchParams();
    params.set("salesInvoiceId", String(invoiceId));
    if (customerId) params.set("entityId", customerId);
    if (customerName) params.set("entityName", customerName);
    // Cap the prefilled amount at the outstanding balance (no overpay seed).
    if (summary.remaining > 0) params.set("amount", summary.remaining.toFixed(2));
    const pt = paymentType === "bank" ? "bank" : "cash";
    params.set("paymentType", pt);
    if (pt === "cash" && cashBoxId) params.set("cashBoxId", cashBoxId);
    if (pt === "bank" && bankAccountId) params.set("bankAccountId", bankAccountId);
    navigate(`/cash/receipt-vouchers/new?${params.toString()}`);
  }

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
        <Button
          size="sm"
          onClick={openNewVoucher}
          disabled={summary.remaining <= 0.005}
          title={summary.remaining <= 0.005 ? "الفاتورة مسدّدة بالكامل — لا يوجد مبلغ متبقٍّ" : undefined}
          data-testid="btn-collect-payment"
        >
          <Plus className="h-4 w-4" />
          تسجيل دفعة (سند قبض)
        </Button>
      </div>

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
                      onClick={(e) => { e.stopPropagation(); navigate(`/cash/receipt-vouchers/${v.id}`); }}
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
