// /admin/invoice-field-policies
//
// Per-company policy editor for invoice screens. Three tabs (Sales /
// Purchase / POS); each shows the field catalogue with a 4-mode select
// (editable / readonly / hidden / required) and, for the date field, a
// "today only" toggle. An AI button asks Claude to propose a sensible
// policy bundle based on the company's industry.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Loader2, Save, Sparkles, Eye, EyeOff, Lock, Asterisk,
  ShieldCheck, ArrowRight, Receipt, ShoppingCart, Store, Calendar, RotateCcw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type FieldMode = "editable" | "readonly" | "hidden" | "required";
type DateConstraint = "none" | "today_only";
type PolicyScope = "sales" | "purchase" | "pos";

interface FieldRule { mode: FieldMode; dateConstraint?: DateConstraint }
type PolicyMap = Record<string, FieldRule>;

interface FieldDef { key: string; labelAr: string; labelEn: string; isDate?: boolean }
type Catalogue = Record<PolicyScope, FieldDef[]>;

interface AdminBundle {
  bundle: Record<PolicyScope, PolicyMap>;
  catalogue: Catalogue;
}

const SCOPE_META: Record<PolicyScope, { titleAr: string; descAr: string; Icon: typeof Receipt }> = {
  sales:    { titleAr: "فواتير المبيعات", descAr: "ضبط حقول شاشة فاتورة المبيعات للمستخدمين العاديين", Icon: Receipt },
  purchase: { titleAr: "فواتير المشتريات", descAr: "ضبط حقول شاشة فاتورة المشتريات للمستخدمين العاديين", Icon: ShoppingCart },
  pos:      { titleAr: "نقاط البيع (POS)", descAr: "ضبط حقول شاشة بيع الكاشير", Icon: Store },
};

const MODE_META: Record<FieldMode, { labelAr: string; klass: string; Icon: typeof Eye }> = {
  editable: { labelAr: "ظاهر وقابل للتعديل", klass: "bg-emerald-100 text-emerald-700 border-emerald-300", Icon: Eye },
  readonly: { labelAr: "للقراءة فقط",          klass: "bg-blue-100 text-blue-700 border-blue-300",       Icon: Lock },
  hidden:   { labelAr: "مخفي",                 klass: "bg-gray-100 text-gray-600 border-gray-300",       Icon: EyeOff },
  required: { labelAr: "ظاهر وإلزامي",         klass: "bg-amber-100 text-amber-700 border-amber-300",    Icon: Asterisk },
};

