import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings2, Save, Info } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Account = { id: number; code: string; nameAr: string; isPosting: boolean };
type CompanyMaps = {
  faAssetCostAccountId:           number | null;
  faAccumDepreciationAccountId:   number | null;
  faDepreciationExpenseAccountId: number | null;
  faAcquisitionClearingAccountId: number | null;
  faDisposalGainAccountId:        number | null;
  faDisposalLossAccountId:        number | null;
};

const FIELDS: { key: keyof CompanyMaps; label: string; hint: string; defaultType: "asset" | "expense" | "revenue" }[] = [
  { key: "faAssetCostAccountId",           label: "حساب تكلفة الأصل",        hint: "مدين عند الاقتناء + دائن عند الاستبعاد. عادةً حساب أصل ثابت (مثل سيارات/معدات)", defaultType: "asset" },
  { key: "faAccumDepreciationAccountId",   label: "حساب مجمع الإهلاك",       hint: "دائن عند الإهلاك الشهري + مدين عند الاستبعاد. حساب مقابل الأصل (Contra-Asset)", defaultType: "asset" },
  { key: "faDepreciationExpenseAccountId", label: "حساب مصروف الإهلاك",      hint: "مدين عند الإهلاك الشهري. حساب مصروف تشغيلي", defaultType: "expense" },
  { key: "faAcquisitionClearingAccountId", label: "حساب وسيط الاقتناء/الاستبعاد", hint: "يستخدم عند شراء أصل بدون تحديد صندوق/بنك (شراء آجل) أو استبعاد بدون تحديد جهة استلام السعر", defaultType: "asset" },
  { key: "faDisposalGainAccountId",        label: "حساب أرباح بيع الأصول",   hint: "دائن عندما يتجاوز سعر البيع القيمة الدفترية. حساب إيراد آخر", defaultType: "revenue" },
  { key: "faDisposalLossAccountId",        label: "حساب خسائر بيع الأصول",   hint: "مدين عندما يقل سعر البيع عن القيمة الدفترية. حساب مصروف",   defaultType: "expense" },
];

export default function FaSettings() {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.company?.id ?? null;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const accountsQ = useQuery<Account[]>({
    queryKey: ["accounts", cid],
    enabled: !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const all = await r.json();
      return (all as Account[]).filter(a => a.isPosting);
    },
  });

  const companyQ = useQuery<any>({
    queryKey: ["company", cid],
    enabled: !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies/${cid}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const [maps, setMaps] = useState<CompanyMaps>({
    faAssetCostAccountId: null, faAccumDepreciationAccountId: null,
    faDepreciationExpenseAccountId: null, faAcquisitionClearingAccountId: null,
    faDisposalGainAccountId: null, faDisposalLossAccountId: null,
  });

  useEffect(() => {
    const c = companyQ.data;
    if (!c) return;
    setMaps({
      faAssetCostAccountId:           c.faAssetCostAccountId ?? null,
      faAccumDepreciationAccountId:   c.faAccumDepreciationAccountId ?? null,
      faDepreciationExpenseAccountId: c.faDepreciationExpenseAccountId ?? null,
      faAcquisitionClearingAccountId: c.faAcquisitionClearingAccountId ?? null,
      faDisposalGainAccountId:        c.faDisposalGainAccountId ?? null,
      faDisposalLossAccountId:        c.faDisposalLossAccountId ?? null,
    });
  }, [companyQ.data]);

  const accounts = accountsQ.data ?? [];
  const accountsById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH", headers, body: JSON.stringify(maps),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: "تم حفظ خرائط حسابات الأصول الثابتة" });
      qc.invalidateQueries({ queryKey: ["company", cid] });
    },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: e.message, variant: "destructive" }),
  });

  const isLoading = accountsQ.isLoading || companyQ.isLoading;

  return (
    <div className="container mx-auto p-4 max-w-4xl" dir="rtl">
      <div className="flex items-center gap-3 mb-6">
        <Settings2 className="h-6 w-6 text-emerald-600" />
        <h1 className="text-2xl font-bold">إعدادات حسابات الأصول الثابتة</h1>
      </div>

      <Card className="border-emerald-200 bg-emerald-50/50 mb-4">
        <CardContent className="pt-4 text-sm text-emerald-900 leading-relaxed flex gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            هذه الإعدادات تحدد الحسابات الافتراضية المستخدمة في القيود الآلية لـ
            <strong className="mx-1">اقتناء الأصول</strong>،
            <strong className="mx-1">الإهلاك الشهري</strong>،
            و<strong className="mx-1">استبعاد الأصول</strong> (وفقاً لمعيار
            <strong className="mx-1">IAS 16</strong>). يمكن تجاوز حسابات
            التكلفة ومجمع الإهلاك ومصروف الإهلاك من شاشة <strong>فئات الأصول</strong>
            لكل فئة على حدة. التحويل التلقائي للقيود يمكن إيقافه من
            <strong className="mx-1">الإعدادات العامة → وضع الترحيل المحاسبي</strong>.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>الحسابات الافتراضية على مستوى الشركة</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading && <div className="text-muted-foreground">جارٍ التحميل…</div>}
          {!isLoading && FIELDS.map(f => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm font-semibold">{f.label}</Label>
              <select
                className="w-full border rounded-md px-3 py-2 bg-background"
                value={maps[f.key] ?? ""}
                onChange={(e) => setMaps(m => ({ ...m, [f.key]: e.target.value ? Number(e.target.value) : null }))}
              >
                <option value="">— غير محدد —</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{f.hint}</p>
              {maps[f.key] && !accountsById.has(maps[f.key]!) && (
                <p className="text-xs text-amber-700">⚠ الحساب المحفوظ غير موجود في دليل الحسابات الحالي</p>
              )}
            </div>
          ))}

          <div className="flex justify-end pt-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending || isLoading} className="gap-2">
              <Save className="h-4 w-4" />
              {save.isPending ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
