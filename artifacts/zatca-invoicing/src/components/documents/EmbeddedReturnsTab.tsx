import { useMemo, useState } from "react";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Undo2, ExternalLink, Plus, FilePen, RotateCcw, FilePlus2, Info,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type ReturnMode = "partial" | "full" | "full_new_draft";

interface EmbeddedReturnsTabProps {
  /** "purchase" → مرتجع مشتريات، "sales" → مرتجع مبيعات */
  kind: "purchase" | "sales";
  /** Saved invoice id — null while the invoice is still a new/unsaved draft. */
  invoiceId: number | null;
  docNumber?: string;
  companyId?: number;
  token?: string | null;
  /** Invoice grand total in document currency (labels only). */
  invoiceTotal: number;
  /** Read-only mode (مرحّلة / view). Creating returns stays allowed — a posted
   *  invoice is exactly the one you return from — so this only hides nothing
   *  today, but is kept for future gating. */
  disabled?: boolean;
}

const CFG = {
  purchase: {
    listUrl: (cid: number) => `${API}/api/purchasing/purchase-returns?companyId=${cid}`,
    returnsPath: "/purchasing/returns",
    newInvoicePath: "/purchasing/invoices/new",
    partyLabel: "المورد",
    createLabel: "إنشاء مرتجع مشتريات",
    listTitle: "مرتجعات المشتريات المرتبطة بهذه الفاتورة",
    emptyText: "لا توجد مرتجعات مرتبطة بهذه الفاتورة بعد.",
    docPrefix: "PR",
  },
  sales: {
    listUrl: (cid: number) => `${API}/api/sales/sales-returns?companyId=${cid}`,
    returnsPath: "/sales/returns",
    newInvoicePath: "/sales/invoices/new",
    partyLabel: "العميل",
    createLabel: "إنشاء إشعار خصم (مرتجع مبيعات)",
    listTitle: "مرتجعات المبيعات المرتبطة بهذه الفاتورة",
    emptyText: "لا توجد مرتجعات مرتبطة بهذه الفاتورة بعد.",
    docPrefix: "SR",
  },
} as const;

const OPTIONS: Array<{
  value: ReturnMode;
  title: string;
  desc: string;
  icon: typeof FilePen;
}> = [
  {
    value: "partial",
    title: "إرجاع جزئي",
    desc: "اختر الأصناف والكميات المراد إرجاعها يدويًا — يُنشئ مسودة مرتجع قابلة للتعديل قبل الحفظ.",
    icon: FilePen,
  },
  {
    value: "full",
    title: "إرجاع كامل",
    desc: "يملأ المرتجع بكل الأصناف والكميات المتبقية القابلة للإرجاع تلقائيًا — راجِع واحفظ مباشرة.",
    icon: RotateCcw,
  },
  {
    value: "full_new_draft",
    title: "إرجاع كامل + مسودة فاتورة جديدة",
    desc: "إرجاع كامل للفاتورة، وبعد حفظ المرتجع يفتح لك نسخة جديدة من الفاتورة لتصحيح الأخطاء وإعادة الإصدار.",
    icon: FilePlus2,
  },
];

