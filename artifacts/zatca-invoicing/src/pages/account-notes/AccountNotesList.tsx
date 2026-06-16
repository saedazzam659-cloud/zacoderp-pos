import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Plus, Send, RotateCcw, Trash2, FileText, Edit, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { accountNotesApi, type AccountNote, type AccountNotePartyType, type AccountNoteType } from "@/lib/accountNotesApi";
import { printAccountNote } from "@/lib/accountNotePrint";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

interface Props {
  partyType: AccountNotePartyType;
  noteType:  AccountNoteType;
}

const TITLES: Record<string, string> = {
  "customer.credit": "إشعارات دائنة - عملاء",
  "customer.debit":  "إشعارات مدينة - عملاء",
  "supplier.credit": "إشعارات دائنة - موردين",
  "supplier.debit":  "إشعارات مدينة - موردين",
};

const SUBTITLES: Record<string, string> = {
  "customer.credit": "تخفض رصيد العميل لدينا (CR ذمم العميل)",
  "customer.debit":  "تزيد رصيد العميل لدينا (DR ذمم العميل)",
  "supplier.credit": "تخفض رصيد المورد لدينا (DR ذمم المورد)",
  "supplier.debit":  "تزيد رصيد المورد لدينا (CR ذمم المورد)",
};

const ROUTE_BASE: Record<string, string> = {
  "customer.credit": "/sales/customer-credit-notes",
  "customer.debit":  "/sales/customer-debit-notes",
  "supplier.credit": "/purchasing/supplier-credit-notes",
  "supplier.debit":  "/purchasing/supplier-debit-notes",
};

