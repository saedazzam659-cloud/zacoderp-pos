import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Settings2, Save, Warehouse, Calculator, Sparkles } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

type Warehouse = { id: number; code?: string; nameAr?: string; nameEn?: string; name?: string };
type Account = { id: number; code: string; nameAr: string };
type CostCenter = { id: number; code: string; nameAr: string; isActive: boolean };
type Settings = {
  defaultRawWarehouseId: number | null;
  defaultFinishedWarehouseId: number | null;
  defaultCostCenter: string | null;
  defaultWipAccountId: number | null;
  defaultRawInventoryAccountId: number | null;
  defaultFinishedGoodsAccountId: number | null;
  defaultLaborAccountId: number | null;
  defaultOverheadAccountId: number | null;
  defaultVarianceAccountId: number | null;
  defaultWasteAccountId: number | null;
};

const EMPTY: Settings = {
  defaultRawWarehouseId: null,
  defaultFinishedWarehouseId: null,
  defaultCostCenter: null,
  defaultWipAccountId: null,
  defaultRawInventoryAccountId: null,
  defaultFinishedGoodsAccountId: null,
  defaultLaborAccountId: null,
  defaultOverheadAccountId: null,
  defaultVarianceAccountId: null,
  defaultWasteAccountId: null,
};

const ACCOUNT_FIELDS: Array<{ key: keyof Settings; label: string; hint: string }> = [
  { key: "defaultWipAccountId",            label: "حساب الإنتاج تحت التشغيل (WIP)", hint: "يُدفع عند صرف الخامات، يُجير عند استلام التام" },
  { key: "defaultRawInventoryAccountId",   label: "حساب مخزون الخامات",              hint: "يُجير عند صرف الخامات للإنتاج" },
  { key: "defaultFinishedGoodsAccountId",  label: "حساب البضاعة التامة (FG)",         hint: "يُدفع عند استلام المنتج النهائي" },
  { key: "defaultLaborAccountId",          label: "حساب الأجور المباشرة",            hint: "يُجير عند تحميل الأجور على WIP" },
  { key: "defaultOverheadAccountId",       label: "حساب التكاليف الصناعية غير المباشرة", hint: "يُجير عند تحميل OH على WIP" },
  { key: "defaultVarianceAccountId",       label: "حساب فروق التكلفة",                hint: "يستوعب فروق التكلفة الفعلية vs المخطط" },
  { key: "defaultWasteAccountId",          label: "حساب الهالك / الفاقد",             hint: "يُدفع بقيمة الهالك عند الإقفال" },
];

