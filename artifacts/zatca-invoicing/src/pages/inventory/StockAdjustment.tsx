import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, SlidersHorizontal, Search, X, Send, ChevronDown, ChevronUp, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:  { label: "مسودة",  color: "bg-amber-50 text-amber-700" },
  posted: { label: "مُرحَّل", color: "bg-green-50 text-green-700" },
};
const REASONS = ["تعديل كمي", "تلف وخسارة", "فاقد وكسر", "إدخال أول مرة", "مكافآت وهبات", "أخرى"];
const EMPTY_LINE = { itemId: "", unitId: "", qty: "0", costPrice: "0", notes: "", conversionFactor: "1" };

export default function StockAdjustment() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>({ adjustmentNumber: "", adjustmentDate: new Date().toISOString().slice(0, 10), warehouseId: "", reason: REASONS[0], notes: "" });
  const [lines, setLines] = useState<any[]>([{ ...EMPTY_LINE }]);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});

  const { data: adjustments = [], isLoading } = useQuery({ queryKey: ["stock-adjustments", cid], queryFn: () => inventoryApi.getAdjustments(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: items = [] } = useQuery({ queryKey: ["items", cid], queryFn: () => inventoryApi.getItems(cid) });
  const { data: units = [] } = useQuery({ queryKey: ["units", cid], queryFn: () => inventoryApi.getUnits(cid) });
  const { data: adjDetail } = useQuery({ queryKey: ["adj-detail", expandedId], queryFn: () => inventoryApi.getAdjustment(expandedId!), enabled: expandedId !== null });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createAdjustment, onSuccess: () => { invalidate(); reset(); toast({ title: "تم إنشاء التسوية" }); } });
  const postMut   = useMutation({ mutationFn: inventoryApi.postAdjustment, onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ["stock-balance"] }); toast({ title: "تم ترحيل التسوية وتحديث المخزون" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteAdjustment, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() {
    setForm({ adjustmentNumber: "", adjustmentDate: new Date().toISOString().slice(0, 10), warehouseId: "", reason: REASONS[0], notes: "" });
    setLines([{ ...EMPTY_LINE }]);
    setShowForm(false);
  }

  const loadItemUnits = useCallback(async (itemId: string) => {
    if (!itemId || itemUnitsMap[itemId] !== undefined) return itemUnitsMap[itemId] ?? [];
    try {
      const ups = await inventoryApi.getItemUnits(Number(itemId));
      setItemUnitsMap(prev => ({ ...prev, [itemId]: ups }));
      return ups;
    } catch { return []; }
  }, [itemUnitsMap]);

  async function handleItemSelect(i: number, itemId: string) {
    const item = (items as any[]).find((it: any) => String(it.id) === itemId);
    const ups = await loadItemUnits(itemId);
    const baseUp = ups.find((u: any) => u.isBase) ?? ups[0];
    setLines(prev => prev.map((l, idx) => idx === i ? {
      ...l,
      itemId,
      unitId: baseUp ? String(baseUp.unitId) : "",
      costPrice: baseUp ? String(baseUp.costPrice) : (item?.costPrice ?? "0"),
      conversionFactor: baseUp ? String(baseUp.conversionFactor) : "1",
    } : l));
  }

  function handleUnitSelect(i: number, unitId: string) {
    const line = lines[i];
    const ups: any[] = itemUnitsMap[line.itemId] ?? [];
    const up = ups.find((u: any) => String(u.unitId) === unitId);
    setLines(prev => prev.map((l, idx) => idx === i ? {
      ...l,
      unitId,
      costPrice: up ? String(up.costPrice) : l.costPrice,
      conversionFactor: up ? String(up.conversionFactor) : "1",
    } : l));
  }

  function updateLine(i: number, key: string, val: string) { setLines(p => p.map((l, idx) => idx === i ? { ...l, [key]: val } : l)); }
  function addLine() { setLines(p => [...p, { ...EMPTY_LINE }]); }
  function removeLine(i: number) { setLines(p => p.filter((_, idx) => idx !== i)); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.warehouseId) return;
    const validLines = lines.filter(l => l.itemId);
    if (!validLines.length) { toast({ title: "أضف صنفاً واحداً على الأقل", variant: "destructive" }); return; }
    createMut.mutate({
      ...form,
      warehouseId: Number(form.warehouseId),
      items: validLines.map(l => ({
        itemId: Number(l.itemId),
        unitId: l.unitId ? Number(l.unitId) : null,
        qty: l.qty,
        costPrice: l.costPrice,
        notes: l.notes,
      })),
    });
  }

  const filtered = adjustments.filter((a: any) => a.adjustmentNumber.includes(search) || (a.warehouse?.nameAr ?? "").includes(search));

  function getLineUnits(line: any): any[] {
    const ups: any[] = itemUnitsMap[line.itemId] ?? [];
    if (ups.length > 0) return ups.map((u: any) => ({ id: u.unitId, nameAr: u.unit?.nameAr ?? "—", code: u.unit?.code, isBase: u.isBase }));
    return units as any[];
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><SlidersHorizontal className="h-6 w-6 text-primary" />التسوية المخزنية</h1>
          <p className="text-muted-foreground text-sm mt-1">تعديل وضبط أرصدة المخزون — الوحدة تملأ التكلفة تلقائياً</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
          <Plus className="h-4 w-4" />تسوية جديدة
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
            <h2 className="font-semibold">تسوية مخزنية جديدة</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label>رقم التسوية</Label>
                <Input placeholder="ADJ-001 (تلقائي)" value={form.adjustmentNumber} onChange={e => setForm((p: any) => ({ ...p, adjustmentNumber: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>التاريخ *</Label>
                <Input type="date" value={form.adjustmentDate} onChange={e => setForm((p: any) => ({ ...p, adjustmentDate: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>المخزن *</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.warehouseId} onChange={e => setForm((p: any) => ({ ...p, warehouseId: e.target.value }))} required>
                  <option value="">— اختر مخزن —</option>
                  {(warehouses as any[]).map((w: any) => <option key={w.id} value={w.id}>[{w.code}] {w.nameAr}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>سبب التسوية</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.reason} onChange={e => setForm((p: any) => ({ ...p, reason: e.target.value }))}>
                  {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
                <Label>ملاحظات</Label>
                <Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">الأصناف</h3>
                <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs"><Plus className="h-3 w-3" />إضافة صنف</Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">الصنف</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-32">الوحدة</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-28">الكمية (+ أو -)</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-32">
                        <span className="flex items-center gap-1">سعر التكلفة <Zap className="h-3 w-3 text-amber-500" /></span>
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">ملاحظة</th>
                      <th className="px-3 py-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line, i) => {
                      const lineUnits = getLineUnits(line);
                      const cf = Number(line.conversionFactor || "1");
                      const baseQty = Number(line.qty || "0") * cf;
                      const hasAutoPrice = line.unitId && (itemUnitsMap[line.itemId] ?? []).some((u: any) => String(u.unitId) === line.unitId);
                      return (
                        <tr key={i}>
                          <td className="px-3 py-2">
                            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={line.itemId} onChange={e => handleItemSelect(i, e.target.value)} required>
                              <option value="">— اختر صنف —</option>
                              {(items as any[]).filter((it: any) => it.itemType === "stock").map((it: any) => <option key={it.id} value={it.id}>[{it.code}] {it.nameAr}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <select
                              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                              value={line.unitId}
                              onChange={e => handleUnitSelect(i, e.target.value)}
                              disabled={!line.itemId}
                            >
                              <option value="">الأساسية</option>
                              {lineUnits.map((u: any) => <option key={u.id} value={u.id}>{u.nameAr ?? u.code}</option>)}
                            </select>
                            {line.itemId && cf !== 1 && (
                              <p className="text-[10px] text-purple-600 mt-0.5 font-medium">
                                ×{cf} → {baseQty.toFixed(2)} وحدة أساسية
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number" step="any" className="h-8 text-xs"
                              value={line.qty}
                              onChange={e => updateLine(i, "qty", e.target.value)}
                              placeholder="+100 أو -50"
                            />
                            {Number(line.qty) >= 0
                              ? <p className="text-[10px] text-green-600 mt-0.5">+ زيادة في المخزون</p>
                              : <p className="text-[10px] text-red-600 mt-0.5">- نقص في المخزون</p>
                            }
                          </td>
                          <td className="px-3 py-2">
                            <div className="relative">
                              <Input
                                type="number" step="any" min="0"
                                className={cn("h-8 text-xs", hasAutoPrice && "border-amber-300 bg-amber-50")}
                                value={line.costPrice}
                                onChange={e => updateLine(i, "costPrice", e.target.value)}
                              />
                              {hasAutoPrice && (
                                <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-0.5">تلقائي</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Input className="h-8 text-xs" placeholder="ملاحظة" value={line.notes} onChange={e => updateLine(i, "notes", e.target.value)} />
                          </td>
                          <td className="px-3 py-2">
                            {lines.length > 1 && <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)}><X className="h-3 w-3" /></Button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3 text-amber-500" />الوحدة تملأ التكلفة تلقائياً من وحدات التسعير — يمكن تعديلها يدوياً
              </p>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending}>حفظ التسوية</Button>
            </div>
          </form>
        </div>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث برقم التسوية أو المخزن..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8"></th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">رقم التسوية</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المخزن</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">السبب</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={7}><Skeleton className="h-6 m-4" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={7} className="py-10 text-center text-muted-foreground"><SlidersHorizontal className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد تسويات</td></tr>
              : filtered.map((adj: any) => {
                  const st = STATUS_CONFIG[adj.status] ?? STATUS_CONFIG.draft;
                  return (
                    <>
                      <tr key={adj.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button onClick={() => setExpandedId(expandedId === adj.id ? null : adj.id)} className="text-muted-foreground">
                            {expandedId === adj.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{adj.adjustmentNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{adj.adjustmentDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{adj.warehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{adj.reason ?? "—"}</td>
                        <td className="px-4 py-3 text-center"><span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>{st.label}</span></td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {adj.status === "draft" && (
                              <>
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50" onClick={() => { if (confirm("ترحيل التسوية وتحديث أرصدة المخزون؟")) postMut.mutate(adj.id); }}>
                                  <Send className="h-3 w-3" />ترحيل
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("حذف التسوية؟")) deleteMut.mutate(adj.id); }}>
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === adj.id && (
                        <tr key={`exp-${adj.id}`} className="bg-muted/10">
                          <td colSpan={7} className="px-6 py-4">
                            {!adjDetail?.items?.length ? <p className="text-xs text-muted-foreground">لا توجد أصناف</p> : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-muted-foreground">
                                    <th className="text-right pb-2">الصنف</th>
                                    <th className="text-right pb-2">الوحدة</th>
                                    <th className="text-right pb-2">الكمية</th>
                                    <th className="text-right pb-2">التكلفة</th>
                                    <th className="text-right pb-2">ملاحظة</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border/50">
                                  {adjDetail.items.map((l: any) => (
                                    <tr key={l.id}>
                                      <td className="py-1.5">{l.item?.nameAr ?? l.itemId}</td>
                                      <td className="py-1.5">{l.unit?.nameAr ?? "وحدة أساسية"}</td>
                                      <td className={cn("py-1.5 tabular-nums font-medium", Number(l.qty) >= 0 ? "text-green-600" : "text-red-600")}>
                                        {Number(l.qty) >= 0 ? "+" : ""}{Number(l.qty).toFixed(2)}
                                      </td>
                                      <td className="py-1.5 tabular-nums">{Number(l.costPrice).toFixed(2)}</td>
                                      <td className="py-1.5 text-muted-foreground">{l.notes ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} تسوية</div>}
      </div>
    </div>
  );
}