export default function AccountNotesList({ partyType, noteType }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const key = `${partyType}.${noteType}`;
  const base = ROUTE_BASE[key];
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const partyLabel = partyType === "customer" ? "العميل" : "المورد";

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["account-notes", partyType, noteType],
    queryFn:  () => accountNotesApi.list({ partyType, noteType }),
  });

  const partiesPath = partyType === "customer" ? "/api/customers" : "/api/suppliers";
  const { data: parties = [] } = useQuery<any[]>({
    queryKey: [partiesPath],
    queryFn: async () => {
      const t = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const h: Record<string, string> = {};
      if (t) h["Authorization"] = `Bearer ${t}`;
      if (acting) h["x-acting-company-id"] = acting;
      const r = await fetch(import.meta.env.BASE_URL.replace(/\/$/, "") + partiesPath, { headers: h });
      if (!r.ok) return [];
      return r.json();
    },
  });
  // Full party object map (id → party) so print has vat/tax number + city, not just the name.
  const partyObjMap = useMemo(() => Object.fromEntries(parties.map((p: any) => [p.id, p])), [parties]);
  const partyName = (id: number) => (partyObjMap[id]?.nameAr as string) ?? `#${id}`;

  const postMut = useMutation({
    mutationFn: (id: number) => accountNotesApi.post(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] });
      toast({ title: r.journalEntryStatus === "posted" ? "تم الترحيل" : "تم الحفظ كقيد مسودة (الترحيل التلقائي معطّل)" });
    },
    onError: (e: any) => toast({ title: "تعذّر الترحيل", description: String(e?.message || e), variant: "destructive" }),
  });
  const unpostMut = useMutation({
    mutationFn: (id: number) => accountNotesApi.unpost(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] }); toast({ title: "تم إلغاء الترحيل" }); },
    onError: (e: any) => toast({ title: "تعذّر إلغاء الترحيل", description: String(e?.message || e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => accountNotesApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] }); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: "تعذّر الحذف", description: String(e?.message || e), variant: "destructive" }),
  });

  const total = (rows as AccountNote[]).reduce((s, r) => s + Number(r.totalAmount || 0), 0);
  const num = (n: any) => Number(n || 0).toFixed(2);

  const doPrint = (r: AccountNote) =>
    printAccountNote({
      note: r,
      party: partyObjMap[r.partyId] ?? null,
      company: user?.company ?? {},
      partyLabel,
      onError: (msg) => toast({ title: msg, variant: "destructive" }),
    });

  const statusBadge = (status: string) => (
    <span className={`px-2 py-0.5 rounded text-xs ${status === "posted" ? "bg-green-50 text-green-700" : status === "cancelled" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
      {status === "posted" ? "مُرحَّل" : status === "cancelled" ? "ملغي" : "مسودة"}
    </span>
  );

  const gridColumns: GridColumn<AccountNote>[] = [
    { key: "noteNumber", label: "رقم", type: "text", value: r => r.noteNumber,
      className: "font-mono", render: r => <span className="font-mono">{r.noteNumber}</span> },
    { key: "noteDate", label: "التاريخ", type: "text", value: r => r.noteDate,
      className: "tabular-nums text-xs text-muted-foreground" },
    { key: "party", label: partyLabel, type: "text", value: r => partyName(r.partyId) },
    { key: "amount", label: "المبلغ", type: "num", align: "end", totalable: false,
      value: r => Number(r.amount || 0), render: r => <span className="tabular-nums">{num(r.amount)}</span> },
    { key: "vat", label: "VAT", type: "num", align: "end",
      value: r => (r.vatEnabled ? Number(r.vatAmount || 0) : 0),
      render: r => <span className="tabular-nums">{r.vatEnabled ? num(r.vatAmount) : "—"}</span> },
    { key: "totalAmount", label: "الإجمالي", type: "num", align: "end", totalable: true,
      value: r => Number(r.totalAmount || 0),
      render: r => <span className="tabular-nums font-semibold">{num(r.totalAmount)}</span> },
    { key: "status", label: "الحالة", type: "text", value: r => r.status, render: r => statusBadge(r.status) },
    { key: "journalEntryId", label: "رقم القيد", type: "text", value: r => r.journalEntryId ?? "",
      render: r => r.journalEntryId ? (
        <Link href={`/accounting/journals/${r.journalEntryId}`}>
          <a className="text-blue-600 hover:underline font-mono"
            onClick={(e) => e.stopPropagation()}
            data-testid={`link-je-${r.id}`}>#{r.journalEntryId}</a>
        </Link>
      ) : <span className="text-muted-foreground">—</span> },
    { key: "actions", label: "إجراءات", type: "none", align: "end", value: () => "",
      render: r => (
        <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {/* Print first → rightmost in RTL, i.e. to the RIGHT of Edit. Available for any status. */}
          <Button size="sm" variant="outline" onClick={() => doPrint(r)}
            title="طباعة" data-testid={`btn-print-${r.id}`}>
            <Printer className="h-3 w-3" />
          </Button>
          {r.status === "draft" && (
            <>
              <Link href={`${base}/${r.id}`}>
                <Button size="sm" variant="outline" title="تعديل" data-testid={`btn-edit-${r.id}`}><Edit className="h-3 w-3" /></Button>
              </Link>
              <Button size="sm" variant="outline" disabled={postMut.isPending}
                onClick={() => postMut.mutate(r.id)}
                data-testid={`btn-post-${r.id}`}>
                <Send className="h-3 w-3 ml-1" /> ترحيل
              </Button>
              <Button size="sm" variant="ghost" className="text-red-600"
                onClick={() => { if (confirm("هل تريد حذف هذا الإشعار؟")) delMut.mutate(r.id); }}
                data-testid={`btn-delete-${r.id}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
          {r.status === "posted" && (
            <Button size="sm" variant="ghost" disabled={unpostMut.isPending}
              onClick={() => { if (confirm("إلغاء الترحيل سيحذف القيد المحاسبي المرتبط. متابعة؟")) unpostMut.mutate(r.id); }}
              data-testid={`btn-unpost-${r.id}`}>
              <RotateCcw className="h-3 w-3 ml-1" /> إلغاء الترحيل
            </Button>
          )}
        </div>
      ) },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> {TITLES[key]}</h1>
          <p className="text-sm text-muted-foreground mt-1">{SUBTITLES[key]}</p>
        </div>
        <Link href={`${base}/new`}>
          <Button data-testid="btn-new-note"><Plus className="h-4 w-4 ml-1" /> إشعار جديد</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-4"><Skeleton className="h-32 w-full" /></div>
      ) : (
        <AdvancedReportGrid
          slug="accountNotesGrid"
          cid={cid}
          columns={gridColumns}
          rowKey={(r) => r.id}
          rows={rows as AccountNote[]}
          onRowDoubleClick={(r) => setLocation(`${base}/${r.id}`)}
          unitLabel="إشعار"
          emptyMessage="لا توجد إشعارات"
          totalsRow={(rows as AccountNote[]).length > 0 ? {
            __label: "الإجمالي",
            totalAmount: <span className="tabular-nums">{total.toFixed(2)}</span>,
          } : null}
        />
      )}
    </div>
  );
}
