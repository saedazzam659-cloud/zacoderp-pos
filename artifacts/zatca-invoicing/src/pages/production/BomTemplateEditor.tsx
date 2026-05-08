import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useToast } from "@/hooks/use-toast";
import { useLocation, useRoute, Link } from "wouter";
import { ArrowRight, Plus, Save, Trash2, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import UnitCodeSelect from "@/components/UnitCodeSelect";

const API = import.meta.env.VITE_API_URL || "";

type Item = {
  id: number;
  nameAr: string;
  nameEn: string | null;
  itemNature?: string | null;
  unitCode?: string | null;
};

type Line = {
  id?: number;
  itemId: number | null;
  description: string;
  quantity: string;
  unitCode: string;
  notes?: string | null;
};

const NEW_LINE: Line = { itemId: null, description: "", quantity: "1", unitCode: "PCE", notes: "" };

// natures eligible to act as the FG output (manufactured items)
const FG_NATURES = new Set(["finished", "semi"]);
// natures eligible as raw lines
const RAW_NATURES = new Set(["raw", "consumable", "semi"]);

export default function BomTemplateEditor() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [, params] = useRoute<{ id: string }>("/production/bom-templates/:id");
  const isNew = !params || params.id === "new";
  const id = isNew ? null : Number(params!.id);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<Item[]>([]);

  const [productItemId, setProductItemId] = useState<number | null>(null);
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [outputQty, setOutputQty] = useState("1");
  const [outputUnitCode, setOutputUnitCode] = useState("PCE");
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  // Reusable items fetcher — called on mount AND whenever the user
  // returns to this tab (so a newly-added item from another screen
  // appears in the picker without manual refresh).
  const loadItems = useCallback(async () => {
    if (!token) return;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const itemsR = await fetch(`${API}/api/inventory/items?includeHidden=1&limit=5000`, { headers });
      const itemsJ = itemsR.ok ? await itemsR.json() : [];
      const all: Item[] = Array.isArray(itemsJ) ? itemsJ : (itemsJ.rows ?? []);
      setItems(all);
    } catch {
      /* silent — initial load handles user-facing error */
    }
  }, [token]);
  useRefetchOnFocus(loadItems);

  // Load items + (optionally) the existing template
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const itemsR = await fetch(`${API}/api/inventory/items?includeHidden=1&limit=5000`, { headers });
        const itemsJ = itemsR.ok ? await itemsR.json() : [];
        const all: Item[] = Array.isArray(itemsJ) ? itemsJ : (itemsJ.rows ?? []);
        if (!cancelled) setItems(all);

        if (!isNew && id) {
          const tR = await fetch(`${API}/api/production/bom-templates/${id}`, { headers });
          if (!tR.ok) throw new Error(`HTTP ${tR.status}`);
          const t = await tR.json();
          if (cancelled) return;
          setProductItemId(t.productItemId);
          setNameAr(t.nameAr);
          setNameEn(t.nameEn ?? "");
          setOutputQty(String(t.outputQty));
          setOutputUnitCode(t.outputUnitCode || "PCE");
          setIsActive(!!t.isActive);
          setNotes(t.notes ?? "");
          setLines(
            (t.lines ?? []).map((l: any) => ({
              id: l.id,
              itemId: l.itemId,
              description: l.description,
              quantity: String(l.quantity),
              unitCode: l.unitCode,
              notes: l.notes,
            })),
          );
        }
      } catch (e: any) {
        toast({ title: "خطأ", description: e?.message, variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, id, isNew, toast]);

  const fgItems = useMemo(
    () => items.filter(i => !i.itemNature || FG_NATURES.has(i.itemNature)),
    [items],
  );
  const rawItems = useMemo(
    () => items.filter(i => !i.itemNature || RAW_NATURES.has(i.itemNature)),
    [items],
  );

  function addLine() { setLines(ls => [...ls, { ...NEW_LINE }]); }
  function removeLine(idx: number) { setLines(ls => ls.filter((_, i) => i !== idx)); }
  function patchLine(idx: number, patch: Partial<Line>) {
    setLines(ls => ls.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function pickLineItem(idx: number, itemId: number | null) {
    const it = itemId == null ? null : items.find(x => x.id === itemId);
    patchLine(idx, {
      itemId,
      description: it ? (it.nameAr || it.nameEn || "") : lines[idx].description,
      unitCode: it?.unitCode || lines[idx].unitCode,
    });
  }

  async function save() {
    if (!productItemId) {
      toast({ title: "اختر المنتج النهائي أولاً", variant: "destructive" });
      return;
    }
    if (!nameAr.trim()) {
      toast({ title: "اسم القالب مطلوب", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
      const body = {
        productItemId, nameAr: nameAr.trim(), nameEn: nameEn.trim() || null,
        outputQty: Number(outputQty) || 1, outputUnitCode, isActive, notes: notes.trim() || null,
      };
      let templateId = id;
      if (isNew) {
        const r = await fetch(`${API}/api/production/bom-templates`, {
          method: "POST", headers, body: JSON.stringify({ ...body, lines }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        templateId = j.id;
      } else {
        const r = await fetch(`${API}/api/production/bom-templates/${id}`, {
          method: "PATCH", headers, body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        const lr = await fetch(`${API}/api/production/bom-templates/${id}/lines`, {
          method: "PUT", headers, body: JSON.stringify({ lines }),
        });
        if (!lr.ok) {
          const lj = await lr.json().catch(() => ({}));
          throw new Error(lj?.error || `HTTP ${lr.status}`);
        }
      }
      toast({ title: "✓ تم الحفظ" });
      navigate(`/production/bom-templates/${templateId}`);
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-48" /><Skeleton className="h-64" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link href="/production/bom-templates">
            <Button variant="ghost" size="sm"><ArrowRight className="h-4 w-4" /></Button>
          </Link>
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <ListTree className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{isNew ? "قالب جديد" : "تعديل القالب"}</h1>
            <p className="text-sm text-slate-500">يُسحب هذا القالب تلقائياً عند إنشاء أمر إنتاج للمنتج المحدد.</p>
          </div>
        </div>
        <Button onClick={save} disabled={saving} data-testid="btn-save-bom-template">
          <Save className="h-4 w-4 me-1" />
          {saving ? "جاري الحفظ…" : "حفظ"}
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">معلومات القالب</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label>المنتج النهائي *</Label>
            <SearchCombobox
              value={productItemId == null ? "" : String(productItemId)}
              onValueChange={(v) => setProductItemId(v ? Number(v) : null)}
              placeholder="اختر المنتج النهائي…"
              searchPlaceholder="ابحث بالاسم أو الكود…"
              items={fgItems.map(i => ({
                value: String(i.id),
                code: (i as any).sku || (i as any).code,
                label: i.nameAr || i.nameEn || `#${i.id}`,
                labelEn: i.nameEn ?? undefined,
              }))}
            />
            <p className="mt-1 text-xs text-slate-500">يظهر فقط الأصناف من نوع "تام الصنع" أو "نصف مصنّع".</p>
          </div>
          <div>
            <Label>اسم القالب (عربي) *</Label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </div>
          <div>
            <Label>اسم القالب (إنجليزي)</Label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div>
            <Label>الكمية الناتجة</Label>
            <Input type="number" min="0" step="0.0001"
              value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">عدد الوحدات التي ينتجها القالب من الكميات أدناه.</p>
          </div>
          <div>
            <Label>وحدة الناتج</Label>
            <UnitCodeSelect value={outputUnitCode} onChange={setOutputUnitCode} />
          </div>
          <div className="md:col-span-2 flex items-center gap-3">
            <Switch checked={isActive} onCheckedChange={setIsActive} id="bom-active" />
            <Label htmlFor="bom-active">القالب نشط (يُسحب تلقائياً عند الإنشاء)</Label>
          </div>
          <div className="md:col-span-2">
            <Label>ملاحظات</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">المكوّنات (الخامات)</CardTitle>
          <Button size="sm" variant="outline" onClick={addLine}>
            <Plus className="h-4 w-4 me-1" />إضافة مكوّن
          </Button>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-slate-500">
              لا توجد مكوّنات بعد. اضغط <strong>«إضافة مكوّن»</strong>.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-start w-1/3">الصنف</th>
                    <th className="p-2 text-start">الوصف</th>
                    <th className="p-2 text-center w-28">الكمية</th>
                    <th className="p-2 text-center w-28">الوحدة</th>
                    <th className="p-2 text-end w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={idx} className="border-t align-top">
                      <td className="p-2">
                        <SearchCombobox
                          value={l.itemId == null ? "" : String(l.itemId)}
                          onValueChange={(v) => pickLineItem(idx, v ? Number(v) : null)}
                          placeholder="اختر صنف…"
                          searchPlaceholder="ابحث بالاسم أو الكود…"
                          items={rawItems.map(i => ({
                            value: String(i.id),
                            code: (i as any).sku || (i as any).code,
                            label: i.nameAr || i.nameEn || `#${i.id}`,
                            labelEn: i.nameEn ?? undefined,
                          }))}
                        />
                      </td>
                      <td className="p-2">
                        <Input value={l.description}
                          onChange={(e) => patchLine(idx, { description: e.target.value })} />
                      </td>
                      <td className="p-2">
                        <Input type="number" min="0" step="0.0001" value={l.quantity}
                          onChange={(e) => patchLine(idx, { quantity: e.target.value })} />
                      </td>
                      <td className="p-2">
                        <UnitCodeSelect value={l.unitCode}
                          onChange={(v) => patchLine(idx, { unitCode: v })} />
                      </td>
                      <td className="p-2 text-end">
                        <Button size="sm" variant="ghost" className="text-red-600"
                          onClick={() => removeLine(idx)}><Trash2 className="h-4 w-4" /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
