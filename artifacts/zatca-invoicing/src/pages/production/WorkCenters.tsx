import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, Factory, Edit3, Trash2, Save, X, Power, PowerOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";

const API = import.meta.env.VITE_API_URL || "";

type WC = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  costCenterCode: string | null;
  laborRatePerHour: string;
  overheadRatePerHour: string;
  capacityHoursPerDay: string;
  defaultLaborAccountId: number | null;
  defaultOverheadAccountId: number | null;
  isActive: boolean;
  notes: string | null;
};
type Account = { id: number; code: string; nameAr: string };
type CostCenter = { id: number; code: string; nameAr: string; isActive: boolean };

const EMPTY: Omit<WC, "id"> = {
  code: "",
  nameAr: "",
  nameEn: "",
  costCenterCode: null,
  laborRatePerHour: "0",
  overheadRatePerHour: "0",
  capacityHoursPerDay: "8",
  defaultLaborAccountId: null,
  defaultOverheadAccountId: null,
  isActive: true,
  notes: "",
};

export default function WorkCenters() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<WC[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [editing, setEditing] = useState<(Omit<WC, "id"> & { id?: number }) | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const url = `${API}/api/production/work-centers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  // Lookups (accounts, cost-centers) come from other screens — refresh on focus
  // so newly-created entries show up without manual refresh.
  const loadLookups = useCallback(async () => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    try {
      const [ac, cc] = await Promise.all([
        fetch(`${API}/api/accounts?limit=2000`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/api/cost-centers`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setAccounts(Array.isArray(ac) ? ac : ac?.rows ?? []);
      setCostCenters(Array.isArray(cc) ? cc : cc?.rows ?? []);
    } catch {
      /* silent */
    }
  }, [token]);
  useRefetchOnFocus(loadLookups);

  useEffect(() => {
    if (!token) return;
    void load();
    void loadLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loadLookups]);

  useEffect(() => {
    const id = setTimeout(() => { if (token) void load(); }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function toggleActive(w: WC) {
    try {
      const r = await fetch(`${API}/api/production/work-centers/${w.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !w.isActive }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(w: WC) {
    if (!confirm(`حذف مركز العمل "${w.nameAr}"؟`)) return;
    try {
      const r = await fetch(`${API}/api/production/work-centers/${w.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: "✓ تم الحذف" });
      await load();
    } catch (e: any) {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
    }
  }

  async function save() {
    if (!editing) return;
    if (!editing.code.trim()) {
      toast({ title: "الكود مطلوب", variant: "destructive" });
      return;
    }
    if (!editing.nameAr.trim()) {
      toast({ title: "الاسم العربي مطلوب", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const isUpdate = !!editing.id;
      const r = await fetch(
        `${API}/api/production/work-centers${isUpdate ? `/${editing.id}` : ""}`,
        {
          method: isUpdate ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(editing),
        },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: isUpdate ? "✓ تم التحديث" : "✓ تم الإنشاء" });
      setEditing(null);
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);
  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}` })),
    [accounts],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <Factory className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">مراكز العمل</h1>
            <p className="text-sm text-slate-500">
              عرّف معدلات الأجور والتكاليف غير المباشرة لكل مركز عمل، وستُحسَب تكاليف الإنتاج تلقائياً =
              الساعات × المعدل.
            </p>
          </div>
        </div>
        <Button onClick={() => setEditing({ ...EMPTY })} data-testid="btn-new-work-center">
          <Plus className="h-4 w-4 me-1" />
          مركز عمل جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 max-w-md">
        <Search className="h-4 w-4 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث بالكود أو الاسم…"
          data-testid="input-search-work-centers"
        />
      </div>

      {editing && (
        <Card className="border-violet-300">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              {editing.id ? `تعديل مركز العمل #${editing.id}` : "مركز عمل جديد"}
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label="إغلاق">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label>الكود *</Label>
              <Input
                value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                placeholder="WC-CUT-01"
                data-testid="input-wc-code"
              />
            </div>
            <div>
              <Label>الاسم بالعربية *</Label>
              <Input
                value={editing.nameAr}
                onChange={(e) => setEditing({ ...editing, nameAr: e.target.value })}
                placeholder="خط القص"
                data-testid="input-wc-name-ar"
              />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input
                value={editing.nameEn ?? ""}
                onChange={(e) => setEditing({ ...editing, nameEn: e.target.value })}
                placeholder="Cutting Line"
              />
            </div>

            <div>
              <Label>معدل الأجور / ساعة</Label>
              <Input
                type="number"
                step="0.0001"
                min={0}
                value={editing.laborRatePerHour}
                onChange={(e) => setEditing({ ...editing, laborRatePerHour: e.target.value })}
                data-testid="input-wc-labor-rate"
              />
              <p className="text-xs text-slate-500 mt-1">يُضرب في ساعات الأمر لحساب أجور الإنتاج.</p>
            </div>
            <div>
              <Label>معدل التكاليف غير المباشرة / ساعة</Label>
              <Input
                type="number"
                step="0.0001"
                min={0}
                value={editing.overheadRatePerHour}
                onChange={(e) => setEditing({ ...editing, overheadRatePerHour: e.target.value })}
                data-testid="input-wc-overhead-rate"
              />
              <p className="text-xs text-slate-500 mt-1">يُضرب في ساعات الأمر لحساب OH.</p>
            </div>
            <div>
              <Label>طاقة العمل اليومية (ساعات)</Label>
              <Input
                type="number"
                step="0.25"
                min={0.25}
                value={editing.capacityHoursPerDay}
                onChange={(e) => setEditing({ ...editing, capacityHoursPerDay: e.target.value })}
                data-testid="input-wc-capacity"
              />
              <p className="text-xs text-slate-500 mt-1">للاستخدام في تخطيط الطاقة لاحقاً.</p>
            </div>

            <div>
              <Label>مركز التكلفة الافتراضي</Label>
              <SearchCombobox
                value={editing.costCenterCode ?? ""}
                onValueChange={(v) => setEditing({ ...editing, costCenterCode: v === "" ? null : v })}
                placeholder="— غير محدد —"
                searchPlaceholder="ابحث بالكود أو الاسم…"
                items={[
                  { value: "", label: "— غير محدد —" },
                  ...costCenters.filter((c) => c.isActive).map((c) => ({
                    value: c.code, code: c.code, label: c.nameAr,
                  })),
                ]}
              />
            </div>
            <div>
              <Label>حساب الأجور الافتراضي</Label>
              <SearchCombobox
                value={editing.defaultLaborAccountId == null ? "" : String(editing.defaultLaborAccountId)}
                onValueChange={(v) =>
                  setEditing({ ...editing, defaultLaborAccountId: v === "" ? null : Number(v) })
                }
                placeholder="— غير محدد —"
                searchPlaceholder="ابحث بالكود أو اسم الحساب…"
                items={[{ value: "", label: "— غير محدد —" }, ...accountOptions.map((o) => ({ value: o.value, label: o.label }))]}
              />
            </div>
            <div>
              <Label>حساب التكاليف غير المباشرة الافتراضي</Label>
              <SearchCombobox
                value={editing.defaultOverheadAccountId == null ? "" : String(editing.defaultOverheadAccountId)}
                onValueChange={(v) =>
                  setEditing({ ...editing, defaultOverheadAccountId: v === "" ? null : Number(v) })
                }
                placeholder="— غير محدد —"
                searchPlaceholder="ابحث بالكود أو اسم الحساب…"
                items={[{ value: "", label: "— غير محدد —" }, ...accountOptions.map((o) => ({ value: o.value, label: o.label }))]}
              />
            </div>

            <div className="md:col-span-2 lg:col-span-3">
              <Label>ملاحظات</Label>
              <Input
                value={editing.notes ?? ""}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="اختياري"
              />
            </div>

            <div className="md:col-span-2 lg:col-span-3 flex items-center justify-between pt-2 border-t">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.isActive}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                />
                نشط
              </label>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
                <Button onClick={save} disabled={saving} data-testid="btn-save-work-center">
                  <Save className="h-4 w-4 me-1" />
                  {saving ? "جارٍ الحفظ…" : "حفظ"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && rows == null ? (
        <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-slate-500">
          لا توجد مراكز عمل بعد. اضغط <strong>«مركز عمل جديد»</strong> لإضافة أول مركز.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-start">الكود</th>
                <th className="p-2 text-start">الاسم</th>
                <th className="p-2 text-end">أجور / ساعة</th>
                <th className="p-2 text-end">OH / ساعة</th>
                <th className="p-2 text-end">طاقة يومية</th>
                <th className="p-2 text-start">مركز التكلفة</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-end">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id} className="border-t hover:bg-slate-50">
                  <td className="p-2 font-mono text-xs">{w.code}</td>
                  <td className="p-2 font-medium">{w.nameAr}{w.nameEn ? ` — ${w.nameEn}` : ""}</td>
                  <td className="p-2 text-end">{Number(w.laborRatePerHour).toLocaleString()}</td>
                  <td className="p-2 text-end">{Number(w.overheadRatePerHour).toLocaleString()}</td>
                  <td className="p-2 text-end">{Number(w.capacityHoursPerDay).toLocaleString()}</td>
                  <td className="p-2 text-xs">{w.costCenterCode || "—"}</td>
                  <td className="p-2 text-center">
                    {w.isActive
                      ? <Badge className="bg-emerald-100 text-emerald-700">نشط</Badge>
                      : <Badge className="bg-slate-200 text-slate-600">معطّل</Badge>}
                  </td>
                  <td className="p-2 text-end">
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ ...w, nameEn: w.nameEn ?? "", notes: w.notes ?? "" })} title="تعديل">
                        <Edit3 className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(w)} title={w.isActive ? "تعطيل" : "تنشيط"}>
                        {w.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(w)} title="حذف" className="text-red-600">
                        <Trash2 className="h-4 w-4" />
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
  );
}
