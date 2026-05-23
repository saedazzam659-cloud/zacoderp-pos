import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import {
  Plus, Search, ShieldCheck, ShieldAlert, ShieldQuestion,
  Trash2, X, Save, Camera, Activity, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";

const API = import.meta.env.VITE_API_URL || "";

type QC = {
  id: number;
  orderId: number;
  stageId: number | null;
  checkType: string;
  result: "pass" | "fail" | "conditional";
  measuredValue: string | null;
  expectedValue: string | null;
  sampleSize: number | null;
  defectsFound: number;
  mediaUrl: string | null;
  notes: string | null;
  checkedByUserId: number | null;
  checkedAt: string;
  createdAt: string;
};
type Order = { id: number; orderNumber: string; productNameAr?: string | null };
type Stage = { id: number; orderId: number; sequence: number; nameAr: string; code: string; status?: string };
type Summary = { pass: number; fail: number; conditional: number; totalDefects: number; total: number };

const CHECK_TYPES: { value: string; label: string }[] = [
  { value: "visual",      label: "بصري" },
  { value: "weight",      label: "وزن" },
  { value: "temperature", label: "حرارة" },
  { value: "dimension",   label: "أبعاد" },
  { value: "barcode",     label: "باركود" },
  { value: "ai_camera",   label: "كاميرا ذكية" },
  { value: "other",       label: "أخرى" },
];

const EMPTY = {
  orderId: null as number | null,
  stageId: null as number | null,
  checkType: "visual",
  result: "pass" as QC["result"],
  measuredValue: "",
  expectedValue: "",
  sampleSize: "" as string,
  defectsFound: "0",
  mediaUrl: "",
  notes: "",
};

export default function QualityChecks() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<QC[] | null>(null);
  const [summary, setSummary] = useState<Summary>({ pass: 0, fail: 0, conditional: 0, totalDefects: 0, total: 0 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [filterOrderId, setFilterOrderId] = useState<number | null>(null);
  const [filterResult, setFilterResult] = useState<"" | QC["result"]>("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<typeof EMPTY | null>(null);
  const [saving, setSaving] = useState(false);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterOrderId) params.set("orderId", String(filterOrderId));
      if (filterResult) params.set("result", filterResult);
      const [listRes, sumRes] = await Promise.all([
        fetch(`${API}/api/production/quality-checks?${params}`, { headers }),
        fetch(`${API}/api/production/quality-checks/summary${filterOrderId ? `?orderId=${filterOrderId}` : ""}`, { headers }),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      setRows(await listRes.json());
      if (sumRes.ok) setSummary(await sumRes.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, headers, filterOrderId, filterResult, toast]);

  const loadLookups = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/api/production/orders?limit=500`, { headers });
      if (r.ok) {
        const data = await r.json();
        const arr: Order[] = Array.isArray(data) ? data : data?.rows ?? [];
        setOrders(arr);
      }
    } catch { /* silent */ }
  }, [token, headers]);
  useRefetchOnFocus(loadLookups);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadLookups(); }, [loadLookups]);

  // When editing.orderId changes, load that order's stages.
  useEffect(() => {
    if (!editing?.orderId) { setStages([]); return; }
    let active = true;
    fetch(`${API}/api/production/orders/${editing.orderId}/stages`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (active) setStages(Array.isArray(d) ? d : []); })
      .catch(() => { if (active) setStages([]); });
    return () => { active = false; };
  }, [editing?.orderId, headers]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) =>
      [r.checkType, r.measuredValue, r.expectedValue, r.notes, String(r.orderId)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)),
    );
  }, [rows, q]);

  function startNew() {
    setEditing({ ...EMPTY, orderId: filterOrderId });
  }

  async function save() {
    if (!editing) return;
    if (!editing.orderId) {
      toast({ title: "تنبيه", description: "اختر أمر الإنتاج", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        orderId: editing.orderId,
        stageId: editing.stageId,
        checkType: editing.checkType,
        result: editing.result,
        measuredValue: editing.measuredValue || null,
        expectedValue: editing.expectedValue || null,
        sampleSize: editing.sampleSize ? Number(editing.sampleSize) : null,
        defectsFound: Number(editing.defectsFound) || 0,
        mediaUrl: editing.mediaUrl || null,
        notes: editing.notes || null,
      };
      const r = await fetch(`${API}/api/production/quality-checks`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      const saved = await r.json().catch(() => ({}));
      if (saved?.stageNeedsReopen) {
        toast({
          title: "تم الحفظ — فحص فاشل",
          description:
            "هذا الفحص فاشل ومرتبط بمرحلة. يمكنك إعادة فتح المرحلة من زر «إعادة فتح» في الصف.",
        });
      } else {
        toast({ title: "تم الحفظ", description: "تم تسجيل فحص الجودة" });
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function reopenStage(id: number) {
    if (!confirm("هل تريد إعادة فتح المرحلة المرتبطة بهذا الفحص؟")) return;
    try {
      const r = await fetch(`${API}/api/production/quality-checks/${id}/reopen-stage`, {
        method: "POST", headers,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      const data = await r.json().catch(() => ({}));
      toast({
        title: data?.alreadyOpen ? "المرحلة مفتوحة بالفعل" : "تم إعادة فتح المرحلة",
        description: data?.alreadyOpen
          ? "لم يتم تغيير الحالة — المرحلة لم تكن مكتملة."
          : "حالة المرحلة → قيد التنفيذ.",
      });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(id: number) {
    if (!confirm("هل تريد حذف هذا الفحص؟")) return;
    try {
      const r = await fetch(`${API}/api/production/quality-checks/${id}`, {
        method: "DELETE", headers,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: "تم الحذف" });
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  const resultBadge = (r: QC["result"]) => {
    if (r === "pass")
      return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><ShieldCheck className="h-3 w-3 me-1" />ناجح</Badge>;
    if (r === "fail")
      return <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100"><ShieldAlert className="h-3 w-3 me-1" />فاشل</Badge>;
    return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100"><ShieldQuestion className="h-3 w-3 me-1" />مشروط</Badge>;
  };

  const checkTypeLabel = (t: string) => CHECK_TYPES.find((c) => c.value === t)?.label ?? t;
  const orderLabel = (id: number) => {
    const o = orders.find((x) => x.id === id);
    return o ? `${o.orderNumber}${o.productNameAr ? " — " + o.productNameAr : ""}` : `#${id}`;
  };

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-emerald-600" />
        <div>
          <h1 className="text-2xl font-bold">مراقبة الجودة</h1>
          <p className="text-sm text-slate-500">تسجيل ومتابعة فحوصات الجودة على أوامر الإنتاج ومراحلها</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><CardContent className="p-3"><div className="text-xs text-slate-500">إجمالي الفحوصات</div><div className="text-2xl font-bold">{summary.total}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-emerald-600">ناجح</div><div className="text-2xl font-bold text-emerald-700">{summary.pass}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-rose-600">فاشل</div><div className="text-2xl font-bold text-rose-700">{summary.fail}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-amber-600">مشروط</div><div className="text-2xl font-bold text-amber-700">{summary.conditional}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-slate-500">إجمالي العيوب</div><div className="text-2xl font-bold">{summary.totalDefects}</div></CardContent></Card>
      </div>

      {/* Toolbar */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Label className="text-xs">أمر الإنتاج</Label>
            <SearchCombobox
              value={filterOrderId ? String(filterOrderId) : ""}
              onValueChange={(v: string) => setFilterOrderId(v ? Number(v) : null)}
              items={[
                { value: "", label: "الكل" },
                ...orders.map((o) => ({ value: String(o.id), label: orderLabel(o.id) })),
              ]}
              placeholder="كل الأوامر"
            />
          </div>
          <div className="min-w-[140px]">
            <Label className="text-xs">النتيجة</Label>
            <select
              value={filterResult}
              onChange={(e) => setFilterResult(e.target.value as any)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">الكل</option>
              <option value="pass">ناجح</option>
              <option value="fail">فاشل</option>
              <option value="conditional">مشروط</option>
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <Label className="text-xs">بحث</Label>
            <div className="relative">
              <Search className="h-4 w-4 absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="نوع، قياس، ملاحظات..." className="ps-8" />
            </div>
          </div>
          <Button onClick={startNew} data-testid="btn-new-qc">
            <Plus className="h-4 w-4 me-1" />فحص جديد
          </Button>
        </CardContent>
      </Card>

      {/* Inline create form */}
      {editing && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">فحص جودة جديد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">أمر الإنتاج *</Label>
                <SearchCombobox
                  value={editing.orderId ? String(editing.orderId) : ""}
                  onValueChange={(v: string) => setEditing({ ...editing, orderId: v ? Number(v) : null, stageId: null })}
                  items={orders.map((o) => ({ value: String(o.id), label: orderLabel(o.id) }))}
                  placeholder="اختر الأمر..."
                />
              </div>
              <div>
                <Label className="text-xs">المرحلة (اختياري)</Label>
                <SearchCombobox
                  value={editing.stageId ? String(editing.stageId) : ""}
                  onValueChange={(v: string) => setEditing({ ...editing, stageId: v ? Number(v) : null })}
                  items={[
                    { value: "", label: "بدون مرحلة" },
                    ...stages.map((s) => ({ value: String(s.id), label: `${s.sequence}. ${s.nameAr}` })),
                  ]}
                  placeholder={editing.orderId ? "اختر المرحلة..." : "اختر الأمر أولاً"}
                  disabled={!editing.orderId}
                />
              </div>
              <div>
                <Label className="text-xs">نوع الفحص *</Label>
                <select
                  value={editing.checkType}
                  onChange={(e) => setEditing({ ...editing, checkType: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {CHECK_TYPES.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label className="text-xs">النتيجة *</Label>
                <div className="flex gap-1">
                  {(["pass", "fail", "conditional"] as const).map((r) => (
                    <Button
                      key={r}
                      size="sm"
                      type="button"
                      variant={editing.result === r ? "default" : "outline"}
                      className={editing.result === r ? (r === "pass" ? "bg-emerald-600 hover:bg-emerald-700" : r === "fail" ? "bg-rose-600 hover:bg-rose-700" : "bg-amber-600 hover:bg-amber-700") : ""}
                      onClick={() => setEditing({ ...editing, result: r })}
                    >
                      {r === "pass" ? "ناجح" : r === "fail" ? "فاشل" : "مشروط"}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs">القيمة المقاسة</Label>
                <Input value={editing.measuredValue} onChange={(e) => setEditing({ ...editing, measuredValue: e.target.value })} placeholder="مثال: 250 g" />
              </div>
              <div>
                <Label className="text-xs">القيمة المتوقعة</Label>
                <Input value={editing.expectedValue} onChange={(e) => setEditing({ ...editing, expectedValue: e.target.value })} placeholder="مثال: 245-255 g" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">حجم العينة</Label>
                  <Input type="number" min={0} value={editing.sampleSize} onChange={(e) => setEditing({ ...editing, sampleSize: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">عدد العيوب</Label>
                  <Input type="number" min={0} value={editing.defectsFound} onChange={(e) => setEditing({ ...editing, defectsFound: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">رابط الصورة / دليل (اختياري)</Label>
                <div className="relative">
                  <Camera className="h-4 w-4 absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
                  <Input value={editing.mediaUrl} onChange={(e) => setEditing({ ...editing, mediaUrl: e.target.value })} placeholder="https://..." className="ps-8" />
                </div>
              </div>
              <div>
                <Label className="text-xs">ملاحظات</Label>
                <Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="ملاحظات إضافية..." />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
                <X className="h-4 w-4 me-1" />إلغاء
              </Button>
              <Button onClick={save} disabled={saving} data-testid="btn-save-qc">
                <Save className="h-4 w-4 me-1" />{saving ? "جاري الحفظ..." : "حفظ"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {loading && !rows && (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (<Skeleton key={i} className="h-12 w-full" />))}
            </div>
          )}
          {filtered && filtered.length === 0 && (
            <div className="p-8 text-center text-slate-500">
              <Activity className="h-10 w-10 mx-auto mb-2 opacity-40" />
              لا توجد فحوصات مطابقة
            </div>
          )}
          {filtered && filtered.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900">
                  <tr className="text-start">
                    <th className="p-3 text-start">الأمر</th>
                    <th className="p-3 text-start">النوع</th>
                    <th className="p-3 text-start">النتيجة</th>
                    <th className="p-3 text-start">القياس</th>
                    <th className="p-3 text-start">المتوقع</th>
                    <th className="p-3 text-start">عينة/عيوب</th>
                    <th className="p-3 text-start">التاريخ</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-t" data-testid={`qc-row-${r.id}`}>
                      <td className="p-3 font-mono text-xs">{orderLabel(r.orderId)}</td>
                      <td className="p-3">{checkTypeLabel(r.checkType)}</td>
                      <td className="p-3">{resultBadge(r.result)}</td>
                      <td className="p-3">{r.measuredValue ?? "—"}</td>
                      <td className="p-3 text-slate-500">{r.expectedValue ?? "—"}</td>
                      <td className="p-3 text-xs">
                        {r.sampleSize != null ? `${r.sampleSize} / ` : ""}
                        <span className={r.defectsFound > 0 ? "text-rose-600 font-bold" : ""}>{r.defectsFound}</span>
                      </td>
                      <td className="p-3 text-xs text-slate-500">{new Date(r.checkedAt).toLocaleString()}</td>
                      <td className="p-3 text-end">
                        <div className="flex justify-end gap-1">
                          {r.result === "fail" && r.stageId != null && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => reopenStage(r.id)}
                              title="إعادة فتح المرحلة"
                              data-testid={`btn-reopen-stage-${r.id}`}
                            >
                              <RotateCcw className="h-4 w-4 text-amber-600" />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => remove(r.id)} data-testid={`btn-del-qc-${r.id}`}>
                            <Trash2 className="h-4 w-4 text-rose-600" />
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