export default function EmbeddedReturnsTab({
  kind, invoiceId, docNumber, companyId, token, invoiceTotal,
}: EmbeddedReturnsTabProps) {
  const cfg = CFG[kind];
  const { fmt } = useFormatters();
  const [, navigate] = useLocation();
  const authH = { Authorization: `Bearer ${token}` };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<ReturnMode>("partial");

  const { data: allReturns = [], isLoading } = useQuery<any[]>({
    queryKey: ["embedded-returns", kind, companyId, invoiceId],
    queryFn: () => fetchJsonArray(cfg.listUrl(companyId!), authH),
    enabled: !!invoiceId && !!companyId,
    staleTime: 15_000,
  });

  const linked = useMemo(
    () => (allReturns as any[]).filter((r: any) => String(r.invoiceId ?? "") === String(invoiceId ?? "")),
    [allReturns, invoiceId],
  );

  const returnedTotal = useMemo(
    () => linked.reduce((s: number, r: any) => s + (Number(r.totalAmount) || 0), 0),
    [linked],
  );
  const remaining = Math.max(0, invoiceTotal - returnedTotal);

  if (!invoiceId) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Info className="h-4 w-4" />
        احفظ الفاتورة أولًا لتتمكن من إنشاء مرتجع مرتبط بها.
      </div>
    );
  }

  function go() {
    const base = `${cfg.returnsPath}?fromInvoice=${invoiceId}`;
    if (mode === "partial") navigate(base);
    else if (mode === "full") navigate(`${base}&full=1`);
    else navigate(`${base}&full=1&newDraft=1`);
  }

  return (
    <div className="space-y-4" data-testid={`embedded-returns-tab-${kind}`}>
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="إجمالي الفاتورة" value={fmt(invoiceTotal)} />
        <SummaryCard label="إجمالي المرتجع منها" value={fmt(returnedTotal)} tone={returnedTotal > 0 ? "amber" : undefined} />
        <SummaryCard label="المتبقي القابل للإرجاع (تقديري)" value={fmt(remaining)} tone={remaining <= 0.005 ? "red" : "green"} />
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Undo2 className="h-3.5 w-3.5" />
          {cfg.listTitle}
        </p>
        <Button
          size="sm"
          className="h-8 text-xs gap-1.5"
          onClick={() => { setMode("partial"); setDialogOpen(true); }}
          data-testid={`btn-open-return-dialog-${kind}`}
        >
          <Plus className="h-3.5 w-3.5" />
          {cfg.createLabel}
        </Button>
      </div>

      {/* Linked returns */}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">رقم المرتجع</TableHead>
              <TableHead className="text-xs">التاريخ</TableHead>
              <TableHead className="text-xs text-end">الإجمالي</TableHead>
              <TableHead className="text-xs">الحالة</TableHead>
              <TableHead className="text-xs w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">جارِ التحميل…</TableCell></TableRow>
            )}
            {!isLoading && linked.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">{cfg.emptyText}</TableCell></TableRow>
            )}
            {linked.map((r: any) => (
              <TableRow
                key={r.id}
                className="cursor-pointer hover:bg-muted/40"
                onDoubleClick={() => navigate(cfg.returnsPath)}
                data-testid={`linked-return-row-${r.id}`}
              >
                <TableCell className="text-xs font-medium" dir="ltr">{r.docNumber ?? `${cfg.docPrefix}-${r.id}`}</TableCell>
                <TableCell className="text-xs whitespace-nowrap" dir="ltr">{r.returnDate ? String(r.returnDate).slice(0, 10) : "—"}</TableCell>
                <TableCell className="text-xs text-end" dir="ltr">{fmt(Number(r.totalAmount) || 0)}</TableCell>
                <TableCell className="text-xs">
                  <Badge variant={r.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                    {r.status === "posted" ? "مرحّل" : "مسودّة"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    onClick={(e) => { e.stopPropagation(); navigate(cfg.returnsPath); }}
                    title="فتح شاشة المرتجعات"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Odoo-style reverse dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Undo2 className="h-4 w-4" />
              إشعار خصم / إرجاع الفاتورة {docNumber ? <span className="font-mono text-sm" dir="ltr">{docNumber}</span> : null}
            </DialogTitle>
            <DialogDescription className="text-xs">
              اختر طريقة الإرجاع — سيُربط المرتجع تلقائيًا بهذه الفاتورة لتسوية {cfg.partyLabel} والمخزون.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {OPTIONS.map((o) => {
              const Icon = o.icon;
              const active = mode === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setMode(o.value)}
                  className={`w-full text-start rounded-lg border p-3 transition-colors flex gap-3 items-start ${
                    active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/40"
                  }`}
                  data-testid={`return-mode-${o.value}`}
                >
                  <span className={`mt-0.5 rounded-md p-1.5 ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{o.title}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">{o.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>إلغاء</Button>
            <Button onClick={go} data-testid="btn-confirm-reverse">
              <Undo2 className="h-4 w-4 ms-0 me-1.5" />
              عكس (إنشاء المرتجع)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
