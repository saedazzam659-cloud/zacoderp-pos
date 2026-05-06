import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Settings2, Save, Warehouse, Calculator } from "lucide-react";

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

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [whR, acR, ccR, sR] = await Promise.all([
          fetch(`${API}/api/inventory/warehouses`, { headers }),
          fetch(`${API}/api/accounts?limit=2000`, { headers }),
          fetch(`${API}/api/cost-centers`, { headers }),
          fetch(`${API}/api/production/manufacturing-settings`, { headers }),
        ]);
        const wh = whR.ok ? await whR.json() : [];
        const ac = acR.ok ? await acR.json() : [];
        const cc = ccR.ok ? await ccR.json() : [];
        const s  = sR.ok  ? await sR.json()  : null;
        if (cancelled) return;
        setWarehouses(Array.isArray(wh) ? wh : (wh.rows ?? []));
        setAccounts(Array.isArray(ac) ? ac : (ac.rows ?? []));
        setCostCenters(Array.isArray(cc) ? cc : (cc.rows ?? []));
        if (s) setData({ ...EMPTY, ...s });
      } catch (e: any) {
        toast({ title: "خطأ", description: e?.message, variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, toast]);

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
      <Select
        value={value == null ? "__none__" : String(value)}
        onValueChange={(v) => onChange(v === "__none__" ? null : Number(v))}
      >
        <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{placeholder}</SelectItem>
          {options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
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
        <Button onClick={save} disabled={saving} data-testid="btn-save-mfg-settings">
          <Save className="h-4 w-4 me-1" />
          {saving ? "جاري الحفظ…" : "حفظ"}
        </Button>
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
            <Select
              value={data.defaultCostCenter == null || data.defaultCostCenter === "" ? "__none__" : data.defaultCostCenter}
              onValueChange={(v) => setData(d => ({ ...d, defaultCostCenter: v === "__none__" ? null : v }))}
            >
              <SelectTrigger><SelectValue placeholder="— غير محدد —" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— غير محدد —</SelectItem>
                {costCenters
                  .filter(c => c.isActive)
                  .map(c => (
                    <SelectItem key={c.id} value={c.code}>
                      {c.code} — {c.nameAr}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
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
              <Label>{f.label}</Label>
              <NumSelect
                value={(data[f.key] as number | null) ?? null}
                onChange={(v) => setData(d => ({ ...d, [f.key]: v }))}
                options={accountOptions}
              />
              <p className="mt-1 text-xs text-slate-500">{f.hint}</p>
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