export default function ManufacturingSettings() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [data, setData] = useState<Settings>(EMPTY);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReasons, setAiReasons] = useState<Record<string, string>>({});

  // Lookups (warehouses, accounts, cost-centers) come from other screens.
  // Wrapped in useCallback so `useRefetchOnFocus` can re-run them when the
  // tab regains focus → newly-added accounts/warehouses appear here without
  // a manual refresh.
  const loadLookups = useCallback(async () => {
    if (!token) return;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [whR, acR, ccR] = await Promise.all([
        fetch(`${API}/api/inventory/warehouses`, { headers }),
        fetch(`${API}/api/accounts?limit=2000`, { headers }),
        fetch(`${API}/api/cost-centers`, { headers }),
      ]);
      const wh = whR.ok ? await whR.json() : [];
      const ac = acR.ok ? await acR.json() : [];
      const cc = ccR.ok ? await ccR.json() : [];
      setWarehouses(Array.isArray(wh) ? wh : (wh.rows ?? []));
      setAccounts(Array.isArray(ac) ? ac : (ac.rows ?? []));
      setCostCenters(Array.isArray(cc) ? cc : (cc.rows ?? []));
    } catch {
      /* silent — initial mount surfaces errors */
    }
  }, [token]);
  useRefetchOnFocus(loadLookups);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        await loadLookups();
        if (cancelled) return;
        const sR = await fetch(`${API}/api/production/manufacturing-settings`, { headers });
        const s = sR.ok ? await sR.json() : null;
        if (cancelled) return;
        if (s) setData({ ...EMPTY, ...s });
      } catch (e: any) {
        toast({ title: "خطأ", description: e?.message, variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, toast, loadLookups]);

  async function aiSuggest() {
    setAiBusy(true);
    try {
      const r = await fetch(`${API}/api/production/manufacturing-settings/ai-suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const sug = j.suggestions ?? {};
      const patch: Partial<Settings> = {};
      const reasons: Record<string, string> = {};
      let filled = 0;
      for (const f of ACCOUNT_FIELDS) {
        const v = sug[f.key];
        if (v && typeof v.id === "number") {
          (patch as any)[f.key] = v.id;
          filled++;
        }
        if (v?.reason) reasons[f.key] = v.reason;
      }
      setData(d => ({ ...d, ...patch }));
      setAiReasons(reasons);
      toast({
        title: filled > 0 ? `✓ تم اقتراح ${filled} من ${ACCOUNT_FIELDS.length} حسابات` : "لم يتمكن الذكاء الاصطناعي من اقتراح حسابات",
        description: filled > 0 ? "راجع الاقتراحات ثم اضغط حفظ." : "تأكد من وجود حسابات قابلة للترحيل في دليل الحسابات.",
      });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/production/manufacturing-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: "✓ تم حفظ إعدادات التصنيع" });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const accountOptions = useMemo(
    () => accounts.map(a => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}` })),
    [accounts],
  );

  function NumSelect({
    value, onChange, options, placeholder = "— غير محدد —",
  }: {
    value: number | null;
    onChange: (v: number | null) => void;
    options: { value: string; label: string }[];
    placeholder?: string;
  }) {
    return (
      <SearchCombobox
        value={value == null ? "" : String(value)}
        onValueChange={(v) => onChange(v === "" ? null : Number(v))}
        placeholder={placeholder}
        searchPlaceholder="ابحث…"
        items={[{ value: "", label: placeholder }, ...options]}
      />
    );
  }

  if (loading) {
    return <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-48" /><Skeleton className="h-64" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">إعدادات التصنيع</h1>
            <p className="text-sm text-slate-500">
              المخازن والحسابات الافتراضية تُطبَّق تلقائياً عند إنشاء أي أمر إنتاج جديد.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={aiSuggest}
            disabled={aiBusy || saving || accounts.length === 0}
            data-testid="btn-ai-suggest-mfg-accounts"
            className="border-violet-300 text-violet-700 hover:bg-violet-50"
          >
            <Sparkles className={`h-4 w-4 me-1 ${aiBusy ? "animate-pulse" : ""}`} />
            {aiBusy ? "يحلّل دليل الحسابات…" : "اقتراح الحسابات بالذكاء الاصطناعي"}
          </Button>
          <Button onClick={save} disabled={saving} data-testid="btn-save-mfg-settings">
            <Save className="h-4 w-4 me-1" />
            {saving ? "جاري الحفظ…" : "حفظ"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Warehouse className="h-4 w-4 text-violet-600" />
          <CardTitle className="text-base">المخازن ومركز التكلفة الافتراضي</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>مخزن الخامات الافتراضي</Label>
            <NumSelect
              value={data.defaultRawWarehouseId}
              onChange={(v) => setData(d => ({ ...d, defaultRawWarehouseId: v }))}
              options={warehouses.map(w => ({ value: String(w.id), label: `${w.code ? w.code + " — " : ""}${w.nameAr || w.nameEn || w.name || `#${w.id}`}` }))}
            />
          </div>
          <div>
            <Label>مخزن البضاعة التامة الافتراضي</Label>
            <NumSelect
              value={data.defaultFinishedWarehouseId}
              onChange={(v) => setData(d => ({ ...d, defaultFinishedWarehouseId: v }))}
              options={warehouses.map(w => ({ value: String(w.id), label: `${w.code ? w.code + " — " : ""}${w.nameAr || w.nameEn || w.name || `#${w.id}`}` }))}
            />
          </div>
          <div>
            <Label>مركز التكلفة الافتراضي</Label>
            <SearchCombobox
              value={data.defaultCostCenter ?? ""}
              onValueChange={(v) => setData(d => ({ ...d, defaultCostCenter: v === "" ? null : v }))}
              placeholder="— غير محدد —"
              searchPlaceholder="ابحث بالكود أو الاسم…"
              items={[
                { value: "", label: "— غير محدد —" },
                ...costCenters.filter(c => c.isActive).map(c => ({
                  value: c.code, code: c.code, label: c.nameAr,
                })),
              ]}
            />
            {costCenters.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">لا توجد مراكز تكلفة معرّفة بعد.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Calculator className="h-4 w-4 text-violet-600" />
          <CardTitle className="text-base">الحسابات المحاسبية الافتراضية للإنتاج</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {ACCOUNT_FIELDS.map(f => (
            <div key={String(f.key)}>
              <Label className="flex items-center gap-1">
                {f.label}
                {aiReasons[f.key as string] && (
                  <Sparkles className="h-3 w-3 text-violet-500" aria-label="مقترح بالذكاء الاصطناعي" />
                )}
              </Label>
              <NumSelect
                value={(data[f.key] as number | null) ?? null}
                onChange={(v) => setData(d => ({ ...d, [f.key]: v }))}
                options={accountOptions}
              />
              <p className="mt-1 text-xs text-slate-500">{f.hint}</p>
              {aiReasons[f.key as string] && (
                <p className="mt-1 text-xs text-violet-600">
                  <Sparkles className="inline h-3 w-3 me-1" />
                  {aiReasons[f.key as string]}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        <strong>ملاحظة:</strong> هذه الإعدادات تُستخدم فقط كقيم افتراضية عند إنشاء أمر إنتاج جديد.
        لا تتأثر أوامر الإنتاج القائمة، ويمكن تجاوز أي قيمة يدوياً داخل أي أمر.
      </div>
    </div>
  );
}
