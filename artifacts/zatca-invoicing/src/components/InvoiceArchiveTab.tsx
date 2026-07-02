// "أرشفة" tab body shared by the sales + purchase invoice forms. PURE archive:
//   1) inline file attachments (reuses <JournalScanArchive>, which respects the
//      company archive mode + per-file WhatsApp/Email/download share), and
//   2) linked goods receipt (استلام) / delivery (تسليم) documents — list +
//      create/open via <DeliveryReceiptDocDialog>.
// No accounting, inventory or GL impact whatsoever.

import { useCallback, useEffect, useState } from "react";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import DeliveryReceiptDocDialog, { type DRKind, type DRSeed } from "@/components/DeliveryReceiptDocDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { Plus, FileText, Loader2, CheckCircle2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Props {
  invoiceId: number;
  invoiceType: "sales" | "purchase";
  invoiceNumber?: string | null;
  seed?: DRSeed | null;
}

const STATUS_LABEL: Record<string, string> = {
  full: "كامل", partial: "جزئي", damaged: "به تلفيات", approved: "معتمد",
};

export default function InvoiceArchiveTab({ invoiceId, invoiceType, invoiceNumber, seed }: Props) {
  const { user, token } = useAuth();
  const company = (user as any)?.company ?? null;
  // sales invoice → delivery note (تسليم); purchase invoice → receipt (استلام).
  const kind: DRKind = invoiceType === "sales" ? "delivery" : "receipt";
  const jeKey = `${invoiceType === "sales" ? "sinv" : "pinv"}:${invoiceId}`;
  const screenKey = invoiceType === "sales" ? "delivery_documents" : "receipt_documents";

  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(
        `${API}/api/delivery-receipt-documents?invoiceId=${invoiceId}&invoiceType=${invoiceType}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (r.ok) {
        const d = await r.json();
        setDocs(Array.isArray(d) ? d : (Array.isArray(d?.items) ? d.items : []));
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [invoiceId, invoiceType, token]);

  useEffect(() => { load(); }, [load]);

  const label = kind === "receipt" ? "سند استلام" : "سند تسليم";

  return (
    <div className="space-y-6">
      {/* Attachments */}
      <section className="rounded-lg border p-4">
        <div className="mb-3 text-sm font-semibold text-primary">المرفقات</div>
        <JournalScanArchive jeKey={jeKey} screenKey={screenKey} companyName={company?.nameAr || company?.nameEn} />
        <p className="mt-2 text-xs text-muted-foreground">
          أرفق الصور والمستندات الممسوحة ضوئياً. تعتمد المشاركة السحابية (واتساب/بريد/تنزيل) على تفعيل وضع الأرشفة السحابية للشركة.
        </p>
      </section>

      {/* Linked receipt/delivery documents */}
      <section className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-primary">{kind === "receipt" ? "سندات الاستلام" : "سندات التسليم"}</div>
          <Button type="button" size="sm" className="gap-1" onClick={() => { setEditId(null); setDlgOpen(true); }}>
            <Plus className="h-4 w-4" />{label} جديد
          </Button>
        </div>

        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : docs.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">لا توجد سندات مرتبطة بعد.</div>
        ) : (
          <div className="divide-y rounded-md border">
            {docs.map((d) => (
              <button key={d.id} type="button"
                onClick={() => { setEditId(d.id); setDlgOpen(true); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-right hover:bg-muted/40 transition">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium" dir="ltr">{d.docNumber}</span>
                <span className="text-xs text-muted-foreground flex-1 truncate">{d.recipientName || d.partyName || "—"}</span>
                {(d.status === "approved" || d.approvedAt) && <Badge className="bg-emerald-600 text-white gap-1 text-[10px]"><CheckCircle2 className="h-3 w-3" />معتمد</Badge>}
                <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[d.status] ?? d.status}</Badge>
                <span className="text-xs text-muted-foreground" dir="ltr">{d.docDate ? new Date(d.docDate).toLocaleDateString("en-GB") : ""}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {dlgOpen && (
        <DeliveryReceiptDocDialog
          open={dlgOpen}
          onOpenChange={setDlgOpen}
          kind={kind}
          editId={editId}
          seed={editId ? null : { ...(seed ?? {}), invoiceId, invoiceType, invoiceNumber }}
          onSaved={load}
        />
      )}
    </div>
  );
}
