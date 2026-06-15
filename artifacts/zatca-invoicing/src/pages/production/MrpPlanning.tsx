import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, X, Save, Edit3, Play, Calculator,
  AlertTriangle, CheckCircle2, Factory, ShoppingCart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  active: "نشط",
  archived: "مؤرشف",
};

type ForecastSummary = {
  id: number;
  name: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  notes: string | null;
  lineCount: number;
};

type ForecastLine = {
  id?: number;
  productItemId: number | null;
  forecastQty: string;
  notes: string;
  productNameAr?: string | null;
  productSku?: string | null;
};

type Forecast = {
  id: number;
  name: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  notes: string | null;
  lines: ForecastLine[];
};

type MrpRow = {
  itemId: number;
  nameAr: string | null;
  nameEn: string | null;
  sku: string | null;
  kind: "fg" | "raw";
  requiredQty: number;
  onHandQty: number;
  openProductionQty: number;
  netRequirement: number;
  suggestedAction: "produce" | "purchase" | "ok";
  missingBomTemplate: boolean;
};

type Item = { id: number; nameAr?: string | null; nameEn?: string | null; sku?: string | null };

const EMPTY_FORM = {
  id: null as number | null,
  name: "",
  periodStart: new Date().toISOString().slice(0, 10),
  periodEnd: new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10),
  status: "draft",
  notes: "",
  lines: [] as ForecastLine[],
};

