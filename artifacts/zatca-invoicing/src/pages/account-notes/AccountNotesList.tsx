import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Send, RotateCcw, Trash2, FileText, Edit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { accountNotesApi, type AccountNotePartyType, type AccountNoteType } from "@/lib/accountNotesApi";

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
  const key = `${partyType}.${noteType}`;
  const base = ROUTE_BASE[key];

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
  const partyMap = useMemo(() => Object.fromEntries(parties.map((p: any) => [p.id, p.nameAr])), [parties]);

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

  const total = (rows as any[]).reduce((s, r) => s + Number(r.totalAmount || 0), 0);

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
      <Card><CardContent className="p-0 overflow-x-auto">
        {isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">رقم</th>
              <th className="p-2 text-right">التاريخ</th>
              <th className="p-2 text-right">{partyType === "customer" ? "العميل" : "المورد"}</th>
              <th className="p-2 text-right">المبلغ</th>
              <th className="p-2 text-right">VAT</th>
              <th className="p-2 text-right">الإجمالي</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2"></th>
            </tr></thead>
            <tbody>
              {(rows as any[]).length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">لا توجد إشعارات</td></tr>
              )}
              {(rows as any[]).map((r: any) => (
                <tr key={r.id} className="border-t hover:bg-muted/30" data-testid={`row-note-${r.id}`}>
                  <td className="p-2 font-mono">{r.noteNumber}</td>
                  <td className="p-2">{r.noteDate}</td>
                  <td className="p-2">{partyMap[r.partyId] ?? `#${r.partyId}`}</td>
                  <td className="p-2 text-left">{Number(r.amount).toFixed(2)}</td>
                  <td className="p-2 text-left">{r.vatEnabled ? Number(r.vatAmount).toFixed(2) : "—"}</td>
                  <td className="p-2 text-left font-semibold">{Number(r.totalAmount).toFixed(2)}</td>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${r.status === "posted" ? "bg-green-50 text-green-700" : r.status === "cancelled" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
                      {r.status === "posted" ? "مُرحَّل" : r.status === "cancelled" ? "ملغي" : "مسودة"}
                    </span>
                  </td>
                  <td className="p-2 flex gap-1 justify-end">
                    {r.status === "draft" && (
                      <>
                        <Link href={`${base}/${r.id}`}>
                          <Button size="sm" variant="outline" data-testid={`btn-edit-${r.id}`}><Edit className="h-3 w-3" /></Button>
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
                  </td>
                </tr>
              ))}
              {(rows as any[]).length > 0 && (
                <tr className="border-t bg-muted/30 font-semibold">
                  <td colSpan={5} className="p-2 text-right">الإجمالي</td>
                  <td className="p-2 text-left">{total.toFixed(2)}</td>
                  <td colSpan={2}></td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}
