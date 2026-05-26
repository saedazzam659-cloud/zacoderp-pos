// SuperAdmin — AI Controls.
//
// Two-panel screen for managing per-company AI feature access:
//   ▸ Top: company picker + "kill all / restore" actions.
//   ▸ Body: a table of every catalog feature with toggle + daily/monthly
//           limit inputs + today's usage counter.
//   ▸ Side: recent blocked attempts across all tenants (signal for abuse).
//
// All writes go through /api/admin/ai-controls (SuperAdmin-only). Setting
// the company to "system defaults" lets the SA set the baseline for any
// company that has no explicit override row.
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Brain, Save, Loader2, ShieldOff, ShieldCheck, AlertTriangle, Activity,
  Globe, Building2, Sparkles, DollarSign, Filter,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Setting = {
  featureKey:   string;
  labelAr:      string;
  tier:         "free" | "paid";
  catalogDaily: number;
  isEnabled:    boolean;
  dailyLimit:   number | null;
  monthlyLimit: number | null;
  note:         string | null;
  source:       "company" | "system" | "catalog";
  updatedAt:    string | null;
};
type Company = { id: number; nameAr: string | null; nameEn: string | null };

export default function AiControls() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = useMemo(() => ({ "Content-Type": "application/json" }), []);
  // null = editing system defaults; number = editing a specific company.
  const [companyId, setCompanyId] = useState<number | null>(null);
  // Drafts keyed by company id (using "__system__" for the null/system case)
  // so switching between companies preserves unsaved edits in each one.
  // The "dirty" set tracks which contexts have local changes so we don't
  // overwrite them on a background refetch.
  const [draftsByCtx, setDraftsByCtx] = useState<Record<string, Record<string, Setting>>>({});
  const [dirtyCtx, setDirtyCtx] = useState<Set<string>>(new Set());
  // UI filter: when "paid", hide free/rule-based features so the SA can
  // focus on the rows that actually cost money.
  const [tierFilter, setTierFilter] = useState<"all" | "paid" | "free">("all");
  const ctxKey = companyId == null ? "__system__" : String(companyId);
  const draft = draftsByCtx[ctxKey] ?? {};

  const companiesQ = useQuery<{ companies: Company[] }>({
    queryKey: ["ai-controls", "companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/ai-controls/companies`, { credentials: "include" });
      if (!r.ok) throw new Error("failed to load companies");
      return r.json();
    },
  });

  const settingsQ = useQuery<{ companyId: number | null; settings: Setting[] }>({
    queryKey: ["ai-controls", "settings", companyId],
    queryFn: async () => {
      const url = companyId == null
        ? `${API}/api/admin/ai-controls/settings`
        : `${API}/api/admin/ai-controls/settings?companyId=${companyId}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("failed to load settings");
      return r.json();
    },
  });

  const usageQ = useQuery<{ today: any[]; month: any[] }>({
    queryKey: ["ai-controls", "usage", companyId],
    queryFn: async () => {
      const url = companyId == null
        ? `${API}/api/admin/ai-controls/usage?days=30`
        : `${API}/api/admin/ai-controls/usage?days=30&companyId=${companyId}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("failed to load usage");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const blockedQ = useQuery<{ entries: any[] }>({
    queryKey: ["ai-controls", "blocked"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/ai-controls/recent-blocked?limit=20`, { credentials: "include" });
      if (!r.ok) throw new Error("failed to load blocked log");
      return r.json();
    },
    refetchInterval: 60_000,
  });

  // Hydrate the draft for the active context from the server response, but
  // only when that context is NOT dirty — never clobber in-progress edits.
  useEffect(() => {
    if (!settingsQ.data?.settings) return;
    const incomingCtx = settingsQ.data.companyId == null ? "__system__" : String(settingsQ.data.companyId);
    if (dirtyCtx.has(incomingCtx)) return;
    const m: Record<string, Setting> = {};
    for (const s of settingsQ.data.settings) m[s.featureKey] = { ...s };
    setDraftsByCtx(d => ({ ...d, [incomingCtx]: m }));
  }, [settingsQ.data, dirtyCtx]);

  const usageMap = useMemo(() => {
    const today: Record<string, number> = {};
    const month: Record<string, number> = {};
    for (const u of usageQ.data?.today ?? []) today[u.feature_key] = Number(u.allowed || 0);
    for (const u of usageQ.data?.month ?? []) month[u.feature_key] = Number(u.allowed || 0);
    return { today, month };
  }, [usageQ.data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/ai-controls/settings`, {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({
          companyId,
          settings: Object.values(draft).map(s => ({
            featureKey:   s.featureKey,
            isEnabled:    s.isEnabled,
            dailyLimit:   s.dailyLimit,
            monthlyLimit: s.monthlyLimit,
            note:         s.note,
          })),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "save failed");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: "تم تحديث إعدادات الذكاء الاصطناعي بنجاح." });
      // Clear dirty flag for the saved context so the next refetch can
      // refresh the displayed source/updatedAt timestamps.
      setDirtyCtx(s => { const n = new Set(s); n.delete(ctxKey); return n; });
      qc.invalidateQueries({ queryKey: ["ai-controls"] });
    },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: e?.message, variant: "destructive" }),
  });

  const killSwitchMut = useMutation({
    mutationFn: async () => {
      if (companyId == null) throw new Error("اختر شركة محددة أولاً");
      const r = await fetch(`${API}/api/admin/ai-controls/disable-all`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ companyId, note: `إيقاف جماعي بواسطة ${user?.email || "SA"}` }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم إيقاف كل الميزات", description: "لن تتمكن الشركة من استخدام أي ميزة AI." });
      qc.invalidateQueries({ queryKey: ["ai-controls"] });
    },
  });

  const disablePaidMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/ai-controls/disable-paid`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({
          companyId,
          note: `إيقاف الميزات المدفوعة بواسطة ${user?.email || "SA"}`,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: (d: any) => {
      toast({
        title: "تم إيقاف الميزات المدفوعة",
        description: companyId == null
          ? `أصبحت ${d.count} ميزة مدفوعة موقوفة افتراضياً للنظام. الميزات المجانية لم تتأثر.`
          : `أوقفنا ${d.count} ميزة مدفوعة لهذه الشركة. الميزات المجانية (مكتبة المعرفة) لا تزال تعمل.`,
      });
      setDirtyCtx(s => { const n = new Set(s); n.delete(ctxKey); return n; });
      qc.invalidateQueries({ queryKey: ["ai-controls"] });
    },
    onError: (e: any) => toast({ title: "فشل", description: e?.message, variant: "destructive" }),
  });

  const restoreMut = useMutation({
    mutationFn: async () => {
      if (companyId == null) throw new Error("اختر شركة محددة أولاً");
      const r = await fetch(`${API}/api/admin/ai-controls/enable-all`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ companyId }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تمت إعادة الضبط", description: "حُذفت جميع التخصيصات؛ الشركة تعود لإعدادات النظام الافتراضية." });
      qc.invalidateQueries({ queryKey: ["ai-controls"] });
    },
  });

  // Local edit helpers — every keystroke updates the draft only and marks
  // the active context dirty so background refetches can't overwrite edits.
  const patch = (key: string, change: Partial<Setting>) => {
    setDraftsByCtx(d => ({
      ...d,
      [ctxKey]: { ...(d[ctxKey] ?? {}), [key]: { ...(d[ctxKey]?.[key] ?? {} as Setting), ...change } },
    }));
    setDirtyCtx(s => { const n = new Set(s); n.add(ctxKey); return n; });
  };

  if (!user || user.role !== "superadmin") {
    return (
      <div className="p-8 text-center">
        <ShieldOff className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-lg font-semibold">هذه الشاشة للمشرف العام فقط.</p>
      </div>
    );
  }

  const allDisabled = Object.values(draft).every(s => !s.isEnabled);
  const paidCount = Object.values(draft).filter(s => s.tier === "paid").length;
  const paidEnabledCount = Object.values(draft).filter(s => s.tier === "paid" && s.isEnabled).length;
  const visibleSettings = Object.values(draft).filter(s =>
    tierFilter === "all" ? true : s.tier === tierFilter,
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      {/* ─── Header ─── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="h-6 w-6 text-fuchsia-600" />
            التحكم في الذكاء الاصطناعي
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تشغيل/إيقاف ميزات الذكاء الاصطناعي وتحديد الحدود اليومية والشهرية لكل شركة.
          </p>
        </div>
      </div>

      {/* ─── Company picker + actions ─── */}
      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <Label className="text-sm font-semibold">السياق:</Label>
          <Select
            value={companyId == null ? "__system__" : String(companyId)}
            onValueChange={v => setCompanyId(v === "__system__" ? null : Number(v))}
          >
            <SelectTrigger className="w-[320px]">
              <SelectValue placeholder="اختر..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system__">
                <span className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  الإعدادات الافتراضية للنظام (تنطبق على كل شركة بدون تخصيص)
                </span>
              </SelectItem>
              {(companiesQ.data?.companies ?? []).map(c => (
                <SelectItem key={c.id} value={String(c.id)}>
                  <span className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    {c.nameAr || c.nameEn || `شركة #${c.id}`} <span className="text-muted-foreground">(#{c.id})</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          {/* Disable paid only — available in BOTH system & per-company contexts */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={disablePaidMut.isPending || paidEnabledCount === 0}
                className="border-amber-500 text-amber-700 hover:bg-amber-50"
              >
                <DollarSign className="h-4 w-4 me-1" />
                إيقاف المدفوعة فقط ({paidEnabledCount}/{paidCount})
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>إيقاف الميزات المدفوعة فقط</AlertDialogTitle>
                <AlertDialogDescription>
                  {companyId == null
                    ? "سيتم إيقاف كل ميزات الذكاء الاصطناعي التي تستدعي خدمات مدفوعة (Gemini / OpenAI) كافتراضي للنظام كله. الشركات الجديدة ستبدأ بدون أي تكلفة عليك. الميزات المجانية (مكتبة المعرفة المحلية، اقتراحات الحسابات) ستظل تعمل بشكل طبيعي."
                    : "سيتم إيقاف كل ميزات الذكاء الاصطناعي المدفوعة لهذه الشركة فقط. المساعد المحاسبي سيستخدم مكتبة المعرفة المحلية (IFRS / GAAP / ZATCA) مجاناً، واقتراحات الحسابات ستظل تعمل."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                <AlertDialogAction onClick={() => disablePaidMut.mutate()}>تأكيد</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {companyId != null && (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={killSwitchMut.isPending}>
                    <ShieldOff className="h-4 w-4 me-1" /> إيقاف كل الميزات لهذه الشركة
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>هل أنت متأكد؟</AlertDialogTitle>
                    <AlertDialogDescription>
                      ستُوقَف جميع ميزات الذكاء الاصطناعي لهذه الشركة فوراً. لن يتمكن أي مستخدم من المساعد المحاسبي أو الاقتراحات أو التحليلات أو التوليد. يمكنك التراجع لاحقاً.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>إلغاء</AlertDialogCancel>
                    <AlertDialogAction onClick={() => killSwitchMut.mutate()}>تأكيد الإيقاف</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={restoreMut.isPending}>
                    <ShieldCheck className="h-4 w-4 me-1" /> إعادة الضبط للافتراضي
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>إعادة ضبط الشركة</AlertDialogTitle>
                    <AlertDialogDescription>
                      سيتم حذف جميع التخصيصات لهذه الشركة، وستعود لاستخدام الإعدادات الافتراضية للنظام. هل تريد المتابعة؟
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>إلغاء</AlertDialogCancel>
                    <AlertDialogAction onClick={() => restoreMut.mutate()}>تأكيد</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          <Button
            size="sm"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !Object.keys(draft).length}
            className="bg-fuchsia-600 hover:bg-fuchsia-700"
          >
            {saveMut.isPending
              ? <Loader2 className="h-4 w-4 me-1 animate-spin" />
              : <Save className="h-4 w-4 me-1" />}
            حفظ التغييرات
          </Button>
        </CardContent>
      </Card>

      {allDisabled && companyId != null && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 flex items-center gap-2 text-red-800 text-sm">
          <AlertTriangle className="h-4 w-4" />
          جميع ميزات الذكاء الاصطناعي مُوقفة حالياً لهذه الشركة.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* ─── Settings table ─── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-fuchsia-600" />
                  ميزات الذكاء الاصطناعي
                </CardTitle>
                <CardDescription>
                  ضع الحد بصفر = إيقاف فعلي. اتركه فارغاً = بلا حد. الافتراضي مطبّق من النظام عند غياب التخصيص.
                </CardDescription>
              </div>
              <div className="flex items-center gap-1 text-xs">
                <Filter className="h-3.5 w-3.5 text-muted-foreground me-1" />
                <Button
                  size="sm" variant={tierFilter === "all"  ? "default" : "outline"}
                  className="h-7 px-2 text-xs" onClick={() => setTierFilter("all")}
                >الكل ({Object.values(draft).length})</Button>
                <Button
                  size="sm" variant={tierFilter === "paid" ? "default" : "outline"}
                  className="h-7 px-2 text-xs" onClick={() => setTierFilter("paid")}
                >💰 مدفوعة ({paidCount})</Button>
                <Button
                  size="sm" variant={tierFilter === "free" ? "default" : "outline"}
                  className="h-7 px-2 text-xs" onClick={() => setTierFilter("free")}
                >🟢 مجانية ({Object.values(draft).length - paidCount})</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {settingsQ.isLoading ? (
              <div className="p-8 text-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mx-auto" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="text-xs text-muted-foreground">
                      <th className="text-start p-3">الميزة</th>
                      <th className="text-center p-3 w-20">التصنيف</th>
                      <th className="text-center p-3 w-20">الحالة</th>
                      <th className="text-center p-3 w-28">الحد اليومي</th>
                      <th className="text-center p-3 w-28">الحد الشهري</th>
                      <th className="text-center p-3 w-32">استهلاك اليوم</th>
                      <th className="text-center p-3 w-24">المصدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSettings.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-xs text-muted-foreground italic">
                          لا توجد ميزات مطابقة للفلتر الحالي.
                        </td>
                      </tr>
                    )}
                    {visibleSettings.map(s => {
                      const usedToday = usageMap.today[s.featureKey] || 0;
                      const overDaily = s.dailyLimit != null && usedToday >= s.dailyLimit;
                      return (
                        <tr key={s.featureKey} className="border-t hover:bg-muted/20">
                          <td className="p-3">
                            <div className="font-medium">{s.labelAr}</div>
                            <code className="text-[10px] text-muted-foreground">{s.featureKey}</code>
                          </td>
                          <td className="p-3 text-center">
                            {s.tier === "paid" ? (
                              <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px] hover:bg-amber-100">
                                💰 مدفوعة
                              </Badge>
                            ) : (
                              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px] hover:bg-emerald-100">
                                🟢 مجانية
                              </Badge>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            <Switch
                              checked={s.isEnabled}
                              onCheckedChange={v => patch(s.featureKey, { isEnabled: v })}
                            />
                          </td>
                          <td className="p-3 text-center">
                            <Input
                              type="number"
                              min={0}
                              max={100000}
                              value={s.dailyLimit ?? ""}
                              onChange={e => patch(s.featureKey, {
                                dailyLimit: e.target.value === "" ? null : Number(e.target.value),
                              })}
                              placeholder="بلا حد"
                              className="h-8 text-center text-xs"
                            />
                          </td>
                          <td className="p-3 text-center">
                            <Input
                              type="number"
                              min={0}
                              max={10000000}
                              value={s.monthlyLimit ?? ""}
                              onChange={e => patch(s.featureKey, {
                                monthlyLimit: e.target.value === "" ? null : Number(e.target.value),
                              })}
                              placeholder="بلا حد"
                              className="h-8 text-center text-xs"
                            />
                          </td>
                          <td className="p-3 text-center">
                            <span className={`text-xs font-mono ${overDaily ? "text-red-600 font-bold" : ""}`}>
                              {usedToday}{s.dailyLimit != null ? ` / ${s.dailyLimit}` : ""}
                            </span>
                            {(usageMap.month[s.featureKey] || 0) > 0 && (
                              <div className="text-[10px] text-muted-foreground">
                                شهر: {usageMap.month[s.featureKey]}
                              </div>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            <Badge variant="outline" className="text-[10px]">
                              {s.source === "company" ? "مخصص" : s.source === "system" ? "نظام" : "افتراضي"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ─── Recent blocked attempts ─── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-600" />
              آخر محاولات مرفوضة
            </CardTitle>
            <CardDescription>على مستوى النظام كله — مفيد لرصد التجاوزات.</CardDescription>
          </CardHeader>
          <CardContent className="p-0 max-h-[600px] overflow-y-auto">
            {(blockedQ.data?.entries ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground p-4 italic text-center">لا توجد محاولات مرفوضة حديثاً.</p>
            ) : (
              <ul className="divide-y">
                {(blockedQ.data?.entries ?? []).map((e: any) => (
                  <li key={e.id} className="p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold truncate">
                        {e.company_name_ar || `#${e.company_id ?? "—"}`}
                      </span>
                      <span className="text-muted-foreground text-[10px]">
                        {new Date(e.created_at).toLocaleString("ar-SA", {
                          hour: "2-digit", minute: "2-digit", day: "numeric", month: "short",
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="text-[10px]">{e.feature_key}</code>
                      <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                        {e.status === "blocked_disabled" ? "موقوفة"
                         : e.status === "blocked_daily_limit" ? "حد يومي"
                         : e.status === "blocked_monthly_limit" ? "حد شهري"
                         : e.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground text-center pt-4">
        💡 ميزة جديدة: المساعد المحاسبي يستخدم مكتبة معرفية محلية (IFRS / GAAP / ZATCA) مجاناً تماماً قبل اللجوء للذكاء الاصطناعي المدفوع. يمكنك إيقاف الميزات المدفوعة هنا والإبقاء على المكتبة فقط لتجنب أي تكلفة.
      </p>
    </div>
  );
}
