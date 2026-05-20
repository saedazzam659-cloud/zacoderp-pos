import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Undo2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { inventoryApi } from "@/lib/inventoryApi";

export default function SisterReturnForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const url = new URL(window.location.href);
  const initialTransferId = url.searchParams.get("transferId") ?? "";

  const [transferId, setTransferId] = useState<string>(initialTransferId);
  const [form, setForm] = useState<any>({
    returnDate: new Date().toISOString().slice(0, 10),
    toWarehouseId: "",
    notes: "",
  });
  // returnLines: itemId-keyed qty editor, but we POST per transfer-item-id
  const [qtys, setQtys] = useState<Record<number, string>>({});

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: () => inventoryApi.getWarehouses() });
  const { data: postedTransfers = [] } = useQuery({
    queryKey: ["sister-transfers"], queryFn: () => sisterCompaniesApi.listTransfers(),
  });
  const { data: tDetail } = useQuery({
    queryKey: ["sister-transfer-detail", transferId],
    queryFn: () => sisterCompaniesApi.getTransfer(Number(transferId)),
    enabled: !!transferId,
  });
  const { data: items = [] } = useQuery({ queryKey: ["items"], queryFn: () => inventoryApi.getItems() });
  const itemMap = Object.fromEntries((items as any[]).map((i: any) => [i.id, i.nameAr]));

  // When transfer changes, default toWarehouse = transfer's source warehouse (restores to same)
  useEffect(() => {
    if (tDetail) setForm((p: any) => ({ ...p, toWarehouseId: p.toWarehouseId || String((tDetail as any).fromWarehouseId) }));
  }, [tDetail]);

  const createMut = useMutation({
    mutationFn: async (body: any) => {
      const ret = await sisterCompaniesApi.createReturn(body);
      await sisterCompaniesApi.postReturn(ret.id);
      return ret;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sister-returns"] });
      qc.invalidateQueries({ queryKey: ["sister-transfers"] });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: "تم الحفظ والترحيل" });
      setLocation("/inventory/sister-returns");
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!transferId || !form.toWarehouseId) {
      toast({ title: "اختر التحويل والمخزن", variant: "destructive" }); return;
    }
    const items_ = Object.entries(qtys)
      .filter(([_, v]) => Number(v) > 0)
      .map(([transferItemId, qty]) => ({ transferItemId: Number(transferItemId), qty }));
    if (!items_.length) { toast({ title: "أدخل كمية واحدة على الأقل", variant: "destructive" }); return; }
    createMut.mutate({
      transferId: Number(transferId),
      returnDate: form.returnDate,
      toWarehouseId: Number(form.toWarehouseId),
      notes: form.notes || null,
      items: items_,
    });
  }

  const postedOnly = (postedTransfers as any[]).filter((t: any) => t.status === "posted");

  return (
    <form onSubmit={submit} className="p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><Undo2 className="h-5 w-5" /> مرتجع تحويل</h1>

      <Card><CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6">
        <label><span className="text-sm">التحويل الأصلي *</span>
          <select className="w-full border rounded h-9 px-2" value={transferId}
            onChange={e => { setTransferId(e.target.value); setQtys({}); }} data-testid="select-transfer">
            <option value="">اختر…</option>
            {postedOnly.map((t: any) =>
              <option key={t.id} value={t.id}>{t.transferNumber} - {t.transferDate}</option>)}
          </select></label>
        <label><span className="text-sm">المخزن الذي يستلم *</span>
          <select className="w-full border rounded h-9 px-2" value={form.toWarehouseId}
            onChange={e => setForm({ ...form, toWarehouseId: e.target.value })}>
            <option value="">اختر…</option>
            {(warehouses as any[]).map((w: any) => <option key={w.id} value={w.id}>{w.nameAr}</option>)}
          </select></label>
        <label><span className="text-sm">التاريخ</span>
          <Input type="date" value={form.returnDate}
            onChange={e => setForm({ ...form, returnDate: e.target.value })} /></label>
      </CardContent></Card>

      {tDetail && (tDetail as any).items && (
        <Card><CardHeader><CardTitle className="text-base">الأصناف المتاحة للإرجاع</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>
                <th className="p-1 text-right">الصنف</th>
                <th className="p-1 text-right">كمية أصلية</th>
                <th className="p-1 text-right">سبق إرجاعه</th>
                <th className="p-1 text-right">متاح</th>
                <th className="p-1 text-right">سعر تكلفة</th>
                <th className="p-1 text-right">كمية الإرجاع</th>
              </tr></thead>
              <tbody>
                {((tDetail as any).items as any[]).map((it: any) => {
                  const remaining = Number(it.qty) - Number(it.returnedQty);
                  return (
                    <tr key={it.id} className="border-t">
                      <td className="p-1">{itemMap[it.itemId] ?? `#${it.itemId}`}</td>
                      <td className="p-1 text-left">{Number(it.qty).toFixed(2)}</td>
                      <td className="p-1 text-left">{Number(it.returnedQty).toFixed(2)}</td>
                      <td className="p-1 text-left font-semibold">{remaining.toFixed(2)}</td>
                      <td className="p-1 text-left">{Number(it.costPrice).toFixed(4)}</td>
                      <td className="p-1"><Input type="number" min="0" max={remaining} step="0.001"
                        disabled={remaining <= 0}
                        value={qtys[it.id] ?? ""}
                        onChange={e => setQtys(prev => ({ ...prev, [it.id]: e.target.value }))}
                        className="h-8" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent></Card>
      )}

      <label className="block"><span className="text-sm">ملاحظات</span>
        <Input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>

      <div className="flex gap-2">
        <Button type="submit" disabled={createMut.isPending}><Save className="h-4 w-4 ml-1" /> حفظ وترحيل</Button>
        <Button type="button" variant="outline" onClick={() => setLocation("/inventory/sister-returns")}>إلغاء</Button>
      </div>
    </form>
  );
}
