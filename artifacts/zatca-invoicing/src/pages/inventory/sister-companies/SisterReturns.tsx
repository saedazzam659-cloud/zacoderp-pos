import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Send, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";

const STATUS: Record<string, { label: string; color: string }> = {
  draft:  { label: "مسودة",  color: "bg-amber-50 text-amber-700" },
  posted: { label: "مُرحَّل", color: "bg-green-50 text-green-700" },
};

export default function SisterReturns() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: returns = [], isLoading } = useQuery({
    queryKey: ["sister-returns"], queryFn: () => sisterCompaniesApi.listReturns(),
  });
  const { data: sisters = [] } = useQuery({
    queryKey: ["sister-companies"], queryFn: () => sisterCompaniesApi.list(),
  });
  const sisterMap = Object.fromEntries((sisters as any[]).map(s => [s.id, s.nameAr]));

  const postMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.postReturn(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sister-returns"] });
      toast({ title: "تم ترحيل المرتجع" }); },
    onError: (e: any) => toast({ title: "تعذّر الترحيل", description: String(e?.message || e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.deleteReturn(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sister-returns"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><Undo2 className="h-5 w-5" /> مرتجعات الشركات الشقيقة</h1>
        <Link href="/inventory/sister-returns/new">
          <Button><Plus className="h-4 w-4 ml-1" /> مرتجع جديد</Button>
        </Link>
      </div>

      <Card><CardContent className="p-0 overflow-x-auto">
        {isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">رقم</th>
              <th className="p-2 text-right">التاريخ</th>
              <th className="p-2 text-right">الشركة الشقيقة</th>
              <th className="p-2 text-right">تكلفة</th>
              <th className="p-2 text-right">قيمة التوريد</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2"></th>
            </tr></thead>
            <tbody>
              {(returns as any[]).length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد مرتجعات</td></tr>
              )}
              {(returns as any[]).map((r: any) => {
                const st = STATUS[r.status] ?? { label: r.status, color: "" };
                return (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="p-2 font-mono">{r.returnNumber}</td>
                    <td className="p-2">{r.returnDate}</td>
                    <td className="p-2">{sisterMap[r.sisterCompanyId] ?? `#${r.sisterCompanyId}`}</td>
                    <td className="p-2 text-left">{Number(r.totalCost).toFixed(2)}</td>
                    <td className="p-2 text-left">{Number(r.totalSupply).toFixed(2)}</td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded text-xs ${st.color}`}>{st.label}</span></td>
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
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}