export default function MrpPlanning() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [list, setList] = useState<ForecastSummary[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<typeof EMPTY_FORM | null>(null);
  const [saving, setSaving] = useState(false);
  const [mrpResult, setMrpResult] = useState<MrpRow[] | null>(null);
  const [mrpRunning, setMrpRunning] = useState(false);
  const [mrpForecastName, setMrpForecastName] = useState<string>("");

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [fR, iR] = await Promise.all([
        fetch(`${API}/api/production/forecasts`, { headers }),
        fetch(`${API}/api/inventory/items?limit=1000`, { headers }),
      ]);
      if (fR.ok) setList(await fR.json());
      if (iR.ok) {
        const d = await iR.json();
        setItems(Array.isArray(d) ? d : d?.items ?? []);
      }
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }, [token, headers, toast]);

  useEffect(() => { void load(); }, [load]);

  const itemLabel = (id: number | null | undefined) => {
    if (!id) return "—";
    const it = items.find((x) => x.id === id);
    return it?.nameAr || it?.nameEn || it?.sku || `#${id}`;
  };

  const startNew = () => setEditing({ ...EMPTY_FORM, lines: [
    { productItemId: null, forecastQty: "", notes: "" },
  ] });

  const startEdit = async (id: number) => {
    try {
      const r = await fetch(`${API}/api/production/forecasts/${id}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const fc: Forecast = await r.json();
      setEditing({
        id: fc.id,
        name: fc.name,
        periodStart: fc.periodStart,
        periodEnd: fc.periodEnd,
        status: fc.status,
        notes: fc.notes ?? "",
        lines: (fc.lines ?? []).map((l) => ({
          id: l.id,
          productItemId: l.productItemId,
          forecastQty: String(l.forecastQty ?? ""),
          notes: l.notes ?? "",
        })),
      });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  };

  const addLine = () => {
    if (!editing) return;
    setEditing({
      ...editing,
      lines: [...editing.lines, { productItemId: null, forecastQty: "", notes: "" }],
    });
  };
  const updateLine = (idx: number, patch: Partial<ForecastLine>) => {
    if (!editing) return;
    const next = editing.lines.slice();
    next[idx] = { ...next[idx], ...patch };
    setEditing({ ...editing, lines: next });
  };
  const removeLine = (idx: number) => {
    if (!editing) return;
    setEditing({ ...editing, lines: editing.lines.filter((_, i) => i !== idx) });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast({ title: "الاسم مطلوب", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: editing.name.trim(),
        periodStart: editing.periodStart,
        periodEnd: editing.periodEnd,
        status: editing.status,
        notes: editing.notes.trim() || null,
        lines: editing.lines
          .filter((l) => l.productItemId && Number(l.forecastQty) > 0)
          .map((l) => ({
            productItemId: l.productItemId,
            forecastQty: Number(l.forecastQty),
            notes: l.notes.trim() || null,
          })),
      };
      const url = editing.id
        ? `${API}/api/production/forecasts/${editing.id}`
        : `${API}/api/production/forecasts`;
      const r = await fetch(url, {
        method: editing.id ? "PUT" : "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      toast({ title: editing.id ? "تم التحديث" : "تم الإنشاء" });
      setEditing(null);
      void load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("حذف التوقع نهائياً؟")) return;
    const r = await fetch(`${API}/api/production/forecasts/${id}`, {
      method: "DELETE", headers,
    });
    if (r.ok) { toast({ title: "تم الحذف" }); void load(); }
    else toast({ title: "فشل الحذف", variant: "destructive" });
  };

  const runMrp = async (fc: ForecastSummary) => {
    setMrpRunning(true);
    setMrpResult(null);
    setMrpForecastName(fc.name);
    try {
      const r = await fetch(`${API}/api/production/mrp/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ forecastId: fc.id }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setMrpResult(data.requirements ?? []);
    } catch (e: any) {
      toast({ title: "فشل تشغيل MRP", description: e?.message, variant: "destructive" });
    } finally {
      setMrpRunning(false);
    }
  };

  // Stats: count of items needing purchase / production.
  const stats = useMemo(() => {
    if (!mrpResult) return null;
    return {
      total: mrpResult.length,
      produce: mrpResult.filter((r) => r.suggestedAction === "produce").length,
      purchase: mrpResult.filter((r) => r.suggestedAction === "purchase").length,
      ok: mrpResult.filter((r) => r.suggestedAction === "ok").length,
      missingBom: mrpResult.filter((r) => r.missingBomTemplate).length,
    };
  }, [mrpResult]);

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Calculator className="h-6 w-6 text-indigo-600" />
          <div>
            <h1 className="text-2xl font-bold">تخطيط احتياجات المواد (MRP)</h1>
            <p className="text-sm text-slate-500">
              أنشئ توقع طلب لمنتجاتك التامة، شغّل MRP، واحصل على قائمة بما يجب إنتاجه أو شراؤه.
            </p>
          </div>
        </div>
        <Button onClick={startNew}><Plus className="h-4 w-4 me-1" />توقع جديد</Button>
      </div>

      {/* Forecast editor */}
      {editing && (
        <Card className="border-indigo-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {editing.id ? `تعديل التوقع #${editing.id}` : "توقع جديد"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <Label className="text-xs">اسم التوقع *</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="توقع الربع الأول 2026"
                />
              </div>
              <div>
                <Label className="text-xs">بداية الفترة *</Label>
                <DateField
                  value={editing.periodStart}
                  onChange={(e) => setEditing({ ...editing, periodStart: e.target.value })}
                />
              </div>
              <div>
                <Label className="text-xs">نهاية الفترة *</Label>
                <DateField
                  value={editing.periodEnd}
                  onChange={(e) => setEditing({ ...editing, periodEnd: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">الحالة</Label>
                <select
                  value={editing.status}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}
                  className="h-10 rounded border border-input bg-background px-2 text-sm w-full"
                >
                  <option value="draft">مسودة</option>
                  <option value="active">نشط</option>
                  <option value="archived">مؤرشف</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <Label className="text-xs">ملاحظات</Label>
                <Input
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </div>
            </div>

            <div className="border rounded">
              <div className="flex items-center justify-between p-2 bg-slate-50 border-b">
                <span className="text-sm font-bold">الكميات المتوقعة ({editing.lines.length})</span>
                <Button size="sm" variant="outline" onClick={addLine}>
                  <Plus className="h-3 w-3 me-1" />سطر
                </Button>
              </div>
              {editing.lines.length === 0 ? (
                <div className="p-4 text-center text-sm text-slate-500">لا توجد أسطر</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-100/60 text-xs">
                    <tr>
                      <th className="p-2 text-start w-8">#</th>
                      <th className="p-2 text-start">المنتج التام *</th>
                      <th className="p-2 text-start w-32">الكمية *</th>
                      <th className="p-2 text-start">ملاحظات</th>
                      <th className="p-2 text-center w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {editing.lines.map((ln, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="p-2 text-xs text-slate-500">{idx + 1}</td>
                        <td className="p-2">
                          <SearchCombobox
                            value={ln.productItemId ? String(ln.productItemId) : ""}
                            onValueChange={(v: string) =>
                              updateLine(idx, { productItemId: v ? Number(v) : null })
                            }
                            items={items.map((it) => ({
                              value: String(it.id),
                              label: it.nameAr || it.nameEn || it.sku || `#${it.id}`,
                            }))}
                            placeholder="اختر منتج..."
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={ln.forecastQty}
                            onChange={(e) => updateLine(idx, { forecastQty: e.target.value })}
                            className="h-8"
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            value={ln.notes}
                            onChange={(e) => updateLine(idx, { notes: e.target.value })}
                            className="h-8"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                            onClick={() => removeLine(idx)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
                <X className="h-4 w-4 me-1" />إلغاء
              </Button>
              <Button onClick={save} disabled={saving}>
                <Save className="h-4 w-4 me-1" />{saving ? "جاري الحفظ..." : "حفظ"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Forecasts list */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">التوقعات</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!list ? (
            <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : list.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              <Calculator className="h-10 w-10 mx-auto mb-2 opacity-40" />
              لا توجد توقعات بعد — أنشئ الأول
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100/60 text-xs">
                  <tr>
                    <th className="p-3 text-start">الاسم</th>
                    <th className="p-3 text-start">الفترة</th>
                    <th className="p-3 text-center">الأسطر</th>
                    <th className="p-3 text-center">الحالة</th>
                    <th className="p-3 text-center w-32">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((fc) => (
                    <tr key={fc.id} className="border-t hover:bg-slate-50">
                      <td className="p-3 font-bold">{fc.name}</td>
                      <td className="p-3 text-xs font-mono">
                        {fc.periodStart} → {fc.periodEnd}
                      </td>
                      <td className="p-3 text-center">{fc.lineCount}</td>
                      <td className="p-3 text-center">
                        <Badge variant={fc.status === "active" ? "default" : "outline"}>
                          {STATUS_LABEL[fc.status] ?? fc.status}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center justify-center gap-1">
                          <Button size="sm" variant="default" className="h-7 gap-1"
                            onClick={() => runMrp(fc)} disabled={mrpRunning || fc.lineCount === 0}>
                            <Play className="h-3 w-3" />تشغيل
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                            onClick={() => startEdit(fc.id)}>
                            <Edit3 className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                            onClick={() => remove(fc.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* MRP results */}
      {(mrpRunning || mrpResult) && (
        <Card className="border-indigo-300">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Calculator className="h-4 w-4 text-indigo-600" />
                نتيجة MRP — {mrpForecastName}
              </span>
              {mrpResult && (
                <Button size="sm" variant="ghost" onClick={() => setMrpResult(null)}>
                  <X className="h-3 w-3" />
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {mrpRunning ? (
              <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : !mrpResult || mrpResult.length === 0 ? (
              <div className="p-4 text-center text-slate-500">لا توجد نتائج</div>
            ) : (
              <>
                {stats && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
                    <div className="rounded border p-2 text-center">
                      <div className="text-xs text-slate-500">إجمالي البنود</div>
                      <div className="text-lg font-bold">{stats.total}</div>
                    </div>
                    <div className="rounded border border-blue-200 bg-blue-50 p-2 text-center">
                      <div className="text-xs text-blue-700 flex items-center justify-center gap-1">
                        <Factory className="h-3 w-3" />إنتاج
                      </div>
                      <div className="text-lg font-bold text-blue-900">{stats.produce}</div>
                    </div>
                    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-center">
                      <div className="text-xs text-amber-700 flex items-center justify-center gap-1">
                        <ShoppingCart className="h-3 w-3" />شراء
                      </div>
                      <div className="text-lg font-bold text-amber-900">{stats.purchase}</div>
                    </div>
                    <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-center">
                      <div className="text-xs text-emerald-700 flex items-center justify-center gap-1">
                        <CheckCircle2 className="h-3 w-3" />متوفر
                      </div>
                      <div className="text-lg font-bold text-emerald-900">{stats.ok}</div>
                    </div>
                    <div className="rounded border border-rose-200 bg-rose-50 p-2 text-center">
                      <div className="text-xs text-rose-700 flex items-center justify-center gap-1">
                        <AlertTriangle className="h-3 w-3" />بدون BOM
                      </div>
                      <div className="text-lg font-bold text-rose-900">{stats.missingBom}</div>
                    </div>
                  </div>
                )}
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-2 text-start">المنتج</th>
                        <th className="p-2 text-center">النوع</th>
                        <th className="p-2 text-end">المطلوب</th>
                        <th className="p-2 text-end">المخزون</th>
                        <th className="p-2 text-end">إنتاج مفتوح</th>
                        <th className="p-2 text-end font-bold">العجز</th>
                        <th className="p-2 text-center">الإجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mrpResult.map((r) => (
                        <tr key={r.itemId} className="border-t">
                          <td className="p-2">
                            <div className="font-bold">{r.nameAr || r.nameEn || `#${r.itemId}`}</div>
                            {r.sku && <div className="text-[10px] text-slate-500 font-mono">{r.sku}</div>}
                            {r.missingBomTemplate && (
                              <Badge variant="destructive" className="mt-1 text-[10px]">بدون قالب BOM</Badge>
                            )}
                          </td>
                          <td className="p-2 text-center">
                            <Badge variant={r.kind === "fg" ? "default" : "outline"} className="text-[10px]">
                              {r.kind === "fg" ? "تام" : "خام"}
                            </Badge>
                          </td>
                          <td className="p-2 text-end font-mono">{r.requiredQty.toLocaleString("en-US")}</td>
                          <td className="p-2 text-end font-mono">{r.onHandQty.toLocaleString("en-US")}</td>
                          <td className="p-2 text-end font-mono text-slate-500">
                            {r.openProductionQty > 0 ? r.openProductionQty.toLocaleString("en-US") : "—"}
                          </td>
                          <td className={`p-2 text-end font-mono font-bold ${r.netRequirement > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                            {r.netRequirement.toLocaleString("en-US")}
                          </td>
                          <td className="p-2 text-center">
                            {r.suggestedAction === "produce" && (
                              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 gap-1">
                                <Factory className="h-3 w-3" />إنتاج
                              </Badge>
                            )}
                            {r.suggestedAction === "purchase" && (
                              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 gap-1">
                                <ShoppingCart className="h-3 w-3" />شراء
                              </Badge>
                            )}
                            {r.suggestedAction === "ok" && (
                              <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 gap-1">
                                <CheckCircle2 className="h-3 w-3" />متوفر
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
