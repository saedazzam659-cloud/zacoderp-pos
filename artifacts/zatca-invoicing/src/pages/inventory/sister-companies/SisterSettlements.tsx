import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Send, Trash2, Wallet, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";

export default function SisterSettlements() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sister-settlements"], queryFn: () => sisterCompaniesApi.listSettlements(),
  });
  const { data: sisters = [] } = useQuery({
    queryKey: ["sister-companies"], queryFn: () => sisterCompaniesApi.list(),
  });
  const sisterMap = Object.fromEntries((sisters as any[]).map(s => [s.id, s.nameAr]));

  const postMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.postSettlement(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sister-settlements"] });
      toast({ title: "تم ترحيل السند" }); },
    onError: (e: any) => toast({ title: "تعذّر الترحيل", description: String(e?.message || e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.deleteSettlement(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sister-settlements"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><Wallet className="h-5 w-5" /> سندات تسوية الشركات الشقيقة</h1>
        <Link href="/inventory/sister-settlements/new">
          <Button><Plus className="h-4 w-4 ml-1" /> سند جديد</Button>
        </Link>
      </div>
      <Card><CardContent className="p-0 overflow-x-auto">
        {isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">رقم</th>
              <th className="p-2 text-right">التاريخ</th>
              <th className="p-2 text-right">الشركة الشقيقة</th>
              <th className="p-2 text-right">النوع</th>
              <th className="p-2 text-right">المبلغ</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2"></th>
            </tr></thead>
            <tbody>
              {(rows as any[]).length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد سندات</td></tr>
              )}
              {(rows as any[]).map((r: any) => (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="p-2 font-mono">{r.code}</td>
                  <td className="p-2">{r.date}</td>
                  <td className="p-2">{sisterMap[r.sisterCompanyId] ?? `#${r.sisterCompanyId}`}</td>
                  <td className="p-2">{r.direction === "receive"
                    ? <span className="text-green-700 flex items-center gap-1"><ArrowDownCircle className="h-3 w-3" /> تحصيل</span>
                    : <span className="text-red-700  flex items-center gap-1"><ArrowUpCircle   className="h-3 w-3" /> سداد</span>}</td>
                  <td className="p-2 text-left font-semibold">{Number(r.amount).toFixed(2)}</td>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${r.status === "posted" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                      {r.status === "posted" ? "مُرحَّل" : "مسودة"}
                    </span>
                  </td>
                  <td className="p-2 flex gap-1">
                    {r.status === "draft" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => postMut.mutate(r.id)}><Send className="h-3 w-3" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف؟")) delMut.mutate(r.id); }}>
                          <Trash2 className="h-3 w-3 text-red-600" />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}
