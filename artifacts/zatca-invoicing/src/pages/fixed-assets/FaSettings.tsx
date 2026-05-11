import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings2, Save, Info, Sparkles, CheckCircle2, PlusCircle, Loader2, Wand2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

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

  // ── AI auto-seed: matches existing accounts by Arabic keywords + creates
  // any missing ones using canonical IFRS codes, then patches the company
  // mapping in one round-trip. UI shows a per-field manifest so the user
  // can audit what was matched vs what was newly created.
  type SeedResult = {
    field: string; label: string;
    action: "matched" | "created";
    accountId: number; code: string; nameAr: string;
    reason: string;
  };
  type SeedResponse = {
    ok: boolean;
    summary: { matched: number; created: number; total: number };
    results: SeedResult[];
    mapping: Record<string, number>;
  };
  const [aiOpen, setAiOpen] = useState(false);
  const [aiResult, setAiResult] = useState<SeedResponse | null>(null);

  const aiSeed = useMutation<SeedResponse, Error, void>({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets-ai/seed-fa-accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ companyId: cid }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data) => {
      setAiResult(data);
      setAiOpen(true);
      // Reflect new IDs into local form state immediately so the dropdowns
      // show the AI selection without waiting for a refetch round-trip.
      setMaps(m => ({ ...m, ...(data.mapping as Partial<CompanyMaps>) }));
      qc.invalidateQueries({ queryKey: ["accounts", cid] });
      qc.invalidateQueries({ queryKey: ["company", cid] });
      toast({
        title: "تم الإعداد التلقائي بنجاح",
        description: `تطابق ${data.summary.matched} حساب • إنشاء ${data.summary.created} حساب جديد`,
      });
    },
    onError: (e) => toast({ title: "فشل الإعداد التلقائي", description: e.message, variant: "destructive" }),
  });

  const isLoading = accountsQ.isLoading || companyQ.isLoading;

  return (
    <div className="container mx-auto p-4 max-w-4xl" dir="rtl">
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-3">
          <Settings2 className="h-6 w-6 text-emerald-600" />
          <h1 className="text-2xl font-bold">إعدادات حسابات الأصول الثابتة</h1>
        </div>
        <Button
          onClick={() => aiSeed.mutate()}
          disabled={aiSeed.isPending || isLoading || !cid}
          className="gap-2 relative overflow-hidden bg-gradient-to-l from-violet-600 via-fuchsia-600 to-pink-600 hover:from-violet-700 hover:via-fuchsia-700 hover:to-pink-700 text-white shadow-lg shadow-fuchsia-500/30 border-0"
        >
          {aiSeed.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {aiSeed.isPending ? "جارٍ الإعداد بالذكاء الاصطناعي…" : "إعداد تلقائي بالذكاء الاصطناعي"}
        </Button>
      </div>

      <Card className="border-fuchsia-200 bg-gradient-to-l from-fuchsia-50 via-pink-50 to-violet-50 mb-4">
        <CardContent className="pt-4 text-sm text-fuchsia-900 leading-relaxed flex gap-2">
          <Wand2 className="h-4 w-4 mt-0.5 shrink-0 text-fuchsia-600" />
          <div>
            <strong>الإعداد التلقائي الذكي:</strong> اضغط الزر أعلاه ليقوم النظام بـ
            <strong className="mx-1">البحث الذكي</strong> في دليل حساباتك عن الحسابات الستة المطلوبة،
            وفي حال عدم وجودها سيتم
            <strong className="mx-1">إنشاؤها تلقائياً</strong>
            بأكواد قياسية متوافقة مع
            <strong className="mx-1">معيار IAS 16 / IFRS</strong>
            (1210 تكلفة • 1280 مجمع إهلاك • 5400 مصروف إهلاك • 1290 وسيط • 4910 أرباح بيع • 5450 خسائر بيع)
            ثم ربطها بالشركة بنقرة واحدة.
          </div>
        </CardContent>
      </Card>

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

      {/* AI Auto-Seed result dialog ─────────────────────────────────────── */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent dir="rtl" className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <Sparkles className="h-5 w-5 text-fuchsia-600" />
              نتيجة الإعداد التلقائي بالذكاء الاصطناعي
            </DialogTitle>
            <DialogDescription>
              تم تجهيز الحسابات الستة وربطها بالشركة. يمكنك مراجعة كل خانة بالأسفل وتعديلها يدوياً إذا رغبت.
            </DialogDescription>
          </DialogHeader>

          {aiResult && (
            <div className="space-y-3">
              {/* Summary chips */}
              <div className="flex gap-2 flex-wrap">
                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 gap-1.5 text-sm py-1 px-3">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  مُطابَق: {aiResult.summary.matched}
                </Badge>
                <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100 gap-1.5 text-sm py-1 px-3">
                  <PlusCircle className="h-3.5 w-3.5" />
                  مُنشأ جديد: {aiResult.summary.created}
                </Badge>
                <Badge variant="outline" className="text-sm py-1 px-3">
                  الإجمالي: {aiResult.summary.total}
                </Badge>
              </div>

              {/* Per-field results */}
              <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                {aiResult.results.map((r) => {
                  const isCreated = r.action === "created";
                  return (
                    <div
                      key={r.field}
                      className={`rounded-lg border p-3 ${
                        isCreated
                          ? "border-violet-200 bg-violet-50/60"
                          : "border-emerald-200 bg-emerald-50/60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="font-semibold text-sm">{r.label}</div>
                        <Badge
                          className={`gap-1 ${
                            isCreated
                              ? "bg-violet-600 hover:bg-violet-600 text-white"
                              : "bg-emerald-600 hover:bg-emerald-600 text-white"
                          }`}
                        >
                          {isCreated ? <PlusCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                          {isCreated ? "تم الإنشاء" : "تم الربط"}
                        </Badge>
                      </div>
                      <div className="text-sm text-foreground">
                        <span className="font-mono text-xs bg-background border px-1.5 py-0.5 rounded mx-1">
                          {r.code}
                        </span>
                        {r.nameAr}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{r.reason}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setAiOpen(false)} className="gap-2">
              <CheckCircle2 className="h-4 w-4" />
              تم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
