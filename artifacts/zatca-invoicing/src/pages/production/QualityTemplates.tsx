import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, X, Save, Edit3, ShieldCheck, ChevronUp, ChevronDown, Package, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";

const API = import.meta.env.VITE_API_URL || "";

const CHECK_TYPES: { value: string; label: string }[] = [
  { value: "visual",      label: "بصري" },
  { value: "weight",      label: "وزن" },
  { value: "temperature", label: "حرارة" },
  { value: "dimension",   label: "أبعاد" },
  { value: "barcode",     label: "باركود" },
  { value: "ai_camera",   label: "كاميرا ذكية" },
  { value: "other",       label: "أخرى" },
];

type TemplateItem = {
  id?: number;
  label: string;
  checkType: string;
  expectedValue: string;
  sampleSize: string;
  sortOrder: number;
  isRequired: boolean;
};

type Template = {
  id: number;
  name: string;
  productItemId: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  items?: TemplateItem[];
};

type Item = { id: number; nameAr?: string | null; nameEn?: string | null; sku?: string | null };

const EMPTY_ITEM: TemplateItem = {
  label: "",
  checkType: "visual",
  expectedValue: "",
  sampleSize: "",
  sortOrder: 0,
  isRequired: true,
};

const EMPTY_FORM = {
  id: null as number | null,
  name: "",
  productItemId: null as number | null,
  notes: "",
  isActive: true,
  items: [] as TemplateItem[],
};