export default function InvoiceFieldPolicies() {
  const { token, user } = useAuth();
  const { i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const isRtl = i18n.language === "ar";
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const { data, isLoading } = useQuery<AdminBundle>({
    queryKey: ["invoice-field-policies", "admin"],
    enabled: isAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/invoice-field-policies`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // Local editable copy.
  const [draft, setDraft] = useState<Record<PolicyScope, PolicyMap> | null>(null);
  useEffect(() => {
    if (data?.bundle) setDraft(JSON.parse(JSON.stringify(data.bundle)));
  }, [data]);

  const [activeScope, setActiveScope] = useState<PolicyScope>("sales");

  const saveMutation = useMutation({
    mutationFn: async (scope: PolicyScope) => {
      if (!draft) return;
      const r = await fetch(`${API}/api/invoice-field-policies/${scope}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ policy: draft[scope] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذّر الحفظ");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: "ستسري الإعدادات على المستخدمين عند تحديث الصفحة." });
      qc.invalidateQueries({ queryKey: ["invoice-field-policies"] });
    },
    onError: (e: Error) => toast({ title: "فشل الحفظ", description: e.message, variant: "destructive" }),
  });

  const suggestMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/invoice-field-policies/suggest`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذّر الاقتراح");
      return r.json() as Promise<{ source: "ai" | "fallback"; bundle: Record<PolicyScope, PolicyMap> }>;
    },
    onSuccess: (resp) => {
      setDraft(resp.bundle);
      toast({
        title: resp.source === "ai" ? "اقتراح الذكاء الاصطناعي جاهز" : "تم تطبيق إعدادات افتراضية ذكية",
        description: resp.source === "ai"
          ? "تمت تعبئة الإعدادات بناءً على نشاط شركتك. راجعها قبل الحفظ."
          : "خدمة الذكاء الاصطناعي غير مهيّأة — تم تطبيق توصيات قياسية.",
      });
    },
    onError: (e: Error) => toast({ title: "فشل الاقتراح", description: e.message, variant: "destructive" }),
  });

  if (!isAdmin) {
    return (
      <div className="container mx-auto p-6">
        <Card><CardContent className="py-10 text-center text-muted-foreground">هذه الصفحة لمشرفي الشركة فقط.</CardContent></Card>
      </div>
    );
  }
  if (isLoading || !draft || !data) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center" style={{ minHeight: 360 }}>
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  function setMode(scope: PolicyScope, key: string, mode: FieldMode) {
    setDraft((prev) => prev ? {
      ...prev,
      [scope]: { ...prev[scope], [key]: { ...(prev[scope][key] ?? {}), mode } },
    } : prev);
  }
  function setDateConstraint(scope: PolicyScope, key: string, on: boolean) {
    setDraft((prev) => prev ? {
      ...prev,
      [scope]: { ...prev[scope], [key]: {
        ...(prev[scope][key] ?? { mode: "editable" }),
        dateConstraint: on ? "today_only" : "none",
      } },
    } : prev);
  }
  function resetScope(scope: PolicyScope) {
    if (!data) return;
    setDraft((prev) => prev ? { ...prev, [scope]: JSON.parse(JSON.stringify(data.bundle[scope])) } : prev);
  }

  return (
    <div className="container mx-auto p-6 space-y-4" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">حوكمة حقول الفواتير</h1>
            <p className="text-sm text-muted-foreground">تحكّم في ما يراه المستخدم العادي على شاشات الفواتير — بدون لمس الكود.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          <ArrowRight className={`h-4 w-4 ${isRtl ? "rotate-180" : ""} me-1`} />
          الرئيسية
        </Button>
      </div>

      <Card className="bg-gradient-to-l from-violet-50 via-fuchsia-50 to-rose-50 border-violet-200">
        <CardContent className="py-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-violet-600 text-white p-2"><Sparkles className="h-5 w-5" /></div>
            <div>
              <div className="font-semibold">اقتراح ذكي بضغطة زر</div>
              <div className="text-xs text-muted-foreground">
                يحلّل الذكاء الاصطناعي نشاط شركتك ويضع لك إعدادات افتراضية متوازنة لجميع الشاشات.
              </div>
            </div>
          </div>
          <Button
            onClick={() => suggestMutation.mutate()}
            disabled={suggestMutation.isPending}
            className="bg-gradient-to-l from-violet-600 to-fuchsia-600 text-white hover:opacity-90 gap-2"
          >
            {suggestMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            اقترح سياسة مناسبة لشركتي
          </Button>
        </CardContent>
      </Card>

      <Tabs value={activeScope} onValueChange={(v) => setActiveScope(v as PolicyScope)}>
        <TabsList className="grid grid-cols-3 w-full md:w-auto">
          {(Object.keys(SCOPE_META) as PolicyScope[]).map((s) => {
            const M = SCOPE_META[s];
            return (
              <TabsTrigger key={s} value={s} className="gap-2">
                <M.Icon className="h-4 w-4" />
                {M.titleAr}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {(Object.keys(SCOPE_META) as PolicyScope[]).map((scope) => {
          const M = SCOPE_META[scope];
          const fields = data.catalogue[scope];
          return (
            <TabsContent key={scope} value={scope} className="space-y-3">
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <M.Icon className="h-4 w-4" /> {M.titleAr}
                    </CardTitle>
                    <CardDescription>{M.descAr}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="gap-1" onClick={() => resetScope(scope)}>
                      <RotateCcw className="h-3.5 w-3.5" /> تراجع
                    </Button>
                    <Button onClick={() => saveMutation.mutate(scope)} disabled={saveMutation.isPending} className="gap-2">
                      {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      حفظ {M.titleAr}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-2">
                    {fields.map((f) => {
                      const rule = draft[scope][f.key] ?? { mode: "editable" as FieldMode };
                      const Mode = MODE_META[rule.mode];
                      const ModeIcon = Mode.Icon;
                      return (
                        <div
                          key={f.key}
                          className="flex flex-col md:flex-row md:items-center gap-3 rounded-lg border p-3 hover-elevate"
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {f.isDate ? <Calendar className="h-4 w-4 text-muted-foreground" /> : null}
                            <div>
                              <div className="font-medium text-sm">{f.labelAr}</div>
                              <div className="text-[11px] text-muted-foreground">{f.labelEn} · <code dir="ltr">{f.key}</code></div>
                            </div>
                          </div>

                          <Badge variant="outline" className={`gap-1 ${Mode.klass} hidden md:inline-flex`}>
                            <ModeIcon className="h-3 w-3" />
                            {Mode.labelAr}
                          </Badge>

                          {f.isDate && (
                            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
                              <Switch
                                id={`date-${scope}-${f.key}`}
                                checked={rule.dateConstraint === "today_only"}
                                onCheckedChange={(v) => setDateConstraint(scope, f.key, v)}
                              />
                              <label htmlFor={`date-${scope}-${f.key}`} className="text-xs cursor-pointer">
                                اليوم فقط
                              </label>
                            </div>
                          )}

                          <Select value={rule.mode} onValueChange={(v) => setMode(scope, f.key, v as FieldMode)}>
                            <SelectTrigger className="w-full md:w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(MODE_META) as FieldMode[]).map((m) => {
                                const Mi = MODE_META[m];
                                const Ic = Mi.Icon;
                                return (
                                  <SelectItem key={m} value={m}>
                                    <div className="flex items-center gap-2">
                                      <Ic className="h-3.5 w-3.5" />
                                      {Mi.labelAr}
                                    </div>
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground rounded-md border-2 border-dashed p-3">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    أنت كمشرف ترى جميع الحقول دائماً — هذه الإعدادات تسري فقط على المستخدمين العاديين داخل الشركة.
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
