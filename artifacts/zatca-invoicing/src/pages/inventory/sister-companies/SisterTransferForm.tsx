import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowRightLeft, Plus, Trash2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { inventoryApi } from "@/lib/inventoryApi";
import { AccountCombobox } from "@/components/AccountCombobox";
import { DateField } from "@/components/ui/date-field";

const newLine = () => ({ itemId: "", unitId: "", qty: "1", costPrice: "0", supplyPrice: "0" });

export default function SisterTransferForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Read ?sisterId=N from URL (deep-link from sister card)
  const url = new URL(window.location.href);
  const presetSisterId = url.searchParams.get("sisterId") ?? "";

  const [form, setForm] = useState<any>({
    sisterCompanyId: presetSisterId,
    fromWarehouseId: "",
    transferDate: new Date().toISOString().slice(0, 10),
    arAccountId: null, cogsAccountId: null, revenueAccountId: null, inventoryAccountId: null,
    notes: "",
  });
  const [lines, setLines] = useState<any[]>([newLine()]);

  const { data: sisters = [] } = useQuery({ queryKey: ["sister-companies"], queryFn: () => sisterCompaniesApi.list() });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: () => inventoryApi.getWarehouses() });
  const { data: items = [] } = useQuery({ queryKey: ["items"], queryFn: () => inventoryApi.getItems() });
  const { data: units = [] } = useQuery({ queryKey: ["units"], queryFn: () => inventoryApi.getUnits() });

  // When sister picked: prefill default accounts from sister card
  useEffect(() => {
    if (!form.sisterCompanyId) return;
    const s = (sisters as any[]).find((x: any) => String(x.id) === String(form.sisterCompanyId));
    if (!s) return;
    setForm((p: any) => ({
      ...p,
      arAccountId:        p.arAccountId        ?? s.accountId,
      cogsAccountId:      p.cogsAccountId      ?? s.defaultCogsAccountId,
      revenueAccountId:   p.revenueAccountId   ?? s.defaultRevenueAccountId,
      inventoryAccountId: p.inventoryAccountId ?? s.defaultInventoryAccountId,
    }));
  }, [form.sisterCompanyId, sisters]);

  const createMut = useMutation({
    mutationFn: async (body: any) => {
      const tr = await sisterCompaniesApi.createTransfer(body);
      // Auto-post on save (matches StockTransfer.tsx UX).
      await sisterCompaniesApi.postTransfer(tr.id);
      return tr;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sister-transfers"] });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: "تم الحفظ والترحيل" });
      setLocation("/inventory/sister-transfers");
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  function updateLine(idx: number, key: string, val: string) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [key]: val } : l));
  }
  function pickItem(idx: number, itemId: string) {
    const it: any = (items as any[]).find((x: any) => String(x.id) === itemId);
    updateLine(idx, "itemId", itemId);
    if (it) {
      updateLine(idx, "costPrice",   String(it.costPrice ?? 0));
      updateLine(idx, "supplyPrice", String(it.salePrice ?? it.costPrice ?? 0));
      if (it.baseUnitId) updateLine(idx, "unitId", String(it.baseUnitId));
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.sisterCompanyId || !form.fromWarehouseId) {
      toast({ title: "اختر الشركة الشقيقة والمخزن", variant: "destructive" });
      return;
    }
    const valid = lines.filter(l => l.itemId && Number(l.qty) > 0);
    if (!valid.length) { toast({ title: "أضف صنفاً واحداً على الأقل", variant: "destructive" }); return; }
    createMut.mutate({
      sisterCompanyId: Number(form.sisterCompanyId),
      fromWarehouseId: Number(form.fromWarehouseId),
      transferDate: form.transferDate,
      arAccountId: form.arAccountId, cogsAccountId: form.cogsAccountId,
      revenueAccountId: form.revenueAccountId, inventoryAccountId: form.inventoryAccountId,
      notes: form.notes || null,
      items: valid.map(l => ({
        itemId: Number(l.itemId), unitId: l.unitId ? Number(l.unitId) : null,
        qty: l.qty, costPrice: l.costPrice, supplyPrice: l.supplyPrice,
      })),
    });
  }

  const totals = lines.reduce(
    (acc, l) => {
      acc.cost   += Number(l.qty || 0) * Number(l.costPrice   || 0);
      acc.supply += Number(l.qty || 0) * Number(l.supplyPrice || 0);
      return acc;
    },
    { cost: 0, supply: 0 },
  );

  return (
    <form onSubmit={submit} className="p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><ArrowRightLeft className="h-5 w-5" /> تحويل جديد إلى شركة شقيقة</h1>

      <Card><CardHeader><CardTitle className="text-base">بيانات التحويل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label><span className="text-sm">الشركة الشقيقة *</span>
            <select className="w-full border rounded h-9 px-2" value={form.sisterCompanyId}
              onChange={e => setForm({ ...form, sisterCompanyId: e.target.value })} data-testid="select-sister">
              <option value="">اختر…</option>
              {(sisters as any[]).filter((s: any) => s.isActive).map((s: any) =>
                <option key={s.id} value={s.id}>{s.nameAr}</option>)}
            </select></label>
          <label><span className="text-sm">المخزن المصدر *</span>
            <select className="w-full border rounded h-9 px-2" value={form.fromWarehouseId}
              onChange={e => setForm({ ...form, fromWarehouseId: e.target.value })}>
              <option value="">اختر…</option>
              {(warehouses as any[]).map((w: any) => <option key={w.id} value={w.id}>{w.nameAr}</option>)}
            </select></label>
          <label><span className="text-sm">التاريخ</span>
            <DateField value={form.transferDate}
              onChange={e => setForm({ ...form, transferDate: e.target.value })} /></label>
        </CardContent>
      </Card>

      <Card><CardHeader><CardTitle className="text-base">الحسابات المحاسبية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><span className="text-sm">ذمم الشركة الشقيقة (AR)</span>
            <AccountCombobox value={form.arAccountId != null ? String(form.arAccountId) : ""} onValueChange={(v: string) => setForm({ ...form, arAccountId: v ? Number(v) : null })} /></div>
          <div><span className="text-sm">تكلفة البضاعة (COGS)</span>
            <AccountCombobox value={form.cogsAccountId != null ? String(form.cogsAccountId) : ""} onValueChange={(v: string) => setForm({ ...form, cogsAccountId: v ? Number(v) : null })} /></div>
          <div><span className="text-sm">إيراد التوريد</span>
            <AccountCombobox value={form.revenueAccountId != null ? String(form.revenueAccountId) : ""} onValueChange={(v: string) => setForm({ ...form, revenueAccountId: v ? Number(v) : null })} /></div>
          <div><span className="text-sm">المخزون</span>
            <AccountCombobox value={form.inventoryAccountId != null ? String(form.inventoryAccountId) : ""} onValueChange={(v: string) => setForm({ ...form, inventoryAccountId: v ? Number(v) : null })} /></div>
        </CardContent>
      </Card>

      <Card><CardHeader><CardTitle className="text-base">الأصناف</CardTitle></CardHeader>
        <CardContent className="space-y-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-1 text-right">الصنف</th>
              <th className="p-1 text-right">الوحدة</th>
              <th className="p-1 text-right">الكمية</th>
              <th className="p-1 text-right">سعر التكلفة</th>
              <th className="p-1 text-right">سعر التوريد</th>
              <th className="p-1 text-right">الإجمالي</th>
              <th className="p-1"></th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="p-1">
                    <select className="w-full border rounded h-8 px-1" value={l.itemId}
                      onChange={e => pickItem(i, e.target.value)}>
                      <option value="">—</option>
                      {(items as any[]).map((it: any) => <option key={it.id} value={it.id}>{it.nameAr}</option>)}
                    </select>
                  </td>
                  <td className="p-1">
                    <select className="w-full border rounded h-8 px-1" value={l.unitId}
                      onChange={e => updateLine(i, "unitId", e.target.value)}>
                      <option value="">—</option>
                      {(units as any[]).map((u: any) => <option key={u.id} value={u.id}>{u.nameAr}</option>)}
                    </select>
                  </td>
                  <td className="p-1"><Input type="number" min="0" step="0.001" value={l.qty}
                    onChange={e => updateLine(i, "qty", e.target.value)} className="h-8" /></td>
                  <td className="p-1"><Input type="number" min="0" step="0.0001" value={l.costPrice}
                    onChange={e => updateLine(i, "costPrice", e.target.value)} className="h-8" /></td>
                  <td className="p-1"><Input type="number" min="0" step="0.0001" value={l.supplyPrice}
                    onChange={e => updateLine(i, "supplyPrice", e.target.value)} className="h-8" /></td>
                  <td className="p-1 text-left">{(Number(l.qty || 0) * Number(l.supplyPrice || 0)).toFixed(2)}</td>
                  <td className="p-1">
                    <Button type="button" size="sm" variant="ghost"
                      onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-3 w-3 text-red-600" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-semibold">
              <tr><td colSpan={3}></td>
                <td className="p-1 text-left">تكلفة: {totals.cost.toFixed(2)}</td>
                <td className="p-1 text-left">توريد: {totals.supply.toFixed(2)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines(p => [...p, newLine()])}>
            <Plus className="h-3 w-3 ml-1" /> سطر
          </Button>
        </CardContent>
      </Card>

      <label className="block"><span className="text-sm">ملاحظات</span>
        <Input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>

      <div className="flex gap-2">
        <Button type="submit" disabled={createMut.isPending} data-testid="btn-save-transfer">
          <Save className="h-4 w-4 ml-1" /> حفظ وترحيل
        </Button>
        <Button type="button" variant="outline" onClick={() => setLocation("/inventory/sister-transfers")}>إلغاء</Button>
      </div>
    </form>
  );
}