export default function QualityTemplates() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [list, setList] = useState<Template[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<typeof EMPTY_FORM | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [tplR, itR] = await Promise.all([
        fetch(`${API}/api/production/quality-templates`, { headers }),
        fetch(`${API}/api/inventory/items?limit=500`, { headers }),
      ]);
      if (!tplR.ok) throw new Error(`HTTP ${tplR.status}`);
      const tpls = await tplR.json();
      setList(Array.isArray(tpls) ? tpls : []);
      if (itR.ok) {
        const dat = await itR.json();
        setItems(Array.isArray(dat) ? dat : dat?.items ?? []);
      }
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, headers, toast]);

  useEffect(() => { void load(); }, [load]);

  const startNew = () => {
    setEditing({
      ...EMPTY_FORM,
      items: [{ ...EMPTY_ITEM, sortOrder: 0 }],
    });
  };

  const startEdit = async (tpl: Template) => {
    try {
      const r = await fetch(`${API}/api/production/quality-templates/${tpl.id}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const full = await r.json();
      setEditing({
        id: full.id,
        name: full.name ?? "",
        productItemId: full.productItemId ?? null,
        notes: full.notes ?? "",
        isActive: full.isActive,
        items: (full.items ?? []).map((it: any) => ({
          id: it.id,
          label: it.label ?? "",
          checkType: it.checkType ?? "visual",
          expectedValue: it.expectedValue ?? "",
          sampleSize: it.sampleSize != null ? String(it.sampleSize) : "",
          sortOrder: it.sortOrder ?? 0,
          isRequired: it.isRequired !== false,
        })),
      });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  };

  const updateItem = (idx: number, patch: Partial<TemplateItem>) => {
    if (!editing) return;
    const next = editing.items.slice();
    next[idx] = { ...next[idx], ...patch };
    setEditing({ ...editing, items: next });
  };
  const addItem = () => {
    if (!editing) return;
    setEditing({
      ...editing,
      items: [...editing.items, { ...EMPTY_ITEM, sortOrder: editing.items.length }],
    });
  };
  const removeItem = (idx: number) => {
    if (!editing) return;
    setEditing({ ...editing, items: editing.items.filter((_, i) => i !== idx) });
  };
  const moveItem = (idx: number, dir: -1 | 1) => {
    if (!editing) return;
    const next = editing.items.slice();
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setEditing({ ...editing, items: next.map((it, i) => ({ ...it, sortOrder: i })) });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast({ title: "اسم القالب مطلوب", variant: "destructive" });
      return;
    }
    if (editing.items.length === 0) {
      toast({ title: "أضف بنداً واحداً على الأقل", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: editing.name.trim(),
        productItemId: editing.productItemId,
        notes: editing.notes.trim() || null,
        isActive: editing.isActive,
        items: editing.items.map((it, i) => ({
          label: it.label.trim(),
          checkType: it.checkType,
          expectedValue: it.expectedValue.trim() || null,
          sampleSize: it.sampleSize ? Number(it.sampleSize) : null,
          sortOrder: i,
          isRequired: it.isRequired,
        })),
      };
      const url = editing.id
        ? `${API}/api/production/quality-templates/${editing.id}`
        : `${API}/api/production/quality-templates`;
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
    if (!confirm("حذف القالب نهائياً؟")) return;
    try {
      const r = await fetch(`${API}/api/production/quality-templates/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: "تم الحذف" });
      void load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  };

  const itemLabel = (id: number | null) => {
    if (!id) return null;
    const it = items.find((x) => x.id === id);
    return it?.nameAr || it?.nameEn || it?.sku || `#${id}`;
  };

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold">قوالب فحص الجودة</h1>
            <p className="text-sm text-slate-500">
              قوالب جاهزة لتسريع إدخال فحوصات الجودة — اربط القالب بمنتج لاقتراحه تلقائياً.
            </p>
          </div>
        </div>
        <Button onClick={startNew} data-testid="btn-new-tpl">
          <Plus className="h-4 w-4 me-1" />قالب جديد
        </Button>
      </div>

      {/* Editor */}
      {editing && (
        <Card className="border-emerald-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {editing.id ? `تعديل القالب #${editing.id}` : "قالب جديد"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">اسم القالب *</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="مثال: فحص خط تعبئة العصير"
                />
              </div>
              <div>
                <Label className="text-xs">المنتج (اختياري — للاقتراح التلقائي)</Label>
                <SearchCombobox
                  value={editing.productItemId ? String(editing.productItemId) : ""}
                  onValueChange={(v: string) =>
                    setEditing({ ...editing, productItemId: v ? Number(v) : null })
                  }
                  items={[
                    { value: "", label: "— عام لجميع المنتجات —" },
                    ...items.map((it) => ({
                      value: String(it.id),
                      label: it.nameAr || it.nameEn || it.sku || `#${it.id}`,
                    })),
                  ]}
                  placeholder="اختر المنتج..."
                />
              </div>
              <div className="flex items-end gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.isActive}
                    onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                    className="h-4 w-4"
                  />
                  مفعّل
                </label>
              </div>
            </div>
            <div>
              <Label className="text-xs">ملاحظات</Label>
              <Textarea
                rows={2}
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="ملاحظات حول استخدام القالب..."
              />
            </div>

            {/* Items table */}
            <div className="border rounded">
              <div className="flex items-center justify-between p-2 bg-slate-50 border-b">
                <span className="text-sm font-bold">بنود الفحص ({editing.items.length})</span>
                <Button size="sm" variant="outline" onClick={addItem}>
                  <Plus className="h-3 w-3 me-1" />بند
                </Button>
              </div>
              {editing.items.length === 0 ? (
                <div className="p-4 text-center text-sm text-slate-500">
                  لا توجد بنود — أضف بنداً واحداً على الأقل
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-2 text-start w-8">#</th>
                        <th className="p-2 text-start">التسمية *</th>
                        <th className="p-2 text-start">النوع</th>
                        <th className="p-2 text-start">القيمة المتوقعة</th>
                        <th className="p-2 text-start w-24">حجم العينة</th>
                        <th className="p-2 text-center w-16">إلزامي</th>
                        <th className="p-2 text-center w-24"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {editing.items.map((it, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2 text-xs text-slate-500">{idx + 1}</td>
                          <td className="p-2">
                            <Input
                              value={it.label}
                              onChange={(e) => updateItem(idx, { label: e.target.value })}
                              placeholder="مثال: وزن الكيس"
                              className="h-8"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={it.checkType}
                              onChange={(e) => updateItem(idx, { checkType: e.target.value })}
                              className="h-8 rounded border border-input bg-background px-2 text-sm w-full"
                            >
                              {CHECK_TYPES.map((c) => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <Input
                              value={it.expectedValue}
                              onChange={(e) => updateItem(idx, { expectedValue: e.target.value })}
                              placeholder="245-255 g"
                              className="h-8"
                            />
                          </td>
                          <td className="p-2">
                            <Input
                              type="number"
                              min={0}
                              value={it.sampleSize}
                              onChange={(e) => updateItem(idx, { sampleSize: e.target.value })}
                              className="h-8"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <input
                              type="checkbox"
                              checked={it.isRequired}
                              onChange={(e) => updateItem(idx, { isRequired: e.target.checked })}
                              className="h-4 w-4"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveItem(idx, -1)} disabled={idx === 0}>
                                <ChevronUp className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveItem(idx, 1)} disabled={idx === editing.items.length - 1}>
                                <ChevronDown className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-rose-600" onClick={() => removeItem(idx)}>
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
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
                <X className="h-4 w-4 me-1" />إلغاء
              </Button>
              <Button onClick={save} disabled={saving} data-testid="btn-save-tpl">
                <Save className="h-4 w-4 me-1" />{saving ? "جاري الحفظ..." : "حفظ"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {loading && !list ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : !list || list.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              <ShieldCheck className="h-10 w-10 mx-auto mb-2 opacity-40" />
              لا توجد قوالب بعد — اضغط "قالب جديد"
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100/60 text-xs">
                  <tr>
                    <th className="p-3 text-start">الاسم</th>
                    <th className="p-3 text-start">المنتج</th>
                    <th className="p-3 text-center">الحالة</th>
                    <th className="p-3 text-start">ملاحظات</th>
                    <th className="p-3 text-center w-24">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((tpl) => (
                    <tr key={tpl.id} className="border-t hover:bg-slate-50">
                      <td className="p-3 font-bold">{tpl.name}</td>
                      <td className="p-3">
                        {tpl.productItemId ? (
                          <Badge variant="secondary" className="gap-1">
                            <Package className="h-3 w-3" />
                            {itemLabel(tpl.productItemId) ?? `#${tpl.productItemId}`}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 text-slate-500">
                            <Globe2 className="h-3 w-3" />
                            عام
                          </Badge>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        {tpl.isActive ? (
                          <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">مفعّل</Badge>
                        ) : (
                          <Badge variant="outline" className="text-slate-500">معطّل</Badge>
                        )}
                      </td>
                      <td className="p-3 text-xs text-slate-500 max-w-[300px] truncate">{tpl.notes ?? "—"}</td>
                      <td className="p-3">
                        <div className="flex items-center justify-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => startEdit(tpl)}>
                            <Edit3 className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600" onClick={() => remove(tpl.id)}>
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
    </div>
  );
}
