import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Trash2, Search, CheckCircle2, Package } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const REF_TYPE_LABELS: Record<string, string> = {
  sales_invoice:    "فاتورة مبيعات",
  sales_return:     "مرتجع مبيعات",
  purchase_invoice: "فاتورة مشتريات",
  purchase_return:  "مرتجع مشتريات",
};

export default function OrphanStockCleanup() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [companyId, setCompanyId] = useState<string>("");

  const { data: companies = [] } = useQuery({
    queryKey: ["admin-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/companies`, { headers });
      return r.json();
    },
  });

  const { data: orphanData, refetch, isFetching } = useQuery({
    queryKey: ["orphan-stock", companyId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/orphan-stock?companyId=${companyId}`, { headers });
      return r.json();
    },
    enabled: false,
  });

  const cleanupMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/orphan-stock/cleanup`, {
        method: "POST", headers, body: JSON.stringify({
          companyId: Number(companyId),
          orphanIds: orphanData?.orphanIds ?? [],   // bind to the previewed snapshot
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الحذف");
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `تم حذف ${data.deleted} حركة وتعديل ${data.balancesAdjusted} رصيد` });
      qc.invalidateQueries({ queryKey: ["orphan-stock"] });
      refetch();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const orphans = orphanData?.rows ?? [];
  const count = orphanData?.count ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="h-6 w-6 text-primary" />
          تنظيف حركات المخزون اليتيمة
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          حذف حركات المخزون المرتبطة بفواتير تم حذفها مسبقاً (سجلات بدون مستند مصدر) وإعادة احتساب الأرصدة.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">اختر الشركة وافحص</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">الشركة</label>
              <Select value={companyId} onValueChange={(v) => { setCompanyId(v); }}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— اختر الشركة —" /></SelectTrigger>
                <SelectContent>
                  {companies.map((c: any) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.nameAr || c.nameEn || `#${c.id}`}
                      {c.status !== "active" && <span className="text-muted-foreground"> ({c.status})</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => refetch()}
              disabled={!companyId || isFetching}
              variant="outline" className="gap-1.5"
            >
              <Search className="h-4 w-4" />
              {isFetching ? "جارٍ الفحص..." : "فحص"}
            </Button>
            <Button
              onClick={() => {
                if (!confirm(`سيتم حذف ${count} حركة مخزون يتيمة وتعديل أرصدة المخزون. لا يمكن التراجع. متابعة؟`)) return;
                cleanupMut.mutate();
              }}
              disabled={!companyId || count === 0 || cleanupMut.isPending}
              variant="destructive" className="gap-1.5"
            >
              <Trash2 className="h-4 w-4" />
              {cleanupMut.isPending ? "جارٍ الحذف..." : `حذف وإعادة احتساب${count > 0 ? ` (${count})` : ""}`}
            </Button>
          </div>

          {orphanData && (
            count === 0 ? (
              <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 text-green-800 border border-green-200 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                لا توجد حركات يتيمة في هذه الشركة.
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-md bg-amber-50 text-amber-900 border border-amber-200 text-sm">
                <AlertTriangle className="h-4 w-4" />
                تم العثور على <strong className="mx-1">{count}</strong> حركة يتيمة (مجموع الكمية: {orphanData.totalQty?.toFixed(2)}).
              </div>
            )
          )}
        </CardContent>
      </Card>

      {orphans.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">معاينة (أول 200 حركة)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-right">#</th>
                    <th className="px-3 py-2 text-right">التاريخ</th>
                    <th className="px-3 py-2 text-right">نوع المرجع</th>
                    <th className="px-3 py-2 text-right">رقم المرجع</th>
                    <th className="px-3 py-2 text-right">الصنف</th>
                    <th className="px-3 py-2 text-right">المخزن</th>
                    <th className="px-3 py-2 text-left">الكمية</th>
                    <th className="px-3 py-2 text-left">الرصيد</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {orphans.map((r: any, i: number) => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2 text-xs text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-2 text-xs">{r.txDate}</td>
                      <td className="px-3 py-2 text-xs">{REF_TYPE_LABELS[r.refType] ?? r.refType}</td>
                      <td className="px-3 py-2 text-xs font-mono">#{r.refId}</td>
                      <td className="px-3 py-2 text-xs">#{r.itemId}</td>
                      <td className="px-3 py-2 text-xs">#{r.warehouseId}</td>
                      <td className="px-3 py-2 text-xs text-left font-mono">{Number(r.qty).toFixed(2)}</td>
                      <td className="px-3 py-2 text-xs text-left font-mono">{Number(r.balanceQty).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
